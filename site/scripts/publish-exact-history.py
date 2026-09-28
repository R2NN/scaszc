#!/usr/bin/env python3
"""Publish independently validated plans for synthetic historical workloads."""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


SITE_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BATCH_ROOT = Path('A:/LCT2-routing/handoff/work/beego-history-exact-2026')
HISTORY_FILE = SITE_ROOT / 'public/data/analytics-history.json'


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open('r', encoding='utf-8-sig', newline='') as source:
        return list(csv.DictReader(source, delimiter=';'))


def clock(value: str) -> str:
    return value[11:16]


def clock_after(value: str, minutes: float) -> str:
    return (datetime.fromisoformat(value) + timedelta(minutes=minutes)).strftime('%H:%M')


def minute(value: str) -> int:
    hour, part = map(int, value.split(':'))
    return hour * 60 + part


def normalize_order(job: dict[str, str], date: str) -> dict:
    priority = {'URGENT': 'Авария', 'HIGH': 'Высокая'}.get(job['priority'], 'Обычная')
    return {
        'id': f"{date}:{job['job_id']}",
        'sourceId': job['job_id'],
        'name': f"Заявка {job.get('source_job_id') or job['job_id']}",
        'address': job['address'],
        'start': clock(job['window_start']),
        'end': clock(job['window_end']),
        'duration': int(job['service_duration_min']),
        'priority': priority,
        'workType': job['bk_type'],
        'serviceType': job['hd_type'],
        'skill': job['required_skill'],
        'zone': job['zone_name'],
        'zoneId': job['zone_id'],
        'district': job['district'],
        'regionId': 'moscow',
        'regionName': 'Москва',
        'status': job['status'],
    }


def normalize_engineer(engineer: dict[str, str], skills: dict[str, list[str]]) -> dict:
    return {
        'id': engineer['engineer_id'],
        'name': engineer['engineer_name'],
        'skills': skills[engineer['engineer_id']],
        'shiftStart': engineer['shift_start'],
        'shiftEnd': engineer['shift_end'],
        'transport': engineer['transport_type'],
        'zone': engineer['zone_name'],
        'regionId': 'moscow',
    }


def compact_baseline(day_root: Path, date: str, dataset_sha256: str,
                     jobs_by_id: dict[str, dict[str, str]],
                     engineers_by_id: dict[str, dict]) -> dict:
    path = day_root / 'baseline-fcfs-exact.json'
    artifact = json.loads(path.read_text(encoding='utf-8'))
    if (artifact.get('artifact_type') != 'EXACT_FCFS_BASELINE'
            or artifact.get('status') != 'EXACT_VALID'
            or artifact.get('publication_allowed') is not True
            or artifact.get('validation', {}).get('status') != 'VALID'
            or artifact.get('dataset_sha256') != dataset_sha256):
        raise ValueError(f'{date}: FCFS baseline is not valid for this dataset')
    routes = []
    assigned_ids: set[str] = set()
    for source_route in artifact['plan']['engineer_plans']:
        engineer_id = source_route['engineer_id']
        if engineer_id not in engineers_by_id:
            raise ValueError(f'{date}: FCFS uses unavailable engineer {engineer_id}')
        assignments = []
        for position, visit in enumerate(source_route['visits'], 1):
            job_id = visit['job_id']
            if job_id not in jobs_by_id or job_id in assigned_ids:
                raise ValueError(f'{date}: FCFS has unknown or duplicate job {job_id}')
            assigned_ids.add(job_id)
            travel = visit['travel']
            assignments.append({
                'orderId': f'{date}:{job_id}',
                'engineerId': engineer_id,
                'position': position,
                'departureAt': clock(visit['departure_at']),
                'arrival': clock_after(visit['departure_at'],
                                       int(travel.get('duration_seconds',
                                                      int(travel['duration_minutes']) * 60)) / 60),
                'plannedStart': clock(visit['service_start_at']),
                'plannedFinish': clock_after(visit['service_start_at'],
                                             int(jobs_by_id[job_id]['service_duration_min'])),
                'travelMinutes': int(travel['duration_minutes']),
                'distanceM': int(travel['distance_m']),
            })
        if not assignments:
            continue
        engineer = engineers_by_id[engineer_id]
        routes.append({
            'engineerId': engineer_id,
            'engineerName': engineer['name'],
            'shiftStart': engineer['shiftStart'],
            'shiftEnd': engineer['shiftEnd'],
            'assignments': assignments,
            'workloadMinutes': max(0, minute(assignments[-1]['plannedFinish']) - minute(engineer['shiftStart'])),
            'distanceKm': sum(item['distanceM'] for item in assignments) / 1000,
            'travelMinutes': sum(item['travelMinutes'] for item in assignments),
            'waitingMinutes': sum(max(0, minute(item['plannedStart']) - minute(item['arrival']))
                                  for item in assignments),
        })
    unserved_ids = artifact['plan']['unserved_job_ids']
    if (len(set(unserved_ids)) != len(unserved_ids) or set(unserved_ids) & assigned_ids
            or set(unserved_ids) | assigned_ids != set(jobs_by_id)):
        raise ValueError(f'{date}: FCFS does not partition the daily jobs')
    metrics = artifact['validation']['metrics']
    if (len(assigned_ids) != metrics['served_urgent_jobs'] + metrics['served_normal_jobs']
            or len(unserved_ids) != metrics['unserved_urgent_jobs'] + metrics['unserved_normal_jobs']
            or len(routes) != metrics['used_engineers']
            or sum(item['distanceM'] for route in routes for item in route['assignments'])
            != metrics['total_distance_m']
            or sum(route['travelMinutes'] for route in routes) != metrics['total_travel_minutes']):
        raise ValueError(f'{date}: FCFS metrics differ from the validator')
    return {
        'status': 'EXACT_VALID',
        'validationStatus': 'VALID',
        'publicationAllowed': True,
        'methodology': 'EXACT_FCFS_SAME_ROUTING_AND_VALIDATOR',
        'policy': artifact['baseline_policy'],
        'contentSha256': artifact['content_sha256'],
        'routes': routes,
        'unassigned': [{'orderId': f'{date}:{job_id}'} for job_id in unserved_ids],
        'metrics': {
            'total': len(jobs_by_id),
            'assigned': len(assigned_ids),
            'unassigned': len(unserved_ids),
            'activeEngineers': len(routes),
            'distanceKm': sum(route['distanceKm'] for route in routes),
            'travelMinutes': sum(route['travelMinutes'] for route in routes),
        },
    }


def build_day(batch_root: Path, date: str, include_baseline: bool = False) -> dict:
    day_root = batch_root / 'days' / date
    status = json.loads((day_root / 'status.json').read_text(encoding='utf-8'))
    if status['status'] != 'COMPLETE' or status['validation_status'] != 'VALID':
        raise ValueError(f'{date}: plan is not complete and valid')
    plan_path = Path(status['final_plan']).resolve()
    if day_root.resolve() not in plan_path.parents:
        raise ValueError(f'{date}: plan path escapes the day directory')
    artifact = json.loads(plan_path.read_text(encoding='utf-8'))
    if (artifact['status'] != 'EXACT_VALID' or artifact['publication_allowed'] is not True
            or artifact['validation']['status'] != 'VALID'
            or artifact['dataset_sha256'] != status['dataset_sha256']
            or artifact['content_sha256'] != status['artifact_sha256']):
        raise ValueError(f'{date}: plan provenance or validation mismatch')

    dataset = day_root / 'dataset'
    jobs = read_csv(dataset / 'core/jobs.csv')
    engineers = read_csv(dataset / 'common/engineers.csv')
    skill_rows = read_csv(dataset / 'common/engineer_skills.csv')
    skills: dict[str, list[str]] = defaultdict(list)
    for row in skill_rows:
        skills[row['engineer_id']].append(row['skill_id'])
    orders = [normalize_order(job, date) for job in jobs]
    team = [normalize_engineer(engineer, skills) for engineer in engineers
            if engineer['is_available'].lower() == 'true']
    jobs_by_id = {job['job_id']: job for job in jobs}
    engineers_by_id = {engineer['id']: engineer for engineer in team}
    if len(jobs_by_id) != len(jobs) or len(engineers_by_id) != len(team):
        raise ValueError(f'{date}: duplicate job or engineer identifier')
    explanations = {item['job_id']: item for item in artifact.get('explanations', {}).get('jobs', [])}

    routes = []
    assigned_ids: set[str] = set()
    for source_route in artifact['plan']['engineer_plans']:
        engineer_id = source_route['engineer_id']
        if engineer_id not in engineers_by_id:
            raise ValueError(f'{date}: unknown or unavailable engineer {engineer_id}')
        assignments = []
        for position, visit in enumerate(source_route['visits'], 1):
            job_id = visit['job_id']
            if job_id not in jobs_by_id or job_id in assigned_ids:
                raise ValueError(f'{date}: unknown or duplicate assigned job {job_id}')
            assigned_ids.add(job_id)
            job = jobs_by_id[job_id]
            travel = visit['travel']
            assignments.append({
                'orderId': f'{date}:{job_id}',
                'engineerId': engineer_id,
                'position': position,
                'departureAt': clock(visit['departure_at']),
                'arrival': clock_after(visit['departure_at'],
                                       int(travel.get('duration_seconds',
                                                      int(travel['duration_minutes']) * 60)) / 60),
                'plannedStart': clock(visit['service_start_at']),
                'plannedFinish': clock_after(visit['service_start_at'], int(job['service_duration_min'])),
                'travelMinutes': int(travel['duration_minutes']),
                'distanceM': int(travel['distance_m']),
            })
        if not assignments:
            continue
        shift = engineers_by_id[engineer_id]
        routes.append({
            'engineerId': engineer_id,
            'engineerName': shift['name'],
            'shiftStart': shift['shiftStart'],
            'shiftEnd': shift['shiftEnd'],
            'assignments': assignments,
            'workloadMinutes': max(0, minute(assignments[-1]['plannedFinish']) - minute(shift['shiftStart'])),
            'distanceKm': sum(item['distanceM'] for item in assignments) / 1000,
            'travelMinutes': sum(item['travelMinutes'] for item in assignments),
            'waitingMinutes': sum(max(0, minute(item['plannedStart']) - minute(item['arrival']))
                                  for item in assignments),
        })
    unserved_ids = artifact['plan']['unserved_job_ids']
    if (len(set(unserved_ids)) != len(unserved_ids) or set(unserved_ids) & assigned_ids
            or set(unserved_ids) | assigned_ids != set(jobs_by_id)):
        raise ValueError(f'{date}: assigned and unassigned jobs do not partition the input')
    unassigned = [{
        'orderId': f'{date}:{job_id}',
        'reasonCode': explanations.get(job_id, {}).get('decision_kind', 'UNSERVED'),
        'reason': explanations.get(job_id, {}).get('summary_ru', 'Не найдено допустимое назначение'),
    } for job_id in unserved_ids]
    metrics = artifact['validation']['metrics']
    if (len(jobs) != status['jobs'] or len(assigned_ids) != status['assigned']
            or len(unassigned) != status['unassigned']
            or len(routes) != status['active_engineers']
            or len(assigned_ids) != metrics['served_urgent_jobs'] + metrics['served_normal_jobs']
            or sum(item['distanceM'] for route in routes for item in route['assignments'])
            != metrics['total_distance_m']
            or sum(route['travelMinutes'] for route in routes) != metrics['total_travel_minutes']):
        raise ValueError(f'{date}: published counts differ from the validator')
    return {
        'date': date,
        'dataKind': 'SYNTHETIC_INPUT_EXACT_PLAN',
        'provenance': {
            'workload': 'SYNTHETIC_DATE_SPECIFIC_INPUT',
            'plan': 'INDEPENDENTLY_VALIDATED_EXACT',
            'datasetSha256': status['dataset_sha256'],
            'railScheduleScope': status['rail_schedule_scope'],
            'railReferenceDate': status['rail_reference_date'],
        },
        'orders': orders,
        'team': team,
        'plan': {
            'status': 'EXACT_VALID',
            'validationStatus': 'VALID',
            'publicationAllowed': True,
            'contentSha256': status['artifact_sha256'],
            'routes': routes,
            'unassigned': unassigned,
            'metrics': {
                'total': len(orders),
                'assigned': len(assigned_ids),
                'unassigned': len(unassigned),
                'activeEngineers': len(routes),
                'urgentAssigned': int(metrics['served_urgent_jobs']),
                'distanceKm': sum(route['distanceKm'] for route in routes),
                'travelMinutes': sum(route['travelMinutes'] for route in routes),
                'waitingMinutes': sum(route['waitingMinutes'] for route in routes),
            },
            'baseline': (compact_baseline(day_root, date, status['dataset_sha256'],
                                          jobs_by_id, engineers_by_id)
                         if include_baseline else None),
        },
        'actual': None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch-root', type=Path, default=DEFAULT_BATCH_ROOT)
    parser.add_argument('--output', type=Path, default=HISTORY_FILE)
    parser.add_argument('--require-baselines', action='store_true')
    args = parser.parse_args()
    progress = json.loads((args.batch_root / 'progress.json').read_text(encoding='utf-8'))
    if (progress['status'] != 'FINISHED' or progress['completed'] != 181
            or progress['failed'] != 0):
        raise ValueError('Historical batch is not finished with 181 valid days')
    existing = json.loads(args.output.read_text(encoding='utf-8'))
    current = existing['days'][-1]
    if (current['date'] != '2026-08-17' or current['plan']['metrics']['assigned'] != 205
            or current['plan']['validationStatus'] != 'VALID'):
        raise ValueError('Canonical 17 August day is missing or invalid')
    dates = sorted(path.name for path in (args.batch_root / 'days').iterdir()
                   if path.is_dir() and '2026-02-17' <= path.name <= '2026-08-16')
    if len(dates) != 181:
        raise ValueError(f'Expected 181 historical dates, got {len(dates)}')
    days = [build_day(args.batch_root, date, args.require_baselines) for date in dates]
    days.append(current)
    result = {'schemaVersion': existing['schemaVersion'],
              'period': {'start': dates[0], 'end': current['date']}, 'days': days}
    output = json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n'
    temporary = args.output.with_suffix('.json.tmp')
    with temporary.open('w', encoding='utf-8', newline='\n') as destination:
        destination.write(output)
    temporary.replace(args.output)
    print(json.dumps({'days': len(days), 'exactHistoryDays': len(dates),
                      'jobs': sum(day['plan']['metrics']['total'] for day in days),
                      'assigned': sum(day['plan']['metrics']['assigned'] for day in days),
                      'output': str(args.output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
