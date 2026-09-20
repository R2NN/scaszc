from __future__ import annotations

from datetime import datetime
from typing import Protocol

from .models import Coordinate, DetailedRoute, MatrixCell, TransportMode


class DetailedRoutingClient(Protocol):
    """Provider contract required by the exact time-dependent oracle."""

    def route(
        self,
        *,
        origin: Coordinate,
        destination: Coordinate,
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> DetailedRoute: ...


class MatrixRoutingClient(Protocol):
    """Provider contract required by a non-authoritative screening matrix."""

    def matrix(
        self,
        *,
        origins: list[Coordinate],
        destinations: list[Coordinate],
        mode: TransportMode,
        departure_at: datetime,
        refresh: bool = False,
    ) -> list[MatrixCell]: ...
