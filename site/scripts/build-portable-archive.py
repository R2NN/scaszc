from __future__ import annotations

import argparse
import hashlib
import io
import os
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT if (ROOT / 'algorithm').is_dir() else ROOT.parent
EXCLUDED_DIRS = {
    '.git',
    'node_modules',
    '.vite',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.sites-runtime',
    '.codex-work',
    'ui-runs',
    'ui-shared-cache',
}
EXCLUDED_NAMES = {
    '.dev.vars',
    '.env',
    '.env.routing.local',
    'FILE_INVENTORY.json',
    'SHA256SUMS.txt',
    'PACKAGE_MANIFEST_SHA256.tsv',
    'Thumbs.db',
    '.DS_Store',
}
EXCLUDED_SUFFIXES = {'.pyc', '.pyo', '.log', '.tmp', '.partial'}
GTFS_FILES = ('calendar.txt', 'routes.txt', 'stop_times.txt', 'stops.txt', 'trips.txt')
RAIL_FILES = ('manifest.json', 'rail_schedule.json', 'rail_station_map.json')


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def include(path: Path, output: Path, source_root: Path) -> bool:
    relative = path.relative_to(source_root)
    if path.resolve() == output.resolve():
        return False
    if any(part in EXCLUDED_DIRS for part in relative.parts):
        return False
    if path.name in EXCLUDED_NAMES or path.suffix.lower() in EXCLUDED_SUFFIXES:
        return False
    return path.is_file()


def source_path(explicit: Path | None, environment: str, bundled: Path, fallback: Path) -> Path:
    if explicit is not None:
        return explicit.expanduser().resolve()
    if os.environ.get(environment):
        return Path(os.environ[environment]).expanduser().resolve()
    return bundled if bundled.exists() else fallback


def package_files(output: Path, gtfs: Path, rail: Path, metro: Path, valhalla: Path) -> list[tuple[Path, str]]:
    entries: list[tuple[Path, str]] = []
    for directory, destination in ((ROOT, ''), (REPOSITORY / 'algorithm', 'algorithm'),
                                   (REPOSITORY / 'data', 'data'), (REPOSITORY / 'runtime', 'runtime')):
        if not directory.is_dir():
            raise FileNotFoundError(f'Не найден каталог проекта: {directory}')
        for file in directory.rglob('*'):
            if include(file, output, directory):
                relative = file.relative_to(directory).as_posix()
                if directory == ROOT and (relative.startswith('algorithm/')
                                          or relative.startswith('data/')
                                          or relative.startswith('offline-assets/transit-sources/')
                                          or relative.startswith('valhalla-data/')
                                          or relative.startswith('runtime/')):
                    continue
                entries.append((file, f'{destination}/{relative}'.lstrip('/')))

    for name in GTFS_FILES:
        entries.append((gtfs / name, f'offline-assets/transit-sources/gtfs/{name}'))
    optional_agency = gtfs / 'agency.txt'
    if optional_agency.is_file():
        entries.append((optional_agency, 'offline-assets/transit-sources/gtfs/agency.txt'))
    for name in (*RAIL_FILES, 'yandex_stations.json'):
        file = rail / name
        if name in RAIL_FILES or file.is_file():
            entries.append((file, f'offline-assets/transit-sources/rail/{name}'))
    entries.append((metro, 'offline-assets/transit-sources/metro/schema.json'))
    for name in ('valhalla.json', 'valhalla_tiles.tar', 'admins.sqlite',
                 'timezones.sqlite', 'default_speeds.json', 'file_hashes.txt'):
        entries.append((valhalla / name, f'valhalla-data/{name}'))

    missing = [str(file) for file, _ in entries if not file.is_file()]
    if missing:
        raise FileNotFoundError('Не найдены файлы для переносимого комплекта:\n' + '\n'.join(missing))
    destinations = [destination for _, destination in entries]
    if len(destinations) != len(set(destinations)):
        raise ValueError('Повторяющиеся пути внутри ZIP')
    return sorted(entries, key=lambda entry: entry[1])


def main() -> int:
    parser = argparse.ArgumentParser(description='Build the complete secret-free BeeGo transfer ZIP.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--package-name', default='BeeGo_FULL_TRANSFER_2026-09-22')
    parser.add_argument('--gtfs-dir', type=Path)
    parser.add_argument('--rail-dir', type=Path)
    parser.add_argument('--metro-schema', type=Path)
    parser.add_argument('--valhalla-dir', type=Path)
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    gtfs = source_path(args.gtfs_dir, 'BEEGO_GTFS_DIR', ROOT / 'offline-assets/transit-sources/gtfs',
                       Path('A:/LCT2-routing/gtfs-inspect'))
    rail = source_path(args.rail_dir, 'BEEGO_RAIL_DIR', ROOT / 'offline-assets/transit-sources/rail',
                       Path('A:/LCT2-routing/handoff/work/transit_normal_weekday_mcc_v2'))
    metro = source_path(args.metro_schema, 'BEEGO_METRO_SCHEMA', ROOT / 'offline-assets/transit-sources/metro/schema.json',
                        Path('A:/LCT2-routing/research/mosmetro-api/schema.json'))
    valhalla = source_path(args.valhalla_dir, 'BEEGO_VALHALLA_DIR', ROOT / 'valhalla-data',
                           Path('A:/LCT2-routing/valhalla-data'))
    files = package_files(output, gtfs, rail, metro, valhalla)
    total = sum(path.stat().st_size for path, _ in files)
    print(f'FILES={len(files)} SOURCE_BYTES={total}', flush=True)

    manifest = io.StringIO()
    manifest.write('sha256\tsize_bytes\tpath\n')
    manifest.write('# Secret-free package: .dev.vars is intentionally excluded.\n')
    manifest.write('# Reproducible directories excluded: .git, node_modules and tool caches.\n')
    hashed = 0
    next_report = 512 * 1024 * 1024
    for path, relative in files:
        size = path.stat().st_size
        manifest.write(f'{sha256_file(path)}\t{size}\t{relative}\n')
        hashed += size
        if hashed >= next_report:
            print(f'HASHED={hashed}/{total}', flush=True)
            next_report += 512 * 1024 * 1024

    if output.exists():
        output.unlink()

    prefix = args.package_name.rstrip('/\\')
    written = 0
    next_report = 512 * 1024 * 1024
    with zipfile.ZipFile(
        output,
        mode='w',
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=1,
        allowZip64=True,
        strict_timestamps=False,
    ) as archive:
        for path, relative in files:
            archive.write(path, f'{prefix}/{relative}')
            written += path.stat().st_size
            if written >= next_report:
                print(f'PACKED={written}/{total}', flush=True)
                next_report += 512 * 1024 * 1024
        archive.writestr(f'{prefix}/PACKAGE_MANIFEST_SHA256.tsv', manifest.getvalue().encode('utf-8'))

    with zipfile.ZipFile(output, 'r') as archive:
        bad = archive.testzip()
        if bad is not None:
            raise RuntimeError(f'ZIP CRC verification failed at {bad}')
        names = set(archive.namelist())
        required = {
            f'{prefix}/START_SITE.ps1',
            f'{prefix}/AGENT_STARTUP_RU.md',
            f'{prefix}/package-lock.json',
            f'{prefix}/src/App.jsx',
            f'{prefix}/worker/index.js',
            f'{prefix}/algorithm/pyproject.toml',
            f'{prefix}/public/data/beego-exact-plans.json',
            f'{prefix}/models/demand-forecast-catboost.cbm',
            f'{prefix}/valhalla-data/valhalla_tiles.tar',
            *(f'{prefix}/offline-assets/transit-sources/gtfs/{name}' for name in GTFS_FILES),
            *(f'{prefix}/offline-assets/transit-sources/rail/{name}' for name in RAIL_FILES),
            f'{prefix}/offline-assets/transit-sources/metro/schema.json',
            f'{prefix}/PACKAGE_MANIFEST_SHA256.tsv',
        }
        missing = sorted(required - names)
        if missing:
            raise RuntimeError(f'Required package files are missing: {missing}')

    zip_hash = sha256_file(output)
    hash_path = output.with_suffix(output.suffix + '.sha256')
    hash_path.write_text(f'{zip_hash}  {output.name}\n', encoding='ascii')
    print(f'ZIP_BYTES={output.stat().st_size}', flush=True)
    print('ZIP_CRC=PASS', flush=True)
    print(f'ZIP_SHA256={zip_hash}', flush=True)
    print(f'ZIP_PATH={output}', flush=True)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f'ERROR={error}', file=sys.stderr, flush=True)
        raise
