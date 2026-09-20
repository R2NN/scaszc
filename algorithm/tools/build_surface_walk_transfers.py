"""Measure short surface-stop transfers using the local pedestrian network."""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from build_walk_transfers import approx_m, matrix


def build(database: Path, endpoint: str, radius_m: int, neighbors: int,
          workers: int) -> dict:
    db = sqlite3.connect(database)
    db.execute('''CREATE TABLE IF NOT EXISTS walk_transfers(
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, seconds INTEGER NOT NULL,
        distance_m INTEGER NOT NULL, PRIMARY KEY(from_id,to_id))''')
    active = {row[0] for row in db.execute('SELECT DISTINCT from_id FROM connections')}
    active.update(row[0] for row in db.execute('SELECT DISTINCT to_id FROM connections'))
    stops = [(sid, lat, lon) for sid, lat, lon in db.execute(
        "SELECT id,lat,lon FROM stops WHERE kind='surface'") if sid in active]
    cells = defaultdict(list)
    for stop in stops:
        cells[(int(stop[1] / .0015), int(stop[2] / .0025))].append(stop)

    def measure(stop: tuple[str, float, float]):
        sid, lat, lon = stop
        key = (int(lat / .0015), int(lon / .0025))
        nearby = []
        for x in range(key[0] - 1, key[0] + 2):
            for y in range(key[1] - 1, key[1] + 2):
                for other in cells.get((x, y), ()):
                    if other[0] == sid:
                        continue
                    distance = approx_m((lat, lon), (other[1], other[2]))
                    if distance <= radius_m:
                        nearby.append((distance, other))
        nearby.sort(key=lambda item: item[0])
        nearby = [item[1] for item in nearby[:neighbors]]
        if not nearby:
            return []
        result = matrix(endpoint, [(lat, lon)], [(item[1], item[2]) for item in nearby])[0]
        return [(sid, item[0], math.ceil(cell['time']), math.ceil(cell['distance'] * 1000))
                for item, cell in zip(nearby, result)
                if cell.get('time') is not None and cell.get('distance') is not None]

    inserted = 0
    failures = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(measure, stop) for stop in stops]
        for future in as_completed(futures):
            try:
                rows = future.result()
            except (OSError, KeyError, ValueError, IndexError):
                failures += 1
                continue
            if rows:
                db.executemany('INSERT OR REPLACE INTO walk_transfers VALUES (?,?,?,?)', rows)
                inserted += len(rows)
            if inserted % 1000 < len(rows):
                db.commit()
    db.commit()
    db.close()
    report = {'active_surface_stops': len(stops), 'measured_walk_arcs': inserted,
              'failed_measurements': failures, 'radius_m': radius_m,
              'nearest_neighbor_limit': neighbors, 'walking_source': endpoint}
    database.with_suffix('.surface_walk_transfers.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--endpoint', default='http://127.0.0.1:8002/sources_to_targets')
    parser.add_argument('--radius-m', type=int, default=120)
    parser.add_argument('--neighbors', type=int, default=5)
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()
    print(json.dumps(build(args.database, args.endpoint, args.radius_m,
                           args.neighbors, args.workers), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
