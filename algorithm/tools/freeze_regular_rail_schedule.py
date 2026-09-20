"""Freeze a normal-weekday MCC/MCD timetable from Yandex Rasp for local routing.

The source date is deliberately independent from the hackathon input date.  It
is a reproducible normal-weekday reference timetable that is kept on disk and
then used without further API requests.  The script never fabricates a
departure: each saved entry is an API response with its source station and
request parameters.

The free Yandex Rasp quota is limited.  The collector is resumable: run it
again with the same output folder, or set another key in
``YANDEX_RASP_API_KEY`` after the first key reaches its limit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.parse
import urllib.error
import urllib.request
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


API_ROOT = 'https://api.rasp.yandex-net.ru/v3.0/'
SOURCE_DATE = '2026-09-21'  # Monday; selected as the normal-weekday reference.
USER_AGENT = 'beeline-routing-hackathon/0.1 (local timetable freeze)'

# Names in the metro schema and Yandex's railway directory differ at these
# interchange stations.  The values are Yandex station codes from the same
# downloaded station directory; the fallback avoids selecting an unrelated
# homonymous railway platform.
MCC_CODE_OVERRIDES = {
    'Андроновка': 's9855157',
    'Лихоборы': 's9855181',
    'Локомотив': 's9601334',
    'Стрешнево': 's9855178',
}
MCD_LINE_TAGS = {14: 'мцд-1', 15: 'мцд-2', 36: 'мцд-3', 37: 'мцд-4', 38: 'мцд-4'}
MCD_CODE_ALIASES = {
    ('Курская', 15): 's2000001',
    ('Курская', 37): 's2000001',
    ('Белорусская', 14): 's2000006',
    ('Белорусская', 37): 's2000006',
    ('Депо', 15): 's9602245',
    ('Люберцы', 36): 's9601636',
    ('Перово', 36): 's9600931',
    ('Андроновка', 36): 's9601991',
    ('Лихоборы', 36): 's9603256',
    ('Окружная', 14): 's9601830',
    ('Новохохловская', 15): 's9868807',
    ('Тимирязевская', 14): 's9602463',
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credentials', type=Path, required=True)
    parser.add_argument('--metro-schema', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--date', default=SOURCE_DATE, help='Normal-weekday source date in YYYY-MM-DD.')
    parser.add_argument('--kinds', default='mcc,mcd', help='Comma-separated: mcc,mcd.')
    parser.add_argument('--max-requests', type=int, default=450)
    parser.add_argument('--pause-seconds', type=float, default=0.05)
    parser.add_argument('--map-only', action='store_true', help='Match metro-schema stations to Yandex codes without API schedule calls.')
    return parser.parse_args()


def load_key(credentials: Path) -> str:
    for raw in credentials.read_text(encoding='utf-8').splitlines():
        key, separator, value = raw.partition('=')
        if separator and key.strip() == 'YANDEX_RASP_API_KEY' and value.strip():
            return value.strip()
    raise RuntimeError('YANDEX_RASP_API_KEY is missing from the credentials file.')


def get_json(path: str, parameters: dict[str, Any], api_key: str) -> dict[str, Any]:
    query = urllib.parse.urlencode({**parameters, 'apikey': api_key})
    request = urllib.request.Request(API_ROOT + path + '?' + query, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=90) as response:
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise RuntimeError(f'Unexpected response type for {path}.')
    return payload


def atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding='utf-8')
    temporary.replace(path)


def load_json(path: Path, default: Any) -> Any:
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


def all_station_records(payload: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    def walk(value: Any, region: str = '') -> None:
        if isinstance(value, dict):
            stations = value.get('stations')
            if isinstance(stations, list):
                records.extend({**item, '_region': region} for item in stations if isinstance(item, dict))
            regions = value.get('regions')
            if isinstance(regions, list):
                for child_region in regions:
                    if isinstance(child_region, dict):
                        walk(child_region, str(child_region.get('title', '')))
            for key, child in value.items():
                if key != 'regions':
                    walk(child, region)
        elif isinstance(value, list):
            for child in value:
                walk(child, region)

    walk(payload)
    return records


def normalize_name(value: str) -> str:
    return ''.join(character for character in value.casefold().replace('ё', 'е') if character.isalnum())


def station_candidates(catalog: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for station in catalog:
        if station.get('transport_type') != 'train':
            continue
        if 'москва' not in str(station.get('_region', '')).casefold():
            continue
        codes = station.get('codes')
        if not isinstance(codes, dict) or not isinstance(codes.get('yandex_code'), str):
            continue
        title = station.get('title')
        if isinstance(title, str):
            base_title = title.split(',', maxsplit=1)[0].split('(', maxsplit=1)[0].strip()
            result.setdefault(normalize_name(base_title), []).append(station)
    return result


def choose_station(name: str, kind: str, line_id: int | None, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not candidates:
        return None
    if kind == 'mcc':
        mcc = [item for item in candidates if 'мцк' in str(item.get('title', '')).casefold()]
        if len(mcc) == 1:
            return mcc[0]
    if kind == 'mcd':
        line_tag = MCD_LINE_TAGS.get(line_id)
        matching_line = [item for item in candidates if line_tag and line_tag in str(item.get('title', '')).casefold()]
        if len(matching_line) == 1:
            return matching_line[0]
    return candidates[0] if len(candidates) == 1 else None


def selected_stations(schema: dict[str, Any], kinds: set[str]) -> list[dict[str, Any]]:
    data = schema.get('data')
    if not isinstance(data, dict) or not isinstance(data.get('stations'), list):
        raise RuntimeError('Metro schema has no data.stations list.')
    rows: list[dict[str, Any]] = []
    for station in data['stations']:
        if not isinstance(station, dict):
            continue
        kind = 'mcc' if station.get('mcc') is True else 'mcd' if station.get('mcd') is True else None
        if kind not in kinds:
            continue
        name = station.get('name')
        russian_name = name.get('ru') if isinstance(name, dict) else None
        if isinstance(russian_name, str):
            rows.append({'metro_id': station.get('id'), 'name': russian_name, 'kind': kind, 'line_id': station.get('lineId')})
    return rows


def fetch_all_pages(code: str, date: str, api_key: str, budget: list[int], pause_seconds: float) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    offset = 0
    while True:
        if budget[0] <= 0:
            raise RuntimeError('Request budget exhausted.')
        payload = get_json('schedule/', {
            'station': code,
            'date': date,
            'transport_types': 'suburban',
            'limit': 100,
            'offset': offset,
        }, api_key)
        budget[0] -= 1
        page = payload.get('schedule')
        pagination = payload.get('pagination')
        if not isinstance(page, list) or not isinstance(pagination, dict):
            raise RuntimeError(f'Invalid schedule response for station {code}.')
        records.extend(item for item in page if isinstance(item, dict))
        total = pagination.get('total')
        if not isinstance(total, int) or offset + len(page) >= total:
            return records
        if not page:
            raise RuntimeError(f'Pagination made no progress for station {code}.')
        offset += len(page)
        time.sleep(pause_seconds)


def main() -> int:
    args = parse_args()
    if args.max_requests < 1 or args.pause_seconds < 0:
        raise SystemExit('max-requests must be positive and pause-seconds must be non-negative.')
    kinds = {value.strip() for value in args.kinds.split(',') if value.strip()}
    if not kinds or not kinds <= {'mcc', 'mcd'}:
        raise SystemExit('kinds must contain mcc and/or mcd.')
    output = args.output.resolve()
    catalog_path = output / 'yandex_stations.json'
    if not catalog_path.exists():
        catalog = get_json('stations_list/', {'lang': 'ru_RU', 'format': 'json'}, api_key)
        atomic_json(catalog_path, catalog)
    catalog = load_json(catalog_path, {})
    api_key = '' if args.map_only else load_key(args.credentials)
    candidates = station_candidates(all_station_records(catalog))
    schema = load_json(args.metro_schema, {})
    stations_path = output / 'rail_station_map.json'
    schedule_path = output / 'rail_schedule.json'
    stations = load_json(stations_path, {})
    schedules = load_json(schedule_path, {})
    budget = [args.max_requests]
    unresolved: list[dict[str, Any]] = []
    for item in selected_stations(schema, kinds):
        metro_id = str(item['metro_id'])
        if metro_id not in stations:
            selected = choose_station(item['name'], item['kind'], item.get('line_id'), candidates.get(normalize_name(item['name']), []))
            if selected is None and item['kind'] == 'mcc':
                override = MCC_CODE_OVERRIDES.get(item['name'])
                if override is not None:
                    selected = next(
                        (
                            candidate
                            for values in candidates.values()
                            for candidate in values
                            if candidate['codes']['yandex_code'] == override
                        ),
                        None,
                    )
            if selected is None and item['kind'] == 'mcd':
                override = MCD_CODE_ALIASES.get((item['name'], item.get('line_id')))
                if override is not None:
                    selected = next(
                        (
                            candidate
                            for values in candidates.values()
                            for candidate in values
                            if candidate['codes']['yandex_code'] == override
                        ),
                        None,
                    )
            if selected is None:
                unresolved.append(item)
                continue
            stations[metro_id] = {
                **item,
                'yandex_code': selected['codes']['yandex_code'],
                'yandex_title': selected.get('title'),
            }
            atomic_json(stations_path, stations)
        code = stations[metro_id]['yandex_code']
        if args.map_only or code in schedules:
            continue
        try:
            entries = fetch_all_pages(code, args.date, api_key, budget, args.pause_seconds)
        except urllib.error.HTTPError as error:
            unresolved.append({**item, 'yandex_code': code, 'http_status': error.code})
            stations.pop(metro_id, None)
            atomic_json(stations_path, stations)
            continue
        except RuntimeError as error:
            if str(error) == 'Request budget exhausted.':
                break
            raise
        schedules[code] = {'source_date': args.date, 'fetched_at': datetime.now(UTC).isoformat(), 'entries': entries}
        atomic_json(schedule_path, schedules)
    manifest = {
        'normal_weekday_reference_date': args.date,
        'input_date_not_modified': '2026-08-17',
        'source': 'Yandex Rasp API v3',
        'source_endpoint': API_ROOT,
        'requested_kinds': sorted(kinds),
        'stations_mapped': len(stations),
        'station_schedules_frozen': len(schedules),
        'unresolved_stations': unresolved,
        'remaining_request_budget': budget[0],
        'frozen_at': datetime.now(UTC).isoformat(),
        'station_catalog_sha256': hashlib.sha256(catalog_path.read_bytes()).hexdigest(),
    }
    atomic_json(output / 'manifest.json', manifest)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
