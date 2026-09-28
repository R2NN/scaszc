"""Promote verified targeted urgent repairs for selected historical days."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from beeline_planning import load_planning_dataset, validate_initial_plan
from beeline_planning.export import load_exact_plan_artifact
from run_history_batch import plan_metrics, save_json


ROOT = Path(__file__).parents[2]
DEFAULT_BATCH = Path('A:/LCT2-routing/handoff/work/beego-history-exact-2026')


def verify_day(batch_root: Path, date: str) -> tuple[Path, dict, dict]:
    """Verify both plans and that only new urgent jobs gain assignments."""
    day_root = batch_root / 'days' / date
    status = json.loads((day_root / 'status.json').read_text(encoding='utf-8'))
    if status['status'] != 'COMPLETE' or status['validation_status'] != 'VALID':
        raise ValueError(f'{date}: existing day is incomplete')
    dataset = load_planning_dataset(day_root / 'dataset', 'core')
    if dataset.dataset_sha256 != status['dataset_sha256']:
        raise ValueError(f'{date}: source dataset checksum changed')
    old_path = Path(status['final_plan'])
    old_plan, old = load_exact_plan_artifact(old_path, dataset.dataset_sha256)
    if old['content_sha256'] != status['artifact_sha256']:
        raise ValueError(f'{date}: status and old plan checksums differ')
    new_path = old_path.parent / 'core-targeted-urgent-retimed.json'
    new_plan, new = load_exact_plan_artifact(new_path, dataset.dataset_sha256)
    if (
        new.get('source_plan_content_sha256') != old['content_sha256']
        or new.get('source_plan') != str(old_path)
        or new.get('departure_timing', {}).get('method')
        != 'EXACT_REROUTE_AND_FULL_VALIDATION'
    ):
        raise ValueError(f'{date}: repair provenance is incomplete')
    for label, plan in (('old', old_plan), ('new', new_plan)):
        if validate_initial_plan(dataset, plan).status.value != 'VALID':
            raise ValueError(f'{date}: {label} plan fails independent validation')
    old_assigned = {
        visit.job_id for route in old_plan.engineer_plans for visit in route.visits
    }
    new_assigned = {
        visit.job_id for route in new_plan.engineer_plans for visit in route.visits
    }
    targets = {move['job_id'] for move in new['accepted_moves']}
    if (
        not targets or new_assigned != old_assigned | targets
        or set(old_plan.unserved_job_ids) - set(new_plan.unserved_job_ids) != targets
        or any(dataset.jobs[job_id].priority.value != 'URGENT' for job_id in targets)
    ):
        raise ValueError(f'{date}: repair changed jobs outside the urgent targets')
    old_metrics = old['validation']['metrics']
    new_metrics = new['validation']['metrics']
    if (
        new_metrics['unserved_urgent_jobs']
        != old_metrics['unserved_urgent_jobs'] - len(targets)
        or new_metrics['unserved_normal_jobs']
        != old_metrics['unserved_normal_jobs']
    ):
        raise ValueError(f'{date}: validator metrics changed unexpectedly')
    for route in new_plan.engineer_plans:
        for visit in route.visits:
            if visit.job_id in targets:
                arrival = visit.departure_at + timedelta(
                    minutes=visit.travel.duration_minutes
                )
                if visit.service_start_at - arrival > timedelta(minutes=30):
                    raise ValueError(f'{date}: new job {visit.job_id} arrives too early')
    metrics = plan_metrics(new_path, status['jobs'])
    return new_path, status, {
        'date': date,
        'targets': sorted(targets),
        'before': old_metrics['unserved_urgent_jobs'],
        'after': new_metrics['unserved_urgent_jobs'],
        'artifact_sha256': new['content_sha256'],
        'metrics': metrics,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch-root', type=Path, default=DEFAULT_BATCH)
    parser.add_argument('--date', action='append', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if len(set(args.date)) != len(args.date):
        parser.error('Each date must be supplied once')
    batch_root = args.batch_root.resolve()
    verified = [verify_day(batch_root, date) for date in args.date]
    print(json.dumps({
        'verified_days': len(verified),
        'added_urgent_jobs': sum(len(item[2]['targets']) for item in verified),
        'days': [item[2] for item in verified],
    }, ensure_ascii=False), flush=True)
    if not args.execute:
        return 0

    for new_path, status, audit in verified:
        updated = dict(status)
        updated.update(audit['metrics'])
        updated.update({
            'final_plan': str(new_path),
            'previous_final_plan': status['final_plan'],
            'targeted_urgent_repair_jobs': audit['targets'],
            'targeted_urgent_repair_at': datetime.now(UTC).isoformat(),
        })
        save_json(batch_root / 'days' / audit['date'] / 'status.json', updated)
    subprocess.run([
        sys.executable, str(ROOT / 'site/scripts/publish-exact-history.py'),
        '--batch-root', str(batch_root), '--require-baselines',
    ], cwd=ROOT, check=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
