from __future__ import annotations

import math
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from .errors import InvalidRoutingInput, ProviderResponseError, RoutingIncomplete
from .http import JsonHttpClient, JsonResponse
from .models import Coordinate, DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode
from .traffic4cast import MOSCOW_TIMEZONE, Traffic4castProfile


PROVIDER = 'LOCAL_VALHALLA'
DEFAULT_ENDPOINT = 'http://127.0.0.1:8002/route'
DEFAULT_RUNTIME_REVISION = 'valhalla-3.8.3-runtime-schema-v2'
DEFAULT_TRAFFIC_PROFILE = Path(__file__).parents[3] / 'data' / 'traffic4cast' / 'moscow-2019.json'
_COSTING = {
    TransportMode.CAR: 'auto',
    TransportMode.BICYCLE: 'bicycle',
    TransportMode.WALKING: 'pedestrian',
}


class ValhallaRoutingClient:
    """Local Valhalla for fast, reproducible road, walking, and bicycle routes."""

    def __init__(self, http: JsonHttpClient, endpoint: str | None = None) -> None:
        self.http = http
        self.endpoint = (endpoint or os.environ.get('VALHALLA_ROUTE_ENDPOINT') or DEFAULT_ENDPOINT).rstrip('/')
        self.runtime_revision = os.environ.get(
            'VALHALLA_RUNTIME_REVISION', DEFAULT_RUNTIME_REVISION
        ).strip() or DEFAULT_RUNTIME_REVISION
        if not self.endpoint.startswith(('http://', 'https://')):
            raise InvalidRoutingInput('VALHALLA_ROUTE_ENDPOINT must be an HTTP(S) URL')
        configured_profile = os.environ.get('TRAFFIC4CAST_PROFILE', '').strip()
        profile_path = Path(configured_profile) if configured_profile else DEFAULT_TRAFFIC_PROFILE
        self.traffic_profile = Traffic4castProfile(profile_path) if (
            configured_profile or profile_path.is_file()
        ) else None

    def route(
        self,
        *,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> DetailedRoute:
        if mode not in _COSTING:
            raise InvalidRoutingInput('Local Valhalla is not used for public-transit routing')
        if mode == TransportMode.CAR and self.traffic_profile is None:
            raise RoutingIncomplete(
                f'Traffic4cast 2021 profile is required for car routing: {DEFAULT_TRAFFIC_PROFILE}'
            )
        if departure_at.tzinfo is None or departure_at.utcoffset() is None:
            raise InvalidRoutingInput('departure_at must include a timezone')
        if departure_at.microsecond != 0:
            raise InvalidRoutingInput('departure_at must use whole seconds')
        local_departure = (
            departure_at.astimezone(MOSCOW_TIMEZONE)
            if self.traffic_profile and self.traffic_profile.covers(origin.latitude, origin.longitude)
            else departure_at
        )
        body = {
            'locations': [
                {'lat': origin.latitude, 'lon': origin.longitude},
                {'lat': destination.latitude, 'lon': destination.longitude},
            ],
            'costing': _COSTING[mode],
            'units': 'kilometers',
            'alternates': 0,
        }
        if mode == TransportMode.CAR:
            body['date_time'] = {
                'type': 1,
                'value': local_departure.strftime('%Y-%m-%dT%H:%M'),
            }
        response = self.http.post_json(
            # The tile/runtime format affects the response. Keep prior runtime
            # failures out of a cache created before a compatible upgrade.
            provider=f'{PROVIDER}:{self.runtime_revision}',
            endpoint=self.endpoint,
            public_parameters={},
            secret_parameters={},
            json_body=body,
            validate_payload=self._validate_payload,
            refresh=refresh,
        )
        route = self._parse(response, origin, destination, mode, departure_at)
        if self.traffic_profile is not None:
            route = self.traffic_profile.adjust(route)
        return route

    @staticmethod
    def _validate_payload(payload: Any, request_sha256: str) -> None:
        if not isinstance(payload, dict):
            raise ProviderResponseError(f'Valhalla response must be an object; request_sha256={request_sha256}')

    def _parse(
        self, response: JsonResponse, origin: Coordinate, destination: Coordinate,
        mode: TransportMode, departure_at: datetime,
    ) -> DetailedRoute:
        payload = response.payload
        provenance = Provenance(
            provider=PROVIDER,
            endpoint=self.endpoint,
            request_sha256=response.request_sha256,
            response_sha256=response.response_sha256,
            fetched_at=response.fetched_at,
            cache_hit=response.cache_hit,
            provider_metadata={
                'costing': _COSTING[mode],
                'local_service': True,
                'runtime_revision': self.runtime_revision,
            },
        )
        if payload.get('error_code') is not None:
            return self._non_ok(origin, destination, mode, departure_at, str(payload.get('error_code')), provenance)
        if payload.get('error') is not None:
            return self._non_ok(origin, destination, mode, departure_at, str(payload['error']), provenance)
        trip = payload.get('trip')
        if not isinstance(trip, dict):
            raise ProviderResponseError('Valhalla response has neither error_code nor trip')
        summary = trip.get('summary')
        legs = trip.get('legs')
        if not isinstance(summary, dict) or not isinstance(legs, list) or not legs:
            raise ProviderResponseError('Valhalla trip lacks summary or legs')
        try:
            duration_seconds = math.ceil(float(summary['time']))
            distance_m = math.ceil(float(summary['length']) * 1000)
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            raise ProviderResponseError('Valhalla trip summary has invalid time or length') from error
        geometry: list[tuple[float, float]] = []
        itinerary: list[RouteStep] = []
        sequence = 0
        for leg in legs:
            if not isinstance(leg, dict) or not isinstance(leg.get('shape'), str):
                raise ProviderResponseError('Valhalla leg lacks encoded shape')
            points = _decode_polyline6(leg['shape'])
            if len(points) < 2:
                raise ProviderResponseError('Valhalla leg shape has fewer than two points')
            if geometry and geometry[-1] == points[0]:
                geometry.extend(points[1:])
            else:
                geometry.extend(points)
            maneuvers = leg.get('maneuvers')
            if not isinstance(maneuvers, list):
                raise ProviderResponseError('Valhalla leg lacks maneuvers')
            for maneuver in maneuvers:
                if not isinstance(maneuver, dict):
                    raise ProviderResponseError('Valhalla maneuver must be an object')
                try:
                    begin = int(maneuver['begin_shape_index'])
                    end = int(maneuver['end_shape_index'])
                    step_points = tuple(points[begin:end + 1])
                    step_time = float(maneuver['time'])
                    step_length = float(maneuver['length']) * 1000
                except (KeyError, TypeError, ValueError, OverflowError) as error:
                    raise ProviderResponseError('Valhalla maneuver has invalid fields') from error
                if not step_points or step_time < 0 or step_length < 0:
                    raise ProviderResponseError('Valhalla maneuver contains invalid geometry or metrics')
                itinerary.append(RouteStep(sequence, _COSTING[mode], step_time, step_length, 0, step_points, {
                    'instruction': maneuver.get('instruction'), 'type': maneuver.get('type'),
                }))
                sequence += 1
        if duration_seconds < 0 or distance_m < 0 or not itinerary or not geometry:
            raise ProviderResponseError('Valhalla trip contains invalid route metrics')
        return DetailedRoute(origin.location_id, destination.location_id, mode, departure_at, RouteStatus.OK,
            duration_seconds, math.ceil(duration_seconds / 60), distance_m, tuple(geometry), tuple(itinerary), 'OK', provenance)

    @staticmethod
    def _non_ok(origin: Coordinate, destination: Coordinate, mode: TransportMode, departure_at: datetime,
                provider_status: str, provenance: Provenance) -> DetailedRoute:
        return DetailedRoute(origin.location_id, destination.location_id, mode, departure_at, RouteStatus.UNREACHABLE,
            None, None, None, (), (), provider_status, provenance)


def _decode_polyline6(value: str) -> tuple[tuple[float, float], ...]:
    """Decode Valhalla's precision-six polyline as (latitude, longitude) coordinates."""
    coordinates: list[tuple[float, float]] = []
    latitude = longitude = index = 0
    while index < len(value):
        decoded: list[int] = []
        for _ in range(2):
            shift = result = 0
            while True:
                if index >= len(value):
                    raise ProviderResponseError('Valhalla polyline is truncated')
                byte = ord(value[index]) - 63
                index += 1
                if byte < 0:
                    raise ProviderResponseError('Valhalla polyline contains an invalid byte')
                result |= (byte & 0x1F) << shift
                shift += 5
                if not byte & 0x20:
                    break
                if shift > 60:
                    raise ProviderResponseError('Valhalla polyline value is too large')
            decoded.append(~(result >> 1) if result & 1 else result >> 1)
        latitude += decoded[0]
        longitude += decoded[1]
        coordinates.append((latitude / 1_000_000, longitude / 1_000_000))
    return tuple(coordinates)
