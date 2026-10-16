"""Run the main planner's exact LNS separately when chain search consumed its pass."""

from __future__ import annotations

import argparse
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from beeline_planning import build_candidate_index, load_planning_dataset, materialize_exact_initial_plan, validate_initial_plan
from beeline_planning.exact_lns import find_exact_lns_coverage_move
from beeline_planning.exact_repair import master_from_orders
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import _materialize_route
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--max-search-seconds', type=float, default=90)
    args = parser.parse_args()
    if args.max_search_seconds <= 0:
        parser.error('Search time must be positive')
    dataset = load_planning_dataset(args.dataset, 'core')
    plan, source = load_exact_plan_artifact(args.input_plan, dataset.dataset_sha256)
    validation = validate_initial_plan(dataset, plan)
    if not validation.is_valid:
        raise ValueError(f'Input failed independent validation: {validation.violations}')
    routes = {route.engineer_id: tuple(visit.job_id for visit in route.visits)
              for route in plan.engineer_plans}
    for engineer_id in dataset.engineers:
        routes.setdefault(engineer_id, ())
    unserved = set(plan.unserved_job_ids)
    active = set(job.job_id for job in dataset.active_jobs_at(dataset.initial_planning_at))
    client = create_route_client(RoutingCache(args.cache), 'valhalla-local-transit',
                                 transit_index=args.transit_index)
    oracle = ExactRoutingOracle(client)
    single = replace(dataset, commitments=())
    known = {(engineer_id, order): True for engineer_id, order in routes.items()}

    def exact_route_valid(engineer_id, order):
        if not order:
            return True
        key = (engineer_id, order)
        if key not in known:
            candidate = master_from_orders(single, {engineer_id: order}, active - set(order))
            result = _materialize_route(single, candidate.routes[0], oracle,
                                        drop_order_infeasible=False)
            known[key] = result.plan is not None
        return known[key]

    started_at = datetime.now(UTC).isoformat()
    try:
        report = find_exact_lns_coverage_move(
            dataset, routes, unserved, build_candidate_index(dataset), exact_route_valid,
            max_route_checks=2500, beam_width=48, max_destroyed_jobs=12,
            max_engineers=4, window_padding_minutes=120, neighbour_radius=1,
            max_seconds=args.max_search_seconds,
        )
        payload = {key: value for key, value in source.items() if key != 'content_sha256'}
        if report.move is not None:
            proposed_routes = {**routes, **report.move.routes}
            proposed_unserved = unserved - {report.move.inserted_job_id}
            result = materialize_exact_initial_plan(
                dataset, master_from_orders(dataset, proposed_routes, proposed_unserved),
                oracle, max_workers=3,
                oracle_factory=lambda: ExactRoutingOracle(create_route_client(
                    RoutingCache(args.cache), 'valhalla-local-transit',
                    transit_index=args.transit_index,
                )),
            )
            candidate = materialization_result_dict(result)
            if not candidate['publication_allowed']:
                raise ValueError('A local LNS move failed complete independent validation')
            payload = candidate
            payload['dataset_sha256'] = dataset.dataset_sha256
        payload.update({
            'artifact_type': 'EXACT_LNS_SUPPLEMENTARY_PASS',
            'lns_source_plan_content_sha256': source['content_sha256'],
            'lns_started_at': started_at,
            'lns_completed_at': datetime.now(UTC).isoformat(),
            'lns_search_configuration': {
                'max_search_seconds': args.max_search_seconds,
                'max_route_checks': 2500, 'beam_width': 48,
                'max_destroyed_jobs': 12, 'max_engineers': 4,
                'screening_rejection_used': False,
            },
            'lns_report': {
                'route_checks': report.route_checks,
                'expanded_states': report.expanded_states,
                'zero_travel_rejections': report.zero_travel_rejections,
                'neighbourhoods_tried': report.neighbourhoods_tried,
                'complete_states_checked': report.complete_states_checked,
                'budget_exhausted': report.budget_exhausted,
                'move_found': report.move is not None,
                'inserted_job_id': report.move.inserted_job_id if report.move else None,
                'global_infeasibility_proven': False,
            },
        })
        payload['content_sha256'] = payload_sha256(payload)
        write_json_atomic(args.output, payload)
        print(json.dumps(payload['lns_report']), flush=True)
    finally:
        client.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
