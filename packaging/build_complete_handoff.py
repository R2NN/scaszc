"""Assemble the verified BeeGo handoff without obsolete planning datasets."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SELECTED_DATASET_SHA256 = 'b1a857658425f422fe1e53e4498f8edf7d5008600234e24a6c3bcc8320756a80'
CURRENT_ARTIFACTS = (
    'initial-exact-205-of-205-retimed.json',
    'event-exact-206-of-206-retimed.json',
    'baseline-fcfs-exact.json',
)
RUNTIME_FILES = (
    'valhalla_bridge.py', 'valhalla_route_cli.cpp',
    'valhalla-runtime.json', 'prepare_valhalla_runtime.py',
    'run_exact_repair_background.ps1',
)
SOURCE_DOCUMENTS = (
    '3. Билайн Бизнес.pdf', 'Инструкция для участника .pdf',
    'Инструкция хакатон.docx', 'Итоговая_расшифровка_ответов_на_вопросы.txt',
    'критерии оценки.md', 'Нормативы.xlsx', 'Ответы на вопросы.pdf',
    'условие задачи.md',
)
VALHALLA_FILES = (
    'admins.sqlite', 'central-fed-district-260915.osm.pbf',
    'default_speeds.json', 'file_hashes.txt', 'timezones.sqlite',
    'valhalla.json', 'valhalla_tiles.tar',
)
IGNORE_DIRS = {
    '__pycache__', '.git', '.mypy_cache', '.pytest_cache', '.ruff_cache',
    '.vite', 'node_modules', 'catboost_info', 'outputs', 'ui-runs',
    'ui-shared-cache',
}
IGNORE_SUFFIXES = {'.pyc', '.pyo', '.log', '.tmp', '.partial'}


def copy_file(source: Path, target: Path) -> None:
    """Copy one required file and fail if either input or destination is wrong."""
    if not source.is_file():
        raise FileNotFoundError(source)
    if target.exists():
        raise FileExistsError(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def copy_tree(source: Path, target: Path, *, skip: set[str] = frozenset()) -> None:
    """Copy code/data while excluding generated caches and unused datasets."""
    if not source.is_dir():
        raise FileNotFoundError(source)
    for base, dirs, files in os.walk(source):
        base_path = Path(base)
        dirs[:] = sorted(
            name for name in dirs if name not in IGNORE_DIRS | skip
        )
        for name in sorted(files):
            if name.endswith(tuple(IGNORE_SUFFIXES)) or name in skip:
                continue
            source_file = base_path / name
            if source_file.is_symlink():
                raise ValueError(f'Unexpected symlink in package source: {source_file}')
            copy_file(source_file, target / source_file.relative_to(source))


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def copy_history(batch: Path, stage: Path) -> None:
    """Keep final validated plans, baselines, and their own dated inputs."""
    days = []
    day_dirs = sorted(
        path for path in (batch / 'days').iterdir()
        if path.is_dir() and '2026-02-17' <= path.name <= '2026-08-16'
    )
    if len(day_dirs) != 181:
        raise ValueError(f'Expected 181 historical days, got {len(day_dirs)}')
    for source_day in day_dirs:
        date = source_day.name
        status = read_json(source_day / 'status.json')
        final = Path(status['final_plan'])
        baseline = source_day / 'baseline-fcfs-exact.json'
        artifact = read_json(final)
        base_artifact = read_json(baseline)
        if (
            status['validation_status'] != 'VALID'
            or artifact['status'] != 'EXACT_VALID'
            or artifact['validation']['status'] != 'VALID'
            or artifact['content_sha256'] != status['artifact_sha256']
            or artifact['dataset_sha256'] != status['dataset_sha256']
            or base_artifact['status'] != 'EXACT_VALID'
            or base_artifact['validation']['status'] != 'VALID'
            or base_artifact['dataset_sha256'] != status['dataset_sha256']
        ):
            raise ValueError(f'Historical result is not validated: {date}')
        destination = stage / 'history' / date
        copy_tree(source_day / 'dataset', destination / 'dataset')
        copy_file(final, destination / 'final-exact.json')
        copy_file(baseline, destination / 'baseline-fcfs-exact.json')
        for name in ('dataset-provenance.json', 'dataset-validation.json'):
            copy_file(source_day / name, destination / name)
        portable_status = dict(status)
        portable_status['final_plan'] = f'history/{date}/final-exact.json'
        portable_status['original_final_plan'] = status['final_plan']
        portable_status.pop('pipeline_summary', None)
        (destination / 'status.json').write_text(
            json.dumps(portable_status, ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8',
        )
        days.append({
            'date': date,
            'dataset_sha256': status['dataset_sha256'],
            'plan_sha256': artifact['content_sha256'],
            'baseline_sha256': base_artifact['content_sha256'],
            'assigned': status['assigned'],
            'unassigned': status['unassigned'],
            'unserved_urgent': artifact['validation']['metrics']['unserved_urgent_jobs'],
        })
    if any(day['unserved_urgent'] for day in days):
        raise ValueError('A historical emergency is still unassigned')
    for name in ('progress.json', 'baseline-progress.json'):
        copy_file(batch / name, stage / 'history' / name)
    (stage / 'history' / 'index.json').write_text(
        json.dumps({'schema_version': 1, 'days': days}, ensure_ascii=False, indent=2)
        + '\n', encoding='utf-8',
    )


def assemble(stage: Path, batch: Path, valhalla: Path, gtfs: Path,
             rail: Path, metro: Path, credentials: Path) -> None:
    """Create a complete, auditable snapshot using only selected inputs."""
    if (stage / 'site').exists():
        raise FileExistsError(f'Use a fresh stage: {stage}')
    if not (stage / 'offline-assets/docker/valhalla-scripted-3.8.3.tar').is_file():
        raise FileNotFoundError('Export the running Valhalla Docker image first')
    if not list((stage / 'offline-assets/python-wheels').glob('*.whl')):
        raise FileNotFoundError('Download the offline Python wheels first')

    copy_tree(ROOT / 'site', stage / 'site', skip={'runtime', 'vite-history.stdout.log'})
    copy_tree(ROOT / 'algorithm', stage / 'algorithm', skip={'work', 'artifacts'})
    for name in CURRENT_ARTIFACTS:
        copy_file(ROOT / 'algorithm/artifacts/current' / name,
                  stage / 'algorithm/artifacts/current' / name)
    copy_tree(ROOT / 'data/dataset', stage / 'data/dataset')
    copy_tree(batch / 'aug17-selected-cold-full-20260928/screening',
              stage / 'data/screening')
    copy_tree(ROOT / 'data/traffic4cast', stage / 'data/traffic4cast')
    for name in ('moscow_2026-08-17.sqlite', 'moscow_2026-08-17.manifest.json',
                 'moscow_2026-08-17.surface_walk_transfers.json',
                 'moscow_2026-08-17.walk_transfers.json'):
        copy_file(ROOT / 'data/transit' / name, stage / 'data/transit' / name)
    for name in RUNTIME_FILES:
        copy_file(ROOT / 'runtime' / name, stage / 'runtime' / name)
    for name in SOURCE_DOCUMENTS:
        copy_file(ROOT / 'source_materials/original_inputs' / name,
                  stage / 'source_materials/original_inputs' / name)
    for name in VALHALLA_FILES:
        copy_file(valhalla / name, stage / 'valhalla-data' / name)
    copy_tree(valhalla / 'valhalla_tiles', stage / 'valhalla-data/valhalla_tiles')
    for name in ('agency.txt', 'calendar.txt', 'routes.txt', 'stop_times.txt',
                 'stops.txt', 'trips.txt'):
        copy_file(gtfs / name,
                  stage / 'offline-assets/transit-sources/gtfs' / name)
    for name in ('manifest.json', 'rail_schedule.json', 'rail_station_map.json',
                 'yandex_stations.json'):
        copy_file(rail / name,
                  stage / 'offline-assets/transit-sources/rail' / name)
    copy_file(metro, stage / 'offline-assets/transit-sources/metro/schema.json')
    copy_file(Path('C:/Program Files/nodejs/node.exe'),
              stage / 'offline-assets/node/node.exe')
    copy_file(credentials, stage / '.env.routing.local')
    copy_file(ROOT / 'site/.dev.vars', stage / 'credentials/site.dev.vars.backup')
    for name in ('HANDOFF_FOR_AGENT_RU.md', 'START_BEEGO.ps1',
                 'VERIFY_PACKAGE.py'):
        copy_file(ROOT / 'packaging' / name, stage / name)
    copy_file(ROOT / 'packaging/build_complete_handoff.py',
              stage / 'packaging/build_complete_handoff.py')
    copy_history(batch, stage)

    from beeline_planning import load_planning_dataset, validate_initial_plan
    from beeline_planning.export import load_exact_plan_artifact
    dataset = load_planning_dataset(stage / 'data/dataset', 'core')
    if dataset.dataset_sha256 != SELECTED_DATASET_SHA256:
        raise ValueError('The selected 17 August dataset changed')
    path = stage / 'algorithm/artifacts/current/initial-exact-205-of-205-retimed.json'
    plan, _ = load_exact_plan_artifact(path, dataset.dataset_sha256)
    validation = validate_initial_plan(dataset, plan)
    if (
        validation.status.value != 'VALID'
        or validation.metrics.served_urgent_jobs + validation.metrics.served_normal_jobs != 205
        or validation.metrics.unserved_urgent_jobs != 0
    ):
        raise ValueError('The canonical exact plan is not 205/205')


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def finish(stage: Path, output: Path) -> None:
    """Write per-file hashes, a ZIP64 archive, and its external checksum."""
    if output.exists():
        raise FileExistsError(output)
    files = sorted(
        (path for path in stage.rglob('*') if path.is_file()
         and path.name != 'PACKAGE_MANIFEST_SHA256.tsv'),
        key=lambda path: path.relative_to(stage).as_posix(),
    )
    manifest = stage / 'PACKAGE_MANIFEST_SHA256.tsv'
    with manifest.open('w', encoding='utf-8', newline='\n') as destination:
        destination.write('sha256\tsize_bytes\tpath\n')
        for index, path in enumerate(files, 1):
            destination.write(
                f'{sha256(path)}\t{path.stat().st_size}\t'
                f'{path.relative_to(stage).as_posix()}\n'
            )
            if index % 1000 == 0:
                print(f'HASHED_FILES={index}/{len(files)}', flush=True)
    files.append(manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    prefix = 'BeeGo_COMPLETE_2026-09-28'
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=1,
                         allowZip64=True, strict_timestamps=False) as archive:
        for index, path in enumerate(files, 1):
            archive.write(path, f'{prefix}/{path.relative_to(stage).as_posix()}')
            if index % 1000 == 0:
                print(f'PACKED_FILES={index}/{len(files)}', flush=True)
    with zipfile.ZipFile(output) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f'ZIP CRC failure: {bad}')
    (output.with_suffix(output.suffix + '.sha256')).write_text(
        f'{sha256(output)}  {output.name}\n', encoding='ascii',
    )
    print(json.dumps({
        'zip': str(output), 'bytes': output.stat().st_size,
        'files': len(files), 'crc': 'PASS',
    }, ensure_ascii=False), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--history-root', type=Path, required=True)
    parser.add_argument('--valhalla-dir', type=Path, required=True)
    parser.add_argument('--gtfs-dir', type=Path, required=True)
    parser.add_argument('--rail-dir', type=Path, required=True)
    parser.add_argument('--metro-schema', type=Path, required=True)
    parser.add_argument('--routing-credentials', type=Path, required=True)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--finish-only', action='store_true')
    args = parser.parse_args()
    stage = args.stage.resolve()
    if not args.finish_only:
        import sys
        sys.path.insert(0, str(ROOT / 'algorithm/src'))
        assemble(stage, args.history_root, args.valhalla_dir,
                 args.gtfs_dir, args.rail_dir, args.metro_schema,
                 args.routing_credentials)
        print(f'STAGED={stage}', flush=True)
    if args.archive:
        finish(stage, args.archive.resolve())


if __name__ == '__main__':
    main()
