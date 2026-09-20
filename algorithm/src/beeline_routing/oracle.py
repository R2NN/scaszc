from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .errors import CacheFrozen, InvalidRoutingInput, RoutingIncomplete
from .interfaces import DetailedRoutingClient
from .models import Coordinate, DetailedRoute, RouteStatus, TransportMode


@dataclass(frozen=True, slots=True)
class OracleQuery:
    mode: TransportMode
    origin: Coordinate
    destination: Coordinate
    departure_at: datetime

    def __post_init__(self) -> None:
        if self.departure_at.tzinfo is None or self.departure_at.utcoffset() is None:
            raise InvalidRoutingInput('Oracle departure_at must include a timezone')
        if self.departure_at.second != 0 or self.departure_at.microsecond != 0:
            raise InvalidRoutingInput(
                'The formal model uses integer minutes; oracle departure_at must be minute-aligned'
            )
        if self.origin.location_id == self.destination.location_id:
            raise InvalidRoutingInput('Self-arcs are forbidden in the routing oracle')


class ExactRoutingOracle:
    """Авторитетная реализация R(m,u,v,t) через детальный маршрут провайдера."""

    def __init__(self, client: DetailedRoutingClient) -> None:
        self.client = client

    def query(self, request: OracleQuery, *, refresh: bool = False) -> DetailedRoute:
        try:
            route = self.client.route(
                origin=request.origin,
                destination=request.destination,
                mode=request.mode,
                departure_at=request.departure_at,
                refresh=refresh,
            )
        except CacheFrozen as error:
            raise RoutingIncomplete(
                'Frozen routing snapshot does not contain required exact query: '
                f'mode={request.mode.value}, origin={request.origin.location_id}, '
                f'destination={request.destination.location_id}, '
                f'departure_at={request.departure_at.isoformat()}'
            ) from error
        self._verify_contract(route, request)
        return route

    @staticmethod
    def require_reachable(route: DetailedRoute) -> DetailedRoute:
        if route.status == RouteStatus.UNKNOWN:
            raise RoutingIncomplete(
                'Routing provider did not produce a trustworthy answer: '
                f'mode={route.mode.value}, origin={route.origin_id}, '
                f'destination={route.destination_id}, departure_at={route.departure_at.isoformat()}, '
                f'provider_status={route.provider_status}'
            )
        return route

    @staticmethod
    def _verify_contract(route: DetailedRoute, request: OracleQuery) -> None:
        expected = (
            request.origin.location_id,
            request.destination.location_id,
            request.mode,
            request.departure_at,
        )
        actual = (route.origin_id, route.destination_id, route.mode, route.departure_at)
        if actual != expected:
            raise RoutingIncomplete(f'Routing response identity mismatch: expected={expected}, actual={actual}')
        if route.status == RouteStatus.OK:
            if not route.itinerary or not route.geometry:
                raise RoutingIncomplete('OK routing response lacks itinerary or geometry')
            if route.duration_seconds is None or route.duration_minutes is None:
                raise RoutingIncomplete('OK routing response lacks duration')
            if route.duration_minutes != (route.duration_seconds + 59) // 60:
                raise RoutingIncomplete('Routing duration violates ceiling-to-minute policy')
