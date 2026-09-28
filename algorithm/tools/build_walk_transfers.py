"""Measure nearby rail/surface transfers with the local Valhalla walking matrix."""

from __future__ import annotations

import argparse
import http.client
import json
import math
import sqlite3
import threading
import urllib.parse
from pathlib import Path


_connections = threading.local()


def approx_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat = math.radians((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * 111_195,
                      (a[1] - b[1]) * 111_195 * math.cos(lat))


def matrix(endpoint: str, sources: list[tuple[float, float]], targets: list[tuple[float, float]]) -> list[list[dict]]:
    """Measure walks while reusing one local HTTP connection per worker thread."""
    body = {
        'sources': [{'lat': lat, 'lon': lon} for lat, lon in sources],
        'targets': [{'lat': lat, 'lon': lon} for lat, lon in targets],
        'costing': 'pedestrian',
        'units': 'kilometers',
    }
    address = urllib.parse.urlsplit(endpoint)
    if address.scheme not in {'http', 'https'} or not address.hostname:
        raise ValueError(f'Invalid walking matrix endpoint: {endpoint}')
    path = urllib.parse.urlunsplit(('', '', address.path or '/', address.query, ''))
    pool = getattr(_connections, 'pool', None)
    if pool is None:
        pool = _connections.pool = {}
    for attempt in range(2):
        connection = pool.get(endpoint)
        if connection is None:
            client = http.client.HTTPSConnection if address.scheme == 'https' else http.client.HTTPConnection
            connection = client(address.hostname, address.port, timeout=30)
            pool[endpoint] = connection
        try:
            connection.request('POST', path, body=json.dumps(body).encode('utf-8'),
                               headers={'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read()
            if response.status != 200:
                raise OSError(f'Walking matrix HTTP {response.status}: {raw[:240]!r}')
            return json.loads(raw)['sources_to_targets']
        except (OSError, http.client.HTTPException):
            connection.close()
            pool.pop(endpoint, None)
            if attempt:
                raise
    raise RuntimeError('Walking matrix retry loop returned without a result')


def build(database: Path, endpoint: str, radius_m: int, neighbor_count: int) -> dict:
    db = sqlite3.connect(database)
    db.execute('''CREATE TABLE IF NOT EXISTS walk_transfers(
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, seconds INTEGER NOT NULL,
        distance_m INTEGER NOT NULL, PRIMARY KEY(from_id,to_id))''')
    stops = list(db.execute('SELECT id,lat,lon,kind FROM stops'))
    rapid = [(stop_id, lat, lon) for stop_id, lat, lon, kind in stops
             if kind in ('mcc', 'mcd', 'metro')]
    surface = [(stop_id, lat, lon) for stop_id, lat, lon, kind in stops if kind == 'surface']
    inserted = 0
    failed = []
    for rail_id, lat, lon in rapid:
        close = sorted(((approx_m((lat, lon), (stop_lat, stop_lon)), stop_id, stop_lat, stop_lon)
                        for stop_id, stop_lat, stop_lon in surface
                        if abs(lat - stop_lat) < .006 and abs(lon - stop_lon) < .01), key=lambda item: item[0])
        close = [item for item in close[:neighbor_count] if item[0] <= radius_m]
        if not close:
            continue
        try:
            forward = matrix(endpoint, [(lat, lon)], [(item[2], item[3]) for item in close])[0]
            backward = matrix(endpoint, [(item[2], item[3]) for item in close], [(lat, lon)])
            for index, (_, surface_id, _, _) in enumerate(close):
                for origin, target, cell in (
                    (rail_id, surface_id, forward[index]),
                    (surface_id, rail_id, backward[index][0]),
                ):
                    if cell.get('time') is None or cell.get('distance') is None:
                        continue
                    db.execute('INSERT OR REPLACE INTO walk_transfers VALUES (?,?,?,?)',
                               (origin, target, math.ceil(cell['time']), math.ceil(cell['distance'] * 1000)))
                    inserted += 1
        except (OSError, KeyError, IndexError, ValueError) as error:
            failed.append({'rail_stop': rail_id, 'error': str(error)})
        if inserted % 500 < 2 * neighbor_count:
            db.commit()
    db.commit()
    db.close()
    report = {'rapid_transit_stops': len(rapid), 'measured_walk_arcs': inserted,
              'failed_stops': failed, 'radius_m': radius_m, 'neighbor_count': neighbor_count,
              'walking_source': endpoint}
    database.with_suffix('.walk_transfers.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--endpoint', default='http://127.0.0.1:8002/sources_to_targets')
    parser.add_argument('--radius-m', type=int, default=450)
    parser.add_argument('--neighbor-count', type=int, default=8)
    args = parser.parse_args()
    print(json.dumps(build(args.database, args.endpoint, args.radius_m, args.neighbor_count), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
