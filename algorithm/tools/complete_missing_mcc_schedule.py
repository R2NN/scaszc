"""Fill three MCC station timetables from real adjacent-station Rasp searches.

Yandex's station schedule endpoint returns 404 for these MCC platforms even
though its point-to-point search endpoint returns individual trains. Every
saved arrival/departure here comes directly from a search segment; no times
are interpolated.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path


MISSING_CODES = {382: 's9855175', 372: 's9855170', 364: 's9855166'}
API = 'https://api.rasp.yandex-net.ru/v3.0/search/'


def key_from_file(path: Path | None) -> str:
    key = os.environ.get('YANDEX_RASP_API_KEY')
    if key:
        return key
    if path is not None:
        for line in path.read_text(encoding='utf-8').splitlines():
            name, separator, value = line.partition('=')
            if separator and name.strip() == 'YANDEX_RASP_API_KEY':
                return value.strip()
    raise RuntimeError('YANDEX_RASP_API_KEY missing')


def atomic_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def fetch(code_from: str, code_to: str, source_date: str, key: str,
          cache: Path) -> dict:
    if cache.is_file():
        return json.loads(cache.read_text(encoding='utf-8'))
    parameters = {'from': code_from, 'to': code_to, 'date': source_date,
                  'transport_types': 'suburban', 'limit': 500}
    request = urllib.request.Request(API + '?' + urllib.parse.urlencode(parameters),
                                     headers={'User-Agent': 'beeline-routing-hackathon/0.1',
                                              'Authorization': key})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    if payload.get('pagination', {}).get('total', 0) > len(payload.get('segments', [])):
        raise RuntimeError(f'Search pagination incomplete for {code_from} -> {code_to}')
    cache.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(cache, payload)
    return payload


def build(rail_dir: Path, schema_path: Path, credentials: Path | None) -> dict:
    manifest_path = rail_dir / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    source_date = manifest['normal_weekday_reference_date']
    station_map_path = rail_dir / 'rail_station_map.json'
    schedules_path = rail_dir / 'rail_schedule.json'
    station_map = json.loads(station_map_path.read_text(encoding='utf-8'))
    schedules = json.loads(schedules_path.read_text(encoding='utf-8'))
    schema = json.loads(schema_path.read_text(encoding='utf-8'))['data']
    stations = {item['id']: item for item in schema['stations']}
    key = key_from_file(credentials)
    report = {'source': API, 'source_date': source_date,
              'queries': [], 'completed_stations': []}
    for station_id, code in MISSING_CODES.items():
        station = stations[station_id]
        adjacent_ids = []
        for edge in schema['connections']:
            if edge.get('stationFromId') == station_id:
                adjacent_ids.append(edge['stationToId'])
            elif edge.get('stationToId') == station_id:
                adjacent_ids.append(edge['stationFromId'])
        adjacent_codes = [station_map[str(item)]['yandex_code'] for item in adjacent_ids]
        if len(adjacent_codes) != 2:
            raise RuntimeError(f'Expected two mapped MCC neighbors for {station_id}')
        by_uid = defaultdict(dict)
        for neighbor in adjacent_codes:
            for origin, destination, event_key, time_key in (
                (code, neighbor, 'departure', 'departure'),
                (neighbor, code, 'arrival', 'arrival'),
            ):
                cache = rail_dir / 'mcc_search_evidence' / f'{origin}_{destination}_{source_date}.json'
                payload = fetch(origin, destination, source_date, key, cache)
                kept = 0
                for segment in payload.get('segments', []):
                    departure = segment.get('departure')
                    arrival = segment.get('arrival')
                    thread = segment.get('thread') or {}
                    uid = thread.get('uid')
                    if not uid or not departure or not arrival:
                        continue
                    duration = (datetime.fromisoformat(arrival) -
                                datetime.fromisoformat(departure)).total_seconds()
                    if not 0 < duration <= 10 * 60:
                        continue
                    event = by_uid[uid]
                    value = segment[time_key]
                    if event_key in event and event[event_key] != value:
                        raise RuntimeError(f'Contradictory {event_key} for {uid}')
                    event[event_key] = value
                    event['thread'] = thread
                    kept += 1
                report['queries'].append({'from': origin, 'to': destination,
                                          'segments': len(payload.get('segments', [])),
                                          'adjacent_ride_segments': kept,
                                          'evidence_file': str(cache)})
        entries = []
        for uid, event in by_uid.items():
            arrival = event.get('arrival')
            departure = event.get('departure')
            if not arrival or not departure:
                continue
            dwell = (datetime.fromisoformat(departure) -
                     datetime.fromisoformat(arrival)).total_seconds()
            if not 0 <= dwell <= 3 * 60:
                continue
            entries.append({'arrival': arrival, 'departure': departure,
                            'thread': event['thread'],
                            'evidence': 'adjacent_station_search_both_sides'})
        if len(entries) < 100:
            raise RuntimeError(f'Too few verified MCC events for {station_id}: {len(entries)}')
        entries.sort(key=lambda item: item['departure'])
        station_map[str(station_id)] = {
            'kind': 'mcc', 'metro_id': station_id,
            'name': station['name']['ru'], 'line_id': station['lineId'],
            'yandex_code': code, 'yandex_title': station['name']['ru'],
        }
        schedules[code] = {'source_date': source_date,
                           'fetched_at': datetime.now().astimezone().isoformat(),
                           'entries': entries,
                           'method': 'adjacent_station_search_both_sides'}
        report['completed_stations'].append({'metro_id': station_id,
                                             'name': station['name']['ru'],
                                             'code': code, 'verified_departures': len(entries)})
    atomic_json(station_map_path, station_map)
    atomic_json(schedules_path, schedules)
    manifest['stations_mapped'] = len(station_map)
    manifest['station_schedules_frozen'] = len(schedules)
    manifest['coverage_audit'] = {
        'official_mcc_stations': sum(item.get('mcc') is True for item in schema['stations']),
        'mapped_mcc_stations': sum(item['kind'] == 'mcc' for item in station_map.values()),
        'official_mcd_stations': sum(item.get('mcd') is True for item in schema['stations']),
        'mapped_mcd_stations': sum(item['kind'] == 'mcd' for item in station_map.values()),
        'additional_mcc_method': 'Yandex Rasp search between adjacent stations',
    }
    atomic_json(manifest_path, manifest)
    atomic_json(rail_dir / 'mcc_search_evidence' / 'coverage_report.json', report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rail', type=Path, required=True)
    parser.add_argument('--schema', type=Path, required=True)
    parser.add_argument('--credentials', type=Path, required=True)
    args = parser.parse_args()
    result = build(args.rail, args.schema, args.credentials)
    print(json.dumps({'completed_stations': result['completed_stations'],
                      'queries': len(result['queries'])}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
