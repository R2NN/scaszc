from dataclasses import replace
from datetime import timedelta

from algorithm.tests import test_replanning as fixtures
from beeline_planning import EngineerPlan, ProposedPlan, ReplanningState, replan_after_event, validate_replanned_plan
from beeline_planning.domain import Priority, EventType
from beeline_planning.dispatch import checkpoint, checkpoint_location, verify_checkpoint
from beeline_routing.models import TransportMode
from beeline_routing.oracle import OracleQuery


class DispatchOracle(fixtures._Oracle):
    def query(self, query):
        result=super().query(query)
        return replace(result,provenance=replace(result.provenance,provider_metadata={'origin_heading':query.origin.heading}))


def scenario(mode=TransportMode.CAR, event_minute=5, waiting=False):
    f=fixtures.ReplanningTests(); f.setUp()
    f.engineers['E1']=replace(f.engineers['E1'],transport_mode=mode)
    f.jobs['A']=replace(f.jobs['A'],location_id='L2')
    oracle=DispatchOracle()
    leg=oracle.query(OracleQuery(mode,f.locations['L1'],f.locations['L2'],f.at(9)))
    return_leg=oracle.query(OracleQuery(mode,f.locations['L2'],f.locations['L1'],f.at(11)))
    old=ProposedPlan(f.t0,(EngineerPlan('E1',(f.visit('A',f.at(9),service_start=f.at(10) if waiting else f.at(9,10),travel=leg),f.visit('B',f.at(11),service_start=f.at(11,10),travel=return_leg))),),())
    source=f.make_dataset(())
    at=f.at(9,event_minute)
    f.jobs['U']=f.job('U','Z1',at,priority=Priority.URGENT,location='L3')
    event=f.event(1,EventType.NEW_URGENT_JOB,'U',at)
    data=f.make_dataset((event,))
    point=checkpoint(old.engineer_plans[0],at,mode)
    if point: data=replace(data,locations={**data.locations,point['location_id']:checkpoint_location(point)})
    return f,source,data,old,event,oracle,point


def solve(parts):
    f,source,data,old,event,oracle,point=parts
    # Source jobs are immutable at the baseline time, before the new urgent job.
    return replan_after_event(data,ReplanningState(old),event,oracle,source_dataset=source,
        forced_engineer_by_job={'U':'E1'},dispatch_engineer_id='E1',departure_timing_queries=0)


def test_mid_car_leg_restarts_from_road_point_and_preserves_elapsed_cost():
    parts=scenario(); result=solve(parts); point=parts[-1]
    route=next(r for r in result.state.plan.engineer_plans if r.engineer_id=='E1')
    assert route.visits[0].job_id=='U'
    assert route.visits[0].departure_at==parts[4].event_time
    assert route.visits[0].travel.origin_id==point['location_id']
    assert route.movements[0]['distance_m']==500
    assert result.validation.is_valid
    assert result.validation.metrics.total_distance_m >= 3500


def test_started_service_finishes_before_emergency_departure():
    parts=scenario(event_minute=15); result=solve(parts)
    route=next(r for r in result.state.plan.engineer_plans if r.engineer_id=='E1')
    assert route.visits[0]==parts[3].engineer_plans[0].visits[0]
    assert route.visits[1].job_id=='U'
    assert route.visits[1].departure_at==parts[0].at(9,40)


def test_waiting_service_may_move_and_transit_must_reach_legal_exit():
    parts=scenario(event_minute=20,waiting=True); result=solve(parts)
    route=next(r for r in result.state.plan.engineer_plans if r.engineer_id=='E1')
    assert route.visits[0].job_id=='U'
    assert route.movements[0]['fraction']==1
    # Ten minutes already waiting at A plus twenty between the later services.
    assert result.validation.metrics.waiting_minutes_by_engineer['E1'] == 30
    parts=scenario(mode=TransportMode.PUBLIC_TRANSIT); result=solve(parts)
    route=next(r for r in result.state.plan.engineer_plans if r.engineer_id=='E1')
    assert route.visits[0].departure_at==parts[0].at(9,10)
    assert route.movements[0]['fraction']==1


def test_validator_rejects_forged_checkpoint_and_emergency_after_another_future_visit():
    parts=scenario(); result=solve(parts); data=parts[2]; route=next(r for r in result.state.plan.engineer_plans if r.engineer_id=='E1')
    forged={**route.movements[0],'distance_m':0}
    assert not verify_checkpoint(forged,data.locations)
    mutated=replace(route,movements=(forged,))
    plan=replace(result.state.plan,engineer_plans=tuple(mutated if r.engineer_id=='E1' else r for r in result.state.plan.engineer_plans))
    report=validate_replanned_plan(data,plan,parts[3],event_time=parts[4].event_time,applied_event_ids=frozenset({parts[4].event_id}),canceled_job_ids=frozenset(),unavailable_until_by_engineer={})
    assert not report.is_valid
    mutated=replace(route,visits=(route.visits[1],route.visits[0],*route.visits[2:]))
    plan=replace(result.state.plan,engineer_plans=(mutated,))
    report=validate_replanned_plan(data,plan,parts[3],event_time=parts[4].event_time,applied_event_ids=frozenset({parts[4].event_id}),canceled_job_ids=frozenset(),unavailable_until_by_engineer={})
    assert not report.is_valid


def test_second_emergency_uses_published_route_and_keeps_first_started_service():
    parts = scenario()
    first = solve(parts)
    f, _, data, _, _, oracle, _ = parts
    f.jobs['V'] = f.job('V', 'Z1', f.at(9, 20), priority=Priority.URGENT, location='L3')
    event = f.event(2, EventType.NEW_URGENT_JOB, 'V', f.at(9, 20))
    second_data = replace(f.make_dataset((*data.events, event)), locations=data.locations)
    second = replan_after_event(second_data, first.state, event, oracle, source_dataset=data,
        forced_engineer_by_job={'V': 'E1'}, dispatch_engineer_id='E1', departure_timing_queries=0)
    before = next(route for route in first.state.plan.engineer_plans if route.engineer_id == 'E1')
    after = next(route for route in second.state.plan.engineer_plans if route.engineer_id == 'E1')
    assert after.visits[0] == before.visits[0]
    assert after.visits[1].job_id == 'V'
    assert after.visits[1].departure_at >= before.visits[0].service_start_at + timedelta(minutes=data.jobs['U'].service_duration_min)
    assert after.movements == before.movements
    assert second.validation.is_valid
