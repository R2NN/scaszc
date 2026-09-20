from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from beeline_planning import (
    CounterfactualStatus,
    ReplanningState,
    counterfactual_result_dict,
    evaluate_event_assignment_counterfactual,
    evaluate_initial_assignment_counterfactual,
    load_planning_dataset,
)
from beeline_planning.export import (
    load_exact_plan_artifact,
    materialization_result_dict,
)
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


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            'Explain what would happen if one job were forced to one engineer. '
            'The result is hypothetical and is never publication-authorized.'
        )
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--engineer-id', required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-route-checks', type=int, default=400)
    parser.add_argument('--max-displacements', type=int, choices=(0, 1, 2), default=2)
    parser.add_argument('--timeout-seconds', type=float, default=30)
    parser.add_argument('--max-attempts', type=int, default=2)
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Counterfactual routing requires explicit --execute')
    if args.output.resolve() == args.input_plan.resolve() or args.output.exists():
        parser.error('Output must be a new path; source plans are never overwritten')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    actual_plan, actual_payload = load_exact_plan_artifact(
        args.input_plan, dataset.dataset_sha256
    )
    oracle = ExactRoutingOracle(create_route_client(
        RoutingCache(args.cache),
        'valhalla-local-transit',
        timeout_seconds=args.timeout_seconds,
        max_attempts=args.max_attempts,
        transit_index=args.transit_index,
        metro_wait_seconds=args.metro_wait_seconds,
    ))

    if actual_payload.get('replanning_state') is None:
        result = evaluate_initial_assignment_counterfactual(
            dataset,
            actual_plan,
            args.job_id,
            args.engineer_id,
            oracle,
            max_route_checks=args.max_route_checks,
            max_displacements=args.max_displacements,
        )
        replayed_event_id = None
    else:
        event_id = actual_payload.get('event_id')
        event = next(
            (item for item in dataset.events if item.event_id == event_id), None
        )
        if event is None:
            parser.error('Event artifact does not reference a known dataset event')
        raw_source_path = actual_payload.get('source_plan')
        if not isinstance(raw_source_path, str):
            parser.error('Event artifact has no source plan path for replay')
        source_path = Path(raw_source_path)
        if not source_path.is_absolute():
            source_path = Path.cwd() / source_path
        source_plan, source_payload = load_exact_plan_artifact(
            source_path, dataset.dataset_sha256
        )
        if (
            source_payload['content_sha256']
            != actual_payload.get('source_plan_content_sha256')
        ):
            parser.error('Event source plan checksum differs from the recorded source')
        policy = actual_payload.get('urgency_policy', {})
        result = evaluate_event_assignment_counterfactual(
            dataset,
            _state_from_artifact(source_plan, source_payload),
            event,
            actual_plan,
            args.job_id,
            args.engineer_id,
            oracle,
            max_route_checks=args.max_route_checks,
            urgent_slack_minutes=int(policy.get('near_earliest_slack_minutes', 15)),
            urgent_ejection_gain_minutes=int(
                policy.get('minimum_gain_for_ejection_minutes', 45)
            ),
        )
        replayed_event_id = event.event_id

    payload = counterfactual_result_dict(result)
    payload.update({
        'artifact_type': 'EXACT_ASSIGNMENT_COUNTERFACTUAL',
        'dataset_sha256': dataset.dataset_sha256,
        'source_plan': str(args.input_plan),
        'source_plan_content_sha256': actual_payload['content_sha256'],
        'replayed_event_id': replayed_event_id,
        'search_scope': {
            'max_route_checks': args.max_route_checks,
            'max_displacements': (
                args.max_displacements if replayed_event_id is None else 1
            ),
            'global_search': False,
        },
        'routing_configuration': {
            'provider': 'valhalla-local-transit',
            'transit_index': str(args.transit_index),
            'metro_wait_assumption_seconds': args.metro_wait_seconds,
            'exact_historical_metro_timetable_proof': False,
        },
    })
    if result.plan is not None and result.validation is not None:
        evidence = materialization_result_dict(MaterializationResult(
            status=MaterializationStatus.EXACT_VALID,
            plan=result.plan,
            validation=result.validation,
            failure=None,
            exact_provider_queries=0,
            identity_legs=0,
        ))
        evidence['publication_allowed'] = False
        evidence['counterfactual_only'] = True
        payload['hypothetical_plan_evidence'] = evidence
    else:
        payload['hypothetical_plan_evidence'] = None
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({
        'status': result.status.value,
        'job_id': result.job_id,
        'forced_engineer_id': result.forced_engineer_id,
        'actual_engineer_id': result.actual_engineer_id,
        'counterfactual_engineer_id': (
            result.forced_engineer_id
            if result.status in {
                CounterfactualStatus.FEASIBLE,
                CounterfactualStatus.ALREADY_ACTUAL,
            }
            else None
        ),
        'route_checks': result.route_checks,
        'budget_exhausted': result.budget_exhausted,
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
