"""Road-geometry checkpoints for scenario dispatch; these are estimates, not GPS."""
from __future__ import annotations

import hashlib
import heapq
import math
from datetime import datetime, timedelta
from pathlib import Path

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


def _transit_step_exit(original, at):
    """A train/corridor finishes its current step; ground walking can stop now."""
    departure = datetime.fromisoformat(original['departure_at'])
    seconds = max(0, (at-departure).total_seconds())
    elapsed, distance, geometry = 0, 0, []
    release = at
    for step in original['itinerary']:
        duration = step['duration_seconds']
        points = tuple(tuple(p) for p in step['geometry'])
        if elapsed + duration <= seconds:
            geometry.extend(points[1:] if geometry and points and geometry[-1] == points[0] else points)
            elapsed += duration
            distance += step['distance_m']
            continue
        if step['mode'] not in ('walking','waiting','metro_wait_model'):
            geometry.extend(points[1:] if geometry and points and geometry[-1] == points[0] else points)
            distance += step['distance_m']
            release = departure + timedelta(minutes=math.ceil((elapsed+duration)/60))
        elif step['mode'] == 'walking' and len(points)>1:
            fraction = max(0,min(1,(seconds-elapsed)/max(1,duration)))
            prefix, _ = split_geometry(points,fraction)
            geometry.extend(prefix[1:] if geometry and geometry[-1] == prefix[0] else prefix)
            distance += step['distance_m']*fraction
        elif points:
            geometry.extend(points[:1])
        break
    if not geometry:
        raise ValueError('Не найден законный выход из текущего транспортного участка')
    return tuple(geometry), geometry[-1], release, round(distance)


def _metro_escape_graph():
    """Load the same official topology used by the transit router."""
    from beeline_routing.metro_reference import MetroReference
    root=Path(__file__).resolve().parents[3]
    candidates=[root/'offline-assets/transit-sources/metro/schema.json',root/'research/mosmetro-api/schema.json']
    schema=next((p for p in candidates if p.is_file()),None)
    if schema is None:
        raise ValueError('Не подтверждён граф метро для безопасного выхода; прежний план сохранён')
    return MetroReference(schema,None)


def _safe_transit_exit(original, at, context):
    """Continue inside the real graph, or wait for a known opening, before exiting."""
    geometry,point,release,distance=_transit_step_exit(original,at)
    closed=[e for e in context.events if e.get('kind')=='entry' and context.active(e,release)
            and any(sum(abs(point[i]-s['geometry'][0][i]) for i in (0,1))<.00005 for s in e['segments'])]
    if not closed:return geometry,point,release,distance,[]
    elapsed=0;current_step=None
    for step in original['itinerary']:
        elapsed+=step['duration_seconds']
        if elapsed>(at-datetime.fromisoformat(original['departure_at'])).total_seconds():current_step=step;break
    if current_step and (current_step['mode']=='walking' or current_step['mode']=='walking_transfer' and current_step.get('attributes',{}).get('source')=='VALHALLA_WALK_MATRIX'):
        # A person still on the street cannot be promoted onto a platform.
        return geometry,point,release,distance,[]
    graph=_metro_escape_graph()
    choices=[key for key in graph.stations if sum(abs(point[i]-graph._point(key)[i]) for i in (0,1))<.00005]
    attrs=current_step.get('attributes',{}) if current_step else {}
    hint=str(attrs.get('to_id','')).removeprefix('m:')
    if hint.isdigit() and int(hint) in choices:choices=[int(hint)]
    elif len(choices)>1 and attrs.get('line_id') is not None and current_step['mode']=='metro':choices=[key for key in choices if str(graph.stations[key]['lineId'])==str(attrs['line_id'])]
    if len(choices)>1 and attrs.get('to_station'):choices=[key for key in choices if graph.stations[key].get('name',{}).get('ru')==attrs['to_station']]
    if len(choices)!=1:raise ValueError('Не подтверждена однозначная текущая платформа метро; прежний план сохранён')
    source=choices[0]
    if not context.blocked('entry',f'm:{source}',None,release):return geometry,point,release,distance,[]
    onboard=graph.stations[source]['lineId'] if current_step and current_step['mode']=='metro' else -1
    incoming=current_step['geometry'][0] if current_step and current_step['geometry'] else None
    previous_station=next((key for key in graph.stations if incoming and sum(abs(incoming[i]-graph._point(key)[i]) for i in (0,1))<.00005),None)
    queue=[(0,source,onboard,[])];best={(source,onboard):0};answer=None
    while queue:
        seconds,station,line,steps=heapq.heappop(queue)
        if seconds!=best.get((station,line)):continue
        when=release+timedelta(seconds=seconds)
        blocking=[e for e in context.events if e.get('kind')=='entry' and context.active(e,when)
                  and any(s.get('fromId')==f'm:{station}' for s in e['segments'])]
        exit_seconds=int(graph.stations[station].get('exitTime') or 0)
        if not blocking:
            candidate=(seconds+exit_seconds,station,steps)
            if answer is None or candidate[0]<answer[0]:answer=candidate
        elif all(e.get('endsAt') for e in blocking):
            opening=max(datetime.fromisoformat(e['endsAt']) for e in blocking)
            candidate=(int((opening-release).total_seconds())+exit_seconds,station,steps)
            if answer is None or candidate[0]<answer[0]:answer=candidate
        if answer and seconds>=answer[0]:continue
        for target,duration,kind in graph.edges[station]:
            next_line=graph.stations[station]['lineId'] if kind=='metro' else -1
            wait=180 if kind=='metro' and (line!=next_line or station==source and target==previous_station) else 0
            if kind=='metro' and not graph._train_available(station,target,seconds,release,wait):continue
            if context.blocked(kind,f'm:{station}',f'm:{target}',when+timedelta(seconds=wait)):continue
            arrival=seconds+wait+duration
            if arrival<best.get((target,next_line),float('inf')):
                best[(target,next_line)]=arrival
                step={'kind':kind,'fromId':f'm:{station}','toId':f'm:{target}','seconds':duration,'waitSeconds':wait,
                      'fromName':graph.stations[station].get('name',{}).get('ru',f'm:{station}'),'toName':graph.stations[target].get('name',{}).get('ru',f'm:{target}'),
                      'geometry':[list(graph._point(station)),list(graph._point(target))]}
                heapq.heappush(queue,(arrival,target,next_line,steps+[step]))
    if answer is None:raise ValueError('Нет подтверждённого открытого выхода из текущего компонента метро. Уточните открытие или согласуйте ожидание')
    seconds,station,steps=answer
    traversed=sum(s['seconds']+s['waitSeconds'] for s in steps)
    exit_seconds=int(graph.stations[station].get('exitTime') or 0)
    waiting=max(0,seconds-traversed-exit_seconds)
    if waiting:steps=steps+[{'kind':'waiting','fromId':f'm:{station}','toId':f'm:{station}','seconds':waiting,'waitSeconds':0,'geometry':[list(graph._point(station)),list(graph._point(station))]}]
    if exit_seconds:steps=steps+[{'kind':'walking','fromId':f'm:{station}','toId':f'm:{station}','seconds':exit_seconds,'waitSeconds':0,'geometry':[list(graph._point(station)),list(graph._point(station))]}]
    points=list(geometry)
    from beeline_routing.metro_reference import _chord
    for step in steps:
        points.append(tuple(step['geometry'][-1]));distance+=_chord(*step['geometry'])
    return tuple(points),points[-1],release+timedelta(minutes=math.ceil(seconds/60)),distance,steps


def _escape_wait_intervals(original,at,escape):
    cursor=_transit_step_exit(original,at)[2];waits=[]
    for step in escape:
        if step['waitSeconds']:
            end=cursor+timedelta(seconds=step['waitSeconds']);waits.append({'start':cursor.isoformat(),'end':end.isoformat()});cursor=end
        end=cursor+timedelta(seconds=step['seconds'])
        if step['kind']=='waiting':waits.append({'start':cursor.isoformat(),'end':end.isoformat()})
        cursor=end
    return waits


def transport_checkpoint(route, at, mode, context):
    """Checkpoint only an affected underway trip, preserving all elapsed motion."""
    visit = next((v for v in route.visits if v.departure_at <= at < v.departure_at + timedelta(minutes=v.travel.duration_minutes)
                  and context.affects_travel(v.travel,mode.value)),None)
    if visit is None:
        return None
    if mode != TransportMode.PUBLIC_TRANSIT:
        return checkpoint(route,at,mode)
    original=detailed_route_dict(visit.travel)
    geometry, point, release, distance, escape = _safe_transit_exit(original,at,context)
    # This is a platform/station exit or a measured point on the current walk,
    # never a position in the middle of a train leg.
    digest=hashlib.sha256(f'transport:{route.engineer_id}:{visit.job_id}:{at.isoformat()}:{release.isoformat()}:{point}'.encode()).hexdigest()[:20]
    waits=_escape_wait_intervals(original,at,escape)
    return {'location_id':f'TRANSPORT-{digest}','coords':list(point),'heading':None,'source':'SCENARIO_ITINERARY',
            'measured_at':at.isoformat(),'at':release.isoformat(),'departure_at':visit.departure_at.isoformat(),
            'source_job_id':visit.job_id,'origin_id':visit.travel.origin_id,
            'after_job_id':next((v.job_id for v in reversed(route.visits) if v.service_start_at<=at),None),
            'geometry':[list(p) for p in geometry],
            'fraction':min(1,(release-visit.departure_at).total_seconds()/max(60,visit.travel.duration_minutes*60)),
            'distance_m':distance,'travel_minutes':math.ceil((release-visit.departure_at).total_seconds()/60),
            'source_travel':original,'escape_steps':escape,'escape_waits':waits,'escape_context':context.events if escape else [],'transport_context_sha256':context.digest,
            'policy':'TRANSIT_SAFE_EXIT' if escape or release!=_transit_step_exit(original,at)[2] else 'TRANSIT_STEP_EXIT'}


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
    if item.get('policy') in ('TRANSIT_STEP_EXIT','TRANSIT_SAFE_EXIT'):
        if item['policy']=='TRANSIT_SAFE_EXIT':
            from beeline_routing.restrictions import TransportContext
            context=TransportContext(item.get('escape_context',[]))
            if context.digest!=item.get('transport_context_sha256'):return False
            geometry,point,release,distance,escape=_safe_transit_exit(original,datetime.fromisoformat(item['measured_at']),context)
            if escape!=item.get('escape_steps'):return False
            if item.get('escape_waits')!=_escape_wait_intervals(original,datetime.fromisoformat(item['measured_at']),escape):return False
            # Replay historical movement in its captured context, but also
            # reject a newly forbidden future continuation in today's context.
            current=TransportContext();cursor=_transit_step_exit(original,datetime.fromisoformat(item['measured_at']))[2]
            for step in escape:
                cursor+=timedelta(seconds=step['waitSeconds'])
                if step['kind'] in ('metro','transfer') and current.blocked(step['kind'],step['fromId'],step['toId'],cursor):return False
                cursor+=timedelta(seconds=step['seconds'])
            if current.blocked('entry',escape[-1]['toId'],None,release):return False
        else:geometry, point, release, distance = _transit_step_exit(original,datetime.fromisoformat(item['measured_at']))
        registered=locations[item['location_id']]
        departure=datetime.fromisoformat(original['departure_at'])
        return (original['status']=='OK' and original['mode']=='PUBLIC_TRANSIT'
                and item['origin_id']==original['origin_id'] and item['departure_at']==original['departure_at']
                and item['at']==release.isoformat() and tuple(tuple(p) for p in item['geometry'])==geometry
                and all(abs(a-b)<1e-8 for a,b in zip(point,item['coords']))
                and abs(registered.latitude-point[0])<1e-8 and abs(registered.longitude-point[1])<1e-8
                and item['distance_m']==distance and item['travel_minutes']==math.ceil((release-departure).total_seconds()/60)
                and item.get('heading') is None and registered.heading is None)
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
