"""Versioned transport context. Intervals are half open, in Moscow time.

Road exclusions use Valhalla 3.8.3's documented exclude_locations with heading
and strict correlation, followed by a separate trace_attributes edge audit.
No polygon/Euclidean intersection is used to infer graph connectivity.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta
from urllib.request import Request, urlopen


class TransportContext:
    def __init__(self, events=None):
        self.events = events if events is not None else json.loads(os.environ.get('BEEGO_TRANSPORT_CONTEXT_JSON', '[]'))
        semantic = [{key: event.get(key) for key in ('id','revision','kind','modes','direction','startsAt','endsAt','status','segments')} for event in sorted(self.events,key=lambda e:e['id'])]
        self.digest = hashlib.sha256(json.dumps(semantic, sort_keys=True).encode()).hexdigest()

    @staticmethod
    def active(event, at):
        if event.get('status') in ('CANCELLED', 'ENDED'):
            return False
        start = datetime.fromisoformat(event['startsAt'])
        end = datetime.fromisoformat(event['endsAt']) if event.get('endsAt') else None
        return start <= at and (end is None or at < end)

    def blocked(self, kind, source, target, at):
        for event in self.events:
            if event.get('kind') != kind or not self.active(event, at):
                continue
            for segment in event.get('segments', []):
                if str(segment.get('fromId')) == str(source) and (target is None or str(segment.get('toId')) == str(target)):
                    return True
                if event.get('direction', 'both') == 'both' and target is not None and str(segment.get('toId')) == str(source) and str(segment.get('fromId')) == str(target):
                    return True
        return False

    def metro_path_blocked(self, segments, departure):
        elapsed = 0
        for segment in segments:
            at = departure + timedelta(seconds=elapsed + segment.get('wait_seconds', 0))
            kind = 'transfer' if segment.get('kind') == 'transfer' else 'metro'
            if self.blocked(kind, segment['from_id'], segment['to_id'], at):
                return True
            elapsed += segment.get('seconds', 0) + segment.get('wait_seconds', 0)
        return False

    def next_open(self, kind, source, target, at):
        """Earliest confirmed opening, including consecutive overlapping closures."""
        candidate = at
        for _ in range(len(self.events) + 1):
            blocking = [event for event in self.events if event.get('kind')==kind and self.active(event,candidate)
                        and any(str(segment.get('fromId'))==str(source) and (target is None or str(segment.get('toId'))==str(target))
                                or event.get('direction','both')=='both' and target is not None and str(segment.get('toId'))==str(source) and str(segment.get('fromId'))==str(target)
                                for segment in event.get('segments',[]))]
            if not blocking:
                return candidate
            if any(not event.get('endsAt') for event in blocking):
                return None
            candidate = max(datetime.fromisoformat(event['endsAt']) for event in blocking)
        return None

    def road_events(self, mode):
        return [e for e in self.events if e.get('kind') == 'road' and mode in e.get('modes', ['CAR']) and e.get('status') not in ('ENDED', 'CANCELLED')]

    def affects_travel(self, travel, mode):
        """Conservative broad phase for reuse, never an edge prohibition.

        An overlapping bounding box requests actual graph routing/audit. It does
        not close an intersecting bridge, tunnel or parallel carriageway.
        """
        for event in self.events:
            if event.get('status') in ('ENDED', 'CANCELLED'):
                continue
            if event['kind'] == 'road' and mode not in event.get('modes', ['CAR']):
                continue
            if event['kind'] != 'road' and mode != 'PUBLIC_TRANSIT':
                continue
            start = datetime.fromisoformat(event['startsAt'])
            end = datetime.fromisoformat(event['endsAt']) if event.get('endsAt') else None
            if start >= travel.departure_at + timedelta(minutes=travel.duration_minutes) or end and end <= travel.departure_at:
                continue
            geometry = getattr(travel, 'geometry', ())
            if event['kind'] == 'road':
                for segment in event['segments']:
                    points = segment['geometry']
                    lo = [min(p[i] for p in points) - .0003 for i in (0,1)]
                    hi = [max(p[i] for p in points) + .0003 for i in (0,1)]
                    if any(all(max(a[i], b[i]) >= lo[i] and min(a[i], b[i]) <= hi[i] for i in (0,1)) for a,b in zip(geometry, geometry[1:])):
                        return True
            else:
                for step in getattr(travel, 'itinerary', ()):
                    if event['kind'] == 'metro' and step.mode != 'metro':
                        continue
                    if event['kind'] == 'transfer' and step.mode != 'walking_transfer':
                        continue
                    for segment in event['segments']:
                        points = segment['geometry']
                        if event['kind'] == 'entry':
                            access = step.mode == 'walking' and step.attributes.get('purpose') in ('station_access','station_egress','metro_access','metro_egress') or step.mode == 'walking_transfer' and step.attributes.get('source') == 'VALHALLA_WALK_MATRIX'
                            if access and any(sum(abs(p[i]-points[0][i]) for i in (0,1))<.00005 for p in (step.geometry[:1] + step.geometry[-1:])):
                                return True
                        elif len(step.geometry)>1 and len(points)>1:
                            same = lambda a,b: sum(abs(a[i]-b[i]) for i in (0,1))<.00005
                            if (same(step.geometry[0],points[0]) and same(step.geometry[-1],points[-1])
                                or same(step.geometry[-1],points[0]) and same(step.geometry[0],points[-1])):
                                return True
        return False


def raw_valhalla(endpoint, action, body):
    url = endpoint.rsplit('/', 1)[0] + '/' + action
    with urlopen(Request(url, json.dumps(body).encode(), {'Content-Type': 'application/json'}), timeout=25) as response:
        return json.load(response)


def trace_edges(endpoint, geometry, mode='auto'):
    if len(geometry) < 2:
        return []
    response = raw_valhalla(endpoint, 'trace_attributes', {
        'shape': [{'lat': p[0], 'lon': p[1]} for p in geometry],
        'costing': mode, 'shape_match': 'edge_walk',
        'filters': {'action': 'include', 'attributes': [
            'edge.id', 'edge.way_id', 'edge.length', 'edge.speed',
            'edge.begin_shape_index', 'edge.end_shape_index', 'node.elapsed_time']},
    })
    if not isinstance(response.get('edges'), list):
        raise ValueError('Дорожный сервис не подтвердил рёбра маршрута')
    return response['edges']


def road_violations(context, events, edges, departure, seconds, not_before=None):
    total = edges[-1].get('end_node', {}).get('elapsed_time', 0) if edges else 0
    elapsed = 0
    violations = []
    for edge in edges:
        at = departure + timedelta(seconds=elapsed * seconds / total if total else 0)
        for event in events:
            ids = {str(s['opposingEdgeId'] if event.get('direction') == 'reverse' else s['edgeId']) for s in event.get('segments', []) if event.get('direction') != 'reverse' or s.get('opposingEdgeId')}
            if event.get('direction', 'both') == 'both':
                ids.update(str(s['opposingEdgeId']) for s in event.get('segments', []) if s.get('opposingEdgeId'))
            if str(edge['id']) in ids and context.active(event, at) and (not_before is None or at >= not_before):
                violations.append(event)
        elapsed = edge.get('end_node', {}).get('elapsed_time', elapsed)
    return {event['id']: event for event in violations}.values()
