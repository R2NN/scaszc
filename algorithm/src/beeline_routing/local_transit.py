"""Offline timetable routing for Moscow surface transit, MCC, and MCD."""

from __future__ import annotations

import hashlib
import json
import math
import heapq
import sqlite3
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from .errors import InvalidRoutingInput, RoutingError
from .models import Coordinate, DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode
from .valhalla import ValhallaRoutingClient
from .metro_reference import MetroReference
from .restrictions import TransportContext


@dataclass(frozen=True, slots=True)
class _Stop:
    id: str
    name: str
    lat: float
    lon: float
    kind: str


@dataclass(frozen=True, slots=True)
class _Label:
    time: int
    stop_id: str
    action: str
    previous: _Label | None
    details: tuple


def _air_distance_m(a: tuple[float, float], b: tuple[float, float]) -> int:
    lat = math.radians((a[0] + b[0]) / 2)
    return math.ceil(math.hypot((a[0] - b[0]) * 111_195,
                                (a[1] - b[1]) * 111_195 * math.cos(lat)))


class LocalTransitRoutingClient:
    """Calculate timetable paths locally, with Valhalla measured walking links.

    The SQLite index is built once from the date-specific GTFS snapshot and a
    frozen normal-Monday railway schedule. No key or paid API is needed at
    query time. If this partial network has no path, the result is UNKNOWN.
    """

    def __init__(self, database: Path, walking: ValhallaRoutingClient,
                 *, horizon_seconds: int = 6 * 3600,
                 metro_wait_seconds: int = 180) -> None:
        if not database.is_file():
            raise RoutingError(f'Local transit index does not exist: {database}')
        if metro_wait_seconds < 0:
            raise InvalidRoutingInput('metro_wait_seconds must be non-negative')
        self.database = database.resolve()
        self.walking = walking
        self.transport_context = TransportContext()
        self.query_departure = None
        self.horizon_seconds = horizon_seconds
        # Each instance is owned by one materialization worker. Cleanup happens
        # after the pool joins and can therefore run in the coordinator thread.
        self.db = sqlite3.connect(
            f'file:{self.database.as_posix()}?mode=ro',
            uri=True,
            check_same_thread=False,
        )
        self.stops = {
            stop_id: _Stop(stop_id, name, lat, lon, kind)
            for stop_id, name, lat, lon, kind in self.db.execute('SELECT id,name,lat,lon,kind FROM stops')
        }
        self.active_stop_ids = {row[0] for row in self.db.execute('SELECT DISTINCT from_id FROM connections')}
        self.active_stop_ids.update(row[0] for row in self.db.execute('SELECT DISTINCT to_id FROM connections'))
        self.active_stop_ids.update(row[0] for row in self.db.execute('SELECT DISTINCT from_id FROM transfers'))
        self.active_stop_ids.update(row[0] for row in self.db.execute('SELECT DISTINCT to_id FROM transfers'))
        self.active_stop_ids.update(row[0] for row in self.db.execute('SELECT DISTINCT from_id FROM metro_paths'))
        self.active_stop_ids.update(row[0] for row in self.db.execute('SELECT DISTINCT to_id FROM metro_paths'))
        self.metadata = {key: json.loads(value) for key, value in self.db.execute('SELECT key,value FROM metadata')}
        index_wait = int(self.metadata.get('metro_wait_assumption_seconds', 180))
        if metro_wait_seconds != index_wait:
            raise InvalidRoutingInput(
                f'metro_wait_seconds={metro_wait_seconds} differs from the index value {index_wait}; '
                'rebuild the index to change this model assumption'
            )
        self.walk_transfers = defaultdict(list)
        self._load_transfers()
        self.station_access = self._load_station_access()
        self.metro_paths_cache: dict[str, list[tuple[str, int, list[dict]]]] = {}
        schema_path = self.database.parent.parent.parent.parent / 'research/mosmetro-api/schema.json'
        self.metro_reference = (MetroReference(schema_path, walking,
                                                boarding_wait_seconds=metro_wait_seconds)
                                if schema_path.is_file() else None)
        transport_schema = self._schema_path()
        self.transport_graph = self.metro_reference
        if self.transport_graph is None and transport_schema.is_file():
            self.transport_graph = MetroReference(transport_schema, walking, boarding_wait_seconds=metro_wait_seconds)

    def _schema_path(self):
        candidates = [Path(__file__).resolve().parents[3] / 'offline-assets/transit-sources/metro/schema.json',
                      self.database.parent.parent.parent.parent / 'research/mosmetro-api/schema.json']
        return next((p for p in candidates if p.is_file()), candidates[0])

    def _at(self, seconds):
        start = self.query_departure.replace(hour=0, minute=0, second=0)
        return start + timedelta(seconds=seconds)

    def _restricted_metro_paths(self, origin, start):
        if not self.transport_graph:
            raise RoutingError('Для обхода метро нужен доступный официальный граф станций')
        graph = self.transport_graph
        source = int(origin.removeprefix('m:'))
        if source not in graph.stations:
            return []
        queue = [(start, source, -1, [])]
        best = {(source, -1): start}
        results = {}
        while queue:
            clock, station, line, path = heapq.heappop(queue)
            if clock != best.get((station, line)):
                continue
            if station != source and (station not in results or clock < results[station][0]):
                results[station] = (clock, path)
            for target, duration, kind in graph.edges[station]:
                target_line = graph.stations[station]['lineId'] if kind == 'metro' else -1
                wait = 180 if kind == 'metro' and line != target_line else 0
                model_wait = wait
                a, b = f'm:{station}', f'm:{target}'
                opening = self.transport_context.next_open(kind, a, b, self._at(clock + wait))
                if opening is None:
                    continue
                wait = int((opening-self._at(clock)).total_seconds())
                if kind == 'metro' and not graph._train_available(station,target,0,self._at(clock),wait):
                    continue
                arrival = clock + wait + duration
                if arrival < best.get((target, target_line), 10**9):
                    best[(target, target_line)] = arrival
                    segment = {'from_id': a, 'to_id': b, 'kind': kind, 'seconds': duration,
                               'wait_seconds': wait, 'opening_wait_seconds':wait-model_wait, 'line_id': graph.stations[station]['lineId']}
                    heapq.heappush(queue, (arrival, target, target_line, path + [segment]))
        return [(f'm:{station}', clock - start, path) for station, (clock, path) in results.items()]

    def _load_transfers(self) -> None:
        for origin, destination, seconds, source in self.db.execute(
            'SELECT from_id,to_id,seconds,source FROM transfers'
        ):
            self.walk_transfers[origin].append((destination, seconds, source, None))
        if self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='walk_transfers'").fetchone():
            for origin, destination, seconds, distance in self.db.execute(
                'SELECT from_id,to_id,seconds,distance_m FROM walk_transfers'
            ):
                self.walk_transfers[origin].append((destination, seconds, 'VALHALLA_WALK_MATRIX', distance))

    def close(self) -> None:
        """Close the read-only SQLite index."""
        self.db.close()

    def _load_station_access(self) -> dict[str, tuple[int, int]]:
        # The official schema provides platform entry/exit times for some stations.
        schema_path = self.database.parent.parent.parent.parent / 'research/mosmetro-api/schema.json'
        if not schema_path.is_file():
            return {}
        schema = json.loads(schema_path.read_text(encoding='utf-8'))['data']
        station_ids = dict(self.db.execute('SELECT metro_id,stop_id FROM network_station_ids'))
        result = {}
        for station in schema['stations']:
            stop_id = station_ids.get(station['id'])
            if stop_id:
                result[stop_id] = (station.get('enterTime') or 0, station.get('exitTime') or 0)
        return result

    def _nearby(self, coordinate: Coordinate) -> list[_Stop]:
        point = (coordinate.latitude, coordinate.longitude)
        surface = []
        rail = []
        for stop in self.stops.values():
            if stop.id not in self.active_stop_ids:
                continue
            if abs(stop.lat - coordinate.latitude) > .022 or abs(stop.lon - coordinate.longitude) > .035:
                continue
            air = _air_distance_m(point, (stop.lat, stop.lon))
            if air > 1800:
                continue
            (rail if stop.kind in ('mcc', 'mcd', 'metro') else surface).append((air, stop))
        surface.sort(key=lambda item: item[0])
        rail.sort(key=lambda item: item[0])
        return [stop for _, stop in surface[:14] + rail[:7]]

    def _walk_routes(self, coordinate: Coordinate, *, inbound: bool,
                     departure_at: datetime) -> dict[str, DetailedRoute | None]:
        result = {}
        for stop in self._nearby(coordinate):
            stop_coord = Coordinate(stop.id, stop.lat, stop.lon)
            origin, destination = (stop_coord, coordinate) if inbound else (coordinate, stop_coord)
            if _air_distance_m((origin.latitude, origin.longitude),
                               (destination.latitude, destination.longitude)) < 3:
                result[stop.id] = None
                continue
            try:
                walk = self.walking.route(origin=origin, destination=destination,
                                          mode=TransportMode.WALKING, departure_at=departure_at)
            except Exception:
                continue
            if walk.status == RouteStatus.OK and walk.duration_seconds is not None:
                result[stop.id] = walk
        return result

    @staticmethod
    def _walk_seconds(route: DetailedRoute | None) -> int:
        return 0 if route is None else route.duration_seconds or 0

    def _direct_walk_option(self, origin: Coordinate, destination: Coordinate,
                            departure_at: datetime) -> DetailedRoute | None:
        try:
            walk = self.walking.route(origin=origin, destination=destination,
                                      mode=TransportMode.WALKING,
                                      departure_at=departure_at)
        except Exception:
            return None
        if walk.status != RouteStatus.OK:
            return None
        provenance = Provenance(
            provider='LOCAL_VALHALLA_WALKING_AS_PT',
            endpoint=walk.provenance.endpoint,
            request_sha256=walk.provenance.request_sha256,
            response_sha256=walk.provenance.response_sha256,
            fetched_at=walk.provenance.fetched_at,
            cache_hit=walk.provenance.cache_hit,
            provider_metadata={**walk.provenance.provider_metadata,
                               'public_transit_vehicle_used': False,
                               'reason': 'Walking is an admissible short trip for a transit-capable engineer'},
        )
        return DetailedRoute(origin.location_id, destination.location_id,
                             TransportMode.PUBLIC_TRANSIT, departure_at,
                             RouteStatus.OK, walk.duration_seconds, walk.duration_minutes,
                             walk.distance_m, walk.geometry, walk.itinerary,
                             'WALKING_ONLY_SHORT_TRIP', provenance)

    @staticmethod
    def _fastest(*routes: DetailedRoute | None) -> DetailedRoute | None:
        candidates = [route for route in routes if route is not None and route.status == RouteStatus.OK]
        return min(candidates, key=lambda route: route.duration_seconds or 10**9) if candidates else None

    def _relax_transfers(self, initial: _Label, labels: dict[str, _Label],
                         *, allow_metro: bool) -> None:
        queue = deque([initial])
        while queue:
            current = queue.popleft()
            if labels.get(current.stop_id) is not current:
                continue
            for target, walk_time, source, distance in self.walk_transfers.get(current.stop_id, ()):
                if source != 'VALHALLA_WALK_MATRIX' and self.transport_context.blocked('transfer', current.stop_id, target, self._at(current.time)):
                    continue
                if source == 'VALHALLA_WALK_MATRIX' and (self.transport_context.blocked('entry', current.stop_id, None, self._at(current.time)) or self.transport_context.blocked('entry', target, None, self._at(current.time + walk_time))):
                    continue
                if source == 'VALHALLA_WALK_MATRIX':
                    exit_time = self.station_access.get(current.stop_id, (0, 0))[1]
                    enter_time = self.station_access.get(target, (0, 0))[0]
                    duration = walk_time + exit_time + enter_time
                else:
                    duration = walk_time
                candidate = current.time + duration
                if candidate < labels.get(target, _Label(10**9, target, '', None, ())).time:
                    updated = _Label(candidate, target, 'transfer', current,
                                     (duration, source, distance, walk_time))
                    labels[target] = updated
                    queue.append(updated)
            if allow_metro and current.stop_id.startswith('m:'):
                if any(e.get('kind') in ('metro', 'transfer') for e in self.transport_context.events):
                    paths = self._restricted_metro_paths(current.stop_id, current.time)
                else:
                    paths = self.metro_paths_cache.get(current.stop_id)
                if paths is None:
                    paths = [
                        (target, seconds, json.loads(path_json))
                        for target, seconds, path_json in self.db.execute(
                            'SELECT to_id,seconds,path_json FROM metro_paths WHERE from_id=?',
                            (current.stop_id,),
                        )
                    ]
                    self.metro_paths_cache[current.stop_id] = paths
                if self.transport_graph:
                    def valid_path(path):
                        elapsed=0
                        for segment in path:
                            wait=segment['wait_seconds']
                            if segment['kind']=='metro' and not self.transport_graph._train_available(int(segment['from_id'][2:]),int(segment['to_id'][2:]),elapsed,self._at(current.time),wait):
                                return False
                            elapsed+=wait+segment['seconds']
                        return True
                    if any(not valid_path(segments) for _,_,segments in paths):
                        paths=self._restricted_metro_paths(current.stop_id,current.time)
                for target, duration, segments in paths:
                    candidate = current.time + duration
                    if candidate < labels.get(target, _Label(10**9, target, '', None, ())).time:
                        updated = _Label(candidate, target, 'metro_path', current,
                                         (duration, segments))
                        labels[target] = updated
                        queue.append(updated)

    def route(self, *, origin: Coordinate, destination: Coordinate,
              mode: TransportMode, departure_at: datetime,
              refresh: bool = False) -> DetailedRoute:
        if mode != TransportMode.PUBLIC_TRANSIT:
            raise InvalidRoutingInput('Local transit client only handles PUBLIC_TRANSIT')
        if departure_at.tzinfo is None or departure_at.utcoffset() is None:
            raise InvalidRoutingInput('departure_at must include a timezone')
        if departure_at.date().isoformat() != self.metadata['scenario_date']:
            return self._unknown(origin, destination, departure_at, 'SCENARIO_DATE_NOT_INDEXED')
        if refresh:
            raise InvalidRoutingInput('The offline timetable index cannot be refreshed during a route query')
        self.query_departure = departure_at
        metro_route = (self.metro_reference.route(origin, destination, departure_at)
                       if self.metro_reference else None)
        direct_walk = self._direct_walk_option(origin, destination, departure_at)
        start = departure_at.hour * 3600 + departure_at.minute * 60 + departure_at.second
        allow_metro = bool(self.transport_graph) or not (3600 <= start < 5 * 3600 + 30 * 60)
        access = self._walk_routes(origin, inbound=False, departure_at=departure_at)
        egress = self._walk_routes(destination, inbound=True, departure_at=departure_at)
        if not access or not egress:
            return self._fastest(metro_route, direct_walk) or self._unknown(
                origin, destination, departure_at, 'WALKING_ACCESS_UNAVAILABLE')
        labels: dict[str, _Label] = {}
        for stop_id, walk in access.items():
            reached=self._at(start+self._walk_seconds(walk))
            opening=self.transport_context.next_open('entry',stop_id,None,reached)
            if opening is None:
                continue
            opening_wait=int((opening-reached).total_seconds())
            platform_enter = self.station_access.get(stop_id, (0, 0))[0]
            candidate = _Label(start + self._walk_seconds(walk) + platform_enter + opening_wait,
                               stop_id, 'access', None, (walk, platform_enter, opening_wait))
            if stop_id not in labels or candidate.time < labels[stop_id].time:
                labels[stop_id] = candidate
                self._relax_transfers(candidate, labels, allow_metro=allow_metro)
        cursor = self.db.execute(
            'SELECT from_id,to_id,dep,arr,trip_id,source FROM connections '
            'WHERE dep >= ? AND dep <= ? ORDER BY dep',
            (start, start + self.horizon_seconds),
        )
        for source_id, target_id, dep, arr, trip_id, timetable_source in cursor:
            source_label = labels.get(source_id)
            if source_label is None or source_label.time > dep:
                continue
            old = labels.get(target_id)
            if old is not None and old.time <= arr:
                continue
            updated = _Label(arr, target_id, 'ride', source_label,
                             (source_id, dep, arr, trip_id, timetable_source))
            labels[target_id] = updated
            self._relax_transfers(updated, labels, allow_metro=allow_metro)
        best = None
        for stop_id, walk in egress.items():
            label = labels.get(stop_id)
            if label is None:
                continue
            opening=self.transport_context.next_open('entry',stop_id,None,self._at(label.time))
            if opening is None:
                continue
            opening_wait=int((opening-self._at(label.time)).total_seconds())
            platform_exit = self.station_access.get(stop_id, (0, 0))[1]
            arrival = label.time + opening_wait + platform_exit + self._walk_seconds(walk)
            if best is None or arrival < best[0]:
                best = (arrival, label, walk, platform_exit, opening_wait)
        if best is None:
            return self._fastest(metro_route, direct_walk) or self._unknown(
                origin, destination, departure_at, 'NO_PATH_IN_COVERED_NETWORK')
        actions = []
        label = best[1]
        while label is not None:
            actions.append(label)
            label = label.previous
        actions.reverse()
        if not any(action.action in ('ride', 'metro_path') for action in actions):
            return self._fastest(metro_route, direct_walk) or self._unknown(
                origin, destination, departure_at, 'NO_PUBLIC_TRANSIT_LEG')
        scheduled = self._assemble(origin, destination, departure_at, best, actions, metro_route)
        return self._fastest(scheduled, metro_route, direct_walk) or scheduled

    def _assemble(self, origin: Coordinate, destination: Coordinate,
                  departure_at: datetime, best: tuple, actions: list[_Label],
                  metro_route: DetailedRoute | None) -> DetailedRoute:
        geometry = []
        itinerary = []
        distance = 0

        def add_step(mode: str, duration: int, meters: int, waiting: int,
                     points: tuple, attributes: dict) -> None:
            nonlocal distance
            if geometry and points and geometry[-1] == points[0]:
                geometry.extend(points[1:])
            else:
                geometry.extend(points)
            itinerary.append(RouteStep(len(itinerary), mode, duration, meters, waiting, points, attributes))
            distance += meters

        first = actions[0]
        access_walk, platform_enter, opening_wait = first.details
        if access_walk is not None:
            add_step('walking', self._walk_seconds(access_walk), access_walk.distance_m or 0, 0,
                     access_walk.geometry, {'source': 'LOCAL_VALHALLA', 'purpose': 'station_access','to_id':first.stop_id})
        if opening_wait:
            stop=self.stops[first.stop_id]
            add_step('waiting',opening_wait,0,opening_wait,((stop.lat,stop.lon),),{'source':'TRANSPORT_KNOWN_OPENING','station':stop.name})
        if platform_enter:
            stop = self.stops[first.stop_id]
            add_step('station_entry', platform_enter, 0, 0, ((stop.lat, stop.lon),),
                     {'source': 'MOSMETRO_SCHEMA', 'station': stop.name,'from_id':stop.id})
        previous_time = first.time
        for action in actions[1:]:
            stop = self.stops[action.stop_id]
            previous = self.stops[action.previous.stop_id]
            if action.action == 'ride':
                source_id, dep, arr, trip_id, timetable_source = action.details
                wait = dep - previous_time
                if wait:
                    add_step('waiting', wait, 0, wait, ((previous.lat, previous.lon),),
                             {'station': previous.name, 'source': timetable_source})
                line, headsign, kind = self.db.execute(
                    'SELECT line,headsign,kind FROM trips WHERE id=?', (trip_id,)
                ).fetchone()
                chord = _air_distance_m((previous.lat, previous.lon), (stop.lat, stop.lon))
                add_step(kind, arr - dep, chord, 0,
                         ((previous.lat, previous.lon), (stop.lat, stop.lon)),
                         {'from_stop': previous.name, 'to_stop': stop.name,
                          'line': line, 'headsign': headsign, 'trip_id': trip_id,
                          'departure_seconds': dep, 'arrival_seconds': arr,
                          'timetable_source': timetable_source,
                          'geometry_quality': 'stop_to_stop_chord',
                          'distance_quality': 'geodesic_lower_bound'})
            elif action.action == 'transfer':
                duration, source, known_distance, walk_time = action.details
                meters = known_distance if known_distance is not None else _air_distance_m(
                    (previous.lat, previous.lon), (stop.lat, stop.lon))
                add_step('walking_transfer', duration, meters, 0,
                         ((previous.lat, previous.lon), (stop.lat, stop.lon)),
                         {'from_stop': previous.name, 'to_stop': stop.name, 'source': source,
                          'measured_walk_seconds': walk_time,
                          'geometry_quality': 'stop_to_stop_chord'})
            elif action.action == 'metro_path':
                _, segments = action.details
                for segment in segments:
                    source_stop = self.stops[segment['from_id']]
                    target_stop = self.stops[segment['to_id']]
                    wait = int(segment['wait_seconds'])
                    opening_wait = int(segment.get('opening_wait_seconds',0))
                    if opening_wait:
                        add_step('waiting',opening_wait,0,opening_wait,((source_stop.lat,source_stop.lon),),{'source':'TRANSPORT_KNOWN_OPENING','station':source_stop.name})
                        wait -= opening_wait
                    if wait:
                        add_step('metro_wait_model', wait, 0, wait,
                                 ((source_stop.lat, source_stop.lon),),
                                 {'source': 'EXPLICIT_SCENARIO_ASSUMPTION',
                                  'assumed_seconds': wait,
                                  'station': source_stop.name})
                    mode = 'metro' if segment['kind'] == 'metro' else 'walking_transfer'
                    chord = _air_distance_m((source_stop.lat, source_stop.lon),
                                            (target_stop.lat, target_stop.lon))
                    add_step(mode, int(segment['seconds']), chord, 0,
                             ((source_stop.lat, source_stop.lon),
                              (target_stop.lat, target_stop.lon)),
                             {'source': 'MOSMETRO_SCHEMA',
                              'from_id': segment['from_id'], 'to_id': segment['to_id'],
                              'from_station': source_stop.name,
                              'to_station': target_stop.name,
                              'line_id': segment['line_id'],
                              'geometry_quality': 'station_to_station_chord',
                              'distance_quality': 'geodesic_lower_bound'})
            previous_time = action.time
        end_stop = self.stops[best[1].stop_id]
        if best[4]:
            add_step('waiting',best[4],0,best[4],((end_stop.lat,end_stop.lon),),{'source':'TRANSPORT_KNOWN_OPENING','station':end_stop.name})
        if best[3]:
            add_step('station_exit', best[3], 0, 0, ((end_stop.lat, end_stop.lon),),
                     {'source': 'MOSMETRO_SCHEMA', 'station': end_stop.name,'from_id':end_stop.id})
        if best[2] is not None:
            walk = best[2]
            add_step('walking', self._walk_seconds(walk), walk.distance_m or 0, 0,
                     walk.geometry, {'source': 'LOCAL_VALHALLA', 'purpose': 'station_egress','from_id':end_stop.id})
        duration = best[0] - (departure_at.hour * 3600 + departure_at.minute * 60 + departure_at.second)
        if not geometry:
            geometry = [(origin.latitude, origin.longitude), (destination.latitude, destination.longitude)]
        request = (origin.location_id, destination.location_id, departure_at.isoformat())
        response = [(step.mode, step.duration_seconds, step.attributes.get('trip_id')) for step in itinerary]
        provenance = Provenance(
            provider=('LOCAL_GTFS_RASP_VALHALLA' if self.metadata.get('rail_schedule_available', True)
                      else 'LOCAL_GTFS_VALHALLA'), endpoint=str(self.database),
            request_sha256=hashlib.sha256(json.dumps(request).encode()).hexdigest(),
            response_sha256=hashlib.sha256(json.dumps(response).encode()).hexdigest(),
            fetched_at=datetime.now(UTC).isoformat(), cache_hit=True,
            provider_metadata={
                'surface_schedule_date': self.metadata['scenario_date'],
                'rail_normal_weekday_reference_date': self.metadata['rail_reference_date'],
                'rail_schedule_applied_to_date': (
                    self.metadata['scenario_date'] if self.metadata.get('rail_schedule_available', True) else None
                ),
                'rail_schedule_available': self.metadata.get('rail_schedule_available', True),
                'rail_schedule_scope': self.metadata.get('rail_schedule_scope'),
                'metro_departure_schedule_available': False,
                'metro_ride_included': any(step.mode == 'metro' for step in itinerary),
                'distance_quality': 'lower_bound_for_transit_legs',
                'geometry_quality': 'stop_to_stop_for_transit_legs',
                'network_completeness': ('surface_gtfs_and_mcc_mcd_subset'
                                         if self.metadata.get('rail_schedule_available', True)
                                         else 'surface_gtfs_and_metro_model_only'),
                'metro_model_candidate_seconds': metro_route.duration_seconds if metro_route else None,
                'metro_model_wait_assumption_seconds': (
                    metro_route.provenance.provider_metadata['boarding_wait_assumption_seconds']
                    if metro_route else None),
            },
        )
        metro_used = any(step.mode == 'metro' for step in itinerary)
        metro_boardings = sum(step.mode == 'metro_wait_model' for step in itinerary)
        metro_wait = int(self.metadata.get('metro_wait_assumption_seconds', 180))
        provenance.provider_metadata.update({
            'time_quality': 'MODELLED_NOT_TIMETABLE_EXACT' if metro_used else 'SOURCE_TIMETABLES',
            'metro_schedule_quality': 'FULL_DEPARTURE_TIMETABLE_UNAVAILABLE',
            'metro_boarding_events': metro_boardings,
            'metro_wait_assumption_seconds': metro_wait,
            'chosen_path_wait_sensitivity_seconds': ({
                'zero_wait': duration - metro_boardings * metro_wait,
                'five_minutes_per_boarding': duration + metro_boardings * (300 - metro_wait),
            } if metro_used else None),
            'fitness_for_exact_proof': False,
        })
        provider_status = 'MIXED_TIMETABLE_METRO_MODEL' if metro_used else 'TIMETABLE_PATH'
        return DetailedRoute(origin.location_id, destination.location_id,
                             TransportMode.PUBLIC_TRANSIT, departure_at, RouteStatus.OK,
                             duration, math.ceil(duration / 60), distance,
                             tuple(geometry), tuple(itinerary), provider_status, provenance)

    def _unknown(self, origin: Coordinate, destination: Coordinate,
                 departure_at: datetime, reason: str) -> DetailedRoute:
        request = (origin.location_id, destination.location_id, departure_at.isoformat())
        provenance = Provenance(
            provider=('LOCAL_GTFS_RASP_VALHALLA' if self.metadata.get('rail_schedule_available', True)
                      else 'LOCAL_GTFS_VALHALLA'), endpoint=str(self.database),
            request_sha256=hashlib.sha256(json.dumps(request).encode()).hexdigest(),
            response_sha256=hashlib.sha256(reason.encode()).hexdigest(),
            fetched_at=datetime.now(UTC).isoformat(), cache_hit=True,
            provider_metadata={'network_completeness': ('surface_gtfs_and_mcc_mcd_subset'
                               if self.metadata.get('rail_schedule_available', True)
                               else 'surface_gtfs_and_metro_model_only'),
                               'metro_departure_schedule_available': False,
                               'rail_normal_weekday_reference_date': self.metadata['rail_reference_date'],
                               'rail_schedule_scope': self.metadata.get('rail_schedule_scope')},
        )
        return DetailedRoute(origin.location_id, destination.location_id,
                             TransportMode.PUBLIC_TRANSIT, departure_at, RouteStatus.UNKNOWN,
                             None, None, None, (), (), reason, provenance)
