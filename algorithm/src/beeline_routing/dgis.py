from __future__ import annotations

import math
import os
import re
from datetime import datetime
from typing import Any

from .errors import InvalidRoutingInput, MissingApiKey, ProviderResponseError
from .http import JsonHttpClient, JsonResponse
from .models import Coordinate, DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode


PROVIDER = '2GIS_ROUTING_API'
ROUTING_ENDPOINT = 'https://routing.api.2gis.com/routing/7.0.0/global'
PUBLIC_TRANSPORT_ENDPOINT = 'https://routing.api.2gis.com/public_transport/2.0'
DEMO_REQUEST_LIMIT = 1_000
DEFAULT_HARD_LIMIT = 900

MODE_MAP = {
    TransportMode.CAR: 'driving',
    TransportMode.BICYCLE: 'bicycle',
    TransportMode.WALKING: 'walking',
}

PUBLIC_TRANSPORT_TYPES = [
    'pedestrian',
    'metro',
    'light_metro',
    'suburban_train',
    'aeroexpress',
    'tram',
    'bus',
    'trolleybus',
    'shuttle_bus',
    'monorail',
    'funicular_railway',
    'river_transport',
    'cable_car',
    'light_rail',
    'premetro',
    'mcc',
    'mcd',
]

_LINESTRING_PATTERN = re.compile(r'^LINESTRING(?:\s+Z)?\s*\((.*)\)$', re.IGNORECASE)


class DgisRoutingClient:
    """Авторитетный 2ГИС-маршрутизатор с жёстким лимитом ниже демо-квоты."""

    def __init__(
        self,
        http: JsonHttpClient,
        api_key: str | None = None,
        *,
        hard_limit: int = DEFAULT_HARD_LIMIT,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get('DGIS_ROUTING_API_KEY')
        if key is None or not key.strip():
            raise MissingApiKey('Set DGIS_ROUTING_API_KEY; the key is never written to cache or output')
        if not 1 <= hard_limit < DEMO_REQUEST_LIMIT:
            raise InvalidRoutingInput(
                f'2GIS hard limit must stay below the {DEMO_REQUEST_LIMIT} demo limit'
            )
        self.http = http
        self._api_key = key.strip()
        self.hard_limit = hard_limit

    def route(
        self,
        *,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> DetailedRoute:
        self._validate_request(origin, destination, departure_at)
        if mode == TransportMode.PUBLIC_TRANSIT:
            endpoint = PUBLIC_TRANSPORT_ENDPOINT
            body = self._public_transport_body(origin, destination, departure_at)
            validator = self._validate_public_transport_payload
            empty_statuses = frozenset({204})
        else:
            endpoint = ROUTING_ENDPOINT
            body = self._routing_body(origin, destination, mode, departure_at)
            validator = self._validate_routing_payload
            empty_statuses = frozenset()
        request_identity = {'method': 'POST', 'query': {}, 'body': body}
        request_sha256, _ = self.http.cache.request_hash(PROVIDER, endpoint, request_identity)

        def reserve_request() -> None:
            self.http.usage_ledger.reserve_usage(
                provider=PROVIDER,
                metric='routing_requests',
                units=1,
                hard_limit=self.hard_limit,
                request_sha256=request_sha256,
            )

        response = self.http.post_json(
            provider=PROVIDER,
            endpoint=endpoint,
            public_parameters={},
            secret_parameters={'key': self._api_key},
            json_body=body,
            before_network=reserve_request,
            validate_payload=validator,
            refresh=refresh,
            empty_response_statuses=empty_statuses,
        )
        if mode == TransportMode.PUBLIC_TRANSIT:
            return self._parse_public_transport(
                response, origin, destination, departure_at
            )
        return self._parse_routing(response, origin, destination, mode, departure_at)

    @staticmethod
    def _validate_request(
        origin: Coordinate, destination: Coordinate, departure_at: datetime
    ) -> None:
        if origin.location_id == destination.location_id:
            raise InvalidRoutingInput('Self-arcs are forbidden for detailed 2GIS routes')
        if departure_at.tzinfo is None or departure_at.utcoffset() is None:
            raise InvalidRoutingInput('departure_at must include a timezone')
        if departure_at.microsecond != 0:
            raise InvalidRoutingInput('2GIS departure_at must use whole seconds')

    @staticmethod
    def _routing_body(
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
    ) -> dict[str, Any]:
        try:
            transport = MODE_MAP[mode]
        except KeyError as error:
            raise InvalidRoutingInput(f'Unsupported 2GIS routing mode: {mode.value}') from error
        body: dict[str, Any] = {
            'points': [
                {'type': 'stop', 'lon': origin.longitude, 'lat': origin.latitude},
                {'type': 'stop', 'lon': destination.longitude, 'lat': destination.latitude},
            ],
            'transport': transport,
            'output': 'detailed',
            'locale': 'en',
            'route_mode': 'fastest',
        }
        if mode == TransportMode.CAR:
            body['utc'] = int(departure_at.timestamp())
            body['traffic_mode'] = 'statistics'
        return body

    @staticmethod
    def _public_transport_body(
        origin: Coordinate, destination: Coordinate, departure_at: datetime
    ) -> dict[str, Any]:
        return {
            'source': {'point': {'lat': origin.latitude, 'lon': origin.longitude}},
            'target': {'point': {'lat': destination.latitude, 'lon': destination.longitude}},
            'transport': PUBLIC_TRANSPORT_TYPES,
            'start_time': int(departure_at.timestamp()),
            'enable_schedule': True,
            'max_result_count': 1,
            'locale': 'en',
        }

    @staticmethod
    def _validate_routing_payload(payload: Any, request_sha256: str) -> None:
        if not isinstance(payload, dict):
            raise ProviderResponseError('2GIS routing response root must be an object')
        if payload.get('type') not in {'result', 'error'}:
            raise ProviderResponseError(
                f'2GIS routing response has unknown type; request_sha256={request_sha256}'
            )
        if not isinstance(payload.get('status'), str):
            raise ProviderResponseError('2GIS routing response has no status')

    @staticmethod
    def _validate_public_transport_payload(payload: Any, request_sha256: str) -> None:
        if payload is not None and not isinstance(payload, list):
            raise ProviderResponseError(
                f'2GIS public-transport response must be an array or HTTP 204; '
                f'request_sha256={request_sha256}'
            )

    @staticmethod
    def _provenance(
        response: JsonResponse,
        endpoint: str,
        metadata: dict[str, Any],
    ) -> Provenance:
        return Provenance(
            provider=PROVIDER,
            endpoint=endpoint,
            request_sha256=response.request_sha256,
            response_sha256=response.response_sha256,
            fetched_at=response.fetched_at,
            cache_hit=response.cache_hit,
            provider_metadata={
                **metadata,
                'api_contract_version': 'routing-7.0.0/public-transport-2.0',
                'graph_version_exposed_by_provider': False,
                'schedule_version_exposed_by_provider': False,
                'documentation': {
                    'routing': 'https://docs.2gis.com/en/api/navigation/routing/reference/routing',
                    'public_transport': (
                        'https://docs.2gis.com/en/api/navigation/routing/reference/public_transport'
                    ),
                    'limits': 'https://docs.2gis.com/en/platform-manager/subscription/pricing',
                },
            },
        )

    def _parse_routing(
        self,
        response: JsonResponse,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
    ) -> DetailedRoute:
        payload = response.payload
        provider_status = str(payload['status'])
        provenance = self._provenance(
            response,
            ROUTING_ENDPOINT,
            {
                'transport': MODE_MAP[mode],
                'traffic_mode': 'statistics' if mode == TransportMode.CAR else None,
                'departure_time_honored': mode == TransportMode.CAR,
            },
        )
        if provider_status in {'ROUTE_NOT_FOUND', 'ROUTE_DOES_NOT_EXISTS'}:
            return self._non_ok_route(
                origin, destination, mode, departure_at, RouteStatus.UNREACHABLE,
                provider_status, provenance
            )
        if provider_status != 'OK' or payload.get('type') != 'result':
            return self._non_ok_route(
                origin, destination, mode, departure_at, RouteStatus.UNKNOWN,
                provider_status, provenance
            )
        results = payload.get('result')
        if not isinstance(results, list) or not results or not all(isinstance(item, dict) for item in results):
            raise ProviderResponseError('2GIS OK response contains no route options')
        try:
            route = min(results, key=lambda item: self._non_negative_number(item.get('total_duration'), 'total_duration'))
        except ValueError as error:
            raise ProviderResponseError('2GIS route options are empty') from error
        duration_seconds = self._non_negative_ceiling(route.get('total_duration'), 'total_duration')
        distance_m = self._non_negative_ceiling(route.get('total_distance'), 'total_distance')
        geometry = self._extract_geometry(route)
        itinerary = self._parse_maneuvers(route, mode)
        return DetailedRoute(
            origin.location_id,
            destination.location_id,
            mode,
            departure_at,
            RouteStatus.OK,
            duration_seconds,
            math.ceil(duration_seconds / 60),
            distance_m,
            geometry,
            itinerary,
            provider_status,
            provenance,
        )

    def _parse_public_transport(
        self,
        response: JsonResponse,
        origin: Coordinate,
        destination: Coordinate,
        departure_at: datetime,
    ) -> DetailedRoute:
        provenance = self._provenance(
            response,
            PUBLIC_TRANSPORT_ENDPOINT,
            {
                'schedule_enabled': True,
                'departure_time_honored': True,
                'requested_transport_types': PUBLIC_TRANSPORT_TYPES,
                'max_result_count': 1,
                'returned_route_options': (
                    len(response.payload) if isinstance(response.payload, list) else None
                ),
                'route_selection': 'minimum_duration_then_distance_then_provider_order',
            },
        )
        payload = response.payload
        if payload is None or payload == []:
            return self._non_ok_route(
                origin,
                destination,
                TransportMode.PUBLIC_TRANSIT,
                departure_at,
                RouteStatus.UNREACHABLE,
                'NO_ROUTE_204' if payload is None else 'EMPTY_ROUTE_ARRAY',
                provenance,
            )
        if not all(isinstance(item, dict) for item in payload):
            raise ProviderResponseError('2GIS public-transport array contains a non-object route')
        route = min(
            enumerate(payload),
            key=lambda indexed: (
                self._non_negative_number(
                    indexed[1].get('total_duration'), 'total_duration'
                ),
                self._non_negative_number(
                    indexed[1].get('total_distance'), 'total_distance'
                ),
                indexed[0],
            ),
        )[1]
        raw_duration = self._non_negative_number(route.get('total_duration'), 'total_duration')
        raw_distance = self._non_negative_number(route.get('total_distance'), 'total_distance')
        duration_seconds = math.ceil(raw_duration)
        distance_m = math.ceil(raw_distance)
        geometry = self._extract_geometry(route)
        movements = route.get('movements')
        if not isinstance(movements, list) or not movements:
            raise ProviderResponseError('2GIS public-transport route contains no movements')
        itinerary = self._parse_public_transport_movements(movements, route)
        movement_duration = sum(
            step.duration_seconds + step.waiting_seconds for step in itinerary
        )
        movement_distance = sum(step.distance_m for step in itinerary)
        if not math.isclose(movement_duration, raw_duration, rel_tol=0, abs_tol=1e-6):
            raise ProviderResponseError(
                '2GIS public-transport movement durations do not equal total_duration'
            )
        if not math.isclose(movement_distance, raw_distance, rel_tol=0, abs_tol=1e-6):
            raise ProviderResponseError(
                '2GIS public-transport movement distances do not equal total_distance'
            )
        return DetailedRoute(
            origin.location_id,
            destination.location_id,
            TransportMode.PUBLIC_TRANSIT,
            departure_at,
            RouteStatus.OK,
            duration_seconds,
            math.ceil(duration_seconds / 60),
            distance_m,
            geometry,
            itinerary,
            'OK',
            provenance,
        )

    def _parse_public_transport_movements(
        self, movements: list[Any], route: dict[str, Any]
    ) -> tuple[RouteStep, ...]:
        steps: list[RouteStep] = []
        for movement in movements:
            if not isinstance(movement, dict):
                raise ProviderResponseError('2GIS public-transport movement must be an object')
            moving_seconds = self._non_negative_number(
                movement.get('moving_duration'), 'moving_duration'
            )
            waiting_seconds = self._non_negative_number(
                movement.get('waiting_duration'), 'waiting_duration'
            )
            distance_m = self._non_negative_number(movement.get('distance'), 'distance')
            if moving_seconds == waiting_seconds == distance_m == 0:
                continue
            geometry = self._primary_public_transport_geometry(movement)
            waypoint = movement.get('waypoint')
            subtype = waypoint.get('subtype') if isinstance(waypoint, dict) else None
            mode = (
                'walking'
                if subtype in {'start', 'finish', 'pedestrian'}
                else str(subtype or movement.get('type') or 'transit')
            )
            alternatives = movement.get('alternatives')
            steps.append(
                RouteStep(
                    sequence=len(steps),
                    mode=mode,
                    duration_seconds=moving_seconds,
                    distance_m=distance_m,
                    waiting_seconds=waiting_seconds,
                    geometry=geometry,
                    attributes={
                        'movement_id': movement.get('id'),
                        'movement_type': movement.get('type'),
                        'waypoint': waypoint,
                        'platforms': movement.get('platforms'),
                        'routes': movement.get('routes'),
                        'metro': movement.get('metro'),
                        'provider_alternative_count': (
                            len(alternatives) if isinstance(alternatives, list) else 0
                        ),
                        'route_summary': (
                            {
                                'route_id': route.get('route_id'),
                                'pedestrian': route.get('pedestrian'),
                                'transfer_count': route.get('transfer_count'),
                                'crossing_count': route.get('crossing_count'),
                                'transport': route.get('transport'),
                                'schedules': route.get('schedules'),
                            }
                            if not steps
                            else None
                        ),
                    },
                )
            )
        if not steps:
            raise ProviderResponseError('2GIS public-transport route has no non-empty movements')
        return tuple(steps)

    @classmethod
    def _primary_public_transport_geometry(
        cls, movement: dict[str, Any]
    ) -> tuple[tuple[float, float], ...]:
        alternatives = movement.get('alternatives')
        if not isinstance(alternatives, list) or not alternatives:
            raise ProviderResponseError(
                '2GIS non-empty public-transport movement contains no geometry alternatives'
            )
        primary = alternatives[0]
        if not isinstance(primary, dict):
            raise ProviderResponseError('2GIS primary movement alternative must be an object')
        return cls._extract_geometry(primary)

    def _parse_maneuvers(
        self, route: dict[str, Any], mode: TransportMode
    ) -> tuple[RouteStep, ...]:
        maneuvers = route.get('maneuvers')
        if not isinstance(maneuvers, list):
            raise ProviderResponseError('2GIS detailed route contains no maneuvers')
        steps: list[RouteStep] = []
        for maneuver in maneuvers:
            if not isinstance(maneuver, dict) or not isinstance(maneuver.get('outcoming_path'), dict):
                continue
            path = maneuver['outcoming_path']
            duration_seconds = self._non_negative_number(path.get('duration'), 'duration')
            distance_m = self._non_negative_number(path.get('distance'), 'distance')
            if duration_seconds == 0 and distance_m == 0:
                continue
            step_geometry = self._extract_geometry(path)
            steps.append(
                RouteStep(
                    sequence=len(steps),
                    mode=MODE_MAP[mode],
                    duration_seconds=duration_seconds,
                    distance_m=distance_m,
                    waiting_seconds=0.0,
                    geometry=step_geometry,
                    attributes={
                        'comment': maneuver.get('comment'),
                        'type': maneuver.get('type'),
                        'turn_direction': maneuver.get('turn_direction'),
                        'road_names': path.get('names'),
                    },
                )
            )
        if not steps:
            raise ProviderResponseError('2GIS detailed route contains no routed maneuver paths')
        return tuple(steps)

    @staticmethod
    def _non_ok_route(
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        status: RouteStatus,
        provider_status: str,
        provenance: Provenance,
    ) -> DetailedRoute:
        return DetailedRoute(
            origin.location_id,
            destination.location_id,
            mode,
            departure_at,
            status,
            None,
            None,
            None,
            (),
            (),
            provider_status,
            provenance,
        )

    @classmethod
    def _extract_geometry(cls, value: Any) -> tuple[tuple[float, float], ...]:
        lines: list[tuple[tuple[float, float], ...]] = []

        def visit(item: Any) -> None:
            if isinstance(item, dict):
                selection = item.get('selection')
                if isinstance(selection, str):
                    parsed = cls._parse_linestring(selection)
                    if parsed:
                        lines.append(parsed)
                for child in item.values():
                    visit(child)
            elif isinstance(item, list):
                for child in item:
                    visit(child)

        visit(value)
        merged: list[tuple[float, float]] = []
        for line in lines:
            for point in line:
                if not merged or merged[-1] != point:
                    merged.append(point)
        if len(merged) < 2:
            raise ProviderResponseError('2GIS detailed route contains no usable WKT geometry')
        return tuple(merged)

    @staticmethod
    def _parse_linestring(value: str) -> tuple[tuple[float, float], ...]:
        match = _LINESTRING_PATTERN.match(value.strip())
        if match is None:
            return ()
        points: list[tuple[float, float]] = []
        try:
            for raw_point in match.group(1).split(','):
                parts = raw_point.strip().split()
                if len(parts) < 2:
                    raise ValueError('not enough coordinate components')
                lon, lat = float(parts[0]), float(parts[1])
                if (
                    not math.isfinite(lat)
                    or not math.isfinite(lon)
                    or not -90 <= lat <= 90
                    or not -180 <= lon <= 180
                ):
                    raise ValueError('coordinate outside valid range')
                points.append((lat, lon))
        except ValueError as error:
            raise ProviderResponseError('2GIS WKT geometry contains invalid coordinates') from error
        return tuple(points)

    @staticmethod
    def _non_negative_number(value: Any, field: str) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError) as error:
            raise ProviderResponseError(f'2GIS {field} is not numeric') from error
        if not math.isfinite(number) or number < 0:
            raise ProviderResponseError(f'2GIS {field} is negative or non-finite')
        return number

    @classmethod
    def _non_negative_ceiling(cls, value: Any, field: str) -> int:
        return math.ceil(cls._non_negative_number(value, field))
