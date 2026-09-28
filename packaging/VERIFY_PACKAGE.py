"""Verify every archived file and the selected historical result inventory."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
EXPECTED_DATES = 181
FORBIDDEN_PARTS = {'tmp', 'algorithm/work', 'data/original_extract'}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    manifest = ROOT / 'PACKAGE_MANIFEST_SHA256.tsv'
    if not manifest.is_file():
        raise SystemExit('Отсутствует PACKAGE_MANIFEST_SHA256.tsv')
    count = 0
    total = 0
    with manifest.open(encoding='utf-8') as source:
        if source.readline().strip() != 'sha256\tsize_bytes\tpath':
            raise SystemExit('Неверный заголовок манифеста')
        for line in source:
            expected, size, relative = line.rstrip('\n').split('\t', 2)
            path = ROOT / relative
            if path.resolve().is_relative_to(ROOT.resolve()) is False:
                raise SystemExit(f'Недопустимый путь: {relative}')
            if not path.is_file() or path.stat().st_size != int(size):
                raise SystemExit(f'Отсутствует или изменён файл: {relative}')
            if sha256(path) != expected:
                raise SystemExit(f'Контрольная сумма не совпадает: {relative}')
            if any(relative == part or relative.startswith(part + '/') for part in FORBIDDEN_PARTS):
                raise SystemExit(f'Попал отвергнутый каталог: {relative}')
            count += 1
            total += int(size)
            if count % 1000 == 0:
                print(f'Проверено {count} файлов', flush=True)
    history = json.loads((ROOT / 'history/index.json').read_text(encoding='utf-8'))
    days = history['days']
    if len(days) != EXPECTED_DATES or len({day['date'] for day in days}) != EXPECTED_DATES:
        raise SystemExit('История содержит неверное число дат')
    if any(day['unserved_urgent'] != 0 for day in days):
        raise SystemExit('В истории есть незакрытые аварии')
    required = (
        'HANDOFF_FOR_AGENT_RU.md',
        'CHECK_BEFORE_DEMO_RU.md',
        'site/public/data/analytics-history.json',
        'site/public/data/beego-exact-plans.json',
        'algorithm/artifacts/current/initial-exact-205-of-205-retimed.json',
        'data/dataset/manifest.json',
        'valhalla-data/valhalla_tiles.tar',
        'offline-assets/docker/valhalla-scripted-3.8.3.tar',
        'site/.dev.vars',
        '.env.routing.local',
    )
    for relative in required:
        if not (ROOT / relative).is_file():
            raise SystemExit(f'Не хватает обязательного файла: {relative}')
    print(f'OK: {count} файлов, {total} байт, {len(days)} исторический день')


if __name__ == '__main__':
    main()
