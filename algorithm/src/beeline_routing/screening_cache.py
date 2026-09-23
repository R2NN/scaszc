"""Persistent coordinate-keyed caches for incremental screening matrices."""

from __future__ import annotations

import json
import sqlite3
import zlib
from pathlib import Path
from collections.abc import Iterable, Sequence

from .models import Coordinate


def _point_key(point: Coordinate) -> str:
    return f'{point.latitude:.8f},{point.longitude:.8f}'


class ScreeningCache:
    """Share surface cells and transit shortest-path labels across dataset runs."""

    def __init__(self, path: Path) -> None:
        self.path = path.resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = self._connect()
        try:
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute(
                '''
                CREATE TABLE IF NOT EXISTS surface_cells (
                    namespace TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    origin_key TEXT NOT NULL,
                    destination_key TEXT NOT NULL,
                    duration_seconds INTEGER NOT NULL,
                    distance_m INTEGER NOT NULL,
                    PRIMARY KEY (namespace, mode, origin_key, destination_key)
                ) STRICT
                '''
            )
            connection.execute(
                '''
                CREATE TABLE IF NOT EXISTS transit_labels (
                    namespace TEXT NOT NULL,
                    origin_key TEXT NOT NULL,
                    labels BLOB NOT NULL,
                    PRIMARY KEY (namespace, origin_key)
                ) STRICT
                '''
            )
            connection.commit()
        finally:
            connection.close()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path, timeout=30)

    def get_surface(
        self,
        namespace: str,
        mode: str,
        origin: Coordinate,
        destination: Coordinate,
    ) -> tuple[int, int] | None:
        """Read one reusable surface matrix cell."""
        connection = self._connect()
        try:
            row = connection.execute(
                '''
                SELECT duration_seconds, distance_m FROM surface_cells
                WHERE namespace=? AND mode=? AND origin_key=? AND destination_key=?
                ''',
                (namespace, mode, _point_key(origin), _point_key(destination)),
            ).fetchone()
        finally:
            connection.close()
        return None if row is None else (int(row[0]), int(row[1]))

    def get_surfaces(
        self,
        namespace: str,
        mode: str,
        locations: Sequence[Coordinate],
    ) -> dict[tuple[int, int], tuple[int, int]]:
        """Read reusable cells for one dataset with bounded SQLite queries."""
        keys = [_point_key(location) for location in locations]
        unique_keys = list(dict.fromkeys(keys))
        rows: dict[tuple[str, str], tuple[int, int]] = {}
        connection = self._connect()
        try:
            for source_start in range(0, len(unique_keys), 200):
                sources = unique_keys[source_start:source_start + 200]
                for target_start in range(0, len(unique_keys), 200):
                    targets = unique_keys[target_start:target_start + 200]
                    placeholders_sources = ','.join('?' for _ in sources)
                    placeholders_targets = ','.join('?' for _ in targets)
                    query = (
                        'SELECT origin_key, destination_key, duration_seconds, distance_m '
                        'FROM surface_cells WHERE namespace=? AND mode=? '
                        f'AND origin_key IN ({placeholders_sources}) '
                        f'AND destination_key IN ({placeholders_targets})'
                    )
                    for origin, destination, seconds, meters in connection.execute(
                        query, (namespace, mode, *sources, *targets)
                    ):
                        rows[(origin, destination)] = (int(seconds), int(meters))
        finally:
            connection.close()
        return {
            (origin_index, destination_index): cached
            for origin_index, origin_key in enumerate(keys)
            for destination_index, destination_key in enumerate(keys)
            if (cached := rows.get((origin_key, destination_key))) is not None
        }

    def put_surfaces(
        self,
        namespace: str,
        mode: str,
        cells: Iterable[tuple[Coordinate, Coordinate, int, int]],
    ) -> None:
        """Persist a matrix response in one transaction instead of per cell."""
        rows = [
            (namespace, mode, _point_key(origin), _point_key(destination), seconds, meters)
            for origin, destination, seconds, meters in cells
        ]
        if not rows:
            return
        connection = self._connect()
        try:
            connection.executemany(
                '''
                INSERT INTO surface_cells VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(namespace, mode, origin_key, destination_key) DO UPDATE SET
                    duration_seconds=excluded.duration_seconds,
                    distance_m=excluded.distance_m
                ''',
                rows,
            )
            connection.commit()
        finally:
            connection.close()

    def put_surface(
        self,
        namespace: str,
        mode: str,
        origin: Coordinate,
        destination: Coordinate,
        duration_seconds: int,
        distance_m: int,
    ) -> None:
        """Persist one surface matrix cell idempotently."""
        connection = self._connect()
        try:
            connection.execute(
                '''
                INSERT INTO surface_cells VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(namespace, mode, origin_key, destination_key) DO UPDATE SET
                    duration_seconds=excluded.duration_seconds,
                    distance_m=excluded.distance_m
                ''',
                (
                    namespace,
                    mode,
                    _point_key(origin),
                    _point_key(destination),
                    duration_seconds,
                    distance_m,
                ),
            )
            connection.commit()
        finally:
            connection.close()

    def get_transit_labels(
        self,
        namespace: str,
        origin: Coordinate,
    ) -> dict[str, int] | None:
        """Load a complete static shortest-path label set for one origin."""
        connection = self._connect()
        try:
            row = connection.execute(
                'SELECT labels FROM transit_labels WHERE namespace=? AND origin_key=?',
                (namespace, _point_key(origin)),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            return None
        return {
            key: int(value)
            for key, value in json.loads(zlib.decompress(row[0])).items()
        }

    def put_transit_labels(
        self,
        namespace: str,
        origin: Coordinate,
        labels: dict[str, int],
    ) -> None:
        """Persist compressed static shortest-path labels for delta recomputation."""
        payload = zlib.compress(
            json.dumps(labels, sort_keys=True, separators=(',', ':')).encode('utf-8'),
            level=6,
        )
        connection = self._connect()
        try:
            connection.execute(
                '''
                INSERT INTO transit_labels VALUES (?, ?, ?)
                ON CONFLICT(namespace, origin_key) DO UPDATE SET labels=excluded.labels
                ''',
                (namespace, _point_key(origin), payload),
            )
            connection.commit()
        finally:
            connection.close()
