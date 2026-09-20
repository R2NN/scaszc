from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()
