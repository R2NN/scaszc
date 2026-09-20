from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from beeline_planning import (
    ReplanningState, ReplanningStatus, build_explanation_bundle,
    load_planning_dataset, replan_after_event,
)
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import MaterializationResult, MaterializationStatus
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def _state_from_artifact(plan, payload: dict) -> ReplanningState:
    raw = payload.get('replanning_state')
    if raw is None:
        return ReplanningState(plan=plan)
    return ReplanningState(
        plan=plan,
        applied_event_ids=tuple(raw['applied_event_ids']),
        canceled_job_ids=frozenset(raw['canceled_job_ids']),
        unavailable_until_by_engineer={
            engineer_id: datetime.fromisoformat(value)
            for engineer_id, value in raw['unavailable_until_by_engineer'].items()
        },
        last_event_time=datetime.fromisoformat(raw['last_event_time']),
    )


def _changes(before, after) -> dict[str, list[dict[str, str]]]:
    def records(plan):
        return {
            visit.job_id: (
                route.engineer_id, sequence, visit.service_start_at.isoformat()
            )
            for route in plan.engineer_plans
            for sequence, visit in enumerate(route.visits, 1)
        }

    old, new = records(before), records(after)
    return {
        'newly_assigned': [
            {'job_id': job_id, 'engineer_id': new[job_id][0]}
            for job_id in sorted(new.keys() - old.keys())
        ],
        'removed_from_route': [
            {'job_id': job_id, 'former_engineer_id': old[job_id][0]}
            for job_id in sorted(old.keys() - new.keys())
        ],
        'changed_assignment': [
            {'job_id': job_id, 'from': old[job_id][0], 'to': new[job_id][0]}
            for job_id in sorted(old.keys() & new.keys())
            if old[job_id][0] != new[job_id][0]
        ],
        'changed_visit_time': [
            {'job_id': job_id, 'from': old[job_id][2], 'to': new[job_id][2]}
            for job_id in sorted(old.keys() & new.keys())
            if old[job_id][2] != new[job_id][2]
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Apply one daytime event and publish only an independently exact-valid new plan.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--event-id', required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-route-checks', type=int, default=400)
    parser.add_argument(
        '--urgent-slack-minutes', type=int, default=15,
        help='Within this delay from the earliest urgent start, prefer less disruption.',
    )
    parser.add_argument(
        '--urgent-ejection-gain-minutes', type=int, default=45,
        help='Minimum urgent speed gain that warrants moving one future normal job.',
    )
    parser.add_argument('--timeout-seconds', type=float, default=30)
    parser.add_argument('--max-attempts', type=int, default=2)
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Replanning requires explicit --execute')
    if args.output.resolve() == args.input_plan.resolve() or args.output.exists():
        parser.error('Output must be a new path; source plans are never overwritten')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    plan, source = load_exact_plan_artifact(args.input_plan, dataset.dataset_sha256)
    state = _state_from_artifact(plan, source)
    event = next((item for item in dataset.events if item.event_id == args.event_id), None)
    if event is None:
        parser.error(f'Event not found: {args.event_id}')
    oracle = ExactRoutingOracle(create_route_client(
        RoutingCache(args.cache),
        'valhalla-local-transit',
        timeout_seconds=args.timeout_seconds,
        max_attempts=args.max_attempts,
        transit_index=args.transit_index,
        metro_wait_seconds=args.metro_wait_seconds,
    ))
    result = replan_after_event(
        dataset, state, event, oracle,
        max_route_checks=args.max_route_checks,
        urgent_slack_minutes=args.urgent_slack_minutes,
        urgent_ejection_gain_minutes=args.urgent_ejection_gain_minutes,
        progress_callback=lambda checks: print(
            f'Checked {checks} full route orders', flush=True
        ),
    )
    urgency_policy = {
        'near_earliest_slack_minutes': args.urgent_slack_minutes,
        'minimum_gain_for_ejection_minutes': args.urgent_ejection_gain_minutes,
        'minimum_gain_if_normal_remains_unserved_minutes':
            2 * args.urgent_ejection_gain_minutes,
        'max_future_normal_jobs_displaced_per_urgent_job': 1,
    }
    if result.state is None:
        payload = {
            'artifact_type': 'EXACT_PLAN_REPLANNING',
            'status': result.status.value,
            'publication_allowed': False,
            'event_id': event.event_id,
            'detail': result.detail,
            'source_plan': str(args.input_plan),
            'source_plan_content_sha256': source['content_sha256'],
            'dataset_sha256': dataset.dataset_sha256,
            'exact_route_checks': result.exact_route_checks,
            'budget_exhausted': result.budget_exhausted,
            'unserved_reasons': dict(result.unserved_reasons),
            'failure_explanation': {
                'claim_level': 'ROUTING_UNVERIFIED'
                if result.status == ReplanningStatus.ROUTING_INCOMPLETE
                else 'EXACT_FACT',
                'summary_ru': result.detail,
                'global_impossibility_proven': False,
            },
        }
    else:
        payload = materialization_result_dict(MaterializationResult(
            status=MaterializationStatus.EXACT_VALID,
            plan=result.state.plan,
            validation=result.validation,
            failure=None,
            exact_provider_queries=0,
            identity_legs=0,
        ))
        # This engine counts full-route feasibility checks, not raw provider
        # calls; zero here would incorrectly claim no routing was requested.
        payload['exact_provider_queries'] = None
        payload['identity_legs'] = None
        changes = _changes(plan, result.state.plan)
        explanations = build_explanation_bundle(
            dataset,
            result.state.plan,
            result.validation,
            explanation_at=event.event_time,
            applied_event_ids=frozenset(result.state.applied_event_ids),
            canceled_job_ids=result.state.canceled_job_ids,
            previous_plan=plan,
            event=event,
            unserved_reasons=result.unserved_reasons,
            candidate_evaluations=result.candidate_evaluations,
            search_budget_exhausted=result.budget_exhausted,
            exact_route_checks=result.exact_route_checks,
            global_optimality_proven=False,
            urgency_policy=urgency_policy,
        )
        payload.update({
            'artifact_type': 'EXACT_PLAN_REPLANNING',
            'event_status': result.status.value,
            'event_id': event.event_id,
            'event_time': event.event_time.isoformat(),
            'source_plan': str(args.input_plan),
            'source_plan_content_sha256': source['content_sha256'],
            'dataset_sha256': dataset.dataset_sha256,
            'exact_route_checks': result.exact_route_checks,
            'budget_exhausted': result.budget_exhausted,
            'unserved_reasons': dict(result.unserved_reasons),
            'changes': changes,
            'explanations': explanations,
            'replanning_state': {
                'applied_event_ids': list(result.state.applied_event_ids),
                'canceled_job_ids': sorted(result.state.canceled_job_ids),
                'unavailable_until_by_engineer': {
                    engineer_id: until.isoformat()
                    for engineer_id, until in result.state.unavailable_until_by_engineer.items()
                },
                'last_event_time': result.state.last_event_time.isoformat(),
            },
            'routing_configuration': {
                'provider': 'valhalla-local-transit',
                'transit_index': str(args.transit_index),
                'metro_wait_assumption_seconds': args.metro_wait_seconds,
                'exact_historical_metro_timetable_proof': False,
            },
            'global_optimality_proven': False,
            'urgency_policy': urgency_policy,
        })
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({
        'status': result.status.value,
        'publication_allowed': payload['publication_allowed'],
        'event_id': event.event_id,
        'served_jobs': sum(len(route.visits) for route in result.state.plan.engineer_plans)
        if result.state is not None else None,
        'unserved_jobs': len(result.state.plan.unserved_job_ids)
        if result.state is not None else None,
        'exact_route_checks': result.exact_route_checks,
        'budget_exhausted': result.budget_exhausted,
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0 if payload['publication_allowed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
