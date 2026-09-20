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
    MasterSolution,
    MasterSolveStatus,
    ObjectivePolicy,
    ExactRefinementReport,
    SolverConfig,
    apply_refinement_report,
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
) -> tuple[str, MasterSolution, list[int]]:
    dataset = _zone_dataset(source, zone)
    master = build_master_model_input(dataset, screening)
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
                require_full_coverage=False,
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
    parser.add_argument('--max-iterations', type=int, default=6)
    parser.add_argument('--max-exact-queries', type=int, default=3000)
    parser.add_argument('--max-unknown-retries', type=int, default=2)
    parser.add_argument('--seconds-per-tier', type=float, default=15)
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
    ) < 1:
        parser.error('Budgets and worker counts must be positive')
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

            actions = apply_refinement_report(
                report,
                duration_overrides=overrides,
                cuts=cuts,
                failure_counts=failure_counts,
                max_unknown_retries=args.max_unknown_retries,
            )
            changed_zones = set(actions.changed_zones)
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
                    'REFINEMENT_RETRYING_UNKNOWN',
                )
                continue

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
                    ),
                    sorted(changed_zones),
                ))
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
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0 if payload.get('publication_allowed') else 2


if __name__ == '__main__':
    raise SystemExit(main())
