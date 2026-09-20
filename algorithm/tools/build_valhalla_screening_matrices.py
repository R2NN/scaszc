from __future__ import annotations

import argparse
import json
import math
import urllib.request
import urllib.error
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

from beeline_planning.screening import SCREENING_PURPOSE
from beeline_routing.export import file_sha256, payload_sha256, write_json_atomic, write_matrix_csv
from beeline_routing.models import MatrixCell, Provenance, RouteStatus, TransportMode
from beeline_routing.screening_cache import ScreeningCache
from collect_screening_matrices import union_locations


COSTING = {
    TransportMode.CAR: 'auto',
    TransportMode.BICYCLE: 'bicycle',
    TransportMode.WALKING: 'pedestrian',
}


def request_matrix(endpoint: str, sources, targets, costing: str, timeout: float) -> list[list[dict]]:
    """Request one bounded all-to-all block from the local Valhalla service."""
    payload = {
        'sources': [{'lat': point.latitude, 'lon': point.longitude} for point in sources],
        'targets': [{'lat': point.latitude, 'lon': point.longitude} for point in targets],
        'costing': costing,
        'units': 'kilometers',
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, separators=(',', ':')).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.loads(response.read())
    return body['sources_to_targets']


def request_route(endpoint: str, origin, destination, costing: str,
                  timeout: float) -> tuple[int, int]:
    """Fall back to Valhalla's bidirectional route algorithm for a missing matrix cell."""
    payload = {
        'locations': [
            {'lat': origin.latitude, 'lon': origin.longitude},
            {'lat': destination.latitude, 'lon': destination.longitude},
        ],
        'costing': costing,
        'units': 'kilometers',
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, separators=(',', ':')).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        summary = json.loads(response.read())['trip']['summary']
    return int(math.ceil(float(summary['time']))), int(round(float(summary['length']) * 1000))


def build(args: argparse.Namespace) -> int:
    by_zone, departure_at = union_locations(args.dataset)
    dataset_manifest = json.loads((args.dataset / 'manifest.json').read_text(encoding='utf-8'))
    args.output.mkdir(parents=True, exist_ok=True)
    fetched_at = datetime.now(UTC).isoformat()
    cache = ScreeningCache(args.cache) if args.cache is not None else None
    for mode, costing in COSTING.items():
        for zone, locations in by_zone.items():
            cells: list[MatrixCell] = []
            content_payload = []
            by_pair: dict[tuple[int, int], dict] = {}
            cache_hits = 0
            namespace = f'valhalla-screening-v1:{args.route_endpoint}'
            if cache is not None:
                for source_index, origin in enumerate(locations):
                    for target_index, destination in enumerate(locations):
                        cached = cache.get_surface(
                            namespace, mode.value, origin, destination
                        )
                        if cached is not None:
                            duration_seconds, distance_m = cached
                            by_pair[(source_index, target_index)] = {
                                'time': duration_seconds,
                                'distance': distance_m / 1000,
                                'cache_hit': True,
                            }
                            cache_hits += 1
            for source_start in range(0, len(locations), args.batch_size):
                sources = locations[source_start:source_start + args.batch_size]
                for target_start in range(0, len(locations), args.batch_size):
                    targets = locations[target_start:target_start + args.batch_size]
                    block_pairs = {
                        (source_start + source_offset, target_start + target_offset)
                        for source_offset in range(len(sources))
                        for target_offset in range(len(targets))
                    }
                    if block_pairs.issubset(by_pair):
                        continue
                    try:
                        block = request_matrix(
                            args.endpoint,
                            sources,
                            targets,
                            costing,
                            args.timeout_seconds,
                        )
                    except (urllib.error.URLError, KeyError, ValueError):
                        continue
                    for source_offset, row in enumerate(block):
                        for target_offset, item in enumerate(row):
                            pair = (source_start + source_offset, target_start + target_offset)
                            by_pair[pair] = item
                            if cache is not None and item.get('time') is not None:
                                cache.put_surface(
                                    namespace,
                                    mode.value,
                                    locations[pair[0]],
                                    locations[pair[1]],
                                    int(math.ceil(float(item['time']))),
                                    int(round(float(item['distance']) * 1000)),
                                )
            missing_pairs = [
                (source_index, target_index)
                for source_index in range(len(locations))
                for target_index in range(len(locations))
                if (source_index, target_index) not in by_pair
                or by_pair[(source_index, target_index)].get('time') is None
            ]
            if missing_pairs:
                def fallback(pair: tuple[int, int]) -> tuple[tuple[int, int], tuple[int, int]]:
                    source_index, target_index = pair
                    return pair, request_route(
                        args.route_endpoint,
                        locations[source_index],
                        locations[target_index],
                        costing,
                        args.timeout_seconds,
                    )

                with ThreadPoolExecutor(max_workers=args.fallback_workers) as executor:
                    for pair, (duration_seconds, distance_m) in executor.map(fallback, missing_pairs):
                        by_pair[pair] = {
                            'time': duration_seconds,
                            'distance': distance_m / 1000,
                        }
                        if cache is not None:
                            cache.put_surface(
                                namespace,
                                mode.value,
                                locations[pair[0]],
                                locations[pair[1]],
                                duration_seconds,
                                distance_m,
                            )
            for source_index, origin in enumerate(locations):
                for target_index, destination in enumerate(locations):
                    item = by_pair[(source_index, target_index)]
                    duration_seconds = int(math.ceil(float(item['time'])))
                    distance_m = int(round(float(item['distance']) * 1000))
                    request_hash = payload_sha256(
                        (mode.value, origin.location_id, destination.location_id)
                    )
                    response_hash = payload_sha256((duration_seconds, distance_m))
                    cells.append(
                        MatrixCell(
                            origin_id=origin.location_id,
                            destination_id=destination.location_id,
                            mode=mode,
                            departure_at=departure_at,
                            status=RouteStatus.OK,
                            duration_seconds=duration_seconds,
                            duration_minutes=math.ceil(duration_seconds / 60),
                            distance_m=distance_m,
                            provider_status='LOCAL_VALHALLA_MATRIX',
                            provenance=Provenance(
                                provider='LOCAL_VALHALLA_MATRIX',
                                endpoint=args.endpoint,
                                request_sha256=request_hash,
                                response_sha256=response_hash,
                                fetched_at=fetched_at,
                                cache_hit=bool(item.get('cache_hit', False)),
                                provider_metadata={'costing': costing, 'local_service': True},
                            ),
                        )
                    )
                    content_payload.append(
                        (
                            origin.location_id,
                            destination.location_id,
                            RouteStatus.OK.value,
                            duration_seconds,
                            distance_m,
                            response_hash,
                        )
                    )
            output = args.output / f'{zone.lower()}-{mode.value.lower()}.csv'
            write_matrix_csv(output, cells)
            counts = Counter(cell.status.value for cell in cells)
            manifest = {
                'matrix_schema_version': '1.0.0',
                'dataset_version': dataset_manifest['dataset_version'],
                'provider': 'LOCAL_VALHALLA_MATRIX',
                'purpose': SCREENING_PURPOSE,
                'zone_id': zone,
                'mode': mode.value,
                'departure_at_label': departure_at.isoformat(),
                'departure_time_honored': False,
                'locations': len(locations),
                'cells': len(cells),
                'status_counts': dict(sorted(counts.items())),
                'matrix_file': output.name,
                'matrix_file_sha256': file_sha256(output),
                'matrix_content_sha256': payload_sha256(content_payload),
            }
            write_json_atomic(output.with_suffix('.manifest.json'), manifest)
            print(
                json.dumps(
                    {
                        'event': 'MATRIX_READY',
                        'output': str(output),
                        'route_fallbacks': len(missing_pairs),
                        'cache_hits': cache_hits,
                        **manifest,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Build free local screening matrices from Valhalla.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument(
        '--endpoint',
        default='http://127.0.0.1:8002/sources_to_targets',
    )
    parser.add_argument(
        '--route-endpoint',
        default='http://127.0.0.1:8002/route',
    )
    parser.add_argument('--batch-size', type=int, default=25)
    parser.add_argument('--timeout-seconds', type=float, default=60)
    parser.add_argument('--fallback-workers', type=int, default=12)
    parser.add_argument(
        '--cache',
        type=Path,
        help='Persistent coordinate-keyed cache used for delta matrix builds.',
    )
    return build(parser.parse_args())


if __name__ == '__main__':
    raise SystemExit(main())
