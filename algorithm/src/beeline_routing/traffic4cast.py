"""Measured Moscow Traffic4cast 2021 hourly road-speed profiles.

The compact profile is produced from the original 2019 HDF5 observations by
``tools/build_traffic4cast_profile.py``. No synthetic speed or live API is used.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .errors import RoutingIncomplete
from .models import DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode


MOSCOW_TIMEZONE = ZoneInfo('Europe/Moscow')


@dataclass(frozen=True, slots=True)
class TrafficProfileMetadata:
    north: float
    south: float
    west: float
    east: float
    height: int
    width: int
    rotated: bool
    source_days: int
    source_year: int
    sha256: str


class Traffic4castProfile:
    """Apply measured hour-of-week and direction speeds to a road itinerary."""

    def __init__(self, metadata_path: Path) -> None:
        metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
        if metadata.get('format') != 'traffic4cast-2021-hourly-v1':
            raise RoutingIncomplete('Unsupported Traffic4cast profile format')
        bounds = metadata['bounds']
        self.metadata = TrafficProfileMetadata(
            north=float(bounds['north']), south=float(bounds['south']),
            west=float(bounds['west']), east=float(bounds['east']),
            height=int(metadata['height']), width=int(metadata['width']),
            rotated=bool(metadata['rotated']),
            source_days=int(metadata['source_days']),
            source_year=int(metadata['source_year']),
            sha256=str(metadata['sha256']),
        )
        meta = self.metadata
        if not (meta.north > meta.south and meta.east > meta.west
                and meta.height > 0 and meta.width > 0 and meta.source_days > 0):
            raise RoutingIncomplete('Invalid Traffic4cast profile geometry or source coverage')
        profile_path = metadata_path.with_suffix('.bin')
        self._speeds = profile_path.read_bytes()
        expected = 7 * 24 * meta.height * meta.width * 4
        if len(self._speeds) != expected:
            raise RoutingIncomplete(f'Traffic4cast profile size mismatch: {profile_path}')
        digest = hashlib.sha256(self._speeds).hexdigest()
        if digest != meta.sha256:
            raise RoutingIncomplete(f'Traffic4cast profile checksum mismatch: {profile_path}')

    def _cell(self, latitude: float, longitude: float) -> tuple[int, int] | None:
        meta = self.metadata
        if meta.rotated:
            # Moscow's published Traffic4cast raster is rotated by 90 degrees.
            # Convert 0.001-degree raw cells before collapsing 3x3 blocks.
            row = (494 - math.floor((longitude - meta.west) * 1000)) // 3
            column = (435 - math.floor((latitude - meta.south) * 1000)) // 3
        else:
            row = math.floor((meta.north - latitude) * meta.height / (meta.north - meta.south))
            column = math.floor((longitude - meta.west) * meta.width / (meta.east - meta.west))
        if not (0 <= row < meta.height and 0 <= column < meta.width):
            return None
        return row, column

    def covers(self, latitude: float, longitude: float) -> bool:
        """Whether a coordinate falls in the historical Moscow raster."""
        return self._cell(latitude, longitude) is not None

    def _speed_ratio(self, row: int, column: int, heading: int, when: datetime) -> float | None:
        meta = self.metadata
        local = when.astimezone(MOSCOW_TIMEZONE)
        offset = ((((local.weekday() * 24 + local.hour) * meta.height + row)
                   * meta.width + column) * 4 + heading)
        value = self._speeds[offset]
        if value:
            return value / 255
        # A nearby observation is still real data, not a manufactured multiplier.
        # Keep the search small so parallel roads retain spatial distinction.
        for radius in (1, 2):
            candidates: list[int] = []
            for r in range(max(0, row - radius), min(meta.height, row + radius + 1)):
                for c in range(max(0, column - radius), min(meta.width, column + radius + 1)):
                    if max(abs(r - row), abs(c - column)) != radius:
                        continue
                    index = ((((local.weekday() * 24 + local.hour) * meta.height + r)
                              * meta.width + c) * 4 + heading)
                    if self._speeds[index]:
                        candidates.append(self._speeds[index])
            if candidates:
                return (sum(candidates) / len(candidates)) / 255
        return None

    def factor(self, start: tuple[float, float], end: tuple[float, float], when: datetime) -> float | None:
        """Return a measured factor, or None where the dataset has no evidence."""
        latitude = (start[0] + end[0]) / 2
        longitude = (start[1] + end[1]) / 2
        cell = self._cell(latitude, longitude)
        if cell is None:
            return None
        row, column = cell
        east = (end[1] - start[1]) * math.cos(math.radians(latitude))
        north = end[0] - start[0]
        bearing = math.degrees(math.atan2(east, north)) % 360
        heading = min(3, int(bearing // 90))
        ratio = self._speed_ratio(row, column, heading, when)
        return 1 / ratio if ratio is not None else None

    def adjust(self, route: DetailedRoute) -> DetailedRoute:
        """Recalculate every car maneuver at its actual estimated traversal time."""
        if route.status != RouteStatus.OK or route.mode != TransportMode.CAR:
            return route
        elapsed = 0.0
        itinerary: list[RouteStep] = []
        measured = 0
        total_segments = 0
        for step in route.itinerary:
            pairs = list(zip(step.geometry, step.geometry[1:]))
            lengths = [_distance_m(start, end) for start, end in pairs]
            total_length = sum(lengths)
            if total_length <= 0:
                adjusted = step.duration_seconds
            else:
                adjusted = 0.0
                for (start, end), length in zip(pairs, lengths):
                    pieces = max(1, math.ceil(length / 200))
                    base_seconds = step.duration_seconds * length / total_length / pieces
                    for part in range(pieces):
                        part_start = _interpolate(start, end, part / pieces)
                        part_end = _interpolate(start, end, (part + 1) / pieces)
                        when = route.departure_at + timedelta(seconds=elapsed + adjusted)
                        factor = self.factor(part_start, part_end, when)
                        # Valhalla's real road-graph time remains authoritative
                        # only on stretches not covered by historical evidence.
                        adjusted += base_seconds * (factor if factor is not None else 1)
                        measured += factor is not None
                        total_segments += 1
            elapsed += adjusted
            itinerary.append(RouteStep(
                step.sequence, step.mode, adjusted, step.distance_m,
                step.waiting_seconds, step.geometry, step.attributes,
            ))
        if total_segments == 0:
            raise RoutingIncomplete('Valhalla route has no road segments for Traffic4cast assessment')
        seconds = math.ceil(elapsed)
        provenance = Provenance(
            route.provenance.provider, route.provenance.endpoint,
            route.provenance.request_sha256, route.provenance.response_sha256,
            route.provenance.fetched_at, route.provenance.cache_hit,
            {**route.provenance.provider_metadata,
             'traffic_source': 'Traffic4cast 2021 Moscow 2019 observations',
             'traffic_profile_sha256': self.metadata.sha256,
             'traffic_source_days': self.metadata.source_days,
             'traffic_measured_segments': measured,
             'traffic_total_segments': total_segments,
             'traffic_coverage_percent': round(100 * measured / total_segments, 1),
             'base_duration_seconds': route.duration_seconds},
        )
        return DetailedRoute(
            route.origin_id, route.destination_id, route.mode, route.departure_at,
            route.status, seconds, math.ceil(seconds / 60), route.distance_m,
            route.geometry, tuple(itinerary), route.provider_status, provenance,
        )


def _distance_m(start: tuple[float, float], end: tuple[float, float]) -> float:
    latitude = math.radians((start[0] + end[0]) / 2)
    north = (end[0] - start[0]) * 111_195
    east = (end[1] - start[1]) * 111_195 * math.cos(latitude)
    return math.hypot(north, east)


def _interpolate(start: tuple[float, float], end: tuple[float, float], fraction: float) -> tuple[float, float]:
    return (start[0] + (end[0] - start[0]) * fraction,
            start[1] + (end[1] - start[1]) * fraction)
