from __future__ import annotations

import argparse
import json
from pathlib import Path

from beeline_planning import (
    build_explanation_bundle,
    load_planning_dataset,
    materialize_exact_initial_plan,
)
from beeline_planning.export import (
    load_master_solution,
    materialization_result_dict,
)
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client, load_credentials
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Materialize a screening candidate with exact hybrid route evidence.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--master-solution', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument(
        '--credentials-file',
        type=Path,
        help='Optional KEY=VALUE file. Local routing does not require API credentials.',
    )
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-logical-queries', type=int, default=250)
    parser.add_argument(
        '--provider',
        choices=(
            'hybrid',
            'valhalla-2gis',
            'valhalla-here',
            'valhalla',
            'valhalla-local-transit',
        ),
        default='valhalla-local-transit',
        help='Routing dispatch. The default uses the frozen local transit index and Valhalla.',
    )
    parser.add_argument(
        '--transit-index',
        type=Path,
        default=Path('work/transit/moscow_2026-08-17.sqlite'),
    )
    parser.add_argument(
        '--metro-wait-seconds',
        type=int,
        default=180,
        help='Explicit metro wait assumption stored in the local index.',
    )
    parser.add_argument('--timeout-seconds', type=float, default=12)
    parser.add_argument('--max-attempts', type=int, default=1)
    parser.add_argument(
        '--route-workers',
        type=int,
        default=1,
        help='Materialize independent engineer routes concurrently.',
    )
    parser.add_argument('--execute', action='store_true')
    parser.add_argument(
        '--drop-order-infeasible',
        action='store_true',
        help=(
            'Return visits that fail exact schedule checks to the unserved set '
            'and revalidate every remaining visit.'
        ),
    )
    args = parser.parse_args()
    if not args.execute:
        parser.error('Live route materialization requires explicit --execute')
    if args.max_logical_queries < 1:
        parser.error('--max-logical-queries must be positive')
    if args.route_workers < 1:
        parser.error('--route-workers must be positive')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    solution = load_master_solution(args.master_solution)
    if solution.dataset_sha256 != dataset.dataset_sha256:
        raise ValueError('Master solution belongs to another dataset checksum')
    upper_bound = sum(len(route.visits) for route in solution.routes)
    if upper_bound > args.max_logical_queries:
        raise ValueError(
            f'Candidate needs at most {upper_bound} logical route queries, '
            f'above explicit cap {args.max_logical_queries}'
        )
    if args.credentials_file is not None:
        load_credentials(args.credentials_file)
    def make_oracle() -> ExactRoutingOracle:
        return ExactRoutingOracle(create_route_client(
            RoutingCache(args.cache),
            args.provider,
            timeout_seconds=args.timeout_seconds,
            max_attempts=args.max_attempts,
            transit_index=args.transit_index,
            metro_wait_seconds=args.metro_wait_seconds,
        ))

    oracle = make_oracle()
    try:
        result = materialize_exact_initial_plan(
            dataset,
            solution,
            oracle,
            drop_order_infeasible=args.drop_order_infeasible,
            max_workers=args.route_workers,
            oracle_factory=make_oracle if args.route_workers > 1 else None,
        )
    finally:
        close = getattr(oracle.client, 'close', None)
        if close is not None:
            close()
    payload = materialization_result_dict(result)
    if result.plan is not None and result.validation is not None and payload['publication_allowed']:
        payload['explanations'] = build_explanation_bundle(
            dataset,
            result.plan,
            result.validation,
            exact_provider_queries=result.exact_provider_queries,
            global_optimality_proven=False,
        )
    payload['routing_configuration'] = {
        'provider': args.provider,
        'transit_index': str(args.transit_index) if args.provider == 'valhalla-local-transit' else None,
        'metro_wait_assumption_seconds': (
            args.metro_wait_seconds if args.provider == 'valhalla-local-transit' else None
        ),
        'query_time_api_key_required': args.provider != 'valhalla-local-transit',
        'exact_historical_metro_timetable_proof': False,
    }
    if args.provider == 'valhalla-local-transit':
        payload['result_interpretation'] = (
            'Validated against frozen surface and rail schedules plus an explicit '
            'metro waiting-time model; this is not a proof against a complete '
            'historical metro departure timetable.'
        )
    payload['dataset_sha256'] = dataset.dataset_sha256
    payload['master_solution_content_sha256'] = json.loads(
        args.master_solution.read_text(encoding='utf-8')
    )['content_sha256']
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(
        json.dumps(
            {
                'status': result.status.value,
                'output': str(args.output),
                'exact_provider_queries': result.exact_provider_queries,
                'identity_legs': result.identity_legs,
                'dropped_job_ids': list(result.dropped_job_ids),
                'publication_allowed': payload['publication_allowed'],
                'routing_provider': args.provider,
                'failure': payload['failure'],
            },
            ensure_ascii=False,
        )
    )
    return 0 if payload['publication_allowed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
