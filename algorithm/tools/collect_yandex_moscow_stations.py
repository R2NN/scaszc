from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from beeline_routing.cli import load_credentials
from beeline_routing.export import write_json_atomic


ENDPOINT = 'https://api.rasp.yandex-net.ru/v3.0/stations_list/?lang=ru_RU&format=json'
MOSCOW_BOUNDS = (54.7, 36.0, 56.5, 39.6)
RAIL_TYPES = {'Электричка', 'Поезд', 'suburban', 'train'}


def _inside_moscow_region(station: dict[str, Any]) -> bool:
    try:
        latitude = float(station['latitude'])
        longitude = float(station['longitude'])
    except (KeyError, TypeError, ValueError):
        return False
    south, west, north, east = MOSCOW_BOUNDS
    return south <= latitude <= north and west <= longitude <= east


def main() -> int:
    parser = argparse.ArgumentParser(description='Collect Moscow rail stations without storing the API key.')
    parser.add_argument('--credentials-file', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    load_credentials(args.credentials_file)
    import os

    api_key = os.environ.get('YANDEX_RASP_API_KEY', '').strip()
    if not api_key:
        raise ValueError('YANDEX_RASP_API_KEY is missing')
    request = urllib.request.Request(
        ENDPOINT,
        headers={'Authorization': api_key, 'Accept': 'application/json', 'User-Agent': 'beeline-routing/0.1.0'},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read(80 * 1024 * 1024 + 1)
        status = int(response.status)
    if status != 200 or len(raw) > 80 * 1024 * 1024:
        raise RuntimeError(f'Unexpected stations-list response: HTTP {status}, bytes={len(raw)}')
    payload = json.loads(raw.decode('utf-8'))
    selected: dict[str, dict[str, Any]] = {}
    for country in payload.get('countries', []):
        for region in country.get('regions', []):
            for settlement in region.get('settlements', []):
                for station in settlement.get('stations', []):
                    if station.get('transport_type') not in RAIL_TYPES or not _inside_moscow_region(station):
                        continue
                    code = station.get('codes', {}).get('yandex_code')
                    if not isinstance(code, str) or not code:
                        continue
                    selected[code] = {
                        'code': code,
                        'title': station.get('title'),
                        'direction': station.get('direction'),
                        'station_type': station.get('station_type'),
                        'transport_type': station.get('transport_type'),
                        'latitude': station.get('latitude'),
                        'longitude': station.get('longitude'),
                        'settlement': settlement.get('title'),
                        'region': region.get('title'),
                    }
    result = {
        'schema_version': '1.0.0',
        'source': 'YANDEX_RASP_STATIONS_LIST',
        'endpoint': ENDPOINT.split('?')[0],
        'fetched_at': datetime.now(UTC).isoformat(),
        'response_sha256': hashlib.sha256(raw).hexdigest(),
        'bounds': MOSCOW_BOUNDS,
        'station_count': len(selected),
        'stations': [selected[code] for code in sorted(selected)],
    }
    write_json_atomic(args.output, result)
    print(json.dumps({'status': 'OK', 'station_count': len(selected), 'output': str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
