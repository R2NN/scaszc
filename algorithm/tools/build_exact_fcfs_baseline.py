from __future__ import annotations

import argparse
import json
from pathlib import Path

from beeline_planning import build_exact_fcfs_baseline, load_planning_dataset
from beeline_planning.export import materialization_result_dict
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Build and independently validate the exact deterministic FCFS baseline.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), default='core')
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--timeout-seconds', type=float, default=120)
    parser.add_argument('--max-attempts', type=int, default=1)
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Exact FCFS calculation requires explicit --execute')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    client = create_route_client(
        RoutingCache(args.cache),
        'valhalla-local-transit',
        timeout_seconds=args.timeout_seconds,
        max_attempts=args.max_attempts,
        transit_index=args.transit_index,
        metro_wait_seconds=args.metro_wait_seconds,
    )
    try:
        result = build_exact_fcfs_baseline(dataset, ExactRoutingOracle(client))
    finally:
        close = getattr(client, 'close', None)
        if close is not None:
            close()

    payload = materialization_result_dict(result)
    payload['artifact_type'] = 'EXACT_FCFS_BASELINE'
    payload['baseline_policy'] = {
        'job_order': 'created_at, source row, job_id',
        'engineer_order': 'source row, engineer_id',
        'assignment': 'first exact-feasible engineer; append only; no reordering',
        'routing': 'same valhalla-local-transit oracle as optimized plan',
        'validation': 'same independent validator as optimized plan',
    }
    payload['routing_configuration'] = {
        'provider': 'valhalla-local-transit',
        'transit_index': str(args.transit_index),
        'metro_wait_assumption_seconds': args.metro_wait_seconds,
    }
    payload['dataset_sha256'] = dataset.dataset_sha256
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    metrics = payload.get('validation', {}).get('metrics', {})
    print(json.dumps({
        'status': payload['status'],
        'validation': payload.get('validation', {}).get('status'),
        'served_jobs': (
            int(metrics.get('served_urgent_jobs', 0) or 0)
            + int(metrics.get('served_normal_jobs', 0) or 0)
        ),
        'used_engineers': metrics.get('used_engineers', 0),
        'total_distance_m': metrics.get('total_distance_m', 0),
        'exact_provider_queries': payload['exact_provider_queries'],
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0 if payload.get('publication_allowed') else 2


if __name__ == '__main__':
    raise SystemExit(main())
