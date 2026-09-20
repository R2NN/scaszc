from __future__ import annotations

import math
import os
import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .errors import InvalidRoutingInput, MissingApiKey, ProviderAccessSuspended, ProviderResponseError
from .http import JsonHttpClient, JsonResponse
from .models import Coordinate, DetailedRoute, MatrixCell, Provenance, RouteStatus, RouteStep, TransportMode


PROVIDER = 'MAPBOX_NAVIGATION_V5'
MATRIX_BASE = 'https://api.mapbox.com/directions-matrix/v1/mapbox'
DIRECTIONS_BASE = 'https://api.mapbox.com/directions/v5/mapbox'
FREE_MATRIX_ELEMENTS = 100_000
DEFAULT_MATRIX_HARD_LIMIT = 80_000
DEFAULT_DIRECTIONS_HARD_LIMIT = 10_000
DEFAULT_ACCOUNT_POLICY_PATH = Path(__file__).resolve().parents[2] / 'work' / 'routing' / 'mapbox_account_policy.json'

PROFILE_MAP = {
    TransportMode.CAR: 'driving-traffic',
    TransportMode.BICYCLE: 'cycling',
    TransportMode.WALKING: 'walking',
}

MATRIX_PROFILE_MAP = {
    TransportMode.CAR: 'driving',
    TransportMode.BICYCLE: 'cycling',
    TransportMode.WALKING: 'walking',
}


class MapboxRoutingClient:
    """Mapbox-клиент с локальным fail-closed ограничителем платных единиц."""

    def __init__(
        self,
        http: JsonHttpClient,
        access_token: str | None = None,
        *,
        matrix_hard_limit: int = DEFAULT_MATRIX_HARD_LIMIT,
        directions_hard_limit: int = DEFAULT_DIRECTIONS_HARD_LIMIT,
        beta_depart_at_enabled: bool = False,
        network_gate: Callable[[], None] | None = None,
        account_policy_path: Path | None = DEFAULT_ACCOUNT_POLICY_PATH,
    ) -> None:
        token = access_token if access_token is not None else os.environ.get('MAPBOX_ACCESS_TOKEN')
        if token is None or not token.strip():
            raise MissingApiKey('Set MAPBOX_ACCESS_TOKEN; the token is never written to cache or output')
        if not 1 <= matrix_hard_limit < FREE_MATRIX_ELEMENTS:
            raise InvalidRoutingInput(
                f'Mapbox matrix hard limit must stay below the {FREE_MATRIX_ELEMENTS} free tier'
            )
        if not 1 <= directions_hard_limit < 100_000:
            raise InvalidRoutingInput('Mapbox directions hard limit must stay below the free tier')
        self.http = http
        self._access_token = token.strip()
        self.matrix_hard_limit = matrix_hard_limit
        self.directions_hard_limit = directions_hard_limit
        self.beta_depart_at_enabled = beta_depart_at_enabled
        self.network_gate = network_gate
        self.account_policy_path = account_policy_path

    def matrix(
        self,
        *,
        origins: list[Coordinate],
        destinations: list[Coordinate],
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> list[MatrixCell]:
        self._validate_common_request(origins, destinations, mode, departure_at)
        if len(origins) * len(destinations) < 2:
            raise InvalidRoutingInput(
                'Mapbox Matrix API requires at least two returned matrix elements; '
                'use Directions API for a single origin/destination pair'
            )
        profile = MATRIX_PROFILE_MAP[mode]
        points, source_indexes, destination_indexes = self._combined_points(origins, destinations)
        max_coordinates = 25
        if len(points) > max_coordinates:
            raise InvalidRoutingInput(
                f'Mapbox {profile} matrix accepts at most {max_coordinates} unique coordinates; '
                f'got {len(points)}'
            )
        endpoint = f'{MATRIX_BASE}/{profile}/{self._coordinate_path(points)}'
        parameters: dict[str, Any] = {
            'sources': ';'.join(map(str, source_indexes)),
            'destinations': ';'.join(map(str, destination_indexes)),
            'annotations': 'duration,distance',
        }
        request_sha256, _ = self.http.cache.request_hash(PROVIDER, endpoint, parameters)
        units = len(origins) * len(destinations)
        response = self.http.get_json(
            provider=PROVIDER,
            endpoint=endpoint,
            public_parameters=parameters,
            secret_parameters={'access_token': self._access_token},
            before_network=lambda: self._reserve_network_usage(
                metric='matrix_elements',
                units=units,
                hard_limit=self.matrix_hard_limit,
                request_sha256=request_sha256,
            ),
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
        self._validate_common_request([origin], [destination], mode, departure_at)
        self._validate_detailed_route_time(mode, departure_at)
        profile = PROFILE_MAP[mode]
        endpoint = f'{DIRECTIONS_BASE}/{profile}/{self._coordinate_path([origin, destination])}'
        parameters: dict[str, Any] = {
            'alternatives': 'false',
            'geometries': 'geojson',
            'overview': 'full',
            'steps': 'true',
        }
        self._add_departure_time(parameters, mode, departure_at)
        request_sha256, _ = self.http.cache.request_hash(PROVIDER, endpoint, parameters)
        response = self.http.get_json(
            provider=PROVIDER,
            endpoint=endpoint,
            public_parameters=parameters,
            secret_parameters={'access_token': self._access_token},
            before_network=lambda: self._reserve_network_usage(
                metric='directions_requests',
                units=1,
                hard_limit=self.directions_hard_limit,
                request_sha256=request_sha256,
            ),
            validate_payload=self._validate_payload,
            refresh=refresh,
        )
        return self._parse_route(response, origin, destination, mode, departure_at)

    def _reserve_network_usage(
        self, *, metric: str, units: int, hard_limit: int, request_sha256: str
    ) -> None:
        self._assert_account_network_allowed()
        if self.network_gate is not None:
            self.network_gate()
        self.http.usage_ledger.reserve_usage(
            provider=PROVIDER,
            metric=metric,
            units=units,
            hard_limit=hard_limit,
            request_sha256=request_sha256,
        )

    def _assert_account_network_allowed(self) -> None:
        """Fail closed before any uncached Mapbox request, including after monthly resets."""
        if self.account_policy_path is None:
            return  # Explicit injection for isolated tests using a fake HTTP opener.
        try:
            policy = json.loads(self.account_policy_path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ProviderAccessSuspended(
                'Mapbox network disabled: account policy is missing or unreadable'
            ) from error
        if not isinstance(policy, dict) or policy.get('status') != 'AUTHORIZED':
            raise ProviderAccessSuspended(
                'Mapbox network disabled: account reports usage limit and API requests suspended'
            )

    def _validate_common_request(
        self,
        origins: list[Coordinate],
        destinations: list[Coordinate],
        mode: TransportMode,
        departure_at: datetime,
    ) -> None:
        if mode == TransportMode.PUBLIC_TRANSIT:
            raise InvalidRoutingInput('Mapbox does not support public-transit routing')
        if not origins or not destinations:
            raise InvalidRoutingInput('Origins and destinations must not be empty')
        if departure_at.tzinfo is None or departure_at.utcoffset() is None:
            raise InvalidRoutingInput('departure_at must include a timezone')
        if departure_at.microsecond != 0:
            raise InvalidRoutingInput('Mapbox departure_at must use whole seconds')

    def _validate_detailed_route_time(
        self, mode: TransportMode, departure_at: datetime
    ) -> None:
        if mode == TransportMode.CAR and departure_at.astimezone(UTC) < datetime.now(UTC):
            raise InvalidRoutingInput(
                'Mapbox driving-traffic does not accept a departure time in the past; '
                'substituting another date is forbidden'
            )
        if mode == TransportMode.CAR and not self.beta_depart_at_enabled:
            raise InvalidRoutingInput(
                'Mapbox depart_at is a gated beta and is not enabled for this client; '
                'use 2GIS statistical traffic or explicitly enable the beta after Mapbox approval'
            )

    @staticmethod
    def _add_departure_time(
        parameters: dict[str, Any], mode: TransportMode, departure_at: datetime
    ) -> None:
        if mode == TransportMode.CAR:
            parameters['depart_at'] = departure_at.isoformat(timespec='seconds')

    @staticmethod
    def _combined_points(
        origins: list[Coordinate], destinations: list[Coordinate]
    ) -> tuple[list[Coordinate], list[int], list[int]]:
        points: list[Coordinate] = []
        indexes: dict[tuple[str, float, float], int] = {}

        def index(point: Coordinate) -> int:
            key = (point.location_id, point.latitude, point.longitude)
            if key not in indexes:
                indexes[key] = len(points)
                points.append(point)
            return indexes[key]

        source_indexes = [index(point) for point in origins]
        destination_indexes = [index(point) for point in destinations]
        return points, source_indexes, destination_indexes

    @staticmethod
    def _coordinate_path(points: list[Coordinate]) -> str:
        return ';'.join(f'{point.longitude!r},{point.latitude!r}' for point in points)

    @staticmethod
    def _validate_payload(payload: Any, request_sha256: str) -> None:
        if not isinstance(payload, dict):
            raise ProviderResponseError('Mapbox response root must be an object')
        code = payload.get('code')
        if code not in {'Ok', 'NoRoute'}:
            raise ProviderResponseError(
                f'Mapbox returned code={code!r}; request_sha256={request_sha256}'
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
                'api_contract_version': 'v5',
                'graph_version_exposed_by_provider': False,
                'traffic_version_exposed_by_provider': False,
                'documentation': {
                    'matrix': 'https://docs.mapbox.com/api/navigation/matrix/',
                    'directions': 'https://docs.mapbox.com/api/navigation/directions/',
                    'pricing': 'https://www.mapbox.com/pricing',
                },
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
        payload = response.payload
        profile = MATRIX_PROFILE_MAP[mode]
        endpoint = f'{MATRIX_BASE}/{profile}'
        provenance = self._provenance(
            response,
            endpoint,
            {
                'profile': profile,
                'purpose': 'SCREENING_ONLY',
                'departure_time_honored': False,
                'traffic_model': None,
            },
        )
        if payload.get('code') == 'NoRoute':
            return [
                self._unreachable_cell(origin, destination, mode, departure_at, provenance, 'NoRoute')
                for origin in origins
                for destination in destinations
            ]
        durations = payload.get('durations')
        distances = payload.get('distances')
        if not isinstance(durations, list) or not isinstance(distances, list):
            raise ProviderResponseError('Mapbox matrix lacks duration/distance arrays')
        if len(durations) != len(origins) or len(distances) != len(origins):
            raise ProviderResponseError('Mapbox matrix row count does not match origins')
        cells: list[MatrixCell] = []
        for row_index, origin in enumerate(origins):
            duration_row = durations[row_index]
            distance_row = distances[row_index]
            if (
                not isinstance(duration_row, list)
                or not isinstance(distance_row, list)
                or len(duration_row) != len(destinations)
                or len(distance_row) != len(destinations)
            ):
                raise ProviderResponseError('Mapbox matrix column count does not match destinations')
            for destination, raw_duration, raw_distance in zip(
                destinations, duration_row, distance_row, strict=True
            ):
                if raw_duration is None or raw_distance is None:
                    cells.append(
                        self._unreachable_cell(
                            origin, destination, mode, departure_at, provenance, 'null'
                        )
                    )
                    continue
                duration_seconds = self._non_negative_ceiling(raw_duration, 'duration')
                distance_m = self._non_negative_ceiling(raw_distance, 'distance')
                cells.append(
                    MatrixCell(
                        origin_id=origin.location_id,
                        destination_id=destination.location_id,
                        mode=mode,
                        departure_at=departure_at,
                        status=RouteStatus.OK,
                        duration_seconds=duration_seconds,
                        duration_minutes=math.ceil(duration_seconds / 60),
                        distance_m=distance_m,
                        provider_status='Ok',
                        provenance=provenance,
                    )
                )
        return cells

    @staticmethod
    def _unreachable_cell(
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        provenance: Provenance,
        provider_status: str,
    ) -> MatrixCell:
        return MatrixCell(
            origin_id=origin.location_id,
            destination_id=destination.location_id,
            mode=mode,
            departure_at=departure_at,
            status=RouteStatus.UNREACHABLE,
            duration_seconds=None,
            duration_minutes=None,
            distance_m=None,
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
        profile = PROFILE_MAP[mode]
        endpoint = f'{DIRECTIONS_BASE}/{profile}'
        provenance = self._provenance(response, endpoint, {'profile': profile})
        if response.payload.get('code') == 'NoRoute':
            return DetailedRoute(
                origin.location_id,
                destination.location_id,
                mode,
                departure_at,
                RouteStatus.UNREACHABLE,
                None,
                None,
                None,
                (),
                (),
                'NoRoute',
                provenance,
            )
        routes = response.payload.get('routes')
        if not isinstance(routes, list) or not routes or not isinstance(routes[0], dict):
            raise ProviderResponseError('Mapbox Ok response contains no routes')
        route = routes[0]
        geometry = self._parse_geojson_geometry(route.get('geometry'))
        legs = route.get('legs')
        if not isinstance(legs, list) or not legs:
            raise ProviderResponseError('Mapbox route contains no legs')
        itinerary: list[RouteStep] = []
        sequence = 0
        for leg in legs:
            steps = leg.get('steps') if isinstance(leg, dict) else None
            if not isinstance(steps, list) or not steps:
                raise ProviderResponseError('Mapbox route leg contains no steps')
            for step in steps:
                if not isinstance(step, dict):
                    raise ProviderResponseError('Mapbox route step must be an object')
                step_geometry = self._parse_geojson_geometry(step.get('geometry'))
                itinerary.append(
                    RouteStep(
                        sequence=sequence,
                        mode=profile,
                        duration_seconds=float(self._non_negative_number(step.get('duration'), 'duration')),
                        distance_m=float(self._non_negative_number(step.get('distance'), 'distance')),
                        waiting_seconds=0.0,
                        geometry=step_geometry,
                        attributes={
                            key: value
                            for key, value in step.items()
                            if key not in {'duration', 'distance', 'geometry'}
                        },
                    )
                )
                sequence += 1
        duration_seconds = self._non_negative_ceiling(route.get('duration'), 'duration')
        distance_m = self._non_negative_ceiling(route.get('distance'), 'distance')
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
            tuple(itinerary),
            'Ok',
            provenance,
        )

    @staticmethod
    def _parse_geojson_geometry(value: Any) -> tuple[tuple[float, float], ...]:
        coordinates = value.get('coordinates') if isinstance(value, dict) else None
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            raise ProviderResponseError('Mapbox detailed geometry is missing')
        try:
            result = tuple((float(point[1]), float(point[0])) for point in coordinates)
        except (TypeError, ValueError, IndexError) as error:
            raise ProviderResponseError('Mapbox geometry contains invalid coordinates') from error
        if not all(
            math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180
            for lat, lon in result
        ):
            raise ProviderResponseError('Mapbox geometry contains out-of-range coordinates')
        return result

    @staticmethod
    def _non_negative_number(value: Any, field: str) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError) as error:
            raise ProviderResponseError(f'Mapbox {field} is not numeric') from error
        if not math.isfinite(number) or number < 0:
            raise ProviderResponseError(f'Mapbox {field} is negative or non-finite')
        return number

    @classmethod
    def _non_negative_ceiling(cls, value: Any, field: str) -> int:
        return math.ceil(cls._non_negative_number(value, field))
