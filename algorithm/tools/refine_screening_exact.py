from __future__ import annotations

import argparse
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from threading import Lock, local
from types import MappingProxyType

from beeline_planning import (
    ExactRefinementFailure,
    ExactRefinementReport,
    MasterSolution,
    MasterSolveStatus,
    ObjectivePolicy,
    SolverConfig,
    apply_refinement_report,
    apply_schedule_failure_assignment_cuts,
    apply_schedule_failure_route_conflicts,
    build_candidate_index,
    build_explanation_bundle,
    build_master_model_input,
    inspect_exact_candidate,
    load_planning_dataset,
    load_screening_matrices,
    materialize_exact_initial_plan,
    screening_solution_quality,
    solve_screening_master,
)
from beeline_planning.export import (
    load_master_solution,
    master_solution_dict,
    materialization_result_dict,
)
from beeline_planning.materialize import MaterializationStatus
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


ArcKey = tuple[str, str, str]


def _zone_dataset(source, zone: str):
    jobs = {
        job_id: job for job_id, job in source.jobs.items() if job.zone_id == zone
    }
    engineers = {
        engineer_id: engineer
        for engineer_id, engineer in source.engineers.items()
        if engineer.zone_id == zone
    }
    offices = {
        office_id: office
        for office_id, office in source.offices.items()
        if office.zone_id == zone
    }
    return replace(
        source,
        jobs=MappingProxyType(jobs),
        engineers=MappingProxyType(engineers),
        offices=MappingProxyType(offices),
        shared_inventory=tuple(
            item for item in source.shared_inventory if item.zone_id == zone
        ),
        events=tuple(event for event in source.events if event.zone_id == zone),
        commitments=tuple(
            item
            for item in source.commitments
            if item.job_id in jobs and item.engineer_id in engineers
        ),
    )


def _zone_hint(candidate: MasterSolution, dataset) -> MasterSolution:
    active = set(dataset.jobs)
    return replace(
        candidate,
        routes=tuple(
            route for route in candidate.routes if route.engineer_id in dataset.engineers
        ),
        unserved_job_ids=tuple(
            job_id for job_id in candidate.unserved_job_ids if job_id in active
        ),
        objective_proofs=(),
        operationally_excluded_arcs=(),
    )


def _solve_refined_zone(
    source,
    screening,
    candidate: MasterSolution,
    zone: str,
    cuts: set[ArcKey],
    overrides: dict[ArcKey, int],
    graph_sizes: tuple[int, ...],
    seconds_per_tier: float,
    search_workers: int,
    forced_assignments: tuple[tuple[str, str], ...] = (),
    strict_full_coverage: bool = False,
    full_coverage_seconds: float = 300.0,
    forbidden_assignments: tuple[tuple[str, str], ...] = (),
    forbidden_arc_groups: tuple[tuple[ArcKey, ...], ...] = (),
    forbidden_assignment_groups: tuple[
        tuple[tuple[str, str], ...], ...
    ] = (),
    mutable_job_ids: frozenset[str] | None = None,
) -> tuple[str, MasterSolution, list[int]]:
    dataset = _zone_dataset(source, zone)
    master = build_master_model_input(dataset, screening)
    if mutable_job_ids is not None:
        current_owner = {
            visit.job_id: route.engineer_id
            for route in candidate.routes
            if route.engineer_id in dataset.engineers
            for visit in route.visits
            if visit.job_id in dataset.jobs
        }
        locked_assignments = {
            (engineer_id, job_id)
            for job_id, engineer_id in current_owner.items()
            if job_id not in mutable_job_ids
        }
        master = replace(
            master,
            hard_assignments=tuple(sorted(
                set(master.hard_assignments) | locked_assignments
            )),
        )
    required_arcs: set[ArcKey] = set()
    if mutable_job_ids is not None:
        for route in candidate.routes:
            if route.engineer_id not in dataset.engineers:
                continue
            previous_job_id: str | None = None
            for visit in route.visits:
                if (
                    previous_job_id is not None
                    and previous_job_id not in mutable_job_ids
                    and visit.job_id not in mutable_job_ids
                ):
                    required_arcs.add((
                        route.engineer_id,
                        previous_job_id,
                        visit.job_id,
                    ))
                previous_job_id = visit.job_id
    zone_forced_assignments = tuple(
        assignment
        for assignment in forced_assignments
        if assignment[0] in dataset.engineers
    )
    if zone_forced_assignments:
        master = replace(
            master,
            hard_assignments=tuple(sorted(
                set(master.hard_assignments) | set(zone_forced_assignments)
            )),
        )
    found_override_keys: set[ArcKey] = set()
    adjusted_arcs = []
    for arc in master.arcs:
        key = (arc.engineer_id, arc.origin_node_id, arc.destination_job_id)
        if key in overrides:
            found_override_keys.add(key)
            adjusted_arcs.append(replace(
                arc,
                screening_duration_minutes=max(
                    arc.screening_duration_minutes,
                    overrides[key],
                ),
                screening_is_surrogate=False,
            ))
        else:
            adjusted_arcs.append(arc)
    missing = {
        key for key in overrides if key[0] in dataset.engineers
    } - found_override_keys
    if missing:
        raise ValueError(f'Exact duration overrides are absent from zone graph: {sorted(missing)}')
    master = replace(master, arcs=tuple(adjusted_arcs))
    hint = _zone_hint(candidate, dataset)
    best: MasterSolution | None = None
    attempts: list[int] = []
    expected = set(master.candidate_index.active_job_ids)
    zone_cuts = tuple(sorted(key for key in cuts if key[0] in dataset.engineers))
    zone_forbidden_assignments = tuple(sorted(
        assignment
        for assignment in forbidden_assignments
        if assignment[0] in dataset.engineers
    ))
    zone_forbidden_arc_groups = tuple(
        group
        for group in forbidden_arc_groups
        if group and group[0][0] in dataset.engineers
    )
    zone_forbidden_assignment_groups = tuple(
        group
        for group in forbidden_assignment_groups
        if group and group[0][0] in dataset.engineers
    )
    for size in graph_sizes:
        attempts.append(size)
        solution = solve_screening_master(
            dataset,
            master,
            SolverConfig(
                max_seconds_per_tier=seconds_per_tier,
                num_search_workers=search_workers,
                max_predecessors_per_destination=size or None,
                excluded_arcs=zone_cuts,
                required_arcs=tuple(sorted(required_arcs)),
                forbidden_arc_groups=zone_forbidden_arc_groups,
                forbidden_assignments=zone_forbidden_assignments,
                forbidden_assignment_groups=zone_forbidden_assignment_groups,
                require_full_coverage=strict_full_coverage,
                full_coverage_seconds=full_coverage_seconds,
                objective_policy=ObjectivePolicy.COMPACT_TEAM,
            ),
            hint_solution=hint,
        )
        represented = {
            visit.job_id for route in solution.routes for visit in route.visits
        } | set(solution.unserved_job_ids)
        if represented != expected:
            continue
        if (
            best is None
            or screening_solution_quality(dataset, solution).key
            < screening_solution_quality(dataset, best).key
        ):
            best = solution
        hint = best
        if best is not None and not best.unserved_job_ids:
            break
    if best is None:
        if mutable_job_ids is not None:
            fallback_zone, fallback_solution, fallback_attempts = _solve_refined_zone(
                source,
                screening,
                candidate,
                zone,
                cuts,
                overrides,
                graph_sizes,
                seconds_per_tier,
                search_workers,
                forced_assignments,
                strict_full_coverage,
                full_coverage_seconds,
                forbidden_assignments,
                forbidden_arc_groups,
                forbidden_assignment_groups,
                None,
            )
            return (
                fallback_zone,
                fallback_solution,
                attempts + fallback_attempts,
            )
        raise RuntimeError(f'No refined screening solution found for zone {zone}')
    return zone, best, attempts


def _merge_zones(
    source,
    candidate: MasterSolution,
    replacements: dict[str, MasterSolution],
) -> MasterSolution:
    replaced_zones = set(replacements)
    routes = [
        route
        for route in candidate.routes
        if source.engineers[route.engineer_id].zone_id not in replaced_zones
    ]
    routes.extend(
        route for solution in replacements.values() for route in solution.routes
    )
    unserved = {
        job_id
        for job_id in candidate.unserved_job_ids
        if source.jobs[job_id].zone_id not in replaced_zones
    }
    unserved.update(
        job_id
        for solution in replacements.values()
        for job_id in solution.unserved_job_ids
    )
    return MasterSolution(
        status=MasterSolveStatus.SCREENING_FEASIBLE,
        planning_at=candidate.planning_at,
        routes=tuple(sorted(routes, key=lambda route: route.engineer_id)),
        unserved_job_ids=tuple(sorted(unserved)),
        objective_proofs=(),
        dataset_sha256=candidate.dataset_sha256,
        screening_snapshot_sha256=candidate.screening_snapshot_sha256,
        solver_version=candidate.solver_version,
        search_graph_complete=False,
        searched_arc_count=sum(
            solution.searched_arc_count for solution in replacements.values()
        ),
        operationally_excluded_arcs=tuple(sorted({
            key
            for solution in replacements.values()
            for key in solution.operationally_excluded_arcs
        })),
    )


def _failure_dict(failure) -> dict[str, object]:
    return {
        'kind': failure.kind.value,
        'engineer_id': failure.engineer_id,
        'zone_id': failure.zone_id,
        'origin_node_id': failure.origin_node_id,
        'destination_job_id': failure.destination_job_id,
        'departure_at': failure.departure_at,
        'reason': failure.reason,
    }


def _mutable_jobs_for_conflicts(
    dataset,
    zone: str,
    assignment_conflict_groups: set[tuple[tuple[str, str], ...]],
    current_failures: tuple[ExactRefinementFailure, ...] = (),
) -> frozenset[str] | None:
    """Build a bounded neighbourhood around the current exact failures.

    Route-prefix no-goods are deliberately local facts.  Re-solving an entire
    zone after learning one of them discards a nearly complete incumbent and
    gives CP-SAT a much harder problem than necessary.  The failed destination,
    its predecessor and jobs with nearby windows form the first neighbourhood;
    ``_solve_refined_zone`` still falls back to the unrestricted zone when this
    neighbourhood is too small.
    """
    seed_ids = {
        job_id
        for group in assignment_conflict_groups
        for engineer_id, job_id in group
        if dataset.engineers[engineer_id].zone_id == zone
    }
    for failure in current_failures:
        if failure.zone_id != zone:
            continue
        if failure.destination_job_id in dataset.jobs:
            seed_ids.add(failure.destination_job_id)
        if failure.origin_node_id in dataset.jobs:
            seed_ids.add(failure.origin_node_id)
    if not seed_ids:
        return None
    seed_jobs = [dataset.jobs[job_id] for job_id in seed_ids]
    start = min(job.window_start for job in seed_jobs)
    end = max(job.window_end for job in seed_jobs)
    max_window = max(job.window_end - job.window_start for job in seed_jobs)
    neighbourhood_start = start - max_window
    neighbourhood_end = end + max_window
    return frozenset(
        job_id
        for job_id, job in dataset.jobs.items()
        if job.zone_id == zone
        and (
            job_id in seed_ids
            or (
                job.window_end - job.window_start <= max_window * 2
                and job.window_start <= neighbourhood_end
                and neighbourhood_start <= job.window_end
            )
        )
    )


def _inspect_parallel(
    dataset,
    candidate: MasterSolution,
    oracle_factory,
    max_workers: int,
) -> ExactRefinementReport:
    """Inspect independent engineer routes concurrently with thread-local clients."""
    state = local()
    clients: list[ExactRoutingOracle] = []
    clients_lock = Lock()

    def inspect_route(route):
        oracle = getattr(state, 'oracle', None)
        if oracle is None:
            oracle = oracle_factory()
            state.oracle = oracle
            with clients_lock:
                clients.append(oracle)
        partial = replace(
            candidate,
            routes=(route,),
            unserved_job_ids=(),
            objective_proofs=(),
        )
        return inspect_exact_candidate(dataset, partial, oracle)

    try:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            reports = list(executor.map(inspect_route, candidate.routes))
    finally:
        for oracle in clients:
            close = getattr(oracle.client, 'close', None)
            if close is not None:
                close()
    return ExactRefinementReport(
        observations=tuple(
            item for report in reports for item in report.observations
        ),
        failures=tuple(item for report in reports for item in report.failures),
        complete_engineer_ids=tuple(
            engineer_id
            for report in reports
            for engineer_id in report.complete_engineer_ids
        ),
        exact_provider_queries=sum(report.exact_provider_queries for report in reports),
        identity_legs=sum(report.identity_legs for report in reports),
    )


def _checkpoint(
    path: Path,
    dataset_sha256: str,
    candidate: MasterSolution,
    iterations: list[dict[str, object]],
    cuts: set[ArcKey],
    overrides: dict[ArcKey, int],
    assignment_cuts: set[tuple[str, str]],
    route_conflict_groups: set[tuple[ArcKey, ...]],
    assignment_conflict_groups: set[tuple[tuple[str, str], ...]],
    status: str,
) -> None:
    payload = {
        'artifact_type': 'EXACT_REFINEMENT_LOOP_CHECKPOINT',
        'status': status,
        'publication_allowed': False,
        'dataset_sha256': dataset_sha256,
        'iterations': iterations,
        'cuts': [list(key) for key in sorted(cuts)],
        'duration_overrides': [
            {'arc': list(key), 'duration_minutes': value}
            for key, value in sorted(overrides.items())
        ],
        'assignment_cuts': [
            {'engineer_id': engineer_id, 'job_id': job_id}
            for engineer_id, job_id in sorted(assignment_cuts)
        ],
        'route_conflict_groups': [
            [list(key) for key in group]
            for group in sorted(route_conflict_groups)
        ],
        'assignment_conflict_groups': [
            [
                {'engineer_id': engineer_id, 'job_id': job_id}
                for engineer_id, job_id in group
            ]
            for group in sorted(assignment_conflict_groups)
        ],
        'latest_candidate': master_solution_dict(candidate),
    }
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(path, payload)


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Iterate screening solve, exact routing, cuts, and zone-only re-solving.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--screening-root', type=Path, required=True)
    parser.add_argument('--input-candidate', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument(
        '--initial-refinement-state',
        type=Path,
        help=(
            'Resume learned cuts from an earlier checksummed refinement '
            'checkpoint while using --input-candidate as the latest candidate.'
        ),
    )
    parser.add_argument('--max-iterations', type=int, default=20)
    parser.add_argument('--max-exact-queries', type=int, default=3000)
    parser.add_argument('--max-unknown-retries', type=int, default=2)
    parser.add_argument('--seconds-per-tier', type=float, default=15)
    parser.add_argument(
        '--strict-full-coverage',
        action='store_true',
        help='Reject every refined candidate that leaves any job unassigned.',
    )
    parser.add_argument(
        '--full-coverage-seconds',
        type=float,
        default=300,
        help='Feasibility budget for each strict full-coverage re-solve.',
    )
    parser.add_argument(
        '--force-assignment',
        action='append',
        default=[],
        metavar='ENGINEER,JOB',
        help=(
            'Keep JOB assigned to ENGINEER through every refinement iteration. '
            'Repeat the option to force several assignments.'
        ),
    )
    parser.add_argument(
        '--assignment-cut-on-schedule-failure',
        action='store_true',
        help=(
            'On an exact WINDOW, SHIFT or ROUTE_LIMIT failure, learn a '
            'run-local engineer/job exclusion instead of hard-coding IDs or '
            'turning one departure-time observation into a timeless arc cost.'
        ),
    )
    parser.add_argument(
        '--max-assignment-cuts',
        type=int,
        default=50,
        help='Maximum run-local engineer/job exclusions learned from exact failures.',
    )
    parser.add_argument(
        '--alternative-owner-probes',
        type=int,
        default=3,
        help=(
            'After an assignment-cut re-solve times out, try this many '
            'automatically ranked eligible owners for the failed job.'
        ),
    )
    parser.add_argument(
        '--route-conflict-cut-on-schedule-failure',
        action='store_true',
        help=(
            'Learn a run-local no-good for the exact route prefix that missed '
            'a window, shift or route limit. This preserves assignment and '
            'reordering alternatives and contains no dataset-specific IDs.'
        ),
    )
    parser.add_argument(
        '--max-route-conflict-cuts',
        type=int,
        default=100,
        help='Maximum exact route-prefix no-goods learned in one run.',
    )
    parser.add_argument(
        '--max-assignment-conflict-cuts',
        type=int,
        default=50,
        help='Maximum proven zero-travel assignment overload cuts in one run.',
    )
    parser.add_argument('--search-workers', type=int, default=1)
    parser.add_argument('--zone-workers', type=int, default=3)
    parser.add_argument('--route-workers', type=int, default=3)
    parser.add_argument('--adaptive-predecessors', default='8,16,0')
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument('--timeout-seconds', type=float, default=30)
    parser.add_argument('--max-attempts', type=int, default=1)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Exact refinement requires explicit --execute')
    if min(
        args.max_iterations,
        args.max_exact_queries,
        args.max_unknown_retries,
        args.search_workers,
        args.zone_workers,
        args.route_workers,
        args.max_assignment_cuts,
        args.alternative_owner_probes,
        args.max_route_conflict_cuts,
        args.max_assignment_conflict_cuts,
    ) < 1:
        parser.error('Budgets and worker counts must be positive')
    if args.full_coverage_seconds <= 0:
        parser.error('--full-coverage-seconds must be positive')
    graph_sizes = tuple(
        int(value.strip()) for value in args.adaptive_predecessors.split(',')
    )
    if not graph_sizes or any(value < 0 for value in graph_sizes):
        parser.error('Adaptive predecessor counts must be non-negative')
    if graph_sizes[-1] != 0:
        graph_sizes += (0,)

    dataset = load_planning_dataset(args.dataset, args.scenario)
    screening = load_screening_matrices(args.screening_root, dataset)
    candidate = load_master_solution(args.input_candidate)
    if candidate.dataset_sha256 != dataset.dataset_sha256:
        raise ValueError('Candidate belongs to another dataset')
    candidate_index = build_candidate_index(dataset)
    forced_assignments: list[tuple[str, str]] = []
    for raw in args.force_assignment:
        parts = tuple(part.strip() for part in raw.split(','))
        if len(parts) != 2 or not all(parts):
            parser.error('--force-assignment requires ENGINEER,JOB')
        engineer_id, job_id = parts
        if engineer_id not in dataset.engineers:
            parser.error(f'Unknown forced engineer: {engineer_id}')
        if job_id not in dataset.jobs:
            parser.error(f'Unknown forced job: {job_id}')
        if engineer_id not in candidate_index.eligible_engineers_by_job[job_id]:
            parser.error(
                f'Forced assignment is statically ineligible: {engineer_id},{job_id}'
            )
        forced_assignments.append((engineer_id, job_id))
    if len({job_id for _, job_id in forced_assignments}) != len(forced_assignments):
        parser.error('Each forced job must have exactly one engineer')
    protected_assignments = frozenset(forced_assignments) | frozenset(
        (engineer_id, job_id)
        for engineer_id, job_id in build_master_model_input(
            dataset,
            screening,
        ).hard_assignments
    )
    require_full_coverage = (
        args.strict_full_coverage
        or (
            (
                args.assignment_cut_on_schedule_failure
                or args.route_conflict_cut_on_schedule_failure
            )
            and not candidate.unserved_job_ids
        )
    )

    def make_oracle() -> ExactRoutingOracle:
        return ExactRoutingOracle(create_route_client(
            RoutingCache(args.cache),
            'valhalla-local-transit',
            timeout_seconds=args.timeout_seconds,
            max_attempts=args.max_attempts,
            transit_index=args.transit_index,
            metro_wait_seconds=args.metro_wait_seconds,
        ))

    oracle = make_oracle()
    cuts: set[ArcKey] = set(candidate.operationally_excluded_arcs)
    overrides: dict[ArcKey, int] = {}
    assignment_cuts: set[tuple[str, str]] = set()
    route_conflict_groups: set[tuple[ArcKey, ...]] = set()
    assignment_conflict_groups: set[tuple[tuple[str, str], ...]] = set()
    if args.initial_refinement_state is not None:
        state_payload = json.loads(
            args.initial_refinement_state.read_text(encoding='utf-8')
        )
        unsigned_state = dict(state_payload)
        expected_hash = unsigned_state.pop('content_sha256', None)
        if expected_hash != payload_sha256(unsigned_state):
            parser.error('Initial refinement state checksum mismatch')
        if state_payload.get('artifact_type') != 'EXACT_REFINEMENT_LOOP_CHECKPOINT':
            parser.error('Initial refinement state is not a refinement checkpoint')
        if state_payload.get('dataset_sha256') != dataset.dataset_sha256:
            parser.error('Initial refinement state belongs to another dataset')
        cuts.update(tuple(item) for item in state_payload.get('cuts', ()))
        overrides.update({
            tuple(item['arc']): int(item['duration_minutes'])
            for item in state_payload.get('duration_overrides', ())
        })
        assignment_cuts.update(
            (item['engineer_id'], item['job_id'])
            for item in state_payload.get('assignment_cuts', ())
        )
        route_conflict_groups.update(
            tuple(tuple(key) for key in group)
            for group in state_payload.get('route_conflict_groups', ())
        )
        assignment_conflict_groups.update(
            tuple((item['engineer_id'], item['job_id']) for item in group)
            for group in state_payload.get('assignment_conflict_groups', ())
        )
    failure_counts: Counter[tuple[str, ArcKey]] = Counter()
    iterations: list[dict[str, object]] = []
    exact_queries = 0
    stop_status = 'REFINEMENT_LIMIT_REACHED'
    final_result = None
    try:
        for iteration in range(1, args.max_iterations + 1):
            report = _inspect_parallel(
                dataset,
                candidate,
                make_oracle,
                args.route_workers,
            )
            exact_queries += report.exact_provider_queries
            failures = list(report.failures)
            record: dict[str, object] = {
                'iteration': iteration,
                'served_jobs': sum(len(route.visits) for route in candidate.routes),
                'unserved_jobs': len(candidate.unserved_job_ids),
                'quality_before': screening_solution_quality(
                    dataset,
                    candidate,
                ).as_dict(),
                'exact_provider_queries': report.exact_provider_queries,
                'failures': [_failure_dict(item) for item in failures],
                'duration_updates': [],
                'new_cuts': [],
                'new_assignment_cuts': [],
                'new_route_conflict_groups': [],
                'new_assignment_conflict_groups': [],
                'resolved_zones': [],
            }
            iterations.append(record)
            if exact_queries > args.max_exact_queries:
                stop_status = 'REFINEMENT_QUERY_BUDGET_EXHAUSTED'
                break
            if not failures:
                final_result = materialize_exact_initial_plan(
                    dataset,
                    candidate,
                    oracle,
                    max_workers=args.route_workers,
                    oracle_factory=make_oracle if args.route_workers > 1 else None,
                )
                stop_status = (
                    'REFINEMENT_CONVERGED'
                    if final_result.status == MaterializationStatus.EXACT_VALID
                    else 'REFINEMENT_FINAL_VALIDATION_FAILED'
                )
                break

            traditional_report = report
            assignment_actions = None
            route_conflict_actions = None
            if args.route_conflict_cut_on_schedule_failure:
                route_conflict_actions = apply_schedule_failure_route_conflicts(
                    report,
                    candidate,
                    conflict_groups=route_conflict_groups,
                    assignment_conflict_groups=assignment_conflict_groups,
                )
                record['new_route_conflict_groups'] = [
                    [list(key) for key in group]
                    for group in route_conflict_actions.new_groups
                ]
                record['new_assignment_conflict_groups'] = [
                    [
                        {'engineer_id': engineer_id, 'job_id': job_id}
                        for engineer_id, job_id in group
                    ]
                    for group in route_conflict_actions.new_assignment_groups
                ]
                if route_conflict_actions.unmatched_failures:
                    record['unmatched_route_conflict_failures'] = [
                        _failure_dict(item)
                        for item in route_conflict_actions.unmatched_failures
                    ]
                if len(route_conflict_groups) > args.max_route_conflict_cuts:
                    stop_status = 'REFINEMENT_ROUTE_CONFLICT_LIMIT_REACHED'
                    break
                if (
                    len(assignment_conflict_groups)
                    > args.max_assignment_conflict_cuts
                ):
                    stop_status = 'REFINEMENT_ASSIGNMENT_CONFLICT_LIMIT_REACHED'
                    break
            if args.assignment_cut_on_schedule_failure:
                assignment_actions = apply_schedule_failure_assignment_cuts(
                    report,
                    assignment_cuts=assignment_cuts,
                    protected_assignments=protected_assignments,
                )
                schedule_zones = {
                    failure.zone_id
                    for failure in report.failures
                    if failure.kind.value in {'WINDOW', 'SHIFT', 'ROUTE_LIMIT'}
                }
                traditional_report = replace(
                    report,
                    observations=tuple(
                        item
                        for item in report.observations
                        if item.zone_id not in schedule_zones
                    ),
                    failures=tuple(
                        failure
                        for failure in report.failures
                        if failure.kind.value
                        not in {'WINDOW', 'SHIFT', 'ROUTE_LIMIT'}
                    ),
                )
                record['new_assignment_cuts'] = [
                    {
                        'engineer_id': engineer_id,
                        'job_id': job_id,
                    }
                    for engineer_id, job_id in assignment_actions.new_cuts
                ]
                if assignment_actions.protected_failures:
                    record['protected_assignment_failures'] = [
                        _failure_dict(item)
                        for item in assignment_actions.protected_failures
                    ]
                    stop_status = 'REFINEMENT_PROTECTED_ASSIGNMENT_FAILED'
                    break
                if len(assignment_cuts) > args.max_assignment_cuts:
                    stop_status = 'REFINEMENT_ASSIGNMENT_CUT_LIMIT_REACHED'
                    break

            if (
                args.route_conflict_cut_on_schedule_failure
                and not args.assignment_cut_on_schedule_failure
            ):
                schedule_zones = {
                    failure.zone_id
                    for failure in report.failures
                    if failure.kind.value in {'WINDOW', 'SHIFT', 'ROUTE_LIMIT'}
                }
                traditional_report = replace(
                    report,
                    observations=tuple(
                        item
                        for item in report.observations
                        if item.zone_id not in schedule_zones
                    ),
                    failures=tuple(
                        failure
                        for failure in report.failures
                        if failure.kind.value
                        not in {'WINDOW', 'SHIFT', 'ROUTE_LIMIT'}
                    ),
                )

            actions = apply_refinement_report(
                traditional_report,
                duration_overrides=overrides,
                cuts=cuts,
                failure_counts=failure_counts,
                max_unknown_retries=args.max_unknown_retries,
            )
            changed_zones = set(actions.changed_zones)
            if assignment_actions is not None:
                changed_zones.update(assignment_actions.changed_zones)
            if route_conflict_actions is not None:
                changed_zones.update(route_conflict_actions.changed_zones)
            record['duration_updates'] = [
                {
                    'arc': [
                        item.engineer_id,
                        item.origin_node_id,
                        item.destination_job_id,
                    ],
                    'screening_minutes': item.screening_duration_minutes,
                    'exact_minutes': item.exact_duration_minutes,
                    'departure_at': item.departure_at,
                }
                for item in actions.duration_updates
            ]
            record['new_cuts'] = [list(key) for key in actions.new_cuts]
            if actions.blocked_unknown and not changed_zones:
                stop_status = 'REFINEMENT_ROUTING_BLOCKED'
                break
            if not changed_zones:
                _checkpoint(
                    args.output,
                    dataset.dataset_sha256,
                    candidate,
                    iterations,
                    cuts,
                    overrides,
                    assignment_cuts,
                    route_conflict_groups,
                    assignment_conflict_groups,
                    'REFINEMENT_RETRYING_UNKNOWN',
                )
                continue

            mutable_jobs_by_zone = {
                zone: _mutable_jobs_for_conflicts(
                    dataset,
                    zone,
                    assignment_conflict_groups,
                    report.failures,
                )
                for zone in changed_zones
            }
            record['mutable_jobs_by_zone'] = {
                zone: len(job_ids) if job_ids is not None else None
                for zone, job_ids in mutable_jobs_by_zone.items()
            }

            try:
                with ThreadPoolExecutor(
                    max_workers=min(args.zone_workers, len(changed_zones))
                ) as executor:
                    results = list(executor.map(
                        lambda zone: _solve_refined_zone(
                            dataset,
                            screening,
                            candidate,
                            zone,
                            cuts,
                            overrides,
                            graph_sizes,
                            args.seconds_per_tier,
                            args.search_workers,
                            tuple(forced_assignments),
                            require_full_coverage,
                            args.full_coverage_seconds,
                            tuple(sorted(assignment_cuts)),
                            tuple(sorted(route_conflict_groups)),
                            tuple(sorted(assignment_conflict_groups)),
                            mutable_jobs_by_zone[zone],
                        ),
                        sorted(changed_zones),
                    ))
            except RuntimeError as error:
                results = []
                alternative_probes: list[dict[str, object]] = []
                if args.assignment_cut_on_schedule_failure:
                    route_jobs = {
                        route.engineer_id: tuple(
                            visit.job_id for visit in route.visits
                        )
                        for route in candidate.routes
                    }
                    for zone in sorted(changed_zones):
                        zone_result = None
                        failed_job_ids = tuple(dict.fromkeys(
                            failure.destination_job_id
                            for failure in report.failures
                            if failure.zone_id == zone
                            and failure.kind.value
                            in {'WINDOW', 'SHIFT', 'ROUTE_LIMIT'}
                        ))
                        for job_id in failed_job_ids:
                            job = dataset.jobs[job_id]

                            def owner_rank(engineer_id: str) -> tuple[object, ...]:
                                overlap_load = sum(
                                    dataset.jobs[assigned_job_id].service_duration_min
                                    for assigned_job_id in route_jobs.get(
                                        engineer_id, ()
                                    )
                                    if (
                                        dataset.jobs[assigned_job_id].window_start
                                        < job.window_end
                                        and job.window_start
                                        < dataset.jobs[assigned_job_id].window_end
                                    )
                                )
                                return (
                                    overlap_load,
                                    len(route_jobs.get(engineer_id, ())),
                                    engineer_id,
                                )

                            owners = sorted(
                                (
                                    engineer_id
                                    for engineer_id in candidate_index.eligible_engineers_by_job[
                                        job_id
                                    ]
                                    if (engineer_id, job_id) not in assignment_cuts
                                ),
                                key=owner_rank,
                            )[:args.alternative_owner_probes]
                            for engineer_id in owners:
                                probe = {
                                    'zone_id': zone,
                                    'job_id': job_id,
                                    'engineer_id': engineer_id,
                                    'overlap_load_minutes': owner_rank(engineer_id)[0],
                                }
                                alternative_probes.append(probe)
                                try:
                                    zone_result = _solve_refined_zone(
                                        dataset,
                                        screening,
                                        candidate,
                                        zone,
                                        cuts,
                                        overrides,
                                        graph_sizes,
                                        args.seconds_per_tier,
                                        args.search_workers,
                                        tuple(forced_assignments)
                                        + ((engineer_id, job_id),),
                                        require_full_coverage,
                                        args.full_coverage_seconds,
                                        tuple(sorted(assignment_cuts)),
                                        tuple(sorted(route_conflict_groups)),
                                        tuple(sorted(assignment_conflict_groups)),
                                        None,
                                    )
                                except RuntimeError:
                                    probe['status'] = 'NO_SOLUTION_WITHIN_LIMIT'
                                    continue
                                probe['status'] = 'SCREENING_FEASIBLE'
                                break
                            if zone_result is not None:
                                break
                        if zone_result is None:
                            results = []
                            break
                        results.append(zone_result)
                record['alternative_owner_probes'] = alternative_probes
                if not results:
                    record['resolve_error'] = str(error)
                    stop_status = 'REFINEMENT_NO_FULL_COVERAGE_WITHIN_LIMIT'
                    _checkpoint(
                        args.output,
                        dataset.dataset_sha256,
                        candidate,
                        iterations,
                        cuts,
                        overrides,
                        assignment_cuts,
                        route_conflict_groups,
                        assignment_conflict_groups,
                        stop_status,
                    )
                    break
            candidate = _merge_zones(
                dataset,
                candidate,
                {zone: solution for zone, solution, _ in results},
            )
            record['resolved_zones'] = [zone for zone, _, _ in results]
            record['quality_after'] = screening_solution_quality(
                dataset,
                candidate,
            ).as_dict()
            record['adaptive_graph_attempts'] = {
                zone: attempts for zone, _, attempts in results
            }
            _checkpoint(
                args.output,
                dataset.dataset_sha256,
                candidate,
                iterations,
                cuts,
                overrides,
                assignment_cuts,
                route_conflict_groups,
                assignment_conflict_groups,
                'REFINEMENT_RUNNING',
            )
    finally:
        close = getattr(oracle.client, 'close', None)
        if close is not None:
            close()

    if final_result is not None:
        payload = materialization_result_dict(final_result)
        payload['artifact_type'] = 'EXACT_REFINEMENT_LOOP_RESULT'
        payload['refinement_status'] = stop_status
        payload['refinement_iterations'] = iterations
        payload['refinement_exact_provider_queries'] = exact_queries
        payload['refinement_cuts'] = [list(key) for key in sorted(cuts)]
        payload['refinement_duration_overrides'] = [
            {'arc': list(key), 'duration_minutes': value}
            for key, value in sorted(overrides.items())
        ]
        payload['refinement_assignment_cuts'] = [
            {'engineer_id': engineer_id, 'job_id': job_id}
            for engineer_id, job_id in sorted(assignment_cuts)
        ]
        payload['refinement_route_conflict_groups'] = [
            [list(key) for key in group]
            for group in sorted(route_conflict_groups)
        ]
        payload['refinement_assignment_conflict_groups'] = [
            [
                {'engineer_id': engineer_id, 'job_id': job_id}
                for engineer_id, job_id in group
            ]
            for group in sorted(assignment_conflict_groups)
        ]
        payload['forced_assignments'] = [
            {'engineer_id': engineer_id, 'job_id': job_id}
            for engineer_id, job_id in forced_assignments
        ]
        payload['strict_full_coverage'] = require_full_coverage
        payload['assignment_cut_on_schedule_failure'] = (
            args.assignment_cut_on_schedule_failure
        )
        payload['route_conflict_cut_on_schedule_failure'] = (
            args.route_conflict_cut_on_schedule_failure
        )
        payload['dataset_sha256'] = dataset.dataset_sha256
        if (
            final_result.plan is not None
            and final_result.validation is not None
            and payload['publication_allowed']
        ):
            payload['explanations'] = build_explanation_bundle(
                dataset,
                final_result.plan,
                final_result.validation,
                exact_route_checks=exact_queries,
                exact_provider_queries=(
                    exact_queries + final_result.exact_provider_queries
                ),
                global_optimality_proven=False,
            )
        payload['content_sha256'] = payload_sha256(payload)
        write_json_atomic(args.output, payload)
    else:
        _checkpoint(
            args.output,
            dataset.dataset_sha256,
            candidate,
            iterations,
            cuts,
            overrides,
            assignment_cuts,
            route_conflict_groups,
            assignment_conflict_groups,
            stop_status,
        )
        payload = json.loads(args.output.read_text(encoding='utf-8'))
    print(json.dumps({
        'status': stop_status,
        'publication_allowed': payload.get('publication_allowed', False),
        'iterations': len(iterations),
        'exact_provider_queries': exact_queries,
        'cuts': len(cuts),
        'duration_overrides': len(overrides),
        'assignment_cuts': len(assignment_cuts),
        'route_conflict_cuts': len(route_conflict_groups),
        'assignment_conflict_cuts': len(assignment_conflict_groups),
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0 if payload.get('publication_allowed') else 2


if __name__ == '__main__':
    raise SystemExit(main())
