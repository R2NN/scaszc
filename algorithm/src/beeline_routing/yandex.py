from __future__ import annotations

import math
import os
from datetime import UTC, datetime
from typing import Any

from .errors import InvalidRoutingInput, MissingApiKey, ProviderResponseError
from .http import JsonHttpClient, JsonResponse
from .models import (
    Coordinate,
    DetailedRoute,
    MatrixCell,
    Provenance,
    RouteStatus,
    RouteStep,
    TransportMode,
)


PROVIDER = 'YANDEX_MAPS_ROUTING_API_V2'
MATRIX_ENDPOINT = 'https://api.routing.yandex.net/v2/distancematrix'
ROUTE_ENDPOINT = 'https://api.routing.yandex.net/v2/route'
DOCUMENTATION = {
    'matrix_request': 'https://yandex.ru/maps-api/docs/distancematrix-api/request.html',
    'matrix_response': 'https://yandex.ru/maps-api/docs/distancematrix-api/response.html',
    'route_request': 'https://yandex.ru/maps-api/docs/router-api/request.html',
    'route_response': 'https://yandex.ru/maps-api/docs/router-api/response.html',
}

MODE_MAP = {
    TransportMode.CAR: 'driving',
    TransportMode.PUBLIC_TRANSIT: 'transit',
    TransportMode.BICYCLE: 'bicycle',
    TransportMode.WALKING: 'walking',
}


class YandexRoutingClient:
    def __init__(self, http: JsonHttpClient, api_key: str | None = None) -> None:
        key = api_key if api_key is not None else os.environ.get('YANDEX_ROUTING_API_KEY')
        if key is None or not key.strip():
            raise MissingApiKey('Set YANDEX_ROUTING_API_KEY; the key is never written to cache or output')
        self.http = http
        self._api_key = key.strip()

    def matrix(
        self,
        *,
        origins: list[Coordinate],
        destinations: list[Coordinate],
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> list[MatrixCell]:
        self._validate_request(origins, destinations, departure_at)
        if len(origins) * len(destinations) > 100:
            raise InvalidRoutingInput('Yandex matrix request may contain at most 100 elements')
        parameters: dict[str, Any] = {
            'origins': '|'.join(point.as_provider_value() for point in origins),
            'destinations': '|'.join(point.as_provider_value() for point in destinations),
            'mode': MODE_MAP[mode],
        }
        self._add_departure_time(parameters, mode, departure_at)
        response = self.http.get_json(
            provider=PROVIDER,
            endpoint=MATRIX_ENDPOINT,
            public_parameters=parameters,
            secret_parameters={'apikey': self._api_key},
            before_network=lambda: self._validate_future_departure(mode, departure_at),
            validate_payload=self._validate_payload,
            refresh=refresh,
        )
        return self._parse_matrix(response, origins, destinations, mode, departure_at)

    def route(
        self,
        *,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> DetailedRoute:
        self._validate_request([origin], [destination], departure_at)
        parameters: dict[str, Any] = {
            'waypoints': f'{origin.as_provider_value()}|{destination.as_provider_value()}',
            'mode': MODE_MAP[mode],
        }
        self._add_departure_time(parameters, mode, departure_at)
        response = self.http.get_json(
            provider=PROVIDER,
            endpoint=ROUTE_ENDPOINT,
            public_parameters=parameters,
            secret_parameters={'apikey': self._api_key},
            before_network=lambda: self._validate_future_departure(mode, departure_at),
            validate_payload=self._validate_payload,
            refresh=refresh,
        )
        return self._parse_route(response, origin, destination, mode, departure_at)

    @staticmethod
    def _validate_request(
        origins: list[Coordinate],
        destinations: list[Coordinate],
        departure_at: datetime,
    ) -> None:
        if not origins or not destinations:
            raise InvalidRoutingInput('Origins and destinations must not be empty')
        if departure_at.tzinfo is None or departure_at.utcoffset() is None:
            raise InvalidRoutingInput('departure_at must include a timezone')
        if departure_at.microsecond != 0:
            raise InvalidRoutingInput(
                'Yandex accepts integer UNIX seconds; fractional departure seconds are forbidden'
            )

    @staticmethod
    def _validate_future_departure(mode: TransportMode, departure_at: datetime) -> None:
        if mode not in {TransportMode.CAR, TransportMode.PUBLIC_TRANSIT}:
            return
        if departure_at.astimezone(UTC) < datetime.now(UTC):
            raise InvalidRoutingInput(
                'Yandex departure_time cannot be in the past. Use an existing cached response '
                'or a scenario date in the future; substituting another date is forbidden.'
            )

    @staticmethod
    def _add_departure_time(
        parameters: dict[str, Any],
        mode: TransportMode,
        departure_at: datetime,
    ) -> None:
        if mode in {TransportMode.CAR, TransportMode.PUBLIC_TRANSIT}:
            parameters['departure_time'] = int(departure_at.timestamp())

    @staticmethod
    def _validate_payload(payload: dict[str, Any], request_sha256: str) -> None:
        errors = payload.get('errors')
        if errors:
            raise ProviderResponseError(
                f'Yandex response contains errors; request_sha256={request_sha256}; '
                f'error_count={len(errors) if isinstance(errors, list) else 1}'
            )

    @staticmethod
    def _provenance(response: JsonResponse, endpoint: str, metadata: dict[str, Any]) -> Provenance:
        return Provenance(
            provider=PROVIDER,
            endpoint=endpoint,
            request_sha256=response.request_sha256,
            response_sha256=response.response_sha256,
            fetched_at=response.fetched_at,
            cache_hit=response.cache_hit,
            provider_metadata={
                **metadata,
                'api_contract_version': 'v2',
                'graph_version_exposed_by_provider': False,
                'schedule_version_exposed_by_provider': False,
                'documentation': DOCUMENTATION,
            },
        )

    def _parse_matrix(
        self,
        response: JsonResponse,
        origins: list[Coordinate],
        destinations: list[Coordinate],
        mode: TransportMode,
        departure_at: datetime,
    ) -> list[MatrixCell]:
        rows = response.payload.get('rows')
        if not isinstance(rows, list) or len(rows) != len(origins):
            raise ProviderResponseError('Yandex matrix row count does not match origins')
        provenance = self._provenance(response, MATRIX_ENDPOINT, {})
        cells: list[MatrixCell] = []
        for origin, row in zip(origins, rows, strict=True):
            elements = row.get('elements') if isinstance(row, dict) else None
            if not isinstance(elements, list) or len(elements) != len(destinations):
                raise ProviderResponseError('Yandex matrix element count does not match destinations')
            for destination, element in zip(destinations, elements, strict=True):
                cells.append(
                    self._parse_matrix_element(
                        element,
                        origin,
                        destination,
                        mode,
                        departure_at,
                        provenance,
                    )
                )
        return cells

    @staticmethod
    def _parse_matrix_element(
        element: Any,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        provenance: Provenance,
    ) -> MatrixCell:
        if not isinstance(element, dict):
            raise ProviderResponseError('Yandex matrix element must be an object')
        provider_status = str(element.get('status', 'MISSING'))
        if provider_status != 'OK':
            return MatrixCell(
                origin_id=origin.location_id,
                destination_id=destination.location_id,
                mode=mode,
                departure_at=departure_at,
                status=RouteStatus.UNKNOWN,
                duration_seconds=None,
                duration_minutes=None,
                distance_m=None,
                provider_status=provider_status,
                provenance=provenance,
            )
        try:
            duration_seconds = math.ceil(float(element['duration']['value']))
            distance_m = math.ceil(float(element['distance']['value']))
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            raise ProviderResponseError('Yandex OK matrix element lacks numeric duration/distance') from error
        if duration_seconds < 0 or distance_m < 0:
            raise ProviderResponseError('Yandex OK matrix element contains a negative value')
        return MatrixCell(
            origin_id=origin.location_id,
            destination_id=destination.location_id,
            mode=mode,
            departure_at=departure_at,
            status=RouteStatus.OK,
            duration_seconds=duration_seconds,
            duration_minutes=math.ceil(duration_seconds / 60),
            distance_m=distance_m,
            provider_status=provider_status,
            provenance=provenance,
        )

    def _parse_route(
        self,
        response: JsonResponse,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
    ) -> DetailedRoute:
        route = response.payload.get('route')
        legs = route.get('legs') if isinstance(route, dict) else None
        if not isinstance(legs, list) or not legs:
            raise ProviderResponseError('Yandex route response has no legs')
        provider_statuses = [str(leg.get('status', 'MISSING')) for leg in legs if isinstance(leg, dict)]
        provider_status = '|'.join(provider_statuses) if provider_statuses else 'MISSING'
        provenance = self._provenance(
            response,
            ROUTE_ENDPOINT,
            {
                'traffic_type': response.payload.get('traffic_type'),
                'route_flags': route.get('flags') if isinstance(route, dict) else None,
            },
        )
        if len(provider_statuses) != len(legs) or any(status != 'OK' for status in provider_statuses):
            return DetailedRoute(
                origin_id=origin.location_id,
                destination_id=destination.location_id,
                mode=mode,
                departure_at=departure_at,
                status=RouteStatus.UNKNOWN,
                duration_seconds=None,
                duration_minutes=None,
                distance_m=None,
                geometry=(),
                itinerary=(),
                provider_status=provider_status,
                provenance=provenance,
            )

        itinerary: list[RouteStep] = []
        geometry: list[tuple[float, float]] = []
        sequence = 0
        for leg_index, leg in enumerate(legs):
            steps = leg.get('steps')
            if not isinstance(steps, list) or not steps:
                raise ProviderResponseError(f'Yandex route leg {leg_index} has no steps')
            for step in steps:
                parsed = self._parse_step(step, sequence)
                itinerary.append(parsed)
                for point in parsed.geometry:
                    if not geometry or geometry[-1] != point:
                        geometry.append(point)
                sequence += 1

        self._validate_route_semantics(mode, response.payload.get('traffic_type'), itinerary)

        duration_seconds = math.ceil(sum(step.duration_seconds for step in itinerary))
        distance_m = math.ceil(sum(step.distance_m for step in itinerary))
        return DetailedRoute(
            origin_id=origin.location_id,
            destination_id=destination.location_id,
            mode=mode,
            departure_at=departure_at,
            status=RouteStatus.OK,
            duration_seconds=duration_seconds,
            duration_minutes=math.ceil(duration_seconds / 60),
            distance_m=distance_m,
            geometry=tuple(geometry),
            itinerary=tuple(itinerary),
            provider_status=provider_status,
            provenance=provenance,
        )

    @staticmethod
    def _validate_route_semantics(
        requested_mode: TransportMode,
        traffic_type: Any,
        itinerary: list[RouteStep],
    ) -> None:
        allowed_step_modes = {
            TransportMode.CAR: {'driving'},
            TransportMode.PUBLIC_TRANSIT: {'transit', 'walking'},
            TransportMode.BICYCLE: {'bicycle'},
            TransportMode.WALKING: {'walking'},
        }[requested_mode]
        unexpected = sorted({step.mode for step in itinerary} - allowed_step_modes)
        if unexpected:
            raise ProviderResponseError(
                f'Yandex returned unexpected step modes for {requested_mode.value}: {unexpected}'
            )
        if requested_mode == TransportMode.CAR and traffic_type not in {'realtime', 'forecast'}:
            raise ProviderResponseError(
                'CAR route is not time-dependent: traffic_type must be realtime or forecast'
            )

    @staticmethod
    def _parse_step(step: Any, sequence: int) -> RouteStep:
        if not isinstance(step, dict):
            raise ProviderResponseError('Yandex route step must be an object')
        try:
            duration_seconds = float(step['duration'])
            distance_m = float(step['length'])
            waiting_seconds = float(step.get('waiting_duration', 0))
            mode = str(step['mode'])
            raw_points = step['polyline']['points']
            geometry = tuple((float(point[0]), float(point[1])) for point in raw_points)
        except (KeyError, TypeError, ValueError, IndexError, OverflowError) as error:
            raise ProviderResponseError(f'Invalid Yandex route step at sequence {sequence}') from error
        numeric_values = (duration_seconds, distance_m, waiting_seconds)
        coordinates_valid = all(
            math.isfinite(latitude)
            and math.isfinite(longitude)
            and -90 <= latitude <= 90
            and -180 <= longitude <= 180
            for latitude, longitude in geometry
        )
        if (
            not all(math.isfinite(value) and value >= 0 for value in numeric_values)
            or not geometry
            or not coordinates_valid
        ):
            raise ProviderResponseError(f'Invalid negative/empty route step at sequence {sequence}')
        attributes = {
            key: value
            for key, value in step.items()
            if key not in {'duration', 'length', 'waiting_duration', 'mode', 'polyline'}
        }
        return RouteStep(
            sequence=sequence,
            mode=mode,
            duration_seconds=duration_seconds,
            distance_m=distance_m,
            waiting_seconds=waiting_seconds,
            geometry=geometry,
            attributes=attributes,
        )
