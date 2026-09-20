from __future__ import annotations

from datetime import datetime

from .dgis import DgisRoutingClient
from .mapbox import MapboxRoutingClient
from .models import Coordinate, DetailedRoute, TransportMode


class HybridRoutingClient:
    """Dispatch exact routes to the provider best suited to each mode."""

    def __init__(self, *, dgis: DgisRoutingClient, mapbox: MapboxRoutingClient) -> None:
        self.dgis = dgis
        self.mapbox = mapbox

    def route(
        self,
        *,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> DetailedRoute:
        client = (
            self.dgis
            if mode
            in {
                TransportMode.CAR,
                TransportMode.PUBLIC_TRANSIT,
                TransportMode.WALKING,
            }
            else self.mapbox
        )
        return client.route(
            origin=origin,
            destination=destination,
            mode=mode,
            departure_at=departure_at,
            refresh=refresh,
        )
