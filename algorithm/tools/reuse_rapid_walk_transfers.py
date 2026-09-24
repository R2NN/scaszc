"""Reuse measured static station walks when the stop geometry is unchanged."""

from __future__ import annotations

import argparse
import json
import sqlite3
from contextlib import closing
from pathlib import Path


def metadata(database: sqlite3.Connection) -> dict[str, object]:
    return {key: json.loads(value) for key, value in database.execute('SELECT key,value FROM metadata')}


def reuse(source: Path, destination: Path) -> dict[str, object]:
    with closing(sqlite3.connect(source)) as old, closing(sqlite3.connect(destination)) as new, new:
        original = metadata(old)
        current = metadata(new)
        for key in ('gtfs_sha256', 'metro_schema_sha256'):
            if original.get(key) != current.get(key):
                raise ValueError(f'Нельзя повторно использовать пешие переходы: отличается {key}')
        old_stops = {row[0]: row[1:] for row in old.execute('SELECT id,lat,lon,kind FROM stops')}
        new_stops = {row[0]: row[1:] for row in new.execute('SELECT id,lat,lon,kind FROM stops')}
        walks = [row for row in old.execute(
            'SELECT from_id,to_id,seconds,distance_m FROM walk_transfers'
        ) if old_stops[row[0]][2] != 'surface' or old_stops[row[1]][2] != 'surface']
        for origin, target, _, _ in walks:
            if new_stops.get(origin) != old_stops[origin] or new_stops.get(target) != old_stops[target]:
                raise ValueError(f'Нельзя повторно использовать пеший переход {origin} → {target}: координаты изменились')
        new.execute('''CREATE TABLE IF NOT EXISTS walk_transfers(
            from_id TEXT NOT NULL, to_id TEXT NOT NULL, seconds INTEGER NOT NULL,
            distance_m INTEGER NOT NULL, PRIMARY KEY(from_id,to_id))''')
        new.executemany('INSERT OR IGNORE INTO walk_transfers VALUES (?,?,?,?)', walks)
        report = {
            'rapid_transit_stops': sum(stop[2] != 'surface' for stop in new_stops.values()),
            'reused_walk_arcs': len(walks),
            'failed_stops': [],
            'walking_source': str(source),
            'static_geometry_verified': True,
        }
    destination.with_suffix('.walk_transfers.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8'
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--database', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(reuse(args.source, args.database), ensure_ascii=False))


if __name__ == '__main__':
    main()
