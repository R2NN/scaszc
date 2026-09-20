from __future__ import annotations

import argparse
import json
from datetime import timedelta
from pathlib import Path

from beeline_planning import build_candidate_index, load_planning_dataset
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.models import RouteStatus
from beeline_routing.oracle import ExactRoutingOracle, OracleQuery


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Build exact duration overrides for one engineer and job-window subset.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--engineer', required=True)
    parser.add_argument('--window-end-hour', type=int, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Exact routing requires --execute')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    engineer = dataset.engineers[args.engineer]
    candidates = build_candidate_index(dataset)
    jobs = [
        dataset.jobs[job_id]
        for job_id in candidates.active_job_ids
        if args.engineer in candidates.eligible_engineers_by_job[job_id]
        and dataset.jobs[job_id].window_end.hour <= args.window_end_hour
    ]
    oracle = ExactRoutingOracle(create_route_client(
        RoutingCache(args.cache),
        'valhalla-local-transit',
        timeout_seconds=60,
        max_attempts=1,
        transit_index=args.transit_index,
    ))
    office = dataset.offices[engineer.start_office_id]
    overrides: list[dict[str, object]] = []

    def query(origin_node: str, origin_location: str, destination) -> None:
        if origin_node.startswith('START:'):
            departure = max(dataset.initial_planning_at, engineer.shift_start)
        else:
            origin_job = dataset.jobs[origin_node]
            departure = max(
                dataset.initial_planning_at,
                engineer.shift_start,
                origin_job.window_start,
            ) + timedelta(minutes=origin_job.service_duration_min)
        if origin_location == destination.location_id:
            overrides.append({
                'engineer_id': engineer.engineer_id,
                'origin_node_id': origin_node,
                'destination_job_id': destination.job_id,
                'duration_minutes': 0,
                'observed_departure_at': departure.isoformat(),
                'request_sha256': None,
            })
            return
        route = oracle.query(OracleQuery(
            mode=engineer.transport_mode,
            origin=dataset.locations[origin_location],
            destination=dataset.locations[destination.location_id],
            departure_at=departure,
        ))
        if route.status != RouteStatus.OK or route.duration_minutes is None:
            raise RuntimeError(
                f'Exact route failed: {origin_node} -> {destination.job_id}: '
                f'{route.status.value} {route.provider_status}'
            )
        overrides.append({
            'engineer_id': engineer.engineer_id,
            'origin_node_id': origin_node,
            'destination_job_id': destination.job_id,
            'duration_minutes': route.duration_minutes,
            'observed_departure_at': departure.isoformat(),
            'request_sha256': route.provenance.request_sha256,
        })

    for destination in jobs:
        query(f'START:{engineer.engineer_id}', office.location_id, destination)
    total = len(jobs) * len(jobs)
    done = 0
    for origin in jobs:
        for destination in jobs:
            if origin.job_id != destination.job_id:
                query(origin.job_id, origin.location_id, destination)
            done += 1
            if done % 20 == 0:
                print(f'Exact overrides: {done}/{total}', flush=True)

    payload = {
        'artifact_type': 'EXACT_ENGINEER_ARC_OVERRIDES',
        'dataset_sha256': dataset.dataset_sha256,
        'engineer_id': engineer.engineer_id,
        'window_end_hour': args.window_end_hour,
        'job_ids': [job.job_id for job in jobs],
        'overrides': overrides,
    }
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({
        'engineer_id': engineer.engineer_id,
        'jobs': len(jobs),
        'overrides': len(overrides),
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
