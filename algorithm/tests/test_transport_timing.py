"""Boundary regressions for official metro operating hours and known openings."""
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from dataclasses import asdict

import pytest
from algorithm.tools import transport_network

from beeline_routing.metro_reference import MetroReference
from beeline_routing.local_transit import LocalTransitRoutingClient
from beeline_routing.models import Coordinate
from beeline_routing.restrictions import TransportContext


def graph():
    value=MetroReference.__new__(MetroReference)
    schedules=[{'weekend':False,'first':'05:30','last':'00:40'},
               {'weekend':True,'first':'06:00','last':'01:20'}]
    value.stations={1:{'lineId':1,'location':{'lat':55.7,'lon':37.6},'name':{'ru':'A'},'scheduleTrains':{'2':schedules}},
                    2:{'lineId':1,'location':{'lat':55.71,'lon':37.61},'name':{'ru':'B'}}}
    value.edges={1:[(2,120,'metro')],2:[]}
    value.boarding_wait_seconds=180
    value.transport_context=TransportContext([])
    value.schema_path=Path('official-fixture.json')
    value._nearby_walks=lambda *args,inbound,**kwargs:{2 if inbound else 1:None}
    return value


def event(start,end,kind='entry',source='m:2',target=None):
    return {'id':start,'kind':kind,'status':'OPEN','startsAt':start,'endsAt':end,
            'segments':[{'fromId':source,'toId':target}],'direction':'both'}


def test_schedule_uses_boarding_date_and_previous_service_day_after_midnight():
    value=graph()
    for at,expected in [('2026-08-17T00:50:00+03:00',True), # Sunday service
                        ('2026-08-18T00:50:00+03:00',False),
                        ('2026-08-22T05:45:00+03:00',False),
                        ('2026-08-22T06:00:00+03:00',True),
                        ('2026-08-17T00:40:00+00:00',False)]:
        assert value._train_available(1,2,0,datetime.fromisoformat(at),0) is expected
    # A wait crossing midnight still belongs to Friday's weekday service.
    assert not value._train_available(1,2,0,datetime.fromisoformat('2026-08-21T23:59:00+03:00'),3600)


def test_separate_schedule_windows_are_not_merged_into_a_fictional_train():
    value=graph()
    value.stations[1]['scheduleTrains']['2']=[{'weekend':False,'first':'05:30','last':'09:00'},
                                             {'weekend':False,'first':'17:00','last':'23:00'}]
    assert not value._train_available(1,2,0,datetime.fromisoformat('2026-08-17T12:00:00+03:00'),0)


def test_known_opening_follows_consecutive_closures_and_unknown_end():
    events=[event('2026-08-17T14:00:00+03:00','2026-08-17T14:10:00+03:00'),
            event('2026-08-17T14:10:00+03:00','2026-08-17T14:20:00+03:00')]
    at=datetime.fromisoformat('2026-08-17T14:05:00+03:00')
    assert TransportContext(events).next_open('entry','m:2',None,at)==at.replace(minute=20)
    events[1]['endsAt']=None
    assert TransportContext(events).next_open('entry','m:2',None,at) is None


def test_metro_route_waits_for_exit_opening_and_reports_wait_separately():
    value=graph()
    value.transport_context=TransportContext([event('2026-08-17T14:00:00+03:00','2026-08-17T14:10:00+03:00'),
                                             event('2026-08-17T14:10:00+03:00','2026-08-17T14:20:00+03:00')])
    at=datetime.fromisoformat('2026-08-17T14:00:00+03:00')
    route=value.route(Coordinate('a',55.7,37.6),Coordinate('b',55.71,37.61),at)
    assert route.duration_seconds==1200
    assert sum(s.duration_seconds for s in route.itinerary)==route.duration_seconds
    assert sum(s.duration_seconds for s in route.itinerary if s.mode=='waiting')==900


def test_restricted_mixed_metro_waits_for_track_opening_but_rejects_last_train():
    value=LocalTransitRoutingClient.__new__(LocalTransitRoutingClient)
    value.transport_graph=graph()
    value.query_departure=datetime.fromisoformat('2026-08-17T14:00:00+03:00')
    value.transport_context=TransportContext([event('2026-08-17T14:00:00+03:00','2026-08-17T14:10:00+03:00','metro','m:1','m:2')])
    paths=value._restricted_metro_paths('m:1',14*3600)
    assert paths[0][1]==720
    assert paths[0][2][0]['opening_wait_seconds']==420
    value.query_departure=datetime.fromisoformat('2026-08-18T00:39:00+03:00')
    value.transport_context=TransportContext([])
    assert not value._restricted_metro_paths('m:1',39*60)


def test_known_track_opening_cannot_create_a_train_after_service_ends():
    value=graph()
    value.transport_context=TransportContext([event('2026-08-18T00:30:00+03:00','2026-08-18T00:50:00+03:00','metro','m:1','m:2')])
    assert value.route(Coordinate('a',55.7,37.6),Coordinate('b',55.71,37.61),datetime.fromisoformat('2026-08-18T00:30:00+03:00')) is None


def test_official_late_weekend_train_is_not_rejected_by_a_fixed_one_am_cutoff():
    value=graph()
    route=value.route(Coordinate('a',55.7,37.6),Coordinate('b',55.71,37.61),datetime.fromisoformat('2026-08-17T01:10:00+03:00'))
    assert route is not None and route.duration_seconds==300
    assert value.route(Coordinate('a',55.7,37.6),Coordinate('b',55.71,37.61),datetime.fromisoformat('2026-08-18T01:10:00+03:00')) is None


@pytest.mark.parametrize('entry_seconds',[0,30])
def test_router_and_independent_audit_agree_on_68_second_entry_wait(monkeypatch,entry_seconds):
    value=graph()
    value.stations[1]['enterTime']=entry_seconds
    walk=SimpleNamespace(duration_seconds=52,distance_m=65,geometry=((55.699,37.599),(55.7,37.6)))
    value._nearby_walks=lambda *args,inbound,**kwargs:{2:None} if inbound else {1:walk}
    closed=event('2026-08-17T09:00:00+03:00','2026-08-17T10:02:00+03:00',source='m:1')
    value.transport_context=TransportContext([closed])
    departure=datetime.fromisoformat('2026-08-17T10:00:00+03:00')
    route=value.route(Coordinate('a',55.699,37.599),Coordinate('b',55.71,37.61),departure)
    assert route is not None
    assert [step.duration_seconds for step in route.itinerary if step.mode=='waiting']==[68]
    assert sum(step.duration_seconds for step in route.itinerary)==route.duration_seconds
    monkeypatch.setattr(transport_network,'catalog',lambda:{'stations':[{'id':f'm:{key}','coords':list(value._point(key))} for key in value.stations]})
    payload={'events':[closed],'date':'2026-08-17','time':'10:00','team':[],'plan':{'routes':[]},'raw':{'plan':{'engineer_plans':[{'visits':[{
        'job_id':'visit','departure_at':departure.isoformat(),'travel':{'mode':'PUBLIC_TRANSIT','duration_minutes':route.duration_minutes,'itinerary':[asdict(step) for step in route.itinerary]}
    }]}]}}}
    result=transport_network.audit(payload)
    assert result['status']=='VALID',result
    assert result['checkedTransitLegs']==1
