from algorithm.tools import transport_network as network
import pytest


def drawing_fixture(monkeypatch, count=3):
    geometry = [[55.7, 37.6 + i*.0001] for i in range(count+1)]
    edges = [{'id': str(i), 'begin_shape_index': i, 'end_shape_index': i+1} for i in range(count)]
    calls = []
    def raw(endpoint, action, body):
        calls.append((action, body))
        return {'shape': 'verified', 'edges': edges} if action == 'trace_attributes' else {'trip': {'legs': [{'shape': 'verified'}]}}
    monkeypatch.setattr(network, 'raw_valhalla', raw)
    monkeypatch.setattr(network, '_decode_polyline6', lambda shape: geometry)
    monkeypatch.setattr(network, 'trace_edges', lambda *args: edges)
    def snap(payload):
        index = int(payload['edgeId'])
        return {'id': f'road:{index}', 'edgeId': str(index), 'opposingEdgeId': str(index+1000),
                'geometry': geometry[index:index+2], 'lengthM': 10, 'name': 'Проверенная улица'}
    monkeypatch.setattr(network, 'snap', snap)
    return geometry, calls


def test_drawing_connects_more_than_twenty_network_edges_without_random_selection(monkeypatch):
    geometry, calls = drawing_fixture(monkeypatch, 25)
    result = network.draw_road({'points': [geometry[0], geometry[-1]], 'mode': 'points'})
    assert len(result['segments']) == 25
    assert result['lengthM'] == 250
    assert result['names'] == ['Проверенная улица']
    assert calls[0][0] == 'route'


def test_brush_uses_map_matching_and_rejects_a_wrong_carriageway(monkeypatch):
    geometry, calls = drawing_fixture(monkeypatch)
    assert len(network.draw_road({'points': geometry, 'mode': 'brush'})['segments']) == 3
    assert calls[0][0] == 'trace_attributes'
    assert calls[0][1]['shape_match'] == 'map_snap'
    monkeypatch.setattr(network, 'snap', lambda payload: {'edgeId': 'wrong'})
    with pytest.raises(ValueError, match='соседнюю'):
        network.draw_road({'points': geometry, 'mode': 'brush'})


def test_drawing_rejects_disconnected_levels_and_large_automatic_detours(monkeypatch):
    geometry, calls = drawing_fixture(monkeypatch)
    original = network.snap
    def disconnected(payload):
        result = original(payload)
        if payload['edgeId'] == '1':
            result['geometry'] = [[55.8,37.8], [55.801,37.801]]
        return result
    monkeypatch.setattr(network, 'snap', disconnected)
    with pytest.raises(ValueError, match='прерывается'):
        network.draw_road({'points': [geometry[0],geometry[-1]], 'mode': 'points'})
    monkeypatch.setattr(network, 'snap', original)
    monkeypatch.setattr(network, '_decode_polyline6', lambda shape: [geometry[0], [55.8,37.8], geometry[-1]])
    with pytest.raises(ValueError, match='большой объезд'):
        network.draw_road({'points': [geometry[0],geometry[-1]], 'mode': 'points'})


@pytest.mark.parametrize('points', [[], [[55.7,37.6]], [[55.7,37.6],[55.7,37.6]], [[0,0],[55.7,37.6]], [[True,37.6],[55.7,37.6]]])
def test_drawing_rejects_incomplete_or_out_of_region_strokes(points):
    with pytest.raises(ValueError):
        network.draw_road({'points': points, 'mode': 'points'})


def test_audit_attributes_metro_conflict_to_the_matching_event(monkeypatch):
    a, b, c = [55.7,37.6], [55.71,37.61], [55.72,37.62]
    monkeypatch.setattr(network,'catalog',lambda:{'stations':[{'id':'m:1','coords':a},{'id':'m:2','coords':b},{'id':'m:3','coords':c}]})
    base={'kind':'metro','status':'OPEN','startsAt':'2026-08-17T09:00:00+03:00','endsAt':None}
    events=[{**base,'id':'used','segments':[{'fromId':'m:1','toId':'m:2'}]},
            {**base,'id':'other','segments':[{'fromId':'m:2','toId':'m:3'}]}]
    payload={'events':events,'date':'2026-08-17','time':'10:00','team':[],'plan':{'routes':[]},'remainingOnly':True,
             'raw':{'plan':{'engineer_plans':[{'visits':[{'job_id':'J','departure_at':'2026-08-17T10:05:00+03:00',
               'travel':{'mode':'PUBLIC_TRANSIT','duration_minutes':2,'itinerary':[{'mode':'metro','duration_seconds':120,'geometry':[a,b],
                 'attributes':{'from_id':'m:1','to_id':'m:2'}}]}}]}]}}}
    result=network.audit(payload)
    assert {v['eventId'] for v in result['violations']}=={'used'}
    assert result['violations'][0]['orderId']=='J'


def test_impact_audit_uses_directed_remaining_edges_not_a_nearby_road(monkeypatch):
    monkeypatch.setattr(network,'trace_edges',lambda *args:[{'id':'10','end_node':{'elapsed_time':300}},{'id':'11','end_node':{'elapsed_time':600}}])
    base={'kind':'road','status':'OPEN','direction':'forward','startsAt':'2026-08-17T09:00:00+03:00','endsAt':None}
    events=[{**base,'id':name,'segments':[{'edgeId':edge,'geometry':[[55.7,37.6],[55.71,37.61]]}]} for name,edge in [('passed','10'),('future','11'),('bridge','99')]]
    result=network.audit({'events':events,'date':'2026-08-17','time':'10:05','remainingOnly':True,'team':[{'id':'E','transport':'CAR'}],
        'plan':{'routes':[{'engineerId':'E','assignments':[{'orderId':'J','departureAt':'10:00','arrival':'10:10','travelMinutes':10,'distanceM':1000,'geometry':[[55.7,37.6],[55.71,37.61]]}]}]}})
    assert {v['eventId'] for v in result['violations']}=={'future'}


@pytest.mark.parametrize('entry_seconds',[0,30])
@pytest.mark.parametrize('wait,status',[(68,'VALID'),(67,'INVALID'),(0,'INVALID')])
def test_entry_audit_checks_door_crossing_after_street_wait(monkeypatch,entry_seconds,wait,status):
    street,station,next_station=[55.7,37.6],[55.701,37.601],[55.71,37.61]
    monkeypatch.setattr(network,'catalog',lambda:{'stations':[{'id':'m:1','coords':station},{'id':'m:2','coords':next_station}]})
    event={'id':'closed-entry','kind':'entry','status':'OPEN','startsAt':'2026-08-17T09:00:00+03:00','endsAt':'2026-08-17T10:02:00+03:00','segments':[{'fromId':'m:1','geometry':[station]}]}
    steps=[{'mode':'walking','duration_seconds':52,'geometry':[street,station],'attributes':{'purpose':'station_access'}}]
    if wait:steps.append({'mode':'waiting','duration_seconds':wait,'geometry':[station],'attributes':{'source':'TRANSPORT_KNOWN_OPENING'}})
    if entry_seconds:steps.append({'mode':'station_entry','duration_seconds':entry_seconds,'geometry':[station],'attributes':{'from_id':'m:1'}})
    steps.append({'mode':'metro','duration_seconds':120,'geometry':[station,next_station],'attributes':{'from_id':'m:1','to_id':'m:2'}})
    payload={'events':[event],'date':'2026-08-17','time':'10:00','team':[],'plan':{'routes':[]},'raw':{'plan':{'engineer_plans':[{'visits':[{'job_id':'visit','departure_at':'2026-08-17T10:00:00+03:00','travel':{'mode':'PUBLIC_TRANSIT','duration_minutes':6,'itinerary':steps}}]}]}}}
    assert network.audit(payload)['status']==status


def test_wait_elsewhere_does_not_legalize_an_early_entry(monkeypatch):
    station=[55.701,37.601]
    monkeypatch.setattr(network,'catalog',lambda:{'stations':[{'id':'m:1','coords':station}]})
    event={'id':'e','kind':'entry','status':'OPEN','startsAt':'2026-08-17T09:00:00+03:00','endsAt':'2026-08-17T10:02:00+03:00','segments':[{'fromId':'m:1'}]}
    steps=[{'mode':'walking','duration_seconds':52,'geometry':[[55.7,37.6],station],'attributes':{'purpose':'metro_access'}},
           {'mode':'waiting','duration_seconds':68,'geometry':[[55.72,37.62]],'attributes':{}}]
    payload={'events':[event],'date':'2026-08-17','time':'10:00','team':[],'plan':{'routes':[]},'raw':{'plan':{'engineer_plans':[{'visits':[{'job_id':'v','departure_at':'2026-08-17T10:00:00+03:00','travel':{'mode':'PUBLIC_TRANSIT','duration_minutes':3,'itinerary':steps}}]}]}}}
    assert network.audit(payload)['status']=='INVALID'


def test_scenario_skips_an_ambiguous_first_edge_and_uses_a_proven_next_edge(monkeypatch):
    monkeypatch.setattr(network, 'catalog', lambda: {'segments': [], 'stations': []})
    edges = [{'id': str(i), 'length': .1, 'begin_shape_index': i, 'end_shape_index': i + 1} for i in range(4)]
    monkeypatch.setattr(network, 'trace_edges', lambda *args: edges)
    attempts = []

    def snap(payload):
        attempts.append(payload['coords'])
        if len(attempts) == 1:
            raise ValueError('Несколько уровней: привязка не доказана')
        return {'id': 'road:2', 'edgeId': '2', 'heading': 90}

    monkeypatch.setattr(network, 'snap', snap)
    choices = network.candidates({'kind': 'road', 'direction': 'forward', 'date': '2026-08-17', 'time': '14:25',
        'team': [{'sourceId': 'E', 'transport': 'CAR'}],
        'raw': {'plan': {'engineer_plans': [{'engineer_id': 'E', 'visits': [{
            'job_id': 'J', 'departure_at': '2026-08-17T14:30:00+03:00',
            'travel': {'distance_m': 1000, 'geometry': [[55.75, 37.6 + i / 1000] for i in range(5)]},
        }]}]}}})
    assert len(attempts) == 2
    assert choices[0]['segment']['edgeId'] == '2'


def test_entry_candidate_is_a_street_entrance_not_a_platform_reached_inside(monkeypatch):
    a, b = [55.75, 37.6], [55.751, 37.601]
    monkeypatch.setattr(network, 'catalog', lambda: {'segments': [], 'stations': [
        {'id': 'm:A', 'coords': a, 'name': 'Вход с улицы'}, {'id': 'm:B', 'coords': b, 'name': 'Внутренняя платформа'},
    ]})
    choices = network.candidates({'kind': 'entry', 'date': '2026-08-17', 'time': '15:45',
        'team': [{'sourceId': 'E', 'transport': 'PUBLIC_TRANSIT'}],
        'raw': {'plan': {'engineer_plans': [{'engineer_id': 'E', 'visits': [{
            'job_id': 'J', 'departure_at': '2026-08-17T15:52:00+03:00', 'travel': {'itinerary': [
                {'mode': 'walking_transfer', 'geometry': [[55.749, 37.599], a], 'duration_seconds': 120, 'attributes': {'source': 'VALHALLA_WALK_MATRIX'}},
                {'mode': 'walking_transfer', 'geometry': [a, b], 'duration_seconds': 180, 'attributes': {'source': 'MOSMETRO_SCHEMA'}},
                {'mode': 'metro', 'geometry': [b, [55.76, 37.61]], 'duration_seconds': 180, 'attributes': {}},
            ]},
        }]}]}}})
    assert choices[0]['segment']['id'] == 'm:A'
