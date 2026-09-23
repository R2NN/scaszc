from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from types import MappingProxyType

from beeline_planning import (
    MasterEngineerRoute,
    MasterSolution,
    MasterSolveStatus,
    MasterVisit,
    ObjectivePolicy,
    ObjectiveProof,
    SolverConfig,
    build_master_model_input,
    build_full_coverage_routing_seed,
    load_planning_dataset,
    load_screening_matrices,
    screening_solution_quality,
    solve_screening_master,
    validate_initial_plan,
    validate_screening_solution,
)
from beeline_planning.export import load_exact_plan_artifact, master_solution_dict
from beeline_routing.export import payload_sha256, write_json_atomic


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


def _read_warm_orders(
    path: Path | None,
    dataset,
) -> tuple[dict[str, list[str]], bool]:
    if path is None:
        return {}, False
    payload = json.loads(path.read_text(encoding='utf-8'))
    unsigned = dict(payload)
    expected = unsigned.pop('content_sha256', None)
    if expected != payload_sha256(unsigned):
        raise ValueError(f'Warm-start checksum mismatch: {path}')
    if payload.get('artifact_type') == 'SCREENING_MASTER_SOLUTION':
        routes = payload.get('routes', ())
    elif isinstance(payload.get('plan'), dict):
        routes = payload['plan'].get('engineer_plans', ())
    else:
        raise ValueError(f'Unsupported warm-start artifact: {path}')
    orders = {
        route['engineer_id']: [visit['job_id'] for visit in route.get('visits', ())]
        for route in routes
    }
    protected_exact_incumbent = bool(
        payload.get('status') == 'EXACT_VALID'
        and payload.get('publication_allowed') is True
        and payload.get('dataset_sha256') == dataset.dataset_sha256
        and isinstance(payload.get('validation'), dict)
        and payload['validation'].get('status') == 'VALID'
        and isinstance(payload.get('plan'), dict)
        and payload['plan'].get('planning_at') == dataset.initial_planning_at.isoformat()
    )
    if protected_exact_incumbent:
        exact_plan, _ = load_exact_plan_artifact(path, dataset.dataset_sha256)
        if validate_initial_plan(dataset, exact_plan).status.value != 'VALID':
            # The same dataset package may contain scenarios with different
            # hard commitments. An incompatible exact plan is a poor hint as
            # well as an unsafe incumbent for the current scenario.
            return {}, False
    return orders, protected_exact_incumbent


def _project_hint(dataset, master, orders: dict[str, list[str]], screening_sha: str):
    seen: set[str] = set()
    routes: list[MasterEngineerRoute] = []
    arcs = {
        (arc.engineer_id, arc.origin_node_id, arc.destination_job_id): arc
        for arc in master.arcs
    }
    for engineer_id in sorted(orders):
        if engineer_id not in dataset.engineers:
            continue
        visits: list[MasterVisit] = []
        origin = f'START:{engineer_id}'
        engineer = dataset.engineers[engineer_id]
        previous_completion = None
        for job_id in orders[engineer_id]:
            if job_id not in dataset.jobs or job_id in seen:
                continue
            arc = arcs.get((engineer_id, origin, job_id))
            if arc is None:
                continue
            job = dataset.jobs[job_id]
            departure_at = (
                max(dataset.initial_planning_at, engineer.shift_start, job.created_at)
                if previous_completion is None
                else previous_completion
            )
            service_start_at = max(
                departure_at + timedelta(minutes=arc.screening_duration_minutes),
                job.window_start,
                job.created_at,
            )
            seen.add(job_id)
            visits.append(
                MasterVisit(
                    sequence=len(visits) + 1,
                    job_id=job_id,
                    origin_node_id=origin,
                    departure_at=departure_at,
                    service_start_at=service_start_at,
                    screening_duration_minutes=arc.screening_duration_minutes,
                    screening_distance_m=arc.screening_distance_m,
                    screening_source_mode=arc.screening_source_mode.value,
                    screening_is_surrogate=arc.screening_is_surrogate,
                )
            )
            origin = job_id
            previous_completion = service_start_at + timedelta(
                minutes=job.service_duration_min
            )
        if visits:
            routes.append(MasterEngineerRoute(engineer_id, tuple(visits)))
    active = {job.job_id for job in dataset.active_jobs_at(dataset.initial_planning_at)}
    return MasterSolution(
        status=MasterSolveStatus.SCREENING_FEASIBLE,
        planning_at=dataset.initial_planning_at,
        routes=tuple(routes),
        unserved_job_ids=tuple(sorted(active - seen)),
        objective_proofs=(),
        dataset_sha256=dataset.dataset_sha256,
        screening_snapshot_sha256=screening_sha,
        solver_version='warm-start-structure',
        search_graph_complete=False,
        searched_arc_count=0,
        operationally_excluded_arcs=(),
    )


def _merge(source, solutions: list[MasterSolution]) -> MasterSolution:
    common_proofs: list[ObjectiveProof] = []
    if solutions:
        for tier_index in range(min(len(item.objective_proofs) for item in solutions)):
            proofs = [item.objective_proofs[tier_index] for item in solutions]
            if len({proof.metric for proof in proofs}) != 1:
                break
            common_proofs.append(
                ObjectiveProof(
                    tier=tier_index + 1,
                    metric=proofs[0].metric,
                    value=sum(proof.value for proof in proofs),
                    best_bound=sum(proof.best_bound for proof in proofs),
                    proven_optimal=all(proof.proven_optimal for proof in proofs),
                    wall_time_seconds=max(proof.wall_time_seconds for proof in proofs),
                )
            )
    complete = all(item.search_graph_complete for item in solutions)
    all_optimal = bool(common_proofs) and all(
        proof.proven_optimal for proof in common_proofs
    ) and all(item.status in {
        MasterSolveStatus.SCREENING_OPTIMAL,
        MasterSolveStatus.SCREENING_RESTRICTED_OPTIMAL,
    } for item in solutions)
    status = (
        MasterSolveStatus.SCREENING_OPTIMAL
        if complete and all_optimal
        else MasterSolveStatus.SCREENING_RESTRICTED_OPTIMAL
        if all_optimal
        else MasterSolveStatus.SCREENING_FEASIBLE
    )
    return MasterSolution(
        status=status,
        planning_at=source.initial_planning_at,
        routes=tuple(sorted(
            (route for item in solutions for route in item.routes),
            key=lambda route: route.engineer_id,
        )),
        unserved_job_ids=tuple(sorted(
            job_id for item in solutions for job_id in item.unserved_job_ids
        )),
        objective_proofs=tuple(common_proofs),
        dataset_sha256=source.dataset_sha256,
        screening_snapshot_sha256=solutions[0].screening_snapshot_sha256,
        solver_version=solutions[0].solver_version,
        search_graph_complete=complete,
        searched_arc_count=sum(item.searched_arc_count for item in solutions),
        operationally_excluded_arcs=tuple(sorted({
            key for item in solutions for key in item.operationally_excluded_arcs
        })),
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Solve independent zones concurrently with adaptive route graphs.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--screening-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--warm-start', type=Path)
    parser.add_argument('--seconds-per-tier', type=float, default=30)
    parser.add_argument(
        '--polish-seconds-per-tier',
        type=float,
        default=10,
        help=(
            'Time per lexicographic tier for reducing the team count and later '
            'metrics after the best discovered coverage has been fixed. Use 0 '
            'to disable this phase.'
        ),
    )
    parser.add_argument(
        '--full-graph-polish-seconds',
        type=float,
        default=30,
        help=(
            'Additional per-zone budget for a full-graph team-minimization '
            'attempt after sparse polishing cannot remove a team. Set 0 to '
            'keep the fast sparse-only mode.'
        ),
    )
    parser.add_argument('--search-workers', type=int, default=1)
    parser.add_argument('--zone-workers', type=int, default=3)
    parser.add_argument('--adaptive-predecessors', default='8,16,0')
    parser.add_argument(
        '--cold-start-seed-seconds',
        type=int,
        default=60,
        help=(
            'Per-zone budget for a generic VRPTW coverage seed when no warm '
            'start is supplied. Set 0 to disable.'
        ),
    )
    parser.add_argument(
        '--cold-start-improve-seconds',
        type=int,
        default=10,
        help=(
            'Per-zone budget for a team-saving VRPTW search before the '
            'ordinary cold-start fallback. Set 0 to disable.'
        ),
    )
    parser.add_argument(
        '--coverage-first-only',
        action='store_true',
        help=(
            'Return immediately after CP-SAT validates full coverage and '
            'defer team minimization to exact team compaction.'
        ),
    )
    parser.add_argument(
        '--objective-policy',
        choices=('service-quality', 'compact-team'),
        default='compact-team',
    )
    args = parser.parse_args()
    if (
        args.zone_workers < 1
        or args.search_workers < 1
        or args.cold_start_seed_seconds < 0
        or args.cold_start_improve_seconds < 0
    ):
        parser.error('Worker counts must be positive')
    if (
        args.seconds_per_tier <= 0
        or args.polish_seconds_per_tier < 0
        or args.full_graph_polish_seconds < 0
    ):
        parser.error('Solve time must be positive and polish time non-negative')
    try:
        graph_sizes = tuple(int(value) for value in args.adaptive_predecessors.split(','))
    except ValueError:
        parser.error('--adaptive-predecessors must be comma-separated integers')
    if not graph_sizes or any(value < 0 for value in graph_sizes):
        parser.error('Adaptive predecessor counts must be non-negative')
    if graph_sizes[-1] != 0:
        graph_sizes += (0,)
    polish_predecessors = max(
        (size for size in graph_sizes if size > 0),
        default=None,
    )

    source = load_planning_dataset(args.dataset, args.scenario)
    screening = load_screening_matrices(args.screening_root, source)
    warm_orders, protected_exact_incumbent = _read_warm_orders(
        args.warm_start,
        source,
    )
    zones = sorted({job.zone_id for job in source.jobs.values()})
    protected_candidate = None
    protected_quality = None
    if protected_exact_incumbent:
        projected_zones = []
        for zone in zones:
            zone_dataset = _zone_dataset(source, zone)
            zone_master = build_master_model_input(zone_dataset, screening)
            projected_zones.append(_project_hint(
                zone_dataset,
                zone_master,
                warm_orders,
                screening.snapshot_sha256,
            ))
        protected_candidate = _merge(source, projected_zones)
        protected_quality = screening_solution_quality(source, protected_candidate)

    def solve_zone(
        zone: str,
    ) -> tuple[str, MasterSolution, list[int], dict[str, object]]:
        dataset = _zone_dataset(source, zone)
        master = build_master_model_input(dataset, screening)
        active_job_ids = set(master.candidate_index.active_job_ids)
        cold_seed = None
        improved_seed = None
        cold_seed_attempts: list[dict[str, object]] = []
        hint = (
            _project_hint(dataset, master, warm_orders, screening.snapshot_sha256)
            if warm_orders else None
        )
        if hint is None and args.cold_start_seed_seconds > 0:
            improved_represents_all = False
            if args.cold_start_improve_seconds > 0:
                improved_seed = build_full_coverage_routing_seed(
                    dataset,
                    master,
                    screening,
                    max_seconds=args.cold_start_improve_seconds,
                    stop_at_full_coverage=False,
                )
                improved_represents_all = (
                    {
                        visit.job_id
                        for route in improved_seed.routes
                        for visit in route.visits
                    }
                    | set(improved_seed.unserved_job_ids)
                ) == active_job_ids
                cold_seed_attempts.append({
                    'phase': 'team_search',
                    'served_jobs': sum(
                        len(route.visits) for route in improved_seed.routes
                    ),
                    'unserved_jobs': len(improved_seed.unserved_job_ids),
                    'used_engineers': len(improved_seed.routes),
                    'represents_all_active_jobs': improved_represents_all,
                })
                if improved_represents_all and not improved_seed.unserved_job_ids:
                    cold_seed = improved_seed
            if cold_seed is None:
                fallback_seed = build_full_coverage_routing_seed(
                    dataset,
                    master,
                    screening,
                    max_seconds=args.cold_start_seed_seconds,
                )
                fallback_represents_all = (
                    {
                        visit.job_id
                        for route in fallback_seed.routes
                        for visit in route.visits
                    }
                    | set(fallback_seed.unserved_job_ids)
                ) == active_job_ids
                cold_seed_attempts.append({
                    'phase': 'coverage_fallback',
                    'served_jobs': sum(
                        len(route.visits) for route in fallback_seed.routes
                    ),
                    'unserved_jobs': len(fallback_seed.unserved_job_ids),
                    'used_engineers': len(fallback_seed.routes),
                    'represents_all_active_jobs': fallback_represents_all,
                })
                if fallback_represents_all:
                    cold_seed = fallback_seed
                elif improved_represents_all:
                    cold_seed = improved_seed
            if cold_seed is not None:
                hint = cold_seed
        attempts: list[int] = []
        best_solution = (
            hint
            if hint is not None and protected_exact_incumbent
            else _project_hint(dataset, master, {}, screening.snapshot_sha256)
        )
        found_solution = hint is not None and protected_exact_incumbent
        retry_with_coverage_seed = cold_seed is not None and cold_seed is improved_seed
        for seed_round in range(2):
            for size in graph_sizes:
                attempts.append(size)
                validate_full_seed = (
                    hint is not None and not hint.unserved_job_ids
                )
                candidate = solve_screening_master(
                    dataset,
                    master,
                    SolverConfig(
                        max_seconds_per_tier=args.seconds_per_tier,
                        num_search_workers=args.search_workers,
                        max_predecessors_per_destination=size or None,
                        require_full_coverage=validate_full_seed,
                        stop_after_full_coverage=(
                            args.coverage_first_only and validate_full_seed
                        ),
                        stop_after_coverage=args.coverage_first_only,
                        full_coverage_seconds=args.seconds_per_tier,
                        objective_policy=(
                            ObjectivePolicy.SERVICE_QUALITY
                            if args.objective_policy == 'service-quality'
                            else ObjectivePolicy.COMPACT_TEAM
                        ),
                    ),
                    hint_solution=hint,
                )
                represented = {
                    visit.job_id
                    for route in candidate.routes
                    for visit in route.visits
                } | set(candidate.unserved_job_ids)
                if represented == active_job_ids:
                    if (
                        not found_solution
                        or screening_solution_quality(dataset, candidate).key
                        < screening_solution_quality(dataset, best_solution).key
                    ):
                        best_solution = candidate
                        found_solution = True
                    hint = best_solution
                if found_solution and not best_solution.unserved_job_ids:
                    break
            if (
                found_solution and not best_solution.unserved_job_ids
            ) or not retry_with_coverage_seed or seed_round:
                break
            fallback_seed = build_full_coverage_routing_seed(
                dataset,
                master,
                screening,
                max_seconds=args.cold_start_seed_seconds,
            )
            fallback_represents_all = (
                {
                    visit.job_id
                    for route in fallback_seed.routes
                    for visit in route.visits
                }
                | set(fallback_seed.unserved_job_ids)
            ) == active_job_ids
            cold_seed_attempts.append({
                'phase': 'coverage_retry',
                'served_jobs': sum(
                    len(route.visits) for route in fallback_seed.routes
                ),
                'unserved_jobs': len(fallback_seed.unserved_job_ids),
                'used_engineers': len(fallback_seed.routes),
                'represents_all_active_jobs': fallback_represents_all,
            })
            if not fallback_represents_all:
                break
            cold_seed = fallback_seed
            hint = fallback_seed

        polish: dict[str, object] = {
            'cold_start_seed': (
                {
                    'attempted': True,
                    'served_jobs': sum(
                        len(route.visits) for route in cold_seed.routes
                    ),
                    'unserved_jobs': len(cold_seed.unserved_job_ids),
                    'used_engineers': len(cold_seed.routes),
                    'attempts': cold_seed_attempts,
                }
                if cold_seed is not None
                else {
                    'attempted': bool(cold_seed_attempts),
                    'attempts': cold_seed_attempts,
                }
            ),
            'enabled': (
                not args.coverage_first_only
                and (
                    args.polish_seconds_per_tier > 0
                    or args.full_graph_polish_seconds > 0
                )
            ),
            'attempted': False,
            'applied': False,
        }
        if not args.coverage_first_only and found_solution and (
            args.polish_seconds_per_tier > 0
            or args.full_graph_polish_seconds > 0
        ):
            quality_before = screening_solution_quality(dataset, best_solution)
            polish.update({
                'attempted': True,
                'fixed_unserved_urgent_jobs': quality_before.unserved_urgent_jobs,
                'fixed_unserved_normal_jobs': quality_before.unserved_normal_jobs,
                'target_max_used_engineers': max(
                    0,
                    quality_before.used_engineers - 1,
                ),
                'max_predecessors_per_destination': polish_predecessors,
                'quality_before': quality_before.as_dict(),
                'attempts': [],
            })
            polish_attempts: list[tuple[str, int | None, float]] = []
            if args.polish_seconds_per_tier > 0:
                polish_attempts.append(
                    ('sparse', polish_predecessors, args.polish_seconds_per_tier)
                )
            if (
                polish_predecessors is not None
                and args.full_graph_polish_seconds > 0
            ):
                polish_attempts.append(
                    ('full_graph', None, args.full_graph_polish_seconds)
                )
            for graph_kind, predecessor_limit, time_budget in polish_attempts:
                polished = solve_screening_master(
                    dataset,
                    master,
                    SolverConfig(
                        max_seconds_per_tier=time_budget,
                        num_search_workers=args.search_workers,
                        max_predecessors_per_destination=predecessor_limit,
                        require_full_coverage=False,
                        fixed_unserved_by_priority=(
                            quality_before.unserved_urgent_jobs,
                            quality_before.unserved_normal_jobs,
                        ),
                        max_used_engineers=max(
                            0,
                            quality_before.used_engineers - 1,
                        ),
                        objective_policy=ObjectivePolicy.COMPACT_TEAM,
                    ),
                    hint_solution=best_solution,
                )
                represented = {
                    visit.job_id
                    for route in polished.routes
                    for visit in route.visits
                } | set(polished.unserved_job_ids)
                attempt = {
                    'graph': graph_kind,
                    'max_predecessors_per_destination': predecessor_limit,
                    'seconds_per_tier': time_budget,
                    'result_status': polished.status.value,
                    'represents_all_active_jobs': represented == active_job_ids,
                }
                polish['attempts'].append(attempt)
                polish['result_status'] = polished.status.value
                if represented != active_job_ids:
                    continue
                quality_after = screening_solution_quality(dataset, polished)
                attempt['quality_after'] = quality_after.as_dict()
                used_proof = next(
                    (
                        proof
                        for proof in polished.objective_proofs
                        if proof.metric == 'used_engineers'
                    ),
                    None,
                )
                if used_proof is not None:
                    attempt['used_engineers_proof'] = {
                        'value': used_proof.value,
                        'best_bound': used_proof.best_bound,
                        'proven_optimal_under_fixed_coverage': (
                            used_proof.proven_optimal
                        ),
                    }
                if quality_after.key < quality_before.key:
                    best_solution = polished
                    polish['quality_after'] = quality_after.as_dict()
                    polish['used_engineers_proof'] = attempt.get(
                        'used_engineers_proof'
                    )
                    polish['applied'] = True
                    break
        return (
            zone,
            best_solution if found_solution else candidate,
            attempts,
            polish,
        )

    with ThreadPoolExecutor(max_workers=min(args.zone_workers, len(zones))) as executor:
        zone_results = list(executor.map(solve_zone, zones))
    solutions = [item[1] for item in zone_results]
    def is_complete_result(zone: str, solution: MasterSolution) -> bool:
        expected = {
            job.job_id
            for job in source.active_jobs_at(source.initial_planning_at)
            if job.zone_id == zone
        }
        represented = {
            visit.job_id for route in solution.routes for visit in route.visits
        } | set(solution.unserved_job_ids)
        return represented == expected

    if any(
        not is_complete_result(zone, solution)
        for zone, solution, _, _ in zone_results
    ):
        failed = [
            zone
            for zone, solution, _, _ in zone_results
            if not is_complete_result(zone, solution)
        ]
        raise RuntimeError(f'No screening solution for zones: {failed}')
    merged = _merge(source, solutions)
    final_quality = screening_solution_quality(source, merged)
    incumbent_fallback_used = False
    if (
        protected_candidate is not None
        and protected_quality is not None
        and final_quality.key > protected_quality.key
    ):
        merged = protected_candidate
        final_quality = protected_quality
        incumbent_fallback_used = True
    if not incumbent_fallback_used:
        violations = validate_screening_solution(
            source,
            build_master_model_input(source, screening),
            merged,
        )
        if violations:
            raise RuntimeError(
                'Independent screening validation failed: '
                + '; '.join(violations[:5])
            )
    payload = master_solution_dict(merged)
    payload['decomposition'] = {
        'independent_zones': True,
        'parallel_workers': min(args.zone_workers, len(zones)),
        'adaptive_graph_attempts': {
            zone: attempts for zone, _, attempts, _ in zone_results
        },
        'coverage_preserving_polish': {
            zone: polish for zone, _, _, polish in zone_results
        },
        'warm_start': str(args.warm_start) if args.warm_start else None,
        'protected_exact_incumbent': protected_exact_incumbent,
        'protected_incumbent_quality': (
            protected_quality.as_dict() if protected_quality is not None else None
        ),
        'incumbent_fallback_used': incumbent_fallback_used,
        'final_quality': final_quality.as_dict(),
    }
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({
        'status': merged.status.value,
        'output': str(args.output),
        **payload['summary'],
        'zones': zones,
        'adaptive_graph_attempts': payload['decomposition']['adaptive_graph_attempts'],
        'coverage_preserving_polish': (
            payload['decomposition']['coverage_preserving_polish']
        ),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
