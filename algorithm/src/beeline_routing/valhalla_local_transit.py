"""Free local road routing plus a frozen, auditable public transit timetable."""

from __future__ import annotations

from datetime import datetime

from .local_transit import LocalTransitRoutingClient
from .models import Coordinate, DetailedRoute, TransportMode
from .valhalla import ValhallaRoutingClient


class ValhallaLocalTransitRoutingClient:
    """Select the local timetable for transit and Valhalla for street travel."""

    def __init__(self, *, transit: LocalTransitRoutingClient,
                 valhalla: ValhallaRoutingClient) -> None:
        self.transit = transit
        self.valhalla = valhalla

    def route(self, *, origin: Coordinate, destination: Coordinate,
              mode: TransportMode, departure_at: datetime,
              refresh: bool = False) -> DetailedRoute:
        client = self.transit if mode == TransportMode.PUBLIC_TRANSIT else self.valhalla
        return client.route(origin=origin, destination=destination,
                            mode=mode, departure_at=departure_at, refresh=refresh)

    def close(self) -> None:
        """Close the SQLite connection owned by the local transit router."""
        self.transit.close()
