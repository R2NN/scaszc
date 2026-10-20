from dataclasses import replace
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from algorithm.tests import test_replanning as fixtures
from beeline_planning import EngineerPlan, ProposedPlan, ReplanningState, replan_after_event, validate_initial_plan, validate_replanned_plan
from beeline_planning.domain import EventType, Priority


def chain_scenario(reserve_available=True):
    """C needs E2, whose A needs E3, whose B needs the free reserve E4."""
    f = fixtures.ReplanningTests()
    f.setUp()
    base = f.engineers['E1']
    f.engineers = {key: replace(base, engineer_id=key, skills=frozenset(skills), max_jobs=1,
                               is_available=reserve_available if key == 'E4' else True)
                   for key, skills in [('E1', ['LOCAL', 'EMERGENCY']), ('E2', ['LOCAL', 'INSTALL']),
                                       ('E3', ['INSTALL', 'UPSELL']), ('E4', ['UPSELL'])]}
    f.jobs = {key: replace(f.job(key, 'Z1', f.t0), required_skill=skill)
              for key, skill in [('A', 'INSTALL'), ('B', 'UPSELL'), ('C', 'LOCAL')]}
    source = replace(f.make_dataset(()), jobs=dict(f.jobs))
    old = ProposedPlan(f.t0, tuple(EngineerPlan(key, (f.visit(job, f.at(10)),))
                                  for key, job in [('E1', 'C'), ('E2', 'A'), ('E3', 'B')]), ())
    assert validate_initial_plan(source, old).is_valid
    event = f.event(1, EventType.NEW_URGENT_JOB, 'U', f.at(8, 5))
    f.jobs['U'] = replace(f.job('U', 'Z1', event.event_time, priority=Priority.URGENT), required_skill='EMERGENCY')
    data = f.make_dataset((event,))
    options = dict(source_dataset=source, forced_engineer_by_job={'U': 'E1'},
                   dispatch_engineer_id='E1', departure_timing_queries=0)
    first = replan_after_event(data, ReplanningState(old), event, fixtures._Oracle(), **options)
    assert first.validation.is_valid
    assert first.state.plan.unserved_job_ids == ('C',)
    return f, data, old, event, options, first


def test_dispatch_repairs_three_engineer_chain_and_preserves_emergency_eta():
    _, data, old, event, options, first = chain_scenario()
    result = replan_after_event(data, ReplanningState(old), event, fixtures._Oracle(),
        incumbent_plan=first.state.plan, rebuild_future=True, coverage_repair_seconds=2,
        max_route_checks=500, **options)
    assert result.validation.is_valid
    assert not result.state.plan.unserved_job_ids
    owners = {v.job_id: route.engineer_id for route in result.state.plan.engineer_plans for v in route.visits}
    assert owners == {'U': 'E1', 'C': 'E2', 'A': 'E3', 'B': 'E4'}
    emergency = lambda plan: next(v for route in plan.engineer_plans for v in route.visits if v.job_id == 'U')
    assert emergency(result.state.plan) == emergency(first.state.plan)
    assert result.coverage_repair['improved_jobs'] == 1
    assert result.exact_route_checks <= 500


@pytest.mark.parametrize('reserve_available,checks', [(False, 500), (True, 1)])
def test_failed_or_budget_limited_repair_retains_every_incumbent_assignment(reserve_available, checks):
    _, data, old, event, options, first = chain_scenario(reserve_available)
    result = replan_after_event(data, ReplanningState(old), event, fixtures._Oracle(),
        incumbent_plan=first.state.plan, rebuild_future=True, coverage_repair_seconds=.1,
        max_route_checks=checks, **options)
    assert result.validation.is_valid
    assert result.state.plan.unserved_job_ids == first.state.plan.unserved_job_ids
    assert result.state.plan.engineer_plans == first.state.plan.engineer_plans


def test_protected_destination_prevents_the_chain_without_unlocking_a_visit():
    _, data, old, event, options, first = chain_scenario()
    result = replan_after_event(data, ReplanningState(old), event, fixtures._Oracle(),
        incumbent_plan=first.state.plan, rebuild_future=True, coverage_repair_seconds=.1,
        protected_job_ids=frozenset({'A'}), max_route_checks=500, **options)
    assert result.validation.is_valid
    assert result.state.plan.unserved_job_ids == ('C',)
    assert next(r for r in result.state.plan.engineer_plans if r.engineer_id == 'E2').visits == old.engineer_plans[1].visits


def test_expired_repair_deadline_retains_cached_incumbent_without_starting_more_road_checks(monkeypatch):
    import beeline_planning.replanning as replanning
    _, data, old, event, options, first = chain_scenario()
    moments = iter([0, 100])
    monkeypatch.setattr(replanning, 'monotonic', lambda: next(moments, 100))
    result = replan_after_event(data, ReplanningState(old), event, fixtures._Oracle(),
        incumbent_plan=first.state.plan, rebuild_future=True, coverage_repair_seconds=.1, **options)
    assert result.validation.is_valid
    assert result.state.plan.engineer_plans == first.state.plan.engineer_plans
    assert result.exact_route_checks == 0


def test_dispatch_short_first_pass_keeps_the_broader_exact_fallback(tmp_path, monkeypatch):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
    import replan_ui_event as adapter
    _, data, old, event, options, _ = chain_scenario()
    budgets = []
    real_replan = adapter.replan_after_event
    def bounded_replan(*args, **kwargs):
        budgets.append(kwargs['max_route_checks'])
        result = real_replan(*args, **kwargs)
        # Model a handoff too difficult for the short pass. No candidate may
        # be published until the broader search returns an actual valid plan.
        return replace(result, state=None, exact_route_checks=24) if len(budgets) == 1 else result
    monkeypatch.setattr(adapter, 'replan_after_event', bounded_replan)
    args = SimpleNamespace(output=tmp_path / 'offers.json', transit_index=Path('model-index.sqlite'),
                           rebuild_route_checks=5000, max_route_checks=400)
    adapter.dispatch_variants(args, {'event': {}, 'orders': [], 'team': [], 'dispatchCoverageRepair': False},
        options['source_dataset'], data, ReplanningState(old), event,
        {'content_sha256': '0' * 64}, [], fixtures._Oracle())
    assert budgets == [24, 400]
    final = json.loads(args.output.read_text())
    assert final['dispatch_candidates'][0]['validation']['status'] == 'VALID'
    assert final['dispatch_search']['complete']


@pytest.mark.parametrize('needs_rebuild', [False, True])
def test_nearest_travelling_engineer_gets_full_handoff_before_other_offers(tmp_path, monkeypatch, needs_rebuild):
    from algorithm.tests.test_dispatch import scenario
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
    import replan_ui_event as adapter
    _, source, data, old, event, oracle, anchor = scenario()
    calls, snapshots = [], []
    real_replan, write = adapter.replan_after_event, adapter.write_json_atomic

    def calculate(*args, **kwargs):
        calls.append((kwargs['dispatch_engineer_id'], kwargs['handoff_interrupted_job'],
                      kwargs['rebuild_future'], kwargs['max_route_checks']))
        result = real_replan(*args, **kwargs)
        if needs_rebuild and len(calls) == 1:
            return replace(result, state=None, exact_route_checks=400, budget_exhausted=True)
        return result

    def capture(file, payload):
        if 'dispatch_candidates' in payload:
            snapshots.append(json.loads(json.dumps(payload)))
        write(file, payload)

    monkeypatch.setattr(adapter, 'replan_after_event', calculate)
    monkeypatch.setattr(adapter, 'write_json_atomic', capture)
    args = SimpleNamespace(output=tmp_path / 'offers.json', transit_index=Path('model-index.sqlite'),
                           rebuild_route_checks=5000, max_route_checks=400)
    adapter.dispatch_variants(args, {'event': {'dispatchAnchors': {'E1': anchor}},
        'orders': [], 'team': [], 'dispatchCoverageRepair': False}, source, data, ReplanningState(old),
        event, {'content_sha256': '0' * 64}, [], oracle)
    assert calls[0] == ('E1', True, False, 400)
    if needs_rebuild:
        assert calls[1] == ('E1', True, True, 1000)
    first = snapshots[0]['dispatch_candidates'][0]
    assert first['dispatch_engineer_id'] == 'E1'
    assert first['dispatch_handoff'] is True
    assert first['validation']['status'] == 'VALID'
    routes = {route['engineer_id']: route for route in first['plan']['engineer_plans']}
    assert routes['E1']['visits'][0]['job_id'] == 'U'
    assert any(visit['job_id'] == 'A' for key, route in routes.items() if key != 'E1' for visit in route['visits'])
    assert not first['plan']['unserved_job_ids']


@pytest.mark.parametrize('worsen', [None, 'response', 'another_assignment', 'confirmation'])
def test_dispatch_publishes_first_offer_before_repair_then_replaces_only_with_strict_improvement(tmp_path, monkeypatch, worsen):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
    import replan_ui_event as adapter
    _, data, old, event, options, _ = chain_scenario()
    snapshots = []
    write = adapter.write_json_atomic
    def capture(file, payload):
        if 'dispatch_candidates' in payload:
            snapshots.append(json.loads(json.dumps(payload)))
        write(file, payload)
    monkeypatch.setattr(adapter, 'write_json_atomic', capture)
    real_replan = adapter.replan_after_event
    def checked_replan(*args, **kwargs):
        result = real_replan(*args, **kwargs)
        if worsen and kwargs.get('incumbent_plan') is not None and not result.state.plan.unserved_job_ids:
            plan = result.state.plan
            if worsen == 'response':
                from datetime import timedelta
                plan = replace(plan, engineer_plans=tuple(replace(route, visits=tuple(
                    replace(visit, service_start_at=visit.service_start_at + timedelta(minutes=1))
                    if visit.job_id == 'U' else visit for visit in route.visits)) for route in plan.engineer_plans))
            else:
                plan = replace(plan, engineer_plans=tuple(replace(route, visits=tuple(
                    visit for visit in route.visits if visit.job_id != 'A')) for route in plan.engineer_plans), unserved_job_ids=('A',))
            return replace(result, state=replace(result.state, plan=plan))
        return result
    monkeypatch.setattr(adapter, 'replan_after_event', checked_replan)
    args = SimpleNamespace(output=tmp_path / 'offers.json', transit_index=Path('model-index.sqlite'),
                           rebuild_route_checks=5000, max_route_checks=400)
    adapter.dispatch_variants(args, {'event': {}, 'orders': [], 'team': [], 'dispatchCoverageRepair': worsen != 'confirmation'}, options['source_dataset'],
        data, ReplanningState(old), event, {'content_sha256': '0' * 64}, [], fixtures._Oracle())
    first = snapshots[0]['dispatch_candidates'][0]
    final = json.loads(args.output.read_text())
    improved = final['dispatch_candidates'][0]
    assert first['plan']['unserved_job_ids'] == ['C']
    if worsen:
        assert improved['content_sha256'] == first['content_sha256']
        if worsen == 'confirmation':
            assert not final['dispatch_search']['coverage_repair']
        else:
            assert not final['dispatch_search']['coverage_repair'][0]['accepted']
        return
    assert improved['plan']['unserved_job_ids'] == []
    assert improved['improves_content_sha256'] == first['content_sha256']
    assert improved['dispatch_engineer_id'] == first['dispatch_engineer_id'] == 'E1'
    loaded, _ = adapter.load_exact_plan_artifact(tmp_path / f'{improved["content_sha256"]}.json', data.dataset_sha256)
    assert validate_replanned_plan(data, loaded, old, event_time=event.event_time,
        applied_event_ids=frozenset({event.event_id}), canceled_job_ids=frozenset(), unavailable_until_by_engineer={}).is_valid
    assert final['dispatch_search']['coverage_repair'][0]['accepted']
    assert final['dispatch_search']['complete']
    assert final['dispatch_search']['route_checks'] <= 5000


def test_selected_interception_can_rebuild_without_handoff_when_its_receiver_is_unavailable(tmp_path, monkeypatch):
    from algorithm.tests.test_dispatch import scenario
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
    import replan_ui_event as adapter
    _, source, data, old, event, oracle, anchor = scenario()
    data = replace(data, engineers={key: replace(engineer, is_available=False) if key == 'E2' else engineer
                                   for key, engineer in data.engineers.items()})
    calculate = adapter.replan_after_event
    calls = []
    def bounded_search(*values, **options):
        calls.append((options['dispatch_engineer_id'], options['handoff_interrupted_job'], options['rebuild_future']))
        result = calculate(*values, **options)
        if not options['rebuild_future']:
            return replace(result, state=None, budget_exhausted=True)
        return result
    monkeypatch.setattr(adapter, 'replan_after_event', bounded_search)
    args = SimpleNamespace(output=tmp_path / 'offers.json', transit_index=Path('model-index.sqlite'),
                           rebuild_route_checks=5000, max_route_checks=400)
    adapter.dispatch_variants(args, {'event': {'orderId': 'U', 'dispatchAnchors': {'E1': anchor}},
        'orders': [], 'team': [], 'dispatchEngineerId': 'E1', 'dispatchCoverageRepair': False},
        source, data, ReplanningState(old), event, {'content_sha256': '0' * 64}, [], oracle)
    final = json.loads(args.output.read_text())['dispatch_candidates'][0]
    assert calls[-1] == ('E1', False, True)
    assert final['dispatch_engineer_id'] == 'E1'
    assert final['validation']['status'] == 'VALID'
    plan, _ = adapter.load_exact_plan_artifact(tmp_path / f'{final["content_sha256"]}.json', data.dataset_sha256)
    route = next(route for route in plan.engineer_plans if route.engineer_id == 'E1')
    assert route.visits[0].job_id == 'U'
    assert any(visit.job_id == 'A' for visit in route.visits)
    assert route.visits[0].departure_at == event.event_time
    assert not plan.unserved_job_ids
