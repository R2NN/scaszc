"""Verify and install the bundled weekday railway timetable snapshots."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import zipfile
from datetime import date
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).parents[2]
ARCHIVE = ROOT / 'data' / 'transit' / 'weekly-rail-snapshots-2026-09-29.zip'
DESTINATION = ROOT / 'offline-assets' / 'transit-sources' / 'rail'
SOURCE_PREFIX = PurePosixPath('offline-assets/transit-sources/rail')
REQUIRED_FILES = {'manifest.json', 'rail_schedule.json', 'rail_station_map.json',
                  'yandex_stations.json'}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def archive_entries(archive: zipfile.ZipFile) -> tuple[str, dict[str, tuple[str, int]]]:
    checksums = [name for name in archive.namelist() if name.endswith('/SHA256SUMS.tsv')]
    if len(checksums) != 1:
        raise ValueError('В архиве должен быть один SHA256SUMS.tsv')
    prefix = checksums[0].removesuffix('SHA256SUMS.tsv')
    rows = archive.read(checksums[0]).decode('utf-8').splitlines()
    if not rows or rows[0] != 'sha256\tsize_bytes\tpath':
        raise ValueError('Неверный формат SHA256SUMS.tsv')
    entries: dict[str, tuple[str, int]] = {}
    for row in rows[1:]:
        digest, size, name = row.split('\t')
        relative = PurePosixPath(name)
        if (len(digest) != 64 or not all(char in '0123456789abcdef' for char in digest)
                or not relative.is_relative_to(SOURCE_PREFIX)
                or '..' in relative.parts or '\\' in name):
            raise ValueError(f'Недопустимый путь или SHA-256: {name}')
        target = relative.relative_to(SOURCE_PREFIX)
        if (len(target.parts) == 1 and target.name not in REQUIRED_FILES
                or len(target.parts) == 3 and (target.parts[0] != 'dates'
                    or target.name not in REQUIRED_FILES)
                or len(target.parts) not in (1, 3)):
            raise ValueError(f'Неожиданный файл расписания: {name}')
        if name in entries or prefix + name not in archive.namelist():
            raise ValueError(f'Отсутствующий или повторный файл: {name}')
        entries[name] = digest, int(size)
    return prefix, entries


def install(archive_path: Path, destination: Path) -> list[str]:
    """Install verified snapshots without replacing different existing data."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive_path) as archive:
        prefix, entries = archive_entries(archive)
        with tempfile.TemporaryDirectory(prefix='.rail-install-', dir=destination.parent) as temporary:
            staging = Path(temporary)
            for name, (expected_digest, expected_size) in entries.items():
                target = staging / PurePosixPath(name).relative_to(SOURCE_PREFIX)
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                size = 0
                with archive.open(prefix + name) as source, target.open('wb') as output:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(block)
                        size += len(block)
                        output.write(block)
                if digest.hexdigest() != expected_digest or size != expected_size:
                    raise ValueError(f'Контрольная сумма или размер не совпали: {name}')

            dates = sorted((staging / 'dates').iterdir())
            if len(dates) != 6:
                raise ValueError('Ожидались шесть снимков для вторника–воскресенья')
            for folder in dates:
                manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
                source_date = date.fromisoformat(folder.name)
                if (manifest.get('source_date') != folder.name
                        or manifest.get('schedule_scope') != 'exact_date'
                        or manifest.get('coverage_complete') is not True
                        or source_date.weekday() == 0
                        or {item.name for item in folder.iterdir()} != REQUIRED_FILES):
                    raise ValueError(f'Неполный снимок: {folder.name}')
            if {date.fromisoformat(folder.name).weekday() for folder in dates} != set(range(1, 7)):
                raise ValueError('Снимки не покрывают все дни вторник–воскресенье')

            # Check every existing destination before moving anything into place.
            for name, (digest, _) in entries.items():
                target = destination / PurePosixPath(name).relative_to(SOURCE_PREFIX)
                if target.exists() and sha256(target) != digest:
                    raise FileExistsError(f'Существующий файл отличается: {target}')

            destination.mkdir(parents=True, exist_ok=True)
            installed: list[str] = []
            for name in REQUIRED_FILES:
                target = destination / name
                if not target.exists():
                    os.replace(staging / name, target)
                    installed.append(str(target))
            (destination / 'dates').mkdir(exist_ok=True)
            for folder in dates:
                target = destination / 'dates' / folder.name
                if not target.exists():
                    os.replace(folder, target)
                    installed.append(str(target))
            return installed


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, default=ARCHIVE)
    parser.add_argument('--destination', type=Path, default=DESTINATION)
    options = parser.parse_args()
    paths = install(options.archive, options.destination)
    print(f'Проверено: 6 дней недели; установлено: {len(paths)}; каталог: {options.destination}')
