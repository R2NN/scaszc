"""Metro routes from the official graph with explicitly modelled train waits."""

from __future__ import annotations

import hashlib
import heapq
import json
import math
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .models import Coordinate, DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode
from .valhalla import ValhallaRoutingClient
from .restrictions import TransportContext


SCHEMA_URL = 'https://prodapp.mosmetro.ru/api/schema/v1.0'
HOURS_URL = 'https://www.mosmetro.ru/passengers/information/schedule'


def _chord(a: tuple[float, float], b: tuple[float, float]) -> int:
    lat = math.radians((a[0] + b[0]) / 2)
    return math.ceil(math.hypot((a[0] - b[0]) * 111_195,
                                (a[1] - b[1]) * 111_195 * math.cos(lat)))


class MetroReference:
    """Use official ride/transfer times, Valhalla walks, and a declared wait.

    The full metro departure timetable is unavailable. Each boarding gets a
    configurable wait assumption; no fictional train departures are created.
    The resulting route is marked as an estimate, not as timetable-exact.
    """

    def __init__(self, schema_path: Path, walking: ValhallaRoutingClient,
                 *, boarding_wait_seconds: int = 180) -> None:
        if boarding_wait_seconds < 0:
            raise ValueError('boarding_wait_seconds must be non-negative')
        self.schema_path = schema_path
        self.walking = walking
        self.transport_context = TransportContext()
        self.boarding_wait_seconds = boarding_wait_seconds
        data = json.loads(schema_path.read_text(encoding='utf-8'))['data']
        self.stations = {
            item['id']: item for item in data['stations']
            if not item.get('mcc') and not item.get('mcd') and not item.get('perspective')
        }
        self.edges: dict[int, list[tuple[int, int, str]]] = {key: [] for key in self.stations}
        for kind, records in (('metro', data['connections']), ('transfer', data['transitions'])):
            for item in records:
                source = item.get('stationFromId')
                target = item.get('stationToId')
                duration = item.get('pathLength')
                if source not in self.stations or target not in self.stations:
                    continue
                if not isinstance(duration, int) or duration <= 0 or item.get('perspective'):
                    continue
                self.edges[source].append((target, duration, kind))
                if item.get('bi') and not item.get('closedBackward'):
                    self.edges[target].append((source, duration, kind))

    def _point(self, station_id: int) -> tuple[float, float]:
        point = self.stations[station_id]['location']
        return point['lat'], point['lon']

    def _nearby_walks(self, location: Coordinate, departure_at: datetime,
                      *, inbound: bool) -> dict[int, DetailedRoute | None]:
        nearby = sorted((_chord((location.latitude, location.longitude), self._point(station_id)), station_id)
                        for station_id in self.stations)
        result = {}
        for distance, station_id in nearby[:6]:
            if distance > 2000:
                continue
            if distance <= 3:
                result[station_id] = None
                continue
            station = Coordinate(f'metro:{station_id}', *self._point(station_id))
            origin, destination = (station, location) if inbound else (location, station)
            try:
                walk = self.walking.route(origin=origin, destination=destination,
                                          mode=TransportMode.WALKING, departure_at=departure_at)
            except Exception:
                continue
            if walk.status == RouteStatus.OK and walk.duration_seconds is not None:
                result[station_id] = walk
        return result

    @staticmethod
    def _walk_seconds(walk: DetailedRoute | None) -> int:
        return 0 if walk is None else walk.duration_seconds or 0

    def _train_available(self, station_id: int, neighbor: int,
                         elapsed_since_query: int, departure_at: datetime,
                         wait: int) -> bool:
        departures = self.stations[station_id].get('scheduleTrains', {}).get(str(neighbor), [])
        def minute_of_day(value: str) -> int | None:
            match = re.match(r'^\s*(\d{1,2})[:.,](\d{2})', str(value))
            if not match:
                return None
            hours, minutes = map(int, match.groups())
            return hours * 3600 + minutes * 60 if minutes < 60 else None

        boarding = (departure_at + timedelta(seconds=elapsed_since_query + wait)).astimezone(ZoneInfo('Europe/Moscow'))
        midnight = boarding.replace(hour=0, minute=0, second=0, microsecond=0)
        if not hasattr(self,'_service_bounds'):
            self._service_bounds={}
        key=(station_id,neighbor,midnight.date())
        if key in self._service_bounds:
            return any(first<=boarding<=last for first,last in self._service_bounds[key])
        bounds=[]
        for service_day in (midnight - timedelta(days=1), midnight):
            for item in departures:
                if item.get('weekend') is not (service_day.weekday() >= 5):
                    continue
                first, last = minute_of_day(item.get('first')), minute_of_day(item.get('last'))
                if first is None or last is None:
                    continue
                if last < first:
                    last += 86400
                bounds.append((service_day+timedelta(seconds=first),service_day+timedelta(seconds=last)))
        self._service_bounds[key]=bounds
        return any(first<=boarding<=last for first,last in bounds)

    def route(self, origin: Coordinate, destination: Coordinate,
              departure_at: datetime) -> DetailedRoute | None:
        access = self._nearby_walks(origin, departure_at, inbound=False)
        egress = self._nearby_walks(destination, departure_at, inbound=True)
        if not access or not egress:
            return None
        # State tracks the onboard metro line so continued travel pays no
        # second boarding wait. -1 means the next train requires boarding.
        times: dict[tuple[int, int, bool], int] = {}
        roots: dict[tuple[int, int, bool], DetailedRoute | None] = {}
        entry_waits = {}
        previous: dict[tuple[int, int, bool], tuple[tuple[int, int, bool], str, int, int]] = {}
        queue: list[tuple[int, int, int, bool]] = []
        for station_id, walk in access.items():
            state = (station_id, -1, False)
            duration = self._walk_seconds(walk) + (self.stations[station_id].get('enterTime') or 0)
            reached = departure_at + timedelta(seconds=self._walk_seconds(walk))
            opening = self.transport_context.next_open('entry', f'm:{station_id}', None, reached)
            if opening is None:
                continue
            entry_wait = int((opening-reached).total_seconds())
            duration += entry_wait
            if duration < times.get(state, 10**9):
                times[state] = duration
                roots[state] = walk
                entry_waits[state] = entry_wait
                heapq.heappush(queue, (duration, *state))
        while queue:
            elapsed, station_id, onboard_line, ridden = heapq.heappop(queue)
            state = (station_id, onboard_line, ridden)
            if times[state] != elapsed:
                continue
            for neighbor, duration, kind in self.edges[station_id]:
                if kind == 'metro':
                    line_id = self.stations[station_id]['lineId']
                    wait = 0 if onboard_line == line_id else self.boarding_wait_seconds
                    opening = self.transport_context.next_open(kind, f'm:{station_id}', f'm:{neighbor}', departure_at + timedelta(seconds=elapsed + wait))
                    if opening is None:
                        continue
                    wait = int((opening-departure_at).total_seconds())-elapsed
                    if not self._train_available(station_id, neighbor, elapsed,
                                                 departure_at, wait):
                        continue
                    next_state = (neighbor, line_id, True)
                else:
                    opening = self.transport_context.next_open(kind, f'm:{station_id}', f'm:{neighbor}', departure_at + timedelta(seconds=elapsed))
                    if opening is None:
                        continue
                    wait = int((opening-departure_at).total_seconds())-elapsed
                    next_state = (neighbor, -1, ridden)
                candidate = elapsed + wait + duration
                if candidate < times.get(next_state, 10**9):
                    times[next_state] = candidate
                    previous[next_state] = (state, kind, duration, wait)
                    heapq.heappush(queue, (candidate, *next_state))
        options = []
        for station_id, walk in egress.items():
            exit_time = self.stations[station_id].get('exitTime') or 0
            for state, duration in times.items():
                if state[0] == station_id and state[2]:
                    opening = self.transport_context.next_open('entry', f'm:{station_id}', None, departure_at + timedelta(seconds=duration))
                    if opening is not None:
                        options.append((int((opening-departure_at).total_seconds()) + exit_time + self._walk_seconds(walk), state, walk))
        if not options:
            return None
        total, terminal, final_walk = min(options, key=lambda option: option[0])
        states = [terminal]
        while states[-1] in previous:
            states.append(previous[states[-1]][0])
        states.reverse()
        first = states[0]
        geometry: list[tuple[float, float]] = []
        steps: list[RouteStep] = []
        distance = 0
        boardings = 0

        def add(mode: str, duration: int, meters: int, waiting: int,
                points: tuple[tuple[float, float], ...], attributes: dict) -> None:
            nonlocal distance
            if geometry and points and geometry[-1] == points[0]:
                geometry.extend(points[1:])
            else:
                geometry.extend(points)
            steps.append(RouteStep(len(steps), mode, duration, meters, waiting, points, attributes))
            distance += meters

        first_walk = roots[first]
        if first_walk is not None:
            add('walking', self._walk_seconds(first_walk), first_walk.distance_m or 0, 0,
                first_walk.geometry, {'source': 'LOCAL_VALHALLA', 'purpose': 'metro_access','to_id':f'm:{first[0]}'})
        entry = self.stations[first[0]].get('enterTime') or 0
        if entry_waits[first]:
            add('waiting', entry_waits[first], 0, entry_waits[first], (self._point(first[0]),), {'source':'TRANSPORT_KNOWN_OPENING'})
        if entry:
            add('station_entry', entry, 0, 0, (self._point(first[0]),),
                {'source': 'MOSMETRO_SCHEMA', 'station': self.stations[first[0]]['name']['ru'],'from_id':f'm:{first[0]}'})
        for source_state, target_state in zip(states, states[1:]):
            _, kind, duration, wait = previous[target_state]
            source_station = self.stations[source_state[0]]
            target_station = self.stations[target_state[0]]
            if kind == 'metro' and source_state[1] != source_station['lineId']:
                boardings += 1
            model_wait = self.boarding_wait_seconds if kind == 'metro' and source_state[1] != source_station['lineId'] else 0
            if wait > model_wait:
                add('waiting', wait-model_wait, 0, wait-model_wait, (self._point(source_state[0]),), {'source':'TRANSPORT_KNOWN_OPENING'})
            if model_wait:
                add('metro_wait_model', model_wait, 0, model_wait, (self._point(source_state[0]),),
                    {'source': 'EXPLICIT_SCENARIO_ASSUMPTION',
                     'station': source_station['name']['ru'],
                     'assumed_seconds': self.boarding_wait_seconds})
            add(kind if kind == 'metro' else 'walking_transfer', duration,
                _chord(self._point(source_state[0]), self._point(target_state[0])), 0,
                (self._point(source_state[0]), self._point(target_state[0])),
                {'source': 'MOSMETRO_SCHEMA', 'from_station': source_station['name']['ru'],
                 'from_id': f'm:{source_state[0]}', 'to_id': f'm:{target_state[0]}',
                 'to_station': target_station['name']['ru'], 'line_id': source_station['lineId'],
                 'geometry_quality': 'station_to_station_chord',
                 'distance_quality': 'geodesic_lower_bound'})
        exit_time = self.stations[terminal[0]].get('exitTime') or 0
        exit_wait = total-times[terminal]-exit_time-self._walk_seconds(final_walk)
        if exit_wait:
            add('waiting', exit_wait, 0, exit_wait, (self._point(terminal[0]),), {'source':'TRANSPORT_KNOWN_OPENING'})
        if exit_time:
            add('station_exit', exit_time, 0, 0, (self._point(terminal[0]),),
                {'source': 'MOSMETRO_SCHEMA', 'station': self.stations[terminal[0]]['name']['ru'],'from_id':f'm:{terminal[0]}'})
        if final_walk is not None:
            add('walking', self._walk_seconds(final_walk), final_walk.distance_m or 0, 0,
                final_walk.geometry, {'source': 'LOCAL_VALHALLA', 'purpose': 'metro_egress','from_id':f'm:{terminal[0]}'})
        if not geometry:
            geometry = [(origin.latitude, origin.longitude), (destination.latitude, destination.longitude)]
        metadata = {
            'time_quality': 'MODELLED_NOT_TIMETABLE_EXACT',
            'metro_schedule_quality': 'FULL_DEPARTURE_TIMETABLE_UNAVAILABLE',
            'first_and_last_trains_checked': True,
            'boarding_wait_assumption_seconds': self.boarding_wait_seconds,
            'boarding_events': boardings,
            'chosen_path_wait_sensitivity_seconds': {
                'zero_wait': total - boardings * self.boarding_wait_seconds,
                'five_minutes_per_boarding': total + boardings * (300 - self.boarding_wait_seconds),
            },
            'metro_station_ids': [state[0] for state in states],
            'metro_station_names': [self.stations[state[0]]['name']['ru'] for state in states],
            'official_schema': SCHEMA_URL, 'official_hours': HOURS_URL,
            'geometry_quality': 'station_to_station_for_metro_links',
            'distance_quality': 'lower_bound_for_metro_links',
            'fitness_for_exact_proof': False,
        }
        request = (origin.location_id, destination.location_id,
                   departure_at.isoformat(), self.boarding_wait_seconds)
        response = [(step.mode, step.duration_seconds) for step in steps]
        provenance = Provenance(
            provider='MOSMETRO_GRAPH_WAIT_MODEL_VALHALLA', endpoint=str(self.schema_path),
            request_sha256=hashlib.sha256(json.dumps(request).encode()).hexdigest(),
            response_sha256=hashlib.sha256(json.dumps(response).encode()).hexdigest(),
            fetched_at=datetime.now(UTC).isoformat(), cache_hit=True,
            provider_metadata=metadata,
        )
        return DetailedRoute(origin.location_id, destination.location_id,
                             TransportMode.PUBLIC_TRANSIT, departure_at, RouteStatus.OK,
                             total, math.ceil(total / 60), distance, tuple(geometry),
                             tuple(steps), 'METRO_MODEL_WAIT_ASSUMPTION', provenance)
