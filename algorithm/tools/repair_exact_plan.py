from __future__ import annotations

import argparse
import json
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from time import monotonic

from beeline_planning import (
    build_explanation_bundle,
    build_candidate_index,
    find_exact_lns_coverage_move,
    load_planning_dataset,
    load_screening_matrices,
    materialize_exact_initial_plan,
)
from beeline_planning.exact_repair import find_coverage_move, master_from_orders
from beeline_planning.export import materialization_result_dict
from beeline_planning.materialize import MaterializationStatus
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            'Repair exact coverage using ejection chains and exact-aware '
            'large-neighbourhood search.'
        )
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument(
        '--screening-root',
        type=Path,
        help=(
            'Optional optimistic screening matrices used to reject impossible '
            'route orders before expensive exact routing.'
        ),
    )
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-route-checks', type=int, default=5000)
    parser.add_argument(
        '--max-displacements',
        type=int,
        choices=(0, 1, 2, 3, 4),
        default=4,
    )
    parser.add_argument(
        '--checks-by-depth',
        help='Comma-separated exact-check limits for direct, relocation and chain phases.',
    )
    parser.add_argument('--max-passes', type=int, default=10)
    parser.add_argument(
        '--max-search-seconds-per-pass', type=float,
        help='Bound search between two accepted, fully validated coverage moves.',
    )
    parser.add_argument('--lns-route-checks', type=int, default=2500)
    parser.add_argument('--lns-beam-width', type=int, default=48)
    parser.add_argument('--lns-max-destroyed-jobs', type=int, default=12)
    parser.add_argument('--lns-max-engineers', type=int, default=4)
    parser.add_argument('--lns-window-padding-minutes', type=int, default=120)
    parser.add_argument('--lns-neighbour-radius', type=int, default=1)
    parser.add_argument('--skip-exact-lns', action='store_true')
    parser.add_argument('--timeout-seconds', type=float, default=30)
    parser.add_argument('--max-attempts', type=int, default=2)
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument(
        '--trust-input-validation', action='store_true',
        help='Skip repeating exact validation of a checksummed published input; '
             'every changed plan is still fully rematerialized.',
    )
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Exact repair requires explicit --execute')
    if args.output.resolve() == args.input_plan.resolve() or args.output.exists():
        parser.error('Output must be a new file, distinct from the input plan')
    if args.max_passes < 1:
        parser.error('--max-passes must be positive')
    if args.max_search_seconds_per_pass is not None and args.max_search_seconds_per_pass <= 0:
        parser.error('--max-search-seconds-per-pass must be positive')
    if min(
        args.lns_route_checks,
        args.lns_beam_width,
        args.lns_max_destroyed_jobs,
        args.lns_max_engineers,
    ) < 1:
        parser.error('Exact LNS budgets must be positive')
    if args.lns_window_padding_minutes < 0 or args.lns_neighbour_radius < 0:
        parser.error('Exact LNS neighbourhood limits must be non-negative')
    checks_by_depth = None
    if args.checks_by_depth:
        try:
            checks_by_depth = tuple(
                int(value.strip()) for value in args.checks_by_depth.split(',')
            )
        except ValueError:
            parser.error('--checks-by-depth must contain positive integers')
        if (
            len(checks_by_depth) != args.max_displacements + 1
            or any(value < 1 for value in checks_by_depth)
        ):
            parser.error('--checks-by-depth must have one positive value per depth')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    source = json.loads(args.input_plan.read_text(encoding='utf-8'))
    expected_checksum = source.get('content_sha256')
    unsigned_source = dict(source)
    unsigned_source.pop('content_sha256', None)
    if expected_checksum != payload_sha256(unsigned_source):
        parser.error('Input plan content checksum mismatch')
    if source.get('status') != 'EXACT_VALID' or not source.get('publication_allowed'):
        parser.error('Input must be a published exact-valid plan')
    if source.get('dataset_sha256') != dataset.dataset_sha256:
        parser.error('Input plan belongs to another dataset checksum')
    if source['plan']['planning_at'] != dataset.initial_planning_at.isoformat():
        parser.error('Only the initial plan at dataset.initial_planning_at is supported')

    routes = {
        route['engineer_id']: tuple(visit['job_id'] for visit in route['visits'])
        for route in source['plan']['engineer_plans']
    }
    for engineer_id in dataset.engineers:
        routes.setdefault(engineer_id, ())
    unserved = set(source['plan']['unserved_job_ids'])
    all_active = set(job.job_id for job in dataset.active_jobs_at(dataset.initial_planning_at))
    assigned = [job_id for order in routes.values() for job_id in order]
    if len(assigned) != len(set(assigned)) or set(assigned) | unserved != all_active:
        parser.error('Input plan has duplicate or missing job results')
    if set(assigned) & unserved:
        parser.error('Input plan assigns a job also listed as unserved')

    oracle = ExactRoutingOracle(create_route_client(
        RoutingCache(args.cache),
        'valhalla-local-transit',
        timeout_seconds=args.timeout_seconds,
        max_attempts=args.max_attempts,
        transit_index=args.transit_index,
        metro_wait_seconds=args.metro_wait_seconds,
    ))
    initial = None
    if not args.trust_input_validation:
        initial = materialize_exact_initial_plan(
            dataset, master_from_orders(dataset, routes, unserved), oracle
        )
        if initial.status != MaterializationStatus.EXACT_VALID:
            parser.error(f'Input route orders fail exact rematerialization: {initial.failure}')
    print(
        f'Initial exact plan: {len(assigned)} served, {len(unserved)} unserved',
        flush=True,
    )

    candidates = build_candidate_index(dataset)
    screening = (
        load_screening_matrices(args.screening_root, dataset)
        if args.screening_root is not None
        else None
    )
    single_route_dataset = replace(dataset, commitments=())
    route_results: dict[tuple[str, tuple[str, ...]], bool] = {}
    for engineer_id, order in routes.items():
        route_results[engineer_id, order] = True
    computed_routes = 0
    screening_rejections = 0

    def screening_route_feasible(
        engineer_id: str,
        order: tuple[str, ...],
    ) -> bool:
        if screening is None or not order:
            return True
        engineer = dataset.engineers[engineer_id]
        previous_location_id = dataset.offices[
            engineer.start_office_id
        ].location_id
        moment = max(
            dataset.initial_planning_at,
            engineer.shift_start,
            dataset.jobs[order[0]].created_at,
        )
        route_start = moment
        for job_id in order:
            job = dataset.jobs[job_id]
            duration = (
                0
                if previous_location_id == job.location_id
                else screening.estimate(
                    engineer.zone_id,
                    engineer.transport_mode,
                    previous_location_id,
                    job.location_id,
                ).duration_minutes
            )
            service_start = max(
                moment + timedelta(minutes=duration),
                job.window_start,
                job.created_at,
            )
            service_end = service_start + timedelta(
                minutes=job.service_duration_min
            )
            if (
                service_start > job.window_end
                or service_end > engineer.shift_end
                or service_end - route_start
                > timedelta(minutes=engineer.max_route_minutes)
            ):
                return False
            moment = service_end
            previous_location_id = job.location_id
        return True

    def exact_route_valid(engineer_id: str, order: tuple[str, ...]) -> bool:
        nonlocal computed_routes, screening_rejections
        key = (engineer_id, order)
        if key not in route_results:
            if not screening_route_feasible(engineer_id, order):
                route_results[key] = False
                screening_rejections += 1
                return False
            proposal = master_from_orders(
                single_route_dataset,
                {engineer_id: order},
                all_active - set(order),
            )
            result = materialize_exact_initial_plan(
                single_route_dataset, proposal, oracle
            )
            route_results[key] = result.status == MaterializationStatus.EXACT_VALID
            computed_routes += 1
            if computed_routes % 25 == 0:
                print(f'Checked {computed_routes} changed route orders', flush=True)
        return route_results[key]

    accepted: list[dict[str, object]] = []
    reports: list[dict[str, object]] = []
    lns_reports: list[dict[str, object]] = []
    current = initial
    for pass_number in range(1, args.max_passes + 1):
        if not unserved:
            break
        pass_deadline = (
            monotonic() + args.max_search_seconds_per_pass
            if args.max_search_seconds_per_pass is not None else None
        )
        report = find_coverage_move(
            dataset,
            routes,
            unserved,
            candidates,
            exact_route_valid,
            max_route_checks=args.max_route_checks,
            max_displacements=args.max_displacements,
            max_checks_by_depth=checks_by_depth,
            reorder_affected_routes=True,
            max_seconds=(
                args.max_search_seconds_per_pass * 0.7
                if args.max_search_seconds_per_pass is not None else None
            ),
        )
        reports.append({
            'pass': pass_number,
            'route_checks': report.route_checks,
            'route_checks_by_depth': list(report.route_checks_by_depth),
            'route_checks_by_job': dict(report.route_checks_by_job),
            'zero_travel_rejections': report.zero_travel_rejections,
            'budget_exhausted': report.budget_exhausted,
            'move_found': report.move is not None,
        })
        move_routes = report.move.routes if report.move is not None else None
        inserted_job_id = (
            report.move.inserted_job_id if report.move is not None else None
        )
        accepted_kind = report.move.kind if report.move is not None else None
        accepted_details: dict[str, object] = {
            'displaced_job_ids': (
                list(report.move.displaced_job_ids) if report.move is not None else []
            ),
        }
        lns_report = None
        remaining_seconds = (
            pass_deadline - monotonic() if pass_deadline is not None else None
        )
        if (
            report.move is None
            and not args.skip_exact_lns
            and (remaining_seconds is None or remaining_seconds > 0)
        ):
            lns_report = find_exact_lns_coverage_move(
                dataset,
                routes,
                unserved,
                candidates,
                exact_route_valid,
                max_route_checks=args.lns_route_checks,
                beam_width=args.lns_beam_width,
                max_destroyed_jobs=args.lns_max_destroyed_jobs,
                max_engineers=args.lns_max_engineers,
                window_padding_minutes=args.lns_window_padding_minutes,
                neighbour_radius=args.lns_neighbour_radius,
                max_seconds=remaining_seconds,
            )
            lns_reports.append({
                'pass': pass_number,
                'route_checks': lns_report.route_checks,
                'expanded_states': lns_report.expanded_states,
                'zero_travel_rejections': lns_report.zero_travel_rejections,
                'neighbourhoods_tried': lns_report.neighbourhoods_tried,
                'complete_states_checked': lns_report.complete_states_checked,
                'budget_exhausted': lns_report.budget_exhausted,
                'move_found': lns_report.move is not None,
            })
            if lns_report.move is not None:
                move_routes = lns_report.move.routes
                inserted_job_id = lns_report.move.inserted_job_id
                accepted_kind = 'EXACT_AWARE_LNS'
                accepted_details = {
                    'destroyed_job_ids': list(lns_report.move.destroyed_job_ids),
                    'neighbourhood_engineer_ids': list(
                        lns_report.move.neighbourhood_engineer_ids
                    ),
                }

        if move_routes is None or inserted_job_id is None or accepted_kind is None:
            print(
                f'Pass {pass_number}: no coverage move; chain checks='
                f'{report.route_checks}, LNS checks='
                f'{lns_report.route_checks if lns_report is not None else 0}',
                flush=True,
            )
            break
        trial_routes = dict(routes)
        trial_routes.update(move_routes)
        trial_unserved = unserved - {inserted_job_id}
        trial = materialize_exact_initial_plan(
            dataset,
            master_from_orders(dataset, trial_routes, trial_unserved),
            oracle,
        )
        if trial.status != MaterializationStatus.EXACT_VALID:
            raise RuntimeError(
                'A route-local valid move failed complete exact validation: '
                f'{trial.failure or trial.validation.violations if trial.validation else trial.failure}'
            )
        routes = trial_routes
        unserved = trial_unserved
        current = trial
        accepted.append({
            'pass': pass_number,
            'job_id': inserted_job_id,
            'kind': accepted_kind,
            **accepted_details,
            'changed_engineer_ids': sorted(move_routes),
        })
        checkpoint = materialization_result_dict(trial)
        checkpoint['artifact_type'] = 'EXACT_PLAN_COVERAGE_REPAIR'
        checkpoint['source_plan'] = str(args.input_plan)
        checkpoint['accepted_moves'] = list(accepted)
        checkpoint['dataset_sha256'] = dataset.dataset_sha256
        checkpoint['content_sha256'] = payload_sha256(checkpoint)
        write_json_atomic(args.output, checkpoint)
        print(
            f'Pass {pass_number}: {accepted_kind} added '
            f'{inserted_job_id}; {len(unserved)} unserved remain',
            flush=True,
        )

    payload = (
        materialization_result_dict(current)
        if current is not None else unsigned_source
    )
    payload['artifact_type'] = 'EXACT_PLAN_COVERAGE_REPAIR'
    payload['source_plan'] = str(args.input_plan)
    payload['accepted_moves'] = accepted
    payload['search_reports'] = reports
    payload['exact_lns_reports'] = lns_reports
    payload['search_configuration'] = {
        'max_route_checks_per_pass': args.max_route_checks,
        'max_displacements': args.max_displacements,
        'max_checks_by_depth': list(checks_by_depth) if checks_by_depth else None,
        'reorder_affected_routes': True,
        'screening_root': (
            str(args.screening_root) if args.screening_root is not None else None
        ),
        'screening_route_rejections': screening_rejections,
        'max_passes': args.max_passes,
        'max_search_seconds_per_pass': args.max_search_seconds_per_pass,
        'exact_lns': {
            'enabled': not args.skip_exact_lns,
            'max_route_checks_per_pass': args.lns_route_checks,
            'beam_width': args.lns_beam_width,
            'max_destroyed_jobs': args.lns_max_destroyed_jobs,
            'max_engineers': args.lns_max_engineers,
            'window_padding_minutes': args.lns_window_padding_minutes,
            'neighbour_radius': args.lns_neighbour_radius,
        },
        'provider': 'valhalla-local-transit',
        'transit_index': str(args.transit_index),
        'metro_wait_assumption_seconds': args.metro_wait_seconds,
        'global_optimality_proven': False,
        'input_exact_validation_repeated': not args.trust_input_validation,
    }
    if current is not None and current.plan is not None and current.validation is not None:
        payload['explanations'] = build_explanation_bundle(
            dataset,
            current.plan,
            current.validation,
            search_budget_exhausted=any(
                bool(report['budget_exhausted']) for report in reports
            ) or any(
                bool(report['budget_exhausted']) for report in lns_reports
            ),
            exact_route_checks=(
                sum(int(report['route_checks']) for report in reports)
                + sum(int(report['route_checks']) for report in lns_reports)
            ),
            exact_provider_queries=current.exact_provider_queries,
            global_optimality_proven=False,
        )
    payload['dataset_sha256'] = dataset.dataset_sha256
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({
        'status': payload['status'],
        'served_jobs': len(all_active) - len(unserved),
        'unserved_jobs': len(unserved),
        'accepted_moves': len(accepted),
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
