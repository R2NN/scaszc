"""Read-only network selections/catalog and independent transport route audit."""
from __future__ import annotations
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from beeline_routing.valhalla import _decode_polyline6
from beeline_routing.restrictions import raw_valhalla, trace_edges, TransportContext, road_violations

ROOT = Path(__file__).resolve().parents[2]
ENDPOINT = os.environ.get('VALHALLA_ROUTE_ENDPOINT', 'http://127.0.0.1:8002/route')


def catalog():
    data = json.loads((ROOT / 'offline-assets/transit-sources/metro/schema.json').read_text())['data']
    lines = {str(line['id']): {'id': line['id'], 'name': line['name']['ru'], 'color': line['color']} for line in data['lines'] if not line.get('perspective')}
    stations = {str(s['id']): {'id': f'm:{s["id"]}', 'name': s['name']['ru'], 'lineId': s['lineId'], 'coords': [s['location']['lat'], s['location']['lon']]} for s in data['stations'] if not s.get('perspective') and s.get('location') and not s.get('mcd') and not s.get('mcc')}
    segments = []
    for kind, key in [('metro', 'connections'), ('transfer', 'transitions')]:
        for edge in data[key]:
            a, b = stations.get(str(edge.get('stationFromId'))), stations.get(str(edge.get('stationToId')))
            if not a or not b or edge.get('perspective') or not edge.get('pathLength'):
                continue
            segments.append({'id': f'{kind}:{edge["id"]}', 'fromId': a['id'], 'toId': b['id'], 'kind': kind,
                             'name': a['name'] + ' — ' + b['name'], 'seconds': edge['pathLength'],
                             'bidirectional': bool(edge.get('bi') and not edge.get('closedBackward')),
                             'lineId': a['lineId'], 'geometry': [a['coords'], b['coords']],
                             'geometryQuality': 'topological_station_link'})
    return {'stations': list(stations.values()), 'segments': segments, 'lines': lines,
            'source': 'https://prodapp.mosmetro.ru/api/schema/v1.0',
            'geometryNotice': 'Связи метро — схема между реальными станциями, не точная трасса тоннелей'}


def snap(payload):
    point = payload['coords']
    locations = [{'lat': point[0], 'lon': point[1], 'radius': 20, 'search_cutoff': 50}]
    result = raw_valhalla(ENDPOINT, 'locate', {'locations': locations, 'costing': 'auto', 'verbose': True})
    edges = result[0].get('edges', [])
    edges = [e for e in edges if e.get('edge', {}).get('access', {}).get('car') and e.get('distance', 999) <= 35]
    if not edges:
        raise ValueError('Рядом нет доступной автомобильной дороги. Приблизьте карту и выберите проезжую часть.')
    edge = min(edges, key=lambda e: e['distance'])
    shape = [list(p) for p in _decode_polyline6(edge['edge_info']['shape'])]
    if not edge['edge']['forward']:
        shape.reverse()
    # Midpoint is deliberately away from junction nodes, preventing exclusion
    # correlation from selecting a neighbouring turn/parallel carriageway.
    from beeline_planning.dispatch import split_geometry
    _, middle = split_geometry(shape, .5)
    nearby = raw_valhalla(ENDPOINT, 'locate', {'locations': [{'lat': middle[0], 'lon': middle[1], 'radius': 2, 'search_cutoff': 4}], 'costing': 'auto', 'verbose': True})[0].get('edges', [])
    middle_edge = next((e for e in nearby if e['edge_id']['value'] == edge['edge_id']['value']), edge)
    opposing = next((e for e in nearby if e['edge_info']['way_id'] == edge['edge_info']['way_id'] and e['edge_info']['shape'] == edge['edge_info']['shape'] and e['edge']['forward'] != edge['edge']['forward'] and e['edge']['access']['car']), None)
    correlation_proof = []
    graph = raw_valhalla(ENDPOINT,'status',{'verbose':True})
    graph_revision = f'{graph.get("version")}:{graph.get("tileset_last_modified")}'
    for intended in [middle_edge, *([opposing] if opposing else [])]:
        request = {'lat':middle[0],'lon':middle[1],'heading':intended['heading'],'heading_tolerance':8,
                   'radius':2,'search_cutoff':4,'node_snap_tolerance':0}
        matched = raw_valhalla(ENDPOINT,'locate',{'locations':[request],'costing':'auto','verbose':True})[0].get('edges',[])
        actual = {str(e['edge_id']['value']) for e in matched}
        if actual != {str(intended['edge_id']['value'])}:
            raise ValueError('В этой точке несколько дорожных рёбер или уровней. Выберите середину участка дальше от развязки: соседние пути закрывать нельзя.')
        correlation_proof.append({'edgeId':str(intended['edge_id']['value']),'location':request})
    return {'id': 'road:' + str(edge['edge_id']['value']), 'kind': 'road', 'edgeId': str(edge['edge_id']['value']),
            'opposingEdgeId': str(opposing['edge_id']['value']) if opposing else None,
            'wayId': str(edge['edge_info']['way_id']), 'heading': middle_edge['heading'], 'midpoint': list(middle),
            'geometry': shape, 'name': ' / '.join(edge['edge_info']['names']) or 'Проезд',
            'lengthM': edge['edge']['geo_attributes']['length'], 'bridge': edge['edge']['bridge'],
            'tunnel': edge['edge']['tunnel'], 'fromId': str(shape[0]), 'toId': str(shape[-1]),
            'correlationProof':correlation_proof, 'graphRevision':graph_revision, 'source': 'Valhalla 3.8.3 / OpenStreetMap'}


def audit(payload):
    context = TransportContext(payload['events'])
    violations, checked = [], 0
    engineers = {e['id']: e for e in payload['team']}
    at = payload['time']
    for route in payload['plan']['routes']:
        mode = engineers[route['engineerId']]['transport']
        if mode != 'CAR' or not context.road_events(mode):
            continue
        for visit in route['assignments']:
            if visit['arrival'] <= at:
                continue
            geometry = visit.get('geometry', [])
            if len(geometry) < 2 or visit.get('distanceM', 0) == 0:
                continue
            edges = trace_edges(ENDPOINT, geometry)
            departure = datetime.fromisoformat(f'{payload["date"]}T{visit["departureAt"]}:00+03:00')
            blocked = list(road_violations(context, context.road_events(mode), edges, departure, visit['travelMinutes'] * 60))
            violations.extend({'orderId': visit['orderId'], 'eventId': event['id']} for event in blocked)
            checked += 1
    checked_transit = 0
    if any(e.get('kind') != 'road' for e in context.events):
        network = catalog()
        points = {tuple(s['coords']): s['id'] for s in network['stations']}
        def station_id(point):
            exact=points.get(tuple(point))
            if exact:return exact
            near=[(sum(abs(point[i]-s['coords'][i]) for i in (0,1)),s['id']) for s in network['stations']]
            distance,identifier=min(near,default=(1,None))
            return identifier if distance<.00005 else None
        for route in payload.get('raw', {}).get('plan', {}).get('engineer_plans', []):
            for visit in route['visits']:
                travel = visit['travel']
                if travel.get('mode') != 'PUBLIC_TRANSIT':
                    continue
                departure = datetime.fromisoformat(visit['departure_at'])
                if departure + timedelta(minutes=travel['duration_minutes']) <= datetime.fromisoformat(f'{payload["date"]}T{at}:00+03:00'):
                    continue
                elapsed = 0
                itinerary=travel.get('itinerary', [])
                for index,step in enumerate(itinerary):
                    attrs, geometry = step['attributes'], step['geometry']
                    source = attrs.get('from_id') or (station_id(geometry[0]) if geometry else None)
                    target = attrs.get('to_id') or (station_id(geometry[-1]) if geometry else None)
                    when = departure + timedelta(seconds=elapsed)
                    kind = 'metro' if step['mode'] == 'metro' else 'transfer' if step['mode'] == 'walking_transfer' and attrs.get('source') != 'VALHALLA_WALK_MATRIX' else None
                    if kind and source and target and context.blocked(kind, source, target, when):
                        violations.append({'orderId': visit['job_id'], 'kind': kind, 'fromId': source, 'toId': target})
                    if step['mode'] in ('station_entry','station_exit') and source and context.blocked('entry', source, None, when):
                        violations.append({'orderId':visit['job_id'],'kind':'entry','fromId':source})
                    if step['mode'] == 'walking' and target and attrs.get('purpose') in ('station_access','metro_access'):
                        # Reaching the door is not entry. Independently account
                        # for stationary street-side waiting before crossing it,
                        # including zero-duration entry legs omitted by the router.
                        entry_at=when+timedelta(seconds=step['duration_seconds'])
                        for following in itinerary[index+1:]:
                            waiting_points=following.get('geometry',[])
                            if following['mode']!='waiting' or not waiting_points or not all(sum(abs(p[i]-geometry[-1][i]) for i in (0,1))<.00005 for p in waiting_points):
                                break
                            entry_at+=timedelta(seconds=following['duration_seconds'])
                        if context.blocked('entry',target,None,entry_at):
                            violations.append({'orderId':visit['job_id'],'kind':'entry','fromId':target})
                    exited=index>0 and itinerary[index-1]['mode']=='station_exit' and (itinerary[index-1].get('attributes',{}).get('from_id') or (station_id(itinerary[index-1]['geometry'][0]) if itinerary[index-1].get('geometry') else None))==source
                    if step['mode'] == 'walking' and source and not exited and attrs.get('purpose') in ('station_egress','metro_egress') and context.blocked('entry',source,None,when):
                        violations.append({'orderId':visit['job_id'],'kind':'entry','fromId':source})
                    if step['mode'] == 'walking_transfer' and attrs.get('source') == 'VALHALLA_WALK_MATRIX':
                        if source and context.blocked('entry',source,None,when) or target and context.blocked('entry',target,None,when+timedelta(seconds=step['duration_seconds'])):
                            violations.append({'orderId':visit['job_id'],'kind':'entry','fromId':source,'toId':target})
                    elapsed += step['duration_seconds']
                checked_transit += 1
    return {'status': 'VALID' if not violations else 'INVALID', 'checkedRoadLegs': checked, 'checkedTransitLegs': checked_transit, 'violations': violations, 'contextSha256': context.digest}


def candidates(payload):
    network = catalog()
    by_points = {(tuple(s['geometry'][0]),tuple(s['geometry'][-1])): s for s in network['segments'] if s['kind'] == payload['kind']}
    stations = {tuple(s['coords']): s for s in network['stations']}
    engineers = {e['sourceId']:e for e in payload['team']}
    at = datetime.fromisoformat(f'{payload["date"]}T{payload["time"]}:00+03:00')
    options = []
    for route in payload['raw']['plan']['engineer_plans']:
        mode = engineers.get(route['engineer_id'],{}).get('transport')
        if (payload['kind']=='road') != (mode=='CAR'):
            continue
        for visit in route['visits']:
            departure = datetime.fromisoformat(visit['departure_at'])
            if departure < at or departure > at+timedelta(hours=2):
                continue
            travel = visit['travel']
            if payload['kind']=='road':
                if travel.get('distance_m',0)<600:
                    continue
                edges = trace_edges(ENDPOINT,travel['geometry'])
                for edge in edges[len(edges)//4:len(edges)*3//4]:
                    if edge.get('length',0)<.03 or edge.get('length',0)>.4:
                        continue
                    a,b=edge['begin_shape_index'],edge['end_shape_index']
                    coords=travel['geometry'][(a+b)//2]
                    try:
                        selected=snap({'coords':coords})
                    except ValueError:
                        # A crossing/parallel road can be ambiguous. Continue
                        # searching actual used edges instead of aborting the
                        # whole day's demonstration at its first candidate.
                        continue
                    if selected['edgeId']!=str(edge['id']):
                        continue
                    if payload.get('direction')=='forward' and selected['heading'] is None:
                        continue
                    options.append({'segment':selected,'engineerId':route['engineer_id'],'orderId':visit['job_id'],'usedAt':departure.isoformat()})
                    break
            else:
                elapsed = 0
                for step in travel.get('itinerary',[]):
                    geometry=step['geometry']
                    selected=None
                    if geometry and payload['kind']=='entry':
                        attrs=step.get('attributes',{})
                        access=step['mode']=='walking' and attrs.get('purpose') in ('station_access','metro_access')
                        egress=step['mode']=='walking' and attrs.get('purpose') in ('station_egress','metro_egress')
                        street_transfer=step['mode']=='walking_transfer' and attrs.get('source')=='VALHALLA_WALK_MATRIX'
                        # Passing a platform on a train or through an internal
                        # interchange never proves use of that street entrance.
                        endpoints=([geometry[-1]] if access else [geometry[0]] if egress else [geometry[-1],geometry[0]] if street_transfer else [])
                        station=next((s for p in endpoints for s in stations.values() if sum(abs(p[i]-s['coords'][i]) for i in (0,1))<.00005),None)
                        if station:selected={**station,'kind':'entry','fromId':station['id'],'toId':None,'geometry':[station['coords']]}
                    elif geometry and step['mode'] in ('metro','walking_transfer'):
                        selected=by_points.get((tuple(geometry[0]),tuple(geometry[-1]))) or by_points.get((tuple(geometry[-1]),tuple(geometry[0])))
                    if selected:
                        options.append({'segment':selected,'engineerId':route['engineer_id'],'orderId':visit['job_id'],'usedAt':(departure+timedelta(seconds=elapsed)).isoformat()})
                        break
                    elapsed += step['duration_seconds']
            if len(options)>=10:
                return options
    return options


if __name__ == '__main__':
    try:
        payload = json.load(sys.stdin)
        action = payload.pop('action')
        result = catalog() if action == 'catalog' else snap(payload) if action == 'snap' else candidates(payload) if action == 'candidates' else audit(payload)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
