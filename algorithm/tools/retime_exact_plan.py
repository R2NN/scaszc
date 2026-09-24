"""Publish a validated plan with later, independently routed departures."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from beeline_planning import load_planning_dataset, validate_initial_plan
from beeline_planning.departure_timing import retime_initial_departures
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import MaterializationResult, MaterializationStatus
from beeline_planning.plan import IdentityTravel
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--provider', default='valhalla-local-transit')
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument('--arrival-buffer-minutes', type=int, default=15)
    parser.add_argument('--max-total-queries', type=int, default=64)
    parser.add_argument('--max-queries-per-leg', type=int, default=3)
    parser.add_argument('--timeout-seconds', type=float, default=8)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Exact departure retiming requires --execute')
    if args.input_plan.resolve() == args.output.resolve() or args.output.exists():
        parser.error('Output must be a new path; the source plan is never overwritten')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    source_plan, source = load_exact_plan_artifact(args.input_plan, dataset.dataset_sha256)
    source_validation = validate_initial_plan(dataset, source_plan)
    if source_validation.status.value != 'VALID':
        raise ValueError('Source plan failed independent validation')
    client = create_route_client(
        RoutingCache(args.cache),
        args.provider,
        timeout_seconds=args.timeout_seconds,
        max_attempts=1,
        transit_index=args.transit_index,
        metro_wait_seconds=args.metro_wait_seconds,
    )
    try:
        timing = retime_initial_departures(
            dataset,
            source_plan,
            ExactRoutingOracle(client),
            arrival_buffer_minutes=args.arrival_buffer_minutes,
            max_queries_per_leg=args.max_queries_per_leg,
            max_total_queries=args.max_total_queries,
        )
    finally:
        close = getattr(client, 'close', None)
        if close is not None:
            close()
    validation = validate_initial_plan(dataset, timing.plan)
    if validation.status.value != 'VALID':
        raise ValueError('Retimed plan failed independent validation')

    source_queries = source.get('exact_provider_queries')
    total_queries = (
        source_queries + timing.exact_queries
        if isinstance(source_queries, int) else None
    )
    result = MaterializationResult(
        status=MaterializationStatus.EXACT_VALID,
        plan=timing.plan,
        validation=validation,
        failure=None,
        exact_provider_queries=timing.exact_queries,
        identity_legs=sum(
            isinstance(visit.travel, IdentityTravel)
            for route in timing.plan.engineer_plans for visit in route.visits
        ),
    )
    payload = {
        **{key: value for key, value in source.items() if key != 'content_sha256'},
        **materialization_result_dict(result),
    }
    payload['exact_provider_queries'] = total_queries
    explanations = payload.get('explanations')
    if isinstance(explanations, dict):
        visit_by_job = {
            visit.job_id: visit
            for route in timing.plan.engineer_plans for visit in route.visits
        }
        for explanation in explanations.get('jobs', []):
            visit = visit_by_job.get(explanation.get('job_id'))
            if visit is None:
                continue
            explanation['departure_at'] = visit.departure_at.isoformat()
            explanation['travel'] = {
                'duration_minutes': visit.travel.duration_minutes,
                'distance_m': visit.travel.distance_m,
                'origin_location_id': visit.travel.origin_id,
                'destination_location_id': visit.travel.destination_id,
                'evidence_type': (
                    'IDENTITY' if isinstance(visit.travel, IdentityTravel)
                    else 'PROVIDER_ROUTE'
                ),
            }
        certificate = explanations.get('run_certificate')
        if isinstance(certificate, dict):
            certificate['exact_provider_queries'] = total_queries
    payload['departure_timing'] = {
        'method': 'EXACT_REROUTE_AND_FULL_VALIDATION',
        'input_plan_content_sha256': source['content_sha256'],
        'arrival_buffer_minutes': args.arrival_buffer_minutes,
        'changed_legs': timing.changed_legs,
        'additional_exact_queries': timing.exact_queries,
        'client_wait_before_minutes': timing.client_wait_before_minutes,
        'client_wait_after_minutes': timing.client_wait_after_minutes,
        'worst_client_wait_before_minutes': timing.worst_client_wait_before_minutes,
        'worst_client_wait_after_minutes': timing.worst_client_wait_after_minutes,
    }
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({
        'output': str(args.output),
        'publication_allowed': payload['publication_allowed'],
        **payload['departure_timing'],
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
