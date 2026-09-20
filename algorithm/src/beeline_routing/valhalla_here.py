from __future__ import annotations

from datetime import datetime

from .here import HereTransitRoutingClient
from .models import Coordinate, DetailedRoute, TransportMode
from .valhalla import ValhallaRoutingClient


class ValhallaHereRoutingClient:
    """Use HERE for scheduled transit and local Valhalla for all street modes."""

    def __init__(
        self,
        *,
        here: HereTransitRoutingClient,
        valhalla: ValhallaRoutingClient,
    ) -> None:
        self.here = here
        self.valhalla = valhalla

    def route(
        self,
        *,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> DetailedRoute:
        client = self.here if mode == TransportMode.PUBLIC_TRANSIT else self.valhalla
        return client.route(
            origin=origin,
            destination=destination,
            mode=mode,
            departure_at=departure_at,
            refresh=refresh,
        )
