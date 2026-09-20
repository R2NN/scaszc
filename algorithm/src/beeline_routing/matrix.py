from __future__ import annotations

from collections import Counter
from collections.abc import Iterator
from datetime import datetime

from .errors import InvalidRoutingInput, RoutingIncomplete
from .interfaces import MatrixRoutingClient
from .models import Coordinate, MatrixCell, RouteStatus, TransportMode


def chunks(values: list[Coordinate], size: int) -> Iterator[list[Coordinate]]:
    if size < 1:
        raise InvalidRoutingInput('chunk size must be positive')
    for offset in range(0, len(values), size):
        yield values[offset:offset + size]


def build_matrix(
    *,
    client: MatrixRoutingClient,
    locations: list[Coordinate],
    mode: TransportMode,
    departure_at: datetime,
    batch_side: int = 10,
    refresh: bool = False,
) -> list[MatrixCell]:
    if not locations:
        raise InvalidRoutingInput('Locations must not be empty')
    if len({point.location_id for point in locations}) != len(locations):
        raise InvalidRoutingInput('Location IDs must be unique')
    if batch_side < 1:
        raise InvalidRoutingInput('batch_side must be positive')
    cells: list[MatrixCell] = []
    for origins in chunks(locations, batch_side):
        for destinations in chunks(locations, batch_side):
            cells.extend(
                client.matrix(
                    origins=origins,
                    destinations=destinations,
                    mode=mode,
                    departure_at=departure_at,
                    refresh=refresh,
                )
            )
    expected = len(locations) ** 2
    if len(cells) != expected:
        raise RoutingIncomplete(f'Matrix has {len(cells)} cells instead of {expected}')
    keys = {(cell.origin_id, cell.destination_id) for cell in cells}
    if len(keys) != expected:
        raise RoutingIncomplete('Matrix contains duplicate or missing origin/destination pairs')
    return cells


def ensure_matrix_complete(cells: list[MatrixCell]) -> None:
    counts = Counter(cell.status for cell in cells)
    if counts[RouteStatus.UNKNOWN]:
        raise RoutingIncomplete(
            f'Matrix contains {counts[RouteStatus.UNKNOWN]} UNKNOWN cells; screening result is incomplete'
        )
