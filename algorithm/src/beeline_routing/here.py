from __future__ import annotations

import math
import os
from datetime import datetime
from typing import Any

from .errors import InvalidRoutingInput, MissingApiKey, ProviderResponseError
from .http import JsonHttpClient, JsonResponse
from .models import Coordinate, DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode


PROVIDER = 'HERE_PUBLIC_TRANSIT_V8'
ROUTING_ENDPOINT = 'https://transit.router.hereapi.com/v8/routes'
LIMITED_PLAN_DAILY_REQUESTS = 1_000
DEFAULT_HARD_LIMIT = 900
_FLEX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
_FLEX_DECODE = {character: index for index, character in enumerate(_FLEX_ALPHABET)}


class HereTransitRoutingClient:
    """Detailed, timetable-aware HERE public transport routing with auditable caching."""

    def __init__(
        self,
        http: JsonHttpClient,
        api_key: str | None = None,
        *,
        hard_limit: int = DEFAULT_HARD_LIMIT,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get('HERE_API_KEY')
        if key is None or not key.strip():
            raise MissingApiKey('Set HERE_API_KEY; the key is never written to cache or output')
        if not 1 <= hard_limit < LIMITED_PLAN_DAILY_REQUESTS:
            raise InvalidRoutingInput(
                f'HERE hard limit must stay below the {LIMITED_PLAN_DAILY_REQUESTS} daily limited-plan limit'
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
        self._validate_request(origin, destination, mode, departure_at)
        public_parameters = {
            'origin': origin.as_provider_value(),
            'destination': destination.as_provider_value(),
            'departureTime': departure_at.isoformat(),
            'alternatives': 0,
            'lang': 'ru-RU',
            'units': 'metric',
            'return': 'polyline,intermediate,actions,travelSummary,sourceFeedMapping',
        }
        request_sha256, _ = self.http.cache.request_hash(
            PROVIDER, ROUTING_ENDPOINT, public_parameters
        )

        def reserve_request() -> None:
            self.http.usage_ledger.reserve_usage(
                provider=PROVIDER,
                metric='public_transit_requests',
                units=1,
                hard_limit=self.hard_limit,
                request_sha256=request_sha256,
            )

        response = self.http.get_json(
            provider=PROVIDER,
            endpoint=ROUTING_ENDPOINT,
            public_parameters=public_parameters,
            secret_parameters={'apiKey': self._api_key},
            before_network=reserve_request,
            validate_payload=self._validate_payload,
            refresh=refresh,
        )
        return self._parse(response, origin, destination, departure_at)

    @staticmethod
    def _validate_request(
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
    ) -> None:
        if mode != TransportMode.PUBLIC_TRANSIT:
            raise InvalidRoutingInput('HERE Public Transit client accepts only PUBLIC_TRANSIT')
        if origin.location_id == destination.location_id:
            raise InvalidRoutingInput('Self-arcs are forbidden for detailed HERE routes')
        if departure_at.tzinfo is None or departure_at.utcoffset() is None:
            raise InvalidRoutingInput('departure_at must include a timezone')
        if departure_at.microsecond != 0:
            raise InvalidRoutingInput('HERE departure_at must use whole seconds')

    @staticmethod
    def _validate_payload(payload: Any, request_sha256: str) -> None:
        if not isinstance(payload, dict):
            raise ProviderResponseError(
                f'HERE response must be an object; request_sha256={request_sha256}'
            )
        routes = payload.get('routes')
        if routes is not None and not isinstance(routes, list):
            raise ProviderResponseError(
                f'HERE routes must be an array; request_sha256={request_sha256}'
            )

    def _parse(
        self,
        response: JsonResponse,
        origin: Coordinate,
        destination: Coordinate,
        departure_at: datetime,
    ) -> DetailedRoute:
        payload = response.payload
        routes = payload.get('routes', [])
        provenance = Provenance(
            provider=PROVIDER,
            endpoint=ROUTING_ENDPOINT,
            request_sha256=response.request_sha256,
            response_sha256=response.response_sha256,
            fetched_at=response.fetched_at,
            cache_hit=response.cache_hit,
            provider_metadata={
                'api_version': 'v8',
                'schedule_aware': True,
                'requested_departure_at': departure_at.isoformat(),
                'returned_routes': len(routes),
                'route_selection': 'provider_rank_1',
            },
        )
        if not routes:
            return DetailedRoute(
                origin.location_id,
                destination.location_id,
                TransportMode.PUBLIC_TRANSIT,
                departure_at,
                RouteStatus.UNREACHABLE,
                None,
                None,
                None,
                (),
                (),
                'NO_ROUTE',
                provenance,
            )
        first_route = routes[0]
        if not isinstance(first_route, dict):
            raise ProviderResponseError('HERE route must be an object')
        sections = first_route.get('sections')
        if not isinstance(sections, list) or not sections:
            raise ProviderResponseError('HERE route lacks sections')

        geometry: list[tuple[float, float]] = []
        itinerary: list[RouteStep] = []
        total_distance = 0
        previous_arrival = departure_at
        final_arrival: datetime | None = None
        for sequence, section in enumerate(sections):
            if not isinstance(section, dict):
                raise ProviderResponseError('HERE section must be an object')
            departure = _section_time(section, 'departure')
            arrival = _section_time(section, 'arrival')
            if arrival < departure or departure < previous_arrival:
                raise ProviderResponseError('HERE section times are inconsistent')
            waiting_seconds = (departure - previous_arrival).total_seconds()
            duration_seconds = (arrival - departure).total_seconds()
            travel_summary = section.get('travelSummary')
            if not isinstance(travel_summary, dict):
                raise ProviderResponseError('HERE section lacks travelSummary')
            try:
                distance_m = float(travel_summary['length'])
            except (KeyError, TypeError, ValueError, OverflowError) as error:
                raise ProviderResponseError('HERE section has invalid travel distance') from error
            if not math.isfinite(distance_m) or distance_m < 0:
                raise ProviderResponseError('HERE section travel distance is negative or non-finite')
            encoded_polyline = section.get('polyline')
            if not isinstance(encoded_polyline, str) or not encoded_polyline:
                raise ProviderResponseError('HERE section lacks polyline')
            section_geometry = _decode_flexible_polyline(encoded_polyline)
            if len(section_geometry) < 2:
                raise ProviderResponseError('HERE section polyline has fewer than two points')
            if geometry and geometry[-1] == section_geometry[0]:
                geometry.extend(section_geometry[1:])
            else:
                geometry.extend(section_geometry)
            transport = section.get('transport')
            if not isinstance(transport, dict) or not isinstance(transport.get('mode'), str):
                raise ProviderResponseError('HERE section lacks transport mode')
            itinerary.append(
                RouteStep(
                    sequence=sequence,
                    mode=transport['mode'],
                    duration_seconds=duration_seconds,
                    distance_m=distance_m,
                    waiting_seconds=waiting_seconds,
                    geometry=section_geometry,
                    attributes={
                        'section_type': section.get('type'),
                        'departure_at': departure.isoformat(),
                        'arrival_at': arrival.isoformat(),
                        'transport': transport,
                        'agency': section.get('agency'),
                        'intermediate_stops': section.get('intermediateStops', []),
                        'actions': section.get('actions', []),
                    },
                )
            )
            total_distance += math.ceil(distance_m)
            previous_arrival = arrival
            final_arrival = arrival
        if final_arrival is None:
            raise ProviderResponseError('HERE route has no final arrival')
        total_duration = math.ceil((final_arrival - departure_at).total_seconds())
        if total_duration < 0 or not geometry or not itinerary:
            raise ProviderResponseError('HERE route contains invalid total metrics')
        return DetailedRoute(
            origin.location_id,
            destination.location_id,
            TransportMode.PUBLIC_TRANSIT,
            departure_at,
            RouteStatus.OK,
            total_duration,
            math.ceil(total_duration / 60),
            total_distance,
            tuple(geometry),
            tuple(itinerary),
            'OK',
            provenance,
        )


def _section_time(section: dict[str, Any], name: str) -> datetime:
    value = section.get(name)
    if not isinstance(value, dict) or not isinstance(value.get('time'), str):
        raise ProviderResponseError(f'HERE section lacks {name}.time')
    try:
        parsed = datetime.fromisoformat(value['time'].replace('Z', '+00:00'))
    except ValueError as error:
        raise ProviderResponseError(f'HERE section has invalid {name}.time') from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ProviderResponseError(f'HERE section {name}.time lacks timezone')
    return parsed


def _decode_flexible_polyline(value: str) -> tuple[tuple[float, float], ...]:
    """Decode HERE Flexible Polyline v1 into latitude/longitude pairs."""
    values: list[int] = []
    index = 0
    while index < len(value):
        result = shift = 0
        while True:
            if index >= len(value):
                raise ProviderResponseError('HERE flexible polyline is truncated')
            try:
                chunk = _FLEX_DECODE[value[index]]
            except KeyError as error:
                raise ProviderResponseError('HERE flexible polyline has an invalid character') from error
            index += 1
            result |= (chunk & 0x1F) << shift
            if not chunk & 0x20:
                break
            shift += 5
            if shift > 60:
                raise ProviderResponseError('HERE flexible polyline value is too large')
        values.append(result)
    if len(values) < 2 or values[0] != 1:
        raise ProviderResponseError('Unsupported HERE flexible polyline version')
    header = values[1]
    precision = header & 0x0F
    third_dimension = (header >> 4) & 0x07
    dimensions = 3 if third_dimension else 2
    encoded = values[2:]
    if len(encoded) % dimensions:
        raise ProviderResponseError('HERE flexible polyline coordinate count is invalid')

    factor = 10**precision
    latitude = longitude = 0
    coordinates: list[tuple[float, float]] = []
    for offset in range(0, len(encoded), dimensions):
        latitude += _decode_signed(encoded[offset])
        longitude += _decode_signed(encoded[offset + 1])
        coordinates.append((latitude / factor, longitude / factor))
    return tuple(coordinates)


def _decode_signed(value: int) -> int:
    return ~(value >> 1) if value & 1 else value >> 1
