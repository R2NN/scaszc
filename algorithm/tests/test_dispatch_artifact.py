"""Reopen real serialized artifacts, including their dataset/content checksums."""
from dataclasses import replace
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from prepare_ui_dataset import prepare
from replan_ui_event import _at, _event_dataset, _dispatch_constraints
from verify_dispatch_artifact import verify
from beeline_planning import EngineerPlan, PlannedVisit, ProposedPlan, ReplanningState, load_planning_dataset, replan_after_event, validate_initial_plan
from beeline_planning.export import materialization_result_dict, load_exact_plan_artifact
from beeline_planning.materialize import MaterializationResult, MaterializationStatus
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import OracleQuery
from algorithm.tests.test_dispatch import DispatchOracle


def stored_artifact(root, *, overdue=False):
    order = {'id':'A','workType':'Аварийные работы','skill':'EMERGENCY','priority':'Обычная','duration':30,
        'zoneId':'EAST','coords':[55.71,37.61],'start':'08:00','end':'17:00'}
    team = [{'id':key,'skills':['EMERGENCY'],'equipment':[],'zoneId':'EAST','startCoords':[55.7,37.6],
        'shiftStart':'08:00','shiftEnd':'18:00','status':'Доступен','transport':'CAR'} for key in ['E1','E2']]
    orders = [order,{**order,'id':'B','coords':[55.72,37.62],'start':'14:00'}]
    dataset_path = root/'dataset'
    prepare({'planningDate':'2026-08-17','orders':orders,'engineers':team},dataset_path)
    data = load_planning_dataset(dataset_path,'core')
    oracle = DispatchOracle()
    origin = data.locations[data.offices[data.engineers['E1'].start_office_id].location_id]
    visits = []
    for key, departure, start in [('A','09:30','09:40'),('B','13:40','14:00')]:
        destination = data.locations[data.jobs[key].location_id]
        travel = oracle.query(OracleQuery(data.engineers['E1'].transport_mode,origin,destination,_at(data,departure)))
        visits.append(PlannedVisit(key,_at(data,departure),_at(data,start),travel))
        origin = destination
    old = ProposedPlan(data.initial_planning_at,(EngineerPlan('E1',tuple(visits)),),())
    source_report = validate_initial_plan(data,old)
    assert source_report.is_valid, source_report.violations
    source = materialization_result_dict(MaterializationResult(MaterializationStatus.EXACT_VALID,old,source_report,None,0,0))
    source['dataset_sha256'] = data.dataset_sha256
    source['content_sha256'] = payload_sha256(source)
    source_path = root/'algorithm/artifacts/complexity/initial-exact.json'
    source_path.parent.mkdir(parents=True)
    write_json_atomic(source_path,source)
    emergency = {**order,'id':'U','priority':'Авария','coords':[55.73,37.63]}
    event_time = '11:00' if overdue else '09:00'
    payload = {'orders':[*orders,emergency],'team':team,'facts':[{'orderId':'A','engineerId':'E1','status':'started','time':'08:50'}],
        'basePlanContentSha256':source['content_sha256'],'event':{'type':'NEW_ORDER','time':event_time,'orderId':'U'}}
    changed, event = _event_dataset(data,payload)
    changed = replace(changed,events=(event,))
    result = replan_after_event(changed,ReplanningState(old),event,oracle,source_dataset=data,
        forced_engineer_by_job={'U':'E2' if overdue else 'E1'},dispatch_engineer_id='E2' if overdue else 'E1',
        protected_job_ids=frozenset({'A'}),locked_engineer_ids=frozenset({'E1'}) if overdue else frozenset(),
        available_after_by_engineer={} if overdue else {'E1':_at(data,'10:10')},departure_timing_queries=24)
    assert result.validation.is_valid, result.validation.violations
    raw = materialization_result_dict(MaterializationResult(MaterializationStatus.EXACT_VALID,result.state.plan,result.validation,None,0,0))
    raw.update(artifact_type='EXACT_PLAN_REPLANNING',dataset_sha256=changed.dataset_sha256,
        source_plan_content_sha256=source['content_sha256'],ui_history=[{key:payload[key] for key in ['event','orders','team']}],dispatch_input=payload)
    raw['content_sha256'] = payload_sha256(raw)
    file = root/'dispatch.json'
    write_json_atomic(file,raw)
    return file,dataset_path,raw


@pytest.mark.parametrize('overdue',[False,True])
def test_saved_artifact_restores_operational_facts(tmp_path,overdue):
    file,dataset_path,_ = stored_artifact(tmp_path,overdue=overdue)
    report = verify(file,dataset_path,tmp_path)
    assert report['status'] == 'VALID', report['violations']


@pytest.mark.parametrize('overdue', [False, True])
def test_coverage_repair_reopens_fact_bound_incumbent_without_releasing_work(tmp_path, overdue):
    file, dataset_path, raw = stored_artifact(tmp_path, overdue=overdue)
    source = load_planning_dataset(dataset_path, 'core')
    old, _ = load_exact_plan_artifact(tmp_path / 'algorithm/artifacts/complexity/initial-exact.json', source.dataset_sha256)
    data, event = _event_dataset(source, raw['dispatch_input'])
    data = replace(data, events=(event,))
    incumbent, _ = load_exact_plan_artifact(file, data.dataset_sha256)
    engineer = next(r.engineer_id for r in incumbent.engineer_plans if any(v.job_id == 'U' for v in r.visits))
    result = replan_after_event(data, ReplanningState(old), event, DispatchOracle(), source_dataset=source,
        incumbent_plan=incumbent, coverage_repair_seconds=.1, rebuild_future=True,
        dispatch_engineer_id=engineer, forced_engineer_by_job={'U': engineer}, departure_timing_queries=0,
        **_dispatch_constraints(data, old, event.event_time, raw['dispatch_input']))
    assert result.state is not None, result.detail
    assert result.validation.is_valid
    before = next(r for r in incumbent.engineer_plans if r.engineer_id == 'E1')
    after = next(r for r in result.state.plan.engineer_plans if r.engineer_id == 'E1')
    assert after.visits == before.visits


def test_saved_artifact_still_checks_content_checksum(tmp_path):
    file,dataset_path,raw = stored_artifact(tmp_path)
    raw['dispatch_input']['facts'][0]['time'] = '08:00'
    write_json_atomic(file,raw)
    with pytest.raises(ValueError,match='checksum'):
        verify(file,dataset_path,tmp_path)


def test_saved_artifact_cannot_change_locked_future_travel(tmp_path):
    file,dataset_path,raw = stored_artifact(tmp_path,overdue=True)
    route = next(route for route in raw['plan']['engineer_plans'] if route['engineer_id']=='E1')
    visit = next(visit for visit in route['visits'] if visit['job_id']=='B')
    visit['departure_at'] = visit['departure_at'].replace('13:40','13:45')
    visit['travel']['departure_at'] = visit['departure_at']
    raw['content_sha256'] = payload_sha256({key:value for key,value in raw.items() if key!='content_sha256'})
    write_json_atomic(file,raw)
    report = verify(file,dataset_path,tmp_path)
    assert report['status'] == 'INVALID'
    assert any(item['code']=='FROZEN_ACTIVITY_CHANGED' for item in report['violations'])
