"""Resume independently validated FCFS baselines for all synthetic history days."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path


ROOT = Path(__file__).parents[2]
BASELINE_TOOL = Path(__file__).with_name('build_exact_fcfs_baseline.py')
PUBLISH_TOOL = ROOT / 'site/scripts/publish-exact-history.py'


def now() -> str:
    return datetime.now(UTC).isoformat()


def save_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8', newline='\n') as output:
        json.dump(value, output, ensure_ascii=False, indent=2)
        output.write('\n')
    temporary.replace(path)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def check_valhalla(base_url: str) -> None:
    with urllib.request.urlopen(f'{base_url.rstrip("/")}/status', timeout=5) as response:
        status = json.load(response)
    if not status.get('version') or 'route' not in status.get('available_actions', []):
        raise RuntimeError('Valhalla is not ready for exact FCFS routing')


def baseline_metrics(path: Path, expected_jobs: int, dataset_sha256: str) -> dict:
    artifact = json.loads(path.read_text(encoding='utf-8'))
    if (artifact.get('artifact_type') != 'EXACT_FCFS_BASELINE'
            or artifact.get('status') != 'EXACT_VALID'
            or artifact.get('publication_allowed') is not True
            or artifact.get('validation', {}).get('status') != 'VALID'
            or artifact.get('dataset_sha256') != dataset_sha256):
        raise ValueError('FCFS baseline is not validated for this dataset')
    assigned = sum(len(route['visits']) for route in artifact['plan']['engineer_plans'])
    unassigned = len(artifact['plan']['unserved_job_ids'])
    if assigned + unassigned != expected_jobs:
        raise ValueError('FCFS baseline job count differs from the input')
    return {'jobs': expected_jobs, 'assigned': assigned, 'unassigned': unassigned,
            'active_engineers': sum(bool(route['visits']) for route in artifact['plan']['engineer_plans']),
            'artifact_sha256': artifact['content_sha256'],
            'exact_provider_queries': artifact['exact_provider_queries']}


def run_day(args: argparse.Namespace, history_date: str, environment: dict[str, str]) -> dict:
    day_root = args.output_root / 'days' / history_date
    source_status = json.loads((day_root / 'status.json').read_text(encoding='utf-8'))
    if source_status['status'] != 'COMPLETE' or source_status['validation_status'] != 'VALID':
        raise ValueError(f'{history_date}: optimized plan is not valid')
    artifact_path = day_root / 'baseline-fcfs-exact.json'
    status_path = day_root / 'baseline-status.json'
    if artifact_path.is_file():
        try:
            metrics = baseline_metrics(artifact_path, source_status['jobs'], source_status['dataset_sha256'])
            if status_path.is_file():
                previous = json.loads(status_path.read_text(encoding='utf-8'))
                if previous.get('status') == 'COMPLETE':
                    return previous
            record = {'date': history_date, 'status': 'COMPLETE', 'source': 'REUSED_VALIDATED_ARTIFACT',
                      **metrics, 'artifact': str(artifact_path), 'finished_at': now()}
            save_json(status_path, record)
            return record
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            pass

    started = time.monotonic()
    record = {'date': history_date, 'status': 'RUNNING', 'started_at': now()}
    save_json(status_path, record)
    command = [sys.executable, '-u', str(BASELINE_TOOL),
               '--dataset', str(day_root / 'dataset'), '--scenario', 'core',
               '--cache', str(args.output_root / 'shared-cache/routing-cache.sqlite3'),
               '--transit-index', str(args.output_root / 'transit' / f'moscow_{history_date}.sqlite'),
               '--output', str(artifact_path), '--execute']
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    try:
        check_valhalla(args.valhalla_base_url)
        with (day_root / 'baseline.log').open('a', encoding='utf-8') as log:
            log.write(f'{now()} START exact FCFS\n')
            log.flush()
            child = subprocess.Popen(command, cwd=ROOT, env=environment,
                                     stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
            try:
                code = child.wait(timeout=args.max_wall_seconds)
            except subprocess.TimeoutExpired as error:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], check=False,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=flags)
                else:
                    child.kill()
                child.wait()
                raise TimeoutError('FCFS exceeded the 15-minute per-day limit') from error
            log.write(f'{now()} END exact FCFS exit={code}\n')
        if code:
            raise RuntimeError(f'FCFS exited with code {code}; see {day_root / "baseline.log"}')
        metrics = baseline_metrics(artifact_path, source_status['jobs'], source_status['dataset_sha256'])
        record.update({'status': 'COMPLETE', **metrics, 'artifact': str(artifact_path),
                       'elapsed_seconds': round(time.monotonic() - started, 1), 'finished_at': now()})
    except Exception as error:
        record.update({'status': 'FAILED', 'error': str(error),
                       'elapsed_seconds': round(time.monotonic() - started, 1), 'finished_at': now()})
    save_json(status_path, record)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-root', type=Path, required=True)
    parser.add_argument('--tile-archive', type=Path,
                        default=Path('A:/LCT2-routing/valhalla-data/valhalla_tiles.tar'))
    parser.add_argument('--valhalla-base-url', default='http://127.0.0.1:8002')
    parser.add_argument('--max-wall-seconds', type=int, default=900)
    args = parser.parse_args()
    args.output_root = args.output_root.resolve()
    if args.max_wall_seconds < 60 or args.max_wall_seconds > 900:
        parser.error('Per-day limit must be from 60 to 900 seconds')
    if not args.tile_archive.is_file():
        parser.error(f'Missing Valhalla tile archive: {args.tile_archive}')
    optimized_progress = json.loads((args.output_root / 'progress.json').read_text(encoding='utf-8'))
    if (optimized_progress['status'] != 'FINISHED' or optimized_progress['completed'] != 181
            or optimized_progress['failed'] != 0):
        parser.error('Optimized history is not complete and valid')
    dates = sorted((path.name for path in (args.output_root / 'days').iterdir()
                    if path.is_dir() and '2026-02-17' <= path.name <= '2026-08-16'), reverse=True)
    if len(dates) != 181:
        parser.error(f'Expected 181 historical dates, got {len(dates)}')
    check_valhalla(args.valhalla_base_url)
    tile_sha256 = file_sha256(args.tile_archive)
    environment = {**os.environ,
                   'PYTHONPATH': str(ROOT / 'algorithm/src'),
                   'PYTHONUTF8': '1', 'PYTHONUNBUFFERED': '1',
                   'VALHALLA_ROUTE_ENDPOINT': f'{args.valhalla_base_url.rstrip("/")}/route',
                   'VALHALLA_TILE_REVISION': tile_sha256,
                   'VALHALLA_RUNTIME_REVISION': f'external-valhalla:tiles:{tile_sha256}'}
    progress_path = args.output_root / 'baseline-progress.json'
    consecutive_failures = 0
    for ordinal, history_date in enumerate(dates, 1):
        if shutil.disk_usage(args.output_root).free < 2 * 1024**3:
            raise OSError('Less than 2 GiB free on output drive')
        result = run_day(args, history_date, environment)
        statuses = [json.loads((args.output_root / 'days' / date / 'baseline-status.json')
                             .read_text(encoding='utf-8')).get('status')
                    for date in dates[:ordinal]]
        summary = {'status': 'RUNNING', 'updated_at': now(), 'total_days': len(dates),
                   'processed': ordinal, 'latest_date': history_date,
                   'latest_status': result['status'],
                   'completed': statuses.count('COMPLETE'), 'failed': statuses.count('FAILED'),
                   'remaining': len(dates) - ordinal}
        save_json(progress_path, summary)
        print(json.dumps({'event': 'BASELINE_DAY_DONE', **summary, 'result': result},
                         ensure_ascii=False), flush=True)
        consecutive_failures = consecutive_failures + 1 if result['status'] == 'FAILED' else 0
        if consecutive_failures >= 3:
            summary.update({'status': 'STOPPED', 'reason': 'Three consecutive FCFS failures'})
            save_json(progress_path, summary)
            return 1
    if summary['failed']:
        summary['status'] = 'INCOMPLETE'
        save_json(progress_path, summary)
        return 1
    summary['status'] = 'PUBLISHING'
    save_json(progress_path, summary)
    publish = subprocess.run([sys.executable, str(PUBLISH_TOOL), '--batch-root', str(args.output_root),
                              '--require-baselines'], cwd=ROOT, env=environment,
                             capture_output=True, text=True, timeout=180, check=False)
    if publish.returncode:
        summary.update({'status': 'PUBLISH_FAILED', 'error': publish.stderr or publish.stdout})
        save_json(progress_path, summary)
        return 1
    summary.update({'status': 'FINISHED', 'published': True, 'published_at': now()})
    save_json(progress_path, summary)
    print(publish.stdout.strip(), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
