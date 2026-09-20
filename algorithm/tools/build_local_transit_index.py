"""Build a local, date-specific timetable index from real Moscow transit data.

The GTFS feed is evaluated on the unchanged scenario date. Railway entries
come from a frozen normal-Monday Yandex Rasp response; their clock times are
used as an explicitly labelled reference, never presented as 17 August facts.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
import heapq
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path


def seconds(value: str) -> int:
    """Parse a GTFS time, including hours past 24 for after-midnight service."""
    hours, minutes, secs = map(int, value.split(':'))
    if not 0 <= minutes < 60 or not 0 <= secs < 60 or hours < 0:
        raise ValueError(f'Invalid GTFS time: {value}')
    return hours * 3600 + minutes * 60 + secs


def rail_seconds(value: str, reference: date) -> int:
    moment = datetime.fromisoformat(value)
    return (moment.date() - reference).days * 86400 + moment.hour * 3600 + moment.minute * 60 + moment.second


def rows(path: Path):
    with path.open(encoding='utf-8-sig', newline='') as source:
        yield from csv.DictReader(source)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def build(
    gtfs: Path,
    rail: Path,
    metro_schema: Path,
    output: Path,
    scenario: date,
    metro_wait_seconds: int = 180,
) -> dict:
    if metro_wait_seconds < 0:
        raise ValueError('Metro wait time must be non-negative')
    reference = date.fromisoformat(json.loads((rail / 'manifest.json').read_text(encoding='utf-8'))['normal_weekday_reference_date'])
    if scenario.weekday() != reference.weekday():
        raise ValueError('Railway reference weekday differs from the scenario weekday')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.tmp.sqlite')
    temporary.unlink(missing_ok=True)
    db = sqlite3.connect(temporary)
    db.execute('PRAGMA journal_mode=OFF')
    db.execute('PRAGMA synchronous=OFF')
    db.execute('PRAGMA temp_store=MEMORY')
    db.executescript('''
        CREATE TABLE stops(id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL,
                           lon REAL NOT NULL, kind TEXT NOT NULL);
        CREATE TABLE trips(id TEXT PRIMARY KEY, line TEXT NOT NULL, headsign TEXT NOT NULL,
                           kind TEXT NOT NULL);
        CREATE TABLE connections(id INTEGER PRIMARY KEY, from_id TEXT NOT NULL,
                                 to_id TEXT NOT NULL, dep INTEGER NOT NULL, arr INTEGER NOT NULL,
                                 trip_id TEXT NOT NULL, source TEXT NOT NULL);
        CREATE TABLE transfers(from_id TEXT NOT NULL, to_id TEXT NOT NULL,
                               seconds INTEGER NOT NULL, source TEXT NOT NULL,
                               PRIMARY KEY(from_id,to_id));
        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE network_station_ids(metro_id INTEGER PRIMARY KEY, stop_id TEXT NOT NULL);
        CREATE TABLE metro_paths(from_id TEXT NOT NULL, to_id TEXT NOT NULL,
                                 seconds INTEGER NOT NULL, path_json TEXT NOT NULL,
                                 PRIMARY KEY(from_id,to_id));
        CREATE TABLE stop_events(trip_id TEXT, sequence INTEGER, stop_id TEXT,
                                 arr INTEGER, dep INTEGER, pickup_type TEXT);
    ''')
    active_services = {
        row['service_id'] for row in rows(gtfs / 'calendar.txt')
        if row['start_date'] <= scenario.strftime('%Y%m%d') <= row['end_date']
        and row[scenario.strftime('%A').lower()] == '1'
    }
    routes = {row['route_id']: row for row in rows(gtfs / 'routes.txt')}
    active_trips = {}
    for row in rows(gtfs / 'trips.txt'):
        if row['service_id'] not in active_services:
            continue
        route = routes.get(row['route_id'])
        if route is None:
            continue
        kind = {'0': 'tram', '3': 'bus', '5': 'cable_tram'}.get(route['route_type'], 'surface_transit')
        active_trips[row['trip_id']] = (route['route_short_name'], row['trip_headsign'], kind)
    db.executemany('INSERT INTO trips VALUES (?,?,?,?)',
                   (('g:' + key, *value) for key, value in active_trips.items()))
    stop_count = 0
    for row in rows(gtfs / 'stops.txt'):
        try:
            db.execute('INSERT OR IGNORE INTO stops VALUES (?,?,?,?,?)',
                       ('g:' + row['stop_id'], row['stop_name'], float(row['stop_lat']),
                        float(row['stop_lon']), 'surface'))
            stop_count += 1
        except (ValueError, TypeError):
            continue
    db.commit()
    event_batch = []
    for row in rows(gtfs / 'stop_times.txt'):
        if row['trip_id'] not in active_trips:
            continue
        try:
            event_batch.append(('g:' + row['trip_id'], int(row['stop_sequence']),
                                'g:' + row['stop_id'], seconds(row['arrival_time']),
                                seconds(row['departure_time']), row['pickup_type']))
        except (ValueError, KeyError):
            continue
        if len(event_batch) >= 20000:
            db.executemany('INSERT INTO stop_events VALUES (?,?,?,?,?,?)', event_batch)
            event_batch.clear()
    if event_batch:
        db.executemany('INSERT INTO stop_events VALUES (?,?,?,?,?,?)', event_batch)
    db.execute('CREATE INDEX events_order ON stop_events(trip_id,sequence)')
    db.commit()
    ground_edges = 0
    bad_ground_edges = 0
    last_trip = None
    previous = None
    edge_batch = []
    for trip_id, sequence, stop_id, arr, dep, pickup in db.execute(
        'SELECT trip_id,sequence,stop_id,arr,dep,pickup_type FROM stop_events ORDER BY trip_id,sequence'
    ):
        if trip_id == last_trip and previous is not None:
            prev_stop, prev_dep, prev_pickup = previous
            if arr >= prev_dep and stop_id != prev_stop and prev_pickup != '1':
                edge_batch.append((prev_stop, stop_id, prev_dep, arr, trip_id, 'GTFS'))
                ground_edges += 1
            else:
                bad_ground_edges += 1
        previous = (stop_id, dep, pickup)
        last_trip = trip_id
        if len(edge_batch) >= 20000:
            db.executemany('INSERT INTO connections(from_id,to_id,dep,arr,trip_id,source) VALUES (?,?,?,?,?,?)', edge_batch)
            edge_batch.clear()
    if edge_batch:
        db.executemany('INSERT INTO connections(from_id,to_id,dep,arr,trip_id,source) VALUES (?,?,?,?,?,?)', edge_batch)
    db.execute('DROP TABLE stop_events')
    db.commit()

    metro = json.loads(metro_schema.read_text(encoding='utf-8'))['data']
    metro_by_id = {station['id']: station for station in metro['stations']}
    network_station_ids = {}
    for station in metro['stations']:
        if station.get('perspective') or station.get('mcc') or station.get('mcd'):
            continue
        stop_id = f"m:{station['id']}"
        network_station_ids[station['id']] = stop_id
        db.execute('INSERT OR IGNORE INTO stops VALUES (?,?,?,?,?)',
                   (stop_id, station['name']['ru'], station['location']['lat'],
                    station['location']['lon'], 'metro'))
        db.execute('INSERT OR REPLACE INTO network_station_ids VALUES (?,?)',
                   (station['id'], stop_id))
    station_map = json.loads((rail / 'rail_station_map.json').read_text(encoding='utf-8'))
    code_to_station = {}
    for item in station_map.values():
        station = metro_by_id[item['metro_id']]
        stop_id = 'r:' + item['yandex_code']
        code_to_station[item['yandex_code']] = stop_id
        db.execute('INSERT OR IGNORE INTO stops VALUES (?,?,?,?,?)',
                   (stop_id, item['name'], station['location']['lat'], station['location']['lon'], item['kind']))
        network_station_ids[item['metro_id']] = stop_id
        db.execute('INSERT OR REPLACE INTO network_station_ids VALUES (?,?)', (item['metro_id'], stop_id))
    rail_data = json.loads((rail / 'rail_schedule.json').read_text(encoding='utf-8'))
    by_uid = defaultdict(list)
    for code, schedule in rail_data.items():
        if code not in code_to_station:
            continue
        for entry in schedule['entries']:
            thread = entry.get('thread') or {}
            uid = thread.get('uid')
            if uid:
                by_uid[uid].append((code, entry, thread))
    rail_edges = 0
    invalid_rail_edges = 0
    rail_trip_rows = []
    rail_edge_rows = []
    for uid, events in by_uid.items():
        thread = events[0][2]
        subtype = thread.get('transport_subtype') or {}
        rail_trip_rows.append(('r:' + uid, str(thread.get('number') or ''),
                               str(thread.get('title') or ''), str(subtype.get('title') or 'suburban')))
        events.sort(key=lambda event: rail_seconds(event[1].get('arrival') or event[1].get('departure'), reference))
        for (left_code, left, _), (right_code, right, _) in zip(events, events[1:]):
            if left_code == right_code or not left.get('departure') or not right.get('arrival'):
                invalid_rail_edges += 1
                continue
            dep = rail_seconds(left['departure'], reference)
            arr = rail_seconds(right['arrival'], reference)
            if not dep < arr <= dep + 4 * 3600:
                invalid_rail_edges += 1
                continue
            rail_edge_rows.append((code_to_station[left_code], code_to_station[right_code],
                                   dep, arr, 'r:' + uid, 'YANDEX_RASP_NORMAL_MONDAY'))
            rail_edges += 1
    db.executemany('INSERT INTO trips VALUES (?,?,?,?)', rail_trip_rows)
    db.executemany('INSERT INTO connections(from_id,to_id,dep,arr,trip_id,source) VALUES (?,?,?,?,?,?)', rail_edge_rows)
    db.execute('CREATE INDEX connections_dep ON connections(dep)')
    db.execute('CREATE INDEX connections_from_dep ON connections(from_id,dep)')
    official_transfer_count = 0
    for transfer in metro['transitions']:
        source = network_station_ids.get(transfer['stationFromId'])
        target = network_station_ids.get(transfer['stationToId'])
        duration = transfer.get('pathLength')
        if source and target and source != target and isinstance(duration, int) and duration > 0:
            db.execute('INSERT OR REPLACE INTO transfers VALUES (?,?,?,?)',
                       (source, target, duration, 'MOSMETRO_OFFICIAL_TRANSITION'))
            official_transfer_count += 1
            if transfer.get('bi'):
                db.execute('INSERT OR REPLACE INTO transfers VALUES (?,?,?,?)',
                           (target, source, duration, 'MOSMETRO_OFFICIAL_TRANSITION'))
                official_transfer_count += 1

    metro_ids = {station_id for station_id, stop_id in network_station_ids.items()
                 if stop_id.startswith('m:')}
    metro_graph = defaultdict(list)
    for connection in metro['connections']:
        source = connection.get('stationFromId')
        target = connection.get('stationToId')
        duration = connection.get('pathLength')
        if source not in metro_ids or target not in metro_ids:
            continue
        if connection.get('perspective') or not isinstance(duration, int) or duration <= 0:
            continue
        metro_graph[source].append((target, duration, 'metro'))
        if connection.get('bi') and not connection.get('closedBackward'):
            metro_graph[target].append((source, duration, 'metro'))
    for transfer in metro['transitions']:
        source = transfer.get('stationFromId')
        target = transfer.get('stationToId')
        duration = transfer.get('pathLength')
        if source not in metro_ids or target not in metro_ids:
            continue
        if transfer.get('perspective') or not isinstance(duration, int) or duration <= 0:
            continue
        metro_graph[source].append((target, duration, 'transfer'))
        if transfer.get('bi'):
            metro_graph[target].append((source, duration, 'transfer'))

    metro_path_rows = []
    for source in sorted(metro_ids):
        initial = (source, -1, False)
        durations = {initial: 0}
        predecessors = {}
        queue = [(0, *initial)]
        while queue:
            elapsed, station_id, onboard_line, ridden = heapq.heappop(queue)
            state = (station_id, onboard_line, ridden)
            if durations[state] != elapsed:
                continue
            for target, ride_seconds, kind in metro_graph[station_id]:
                if kind == 'metro':
                    line_id = metro_by_id[station_id]['lineId']
                    wait = 0 if onboard_line == line_id else metro_wait_seconds
                    next_state = (target, line_id, True)
                else:
                    wait = 0
                    next_state = (target, -1, ridden)
                candidate = elapsed + wait + ride_seconds
                if candidate < durations.get(next_state, 10**9):
                    durations[next_state] = candidate
                    predecessors[next_state] = (state, kind, ride_seconds, wait)
                    heapq.heappush(queue, (candidate, *next_state))
        for target in sorted(metro_ids - {source}):
            choices = [(duration, state) for state, duration in durations.items()
                       if state[0] == target and state[2]]
            if not choices:
                continue
            elapsed, state = min(choices)
            states = [state]
            while states[-1] != initial:
                states.append(predecessors[states[-1]][0])
            states.reverse()
            segments = []
            for left, right in zip(states, states[1:]):
                _, kind, ride_seconds, wait = predecessors[right]
                segments.append({'from_id': network_station_ids[left[0]],
                                 'to_id': network_station_ids[right[0]],
                                 'kind': kind, 'seconds': ride_seconds,
                                 'wait_seconds': wait,
                                 'line_id': metro_by_id[left[0]]['lineId']})
            metro_path_rows.append((network_station_ids[source], network_station_ids[target],
                                    elapsed, json.dumps(segments, ensure_ascii=False)))
    db.executemany('INSERT INTO metro_paths VALUES (?,?,?,?)', metro_path_rows)
    official_transfer_count = db.execute('SELECT COUNT(*) FROM transfers').fetchone()[0]
    report = {
        'scenario_date': scenario.isoformat(),
        'rail_reference_date': reference.isoformat(),
        'active_gtfs_services': len(active_services),
        'active_gtfs_trips': len(active_trips),
        'surface_stops': stop_count,
        'surface_connections': ground_edges,
        'invalid_surface_connections_skipped': bad_ground_edges,
        'rail_stops': len(code_to_station),
        'official_mcc_stations': sum(station.get('mcc') is True for station in metro['stations']),
        'mapped_mcc_stations': sum(item['kind'] == 'mcc' for item in station_map.values()),
        'official_mcd_stations': sum(station.get('mcd') is True for station in metro['stations']),
        'mapped_mcd_stations': sum(item['kind'] == 'mcd' for item in station_map.values()),
        'unmapped_rail_stations': [
            {'id': station['id'], 'name': station['name']['ru']}
            for station in metro['stations']
            if (station.get('mcc') is True or station.get('mcd') is True)
            and str(station['id']) not in station_map
        ],
        'rail_trips': len(by_uid),
        'rail_connections': rail_edges,
        'invalid_rail_connections_skipped': invalid_rail_edges,
        'official_network_transfers': official_transfer_count,
        'metro_stations': len(metro_ids),
        'metro_model_paths': len(metro_path_rows),
        'metro_wait_assumption_seconds': metro_wait_seconds,
        'gtfs_sha256': {name: sha256(gtfs / name) for name in ('calendar.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt')},
        'rail_schedule_sha256': sha256(rail / 'rail_schedule.json'),
        'metro_schema_sha256': sha256(metro_schema),
    }
    db.executemany('INSERT INTO metadata VALUES (?,?)',
                   ((key, json.dumps(value, ensure_ascii=False)) for key, value in report.items()))
    db.commit()
    result = db.execute('PRAGMA integrity_check').fetchone()[0]
    db.close()
    if result != 'ok':
        raise RuntimeError(f'SQLite integrity check failed: {result}')
    temporary.replace(output)
    output.with_suffix('.manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gtfs', type=Path, required=True)
    parser.add_argument('--rail', type=Path, required=True)
    parser.add_argument('--metro-schema', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--scenario-date', type=date.fromisoformat, default=date(2026, 8, 17))
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    args = parser.parse_args()
    print(json.dumps(build(
        args.gtfs,
        args.rail,
        args.metro_schema,
        args.output,
        args.scenario_date,
        args.metro_wait_seconds,
    ),
                     ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
