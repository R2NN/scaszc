"""Exact manual assignment inside an isolated rating scenario."""
from __future__ import annotations
import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path

from beeline_planning import load_planning_dataset, validate_initial_plan, ReplanningState, replan_after_event
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import MaterializationResult, MaterializationStatus
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.oracle import ExactRoutingOracle
from beeline_routing.export import payload_sha256, write_json_atomic
from replan_ui_event import _event_dataset


def main():
    parser = argparse.ArgumentParser()
    for name in ['dataset', 'input-plan', 'output', 'cache', 'transit-index']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    source = json.loads(args.input_plan.read_text(encoding='utf-8'))
    dataset = load_planning_dataset(args.dataset, 'core')
    # Source profiles are retained by the server after the original trusted match.
    engineers = dict(dataset.engineers)
    for item in source['candidate_profiles']:
        engineers[item['id']] = replace(dataset.engineers[item['templateId']], engineer_id=item['id'])
    dataset = replace(dataset, engineers=engineers)
    history = source.get('ui_history', [])
    events = []
    for entry in history:
        dataset, event = _event_dataset(dataset, entry)
        events.append(replace(event, apply_order=len(events) + 1))
        dataset = replace(dataset, events=tuple(events))
    plan, verified = load_exact_plan_artifact(args.input_plan, dataset.dataset_sha256)
    # Event-aware validation is performed by the existing exact replanner below.
    if not history and not validate_initial_plan(dataset, plan).is_valid:
        raise ValueError('Исходный сценарий не прошёл проверку')
    event_payload = {'event': {'type': 'FORCED_ASSIGNMENT', 'orderId': payload['orderId'],
                              'engineerId': payload['engineerId'], 'time': (events[-1].event_time if events else plan.planning_at).isoformat()}}
    changed, event = _event_dataset(dataset, event_payload)
    event = replace(event, apply_order=len(events) + 1)
    changed = replace(changed, events=tuple(events) + (event,))
    oracle = ExactRoutingOracle(create_route_client(RoutingCache(args.cache), 'valhalla-local-transit',
        timeout_seconds=30, max_attempts=2, transit_index=args.transit_index, metro_wait_seconds=180))
    state = ReplanningState(plan=plan, applied_event_ids=tuple(item.event_id for item in events),
                           last_event_time=events[-1].event_time if events else None)
    result = replan_after_event(changed, state, event, oracle, max_route_checks=400,
        forced_engineer_by_job={event.target_id: payload['engineerId']}, source_dataset=dataset)
    if result.state is None or not result.validation or not result.validation.is_valid:
        raise ValueError(result.detail or 'Закрепление не прошло точную проверку')
    if not any(route.engineer_id == payload['engineerId'] and any(v.job_id == payload['orderId'] for v in route.visits)
               for route in result.state.plan.engineer_plans):
        raise ValueError('Закрепление невозможно при текущих окнах, навыках, оснащении и маршрутах')
    artifact = materialization_result_dict(MaterializationResult(status=MaterializationStatus.EXACT_VALID,
        plan=result.state.plan, validation=result.validation, failure=None, exact_provider_queries=0, identity_legs=0))
    artifact.update({'artifact_type': 'RATING_MANUAL_ASSIGNMENT', 'dataset_sha256': changed.dataset_sha256,
        'source_plan_content_sha256': verified['content_sha256'], 'candidate_profiles': source['candidate_profiles'],
        'ui_history': history + [event_payload], 'rating_version': payload['ratingVersion'],
        'search_scope': 'EXACT_MANUAL_ASSIGNMENT', 'exact_route_checks': result.exact_route_checks,
        'exact_provider_queries': None, 'identity_legs': None, 'global_optimality_proven': False})
    artifact['content_sha256'] = payload_sha256(artifact)
    write_json_atomic(args.output, artifact)
    print(json.dumps({'status': 'EXACT_VALID'}))


if __name__ == '__main__':
    main()
