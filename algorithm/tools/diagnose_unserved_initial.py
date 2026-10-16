"""Audit remaining initial-plan jobs against all staff and concrete insertion orders."""

from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from beeline_planning import (
    build_candidate_index, build_explanation_bundle, load_planning_dataset, materialize_exact_initial_plan,
    validate_initial_plan,
)
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle
from improve_exact_plan import _insertion_job_order, _insertion_master, _zero_travel_window_conflict


def summarize_job(entry: dict) -> str:
    """Describe observed time conflicts without claiming unsearched orders impossible."""
    if not entry['eligible_engineer_ids']:
        time_only = [item for item in entry['engineers']
                     if item['rejections'] == ['SHIFT_WINDOW_NO_OVERLAP']
                     and item['minimum_shift_overrun_minutes'] > 0]
        if time_only:
            best = min(time_only, key=lambda item: item['minimum_shift_overrun_minutes'])
            return (f"Работа {entry['service_duration_min']} мин: даже без дороги окончание "
                    f"в {best['earliest_finish_without_travel'][11:16]}, смена до "
                    f"{best['shift_end'][11:16]} — превышение "
                    f"{best['minimum_shift_overrun_minutes']} мин.")
        return 'Нет инженера, одновременно подходящего по зоне, допускам, оснащению и смене.'
    prefix = (f"Проверены {len(entry['eligible_engineer_ids'])} инженеров и "
              f"{len(entry['positions'])} вставок.")
    exact = [item for item in entry['positions']
             if item.get('proof_level') == 'EXACT_CURRENT_ORDER'
             and item.get('constraint') == 'client_window'
             and item.get('violation_minutes', 0) > 0]
    if exact:
        best = min(exact, key=lambda item: item['violation_minutes'])
        return (f"{prefix} Один из вариантов: начало в "
                f"{best['service_start_at'][11:16]}, окно до {best['limit_at'][11:16]} "
                f"— опоздание {best['violation_minutes']} мин.")
    return f'{prefix} Допустимая вставка в текущий порядок не подтверждена.'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--explained-plan-output', type=Path)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), default='core')
    parser.add_argument('--max-wall-seconds', type=float, default=300)
    args = parser.parse_args()
    if args.max_wall_seconds <= 0:
        parser.error('The audit time limit must be positive')
    if args.explained_plan_output and args.explained_plan_output.resolve() == args.input_plan.resolve():
        parser.error('The explained plan must use a new path')
    dataset = load_planning_dataset(args.dataset, args.scenario)
    plan, source = load_exact_plan_artifact(args.input_plan, dataset.dataset_sha256)
    validation = validate_initial_plan(dataset, plan)
    if not validation.is_valid:
        raise ValueError(f'Input failed independent validation: {validation.violations}')
    candidates = build_candidate_index(dataset)
    routes = {item.engineer_id: [visit.job_id for visit in item.visits]
              for item in plan.engineer_plans}
    for engineer_id in dataset.engineers:
        routes.setdefault(engineer_id, [])
    client = create_route_client(RoutingCache(args.cache), 'valhalla-local-transit',
                                 transit_index=args.transit_index)
    oracle = ExactRoutingOracle(client)
    started = time.monotonic()
    report = {
        'artifact_type': 'UNSERVED_INITIAL_PLAN_AUDIT',
        'dataset_sha256': dataset.dataset_sha256,
        'source_plan_content_sha256': source['content_sha256'],
        'started_at': datetime.now(UTC).isoformat(),
        'max_wall_seconds': args.max_wall_seconds,
        'scope': 'All static staff candidates; every insertion position in current routes. '
                 'Does not prove global infeasibility when reassignment or reordering is needed.',
        'jobs': {},
    }

    def save() -> None:
        report['elapsed_seconds'] = round(time.monotonic() - started, 3)
        write_json_atomic(args.output, report)

    try:
        for job_id in _insertion_job_order(dataset, plan.unserved_job_ids):
            job = dataset.jobs[job_id]
            entry = {
                'priority': job.priority.value, 'zone_id': job.zone_id,
                'service_duration_min': job.service_duration_min,
                'window_start': job.window_start.isoformat(),
                'window_end': job.window_end.isoformat(),
                'required_skill': job.required_skill,
                'required_transport': job.required_transport.value,
                'required_equipment': [
                    {'equipment_id': need.equipment_id, 'quantity': need.quantity}
                    for need in job.required_equipment
                ],
                'eligible_engineer_ids': list(candidates.eligible_engineers_by_job[job_id]),
                'engineers': [], 'positions': [],
                'budget_exhausted': False, 'feasible_insertions': 0,
            }
            report['jobs'][job_id] = entry
            for engineer_id, engineer in sorted(dataset.engineers.items()):
                earliest = max(dataset.initial_planning_at, job.created_at,
                               job.window_start, engineer.shift_start)
                finish = earliest + timedelta(minutes=job.service_duration_min)
                missing = [need.equipment_id for need in job.required_equipment
                           if dataset.equipment_catalog[need.equipment_id].reusable
                           and engineer.equipment_quantity(need.equipment_id) < need.quantity]
                entry['engineers'].append({
                    'engineer_id': engineer_id, 'zone_id': engineer.zone_id,
                    'rejections': [code.value for code in candidates.reasons(engineer_id, job_id)],
                    'skills': sorted(engineer.skills), 'transport': engineer.transport_mode.value,
                    'missing_personal_equipment': missing,
                    'shift_start': engineer.shift_start.isoformat(),
                    'shift_end': engineer.shift_end.isoformat(),
                    'earliest_service_start_without_travel': earliest.isoformat(),
                    'earliest_finish_without_travel': finish.isoformat(),
                    'minimum_shift_overrun_minutes': max(0, int((finish - engineer.shift_end).total_seconds() // 60)),
                    'current_route': routes[engineer_id],
                })
            if not entry['eligible_engineer_ids']:
                entry['proof_level'] = 'STATIC_NO_ELIGIBLE_ENGINEER'
                entry['global_assignment_impossible_under_current_constraints'] = True
                save()
                continue
            entry['proof_level'] = 'CURRENT_INSERTION_ORDERS_ONLY'
            entry['global_assignment_impossible_under_current_constraints'] = False
            for engineer_id in entry['eligible_engineer_ids']:
                order = routes[engineer_id]
                if len(order) >= dataset.engineers[engineer_id].max_jobs:
                    entry['positions'].append({'engineer_id': engineer_id,
                                               'constraint': 'max_jobs',
                                               'actual': len(order) + 1,
                                               'limit': dataset.engineers[engineer_id].max_jobs})
                    continue
                for position in range(len(order) + 1):
                    if time.monotonic() - started >= args.max_wall_seconds:
                        entry['budget_exhausted'] = True
                        break
                    trial = order[:position] + [job_id] + order[position:]
                    detail = {'engineer_id': engineer_id, 'position': position + 1,
                              'trial_order': trial}
                    conflict = _zero_travel_window_conflict(dataset, engineer_id, trial)
                    if conflict:
                        detail.update(conflict)
                    else:
                        result = materialize_exact_initial_plan(
                            dataset, _insertion_master(dataset, routes, engineer_id, trial,
                                                       candidates.active_job_ids), oracle,
                        )
                        payload = materialization_result_dict(result)
                        detail['status'] = result.status.value
                        detail['proof_level'] = ('EXACT_CURRENT_ORDER' if result.status.value != 'ROUTING_INCOMPLETE'
                                                 else 'ROUTING_UNVERIFIED')
                        if payload['publication_allowed']:
                            entry['feasible_insertions'] += 1
                            payload['dataset_sha256'] = dataset.dataset_sha256
                            payload['audit_source_plan'] = source['content_sha256']
                            payload['content_sha256'] = payload_sha256(payload)
                            alternative = args.output.with_name(f'{args.output.stem}-{job_id}-feasible.json')
                            write_json_atomic(alternative, payload)
                            detail['validated_alternative'] = str(alternative)
                        elif payload['failure']:
                            detail.update(payload['failure'])
                        elif payload['validation']:
                            detail['violations'] = payload['validation']['violations']
                    entry['positions'].append(detail)
                    save()
                if entry['budget_exhausted']:
                    break
            entry['all_current_positions_checked'] = not entry['budget_exhausted']
            print(json.dumps({'job_id': job_id, 'positions': len(entry['positions']),
                              'feasible_insertions': entry['feasible_insertions'],
                              'budget_exhausted': entry['budget_exhausted']}), flush=True)
            save()
    finally:
        client.close()
    report['completed_at'] = datetime.now(UTC).isoformat()
    for entry in report['jobs'].values():
        entry['summary_ru'] = summarize_job(entry)
    report['status'] = ('PARTIAL' if any(item['budget_exhausted'] for item in report['jobs'].values())
                        else 'ALL_CURRENT_INSERTIONS_CHECKED')
    save()
    if args.explained_plan_output:
        diagnostics = {
            job_id: {
                'static_eligible_engineers': len(entry['eligible_engineer_ids']),
                'candidate_positions': len(entry['positions']),
                'checked_positions': entry['positions'],
                'routing_unverified': sum(item.get('proof_level') == 'ROUTING_UNVERIFIED'
                                          for item in entry['positions']),
                'global_infeasibility_proven': entry['global_assignment_impossible_under_current_constraints'],
            }
            for job_id, entry in report['jobs'].items()
        }
        payload = {key: value for key, value in source.items() if key != 'content_sha256'}
        payload['unserved_insertion_diagnostics'] = diagnostics
        payload['explanations'] = build_explanation_bundle(
            dataset, plan, validation, insertion_diagnostics=diagnostics,
            global_optimality_proven=False,
        )
        for entry in payload['explanations']['jobs']:
            if entry['job_id'] in report['jobs']:
                entry['summary_ru'] = report['jobs'][entry['job_id']]['summary_ru']
        payload['unserved_detailed_audit'] = report
        payload['content_sha256'] = payload_sha256(payload)
        write_json_atomic(args.explained_plan_output, payload)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
