from datetime import datetime, timedelta
from types import SimpleNamespace
import pytest
from beeline_routing.restrictions import TransportContext, road_violations


def event(kind='metro', **patch):
    return {'id':'e','kind':kind,'modes':['CAR'],'status':'OPEN','direction':'both',
            'startsAt':'2026-08-17T14:25:00+03:00','endsAt':'2026-08-17T15:00:00+03:00',
            'segments':[{'fromId':'m:1','toId':'m:2','edgeId':'10','opposingEdgeId':'11','geometry':[[55.75,37.6],[55.751,37.6]]}],**patch}


@pytest.mark.parametrize('minute,blocked',[(24,False),(25,True),(59,True),(60,False),(61,False)])
def test_moscow_boundaries(minute,blocked):
    at=datetime.fromisoformat('2026-08-17T14:00:00+03:00')+timedelta(minutes=minute)
    assert TransportContext([event()]).blocked('metro','m:1','m:2',at)==blocked


def test_closing_entry_does_not_close_train_or_transfer():
    at=datetime.fromisoformat('2026-08-17T14:30:00+03:00')
    context=TransportContext([event('entry')])
    assert context.blocked('entry','m:1',None,at)
    assert not context.blocked('metro','m:1','m:2',at)
    assert not context.blocked('transfer','m:1','m:2',at)


def test_directed_edges_do_not_block_bridge_parallel_or_reverse():
    at=datetime.fromisoformat('2026-08-17T14:30:00+03:00')
    e=event('road',direction='forward');context=TransportContext([e])
    edges=[{'id':'99','end_node':{'elapsed_time':10}},{'id':'11','end_node':{'elapsed_time':20}}]
    assert not list(road_violations(context,[e],edges,at,20))
    assert list(road_violations(context,[e],[{'id':'10','end_node':{'elapsed_time':20}}],at,20))
    assert not context.road_events('WALKING')


def test_planned_closure_checks_edge_entry_and_keeps_already_passed_edge():
    at=datetime.fromisoformat('2026-08-17T14:20:00+03:00')
    e=event('road');context=TransportContext([e])
    edges=[{'id':'99','end_node':{'elapsed_time':360}},{'id':'10','end_node':{'elapsed_time':600}}]
    assert list(road_violations(context,[e],edges,at,600))
    edges.reverse();assert not list(road_violations(context,[e],edges,at,600))


def test_context_changes_on_edit_and_end_without_cross_context_cache_reuse():
    a=TransportContext([event()]);b=TransportContext([event(endsAt=None)]);c=TransportContext([event(status='ENDED')])
    assert len({a.digest,b.digest,c.digest})==3
    assert not c.blocked('metro','m:1','m:2',datetime.fromisoformat('2026-08-17T14:30:00+03:00'))


def test_spatial_screen_only_requests_audit_and_preserves_unrelated_routes():
    context=TransportContext([event('road')]);at=datetime.fromisoformat('2026-08-17T14:30:00+03:00')
    travel=SimpleNamespace(departure_at=at,duration_minutes=10,geometry=((55.74,37.6),(55.76,37.6)))
    assert context.affects_travel(travel,'CAR')
    assert not context.affects_travel(travel,'WALKING')
    travel.geometry=((55.8,37.8),(55.81,37.8));assert not context.affects_travel(travel,'CAR')
