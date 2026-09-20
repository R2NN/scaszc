from __future__ import annotations

import argparse
import json
from pathlib import Path

from beeline_planning import (
    ExactRouteProbeFailure,
    ExactRouteProbeReport,
    ProbeFailureKind,
    load_planning_dataset,
    probe_exact_initial_plan_routes,
)
from beeline_planning.export import load_master_solution
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client, load_credentials
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def report_payload(
    *,
    report,
    dataset_sha256: str,
    master_solution_content_sha256: str,
    total_engineer_routes: int,
    probe_complete: bool,
    provider: str,
    transit_index: Path,
    metro_wait_seconds: int,
) -> dict:
    """Build a checksummed diagnostic checkpoint without publication authority."""
    payload = {
        'artifact_type': 'EXACT_ROUTE_REFINEMENT_PROBE',
        'probe_complete': probe_complete,
        'dataset_sha256': dataset_sha256,
        'master_solution_content_sha256': master_solution_content_sha256,
        'total_engineer_routes': total_engineer_routes,
        'processed_engineer_routes': len(report.complete_engineer_ids)
        + len(report.failures),
        'exact_provider_queries': report.exact_provider_queries,
        'identity_legs': report.identity_legs,
        'complete_engineer_ids': list(report.complete_engineer_ids),
        'failures': [
            {
                'kind': failure.kind.value,
                'engineer_id': failure.engineer_id,
                'origin_node_id': failure.origin_node_id,
                'job_id': failure.job_id,
                'origin_location_id': failure.origin_location_id,
                'destination_location_id': failure.destination_location_id,
                'departure_at': failure.departure_at,
                'reason': failure.reason,
            }
            for failure in report.failures
        ],
        'publication_allowed': False,
        'publication_blocker': 'DIAGNOSTIC_PROBE_IS_NOT_PLAN_VALIDATION',
        'routing_configuration': {
            'provider': provider,
            'transit_index': str(transit_index) if provider == 'valhalla-local-transit' else None,
            'metro_wait_assumption_seconds': (
                metro_wait_seconds if provider == 'valhalla-local-transit' else None
            ),
            'query_time_api_key_required': provider != 'valhalla-local-transit',
            'exact_historical_metro_timetable_proof': False,
        },
    }
    payload['content_sha256'] = payload_sha256(payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            'Probe exact routes independently and collect at most one provider '
            'failure per engineer route. This never publishes a plan.'
        )
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
    parser.add_argument('--timeout-seconds', type=float, default=120)
    parser.add_argument('--max-attempts', type=int, default=1)
    parser.add_argument(
        '--provider',
        choices=(
            'hybrid',
            '2gis',
            'mapbox',
            'yandex',
            'valhalla',
            'valhalla-2gis',
            'valhalla-here',
            'valhalla-local-transit',
        ),
        default='valhalla-local-transit',
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
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Live route probing requires explicit --execute')
    if args.max_logical_queries < 1:
        parser.error('--max-logical-queries must be positive')

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
    oracle = ExactRoutingOracle(
        create_route_client(
            RoutingCache(args.cache),
            args.provider,
            timeout_seconds=args.timeout_seconds,
            max_attempts=args.max_attempts,
            transit_index=args.transit_index,
            metro_wait_seconds=args.metro_wait_seconds,
        )
    )
    master_solution_content_sha256 = json.loads(
        args.master_solution.read_text(encoding='utf-8')
    )['content_sha256']
    total_engineer_routes = len(solution.routes)
    resume_report = None
    if args.resume:
        previous = json.loads(args.output.read_text(encoding='utf-8'))
        unsigned = dict(previous)
        expected_hash = unsigned.pop('content_sha256', None)
        if expected_hash != payload_sha256(unsigned):
            raise ValueError('Probe checkpoint checksum mismatch')
        if (
            previous.get('artifact_type') != 'EXACT_ROUTE_REFINEMENT_PROBE'
            or previous.get('probe_complete') is not False
            or previous.get('dataset_sha256') != dataset.dataset_sha256
            or previous.get('master_solution_content_sha256')
            != master_solution_content_sha256
            or previous.get('total_engineer_routes') != total_engineer_routes
        ):
            raise ValueError('Probe checkpoint does not belong to this unfinished run')
        resume_report = ExactRouteProbeReport(
            failures=tuple(
                ExactRouteProbeFailure(
                    kind=ProbeFailureKind(item['kind']),
                    engineer_id=item['engineer_id'],
                    origin_node_id=item['origin_node_id'],
                    job_id=item['job_id'],
                    origin_location_id=item['origin_location_id'],
                    destination_location_id=item['destination_location_id'],
                    departure_at=item['departure_at'],
                    reason=item['reason'],
                )
                for item in previous['failures']
            ),
            complete_engineer_ids=tuple(previous['complete_engineer_ids']),
            exact_provider_queries=previous['exact_provider_queries'],
            identity_legs=previous['identity_legs'],
        )
        if (
            previous['processed_engineer_routes']
            != len(resume_report.failures) + len(resume_report.complete_engineer_ids)
        ):
            raise ValueError('Probe checkpoint processed route count mismatch')

    def checkpoint(partial_report) -> None:
        write_json_atomic(
            args.output,
            report_payload(
                report=partial_report,
                dataset_sha256=dataset.dataset_sha256,
                master_solution_content_sha256=master_solution_content_sha256,
                total_engineer_routes=total_engineer_routes,
                probe_complete=False,
                provider=args.provider,
                transit_index=args.transit_index,
                metro_wait_seconds=args.metro_wait_seconds,
            ),
        )

    report = probe_exact_initial_plan_routes(
        dataset,
        solution,
        oracle,
        on_progress=checkpoint,
        resume_from=resume_report,
    )
    payload = report_payload(
        report=report,
        dataset_sha256=dataset.dataset_sha256,
        master_solution_content_sha256=master_solution_content_sha256,
        total_engineer_routes=total_engineer_routes,
        probe_complete=True,
        provider=args.provider,
        transit_index=args.transit_index,
        metro_wait_seconds=args.metro_wait_seconds,
    )
    write_json_atomic(args.output, payload)
    print(
        json.dumps(
            {
                'status': 'PROBE_COMPLETE',
                'output': str(args.output),
                'exact_provider_queries': report.exact_provider_queries,
                'complete_engineer_routes': len(report.complete_engineer_ids),
                'failures': len(report.failures),
                'publication_allowed': False,
                'routing_provider': args.provider,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
