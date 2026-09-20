"""Persistent cache for expensive exact public-transit route calculations."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .cache import RoutingCache
from .export import detailed_route_dict
from .interfaces import DetailedRoutingClient
from .models import (
    Coordinate,
    DetailedRoute,
    Provenance,
    RouteStatus,
    RouteStep,
    TransportMode,
)


def _route_from_dict(payload: dict[str, Any], *, cache_hit: bool) -> DetailedRoute:
    provenance = payload['provenance']
    return DetailedRoute(
        origin_id=payload['origin_id'],
        destination_id=payload['destination_id'],
        mode=TransportMode(payload['mode']),
        departure_at=datetime.fromisoformat(payload['departure_at']),
        status=RouteStatus(payload['status']),
        duration_seconds=payload['duration_seconds'],
        duration_minutes=payload['duration_minutes'],
        distance_m=payload['distance_m'],
        geometry=tuple(tuple(point) for point in payload['geometry']),
        itinerary=tuple(
            RouteStep(
                sequence=step['sequence'],
                mode=step['mode'],
                duration_seconds=step['duration_seconds'],
                distance_m=step['distance_m'],
                waiting_seconds=step['waiting_seconds'],
                geometry=tuple(tuple(point) for point in step['geometry']),
                attributes=step['attributes'],
            )
            for step in payload['itinerary']
        ),
        provider_status=payload['provider_status'],
        provenance=Provenance(
            provider=provenance['provider'],
            endpoint=provenance['endpoint'],
            request_sha256=provenance['request_sha256'],
            response_sha256=provenance['response_sha256'],
            fetched_at=provenance['fetched_at'],
            cache_hit=cache_hit,
            provider_metadata=provenance['provider_metadata'],
        ),
    )


class MemoizedTransitRoutingClient:
    """Cache exact transit results, including locally computed itineraries, in SQLite."""

    def __init__(
        self,
        delegate: DetailedRoutingClient,
        cache: RoutingCache,
        *,
        namespace: str,
    ) -> None:
        self.delegate = delegate
        self.cache = cache
        self.namespace = namespace

    def route(
        self,
        *,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> DetailedRoute:
        """Return a persistent cached transit route or calculate and store it."""
        if mode != TransportMode.PUBLIC_TRANSIT:
            return self.delegate.route(
                origin=origin,
                destination=destination,
                mode=mode,
                departure_at=departure_at,
                refresh=refresh,
            )
        parameters = {
            'namespace': self.namespace,
            'origin': [origin.location_id, origin.latitude, origin.longitude],
            'destination': [
                destination.location_id,
                destination.latitude,
                destination.longitude,
            ],
            'mode': mode.value,
            'departure_at': departure_at.isoformat(),
        }
        request_sha256, request_json = self.cache.request_hash(
            'LOCAL_TRANSIT_EXACT',
            'computed-route-v2',
            parameters,
        )
        if not refresh:
            cached = self.cache.get(request_sha256)
            if cached is not None:
                return _route_from_dict(cached.response, cache_hit=True)
        route = self.delegate.route(
            origin=origin,
            destination=destination,
            mode=mode,
            departure_at=departure_at,
            refresh=refresh,
        )
        if route.status != RouteStatus.UNKNOWN:
            self.cache.put(
                request_sha256=request_sha256,
                provider='LOCAL_TRANSIT_EXACT',
                endpoint='computed-route-v2',
                request_json=request_json,
                response=detailed_route_dict(route),
                http_status=200,
                replace=refresh,
            )
        return route

    def close(self) -> None:
        """Close the wrapped local router if it owns resources."""
        close = getattr(self.delegate, 'close', None)
        if close is not None:
            close()
