"""Resolve ambiguous MCD station names by checking the actual Yandex timetable."""

from __future__ import annotations

import json
import sys
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from freeze_regular_rail_schedule import (  # noqa: E402
    MCD_LINE_TAGS,
    all_station_records,
    atomic_json,
    get_json,
    load_json,
    load_key,
    normalize_name,
)


def main() -> int:
    credentials = Path(sys.argv[1])
    schema_path = Path(sys.argv[2])
    output = Path(sys.argv[3])
    api_key = load_key(credentials)
    mapping_path = output / 'rail_station_map.json'
    mapping = load_json(mapping_path, {})
    schema = load_json(schema_path, {})['data']
    catalog = load_json(output / 'yandex_stations.json', {})
    records = [
        item for item in all_station_records(catalog)
        if item.get('transport_type') == 'train' and isinstance(item.get('codes', {}).get('yandex_code'), str)
    ]
    resolved = []
    checked = 0
    for station in schema['stations']:
        if station.get('mcd') is not True or str(station['id']) in mapping:
            continue
        line_id = station.get('lineId')
        expected = MCD_LINE_TAGS.get(line_id, '').replace('-', '')
        name = station['name']['ru']
        target = normalize_name(name)
        candidates = [
            item for item in records
            if normalize_name(str(item.get('title', '')).split('(', 1)[0]) == target
        ]
        confirmed = []
        for candidate in candidates:
            code = candidate['codes']['yandex_code']
            try:
                response = get_json('schedule/', {
                    'station': code,
                    'date': '2026-09-21',
                    'transport_types': 'suburban',
                    'limit': 20,
                }, api_key)
            except urllib.error.HTTPError:
                continue
            checked += 1
            entries = response.get('schedule', [])
            if any(
                isinstance(entry, dict)
                and isinstance(entry.get('thread'), dict)
                and str(entry['thread'].get('transport_subtype', {}).get('code', '')).casefold() == expected
                for entry in entries
            ):
                confirmed.append(candidate)
        if len(confirmed) == 1:
            candidate = confirmed[0]
            mapping[str(station['id'])] = {
                'metro_id': station['id'],
                'name': name,
                'kind': 'mcd',
                'line_id': line_id,
                'yandex_code': candidate['codes']['yandex_code'],
                'yandex_title': candidate.get('title'),
                'confirmed_by': 'Yandex schedule transport_subtype',
            }
            resolved.append(name)
            atomic_json(mapping_path, mapping)
    print(json.dumps({'requests': checked, 'resolved': resolved, 'mapped_total': len(mapping)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
