from dataclasses import replace
import json
from types import SimpleNamespace
from datetime import timedelta
import pytest
from algorithm.tests.test_dispatch import scenario
from beeline_planning import ReplanningState, replan_after_event
from beeline_planning.dispatch import transport_checkpoint, checkpoint_location, verify_checkpoint
from beeline_routing.models import RouteStep, TransportMode
from beeline_routing.restrictions import TransportContext


def context_for(geometry,kind='road'):
    return TransportContext([{'id':'closure','revision':1,'kind':kind,'modes':['CAR'],'direction':'both','status':'OPEN',
      'startsAt':'2026-08-17T09:00:00+03:00','endsAt':None,
      'segments':[{'edgeId':'1','fromId':'m:1','toId':'m:2','geometry':geometry}]}])


def test_car_transport_diversion_keeps_routed_current_point_and_elapsed_movement():
    f,source,data,old,event,oracle,_=scenario()
    leg=old.engineer_plans[0].visits[0].travel
    context=context_for(leg.geometry)
    # Fixture dates deliberately differ from the Moscow acceptance dataset.
    context.events[0]['startsAt']=event.event_time.isoformat()
    anchor=transport_checkpoint(old.engineer_plans[0],event.event_time,TransportMode.CAR,context)
    assert anchor and anchor['fraction']==.5
    data=replace(data,locations={**data.locations,anchor['location_id']:checkpoint_location(anchor)})
    result=replan_after_event(data,ReplanningState(old),event,oracle,source_dataset=source,
                             transport_anchors={'E1':anchor},departure_timing_queries=0)
    route=next(r for r in result.state.plan.engineer_plans if r.engineer_id=='E1')
    assert result.validation.is_valid
    assert route.movements[0]['coords']==anchor['coords']
    assert route.movements[0]['travel_minutes']==5
    assert route.visits[0].travel.origin_id==anchor['location_id']


@pytest.mark.parametrize('vehicle',['metro','Пригородный поезд'])
def test_transit_does_not_alight_between_stations_and_checkpoint_is_independently_replayed(vehicle):
    f,source,data,old,event,oracle,_=scenario(TransportMode.PUBLIC_TRANSIT)
    visit=old.engineer_plans[0].visits[0]
    a,b=visit.travel.geometry
    p=(a[0]+(b[0]-a[0])*.2,a[1]+(b[1]-a[1])*.2)
    q=(a[0]+(b[0]-a[0])*.8,a[1]+(b[1]-a[1])*.8)
    steps=(RouteStep(0,'walking',120,200,0,(a,p),{'purpose':'station_access'}),
           RouteStep(1,vehicle,360,600,0,(p,q),{'from_id':'m:1','to_id':'m:2'}),
           RouteStep(2,'walking',120,200,0,(q,b),{'purpose':'station_egress'}))
    travel=replace(visit.travel,itinerary=steps,geometry=(a,p,q,b),duration_seconds=600,duration_minutes=10,distance_m=1000)
    route=replace(old.engineer_plans[0],visits=(replace(visit,travel=travel),*old.engineer_plans[0].visits[1:]))
    context=context_for([q],'entry');context.events[0]['startsAt']=event.event_time.isoformat()
    # Trigger the broad phase using the known future access, while leaving
    # this alighting station open in the actual event interval.
    context.events[0]['segments'][0]['geometry']=[b]
    context.events[0]['startsAt']=(visit.departure_at+timedelta(minutes=9)).isoformat()
    anchor=transport_checkpoint(route,event.event_time,TransportMode.PUBLIC_TRANSIT,context)
    assert anchor['policy']=='TRANSIT_STEP_EXIT'
    assert anchor['coords']==list(q)
    assert anchor['at']==(visit.departure_at+timedelta(minutes=8)).isoformat()
    locations={anchor['location_id']:checkpoint_location(anchor)}
    assert verify_checkpoint(anchor,locations)
    assert not verify_checkpoint({**anchor,'distance_m':9999},locations)
    assert not verify_checkpoint({**anchor,'coords':list(p)},locations)


@pytest.mark.parametrize('known_opening',[False,True])
def test_closed_current_exit_searches_real_graph_or_waits_for_known_opening(monkeypatch,known_opening):
    import beeline_planning.dispatch as dispatch
    _,_,_,old,event,_,_=scenario(TransportMode.PUBLIC_TRANSIT)
    visit=old.engineer_plans[0].visits[0];a,b=visit.travel.geometry
    p=(a[0]+.001,a[1]+.001);q=(a[0]+.002,a[1]+.002);r=(a[0]+.003,a[1]+.003)
    steps=(RouteStep(0,'walking',120,200,0,(a,p),{'purpose':'station_access'}),RouteStep(1,'metro',360,600,0,(p,q),{'from_id':'m:1','to_id':'m:2'}),RouteStep(2,'walking',120,200,0,(q,b),{'purpose':'station_egress'}))
    travel=replace(visit.travel,itinerary=steps,geometry=(a,p,q,b),duration_seconds=600,duration_minutes=10,distance_m=1000)
    route=replace(old.engineer_plans[0],visits=(replace(visit,travel=travel),))
    context=context_for([q],'entry');context.events[0]['segments'][0]['fromId']='m:2';context.events[0]['startsAt']=event.event_time.isoformat()
    if known_opening:context.events[0]['endsAt']=(visit.departure_at+timedelta(minutes=9)).isoformat()
    # The shorter first edge is forbidden; the second edge reaches a legal exit.
    context.events.append({**context.events[0],'id':'blocked-ride','kind':'metro','endsAt':None,'segments':[{'fromId':'m:2','toId':'m:4','geometry':[q,b]}]})
    context=TransportContext(context.events)
    graph=SimpleNamespace(stations={2:{'lineId':1},3:{'lineId':1},4:{'lineId':1}},edges={2:[(4,60,'metro'),(3,120,'metro')],3:[],4:[]},_point=lambda key:{2:q,3:r,4:b}[key],_train_available=lambda *args:True)
    monkeypatch.setattr(dispatch,'_metro_escape_graph',lambda:graph);monkeypatch.setenv('BEEGO_TRANSPORT_CONTEXT_JSON',json.dumps(context.events))
    anchor=transport_checkpoint(route,event.event_time,TransportMode.PUBLIC_TRANSIT,context)
    assert anchor['policy']=='TRANSIT_SAFE_EXIT';assert anchor['coords']==list(q if known_opening else r)
    assert anchor['at']==(visit.departure_at+timedelta(minutes=9 if known_opening else 10)).isoformat()
    assert bool(anchor['escape_waits'])==known_opening
    assert verify_checkpoint(anchor,{anchor['location_id']:checkpoint_location(anchor)})
    assert not verify_checkpoint({**anchor,'escape_steps':[]},{anchor['location_id']:checkpoint_location(anchor)})
    ended=[{**e,'status':'ENDED'} for e in context.events]
    monkeypatch.setenv('BEEGO_TRANSPORT_CONTEXT_JSON',json.dumps(ended))
    assert verify_checkpoint(anchor,{anchor['location_id']:checkpoint_location(anchor)}),'Past movement keeps its original verified context'


def test_coincident_platform_of_another_line_is_not_closed_by_a_coordinate_match(monkeypatch):
    import beeline_planning.dispatch as dispatch
    from datetime import datetime
    a,b=[55.75,37.6],[55.751,37.601]
    original={'departure_at':'2026-08-17T15:30:00+03:00','itinerary':[{'mode':'metro','duration_seconds':120,'distance_m':100,'geometry':[a,b],'attributes':{'to_id':'m:5','line_id':2}}]}
    context=context_for([b],'entry');context.events[0]['segments'][0]['fromId']='m:2'
    graph=SimpleNamespace(stations={2:{'lineId':1},5:{'lineId':2}},_point=lambda key:tuple(b))
    monkeypatch.setattr(dispatch,'_metro_escape_graph',lambda:graph)
    result=dispatch._safe_transit_exit(original,datetime.fromisoformat('2026-08-17T15:31:00+03:00'),context)
    assert result[1]==tuple(b) and result[4]==[]
