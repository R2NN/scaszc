from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

from beeline_routing.cache import RoutingCache
from beeline_routing.dgis import DEFAULT_HARD_LIMIT as DGIS_HARD_LIMIT
from beeline_routing.dgis import PROVIDER as DGIS_PROVIDER
from beeline_routing.dgis import DgisRoutingClient
from beeline_routing.errors import RoutingError
from beeline_routing.http import JsonHttpClient
from beeline_routing.mapbox import DEFAULT_DIRECTIONS_HARD_LIMIT, DEFAULT_MATRIX_HARD_LIMIT
from beeline_routing.mapbox import PROVIDER as MAPBOX_PROVIDER
from beeline_routing.mapbox import MapboxRoutingClient
from beeline_routing.models import Coordinate, DetailedRoute, MatrixCell, TransportMode


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_local_credentials(path: Path) -> None:
    """Load the ignored local credential file without printing its values."""
    if not path.is_file():
        raise RuntimeError(f'Credential file is missing: {path}')
    for line_number, raw_line in enumerate(path.read_text(encoding='utf-8').splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition('=')
        if not separator or not name.strip() or not value.strip():
            raise RuntimeError(f'Invalid credential entry at line {line_number}')
        os.environ[name.strip()] = value.strip()


def cell_summary(cell: MatrixCell) -> dict[str, object]:
    return {
        'status': cell.status.value,
        'duration_seconds': cell.duration_seconds,
        'distance_m': cell.distance_m,
        'provider': cell.provenance.provider,
        'cache_hit': cell.provenance.cache_hit,
    }


def route_summary(route: DetailedRoute) -> dict[str, object]:
    return {
        'status': route.status.value,
        'duration_seconds': route.duration_seconds,
        'distance_m': route.distance_m,
        'geometry_points': len(route.geometry),
        'itinerary_steps': len(route.itinerary),
        'provider': route.provenance.provider,
        'cache_hit': route.provenance.cache_hit,
    }


def main() -> int:
    load_local_credentials(PROJECT_ROOT / '.env.routing.local')
    cache = RoutingCache(PROJECT_ROOT / 'work' / 'routing' / 'provider_smoke.sqlite3')
    http = JsonHttpClient(cache=cache, timeout_seconds=90, max_attempts=1)
    mapbox = MapboxRoutingClient(http)
    dgis = DgisRoutingClient(http)

    origin = Coordinate('SMOKE-A', 55.751244, 37.618423)
    destination = Coordinate('SMOKE-B', 55.760186, 37.618711)
    transit_destination = Coordinate('SMOKE-PT-B', 55.829817, 37.633045)
    scenario_time = datetime(2026, 8, 17, 10, 0, tzinfo=timezone(timedelta(hours=3)))
    future_time = (datetime.now(UTC) + timedelta(days=1)).replace(second=0, microsecond=0)

    results: dict[str, object] = {'mapbox': {}, '2gis': {}}
    for mode in (TransportMode.WALKING, TransportMode.BICYCLE):
        try:
            cell = mapbox.matrix(
                origins=[origin],
                destinations=[origin, destination],
                mode=mode,
                departure_at=scenario_time,
            )[1]
            results['mapbox'][mode.value] = cell_summary(cell)  # type: ignore[index]
        except RoutingError as error:
            results['mapbox'][mode.value] = {  # type: ignore[index]
                'error_type': type(error).__name__,
                'message': str(error),
            }
    try:
        car_cell = mapbox.matrix(
            origins=[origin],
            destinations=[origin, destination],
            mode=TransportMode.CAR,
            departure_at=future_time,
        )[1]
        results['mapbox']['CAR_FUTURE_CONTRACT_ONLY'] = cell_summary(car_cell)  # type: ignore[index]
    except RoutingError as error:
        results['mapbox']['CAR_FUTURE_CONTRACT_ONLY'] = {  # type: ignore[index]
            'error_type': type(error).__name__,
            'message': str(error),
        }

    for mode in TransportMode:
        route_time = scenario_time
        result_name = mode.value
        try:
            route = dgis.route(
                origin=origin,
                destination=(
                    transit_destination
                    if mode == TransportMode.PUBLIC_TRANSIT
                    else destination
                ),
                mode=mode,
                departure_at=route_time,
            )
            results['2gis'][result_name] = route_summary(route)  # type: ignore[index]
        except RoutingError as error:
            results['2gis'][result_name] = {  # type: ignore[index]
                'error_type': type(error).__name__,
                'message': str(error),
            }

    mapbox_matrix_usage = http.usage_ledger.usage_status(
        provider=MAPBOX_PROVIDER,
        metric='matrix_elements',
        hard_limit=DEFAULT_MATRIX_HARD_LIMIT,
    )
    mapbox_directions_usage = http.usage_ledger.usage_status(
        provider=MAPBOX_PROVIDER,
        metric='directions_requests',
        hard_limit=DEFAULT_DIRECTIONS_HARD_LIMIT,
    )
    dgis_usage = http.usage_ledger.usage_status(
        provider=DGIS_PROVIDER,
        metric='routing_requests',
        hard_limit=DGIS_HARD_LIMIT,
    )
    results['local_hard_limits'] = {
        'mapbox_matrix': {
            'reserved': mapbox_matrix_usage.reserved_units,
            'limit': mapbox_matrix_usage.hard_limit,
        },
        'mapbox_directions': {
            'reserved': mapbox_directions_usage.reserved_units,
            'limit': mapbox_directions_usage.hard_limit,
        },
        '2gis_routing': {
            'reserved': dgis_usage.reserved_units,
            'limit': dgis_usage.hard_limit,
        },
    }
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
