from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any

from .errors import InvalidRoutingInput


class TransportMode(StrEnum):
    CAR = 'CAR'
    PUBLIC_TRANSIT = 'PUBLIC_TRANSIT'
    BICYCLE = 'BICYCLE'
    WALKING = 'WALKING'


class RouteStatus(StrEnum):
    OK = 'OK'
    UNREACHABLE = 'UNREACHABLE'
    UNKNOWN = 'UNKNOWN'


@dataclass(frozen=True, slots=True)
class Coordinate:
    location_id: str
    latitude: float
    longitude: float

    def __post_init__(self) -> None:
        if not self.location_id.strip():
            raise InvalidRoutingInput('location_id must not be empty')
        if not math.isfinite(self.latitude) or not -90 <= self.latitude <= 90:
            raise InvalidRoutingInput(f'Invalid latitude for {self.location_id}: {self.latitude}')
        if not math.isfinite(self.longitude) or not -180 <= self.longitude <= 180:
            raise InvalidRoutingInput(f'Invalid longitude for {self.location_id}: {self.longitude}')
        if self.latitude == 0 and self.longitude == 0:
            raise InvalidRoutingInput(f'Coordinates 0,0 are forbidden for {self.location_id}')

    def as_provider_value(self) -> str:
        return f'{self.latitude!r},{self.longitude!r}'


@dataclass(frozen=True, slots=True)
class Provenance:
    provider: str
    endpoint: str
    request_sha256: str
    response_sha256: str
    fetched_at: str
    cache_hit: bool
    provider_metadata: dict[str, Any]


@dataclass(frozen=True, slots=True)
class MatrixCell:
    origin_id: str
    destination_id: str
    mode: TransportMode
    departure_at: datetime
    status: RouteStatus
    duration_seconds: int | None
    duration_minutes: int | None
    distance_m: int | None
    provider_status: str
    provenance: Provenance

    def __post_init__(self) -> None:
        if self.departure_at.tzinfo is None:
            raise InvalidRoutingInput('departure_at must include a timezone')
        values = (self.duration_seconds, self.duration_minutes, self.distance_m)
        if self.status == RouteStatus.OK:
            if any(value is None for value in values):
                raise InvalidRoutingInput('OK matrix cell must contain duration and distance')
            if any(value < 0 for value in values if value is not None):
                raise InvalidRoutingInput('Duration and distance must be non-negative')
        elif any(value is not None for value in values):
            raise InvalidRoutingInput('Non-OK matrix cell must not contain plausible numeric values')


@dataclass(frozen=True, slots=True)
class RouteStep:
    sequence: int
    mode: str
    duration_seconds: float
    distance_m: float
    waiting_seconds: float
    geometry: tuple[tuple[float, float], ...]
    attributes: dict[str, Any]


@dataclass(frozen=True, slots=True)
class DetailedRoute:
    origin_id: str
    destination_id: str
    mode: TransportMode
    departure_at: datetime
    status: RouteStatus
    duration_seconds: int | None
    duration_minutes: int | None
    distance_m: int | None
    geometry: tuple[tuple[float, float], ...]
    itinerary: tuple[RouteStep, ...]
    provider_status: str
    provenance: Provenance

    def __post_init__(self) -> None:
        if self.departure_at.tzinfo is None:
            raise InvalidRoutingInput('departure_at must include a timezone')
        if self.status == RouteStatus.OK:
            if self.duration_seconds is None or self.duration_minutes is None or self.distance_m is None:
                raise InvalidRoutingInput('OK route must contain duration and distance')
            if self.duration_seconds < 0 or self.duration_minutes < 0 or self.distance_m < 0:
                raise InvalidRoutingInput('Duration and distance must be non-negative')
            if not self.itinerary:
                raise InvalidRoutingInput('OK route must contain an itinerary')
            if not self.geometry:
                raise InvalidRoutingInput('OK route must contain geometry')
        elif any(value is not None for value in (self.duration_seconds, self.duration_minutes, self.distance_m)):
            raise InvalidRoutingInput('Non-OK route must not contain plausible numeric values')
