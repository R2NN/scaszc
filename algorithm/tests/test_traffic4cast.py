from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import h5py
import numpy as np

from beeline_routing.errors import RoutingIncomplete
from beeline_routing.models import DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode
from beeline_routing.models import Coordinate
from beeline_routing.traffic4cast import Traffic4castProfile
from beeline_routing.valhalla import DEFAULT_TRAFFIC_PROFILE, ValhallaRoutingClient

sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))
import build_traffic4cast_profile as builder


class Traffic4castProfileTests(unittest.TestCase):
    def test_default_profile_points_to_repository_data(self) -> None:
        self.assertEqual(DEFAULT_TRAFFIC_PROFILE, Path(__file__).parents[2] / 'data' / 'traffic4cast' / 'moscow-2019.json')

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.profile = Path(self.temporary.name) / 'moscow-2019.json'
        # A tiny measured-profile fixture; production data is never synthesized.
        values = bytearray(7 * 24 * 2 * 2 * 4)
        values[(((0 * 24 + 9) * 2 + 0) * 2 + 0) * 4 + 0] = 128
        values[(((0 * 24 + 10) * 2 + 0) * 2 + 0) * 4 + 0] = 255
        self.profile.with_suffix('.bin').write_bytes(values)
        self.profile.write_text(json.dumps({
            'format': 'traffic4cast-2021-hourly-v1',
            'bounds': {'north': 56, 'south': 55, 'west': 37, 'east': 38},
            'height': 2, 'width': 2, 'source_days': 10, 'source_year': 2019,
            'rotated': False,
            'sha256': hashlib.sha256(values).hexdigest(),
        }), encoding='utf-8')
        self.traffic = Traffic4castProfile(self.profile)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_hour_and_direction_change_route_time(self) -> None:
        moscow = timezone(timedelta(hours=3))
        departure = datetime(2026, 9, 21, 9, tzinfo=moscow)
        start = (55.75, 37.2)
        end = (55.76, 37.21)
        slow = self.traffic.factor(start, end, departure)
        clear = self.traffic.factor(start, end, departure + timedelta(hours=1))
        self.assertGreater(slow, 1.9)
        self.assertEqual(clear, 1)
        self.assertIsNone(self.traffic.factor(end, start, departure))

    def test_adjust_changes_actual_oracle_duration_and_preserves_source(self) -> None:
        departure = datetime(2026, 9, 21, 9, tzinfo=timezone(timedelta(hours=3)))
        points = ((55.75, 37.2), (55.76, 37.21))
        source = Provenance('LOCAL_VALHALLA', 'http://local', 'a' * 64, 'b' * 64,
                            '2026-09-21T00:00:00Z', False, {})
        route = DetailedRoute('A', 'B', TransportMode.CAR, departure,
                              RouteStatus.OK, 120, 2, 1500, points,
                              (RouteStep(0, 'auto', 120, 1500, 0, points, {}),),
                              'OK', source)
        adjusted = self.traffic.adjust(route)
        self.assertGreater(adjusted.duration_seconds, 230)
        self.assertEqual(adjusted.provenance.provider_metadata['traffic_source_days'], 10)
        self.assertEqual(adjusted.distance_m, route.distance_m)

    def test_profile_checksum_is_enforced(self) -> None:
        self.profile.with_suffix('.bin').write_bytes(b'corrupt')
        with self.assertRaises(RoutingIncomplete):
            Traffic4castProfile(self.profile)

    def test_valhalla_car_client_uses_measured_profile(self) -> None:
        departure = datetime(2026, 9, 21, 9, tzinfo=timezone(timedelta(hours=3)))
        points = ((55.75, 37.2), (55.76, 37.21))
        source = Provenance('LOCAL_VALHALLA', 'http://local', 'a' * 64, 'b' * 64,
                            '2026-09-21T00:00:00Z', False, {})
        route = DetailedRoute('A', 'B', TransportMode.CAR, departure,
                              RouteStatus.OK, 120, 2, 1500, points,
                              (RouteStep(0, 'auto', 120, 1500, 0, points, {}),),
                              'OK', source)
        sent: list[dict[str, object]] = []

        def post_json(**kwargs: object) -> object:
            sent.append(kwargs['json_body'])  # type: ignore[arg-type]
            return SimpleNamespace(payload={})

        with patch.dict('os.environ', {'TRAFFIC4CAST_PROFILE': str(self.profile)}):
            client = ValhallaRoutingClient(SimpleNamespace(post_json=post_json))  # type: ignore[arg-type]
        with patch.object(client, '_parse', return_value=route):
            adjusted = client.route(
                origin=Coordinate('A', *points[0]),
                destination=Coordinate('B', *points[1]),
                mode=TransportMode.CAR, departure_at=departure,
            )
        self.assertGreater(adjusted.duration_seconds, route.duration_seconds)
        self.assertEqual(sent[0]['date_time'], {'type': 1, 'value': '2026-09-21T09:00'})

    def test_car_routing_rejects_missing_profile(self) -> None:
        missing = Path(self.temporary.name) / 'missing.json'
        with (patch('beeline_routing.valhalla.DEFAULT_TRAFFIC_PROFILE', missing),
              patch.dict('os.environ', {'TRAFFIC4CAST_PROFILE': ''})):
            client = ValhallaRoutingClient(SimpleNamespace())  # type: ignore[arg-type]
            with self.assertRaises(RoutingIncomplete):
                client.route(
                    origin=Coordinate('A', 55.75, 37.2),
                    destination=Coordinate('B', 55.76, 37.21),
                    mode=TransportMode.CAR,
                    departure_at=datetime(2026, 9, 21, 9,
                                          tzinfo=timezone(timedelta(hours=3))),
                )


class Traffic4castImporterTests(unittest.TestCase):
    def test_official_hdf5_channel_order_and_hourly_profile(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'training'
            source.mkdir()
            path = source / '2019-01-07_MOSCOW_8ch.h5'
            frames = np.zeros((1, 288, 6, 6, 8), dtype=np.uint8)
            frames[..., 0] = 10
            frames[..., 1] = 100
            frames[:, 10 * 12:, ..., 1] = 200
            with h5py.File(path, 'w') as handle:
                handle.create_dataset('array', data=frames)
            with (patch.object(builder, 'HEIGHT', 6), patch.object(builder, 'WIDTH', 6),
                  patch.object(builder, 'PROFILE_HEIGHT', 2), patch.object(builder, 'PROFILE_WIDTH', 2)):
                metadata = builder.build_profile(source, Path(folder) / 'profile', 2019)
            self.assertEqual(metadata['source_days'], 1)
            encoded = (Path(folder) / 'profile.bin').read_bytes()
            hour_9 = (((0 * 24 + 9) * 2 + 0) * 2 + 0) * 4
            hour_10 = (((0 * 24 + 10) * 2 + 0) * 2 + 0) * 4
            self.assertLess(encoded[hour_9], encoded[hour_10])
            self.assertEqual(encoded[hour_10], 255)


if __name__ == '__main__':
    unittest.main()
