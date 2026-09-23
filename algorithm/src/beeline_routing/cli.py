from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from .cache import RoutingCache, default_usage_ledger_path
from .dataset import load_dataset_locations
from .dgis import DEFAULT_HARD_LIMIT as DGIS_HARD_LIMIT
from .dgis import PROVIDER as DGIS_PROVIDER
from .dgis import DgisRoutingClient
from .errors import RoutingError
from .export import detailed_route_dict, file_sha256, payload_sha256, write_json_atomic, write_matrix_csv
from .http import JsonHttpClient
from .hybrid import HybridRoutingClient
from .here import DEFAULT_HARD_LIMIT as HERE_HARD_LIMIT
from .here import PROVIDER as HERE_PROVIDER
from .here import HereTransitRoutingClient
from .interfaces import DetailedRoutingClient, MatrixRoutingClient
from .mapbox import DEFAULT_DIRECTIONS_HARD_LIMIT, DEFAULT_MATRIX_HARD_LIMIT
from .mapbox import PROVIDER as MAPBOX_PROVIDER
from .mapbox import MapboxRoutingClient
from .matrix import build_matrix, ensure_matrix_complete
from .models import RouteStatus, TransportMode
from .oracle import ExactRoutingOracle, OracleQuery
from .yandex import PROVIDER as YANDEX_PROVIDER
from .yandex import YandexRoutingClient
from .valhalla import DEFAULT_TRAFFIC_PROFILE, ValhallaRoutingClient
from .traffic4cast import Traffic4castProfile
from .valhalla_hybrid import Valhalla2GisRoutingClient
from .valhalla_here import ValhallaHereRoutingClient
from .local_transit import LocalTransitRoutingClient
from .memoized_transit import MemoizedTransitRoutingClient
from .valhalla_local_transit import ValhallaLocalTransitRoutingClient


def parse_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise argparse.ArgumentTypeError('Timestamp must include a UTC offset')
    return parsed


def load_credentials(path: Path) -> None:
    """Load a simple local KEY=VALUE file without logging credential values."""
    if not path.is_file():
        raise RoutingError(f'Credential file does not exist: {path}')
    for line_number, raw_line in enumerate(path.read_text(encoding='utf-8').splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition('=')
        if not separator or not name.strip() or not value.strip():
            raise RoutingError(f'Invalid credential entry at line {line_number}: {path}')
        os.environ[name.strip()] = value.strip()


def create_route_client(
    cache: RoutingCache,
    provider: str,
    *,
    timeout_seconds: float = 30,
    max_attempts: int = 4,
    transit_index: Path | None = None,
    metro_wait_seconds: int = 180,
) -> DetailedRoutingClient:
    http = JsonHttpClient(
        cache=cache,
        timeout_seconds=timeout_seconds,
        max_attempts=max_attempts,
    )
    if provider == 'hybrid':
        return HybridRoutingClient(
            dgis=DgisRoutingClient(http),
            mapbox=MapboxRoutingClient(http),
        )
    if provider == '2gis':
        return DgisRoutingClient(http)
    if provider == 'mapbox':
        return MapboxRoutingClient(http)
    if provider == 'yandex':
        return YandexRoutingClient(http)
    if provider == 'valhalla':
        return ValhallaRoutingClient(http)
    if provider == 'valhalla-2gis':
        return Valhalla2GisRoutingClient(
            dgis=DgisRoutingClient(http),
            valhalla=ValhallaRoutingClient(http),
        )
    if provider == 'valhalla-here':
        return ValhallaHereRoutingClient(
            here=HereTransitRoutingClient(http),
            valhalla=ValhallaRoutingClient(http),
        )
    if provider == 'valhalla-local-transit':
        valhalla = ValhallaRoutingClient(http)
        if transit_index is None:
            raise RoutingError('The local transit provider requires --transit-index')
        client = ValhallaLocalTransitRoutingClient(
            transit=LocalTransitRoutingClient(transit_index, valhalla,
                                              metro_wait_seconds=metro_wait_seconds),
            valhalla=valhalla,
        )
        stat = transit_index.resolve().stat()
        return MemoizedTransitRoutingClient(
            client,
            cache,
            namespace=(
                f'{transit_index.resolve()}:{stat.st_size}:{stat.st_mtime_ns}:'
                f'metro-wait={metro_wait_seconds}:'
                f'road-snapshot={valhalla.runtime_revision}'
            ),
        )
    raise RoutingError(f'Unsupported detailed-route provider: {provider}')


def create_matrix_client(cache: RoutingCache, provider: str) -> MatrixRoutingClient:
    http = JsonHttpClient(cache=cache)
    if provider == 'mapbox':
        return MapboxRoutingClient(http)
    if provider == 'yandex':
        return YandexRoutingClient(http)
    raise RoutingError(f'Provider {provider} does not expose the required matrix contract')


def provider_id(provider: str) -> str:
    return {
        '2gis': DGIS_PROVIDER,
        'mapbox': MAPBOX_PROVIDER,
        'yandex': YANDEX_PROVIDER,
        'hybrid': 'HYBRID_2GIS_MAPBOX',
    }[provider]


def command_validate_dataset(args: argparse.Namespace) -> int:
    dataset = load_dataset_locations(args.dataset, args.scenario)
    summary = {
        'dataset_version': dataset.dataset_version,
        'zones': {
            zone: {
                'locations': len(dataset.zone_location_ids[zone]),
                'modes': [mode.value for mode in dataset.zone_modes[zone]],
            }
            for zone in sorted(dataset.zone_location_ids)
        },
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def command_preflight(args: argparse.Namespace) -> int:
    dataset = load_dataset_locations(args.dataset, args.scenario)
    manifest_path = dataset.dataset_root / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    planning_at = datetime.fromisoformat(str(manifest['initial_planning_at']))
    required_modes = sorted(
        {mode for modes in dataset.zone_modes.values() for mode in modes},
        key=lambda mode: mode.value,
    )
    blockers: list[dict[str, str]] = []
    index_path = args.transit_index.resolve()
    transit_manifest = index_path.with_suffix('.manifest.json')
    if not index_path.is_file() or not transit_manifest.is_file():
        blockers.append({'code': 'LOCAL_TRANSIT_INDEX_MISSING',
                         'resolution': 'Build the GTFS and railway index on disk A:.'})
    else:
        index_metadata = json.loads(transit_manifest.read_text(encoding='utf-8'))
        if TransportMode.PUBLIC_TRANSIT in required_modes and index_metadata.get('scenario_date') != planning_at.date().isoformat():
            blockers.append({'code': 'LOCAL_TRANSIT_INDEX_DATE_MISMATCH',
                             'resolution': 'Rebuild the index for the dataset planning date.'})
        if index_metadata.get('unmapped_rail_stations'):
            blockers.append({'code': 'RAIL_STATION_COVERAGE_INCOMPLETE',
                             'resolution': 'Resolve the unmapped MCC/MCD stations.'})
    valhalla_endpoint = os.environ.get('VALHALLA_ROUTE_ENDPOINT', 'http://127.0.0.1:8002/route')
    status_endpoint = valhalla_endpoint.removesuffix('/route') + '/status'
    try:
        with urllib.request.urlopen(status_endpoint, timeout=3) as response:
            if response.status != 200:
                raise OSError(f'HTTP {response.status}')
    except OSError:
        blockers.append({'code': 'LOCAL_VALHALLA_UNAVAILABLE',
                         'resolution': 'Start the local Valhalla Docker service on port 8002.'})
    traffic_path = Path(os.environ.get('TRAFFIC4CAST_PROFILE') or DEFAULT_TRAFFIC_PROFILE)
    traffic_metadata = None
    if TransportMode.CAR in required_modes:
        try:
            traffic_metadata = Traffic4castProfile(traffic_path).metadata
        except (OSError, ValueError, KeyError, RoutingError) as error:
            blockers.append({
                'code': 'TRAFFIC4CAST_PROFILE_UNAVAILABLE',
                'resolution': f'Build or repair the Moscow Traffic4cast 2021 profile at {traffic_path}: {error}',
            })
    payload = {
        'status': 'READY_FOR_LOCAL_ROUTING' if not blockers else 'BLOCKED',
        'providers': {
            'surface_mcc_mcd_timetable': 'LOCAL_GTFS_AND_FROZEN_RASP',
            'metro_model': 'MOSMETRO_SCHEMA_WITH_EXPLICIT_WAIT_ASSUMPTION',
            'car_walking_and_bicycle': 'LOCAL_VALHALLA',
        },
        'dataset_version': dataset.dataset_version,
        'scenario': args.scenario.upper(),
        'initial_planning_at': planning_at.isoformat(),
        'required_modes': [mode.value for mode in required_modes],
        'transit_index': str(index_path),
        'valhalla_route_endpoint': valhalla_endpoint,
        'traffic4cast_profile': str(traffic_path) if traffic_metadata else None,
        'traffic4cast_profile_sha256': traffic_metadata.sha256 if traffic_metadata else None,
        'traffic4cast_source_days': traffic_metadata.source_days if traffic_metadata else None,
        'query_time_api_key_required': False,
        'metro_timetable_exact': False,
        'metro_wait_assumption_seconds': 180,
        'blockers': blockers,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if not blockers else 2


def command_cache_status(args: argparse.Namespace) -> int:
    if not args.cache.is_file():
        raise RoutingError(f'Routing cache does not exist: {args.cache}')
    cache = RoutingCache(args.cache)
    usage_ledger = RoutingCache(default_usage_ledger_path())
    integrity_sha256 = cache.verify_integrity()
    status = cache.status()
    usage = [
        usage_ledger.usage_status(
            provider=MAPBOX_PROVIDER,
            metric='matrix_elements',
            hard_limit=DEFAULT_MATRIX_HARD_LIMIT,
        ),
        usage_ledger.usage_status(
            provider=MAPBOX_PROVIDER,
            metric='directions_requests',
            hard_limit=DEFAULT_DIRECTIONS_HARD_LIMIT,
        ),
        usage_ledger.usage_status(
            provider=DGIS_PROVIDER,
            metric='routing_requests',
            hard_limit=DGIS_HARD_LIMIT,
        ),
        usage_ledger.usage_status(
            provider=HERE_PROVIDER,
            metric='public_transit_requests',
            hard_limit=HERE_HARD_LIMIT,
        ),
    ]
    if status.state == 'FROZEN' and status.snapshot_sha256 != integrity_sha256:
        raise RoutingError('Frozen routing snapshot failed its root checksum')
    print(
        json.dumps(
            {
                'state': status.state,
                'response_count': status.response_count,
                'frozen_at': status.frozen_at,
                'snapshot_sha256': status.snapshot_sha256,
                'current_integrity_sha256': integrity_sha256,
                'local_usage_budgets': [
                    {
                        'provider': item.provider,
                        'metric': item.metric,
                        'billing_period': item.billing_period,
                        'reserved_units': item.reserved_units,
                        'hard_limit': item.hard_limit,
                        'remaining_units': item.hard_limit - item.reserved_units,
                    }
                    for item in usage
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_freeze_cache(args: argparse.Namespace) -> int:
    if not args.cache.is_file():
        raise RoutingError(f'Routing cache does not exist: {args.cache}')
    cache = RoutingCache(args.cache)
    if cache.status().response_count == 0:
        raise RoutingError('Refusing to freeze an empty routing cache')
    status = cache.freeze()
    print(
        json.dumps(
            {
                'state': status.state,
                'response_count': status.response_count,
                'frozen_at': status.frozen_at,
                'snapshot_sha256': status.snapshot_sha256,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def command_route(args: argparse.Namespace) -> int:
    dataset = load_dataset_locations(args.dataset, args.scenario)
    try:
        origin = dataset.locations[args.origin_id]
        destination = dataset.locations[args.destination_id]
    except KeyError as error:
        raise RoutingError(f'Unknown location ID: {error.args[0]}') from error
    cache = RoutingCache(args.cache)
    client = create_route_client(
        cache,
        args.provider,
        timeout_seconds=args.timeout_seconds,
        max_attempts=args.max_attempts,
        transit_index=args.transit_index,
        metro_wait_seconds=args.metro_wait_seconds,
    )
    route = ExactRoutingOracle(client).query(
        OracleQuery(
            origin=origin,
            destination=destination,
            mode=args.mode,
            departure_at=args.departure_at,
        ),
        refresh=args.refresh,
    )
    payload = detailed_route_dict(route)
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({'status': route.status.value, 'output': str(args.output)}, ensure_ascii=False))
    return 0 if route.status != RouteStatus.UNKNOWN else 2


def command_matrix(args: argparse.Namespace) -> int:
    dataset = load_dataset_locations(args.dataset, args.scenario)
    if args.zone not in dataset.zone_location_ids:
        raise RoutingError(f'Unknown zone: {args.zone}')
    if args.mode not in dataset.zone_modes[args.zone]:
        raise RoutingError(f'Mode {args.mode.value} is not used by available engineers in {args.zone}')
    locations = [dataset.locations[item] for item in dataset.zone_location_ids[args.zone]]
    cache = RoutingCache(args.cache)
    client = create_matrix_client(cache, args.provider)
    cells = build_matrix(
        client=client,
        locations=locations,
        mode=args.mode,
        departure_at=args.departure_at,
        batch_side=args.batch_side,
        refresh=args.refresh,
    )
    write_matrix_csv(args.output, cells)
    ensure_matrix_complete(cells)
    counts = Counter(cell.status.value for cell in cells)
    cache_status = cache.status()
    cache_integrity_sha256 = cache.verify_integrity()
    manifest = {
        'matrix_schema_version': '1.0.0',
        'dataset_version': dataset.dataset_version,
        'provider': provider_id(args.provider),
        'purpose': 'SCREENING_ONLY_NOT_AUTHORITATIVE_FOR_OPTIMIZER',
        'scenario': args.scenario.upper(),
        'zone_id': args.zone,
        'mode': args.mode.value,
        'departure_at': args.departure_at.isoformat(),
        'locations': len(locations),
        'cells': len(cells),
        'status_counts': dict(sorted(counts.items())),
        'matrix_file': args.output.name,
        'matrix_file_sha256': file_sha256(args.output),
        'matrix_content_sha256': payload_sha256([
            (
                cell.origin_id,
                cell.destination_id,
                cell.status.value,
                cell.duration_seconds,
                cell.distance_m,
                cell.provenance.response_sha256,
            )
            for cell in cells
        ]),
        'routing_cache_state': cache_status.state,
        'routing_cache_snapshot_sha256': cache_status.snapshot_sha256,
        'routing_cache_current_integrity_sha256': cache_integrity_sha256,
    }
    manifest_path = args.output.with_suffix('.manifest.json')
    write_json_atomic(manifest_path, manifest)
    print(json.dumps({'status': 'SCREENING_MATRIX_READY', **manifest}, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='beeline-routing')
    parser.add_argument(
        '--credentials',
        type=Path,
        help='Optional ignored KEY=VALUE file; credential values are never printed or cached',
    )
    subparsers = parser.add_subparsers(dest='command', required=True)

    validate_parser = subparsers.add_parser('validate-dataset')
    validate_parser.add_argument('--dataset', type=Path, required=True)
    validate_parser.add_argument('--scenario', choices=['core', 'stress'], default='core')
    validate_parser.set_defaults(handler=command_validate_dataset)

    preflight_parser = subparsers.add_parser('preflight')
    preflight_parser.add_argument('--dataset', type=Path, required=True)
    preflight_parser.add_argument('--scenario', choices=['core', 'stress'], default='core')
    preflight_parser.add_argument('--transit-index', type=Path,
                                  default=Path('work/transit/moscow_2026-08-17.sqlite'))
    preflight_parser.set_defaults(handler=command_preflight)

    status_parser = subparsers.add_parser('cache-status')
    status_parser.add_argument('--cache', type=Path, required=True)
    status_parser.set_defaults(handler=command_cache_status)

    freeze_parser = subparsers.add_parser('freeze-cache')
    freeze_parser.add_argument('--cache', type=Path, required=True)
    freeze_parser.set_defaults(handler=command_freeze_cache)

    route_parser = subparsers.add_parser('route')
    route_parser.add_argument('--dataset', type=Path, required=True)
    route_parser.add_argument('--scenario', choices=['core', 'stress'], default='core')
    route_parser.add_argument('--origin-id', required=True)
    route_parser.add_argument('--destination-id', required=True)
    route_parser.add_argument('--mode', type=TransportMode, choices=list(TransportMode), required=True)
    route_parser.add_argument(
        '--provider', choices=['hybrid', '2gis', 'mapbox', 'yandex', 'valhalla', 'valhalla-2gis', 'valhalla-here', 'valhalla-local-transit'], default='valhalla-local-transit'
    )
    route_parser.add_argument('--departure-at', type=parse_timestamp, required=True)
    route_parser.add_argument('--cache', type=Path, required=True)
    route_parser.add_argument('--transit-index', type=Path,
                              default=Path('work/transit/moscow_2026-08-17.sqlite'))
    route_parser.add_argument('--metro-wait-seconds', type=int, default=180,
                              help='Explicit assumed metro wait per boarding; metro has no complete public timetable.')
    route_parser.add_argument('--output', type=Path, required=True)
    route_parser.add_argument(
        '--timeout-seconds', type=float, default=12,
        help='Maximum duration of one provider attempt; defaults to 12 seconds to bound 2GIS delays.',
    )
    route_parser.add_argument(
        '--max-attempts', type=int, default=1,
        help='Maximum physical provider requests for one route; defaults to one to preserve the 2GIS quota.',
    )
    route_parser.add_argument('--refresh', action='store_true')
    route_parser.set_defaults(handler=command_route)

    matrix_parser = subparsers.add_parser('matrix')
    matrix_parser.add_argument('--dataset', type=Path, required=True)
    matrix_parser.add_argument('--scenario', choices=['core', 'stress'], default='core')
    matrix_parser.add_argument('--zone', required=True)
    matrix_parser.add_argument('--mode', type=TransportMode, choices=list(TransportMode), required=True)
    matrix_parser.add_argument('--provider', choices=['mapbox', 'yandex'], default='mapbox')
    matrix_parser.add_argument('--departure-at', type=parse_timestamp, required=True)
    matrix_parser.add_argument('--cache', type=Path, required=True)
    matrix_parser.add_argument('--output', type=Path, required=True)
    matrix_parser.add_argument('--batch-side', type=int, default=12)
    matrix_parser.add_argument('--refresh', action='store_true')
    matrix_parser.set_defaults(handler=command_matrix)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.credentials is not None:
            load_credentials(args.credentials)
        exit_code = args.handler(args)
    except RoutingError as error:
        print(json.dumps({'status': 'ERROR', 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2) from error
    raise SystemExit(exit_code)


if __name__ == '__main__':
    main()
