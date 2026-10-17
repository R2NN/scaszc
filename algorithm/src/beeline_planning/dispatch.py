"""Road-geometry checkpoints for scenario dispatch; these are estimates, not GPS."""
from __future__ import annotations

import hashlib
import math
from datetime import datetime, timedelta

from beeline_routing.export import detailed_route_dict
from beeline_routing.models import Coordinate, TransportMode, RouteStatus
from beeline_routing.oracle import OracleQuery


def split_geometry(points, fraction):
    """Split a routed polyline by geodesic length, never between two addresses."""
    if len(points) < 2:
        raise ValueError('Положение неизвестно: нет геометрии текущей поездки')
    def distance(a, b):
        lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
        return 2 * math.asin(min(1, math.sqrt(math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2)))
    lengths = [distance(a, b) for a, b in zip(points, points[1:])]
    target = sum(lengths) * max(0, min(1, fraction))
    prefix = [tuple(points[0])]
    for index, length in enumerate(lengths):
        if target <= length or index == len(lengths)-1:
            ratio = min(1, target / length) if length else 0
            point = tuple(points[index][axis] + (points[index+1][axis]-points[index][axis])*ratio for axis in (0, 1))
            return tuple(prefix + [point]), point
        prefix.append(tuple(points[index+1]))
        target -= length
    return tuple(points), tuple(points[-1])


def _checkpoint_heading(geometry, point, fraction, origin_heading):
    """Keep the known direction when no part of a new leg has elapsed yet."""
    if fraction == 0 and origin_heading is not None:
        return origin_heading
    prior = next((p for p in reversed(geometry[:-1]) if p != point), geometry[0])
    lat1, lon1, lat2, lon2 = map(math.radians, (*prior, *point))
    return math.degrees(math.atan2(math.sin(lon2-lon1)*math.cos(lat2), math.cos(lat1)*math.sin(lat2)-math.sin(lat1)*math.cos(lat2)*math.cos(lon2-lon1))) % 360


def checkpoint(route, at, mode):
    """Retain elapsed movement; public transit continues to its known destination."""
    for visit in route.visits:
        if visit.departure_at <= at < visit.service_start_at:
            travel = visit.travel
            if not hasattr(travel, 'geometry') or not travel.geometry:
                return None
            arrival = visit.departure_at + timedelta(minutes=travel.duration_minutes)
            # No mid-vehicle alighting. Arrival is a conservative legal exit.
            release = max(at, arrival) if mode == TransportMode.PUBLIC_TRANSIT else at
            fraction = min(1, (release-visit.departure_at).total_seconds() / max(60, travel.duration_minutes*60))
            geometry, point = split_geometry(travel.geometry, fraction)
            heading = None
            if mode == TransportMode.CAR and fraction < 1:
                heading = _checkpoint_heading(geometry, point, fraction, travel.provenance.provider_metadata.get('origin_heading'))
            digest = hashlib.sha256(f'{route.engineer_id}:{visit.job_id}:{visit.departure_at.isoformat()}:{release.isoformat()}:{point}'.encode()).hexdigest()[:20]
            return {
                'location_id': f'DISPATCH-{digest}', 'coords': list(point),
                'heading': heading,
                'source': 'SCENARIO_ROUTE_LENGTH', 'measured_at': at.isoformat(),
                'at': release.isoformat(), 'departure_at': visit.departure_at.isoformat(),
                'source_job_id': visit.job_id, 'origin_id': travel.origin_id,
                'after_job_id': next((item.job_id for item in reversed(route.visits) if item.service_start_at <= at), None),
                'geometry': [list(p) for p in geometry], 'fraction': fraction,
                'distance_m': round(travel.distance_m*fraction),
                'travel_minutes': math.ceil(travel.duration_minutes*fraction),
                'source_travel': detailed_route_dict(travel),
                'policy': 'DESTINATION_EXIT' if mode == TransportMode.PUBLIC_TRANSIT else 'ROUTED_LENGTH_ESTIMATE',
            }
    return None


def checkpoint_location(item):
    """Create the exact origin identity used by the router and validator."""
    return Coordinate(item['location_id'], *item['coords'], heading=item.get('heading'))


def rank_interceptions(dataset, plan, event, eligible, anchors, oracle, on_check=None):
    """Rank engineers actually travelling by exact arrival from their legal exit.

    These legs only determine search order. A candidate still requires independent
    full-day validation, including handoff of its interrupted destination.
    """
    ranked = []
    destination = dataset.locations[dataset.jobs[event.target_id].location_id]
    routes = {route.engineer_id: route for route in plan.engineer_plans}
    for key in eligible:
        anchor = anchors.get(key)
        route = routes.get(key)
        if not anchor or not route:
            continue
        visit = next((v for v in route.visits if v.job_id == anchor['source_job_id']), None)
        if not visit or not visit.departure_at <= event.event_time < visit.departure_at + timedelta(minutes=visit.travel.duration_minutes):
            continue
        if on_check:
            on_check(key)
        departure = datetime.fromisoformat(anchor['at'])
        try:
            leg = oracle.query(OracleQuery(dataset.engineers[key].transport_mode,
                checkpoint_location(anchor), destination, departure))
            if leg.status == RouteStatus.OK:
                ranked.append((departure + timedelta(minutes=leg.duration_minutes), key))
        except Exception:
            # Unknown routing cannot produce an ETA or a published candidate.
            continue
    return tuple(key for _, key in sorted(ranked))


def verify_checkpoint(item, locations):
    """Independently check movement time, cost, polyline and registered origin."""
    original = item['source_travel']
    departure = datetime.fromisoformat(item['departure_at'])
    at = datetime.fromisoformat(item['at'])
    fraction = min(1, (at-departure).total_seconds()/max(60, original['duration_minutes']*60))
    geometry, point = split_geometry(original['geometry'], fraction)
    registered = locations[item['location_id']]
    expected_heading = None
    if original['mode'] == 'CAR' and fraction < 1:
        expected_heading = _checkpoint_heading(geometry, point, fraction, original['provenance']['provider_metadata'].get('origin_heading'))
    return (
        original['status'] == 'OK' and original['origin_id'] == item['origin_id']
        and original['departure_at'] == item['departure_at'] and at >= departure
        and abs(fraction-item['fraction']) < 1e-9
        and all(abs(a-b) < 1e-8 for a,b in zip(point, item['coords']))
        and tuple(tuple(p) for p in item['geometry']) == geometry
        and abs(registered.latitude-point[0]) < 1e-8 and abs(registered.longitude-point[1]) < 1e-8
        and item['distance_m'] == round(original['distance_m']*fraction)
        and item['travel_minutes'] == math.ceil(original['duration_minutes']*fraction)
        and (original['mode'] != 'PUBLIC_TRANSIT' or fraction == 1)
        and item.get('heading') == expected_heading and registered.heading == expected_heading
    )
