from __future__ import annotations

from datetime import datetime

from .dgis import DgisRoutingClient
from .models import Coordinate, DetailedRoute, TransportMode
from .valhalla import ValhallaRoutingClient


class Valhalla2GisRoutingClient:
    """Use local Valhalla for active modes and 2GIS for time-dependent final checks."""

    def __init__(self, *, dgis: DgisRoutingClient, valhalla: ValhallaRoutingClient) -> None:
        self.dgis = dgis
        self.valhalla = valhalla

    def route(self, *, origin: Coordinate, destination: Coordinate, mode: TransportMode,
              departure_at: datetime, refresh: bool = False) -> DetailedRoute:
        client = self.dgis if mode in {TransportMode.CAR, TransportMode.PUBLIC_TRANSIT} else self.valhalla
        return client.route(origin=origin, destination=destination, mode=mode,
                            departure_at=departure_at, refresh=refresh)
