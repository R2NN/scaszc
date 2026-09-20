from __future__ import annotations

import argparse
import csv
import hashlib
import heapq
import json
import math
import sqlite3
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

from beeline_planning.screening import SCREENING_PURPOSE
from beeline_routing.dataset import load_dataset_locations
from beeline_routing.export import file_sha256, payload_sha256, write_json_atomic, write_matrix_csv
from beeline_routing.models import Coordinate, MatrixCell, Provenance, RouteStatus, TransportMode
from beeline_routing.screening_cache import ScreeningCache


def air_distance_m(left: tuple[float, float], right: tuple[float, float]) -> int:
    """Return a deterministic geodesic approximation suitable for screening."""
    latitude = math.radians((left[0] + right[0]) / 2)
    return math.ceil(
        math.hypot(
            (left[0] - right[0]) * 111_195,
            (left[1] - right[1]) * 111_195 * math.cos(latitude),
        )
    )


def union_locations(dataset_root: Path) -> tuple[dict[str, list[Coordinate]], datetime, str]:
    """Return the exact union of core and stress locations by zone."""
    core = load_dataset_locations(dataset_root, 'core')
    stress = load_dataset_locations(dataset_root, 'stress')
    manifest = json.loads((dataset_root / 'manifest.json').read_text(encoding='utf-8'))
    by_zone: dict[str, list[Coordinate]] = {}
    for zone in sorted(set(core.zone_location_ids) | set(stress.zone_location_ids)):
        points = []
        for location_id in sorted(
            set(core.zone_location_ids.get(zone, ()))
            | set(stress.zone_location_ids.get(zone, ()))
        ):
            first = core.locations.get(location_id)
            second = stress.locations.get(location_id)
            if first is not None and second is not None and first != second:
                raise RuntimeError(f'Coordinate mismatch between scenarios: {location_id}')
            points.append(first or second)
        by_zone[zone] = points
    return by_zone, datetime.fromisoformat(manifest['initial_planning_at']), manifest['dataset_version']


class StaticTransitScreeningGraph:
    """Fast optimistic graph built only from the frozen local transport index.

    Timetable edges use their fastest observed running time and omit surface and
    rail waiting. Metro all-pairs edges retain the configured boarding wait. The
    resulting duration is a search estimate and is never final route evidence.
    """

    def __init__(self, database: Path, *, walking_speed_mps: float = 1.25) -> None:
        if walking_speed_mps <= 0:
            raise ValueError('walking_speed_mps must be positive')
        self.database = database.resolve()
        self.walking_speed_mps = walking_speed_mps
        db = sqlite3.connect(f'file:{self.database.as_posix()}?mode=ro', uri=True)
        try:
            self.stops = {
                stop_id: (lat, lon, kind)
                for stop_id, lat, lon, kind in db.execute('SELECT id,lat,lon,kind FROM stops')
            }
            self.active_stop_ids = {
                row[0]
                for row in db.execute(
                    'SELECT from_id FROM connections UNION SELECT to_id FROM connections '
                    'UNION SELECT from_id FROM transfers UNION SELECT to_id FROM transfers '
                    'UNION SELECT from_id FROM metro_paths UNION SELECT to_id FROM metro_paths'
                )
            }
            self.graph: dict[str, list[tuple[str, int]]] = defaultdict(list)
            for origin, destination, seconds in db.execute(
                'SELECT from_id,to_id,MIN(arr-dep) FROM connections GROUP BY from_id,to_id'
            ):
                self.graph[origin].append((destination, int(seconds)))
            for origin, destination, seconds in db.execute(
                'SELECT from_id,to_id,seconds FROM transfers'
            ):
                self.graph[origin].append((destination, int(seconds)))
            if db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='walk_transfers'"
            ).fetchone():
                for origin, destination, seconds in db.execute(
                    'SELECT from_id,to_id,seconds FROM walk_transfers'
                ):
                    self.graph[origin].append((destination, int(seconds)))
            for origin, destination, seconds in db.execute(
                'SELECT from_id,to_id,seconds FROM metro_paths'
            ):
                self.graph[origin].append((destination, int(seconds)))
        finally:
            db.close()

    def nearby(self, point: Coordinate) -> list[tuple[str, int]]:
        """Use the same access radius and stop caps as the detailed router."""
        surface: list[tuple[int, str]] = []
        rapid: list[tuple[int, str]] = []
        coordinate = (point.latitude, point.longitude)
        for stop_id, (latitude, longitude, kind) in self.stops.items():
            if stop_id not in self.active_stop_ids:
                continue
            if abs(latitude - point.latitude) > 0.022 or abs(longitude - point.longitude) > 0.035:
                continue
            distance = air_distance_m(coordinate, (latitude, longitude))
            if distance > 1800:
                continue
            target = rapid if kind in {'mcc', 'mcd', 'metro'} else surface
            target.append((distance, stop_id))
        surface.sort()
        rapid.sort()
        return [(stop_id, distance) for distance, stop_id in surface[:14] + rapid[:7]]

    def durations_from(self, origin: Coordinate) -> dict[str, int]:
        """Run one static shortest path from an arbitrary dataset coordinate."""
        distances: dict[str, int] = {}
        queue: list[tuple[int, str]] = []
        for stop_id, meters in self.nearby(origin):
            seconds = math.ceil(meters / self.walking_speed_mps)
            if seconds < distances.get(stop_id, 10**12):
                distances[stop_id] = seconds
                heapq.heappush(queue, (seconds, stop_id))
        while queue:
            elapsed, stop_id = heapq.heappop(queue)
            if distances.get(stop_id) != elapsed:
                continue
            for target, seconds in self.graph.get(stop_id, ()):
                candidate = elapsed + seconds
                if candidate < distances.get(target, 10**12):
                    distances[target] = candidate
                    heapq.heappush(queue, (candidate, target))
        return distances

    def estimate(self, origin: Coordinate, destination: Coordinate,
                 stop_durations: dict[str, int]) -> tuple[int, int]:
        """Return a static network duration and geodesic distance for search only."""
        direct_distance = air_distance_m(
            (origin.latitude, origin.longitude),
            (destination.latitude, destination.longitude),
        )
        best = 10**12
        for stop_id, meters in self.nearby(destination):
            if stop_id in stop_durations:
                best = min(best, stop_durations[stop_id] + math.ceil(meters / self.walking_speed_mps))
        if best == 10**12:
            best = math.ceil(direct_distance / self.walking_speed_mps)
        return best, direct_distance


def walking_cells(root: Path, zone: str) -> dict[tuple[str, str], tuple[int, int]]:
    """Load the matching local Valhalla walking matrix for direct-walk alternatives."""
    path = root / f'{zone.lower()}-{TransportMode.WALKING.value.lower()}.csv'
    if not path.is_file():
        raise RuntimeError(f'Missing local walking screening matrix: {path}')
    with path.open('r', encoding='utf-8-sig', newline='') as file:
        return {
            (row['origin_id'], row['destination_id']): (
                int(row['duration_seconds']),
                int(row['distance_m']),
            )
            for row in csv.DictReader(file, delimiter=';')
        }


def build(args: argparse.Namespace) -> int:
    by_zone, departure_at, dataset_version = union_locations(args.dataset)
    graph = StaticTransitScreeningGraph(
        args.transit_index,
        walking_speed_mps=args.walking_speed_mps,
    )
    args.output.mkdir(parents=True, exist_ok=True)
    index_sha256 = hashlib.sha256(args.transit_index.read_bytes()).hexdigest()
    fetched_at = datetime.now(UTC).isoformat()
    cache = ScreeningCache(args.cache) if args.cache is not None else None
    cache_namespace = f'{index_sha256}:walking-speed={args.walking_speed_mps}'
    for zone, locations in by_zone.items():
        direct_walking = walking_cells(args.walking_screening_root, zone)
        cells: list[MatrixCell] = []
        content_payload = []
        cached_origins = 0
        for origin in locations:
            stop_durations = (
                cache.get_transit_labels(cache_namespace, origin)
                if cache is not None else None
            )
            if stop_durations is None:
                stop_durations = graph.durations_from(origin)
                if cache is not None:
                    cache.put_transit_labels(cache_namespace, origin, stop_durations)
            else:
                cached_origins += 1
            for destination in locations:
                if origin.location_id == destination.location_id:
                    duration_seconds, distance_m = 0, 0
                else:
                    network_seconds, distance_m = graph.estimate(
                        origin,
                        destination,
                        stop_durations,
                    )
                    walking_seconds, walking_distance = direct_walking[
                        (origin.location_id, destination.location_id)
                    ]
                    if walking_seconds <= network_seconds:
                        duration_seconds, distance_m = walking_seconds, walking_distance
                    else:
                        duration_seconds = network_seconds
                request = (
                    index_sha256,
                    origin.location_id,
                    destination.location_id,
                    departure_at.isoformat(),
                )
                response = (duration_seconds, distance_m)
                request_sha256 = payload_sha256(request)
                response_sha256 = payload_sha256(response)
                cells.append(
                    MatrixCell(
                        origin_id=origin.location_id,
                        destination_id=destination.location_id,
                        mode=TransportMode.PUBLIC_TRANSIT,
                        departure_at=departure_at,
                        status=RouteStatus.OK,
                        duration_seconds=duration_seconds,
                        duration_minutes=math.ceil(duration_seconds / 60),
                        distance_m=distance_m,
                        provider_status='LOCAL_TRANSIT_OPTIMISTIC_SCREENING',
                        provenance=Provenance(
                            provider='LOCAL_TRANSIT_STATIC_SCREENING',
                            endpoint=str(args.transit_index),
                            request_sha256=request_sha256,
                            response_sha256=response_sha256,
                            fetched_at=fetched_at,
                            cache_hit=True,
                            provider_metadata={
                                'authoritative': False,
                                'surface_and_rail_wait_omitted': True,
                                'walking_access_geometry': 'geodesic',
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
                        response_sha256,
                    )
                )
        output = args.output / f'{zone.lower()}-{TransportMode.PUBLIC_TRANSIT.value.lower()}.csv'
        write_matrix_csv(output, cells)
        counts = Counter(cell.status.value for cell in cells)
        manifest = {
            'matrix_schema_version': '1.0.0',
            'dataset_version': dataset_version,
            'provider': 'LOCAL_TRANSIT_STATIC_SCREENING',
            'purpose': SCREENING_PURPOSE,
            'zone_id': zone,
            'mode': TransportMode.PUBLIC_TRANSIT.value,
            'departure_at_label': departure_at.isoformat(),
            'departure_time_honored': False,
            'estimate_policy': (
                'STATIC_NETWORK_LOWER_BOUND_COMPARED_TO_LOCAL_VALHALLA_WALKING; '
                'no time multiplier or buffer; exact local timetable routing remains mandatory'
            ),
            'network_time_factor': 1.0,
            'network_time_padding_seconds': 0,
            'transit_index_sha256': index_sha256,
            'locations': len(locations),
            'cells': len(cells),
            'status_counts': dict(sorted(counts.items())),
            'matrix_file': output.name,
            'matrix_file_sha256': file_sha256(output),
            'matrix_content_sha256': payload_sha256(content_payload),
        }
        write_json_atomic(output.with_suffix('.manifest.json'), manifest)
        print(json.dumps({
            'event': 'MATRIX_READY',
            'output': str(output),
            'cached_origin_labels': cached_origins,
            **manifest,
        }, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Build fast public-transit screening matrices from the local network index.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--walking-screening-root', type=Path, required=True)
    parser.add_argument('--walking-speed-mps', type=float, default=1.25)
    parser.add_argument(
        '--cache',
        type=Path,
        help='Persistent cache for static shortest-path labels by origin coordinate.',
    )
    return build(parser.parse_args())


if __name__ == '__main__':
    raise SystemExit(main())
