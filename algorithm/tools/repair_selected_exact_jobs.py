"""Add selected missed jobs to a saved exact plan and revalidate the day."""

from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path

from beeline_planning import (
    build_candidate_index, build_explanation_bundle, load_planning_dataset,
    validate_initial_plan,
)
from beeline_planning.departure_timing import retime_initial_departures
from beeline_planning.exact_repair import find_coverage_move, master_from_orders
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import (
    MaterializationResult, MaterializationStatus, _materialize_route,
)
from beeline_planning.plan import IdentityTravel
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def exact_result(plan, validation, queries: int) -> MaterializationResult:
    """Wrap an independently valid plan as an exact materialization result."""
    if validation.status.value != 'VALID':
        raise ValueError('The merged plan failed independent validation')
    return MaterializationResult(
        status=MaterializationStatus.EXACT_VALID,
        plan=plan,
        validation=validation,
        failure=None,
        exact_provider_queries=queries,
        identity_legs=sum(
            isinstance(visit.travel, IdentityTravel)
            for route in plan.engineer_plans for visit in route.visits
        ),
    )


def save_plan(path: Path, dataset, result: MaterializationResult,
              source: dict, source_path: Path, moves: list[dict],
              exact_checks: int, *, timing=None) -> None:
    """Write a checksummed artifact with current explanations and provenance."""
    payload = materialization_result_dict(result)
    payload.update({
        'artifact_type': 'EXACT_PLAN_TARGETED_COVERAGE_REPAIR',
        'dataset_sha256': dataset.dataset_sha256,
        'source_plan': str(source_path),
        'source_plan_content_sha256': source['content_sha256'],
        'accepted_moves': moves,
        'search_configuration': {
            'method': 'DIRECT_EXACT_INSERTION',
            'max_displacements': 0,
            'route_reordering': True,
            'global_optimality_proven': False,
        },
        'explanations': build_explanation_bundle(
            dataset, result.plan, result.validation,
            exact_route_checks=exact_checks,
            exact_provider_queries=result.exact_provider_queries,
            global_optimality_proven=False,
        ),
    })
    if timing is not None:
        payload['departure_timing'] = timing
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(path, payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--day-root', type=Path, required=True)
    parser.add_argument('--target-job', action='append', required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--max-search-seconds-per-job', type=float, default=90)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Exact route repair requires --execute')
    if args.max_search_seconds_per_job <= 0:
        parser.error('Search time must be positive')

    day_root = args.day_root.resolve()
    status = json.loads((day_root / 'status.json').read_text(encoding='utf-8'))
    if status['status'] != 'COMPLETE' or status['validation_status'] != 'VALID':
        raise ValueError('Source day is incomplete')
    dataset = load_planning_dataset(day_root / 'dataset', 'core')
    source_path = Path(status['final_plan'])
    plan, source = load_exact_plan_artifact(source_path, dataset.dataset_sha256)
    if source['content_sha256'] != status['artifact_sha256']:
        raise ValueError('Source plan differs from the selected day artifact')
    if validate_initial_plan(dataset, plan).status.value != 'VALID':
        raise ValueError('Source plan fails full independent validation')
    targets = tuple(dict.fromkeys(args.target_job))
    if len(targets) != len(args.target_job) or not set(targets) <= set(plan.unserved_job_ids):
        raise ValueError('Targets must be distinct unserved jobs in this source plan')

    output = source_path.parent / 'core-targeted-urgent-exact.json'
    retimed_output = source_path.parent / 'core-targeted-urgent-retimed.json'
    if output.exists() or retimed_output.exists():
        raise FileExistsError('Targeted output already exists; inspect it before rerunning')
    client = create_route_client(
        RoutingCache(args.cache), 'valhalla-local-transit',
        timeout_seconds=8, max_attempts=1,
        transit_index=Path(status['transit_index']), metro_wait_seconds=180,
    )
    oracle = ExactRoutingOracle(client)
    try:
        candidates = build_candidate_index(dataset)
        exact_checks = 0
        route_queries = 0
        moves = []
        for job_id in targets:
            routes = {
                route.engineer_id: tuple(visit.job_id for visit in route.visits)
                for route in plan.engineer_plans
            }
            route_results = {}

            def route_check(engineer_id: str, order: tuple[str, ...]) -> bool:
                nonlocal exact_checks, route_queries
                master = master_from_orders(dataset, {engineer_id: order}, set())
                result = _materialize_route(
                    dataset, master.routes[0], oracle,
                    drop_order_infeasible=False,
                )
                exact_checks += 1
                route_queries += result.exact_queries
                route_results[engineer_id, order] = result
                return result.plan is not None

            report = find_coverage_move(
                dataset, routes, {job_id}, candidates, route_check,
                max_route_checks=200, max_displacements=0,
                reorder_affected_routes=True,
                max_seconds=args.max_search_seconds_per_job,
            )
            if report.move is None:
                raise RuntimeError(
                    f'{job_id}: no exact direct insertion within search budget; '
                    f'checks={report.route_checks}, exhausted={report.budget_exhausted}'
                )
            changed = {}
            for engineer_id, order in report.move.routes.items():
                result = route_results[engineer_id, order]
                if result.plan is None:
                    raise AssertionError('Search selected a route without exact evidence')
                changed[engineer_id] = result.plan
            old_routes = {route.engineer_id: route for route in plan.engineer_plans}
            old_routes.update(changed)
            trial = replace(
                plan,
                engineer_plans=tuple(old_routes[key] for key in sorted(old_routes)),
                unserved_job_ids=tuple(sorted(set(plan.unserved_job_ids) - {job_id})),
            )
            validation = validate_initial_plan(dataset, trial)
            if validation.status.value != 'VALID':
                raise ValueError(f'{job_id}: merged plan failed validation: {validation.violations}')
            plan = trial
            moves.append({
                'job_id': job_id,
                'kind': report.move.kind,
                'changed_engineer_ids': sorted(changed),
                'route_checks': report.route_checks,
                'budget_exhausted': report.budget_exhausted,
            })
            print(json.dumps({'job_id': job_id, 'assigned_to': sorted(changed),
                              'route_checks': report.route_checks}), flush=True)

        validation = validate_initial_plan(dataset, plan)
        source_queries = source.get('exact_provider_queries')
        total_queries = route_queries + (source_queries if isinstance(source_queries, int) else 0)
        result = exact_result(plan, validation, total_queries)
        save_plan(output, dataset, result, source, source_path, moves, exact_checks)

        timing = retime_initial_departures(
            dataset, plan, oracle,
            max_total_queries=200, max_queries_per_leg=12,
        )
        final_validation = validate_initial_plan(dataset, timing.plan)
        final_result = exact_result(
            timing.plan, final_validation, total_queries + timing.exact_queries,
        )
        timing_metadata = {
            'method': 'EXACT_REROUTE_AND_FULL_VALIDATION',
            'input_plan_content_sha256': json.loads(
                output.read_text(encoding='utf-8')
            )['content_sha256'],
            'arrival_buffer_minutes': 15,
            'changed_legs': timing.changed_legs,
            'additional_exact_queries': timing.exact_queries,
            'client_wait_before_minutes': timing.client_wait_before_minutes,
            'client_wait_after_minutes': timing.client_wait_after_minutes,
            'worst_client_wait_before_minutes': timing.worst_client_wait_before_minutes,
            'worst_client_wait_after_minutes': timing.worst_client_wait_after_minutes,
        }
        save_plan(
            retimed_output, dataset, final_result, source, source_path,
            moves, exact_checks, timing=timing_metadata,
        )
        old_metrics = source['validation']['metrics']
        new_metrics = json.loads(retimed_output.read_text(encoding='utf-8'))['validation']['metrics']
        if (
            new_metrics['unserved_urgent_jobs']
            != old_metrics['unserved_urgent_jobs'] - len(targets)
            or new_metrics['unserved_normal_jobs']
            != old_metrics['unserved_normal_jobs']
        ):
            raise ValueError('Targeted output changed coverage outside selected urgent jobs')
        print(json.dumps({
            'output': str(retimed_output),
            'urgent_missed_before': old_metrics['unserved_urgent_jobs'],
            'urgent_missed_after': new_metrics['unserved_urgent_jobs'],
            'normal_missed': new_metrics['unserved_normal_jobs'],
            'worst_client_wait_minutes': timing.worst_client_wait_after_minutes,
            'exact_route_checks': exact_checks,
        }, ensure_ascii=False), flush=True)
    finally:
        close = getattr(client, 'close', None)
        if close is not None:
            close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
