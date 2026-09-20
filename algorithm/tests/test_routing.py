from __future__ import annotations

import json
import math
import os
import sqlite3
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from beeline_routing.cache import RoutingCache
from beeline_routing.dataset import load_dataset_locations
from beeline_routing.errors import (
    CacheFrozen,
    InvalidRoutingInput,
    ProviderAccessSuspended,
    ProviderResponseError,
    RoutingIncomplete,
    UsageBudgetExceeded,
)
from beeline_routing.http import JsonHttpClient
from beeline_routing.here import HereTransitRoutingClient, _decode_flexible_polyline
from beeline_routing.dgis import DgisRoutingClient
from beeline_routing.hybrid import HybridRoutingClient
from beeline_routing.mapbox import MapboxRoutingClient
from beeline_routing.matrix import build_matrix, ensure_matrix_complete
from beeline_routing.models import (
    Coordinate,
    MatrixCell,
    Provenance,
    RouteStatus,
    TransportMode,
)
from beeline_routing.oracle import ExactRoutingOracle, OracleQuery
from beeline_routing.yandex import (
    MATRIX_ENDPOINT,
    PROVIDER,
    YandexRoutingClient,
)
from beeline_routing.valhalla import ValhallaRoutingClient, _decode_polyline6
from beeline_routing.valhalla_hybrid import Valhalla2GisRoutingClient
from beeline_routing.valhalla_here import ValhallaHereRoutingClient


class MemoryResponse:
    def __init__(self, payload: Any, status: int = 200) -> None:
        self.status = status
        self._raw = json.dumps(payload).encode('utf-8')

    def __enter__(self) -> MemoryResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, size: int = -1) -> bytes:
        return self._raw if size < 0 else self._raw[:size]


class SequencedOpener:
    def __init__(self, payloads: list[Any]) -> None:
        self.payloads = list(payloads)
        self.urls: list[str] = []
        self.requests: list[Any] = []

    def __call__(self, request: Any, *, timeout: float) -> MemoryResponse:
        self.urls.append(request.full_url)
        self.requests.append(request)
        if not self.payloads:
            raise AssertionError('Unexpected network request')
        return MemoryResponse(self.payloads.pop(0))


def provenance() -> Provenance:
    return Provenance(
        provider='TEST',
        endpoint='https://example.invalid',
        request_sha256='a' * 64,
        response_sha256='b' * 64,
        fetched_at='2026-09-15T00:00:00+00:00',
        cache_hit=False,
        provider_metadata={},
    )


class ModelTests(unittest.TestCase):
    def test_coordinate_rejects_nan_and_zero_zero(self) -> None:
        with self.assertRaises(InvalidRoutingInput):
            Coordinate('bad', math.nan, 37.6)
        with self.assertRaises(InvalidRoutingInput):
            Coordinate('bad', 0, 0)

    def test_coordinate_serialization_does_not_round_to_seven_decimals(self) -> None:
        point = Coordinate('precise', 55.1234567890123, 37.9876543210987)
        self.assertEqual(point.as_provider_value(), '55.1234567890123,37.9876543210987')

    def test_unknown_cell_cannot_carry_fake_numbers(self) -> None:
        with self.assertRaises(InvalidRoutingInput):
            MatrixCell(
                origin_id='A',
                destination_id='B',
                mode=TransportMode.CAR,
                departure_at=datetime.now(UTC),
                status=RouteStatus.UNKNOWN,
                duration_seconds=1,
                duration_minutes=1,
                distance_m=1,
                provider_status='FAIL',
                provenance=provenance(),
            )


class ValhallaParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = RoutingCache(Path(self.temporary.name) / 'routing.sqlite3')
        self.origin = Coordinate('A', 55.75, 37.61)
        self.destination = Coordinate('B', 55.76, 37.62)
        self.departure = datetime(2026, 8, 17, 10, tzinfo=UTC)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_precision_six_polyline_decoder(self) -> None:
        self.assertEqual(_decode_polyline6('??AA'), ((0.0, 0.0), (0.000001, 0.000001)))

    def test_local_route_is_parsed_and_cached_without_secrets(self) -> None:
        opener = SequencedOpener([{
            'trip': {
                'summary': {'time': 90.1, 'length': 1.234},
                'legs': [{'shape': '??AA', 'maneuvers': [{
                    'begin_shape_index': 0, 'end_shape_index': 1, 'time': 90.1,
                    'length': 1.234, 'instruction': 'Walk', 'type': 1,
                }]}],
            },
        }])
        client = ValhallaRoutingClient(JsonHttpClient(cache=self.cache, opener=opener))
        route = client.route(
            origin=self.origin, destination=self.destination, mode=TransportMode.WALKING,
            departure_at=self.departure,
        )
        self.assertEqual(route.status, RouteStatus.OK)
        self.assertEqual((route.duration_seconds, route.duration_minutes, route.distance_m), (91, 2, 1234))
        self.assertEqual(route.geometry, ((0.0, 0.0), (0.000001, 0.000001)))
        self.assertIn('"costing":"pedestrian"', opener.requests[0].data.decode('utf-8'))

    def test_local_valhalla_error_is_an_actual_unreachable_route(self) -> None:
        opener = SequencedOpener([{'error': 'No pedestrian path'}])
        client = ValhallaRoutingClient(JsonHttpClient(cache=self.cache, opener=opener))
        route = client.route(
            origin=self.origin,
            destination=self.destination,
            mode=TransportMode.WALKING,
            departure_at=self.departure,
        )
        self.assertEqual(route.status, RouteStatus.UNREACHABLE)
        self.assertEqual(route.provider_status, 'No pedestrian path')

    def test_valhalla_hybrid_sends_only_public_transit_to_2gis(self) -> None:
        class Recorder:
            def __init__(self) -> None:
                self.calls: list[TransportMode] = []

            def route(self, **kwargs: Any) -> Any:
                self.calls.append(kwargs['mode'])
                return 'route'

        dgis, valhalla = Recorder(), Recorder()
        client = Valhalla2GisRoutingClient(dgis=dgis, valhalla=valhalla)  # type: ignore[arg-type]
        client.route(origin=self.origin, destination=self.destination, mode=TransportMode.PUBLIC_TRANSIT, departure_at=self.departure)
        client.route(origin=self.origin, destination=self.destination, mode=TransportMode.CAR, departure_at=self.departure)
        client.route(origin=self.origin, destination=self.destination, mode=TransportMode.BICYCLE, departure_at=self.departure)
        self.assertEqual(dgis.calls, [TransportMode.PUBLIC_TRANSIT, TransportMode.CAR])
        self.assertEqual(valhalla.calls, [TransportMode.BICYCLE])


class HereTransitParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = RoutingCache(Path(self.temporary.name) / 'routing.sqlite3')
        self.origin = Coordinate('A', 55.75, 37.61)
        self.destination = Coordinate('B', 55.76, 37.62)
        self.departure = datetime.fromisoformat('2026-09-21T10:00:00+03:00')

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_flexible_polyline_decoder_matches_here_reference(self) -> None:
        self.assertEqual(
            _decode_flexible_polyline('BFoz5xJ67i1B1B7PzIhaxL7Y'),
            (
                (50.10228, 8.69821),
                (50.10201, 8.69567),
                (50.10063, 8.6915),
                (50.09878, 8.68752),
            ),
        )

    def test_route_includes_timetable_waiting_sections_and_hides_key_from_cache(self) -> None:
        polyline = 'BFoz5xJ67i1B1B7PzIhaxL7Y'
        opener = SequencedOpener([{
            'routes': [{
                'id': 'route-1',
                'sections': [
                    {
                        'type': 'pedestrian',
                        'departure': {'time': '2026-09-21T10:00:00+03:00'},
                        'arrival': {'time': '2026-09-21T10:05:00+03:00'},
                        'travelSummary': {'duration': 300, 'length': 300},
                        'polyline': polyline,
                        'transport': {'mode': 'pedestrian'},
                    },
                    {
                        'type': 'transit',
                        'departure': {'time': '2026-09-21T10:07:00+03:00'},
                        'arrival': {'time': '2026-09-21T10:20:00+03:00'},
                        'travelSummary': {'duration': 780, 'length': 5000},
                        'polyline': polyline,
                        'transport': {'mode': 'subway', 'name': '3'},
                        'agency': {'name': 'Московский метрополитен'},
                    },
                ],
            }],
        }])
        route = HereTransitRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener),
            api_key='HERE-SECRET',
        ).route(
            origin=self.origin,
            destination=self.destination,
            mode=TransportMode.PUBLIC_TRANSIT,
            departure_at=self.departure,
        )
        self.assertEqual(route.status, RouteStatus.OK)
        self.assertEqual(
            (route.duration_seconds, route.duration_minutes, route.distance_m),
            (1200, 20, 5300),
        )
        self.assertEqual(route.itinerary[1].waiting_seconds, 120)
        self.assertEqual(route.itinerary[1].mode, 'subway')
        self.assertIn('apiKey=HERE-SECRET', opener.urls[0])
        database_bytes = (Path(self.temporary.name) / 'routing.sqlite3').read_bytes()
        self.assertNotIn(b'HERE-SECRET', database_bytes)

    def test_hybrid_sends_only_public_transit_to_here(self) -> None:
        class Recorder:
            def __init__(self) -> None:
                self.calls: list[TransportMode] = []

            def route(self, **kwargs: Any) -> Any:
                self.calls.append(kwargs['mode'])
                return 'route'

        here, valhalla = Recorder(), Recorder()
        client = ValhallaHereRoutingClient(
            here=here, valhalla=valhalla  # type: ignore[arg-type]
        )
        for mode in TransportMode:
            client.route(
                origin=self.origin,
                destination=self.destination,
                mode=mode,
                departure_at=self.departure,
            )
        self.assertEqual(here.calls, [TransportMode.PUBLIC_TRANSIT])
        self.assertEqual(
            valhalla.calls,
            [TransportMode.CAR, TransportMode.BICYCLE, TransportMode.WALKING],
        )


class CacheAndHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cache_path = Path(self.temporary.name) / 'routing.sqlite3'
        self.cache = RoutingCache(self.cache_path)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_secret_is_neither_cache_key_nor_persisted_data(self) -> None:
        opener = SequencedOpener([{'value': 1}])
        client = JsonHttpClient(cache=self.cache, opener=opener)
        first = client.get_json(
            provider='P',
            endpoint='https://example.invalid/api',
            public_parameters={'mode': 'walking'},
            secret_parameters={'apikey': 'TOP-SECRET'},
        )
        second = client.get_json(
            provider='P',
            endpoint='https://example.invalid/api',
            public_parameters={'mode': 'walking'},
            secret_parameters={'apikey': 'DIFFERENT-SECRET'},
        )
        self.assertFalse(first.cache_hit)
        self.assertTrue(second.cache_hit)
        self.assertEqual(len(opener.urls), 1)
        self.assertIn('TOP-SECRET', opener.urls[0])
        self.assertNotIn(b'TOP-SECRET', self.cache_path.read_bytes())
        self.assertNotIn(b'DIFFERENT-SECRET', self.cache_path.read_bytes())

    def test_refresh_replaces_existing_response(self) -> None:
        opener = SequencedOpener([{'value': 1}, {'value': 2}])
        client = JsonHttpClient(cache=self.cache, opener=opener)
        arguments = {
            'provider': 'P',
            'endpoint': 'https://example.invalid/api',
            'public_parameters': {'x': 1},
            'secret_parameters': {},
        }
        first = client.get_json(**arguments)
        refreshed = client.get_json(**arguments, refresh=True)
        cached = client.get_json(**arguments)
        self.assertEqual(first.payload, {'value': 1})
        self.assertEqual(refreshed.payload, {'value': 2})
        self.assertEqual(cached.payload, {'value': 2})
        self.assertTrue(cached.cache_hit)

    def test_business_error_is_rejected_before_cache(self) -> None:
        opener = SequencedOpener([{'errors': ['invalid request']}])
        client = JsonHttpClient(cache=self.cache, opener=opener)

        def validate(payload: dict[str, Any], request_sha256: str) -> None:
            if payload.get('errors'):
                raise ProviderResponseError(request_sha256)

        with self.assertRaises(ProviderResponseError):
            client.get_json(
                provider='P',
                endpoint='https://example.invalid/api',
                public_parameters={'x': 1},
                secret_parameters={},
                validate_payload=validate,
            )
        connection = sqlite3.connect(self.cache_path)
        try:
            count = connection.execute('SELECT COUNT(*) FROM api_responses').fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(count, 0)

    def test_non_standard_json_number_is_rejected(self) -> None:
        class NonStandardResponse(MemoryResponse):
            def __init__(self) -> None:
                self.status = 200
                self._raw = b'{"value": NaN}'

        with self.assertRaises(ProviderResponseError):
            JsonHttpClient(
                cache=self.cache,
                opener=lambda *_args, **_kwargs: NonStandardResponse(),
            ).get_json(
                provider='P',
                endpoint='https://example.invalid/api',
                public_parameters={'x': 1},
                secret_parameters={},
            )

    def test_oversized_response_is_rejected(self) -> None:
        opener = SequencedOpener([{'value': 'too large'}])
        with self.assertRaises(ProviderResponseError):
            JsonHttpClient(cache=self.cache, opener=opener, max_response_bytes=4).get_json(
                provider='P',
                endpoint='https://example.invalid/api',
                public_parameters={'x': 1},
                secret_parameters={},
            )

    def test_secret_echo_is_rejected_before_cache(self) -> None:
        opener = SequencedOpener([{'debug': 'TOP-SECRET'}])
        with self.assertRaises(ProviderResponseError):
            JsonHttpClient(cache=self.cache, opener=opener).get_json(
                provider='P',
                endpoint='https://example.invalid/api',
                public_parameters={'x': 1},
                secret_parameters={'apikey': 'TOP-SECRET'},
            )
        connection = sqlite3.connect(self.cache_path)
        try:
            count = connection.execute('SELECT COUNT(*) FROM api_responses').fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(count, 0)

    def test_sensitive_parameter_cannot_be_declared_public(self) -> None:
        with self.assertRaises(InvalidRoutingInput):
            JsonHttpClient(cache=self.cache).get_json(
                provider='P',
                endpoint='https://example.invalid/api',
                public_parameters={'apikey': 'TOP-SECRET'},
                secret_parameters={},
            )

    def test_frozen_snapshot_is_immutable_and_verifiable(self) -> None:
        opener = SequencedOpener([{'value': 1}, {'value': 2}])
        client = JsonHttpClient(cache=self.cache, opener=opener)
        arguments = {
            'provider': 'P',
            'endpoint': 'https://example.invalid/api',
            'public_parameters': {'x': 1},
            'secret_parameters': {},
        }
        client.get_json(**arguments)
        frozen = self.cache.freeze()
        self.assertEqual(frozen.state, 'FROZEN')
        self.assertEqual(frozen.snapshot_sha256, self.cache.verify_integrity())
        self.assertTrue(client.get_json(**arguments).cache_hit)
        with self.assertRaises(CacheFrozen):
            client.get_json(**arguments, refresh=True)
        with self.assertRaises(CacheFrozen):
            client.get_json(**{**arguments, 'public_parameters': {'x': 2}})
        self.assertEqual(len(opener.urls), 1)

    def test_usage_budget_stops_before_limit_is_exceeded(self) -> None:
        self.cache.reserve_usage(
            provider='P',
            metric='elements',
            units=4,
            hard_limit=5,
            request_sha256='a' * 64,
            billing_period='2026-09',
        )
        with self.assertRaises(UsageBudgetExceeded):
            self.cache.reserve_usage(
                provider='P',
                metric='elements',
                units=2,
                hard_limit=5,
                request_sha256='b' * 64,
                billing_period='2026-09',
            )
        status = self.cache.usage_status(
            provider='P',
            metric='elements',
            hard_limit=5,
            billing_period='2026-09',
        )
        self.assertEqual(status.reserved_units, 4)

    def test_post_body_is_hashed_but_secret_is_not_persisted(self) -> None:
        opener = SequencedOpener([[{'ok': True}]])
        response = JsonHttpClient(cache=self.cache, opener=opener).post_json(
            provider='P',
            endpoint='https://example.invalid/post',
            public_parameters={},
            secret_parameters={'key': 'POST-SECRET'},
            json_body={'point': {'lat': 55.75, 'lon': 37.61}},
        )
        self.assertEqual(response.payload, [{'ok': True}])
        self.assertNotIn(b'POST-SECRET', self.cache_path.read_bytes())
        self.assertIn(b'55.75', self.cache_path.read_bytes())


class MapboxParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = RoutingCache(Path(self.temporary.name) / 'routing.sqlite3')
        self.a = Coordinate('A', 55.75, 37.61)
        self.b = Coordinate('B', 55.76, 37.62)
        self.departure = datetime(2026, 8, 17, 10, 0, tzinfo=UTC)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_walking_matrix_parses_real_values_and_reserves_elements(self) -> None:
        opener = SequencedOpener(
            [{'code': 'Ok', 'durations': [[0, 60.1]], 'distances': [[0, 1000.1]]}]
        )
        client = MapboxRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache),
            access_token='test-token',
            account_policy_path=None,
        )
        cells = client.matrix(
            origins=[self.a],
            destinations=[self.a, self.b],
            mode=TransportMode.WALKING,
            departure_at=self.departure,
        )
        self.assertEqual(cells[1].duration_seconds, 61)
        self.assertEqual(cells[1].distance_m, 1001)
        usage = self.cache.usage_status(
            provider='MAPBOX_NAVIGATION_V5',
            metric='matrix_elements',
            hard_limit=80_000,
        )
        self.assertEqual(usage.reserved_units, 2)
        self.assertNotIn(b'test-token', self.cache.path.read_bytes())

    def test_null_matrix_cell_is_explicitly_unreachable(self) -> None:
        opener = SequencedOpener(
            [{'code': 'Ok', 'durations': [[0, None]], 'distances': [[0, None]]}]
        )
        cells = MapboxRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache),
            access_token='test-token',
            account_policy_path=None,
        ).matrix(
            origins=[self.a],
            destinations=[self.a, self.b],
            mode=TransportMode.BICYCLE,
            departure_at=self.departure,
        )
        cell = cells[1]
        self.assertEqual(cell.status, RouteStatus.UNREACHABLE)
        self.assertIsNone(cell.duration_seconds)

    def test_budget_blocks_network_call(self) -> None:
        opener = SequencedOpener([])
        client = MapboxRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache),
            access_token='test-token',
            matrix_hard_limit=1,
            account_policy_path=None,
        )
        with self.assertRaises(UsageBudgetExceeded):
            client.matrix(
                origins=[self.a],
                destinations=[self.a, self.b],
                mode=TransportMode.WALKING,
                departure_at=self.departure,
            )
        self.assertEqual(opener.urls, [])

    def test_account_suspension_blocks_uncached_requests_but_allows_cache(self) -> None:
        policy_path = Path(self.temporary.name) / 'mapbox_account_policy.json'
        policy_path.write_text('{"status":"AUTHORIZED"}', encoding='utf-8')
        opener = SequencedOpener(
            [{'code': 'Ok', 'durations': [[0, 60]], 'distances': [[0, 1000]]}]
        )
        client = MapboxRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache),
            access_token='test-token',
            account_policy_path=policy_path,
        )
        client.matrix(
            origins=[self.a], destinations=[self.a, self.b],
            mode=TransportMode.WALKING, departure_at=self.departure,
        )
        policy_path.write_text('{"status":"SUSPENDED_USAGE_LIMIT"}', encoding='utf-8')
        cached = client.matrix(
            origins=[self.a], destinations=[self.a, self.b],
            mode=TransportMode.WALKING, departure_at=self.departure,
        )
        self.assertTrue(cached[1].provenance.cache_hit)
        with self.assertRaises(ProviderAccessSuspended):
            client.matrix(
                origins=[self.a], destinations=[self.a, self.b],
                mode=TransportMode.WALKING, departure_at=self.departure, refresh=True,
            )
        self.assertEqual(len(opener.urls), 1)

    def test_budget_is_shared_between_independent_response_caches(self) -> None:
        shared_ledger = RoutingCache(Path(self.temporary.name) / 'shared-usage.sqlite3')
        first_cache = RoutingCache(Path(self.temporary.name) / 'first-responses.sqlite3')
        second_cache = RoutingCache(Path(self.temporary.name) / 'second-responses.sqlite3')
        first_opener = SequencedOpener(
            [{'code': 'Ok', 'durations': [[0, 60]], 'distances': [[0, 1000]]}]
        )
        first = MapboxRoutingClient(
            JsonHttpClient(
                cache=first_cache,
                opener=first_opener,
                usage_ledger=shared_ledger,
            ),
            access_token='test-token',
            matrix_hard_limit=3,
            account_policy_path=None,
        )
        first.matrix(
            origins=[self.a],
            destinations=[self.a, self.b],
            mode=TransportMode.WALKING,
            departure_at=self.departure,
        )
        second_opener = SequencedOpener([])
        second = MapboxRoutingClient(
            JsonHttpClient(
                cache=second_cache,
                opener=second_opener,
                usage_ledger=shared_ledger,
            ),
            access_token='test-token',
            matrix_hard_limit=3,
            account_policy_path=None,
        )
        with self.assertRaises(UsageBudgetExceeded):
            second.matrix(
                origins=[self.a],
                destinations=[self.a, self.b],
                mode=TransportMode.WALKING,
                departure_at=self.departure,
            )
        self.assertEqual(second_opener.urls, [])

    def test_past_car_departure_is_not_silently_substituted(self) -> None:
        opener = SequencedOpener([])
        client = MapboxRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache),
            access_token='test-token',
            account_policy_path=None,
        )
        with self.assertRaises(InvalidRoutingInput):
            client.route(
                origin=self.a,
                destination=self.b,
                mode=TransportMode.CAR,
                departure_at=self.departure,
            )
        self.assertEqual(opener.urls, [])

    def test_future_car_requires_explicit_mapbox_beta_enablement(self) -> None:
        opener = SequencedOpener([])
        client = MapboxRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache),
            access_token='test-token',
            account_policy_path=None,
        )
        with self.assertRaisesRegex(InvalidRoutingInput, 'gated beta'):
            client.route(
                origin=self.a,
                destination=self.b,
                mode=TransportMode.CAR,
                departure_at=(datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0),
            )
        self.assertEqual(opener.urls, [])

    def test_car_matrix_is_explicitly_time_independent_screening(self) -> None:
        opener = SequencedOpener(
            [{'code': 'Ok', 'durations': [[0, 60]], 'distances': [[0, 1000]]}]
        )
        cells = MapboxRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache),
            access_token='test-token',
            account_policy_path=None,
        ).matrix(
            origins=[self.a],
            destinations=[self.a, self.b],
            mode=TransportMode.CAR,
            departure_at=self.departure,
        )
        self.assertIn('/mapbox/driving/', opener.urls[0])
        self.assertNotIn('depart_at=', opener.urls[0])
        self.assertEqual(cells[1].provenance.provider_metadata['purpose'], 'SCREENING_ONLY')
        self.assertFalse(cells[1].provenance.provider_metadata['departure_time_honored'])


class DgisParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = RoutingCache(Path(self.temporary.name) / 'routing.sqlite3')
        self.a = Coordinate('A', 55.75, 37.61)
        self.b = Coordinate('B', 55.76, 37.62)
        self.departure = datetime(2026, 8, 17, 10, 0, tzinfo=UTC)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_past_car_uses_documented_statistical_traffic(self) -> None:
        payload = {
            'type': 'result',
            'status': 'OK',
            'result': [
                {
                    'total_duration': 60.1,
                    'total_distance': 1000.1,
                    'maneuvers': [
                        {
                            'type': 'begin',
                            'outcoming_path': {
                                'duration': 60.1,
                                'distance': 1000.1,
                                'geometry': [
                                    {'selection': 'LINESTRING(37.61 55.75, 37.62 55.76)'}
                                ],
                            },
                        }
                    ],
                }
            ],
        }
        opener = SequencedOpener([payload])
        route = DgisRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache),
            api_key='test-key',
        ).route(
            origin=self.a,
            destination=self.b,
            mode=TransportMode.CAR,
            departure_at=self.departure,
        )
        request_body = json.loads(opener.requests[0].data.decode('utf-8'))
        self.assertEqual(request_body['traffic_mode'], 'statistics')
        self.assertEqual(request_body['utc'], int(self.departure.timestamp()))
        self.assertEqual(route.duration_seconds, 61)
        self.assertEqual(route.distance_m, 1001)
        self.assertEqual(route.geometry, ((55.75, 37.61), (55.76, 37.62)))
        self.assertNotIn(b'test-key', self.cache.path.read_bytes())

    def test_zero_length_service_maneuver_is_skipped(self) -> None:
        payload = {
            'type': 'result',
            'status': 'OK',
            'result': [
                {
                    'total_duration': 60,
                    'total_distance': 1000,
                    'maneuvers': [
                        {
                            'type': 'begin',
                            'outcoming_path': {
                                'duration': 0,
                                'distance': 0,
                                'geometry': [
                                    {'selection': 'LINESTRING(37.61 55.75, 37.61 55.75)'}
                                ],
                            },
                        },
                        {
                            'type': 'crossroad',
                            'outcoming_path': {
                                'duration': 60,
                                'distance': 1000,
                                'geometry': [
                                    {'selection': 'LINESTRING(37.61 55.75, 37.62 55.76)'}
                                ],
                            },
                        },
                    ],
                }
            ],
        }
        route = DgisRoutingClient(
            JsonHttpClient(
                cache=self.cache,
                opener=SequencedOpener([payload]),
                usage_ledger=self.cache,
            ),
            api_key='test-key',
        ).route(
            origin=self.a,
            destination=self.b,
            mode=TransportMode.CAR,
            departure_at=self.departure,
        )
        self.assertEqual(len(route.itinerary), 1)
        self.assertEqual(route.itinerary[0].duration_seconds, 60)
        self.assertEqual(route.itinerary[0].distance_m, 1000)

    def test_explicit_route_not_found_is_unreachable(self) -> None:
        opener = SequencedOpener([{'type': 'error', 'status': 'ROUTE_NOT_FOUND'}])
        route = DgisRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache),
            api_key='test-key',
        ).route(
            origin=self.a,
            destination=self.b,
            mode=TransportMode.WALKING,
            departure_at=self.departure,
        )
        self.assertEqual(route.status, RouteStatus.UNREACHABLE)

    def test_empty_public_transport_array_is_unreachable(self) -> None:
        opener = SequencedOpener([[]])
        http = JsonHttpClient(cache=self.cache, opener=opener, usage_ledger=self.cache)
        route = DgisRoutingClient(
            http,
            api_key='test-key',
        ).route(
            origin=self.a,
            destination=self.b,
            mode=TransportMode.PUBLIC_TRANSIT,
            departure_at=self.departure,
        )
        self.assertEqual(route.status, RouteStatus.UNREACHABLE)
        request_body = json.loads(opener.requests[0].data.decode('utf-8'))
        self.assertEqual(request_body['max_result_count'], 1)
        self.assertEqual(len(request_body['transport']), 17)
        self.assertTrue(request_body['enable_schedule'])

    def test_public_transport_preserves_each_movement_and_waiting_time(self) -> None:
        payload = [
            {
                'route_id': 'route-1',
                'total_duration': 55,
                'total_distance': 300,
                'pedestrian': False,
                'movements': [
                    {
                        'id': 'walk-1',
                        'type': 'walkway',
                        'moving_duration': 30,
                        'waiting_duration': 5,
                        'distance': 100,
                        'waypoint': {'subtype': 'start'},
                        'alternatives': [
                            {
                                'geometry': [
                                    {'selection': 'LINESTRING(37.61 55.75, 37.615 55.755)'}
                                ]
                            }
                        ],
                    },
                    {
                        'id': 'metro-1',
                        'type': 'passage',
                        'moving_duration': 20,
                        'waiting_duration': 0,
                        'distance': 200,
                        'waypoint': {'subtype': 'metro'},
                        'alternatives': [
                            {
                                'geometry': [
                                    {'selection': 'LINESTRING(37.615 55.755, 37.62 55.76)'}
                                ]
                            }
                        ],
                    },
                ],
            }
        ]
        route = DgisRoutingClient(
            JsonHttpClient(
                cache=self.cache,
                opener=SequencedOpener([payload]),
                usage_ledger=self.cache,
            ),
            api_key='test-key',
        ).route(
            origin=self.a,
            destination=self.b,
            mode=TransportMode.PUBLIC_TRANSIT,
            departure_at=self.departure,
        )
        self.assertEqual(route.duration_seconds, 55)
        self.assertEqual(route.distance_m, 300)
        self.assertEqual(len(route.itinerary), 2)
        self.assertEqual(route.itinerary[0].mode, 'walking')
        self.assertEqual(route.itinerary[0].waiting_seconds, 5)
        self.assertEqual(route.itinerary[1].mode, 'metro')

    def test_public_transport_deterministically_selects_fastest_returned_option(self) -> None:
        def option(route_id: str, duration: int, distance: int) -> dict[str, Any]:
            return {
                'route_id': route_id,
                'total_duration': duration,
                'total_distance': distance,
                'movements': [
                    {
                        'type': 'walkway',
                        'moving_duration': duration,
                        'waiting_duration': 0,
                        'distance': distance,
                        'waypoint': {'subtype': 'pedestrian'},
                        'alternatives': [
                            {
                                'geometry': [
                                    {'selection': 'LINESTRING(37.61 55.75, 37.62 55.76)'}
                                ]
                            }
                        ],
                    }
                ],
            }

        route = DgisRoutingClient(
            JsonHttpClient(
                cache=self.cache,
                opener=SequencedOpener(
                    [[option('slower', 55, 300), option('faster', 40, 350)]]
                ),
                usage_ledger=self.cache,
            ),
            api_key='test-key',
        ).route(
            origin=self.a,
            destination=self.b,
            mode=TransportMode.PUBLIC_TRANSIT,
            departure_at=self.departure,
        )
        self.assertEqual(route.duration_seconds, 40)
        self.assertEqual(route.distance_m, 350)
        self.assertEqual(route.provenance.provider_metadata['returned_route_options'], 2)
        self.assertEqual(
            route.provenance.provider_metadata['route_selection'],
            'minimum_duration_then_distance_then_provider_order',
        )

    def test_public_transport_rejects_inconsistent_movement_totals(self) -> None:
        payload = [
            {
                'total_duration': 999,
                'total_distance': 100,
                'movements': [
                    {
                        'type': 'walkway',
                        'moving_duration': 30,
                        'waiting_duration': 0,
                        'distance': 100,
                        'waypoint': {'subtype': 'pedestrian'},
                        'alternatives': [
                            {'geometry': [{'selection': 'LINESTRING(37.61 55.75, 37.62 55.76)'}]}
                        ],
                    }
                ],
            }
        ]
        with self.assertRaises(ProviderResponseError):
            DgisRoutingClient(
                JsonHttpClient(
                    cache=self.cache,
                    opener=SequencedOpener([payload]),
                    usage_ledger=self.cache,
                ),
                api_key='test-key',
            ).route(
                origin=self.a,
                destination=self.b,
                mode=TransportMode.PUBLIC_TRANSIT,
                departure_at=self.departure,
            )


class HybridProviderPolicyTests(unittest.TestCase):
    def test_exact_mode_dispatch_is_static_and_has_no_runtime_fallback(self) -> None:
        calls: list[tuple[str, TransportMode]] = []

        class Recorder:
            def __init__(self, name: str) -> None:
                self.name = name

            def route(self, *, origin, destination, mode, departure_at, refresh=False):
                calls.append((self.name, mode))
                return object()

        client = HybridRoutingClient(
            dgis=Recorder('2GIS'),  # type: ignore[arg-type]
            mapbox=Recorder('MAPBOX'),  # type: ignore[arg-type]
        )
        origin = Coordinate('A', 55.75, 37.61)
        destination = Coordinate('B', 55.76, 37.62)
        departure = datetime(2026, 8, 17, 10, 0, tzinfo=UTC)
        for mode in TransportMode:
            client.route(
                origin=origin,
                destination=destination,
                mode=mode,
                departure_at=departure,
            )
        self.assertEqual(
            calls,
            [
                ('2GIS', TransportMode.CAR),
                ('2GIS', TransportMode.PUBLIC_TRANSIT),
                ('MAPBOX', TransportMode.BICYCLE),
                ('2GIS', TransportMode.WALKING),
            ],
        )


class YandexParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = RoutingCache(Path(self.temporary.name) / 'routing.sqlite3')
        self.departure = (datetime.now(UTC) + timedelta(days=7)).replace(microsecond=0)
        self.a = Coordinate('A', 55.75, 37.61)
        self.b = Coordinate('B', 55.76, 37.62)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def client_for(self, payload: dict[str, Any]) -> YandexRoutingClient:
        opener = SequencedOpener([payload])
        return YandexRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener),
            api_key='test-only-key',
        )

    def test_matrix_ok_rounds_only_published_values_up(self) -> None:
        client = self.client_for(
            {
                'rows': [
                    {
                        'elements': [
                            {
                                'status': 'OK',
                                'duration': {'value': 60.1},
                                'distance': {'value': 1000.1},
                            }
                        ]
                    }
                ]
            }
        )
        cell = client.matrix(
            origins=[self.a],
            destinations=[self.b],
            mode=TransportMode.CAR,
            departure_at=self.departure,
        )[0]
        self.assertEqual(cell.status, RouteStatus.OK)
        self.assertEqual(cell.duration_seconds, 61)
        self.assertEqual(cell.duration_minutes, 2)
        self.assertEqual(cell.distance_m, 1001)

    def test_matrix_fail_is_unknown_without_numbers(self) -> None:
        client = self.client_for({'rows': [{'elements': [{'status': 'FAIL'}]}]})
        cell = client.matrix(
            origins=[self.a],
            destinations=[self.b],
            mode=TransportMode.WALKING,
            departure_at=self.departure,
        )[0]
        self.assertEqual(cell.status, RouteStatus.UNKNOWN)
        self.assertIsNone(cell.duration_seconds)
        self.assertIsNone(cell.distance_m)

    def test_route_sums_raw_steps_before_rounding(self) -> None:
        client = self.client_for(
            {
                'traffic_type': 'realtime',
                'route': {
                    'legs': [
                        {
                            'status': 'OK',
                            'steps': [
                                {
                                    'duration': 30.2,
                                    'length': 100.2,
                                    'mode': 'walking',
                                    'polyline': {'points': [[55.75, 37.61], [55.755, 37.615]]},
                                },
                                {
                                    'duration': 30.2,
                                    'length': 100.2,
                                    'mode': 'walking',
                                    'polyline': {'points': [[55.755, 37.615], [55.76, 37.62]]},
                                },
                            ],
                        }
                    ]
                },
            }
        )
        route = client.route(
            origin=self.a,
            destination=self.b,
            mode=TransportMode.WALKING,
            departure_at=self.departure,
        )
        self.assertEqual(route.duration_seconds, 61)
        self.assertEqual(route.duration_minutes, 2)
        self.assertEqual(route.distance_m, 201)
        self.assertEqual(len(route.geometry), 3)
        self.assertEqual(route.provenance.provider_metadata['traffic_type'], 'realtime')

    def test_car_route_without_traffic_model_is_rejected(self) -> None:
        client = self.client_for(
            {
                'traffic_type': 'disabled',
                'route': {
                    'legs': [
                        {
                            'status': 'OK',
                            'steps': [
                                {
                                    'duration': 60,
                                    'length': 100,
                                    'mode': 'driving',
                                    'polyline': {'points': [[55.75, 37.61], [55.76, 37.62]]},
                                }
                            ],
                        }
                    ]
                },
            }
        )
        with self.assertRaises(ProviderResponseError):
            client.route(
                origin=self.a,
                destination=self.b,
                mode=TransportMode.CAR,
                departure_at=self.departure,
            )

    def test_unexpected_route_step_mode_is_rejected(self) -> None:
        client = self.client_for(
            {
                'route': {
                    'legs': [
                        {
                            'status': 'OK',
                            'steps': [
                                {
                                    'duration': 60,
                                    'length': 100,
                                    'mode': 'driving',
                                    'polyline': {'points': [[55.75, 37.61], [55.76, 37.62]]},
                                }
                            ],
                        }
                    ]
                },
            }
        )
        with self.assertRaises(ProviderResponseError):
            client.route(
                origin=self.a,
                destination=self.b,
                mode=TransportMode.WALKING,
                departure_at=self.departure,
            )

    def test_time_dependent_network_request_rejects_past(self) -> None:
        client = self.client_for({'rows': []})
        with self.assertRaises(InvalidRoutingInput):
            client.matrix(
                origins=[self.a],
                destinations=[self.b],
                mode=TransportMode.PUBLIC_TRANSIT,
                departure_at=datetime(2020, 1, 1, tzinfo=UTC),
            )

    def test_fractional_departure_second_is_rejected_not_truncated(self) -> None:
        client = self.client_for({'rows': []})
        with self.assertRaises(InvalidRoutingInput):
            client.matrix(
                origins=[self.a],
                destinations=[self.b],
                mode=TransportMode.WALKING,
                departure_at=self.departure.replace(microsecond=1),
            )

    def test_provider_error_payload_is_not_cached(self) -> None:
        client = self.client_for({'errors': ['bad key']})
        with self.assertRaises(ProviderResponseError):
            client.matrix(
                origins=[self.a],
                destinations=[self.b],
                mode=TransportMode.WALKING,
                departure_at=self.departure,
            )


class MatrixAssemblyTests(unittest.TestCase):
    class ExactClient:
        def __init__(self) -> None:
            self.calls: list[tuple[int, int]] = []

        def matrix(
            self,
            *,
            origins: list[Coordinate],
            destinations: list[Coordinate],
            mode: TransportMode,
            departure_at: datetime,
            refresh: bool,
        ) -> list[MatrixCell]:
            self.calls.append((len(origins), len(destinations)))
            return [
                MatrixCell(
                    origin_id=origin.location_id,
                    destination_id=destination.location_id,
                    mode=mode,
                    departure_at=departure_at,
                    status=RouteStatus.OK,
                    duration_seconds=0,
                    duration_minutes=0,
                    distance_m=0,
                    provider_status='OK',
                    provenance=provenance(),
                )
                for origin in origins
                for destination in destinations
            ]

    def test_batches_cover_every_pair_exactly_once(self) -> None:
        locations = [Coordinate(str(index), 55.7 + index / 1000, 37.6) for index in range(23)]
        client = self.ExactClient()
        cells = build_matrix(
            client=client,  # type: ignore[arg-type]
            locations=locations,
            mode=TransportMode.WALKING,
            departure_at=datetime.now(UTC),
            batch_side=10,
        )
        self.assertEqual(len(cells), 23**2)
        self.assertEqual(len(client.calls), 9)
        ensure_matrix_complete(cells)

    def test_unknown_blocks_optimizer(self) -> None:
        cell = MatrixCell(
            origin_id='A',
            destination_id='B',
            mode=TransportMode.CAR,
            departure_at=datetime.now(UTC),
            status=RouteStatus.UNKNOWN,
            duration_seconds=None,
            duration_minutes=None,
            distance_m=None,
            provider_status='FAIL',
            provenance=provenance(),
        )
        with self.assertRaises(RoutingIncomplete):
            ensure_matrix_complete([cell])


class ExactOracleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.cache = RoutingCache(Path(self.temporary.name) / 'routing.sqlite3')
        self.origin = Coordinate('A', 55.75, 37.61)
        self.destination = Coordinate('B', 55.76, 37.62)
        self.departure = (datetime.now(UTC) + timedelta(days=7)).replace(
            second=0,
            microsecond=0,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def request(self) -> OracleQuery:
        return OracleQuery(
            mode=TransportMode.WALKING,
            origin=self.origin,
            destination=self.destination,
            departure_at=self.departure,
        )

    def test_oracle_requires_integer_minute_and_non_self_arc(self) -> None:
        with self.assertRaises(InvalidRoutingInput):
            OracleQuery(
                mode=TransportMode.WALKING,
                origin=self.origin,
                destination=self.destination,
                departure_at=self.departure.replace(second=1),
            )
        with self.assertRaises(InvalidRoutingInput):
            OracleQuery(
                mode=TransportMode.WALKING,
                origin=self.origin,
                destination=self.origin,
                departure_at=self.departure,
            )

    def test_frozen_cache_miss_becomes_routing_incomplete(self) -> None:
        self.cache.freeze()
        client = YandexRoutingClient(JsonHttpClient(cache=self.cache), api_key='test-only-key')
        with self.assertRaises(RoutingIncomplete):
            ExactRoutingOracle(client).query(self.request())

    def test_oracle_replays_detailed_route_from_frozen_cache(self) -> None:
        payload = {
            'route': {
                'legs': [
                    {
                        'status': 'OK',
                        'steps': [
                            {
                                'duration': 60,
                                'length': 100,
                                'mode': 'walking',
                                'polyline': {'points': [[55.75, 37.61], [55.76, 37.62]]},
                            }
                        ],
                    }
                ]
            }
        }
        opener = SequencedOpener([payload])
        client = YandexRoutingClient(
            JsonHttpClient(cache=self.cache, opener=opener),
            api_key='test-only-key',
        )
        oracle = ExactRoutingOracle(client)
        first = oracle.query(self.request())
        self.cache.freeze()
        replayed = oracle.query(self.request())
        self.assertFalse(first.provenance.cache_hit)
        self.assertTrue(replayed.provenance.cache_hit)
        self.assertEqual(first.provenance.response_sha256, replayed.provenance.response_sha256)
        self.assertEqual(len(opener.urls), 1)


class DatasetIntegrationTests(unittest.TestCase):
    def test_v21_dataset_loads_for_both_scenarios(self) -> None:
        project_root = Path(__file__).resolve().parents[1]
        dataset_root = project_root / 'work' / 'dataset_v21' / 'beeline_synthetic_dataset_v2_1'
        for scenario in ('core', 'stress'):
            with self.subTest(scenario=scenario):
                dataset = load_dataset_locations(dataset_root, scenario)
                self.assertEqual(dataset.dataset_version, '2.1.0')
                self.assertEqual(set(dataset.zone_location_ids), {'EAST', 'SOUTHCENTER', 'SOUTHEAST'})
                self.assertTrue(all(dataset.zone_modes.values()))


@unittest.skipUnless(
    os.environ.get('RUN_LIVE_YANDEX_TESTS') == '1' and os.environ.get('YANDEX_ROUTING_API_KEY'),
    'Requires explicit RUN_LIVE_YANDEX_TESTS=1 and a billable Yandex API key',
)
class LiveYandexContractTests(unittest.TestCase):
    def test_real_walking_matrix_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = YandexRoutingClient(
                JsonHttpClient(cache=RoutingCache(Path(directory) / 'routing.sqlite3'))
            )
            cell = client.matrix(
                origins=[Coordinate('A', 55.751244, 37.618423)],
                destinations=[Coordinate('B', 55.75393, 37.620795)],
                mode=TransportMode.WALKING,
                departure_at=datetime.now(UTC).replace(second=0, microsecond=0),
                refresh=True,
            )[0]
            self.assertEqual(cell.status, RouteStatus.OK)
            self.assertEqual(cell.provenance.provider, PROVIDER)
            self.assertEqual(cell.provenance.endpoint, MATRIX_ENDPOINT)
            self.assertGreater(cell.duration_seconds or 0, 0)
            self.assertGreater(cell.distance_m or 0, 0)

    def test_real_detailed_route_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            client = YandexRoutingClient(
                JsonHttpClient(cache=RoutingCache(Path(directory) / 'routing.sqlite3'))
            )
            oracle = ExactRoutingOracle(client)
            route = oracle.query(
                OracleQuery(
                    origin=Coordinate('A', 55.751244, 37.618423),
                    destination=Coordinate('B', 55.75393, 37.620795),
                    mode=TransportMode.WALKING,
                    departure_at=datetime.now(UTC).replace(second=0, microsecond=0),
                ),
                refresh=True,
            )
            self.assertEqual(route.status, RouteStatus.OK)
            self.assertTrue(route.geometry)
            self.assertTrue(route.itinerary)
            self.assertGreater(route.duration_seconds or 0, 0)


if __name__ == '__main__':
    unittest.main()
