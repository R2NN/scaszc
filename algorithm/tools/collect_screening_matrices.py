from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

from beeline_routing.cache import RoutingCache
from beeline_routing.dataset import load_dataset_locations
from beeline_routing.export import file_sha256, payload_sha256, write_json_atomic, write_matrix_csv
from beeline_routing.http import JsonHttpClient
from beeline_routing.mapbox import DEFAULT_MATRIX_HARD_LIMIT, PROVIDER, MapboxRoutingClient
from beeline_routing.matrix import build_matrix, ensure_matrix_complete
from beeline_routing.models import Coordinate, TransportMode


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET = PROJECT_ROOT / 'work' / 'dataset_v21' / 'beeline_synthetic_dataset_v2_1'
DEFAULT_CACHE = PROJECT_ROOT / 'work' / 'routing' / 'screening.sqlite3'
DEFAULT_OUTPUT = PROJECT_ROOT / 'work' / 'routing' / 'screening'
SCREENING_MODES = (TransportMode.CAR, TransportMode.BICYCLE, TransportMode.WALKING)


class RequestRateGate:
    """Enforce Mapbox's documented limit of at most 60 matrix requests/minute."""

    def __init__(self, interval_seconds: float = 1.05) -> None:
        self.interval_seconds = interval_seconds
        self.previous_at: float | None = None
        self.request_count = 0

    def __call__(self) -> None:
        now = time.monotonic()
        if self.previous_at is not None:
            time.sleep(max(0.0, self.interval_seconds - (now - self.previous_at)))
        self.previous_at = time.monotonic()
        self.request_count += 1
        if self.request_count == 1 or self.request_count % 10 == 0:
            print(
                json.dumps(
                    {'event': 'MAPBOX_NETWORK_REQUEST', 'count': self.request_count},
                    ensure_ascii=False,
                ),
                flush=True,
            )


def load_credentials(path: Path) -> None:
    """Load the ignored local credential file without exposing values."""
    import os

    if not path.is_file():
        raise RuntimeError(f'Credential file does not exist: {path}')
    for line_number, raw_line in enumerate(path.read_text(encoding='utf-8').splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition('=')
        if not separator or not name.strip() or not value.strip():
            raise RuntimeError(f'Invalid credential entry at line {line_number}')
        os.environ[name.strip()] = value.strip()


def union_locations(dataset_root: Path) -> tuple[dict[str, list[Coordinate]], datetime]:
    """Return the exact union of locations needed by core and stress scenarios."""
    core = load_dataset_locations(dataset_root, 'core')
    stress = load_dataset_locations(dataset_root, 'stress')
    manifest = json.loads((dataset_root / 'manifest.json').read_text(encoding='utf-8'))
    departure_at = datetime.fromisoformat(str(manifest['initial_planning_at']))
    by_zone: dict[str, list[Coordinate]] = {}
    for zone in sorted(set(core.zone_location_ids) | set(stress.zone_location_ids)):
        ids = sorted(
            set(core.zone_location_ids.get(zone, ()))
            | set(stress.zone_location_ids.get(zone, ()))
        )
        points: list[Coordinate] = []
        for location_id in ids:
            first = core.locations.get(location_id)
            second = stress.locations.get(location_id)
            if first is not None and second is not None and first != second:
                raise RuntimeError(f'Coordinate mismatch between scenarios: {location_id}')
            point = first or second
            if point is None:
                raise RuntimeError(f'Missing location in both scenarios: {location_id}')
            points.append(point)
        by_zone[zone] = points
    return by_zone, departure_at


def budget_plan(by_zone: dict[str, list[Coordinate]]) -> dict[str, object]:
    per_mode = sum(len(points) ** 2 for points in by_zone.values())
    return {
        'zones': {zone: len(points) for zone, points in by_zone.items()},
        'modes': [mode.value for mode in SCREENING_MODES],
        'matrix_elements_per_mode': per_mode,
        'total_matrix_elements': per_mode * len(SCREENING_MODES),
        'local_hard_limit': DEFAULT_MATRIX_HARD_LIMIT,
        'batch_side': 12,
        'minimum_request_interval_seconds': 1.05,
    }


def collect(args: argparse.Namespace) -> int:
    load_credentials(args.credentials)
    by_zone, departure_at = union_locations(args.dataset)
    plan = budget_plan(by_zone)
    cache = RoutingCache(args.cache)
    rate_gate = RequestRateGate()
    http = JsonHttpClient(cache=cache, max_attempts=4)
    client = MapboxRoutingClient(http, network_gate=rate_gate)
    usage_before = http.usage_ledger.usage_status(
        provider=PROVIDER,
        metric='matrix_elements',
        hard_limit=DEFAULT_MATRIX_HARD_LIMIT,
    )
    predicted_total = usage_before.reserved_units + int(plan['total_matrix_elements'])
    if predicted_total > DEFAULT_MATRIX_HARD_LIMIT:
        raise RuntimeError(
            f'Worst-case collection would reach {predicted_total} elements, above '
            f'the local hard limit {DEFAULT_MATRIX_HARD_LIMIT}'
        )
    print(
        json.dumps(
            {
                'event': 'COLLECTION_PREFLIGHT',
                **plan,
                'reserved_before': usage_before.reserved_units,
                'worst_case_reserved_after': predicted_total,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    if not args.execute:
        return 0

    args.output.mkdir(parents=True, exist_ok=True)
    for mode in SCREENING_MODES:
        for zone, locations in by_zone.items():
            output = args.output / f'{zone.lower()}-{mode.value.lower()}.csv'
            cells = build_matrix(
                client=client,
                locations=locations,
                mode=mode,
                departure_at=departure_at,
                batch_side=12,
            )
            ensure_matrix_complete(cells)
            write_matrix_csv(output, cells)
            counts = Counter(cell.status.value for cell in cells)
            manifest = {
                'matrix_schema_version': '1.0.0',
                'dataset_version': '2.1.0',
                'provider': PROVIDER,
                'purpose': 'SCREENING_ONLY_NOT_AUTHORITATIVE_FOR_TIME_DEPENDENT_CONSTRAINTS',
                'zone_id': zone,
                'mode': mode.value,
                'departure_at_label': departure_at.isoformat(),
                'departure_time_honored': False,
                'locations': len(locations),
                'cells': len(cells),
                'status_counts': dict(sorted(counts.items())),
                'matrix_file': output.name,
                'matrix_file_sha256': file_sha256(output),
                'matrix_content_sha256': payload_sha256(
                    [
                        (
                            cell.origin_id,
                            cell.destination_id,
                            cell.status.value,
                            cell.duration_seconds,
                            cell.distance_m,
                            cell.provenance.response_sha256,
                        )
                        for cell in cells
                    ]
                ),
            }
            write_json_atomic(output.with_suffix('.manifest.json'), manifest)
            print(
                json.dumps(
                    {'event': 'MATRIX_READY', 'output': str(output), **manifest},
                    ensure_ascii=False,
                ),
                flush=True,
            )
    usage_after = http.usage_ledger.usage_status(
        provider=PROVIDER,
        metric='matrix_elements',
        hard_limit=DEFAULT_MATRIX_HARD_LIMIT,
    )
    print(
        json.dumps(
            {
                'event': 'COLLECTION_COMPLETE',
                'network_requests': rate_gate.request_count,
                'reserved_before': usage_before.reserved_units,
                'reserved_after': usage_after.reserved_units,
                'hard_limit': usage_after.hard_limit,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', type=Path, default=DEFAULT_DATASET)
    parser.add_argument('--credentials', type=Path, default=PROJECT_ROOT / '.env.routing.local')
    parser.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--execute', action='store_true')
    return collect(parser.parse_args())


if __name__ == '__main__':
    raise SystemExit(main())
