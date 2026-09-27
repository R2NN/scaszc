"""Calculate synthetic history days newest first with date-specific exact validation.

Each day's input, timetable provenance, logs and checked plan stay in an
independent directory. The batch is resumable and never treats the generated
analytics plan as a validated solver result.
"""

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
from datetime import UTC, date, datetime
from pathlib import Path

from prepare_history_day import prepare


ROOT = Path(__file__).parents[2]
TOOLS = Path(__file__).parent


def now() -> str:
    return datetime.now(UTC).isoformat()


def save_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def execute(command: list[str], *, stage: str, day_dir: Path, deadline: float,
            extra_env: dict[str, str] | None = None) -> None:
    remaining = deadline - time.monotonic()
    if remaining <= 5:
        raise TimeoutError(f'{stage}: суточный лимит 15 минут исчерпан')
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with (day_dir / 'run.log').open('a', encoding='utf-8') as log:
        log.write(f'\n{now()} STAGE_START {stage}\n')
        log.flush()
        child = subprocess.Popen(
            command, cwd=ROOT, env={**os.environ, 'PYTHONPATH': str(ROOT / 'algorithm' / 'src'),
                                     'PYTHONUTF8': '1', 'PYTHONUNBUFFERED': '1',
                                     **(extra_env or {})},
            stdout=log, stderr=subprocess.STDOUT, creationflags=flags,
        )
        try:
            code = child.wait(timeout=remaining)
        except subprocess.TimeoutExpired as error:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               check=False, creationflags=flags)
            else:
                child.kill()
            child.wait()
            raise TimeoutError(f'{stage}: суточный лимит 15 минут исчерпан') from error
        log.write(f'{now()} STAGE_END {stage} exit={code}\n')
        if code:
            raise RuntimeError(f'{stage} завершился с кодом {code}; см. {day_dir / "run.log"}')


def rail_reference(planning_date: str, cache: Path, base: Path) -> tuple[Path, str]:
    target_weekday = date.fromisoformat(planning_date).weekday()
    candidates: list[tuple[str, Path]] = []
    if cache.is_dir():
        for directory in cache.iterdir():
            if not directory.is_dir():
                continue
            manifest_file = directory / 'manifest.json'
            if not manifest_file.is_file():
                continue
            manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
            source_date = manifest.get('source_date')
            if (manifest.get('schedule_scope') == 'exact_date'
                    and manifest.get('coverage_complete') is True
                    and source_date == directory.name
                    and date.fromisoformat(source_date).weekday() == target_weekday
                    and (directory / 'rail_schedule.json').is_file()
                    and (directory / 'rail_station_map.json').is_file()):
                candidates.append((source_date, directory))
    if target_weekday == date(2026, 9, 21).weekday() and (base / 'rail_schedule.json').is_file():
        candidates.append(('2026-09-21', base))
    if not candidates:
        raise FileNotFoundError(f'Нет полного эталона МЦК/МЦД для дня недели {target_weekday}')
    source_date, directory = max(candidates)
    return directory, source_date


def rail_weekday_override_required(rail: Path) -> bool:
    """Older Monday snapshot already declares itself a weekday reference."""
    manifest = json.loads((rail / 'manifest.json').read_text(encoding='utf-8'))
    return manifest.get('schedule_scope', 'weekday_reference') == 'exact_date'


def index_valid(database: Path, planning_date: str) -> bool:
    files = [database, database.with_suffix('.manifest.json'),
             database.with_suffix('.surface_walk_transfers.json'),
             database.with_suffix('.walk_transfers.json')]
    if not all(file.is_file() for file in files):
        return False
    try:
        metadata = json.loads(files[1].read_text(encoding='utf-8'))
        surface = json.loads(files[2].read_text(encoding='utf-8'))
        rapid = json.loads(files[3].read_text(encoding='utf-8'))
        return (metadata.get('scenario_date') == planning_date
                and metadata.get('active_gtfs_trips', 0) > 0
                and metadata.get('rail_schedule_available') is True
                and surface.get('failed_measurements') == 0
                and rapid.get('failed_stops') == [])
    except (OSError, ValueError, KeyError):
        return False


def check_direct_valhalla(endpoint: str) -> None:
    """Require an actual running Valhalla HTTP server for direct routing."""
    with urllib.request.urlopen(f'{endpoint.rstrip("/")}/status', timeout=5) as response:
        status = json.load(response)
    if not status.get('version') or 'route' not in status.get('available_actions', []):
        raise RuntimeError('Direct Valhalla is not ready for road routing')


def direct_valhalla_revision(tile_archive: Path, endpoint: str) -> str:
    """Bind direct Valhalla routing to a checked local graph snapshot."""
    check_direct_valhalla(endpoint)
    if not tile_archive.is_file():
        raise FileNotFoundError(f'Valhalla tile archive is missing: {tile_archive}')
    digest = hashlib.sha256()
    with tile_archive.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def build_index(args: argparse.Namespace, planning_date: str, day_dir: Path,
                deadline: float) -> tuple[Path, str]:
    database = args.output_root / 'transit' / f'moscow_{planning_date}.sqlite'
    rail, reference_date = rail_reference(planning_date, args.rail_cache, args.rail_base)
    if index_valid(database, planning_date):
        metadata = json.loads(database.with_suffix('.manifest.json').read_text(encoding='utf-8'))
        return database, str(metadata.get('rail_reference_date') or reference_date)
    database.parent.mkdir(parents=True, exist_ok=True)
    building = database.with_name(database.stem + '.building.sqlite')
    for suffix in ('.sqlite', '.manifest.json', '.surface_walk_transfers.json',
                   '.walk_transfers.json'):
        building.with_suffix(suffix).unlink(missing_ok=True)
    if args.valhalla_backend == 'bridge':
        execute([sys.executable, str(TOOLS / 'ensure_local_valhalla.py'),
                 '--endpoint', args.valhalla_base_url],
                stage='ensure_local_valhalla', day_dir=day_dir, deadline=deadline)
    else:
        check_direct_valhalla(args.valhalla_base_url)
    execute([sys.executable, str(TOOLS / 'build_local_transit_index.py'),
             '--gtfs', str(args.gtfs), '--rail', str(rail),
             '--metro-schema', str(args.metro_schema), '--output', str(building),
             '--scenario-date', planning_date,
             *(['--rail-weekday-reference'] if rail_weekday_override_required(rail) else [])],
            stage='build_transit_index', day_dir=day_dir, deadline=deadline)
    execute([sys.executable, str(TOOLS / 'build_surface_walk_transfers.py'),
             '--database', str(building),
             '--endpoint', f'{args.valhalla_base_url.rstrip("/")}/sources_to_targets'],
            stage='build_surface_walk_transfers',
            day_dir=day_dir, deadline=deadline)
    execute([sys.executable, str(TOOLS / 'reuse_rapid_walk_transfers.py'),
             '--source', str(args.canonical_index), '--database', str(building)],
            stage='reuse_rapid_walk_transfers', day_dir=day_dir, deadline=deadline)
    if not index_valid(building, planning_date):
        raise ValueError(f'Индекс {planning_date} не прошёл проверку полноты')
    for suffix in ('.manifest.json', '.surface_walk_transfers.json',
                   '.walk_transfers.json', '.sqlite'):
        building.with_suffix(suffix).replace(database.with_suffix(suffix))
    return database, reference_date


def plan_metrics(plan_path: Path, expected_jobs: int) -> dict:
    artifact = json.loads(plan_path.read_text(encoding='utf-8'))
    if (artifact.get('status') != 'EXACT_VALID'
            or artifact.get('publication_allowed') is not True
            or artifact.get('validation', {}).get('status') != 'VALID'):
        raise ValueError('Конечный план не прошёл точную валидацию')
    plan = artifact['plan']
    assigned = sum(len(route['visits']) for route in plan['engineer_plans'])
    unassigned = len(plan['unserved_job_ids'])
    if assigned + unassigned != expected_jobs:
        raise ValueError('Число назначений не совпадает с числом заявок дня')
    return {'jobs': expected_jobs, 'assigned': assigned, 'unassigned': unassigned,
            'active_engineers': sum(bool(route['visits']) for route in plan['engineer_plans']),
            'validation_status': 'VALID', 'artifact_sha256': artifact.get('content_sha256')}


def run_day(args: argparse.Namespace, history_date: str, expected_jobs: int) -> dict:
    day_dir = args.output_root / 'days' / history_date
    day_dir.mkdir(parents=True, exist_ok=True)
    status_path = day_dir / 'status.json'
    if status_path.is_file():
        previous = json.loads(status_path.read_text(encoding='utf-8'))
        if previous.get('status') == 'COMPLETE' and Path(previous.get('final_plan', '')).is_file():
            try:
                plan_metrics(Path(previous['final_plan']), expected_jobs)
                return previous
            except (OSError, ValueError, KeyError):
                pass
    started = time.monotonic()
    deadline = started + args.max_wall_seconds
    record = {'date': history_date, 'status': 'RUNNING', 'stage': 'prepare_dataset',
              'started_at': now(), 'expected_jobs': expected_jobs}
    save_json(status_path, record)
    try:
        dataset = day_dir / 'dataset'
        if not (dataset / 'CHECKSUMS.sha256').is_file():
            record['provenance'] = prepare(args.source_dataset, args.history,
                                           history_date, dataset)
        record['stage'] = 'validate_dataset'
        save_json(status_path, record)
        validation = day_dir / 'dataset-validation.json'
        validation.unlink(missing_ok=True)
        execute([sys.executable, str(TOOLS / 'validate_planning_dataset_generic.py'),
                 '--dataset', str(dataset), '--scenario', 'core', '--scenario', 'stress',
                 '--output', str(validation)], stage='validate_dataset',
                day_dir=day_dir, deadline=deadline)
        record['dataset_sha256'] = json.loads(validation.read_text(encoding='utf-8'))['dataset_sha256']
        record['stage'] = 'build_transit_index'
        save_json(status_path, record)
        transit_index, rail_date = build_index(args, history_date, day_dir, deadline)
        record['rail_reference_date'] = rail_date
        record['rail_schedule_scope'] = 'weekday_reference'
        record['transit_index'] = str(transit_index)
        record['stage'] = 'exact_pipeline'
        save_json(status_path, record)
        remaining = int(deadline - time.monotonic()) - 12
        if remaining <= 0:
            raise TimeoutError('Не осталось времени на точный план и проверку')
        run_dir = day_dir / 'runs' / datetime.now(UTC).strftime('%Y%m%dT%H%M%S%f')
        execute([sys.executable, str(TOOLS / 'run_new_dataset_pipeline.py'),
                 '--dataset', str(dataset), '--scenario', 'core',
                 '--run-dir', str(run_dir), '--transit-index', str(transit_index),
                 '--shared-cache-dir', str(args.output_root / 'shared-cache'),
                 '--valhalla-base-url', args.valhalla_base_url,
                 *(['--skip-valhalla-autostart'] if args.valhalla_backend == 'direct' else []),
                 '--max-wall-seconds', str(min(840, remaining)), '--execute'],
                stage='exact_pipeline', day_dir=day_dir, deadline=deadline,
                extra_env=({'VALHALLA_TILE_REVISION': args.tile_revision}
                           if args.valhalla_backend == 'direct' else None))
        summary = json.loads((run_dir / 'pipeline-run.json').read_text(encoding='utf-8'))
        plan_path = Path(summary['publishable_final_plan'])
        record.update(plan_metrics(plan_path, expected_jobs))
        record.update({'status': 'COMPLETE', 'stage': 'done', 'final_plan': str(plan_path),
                       'pipeline_summary': str(run_dir / 'pipeline-run.json'),
                       'elapsed_seconds': round(time.monotonic() - started, 1),
                       'finished_at': now()})
    except Exception as error:
        record.update({'status': 'FAILED', 'error': str(error),
                       'elapsed_seconds': round(time.monotonic() - started, 1),
                       'finished_at': now()})
    save_json(status_path, record)
    return record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-root', type=Path, required=True)
    parser.add_argument('--source-dataset', type=Path, default=ROOT / 'algorithm' / 'work' /
                        'dataset_v21' / 'beeline_synthetic_dataset_v2_1')
    parser.add_argument('--history', type=Path, default=ROOT / 'site' / 'public' /
                        'data' / 'analytics-history.json')
    parser.add_argument('--gtfs', type=Path, default=Path(os.environ.get(
                        'BEEGO_GTFS_DIR', 'A:/LCT2-routing/gtfs-inspect')))
    parser.add_argument('--rail-cache', type=Path, default=ROOT / 'runtime' /
                        'ui-shared-cache' / 'rail' / 'dates')
    parser.add_argument('--rail-base', type=Path, default=Path(os.environ.get(
                        'BEEGO_RAIL_DIR', 'A:/LCT2-routing/handoff/work/transit_normal_weekday_mcc_v2')))
    parser.add_argument('--metro-schema', type=Path, default=Path(os.environ.get(
                        'BEEGO_METRO_SCHEMA', 'A:/LCT2-routing/research/mosmetro-api/schema.json')))
    parser.add_argument('--canonical-index', type=Path, default=ROOT / 'data' /
                        'transit' / 'moscow_2026-08-17.sqlite')
    parser.add_argument('--valhalla-backend', choices=('bridge', 'direct'), default='bridge')
    parser.add_argument('--valhalla-base-url', default='http://127.0.0.1:8002')
    parser.add_argument('--tile-archive', type=Path, default=Path(
                        'A:/LCT2-routing/valhalla-data/valhalla_tiles.tar'))
    parser.add_argument('--start-date', default='2026-08-16')
    parser.add_argument('--end-date', default='2026-02-17')
    parser.add_argument('--max-days', type=int, default=0)
    parser.add_argument('--max-wall-seconds', type=int, default=900)
    args = parser.parse_args()
    args.output_root = args.output_root.resolve()
    if args.max_wall_seconds < 60 or args.max_wall_seconds > 900:
        parser.error('Per-day limit must be from 60 to 900 seconds')
    for required in (args.source_dataset / 'manifest.json', args.history, args.gtfs / 'calendar.txt',
                     args.rail_base / 'rail_schedule.json', args.metro_schema, args.canonical_index):
        if not required.is_file():
            parser.error(f'Missing input: {required}')
    args.tile_revision = (direct_valhalla_revision(args.tile_archive, args.valhalla_base_url)
                          if args.valhalla_backend == 'direct' else None)
    args.output_root.mkdir(parents=True, exist_ok=True)
    history = json.loads(args.history.read_text(encoding='utf-8'))
    days = sorted((day for day in history['days'] if args.end_date <= day['date'] <= args.start_date),
                  key=lambda day: day['date'], reverse=True)
    if args.max_days:
        days = days[:args.max_days]
    progress_path = args.output_root / 'progress.json'
    save_json(progress_path, {'status': 'RUNNING', 'updated_at': now(),
                              'total_days': len(days), 'processed': 0,
                              'completed': 0, 'failed': 0, 'remaining': len(days)})
    consecutive_infrastructure_failures = 0
    for ordinal, day in enumerate(days, 1):
        if shutil.disk_usage(args.output_root).free < 2 * 1024**3:
            raise OSError('Batch stopped: less than 2 GiB free on output drive')
        result = run_day(args, day['date'], len(day['orders']))
        summary = {'status': 'RUNNING', 'updated_at': now(), 'total_days': len(days), 'processed': ordinal,
                   'latest_date': day['date'], 'latest_status': result['status'],
                   'completed': 0, 'failed': 0, 'remaining': len(days) - ordinal}
        for item in days[:ordinal]:
            file = args.output_root / 'days' / item['date'] / 'status.json'
            if file.is_file():
                status = json.loads(file.read_text(encoding='utf-8')).get('status')
                summary['completed'] += status == 'COMPLETE'
                summary['failed'] += status == 'FAILED'
        save_json(progress_path, summary)
        print(json.dumps({'event': 'DAY_DONE', **summary, 'result': result}, ensure_ascii=False), flush=True)
        infrastructure_failed = (result['status'] == 'FAILED' and
                                 result.get('stage') in {'prepare_dataset', 'validate_dataset',
                                                          'build_transit_index'})
        consecutive_infrastructure_failures = (consecutive_infrastructure_failures + 1
                                                if infrastructure_failed else 0)
        if consecutive_infrastructure_failures >= 3:
            summary['stopped_reason'] = 'Three consecutive input or transit failures'
            save_json(progress_path, summary)
            print(json.dumps({'event': 'BATCH_STOPPED', **summary}, ensure_ascii=False), flush=True)
            return 1
    summary['status'] = 'FINISHED'
    save_json(progress_path, summary)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
