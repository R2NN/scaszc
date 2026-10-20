from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime
from pathlib import Path

from beeline_routing.local_transit import LocalTransitRoutingClient
from beeline_routing.models import (
    Coordinate,
    DetailedRoute,
    Provenance,
    RouteStatus,
    RouteStep,
    TransportMode,
)


class FakeWalkingClient:
    def route(self, *, origin: Coordinate, destination: Coordinate,
              mode: TransportMode, departure_at: datetime,
              refresh: bool = False) -> DetailedRoute:
        duration = 10 if origin.location_id.startswith(('g:', 'm:')) or destination.location_id.startswith(('g:', 'm:')) else 1000
        geometry = ((origin.latitude, origin.longitude),
                    (destination.latitude, destination.longitude))
        step = RouteStep(0, 'pedestrian', duration, duration, 0, geometry, {})
        provenance = Provenance('TEST_WALK', 'local', 'a', 'b',
                                '2026-08-17T00:00:00+00:00', True, {})
        return DetailedRoute(origin.location_id, destination.location_id,
                             mode, departure_at, RouteStatus.OK, duration, 1,
                             duration, geometry, (step,), 'OK', provenance)


class LocalTransitMixedModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.clients: list[LocalTransitRoutingClient] = []
        self.database = Path(self.temporary.name) / 'network.sqlite'
        # This tiny synthetic index has no official station mapping. Never
        # attach an unrelated runtime Moscow graph merely because it is installed.
        schema_patch=patch.object(LocalTransitRoutingClient,'_schema_path',return_value=Path(self.temporary.name)/'missing-schema.json')
        schema_patch.start()
        self.addCleanup(schema_patch.stop)
        db = sqlite3.connect(self.database)
        db.executescript('''
            CREATE TABLE stops(id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, kind TEXT);
            CREATE TABLE trips(id TEXT PRIMARY KEY, line TEXT, headsign TEXT, kind TEXT);
            CREATE TABLE connections(id INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT,
                                     dep INTEGER, arr INTEGER, trip_id TEXT, source TEXT);
            CREATE TABLE transfers(from_id TEXT, to_id TEXT, seconds INTEGER, source TEXT);
            CREATE TABLE walk_transfers(from_id TEXT, to_id TEXT, seconds INTEGER,
                                        distance_m INTEGER);
            CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE network_station_ids(metro_id INTEGER PRIMARY KEY, stop_id TEXT);
            CREATE TABLE metro_paths(from_id TEXT, to_id TEXT, seconds INTEGER,
                                     path_json TEXT);
        ''')
        db.executemany('INSERT INTO stops VALUES (?,?,?,?,?)', [
            ('g:a', 'Bus A', 55.7000, 37.6000, 'surface'),
            ('m:1', 'Metro A', 55.7001, 37.6001, 'metro'),
            ('m:2', 'Metro B', 55.7300, 37.6300, 'metro'),
            ('g:b', 'Bus B', 55.7301, 37.6301, 'surface'),
        ])
        db.executemany('INSERT INTO walk_transfers VALUES (?,?,?,?)', [
            ('g:a', 'm:1', 20, 30),
            ('m:2', 'g:b', 20, 30),
        ])
        path = json.dumps([{
            'from_id': 'm:1', 'to_id': 'm:2', 'kind': 'metro',
            'seconds': 180, 'wait_seconds': 60, 'line_id': 1,
        }])
        db.execute('INSERT INTO metro_paths VALUES (?,?,?,?)', ('m:1', 'm:2', 240, path))
        db.executemany('INSERT INTO metadata VALUES (?,?)', [
            ('scenario_date', json.dumps('2026-08-17')),
            ('rail_reference_date', json.dumps('2026-09-21')),
        ])
        db.commit()
        db.close()

    def tearDown(self) -> None:
        for client in self.clients:
            client.close()
        self.temporary.cleanup()

    def test_surface_to_metro_to_surface_path_is_reconstructed(self) -> None:
        client = LocalTransitRoutingClient(self.database, FakeWalkingClient())  # type: ignore[arg-type]
        self.clients.append(client)
        route = client.route(
            origin=Coordinate('origin', 55.7000, 37.6000),
            destination=Coordinate('destination', 55.7301, 37.6301),
            mode=TransportMode.PUBLIC_TRANSIT,
            departure_at=datetime.fromisoformat('2026-08-17T09:00:00+03:00'),
        )
        self.assertEqual(route.status, RouteStatus.OK)
        self.assertEqual(route.provider_status, 'MIXED_TIMETABLE_METRO_MODEL')
        self.assertIn('metro', [step.mode for step in route.itinerary])
        self.assertIn('metro_wait_model', [step.mode for step in route.itinerary])
        self.assertEqual(sum(step.duration_seconds for step in route.itinerary),
                         route.duration_seconds)
        self.assertTrue(route.provenance.provider_metadata['metro_ride_included'])

    def test_wrong_scenario_date_is_unknown(self) -> None:
        client = LocalTransitRoutingClient(self.database, FakeWalkingClient())  # type: ignore[arg-type]
        self.clients.append(client)
        route = client.route(
            origin=Coordinate('origin', 55.7000, 37.6000),
            destination=Coordinate('destination', 55.7301, 37.6301),
            mode=TransportMode.PUBLIC_TRANSIT,
            departure_at=datetime.fromisoformat('2026-08-18T09:00:00+03:00'),
        )
        self.assertEqual(route.status, RouteStatus.UNKNOWN)
        self.assertIsNone(route.duration_seconds)

    def test_no_rail_reference_is_labelled_without_rail_claim(self) -> None:
        db = sqlite3.connect(self.database)
        try:
            db.execute('INSERT INTO metadata VALUES (?,?)', ('rail_schedule_available', json.dumps(False)))
            db.commit()
        finally:
            db.close()
        client = LocalTransitRoutingClient(self.database, FakeWalkingClient())  # type: ignore[arg-type]
        self.clients.append(client)
        route = client.route(
            origin=Coordinate('origin', 55.7000, 37.6000),
            destination=Coordinate('destination', 55.7301, 37.6301),
            mode=TransportMode.PUBLIC_TRANSIT,
            departure_at=datetime.fromisoformat('2026-08-17T09:00:00+03:00'),
        )
        self.assertEqual(route.status, RouteStatus.OK)
        self.assertEqual(route.provenance.provider, 'LOCAL_GTFS_VALHALLA')
        self.assertIsNone(route.provenance.provider_metadata['rail_schedule_applied_to_date'])

    def test_runtime_schema_supplies_platform_times_and_metro_reference(self) -> None:
        schema = Path(self.temporary.name) / 'portable-schema.json'
        schema.write_text(json.dumps({'data': {
            'stations': [{'id': 1, 'lineId': 1, 'enterTime': 80, 'exitTime': 45}],
            'connections': [], 'transitions': [],
        }}), encoding='utf-8')
        with sqlite3.connect(self.database) as db:
            db.execute('INSERT INTO network_station_ids VALUES (?,?)', (1, 'm:1'))
        with patch.object(LocalTransitRoutingClient, '_schema_path', return_value=schema):
            client = LocalTransitRoutingClient(self.database, FakeWalkingClient())
        self.clients.append(client)
        self.assertEqual(client.station_access['m:1'], (80, 45))
        self.assertIsNotNone(client.metro_reference)
        self.assertIs(client.transport_graph, client.metro_reference)

    def test_known_walk_bounds_scan_without_losing_faster_bus(self) -> None:
        with sqlite3.connect(self.database) as db:
            db.execute('INSERT INTO trips VALUES (?,?,?,?)', ('early', '1', 'B', 'bus'))
            db.execute('INSERT INTO trips VALUES (?,?,?,?)', ('late', '2', 'B', 'bus'))
            db.execute('INSERT INTO connections VALUES (?,?,?,?,?,?,?)',
                       (1, 'g:a', 'g:b', 9 * 3600 + 30, 9 * 3600 + 90, 'early', 'GTFS'))
            db.execute('INSERT INTO connections VALUES (?,?,?,?,?,?,?)',
                       (2, 'g:a', 'g:b', 14 * 3600, 14 * 3600 + 60, 'late', 'GTFS'))
        client = LocalTransitRoutingClient(self.database, FakeWalkingClient())
        self.clients.append(client)
        statements = []
        client.db.set_trace_callback(statements.append)
        route = client.route(
            origin=Coordinate('origin', 55.7000, 37.6000),
            destination=Coordinate('destination', 55.7301, 37.6301),
            mode=TransportMode.PUBLIC_TRANSIT,
            departure_at=datetime.fromisoformat('2026-08-17T09:00:00+03:00'),
        )
        self.assertEqual(route.status, RouteStatus.OK)
        self.assertEqual(route.duration_seconds, 90)
        self.assertIn('bus', [step.mode for step in route.itinerary])
        scan = next(statement for statement in statements if 'FROM connections WHERE dep' in statement)
        self.assertIn('dep <= 33400', scan)

    def test_no_incumbent_keeps_arrivals_after_departure_horizon(self) -> None:
        with sqlite3.connect(self.database) as db:
            db.execute('INSERT INTO trips VALUES (?,?,?,?)', ('late', '1', 'B', 'bus'))
            db.execute('INSERT INTO connections VALUES (?,?,?,?,?,?,?)',
                       (1, 'g:a', 'g:b', 14 * 3600 + 50 * 60,
                        15 * 3600 + 10 * 60, 'late', 'GTFS'))
            db.execute('DELETE FROM metro_paths')
        client = LocalTransitRoutingClient(self.database, FakeWalkingClient())
        self.clients.append(client)
        with patch.object(client, '_direct_walk_option', return_value=None):
            route = client.route(
                origin=Coordinate('origin', 55.7000, 37.6000),
                destination=Coordinate('destination', 55.7301, 37.6301),
                mode=TransportMode.PUBLIC_TRANSIT,
                departure_at=datetime.fromisoformat('2026-08-17T09:00:00+03:00'),
            )
        self.assertEqual(route.status, RouteStatus.OK)
        self.assertEqual(route.duration_seconds, 6 * 3600 + 10 * 60)


if __name__ == '__main__':
    unittest.main()
