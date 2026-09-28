"""Promote superior saved exact history plans after safe departure retiming."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from beeline_routing.export import payload_sha256
from run_history_batch import plan_metrics, save_json


ROOT = Path(__file__).parents[2]
DEFAULT_BATCH = Path('A:/LCT2-routing/handoff/work/beego-history-exact-2026')


def exact_quality(artifact: dict) -> tuple[int, int, int, int, int]:
    """Rank by missed urgent work, missed normal work, then route cost."""
    metrics = artifact['validation']['metrics']
    return tuple(int(metrics[key]) for key in (
        'unserved_urgent_jobs', 'unserved_normal_jobs', 'used_engineers',
        'total_distance_m', 'total_travel_minutes',
    ))


def checked_artifact(path: Path, dataset_sha256: str) -> dict | None:
    """Read only a checksummed, independently validated exact artifact."""
    try:
        artifact = json.loads(path.read_text(encoding='utf-8'))
        unsigned = dict(artifact)
        content_sha256 = unsigned.pop('content_sha256', None)
        if (
            content_sha256 != payload_sha256(unsigned)
            or artifact.get('status') != 'EXACT_VALID'
            or artifact.get('publication_allowed') is not True
            or artifact.get('dataset_sha256') != dataset_sha256
            or artifact.get('validation', {}).get('status') != 'VALID'
        ):
            return None
        exact_quality(artifact)
        return artifact
    except (OSError, UnicodeError, ValueError, KeyError, TypeError):
        return None


def best_saved_plan(status: dict) -> tuple[Path, dict] | None:
    """Select the best verified plan in the completed day's own run directory."""
    current_path = Path(status['final_plan'])
    current = checked_artifact(current_path, status['dataset_sha256'])
    if current is None or current['content_sha256'] != status['artifact_sha256']:
        raise ValueError(f'Published plan failed integrity check: {current_path}')
    best_path, best = current_path, current
    for path in current_path.parent.glob('core-*.json'):
        candidate = checked_artifact(path, status['dataset_sha256'])
        if candidate is not None and exact_quality(candidate) < exact_quality(best):
            best_path, best = path, candidate
    if exact_quality(best)[:3] >= exact_quality(current)[:3]:
        return None
    return best_path, best


def retime_candidate(batch_root: Path, day_root: Path, status: dict,
                     candidate_path: Path, candidate: dict,
                     tile_revision: str) -> tuple[Path, dict]:
    """Reroute delayed departures and validate the whole selected plan."""
    if candidate.get('departure_timing', {}).get('method') == 'EXACT_REROUTE_AND_FULL_VALIDATION':
        return candidate_path, candidate
    output = candidate_path.parent / 'core-best-retimed.json'
    retimed = checked_artifact(output, status['dataset_sha256']) if output.is_file() else None
    if retimed is None or retimed.get('departure_timing', {}).get(
        'input_plan_content_sha256'
    ) != candidate['content_sha256']:
        if output.exists():
            raise ValueError(f'Existing retimed artifact does not match source: {output}')
        environment = os.environ.copy()
        environment['PYTHONPATH'] = str(ROOT / 'algorithm/src')
        environment['VALHALLA_TILE_REVISION'] = tile_revision
        environment['VALHALLA_RUNTIME_REVISION'] = f'external-valhalla:tiles:{tile_revision}'
        command = [
            sys.executable, str(ROOT / 'algorithm/tools/retime_exact_plan.py'),
            '--dataset', str(day_root / 'dataset'), '--scenario', 'core',
            '--input-plan', str(candidate_path), '--output', str(output),
            '--cache', str(batch_root / 'shared-cache/routing-cache.sqlite3'),
            '--transit-index', status['transit_index'], '--execute',
        ]
        result = subprocess.run(command, cwd=ROOT, env=environment,
                                capture_output=True, text=True, timeout=180,
                                check=False)
        if result.returncode:
            raise RuntimeError(f'Retiming failed for {day_root.name}: {result.stderr[-1000:]}')
        retimed = checked_artifact(output, status['dataset_sha256'])
    if retimed is None or exact_quality(retimed)[:2] != exact_quality(candidate)[:2]:
        raise ValueError(f'Retiming changed coverage or failed integrity: {day_root.name}')
    return output, retimed


def improve_long_wait(batch_root: Path, day_root: Path, status: dict,
                      tile_revision: str) -> bool:
    """Spend extra exact queries only where a selected route still arrives very early."""
    source_path = Path(status['final_plan'])
    source = checked_artifact(source_path, status['dataset_sha256'])
    if source is None:
        raise ValueError(f'Selected plan failed integrity check: {day_root.name}')
    timing = source.get('departure_timing', {})
    old_wait = timing.get('worst_client_wait_after_minutes', 0)
    if old_wait <= 30 or source_path.stem.endswith('-v2'):
        return False
    output = source_path.parent / 'core-best-retimed-v2.json'
    refined = checked_artifact(output, status['dataset_sha256']) if output.is_file() else None
    if refined is None or refined.get('departure_timing', {}).get(
        'input_plan_content_sha256'
    ) != source['content_sha256']:
        if output.exists():
            raise ValueError(f'Existing timing refinement does not match: {output}')
        environment = os.environ.copy()
        environment['PYTHONPATH'] = str(ROOT / 'algorithm/src')
        environment['VALHALLA_TILE_REVISION'] = tile_revision
        environment['VALHALLA_RUNTIME_REVISION'] = f'external-valhalla:tiles:{tile_revision}'
        command = [
            sys.executable, str(ROOT / 'algorithm/tools/retime_exact_plan.py'),
            '--dataset', str(day_root / 'dataset'), '--scenario', 'core',
            '--input-plan', str(source_path), '--output', str(output),
            '--cache', str(batch_root / 'shared-cache/routing-cache.sqlite3'),
            '--transit-index', status['transit_index'],
            '--max-total-queries', '200', '--max-queries-per-leg', '12', '--execute',
        ]
        result = subprocess.run(command, cwd=ROOT, env=environment,
                                capture_output=True, text=True, timeout=180,
                                check=False)
        if result.returncode:
            raise RuntimeError(f'Extra retiming failed for {day_root.name}: {result.stderr[-1000:]}')
        refined = checked_artifact(output, status['dataset_sha256'])
    if refined is None or exact_quality(refined)[:2] != exact_quality(source)[:2]:
        raise ValueError(f'Extra retiming changed coverage: {day_root.name}')
    new_wait = refined['departure_timing']['worst_client_wait_after_minutes']
    if new_wait >= old_wait:
        return False
    updated = dict(status)
    updated.update(plan_metrics(output, status['jobs']))
    updated['final_plan'] = str(output)
    updated['timing_previous_plan'] = str(source_path)
    updated['selection_quality_after'] = exact_quality(refined)
    save_json(day_root / 'status.json', updated)
    print(json.dumps({'date': day_root.name, 'wait_before': old_wait,
                      'wait_after': new_wait}, ensure_ascii=False), flush=True)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch-root', type=Path, default=DEFAULT_BATCH)
    parser.add_argument('--tile-archive', type=Path, default=Path(
        'A:/LCT2-routing/valhalla-data/valhalla_tiles.tar'))
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    batch_root = args.batch_root.resolve()
    dates = sorted(path.name for path in (batch_root / 'days').iterdir()
                   if path.is_dir() and '2026-02-17' <= path.name <= '2026-08-16')
    if len(dates) != 181:
        raise ValueError(f'Expected 181 completed historical days, found {len(dates)}')
    selections = []
    for date in dates:
        status = json.loads((batch_root / 'days' / date / 'status.json').read_text(encoding='utf-8'))
        if status['status'] != 'COMPLETE' or status['validation_status'] != 'VALID':
            raise ValueError(f'Historical day is incomplete: {date}')
        choice = best_saved_plan(status)
        if choice is not None:
            selections.append((date, status, *choice))
    print(json.dumps({'verified_days': len(dates), 'better_saved_plans': len(selections)},
                     ensure_ascii=False), flush=True)
    if not args.execute:
        return 0
    digest = hashlib.sha256()
    with args.tile_archive.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    tile_revision = digest.hexdigest()
    progress_path = batch_root / 'best-selection-progress.json'
    for number, (date, status, candidate_path, candidate) in enumerate(selections, 1):
        day_root = batch_root / 'days' / date
        output, retimed = retime_candidate(batch_root, day_root, status,
                                           candidate_path, candidate, tile_revision)
        prior_quality = exact_quality(checked_artifact(
            Path(status['final_plan']), status['dataset_sha256']))
        final_quality = exact_quality(retimed)
        if final_quality[:3] >= prior_quality[:3]:
            raise ValueError(f'Selected plan does not improve the day: {date}')
        metrics = plan_metrics(output, status['jobs'])
        new_status = dict(status)
        new_status.update(metrics)
        new_status.update({
            'final_plan': str(output),
            'previous_final_plan': status['final_plan'],
            'selected_from': str(candidate_path),
            'selection_quality_before': prior_quality,
            'selection_quality_after': final_quality,
            'selected_at': datetime.now(UTC).isoformat(),
        })
        save_json(day_root / 'status.json', new_status)
        save_json(progress_path, {'status': 'RUNNING', 'processed': number,
                                  'total': len(selections), 'latest_date': date})
        print(json.dumps({'date': date, 'number': number, 'total': len(selections),
                          'before': prior_quality[:3], 'after': final_quality[:3]},
                         ensure_ascii=False), flush=True)
    for date in dates:
        day_root = batch_root / 'days' / date
        status = json.loads((day_root / 'status.json').read_text(encoding='utf-8'))
        if status.get('selected_at'):
            improve_long_wait(batch_root, day_root, status, tile_revision)
    publisher = ROOT / 'site/scripts/publish-exact-history.py'
    subprocess.run([sys.executable, str(publisher), '--batch-root', str(batch_root),
                    '--require-baselines'], cwd=ROOT, check=True)
    save_json(progress_path, {'status': 'FINISHED', 'processed': len(selections),
                              'total': len(selections),
                              'finished_at': datetime.now(UTC).isoformat()})
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
