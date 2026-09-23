from __future__ import annotations

import argparse
import json
import math
import os
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
        route_response = json.loads(response.read())
    trip = route_response.get('trip')
    if not isinstance(trip, dict) or 'summary' not in trip:
        raise RuntimeError(
            f'Valhalla route unavailable for {costing}: '
            f'{origin.location_id} -> {destination.location_id}; '
            f'response={route_response!r}'
        )
    summary = trip['summary']
    return int(math.ceil(float(summary['time']))), int(round(float(summary['length']) * 1000))


def missing_matrix_requests(
    location_count: int,
    batch_size: int,
    cached_pairs: set[tuple[int, int]],
) -> list[tuple[list[int], list[int]]]:
    """Batch cold blocks, but request only missing rows in warm blocks."""
    requests: list[tuple[list[int], list[int]]] = []
    for source_start in range(0, location_count, batch_size):
        sources = list(range(source_start, min(source_start + batch_size, location_count)))
        for target_start in range(0, location_count, batch_size):
            targets = list(range(target_start, min(target_start + batch_size, location_count)))
            missing = [
                (source, target)
                for source in sources
                for target in targets
                if (source, target) not in cached_pairs
            ]
            if not missing:
                continue
            if len(missing) >= (len(sources) * len(targets)) / 2:
                requests.append((sources, targets))
                continue
            missing_sources = {
                source for source, _ in missing
            }
            missing_targets = {
                target for _, target in missing
            }
            if len(missing_sources) <= len(missing_targets):
                for source in sources:
                    targets_for_source = [
                        target for target in targets
                        if (source, target) not in cached_pairs
                    ]
                    if targets_for_source:
                        requests.append(([source], targets_for_source))
            else:
                for target in targets:
                    sources_for_target = [
                        source for source in sources
                        if (source, target) not in cached_pairs
                    ]
                    if sources_for_target:
                        requests.append((sources_for_target, [target]))
    return requests


def build(args: argparse.Namespace) -> int:
    by_zone, departure_at = union_locations(args.dataset)
    dataset_manifest = json.loads((args.dataset / 'manifest.json').read_text(encoding='utf-8'))
    args.output.mkdir(parents=True, exist_ok=True)
    fetched_at = datetime.now(UTC).isoformat()
    cache = ScreeningCache(args.cache) if args.cache is not None else None
    tile_revision = args.tile_revision or os.environ.get('VALHALLA_TILE_REVISION')
    runtime_revision = os.environ.get('VALHALLA_RUNTIME_REVISION', 'unknown-runtime')
    if cache is not None and not tile_revision:
        raise RuntimeError(
            'A tile revision is required to reuse screening cells safely; '
            'start the BeeGo pipeline or pass --tile-revision.'
        )
    for mode, costing in COSTING.items():
        for zone, locations in by_zone.items():
            cells: list[MatrixCell] = []
            content_payload = []
            by_pair: dict[tuple[int, int], dict] = {}
            cache_hits = 0
            namespace = (
                f'valhalla-screening-v2:{args.route_endpoint}:'
                f'{runtime_revision}:{tile_revision or "uncached"}'
            )
            if cache is not None:
                for pair, (duration_seconds, distance_m) in cache.get_surfaces(
                    namespace, mode.value, locations
                ).items():
                    by_pair[pair] = {
                        'time': duration_seconds,
                        'distance': distance_m / 1000,
                        'cache_hit': True,
                    }
                    cache_hits += 1
            requests = missing_matrix_requests(
                len(locations), args.batch_size, set(by_pair)
            )

            def fetch(spec: tuple[list[int], list[int]]):
                source_indices, target_indices = spec
                try:
                    block = request_matrix(
                        args.endpoint,
                        [locations[index] for index in source_indices],
                        [locations[index] for index in target_indices],
                        costing,
                        args.timeout_seconds,
                    )
                except (urllib.error.URLError, KeyError, ValueError):
                    block = []
                return spec, block

            with ThreadPoolExecutor(max_workers=args.matrix_workers) as executor:
                for (source_indices, target_indices), block in executor.map(fetch, requests):
                    cached_cells = []
                    if len(block) != len(source_indices):
                        continue
                    for source_index, row in zip(source_indices, block):
                        if not isinstance(row, list) or len(row) != len(target_indices):
                            continue
                        for target_index, item in zip(target_indices, row):
                            pair = (source_index, target_index)
                            if pair in by_pair or not isinstance(item, dict):
                                continue
                            by_pair[pair] = item
                            if item.get('time') is not None and item.get('distance') is not None:
                                cached_cells.append((
                                    locations[source_index], locations[target_index],
                                    int(math.ceil(float(item['time']))),
                                    int(round(float(item['distance']) * 1000)),
                                ))
                    if cache is not None:
                        cache.put_surfaces(namespace, mode.value, cached_cells)
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

                fallback_cells = []
                with ThreadPoolExecutor(max_workers=args.fallback_workers) as executor:
                    for pair, (duration_seconds, distance_m) in executor.map(fallback, missing_pairs):
                        by_pair[pair] = {
                            'time': duration_seconds,
                            'distance': distance_m / 1000,
                        }
                        fallback_cells.append((
                            locations[pair[0]], locations[pair[1]],
                            duration_seconds, distance_m,
                        ))
                if cache is not None:
                    cache.put_surfaces(namespace, mode.value, fallback_cells)
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
                                provider_metadata={
                                    'costing': costing,
                                    'local_service': True,
                                    'tile_revision': tile_revision,
                                    'runtime_revision': runtime_revision,
                                },
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
    parser.add_argument('--matrix-workers', type=int, default=3)
    parser.add_argument('--timeout-seconds', type=float, default=60)
    parser.add_argument('--fallback-workers', type=int, default=3)
    parser.add_argument('--tile-revision', help='Identifier of the Valhalla tile snapshot.')
    parser.add_argument(
        '--cache',
        type=Path,
        help='Persistent coordinate-keyed cache used for delta matrix builds.',
    )
    args = parser.parse_args()
    if args.batch_size < 1 or args.matrix_workers < 1 or args.fallback_workers < 1:
        parser.error('Batch size and worker counts must be positive')
    return build(args)


if __name__ == '__main__':
    raise SystemExit(main())
