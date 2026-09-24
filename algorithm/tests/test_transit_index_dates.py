from __future__ import annotations

import csv
import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path

from algorithm.tools.build_local_transit_index import build
from algorithm.tools.reuse_rapid_walk_transfers import reuse


def write_csv(path: Path, fields: list[str], records: list[list[str]]) -> None:
    with path.open('w', encoding='utf-8', newline='') as output:
        writer = csv.writer(output)
        writer.writerow(fields)
        writer.writerows(records)


class TransitIndexDateTests(unittest.TestCase):
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
            write_csv(gtfs / 'routes.txt', ['route_id', 'route_type', 'route_short_name'],
                      [['R1', '3', '10']])
            write_csv(gtfs / 'trips.txt',
                      ['trip_id', 'service_id', 'route_id', 'trip_headsign'],
                      [['T1', 'SUNDAY', 'R1', 'Конечная']])
            write_csv(gtfs / 'stops.txt',
                      ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
                      [['A', 'Начало', '55.7', '37.6'], ['B', 'Конец', '55.71', '37.61']])
            write_csv(gtfs / 'stop_times.txt',
                      ['trip_id', 'stop_sequence', 'stop_id', 'arrival_time',
                       'departure_time', 'pickup_type'],
                      [['T1', '1', 'A', '09:00:00', '09:00:00', '0'],
                       ['T1', '2', 'B', '09:10:00', '09:10:00', '0']])
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
