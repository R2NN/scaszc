from __future__ import annotations

import argparse
import json
from dataclasses import replace
from itertools import combinations
from pathlib import Path

from beeline_planning import (
    build_candidate_index,
    load_planning_dataset,
    materialize_exact_initial_plan,
)
from beeline_planning.exact_repair import master_from_orders
from beeline_planning.export import load_master_solution, materialization_result_dict
from beeline_planning.materialize import MaterializationStatus
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def _within_route_neighbors(order: tuple[str, ...]):
    seen: set[tuple[str, ...]] = set()
    for source in range(len(order)):
        reduced = order[:source] + order[source + 1:]
        for destination in range(len(order)):
            candidate = reduced[:destination] + (order[source],) + reduced[destination:]
            if candidate != order and candidate not in seen:
                seen.add(candidate)
                yield 'relocate', candidate
    for left in range(len(order)):
        for right in range(left + 1, len(order)):
            candidate = list(order)
            candidate[left], candidate[right] = candidate[right], candidate[left]
            value = tuple(candidate)
            if value not in seen:
                seen.add(value)
                yield 'swap', value
            reversed_value = order[:left] + tuple(reversed(order[left:right + 1])) + order[right + 1:]
            if reversed_value != order and reversed_value not in seen:
                seen.add(reversed_value)
                yield 'reverse', reversed_value


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Repair an all-covered screening proposal until every route is exact-valid.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--input-candidate', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-route-checks', type=int, default=5000)
    parser.add_argument(
        '--focus-engineer',
        help='Repair one already diagnosed route, then run complete final validation.',
    )
    parser.add_argument(
        '--skip-single-repairs',
        action='store_true',
        help='Skip single-route and single-job moves already exhausted by a prior run.',
    )
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument('--timeout-seconds', type=float, default=60)
    parser.add_argument('--max-attempts', type=int, default=1)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Exact repair requires explicit --execute')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    candidate = load_master_solution(args.input_candidate)
    if candidate.dataset_sha256 != dataset.dataset_sha256:
        raise ValueError('Candidate belongs to another dataset')
    if candidate.unserved_job_ids:
        raise ValueError('Candidate must cover every active job before exact repair')

    routes = {
        route.engineer_id: tuple(visit.job_id for visit in route.visits)
        for route in candidate.routes
    }
    for engineer_id in dataset.engineers:
        routes.setdefault(engineer_id, ())
    active = {
        job.job_id for job in dataset.active_jobs_at(dataset.initial_planning_at)
    }
    assigned = [job_id for order in routes.values() for job_id in order]
    if len(assigned) != len(set(assigned)) or set(assigned) != active:
        raise ValueError('Candidate has duplicate, missing, or inactive assignments')

    candidates = build_candidate_index(dataset)
    oracle = ExactRoutingOracle(
        create_route_client(
            RoutingCache(args.cache),
            'valhalla-local-transit',
            timeout_seconds=args.timeout_seconds,
            max_attempts=args.max_attempts,
            transit_index=args.transit_index,
            metro_wait_seconds=args.metro_wait_seconds,
        )
    )
    isolated_dataset = replace(dataset, commitments=())
    cache: dict[tuple[str, tuple[str, ...]], bool] = {}
    checks = 0

    def valid(engineer_id: str, order: tuple[str, ...]) -> bool:
        nonlocal checks
        key = (engineer_id, order)
        if key in cache:
            return cache[key]
        if checks >= args.max_route_checks:
            raise RuntimeError('Exact route-check budget exhausted')
        checks += 1
        proposal = master_from_orders(
            isolated_dataset,
            {engineer_id: order},
            active - set(order),
        )
        result = materialize_exact_initial_plan(isolated_dataset, proposal, oracle)
        cache[key] = result.status == MaterializationStatus.EXACT_VALID
        if checks % 25 == 0:
            print(f'Checked {checks} exact route orders', flush=True)
        return cache[key]

    changes: list[dict[str, object]] = []
    while True:
        invalid = (
            [args.focus_engineer]
            if args.focus_engineer and not changes
            else [
                engineer_id
                for engineer_id, order in sorted(routes.items())
                if order and not valid(engineer_id, order)
            ]
        )
        if not invalid:
            break
        failing = invalid[0]
        original = routes[failing]
        repaired = False

        within_trials = (
            () if args.skip_single_repairs else _within_route_neighbors(original)
        )
        for kind, trial in within_trials:
            if valid(failing, trial):
                routes[failing] = trial
                changes.append({'kind': kind, 'engineer_ids': [failing]})
                print(f'Repaired {failing} with {kind}', flush=True)
                repaired = True
                break
        if repaired:
            if args.focus_engineer:
                break
            continue

        engineer = dataset.engineers[failing]
        source_jobs = () if args.skip_single_repairs else enumerate(original)
        for source_position, job_id in source_jobs:
            source_trial = original[:source_position] + original[source_position + 1:]
            if source_trial and not valid(failing, source_trial):
                continue
            for target in candidates.eligible_engineers_by_job[job_id]:
                if target == failing or dataset.engineers[target].zone_id != engineer.zone_id:
                    continue
                target_order = routes[target]
                if len(target_order) >= dataset.engineers[target].max_jobs:
                    continue
                for destination in range(len(target_order) + 1):
                    target_trial = (
                        target_order[:destination]
                        + (job_id,)
                        + target_order[destination:]
                    )
                    if valid(target, target_trial):
                        routes[failing] = source_trial
                        routes[target] = target_trial
                        changes.append({
                            'kind': 'cross_route_relocate',
                            'job_id': job_id,
                            'engineer_ids': [failing, target],
                        })
                        print(
                            f'Repaired {failing}: moved {job_id} to {target}',
                            flush=True,
                        )
                        repaired = True
                        break
                if repaired:
                    break
            if repaired:
                break
        if repaired:
            if args.focus_engineer:
                break
            continue

        used_targets = tuple(
            engineer_id
            for engineer_id, order in sorted(routes.items())
            if engineer_id != failing and order
        )

        def place_removed(
            pending: tuple[str, ...],
            working: dict[str, tuple[str, ...]],
        ) -> dict[str, tuple[str, ...]] | None:
            if not pending:
                return working
            job_id = min(
                pending,
                key=lambda value: sum(
                    target in candidates.eligible_engineers_by_job[value]
                    and len(working[target]) < dataset.engineers[target].max_jobs
                    for target in used_targets
                ),
            )
            rest = tuple(value for value in pending if value != job_id)
            for target in used_targets:
                if target not in candidates.eligible_engineers_by_job[job_id]:
                    continue
                target_order = working[target]
                if len(target_order) >= dataset.engineers[target].max_jobs:
                    continue
                for destination in range(len(target_order) + 1):
                    target_trial = (
                        target_order[:destination]
                        + (job_id,)
                        + target_order[destination:]
                    )
                    if not valid(target, target_trial):
                        continue
                    next_working = dict(working)
                    next_working[target] = target_trial
                    result = place_removed(rest, next_working)
                    if result is not None:
                        return result
            return None

        for removal_count in range(2, min(4, len(original) - 1) + 1):
            for positions in combinations(range(len(original)), removal_count):
                position_set = set(positions)
                source_trial = tuple(
                    job_id
                    for index, job_id in enumerate(original)
                    if index not in position_set
                )
                if not valid(failing, source_trial):
                    continue
                removed = tuple(original[index] for index in positions)
                working = dict(routes)
                working[failing] = source_trial
                placed = place_removed(removed, working)
                if placed is None:
                    continue
                changed_targets = sorted(
                    engineer_id
                    for engineer_id in placed
                    if placed[engineer_id] != routes[engineer_id]
                )
                routes = placed
                changes.append({
                    'kind': 'multi_job_redistribution',
                    'job_ids': list(removed),
                    'engineer_ids': changed_targets,
                })
                print(
                    f'Repaired {failing}: redistributed {list(removed)} '
                    f'across {changed_targets}',
                    flush=True,
                )
                repaired = True
                break
            if repaired:
                break
        if repaired:
            if args.focus_engineer:
                break
            continue
        raise RuntimeError(f'No exact-valid local repair found for {failing}')

    final_routes = {engineer_id: order for engineer_id, order in routes.items() if order}
    final = materialize_exact_initial_plan(
        dataset,
        master_from_orders(dataset, final_routes, set()),
        oracle,
    )
    payload = materialization_result_dict(final)
    payload['artifact_type'] = 'EXACT_PLAN_FULL_COVERAGE_REPAIR'
    payload['source_candidate'] = str(args.input_candidate)
    payload['repair_changes'] = changes
    payload['exact_route_order_checks'] = checks
    payload['dataset_sha256'] = dataset.dataset_sha256
    payload['routing_configuration'] = {
        'provider': 'valhalla-local-transit',
        'transit_index': str(args.transit_index),
        'metro_wait_assumption_seconds': args.metro_wait_seconds,
        'query_time_api_key_required': False,
        'exact_historical_metro_timetable_proof': False,
    }
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({
        'status': final.status.value,
        'publication_allowed': payload['publication_allowed'],
        'served_jobs': sum(len(order) for order in final_routes.values()),
        'unserved_jobs': 0,
        'used_engineers': len(final_routes),
        'route_order_checks': checks,
        'changes': changes,
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0 if payload['publication_allowed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
