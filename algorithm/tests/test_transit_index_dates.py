from __future__ import annotations

import csv
import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from algorithm.tools.collect_rail_date import collect
from algorithm.tools.freeze_regular_rail_schedule import main as freeze_rail
from algorithm.tools.build_local_transit_index import build
from algorithm.tools.reuse_rapid_walk_transfers import reuse


def write_csv(path: Path, fields: list[str], records: list[list[str]]) -> None:
    with path.open('w', encoding='utf-8', newline='') as output:
        writer = csv.writer(output)
        writer.writerow(fields)
        writer.writerows(records)


class TransitIndexDateTests(unittest.TestCase):
    def test_saved_rail_station_cannot_be_reused_for_another_date(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'yandex_stations.json').write_text('{}', encoding='utf-8')
            (root / 'rail_station_map.json').write_text('{}', encoding='utf-8')
            (root / 'station_entries').mkdir()
            (root / 'station_entries' / 'x1.json').write_text(json.dumps({
                'source_date': '2026-09-25', 'entries': [],
            }), encoding='utf-8')
            metro = root / 'metro.json'
            metro.write_text(json.dumps({'data': {'stations': []}}), encoding='utf-8')
            args = ['freeze_regular_rail_schedule.py', '--map-only',
                    '--metro-schema', str(metro), '--output', str(root),
                    '--date', '2026-09-26']
            with patch.object(sys, 'argv', args), self.assertRaisesRegex(
                RuntimeError, 'belongs to another date'
            ):
                freeze_rail()

    def test_rail_collector_marks_only_complete_snapshot_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / 'base'
            base.mkdir()
            (base / 'rail_station_map.json').write_text(json.dumps({
                '1': {'yandex_code': 'x1'}, '2': {'yandex_code': 'x2'},
            }), encoding='utf-8')
            (base / 'yandex_stations.json').write_text('{}', encoding='utf-8')
            metro = root / 'metro.json'
            metro.write_text('{}', encoding='utf-8')
            output = root / 'date'

            def partial_run(*_args, **_kwargs):
                (output / 'rail_schedule.json').write_text(json.dumps({
                    'x1': {'entries': [{'departure': '09:00'}]},
                }), encoding='utf-8')
                (output / 'manifest.json').write_text(json.dumps({
                    'source_date': '2026-08-18', 'schedule_scope': 'exact_date',
                }), encoding='utf-8')
                return SimpleNamespace(returncode=0, stderr='', stdout='')

            with patch('algorithm.tools.collect_rail_date.subprocess.run', side_effect=partial_run):
                report = collect(base, metro, output, date(2026, 8, 18), None)
            self.assertEqual(report['status'], 'PARTIAL')
            self.assertFalse(json.loads((output / 'manifest.json').read_text())
                             .get('coverage_complete', False))

            def complete_run(*_args, **_kwargs):
                (output / 'rail_schedule.json').write_text(json.dumps({
                    'x1': {'entries': [{'departure': '09:00'}]},
                    'x2': {'entries': [{'departure': '09:10'}]},
                }), encoding='utf-8')
                return SimpleNamespace(returncode=0, stderr='', stdout='')

            with patch('algorithm.tools.collect_rail_date.subprocess.run', side_effect=complete_run):
                report = collect(base, metro, output, date(2026, 8, 18), None)
            self.assertEqual(report['status'], 'COMPLETE')
            self.assertTrue(json.loads((output / 'manifest.json').read_text())['coverage_complete'])

    def test_exact_date_rail_runs_only_on_its_source_date(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gtfs = root / 'gtfs'
            rail = root / 'rail'
            gtfs.mkdir()
            rail.mkdir()
            write_csv(gtfs / 'calendar.txt',
                      ['service_id', 'start_date', 'end_date', 'monday', 'tuesday',
                       'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
                      [['DAILY', '20260101', '20261231', '1', '1', '1', '1', '1', '1', '1']])
            write_csv(gtfs / 'routes.txt', ['route_id', 'route_type', 'route_short_name'],
                      [['R1', '3', '10']])
            write_csv(gtfs / 'trips.txt',
                      ['trip_id', 'service_id', 'route_id', 'trip_headsign'],
                      [['T1', 'DAILY', 'R1', 'Конечная']])
            write_csv(gtfs / 'stops.txt', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
                      [['A', 'Начало', '55.7', '37.6'], ['B', 'Конец', '55.71', '37.61']])
            write_csv(gtfs / 'stop_times.txt',
                      ['trip_id', 'stop_sequence', 'stop_id', 'arrival_time',
                       'departure_time', 'pickup_type'],
                      [['T1', '1', 'A', '09:00:00', '09:00:00', '0'],
                       ['T1', '2', 'B', '09:10:00', '09:10:00', '0']])
            (rail / 'manifest.json').write_text(json.dumps({
                'source_date': '2026-08-18', 'schedule_scope': 'exact_date',
            }), encoding='utf-8')
            (rail / 'rail_station_map.json').write_text(json.dumps({
                '1': {'metro_id': 1, 'yandex_code': 'x1', 'name': 'Станция 1', 'kind': 'mcc'},
                '2': {'metro_id': 2, 'yandex_code': 'x2', 'name': 'Станция 2', 'kind': 'mcc'},
            }), encoding='utf-8')
            rail_entries = {
                code: {'entries': [{'arrival': f'2026-08-18T09:{minute}:00+03:00',
                                    'departure': f'2026-08-18T09:{minute}:00+03:00',
                                    'thread': {'uid': 'train1', 'number': '1'}}]}
                for code, minute in [('x1', '00'), ('x2', '10')]
            }
            (rail / 'rail_schedule.json').write_text(json.dumps(rail_entries), encoding='utf-8')
            metro = root / 'metro.json'
            metro.write_text(json.dumps({'data': {
                'stations': [
                    {'id': 1, 'name': {'ru': 'Станция 1'}, 'location': {'lat': 55.7, 'lon': 37.6}, 'mcc': True},
                    {'id': 2, 'name': {'ru': 'Станция 2'}, 'location': {'lat': 55.71, 'lon': 37.61}, 'mcc': True},
                ], 'transitions': [], 'connections': [],
            }}), encoding='utf-8')
            tuesday = build(gtfs, rail, metro, root / 'tuesday.sqlite', date(2026, 8, 18))
            self.assertTrue(tuesday['rail_schedule_available'])
            self.assertEqual(tuesday['rail_schedule_scope'], 'exact_date')
            self.assertEqual(tuesday['rail_connections'], 1)
            wednesday = build(gtfs, rail, metro, root / 'wednesday.sqlite', date(2026, 8, 19))
            self.assertFalse(wednesday['rail_schedule_available'])
            self.assertEqual(wednesday['rail_connections'], 0)
            next_tuesday = build(gtfs, rail, metro, root / 'next-tuesday.sqlite',
                                 date(2026, 8, 25), rail_weekday_reference=True)
            self.assertTrue(next_tuesday['rail_schedule_available'])
            self.assertEqual(next_tuesday['rail_schedule_scope'], 'weekday_reference')
            self.assertEqual(next_tuesday['rail_connections'], 1)

    def test_sunday_uses_sunday_gtfs_and_omits_monday_rail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gtfs = root / 'gtfs'
            rail = root / 'rail'
            gtfs.mkdir()
            rail.mkdir()
            write_csv(gtfs / 'calendar.txt',
                      ['service_id', 'start_date', 'end_date', 'monday', 'tuesday',
                       'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
                      [['SUNDAY', '20260101', '20261231', '0', '0', '0', '0', '0', '0', '1']])
            write_csv(gtfs / 'calendar_dates.txt', ['service_id', 'date', 'exception_type'],
                      [['SUNDAY', '20260816', '2'], ['SPECIAL', '20260816', '1']])
            write_csv(gtfs / 'routes.txt', ['route_id', 'route_type', 'route_short_name'],
                      [['R1', '3', '10']])
            write_csv(gtfs / 'trips.txt',
                      ['trip_id', 'service_id', 'route_id', 'trip_headsign'],
                      [['T1', 'SUNDAY', 'R1', 'Конечная'],
                       ['T2', 'SPECIAL', 'R1', 'Конечная']])
            write_csv(gtfs / 'stops.txt',
                      ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
                      [['A', 'Начало', '55.7', '37.6'], ['B', 'Конец', '55.71', '37.61']])
            write_csv(gtfs / 'stop_times.txt',
                      ['trip_id', 'stop_sequence', 'stop_id', 'arrival_time',
                       'departure_time', 'pickup_type'],
                      [['T1', '1', 'A', '09:00:00', '09:00:00', '0'],
                       ['T1', '2', 'B', '09:10:00', '09:10:00', '0'],
                       ['T2', '1', 'A', '10:00:00', '10:00:00', '0'],
                       ['T2', '2', 'B', '10:10:00', '10:10:00', '0']])
            (rail / 'manifest.json').write_text(json.dumps({
                'normal_weekday_reference_date': '2026-09-21',
            }), encoding='utf-8')
            (rail / 'rail_station_map.json').write_text('{}', encoding='utf-8')
            (rail / 'rail_schedule.json').write_text('{}', encoding='utf-8')
            metro = root / 'metro.json'
            metro.write_text(json.dumps({'data': {
                'stations': [], 'transitions': [], 'connections': [],
            }}), encoding='utf-8')
            output = root / 'sunday.sqlite'
            report = build(gtfs, rail, metro, output, date(2026, 8, 16))
            self.assertEqual(report['scenario_date'], '2026-08-16')
            self.assertFalse(report['rail_schedule_available'])
            self.assertIsNone(report['rail_reference_date'])
            self.assertEqual(report['surface_connections'], 1)
            self.assertEqual(report['rail_connections'], 0)
            database = sqlite3.connect(output)
            try:
                self.assertEqual(database.execute('SELECT COUNT(*) FROM connections').fetchone()[0], 1)
                self.assertEqual(database.execute('SELECT trip_id FROM connections').fetchone()[0], 'g:T2')
            finally:
                database.close()
            missing = root / 'outside.sqlite'
            with self.assertRaisesRegex(ValueError, 'нет действующих рейсов'):
                build(gtfs, rail, metro, missing, date(2040, 8, 16))
            self.assertFalse(missing.with_suffix('.tmp.sqlite').exists())

    def test_static_station_walks_are_reused_only_with_matching_coordinates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.sqlite'
            destination = root / 'destination.sqlite'
            for file in (source, destination):
                database = sqlite3.connect(file)
                try:
                    database.executescript('''
                        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
                        CREATE TABLE stops(id TEXT PRIMARY KEY, lat REAL, lon REAL, kind TEXT);
                    ''')
                    database.executemany('INSERT INTO metadata VALUES (?,?)', [
                        ('gtfs_sha256', json.dumps({'calendar.txt': 'same'})),
                        ('metro_schema_sha256', json.dumps('same')),
                    ])
                    database.executemany('INSERT INTO stops VALUES (?,?,?,?)', [
                        ('m:1', 55.7, 37.6, 'metro'), ('g:a', 55.7001, 37.6001, 'surface'),
                    ])
                    if file == source:
                        database.execute('CREATE TABLE walk_transfers(from_id TEXT, to_id TEXT, seconds INTEGER, distance_m INTEGER)')
                        database.execute('INSERT INTO walk_transfers VALUES (?,?,?,?)', ('m:1', 'g:a', 30, 40))
                    database.commit()
                finally:
                    database.close()
            report = reuse(source, destination)
            self.assertEqual(report['reused_walk_arcs'], 1)
            database = sqlite3.connect(destination)
            try:
                self.assertEqual(database.execute('SELECT seconds FROM walk_transfers').fetchone()[0], 30)
                database.execute("UPDATE stops SET lat=56 WHERE id='m:1'")
                database.commit()
            finally:
                database.close()
            with self.assertRaisesRegex(ValueError, 'координаты изменились'):
                reuse(source, destination)


if __name__ == '__main__':
    unittest.main()
