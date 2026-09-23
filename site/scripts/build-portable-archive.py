from __future__ import annotations

import argparse
import hashlib
import io
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRS = {
    '.git',
    'node_modules',
    '.vite',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
}
EXCLUDED_NAMES = {
    '.dev.vars',
    'FILE_INVENTORY.json',
    'SHA256SUMS.txt',
    'PACKAGE_MANIFEST_SHA256.tsv',
    'Thumbs.db',
    '.DS_Store',
}
EXCLUDED_SUFFIXES = {'.pyc', '.pyo', '.log', '.tmp', '.partial'}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def include(path: Path, output: Path) -> bool:
    relative = path.relative_to(ROOT)
    if path.resolve() == output.resolve():
        return False
    if any(part in EXCLUDED_DIRS for part in relative.parts):
        return False
    if path.name in EXCLUDED_NAMES or path.suffix.lower() in EXCLUDED_SUFFIXES:
        return False
    return path.is_file()


def main() -> int:
    parser = argparse.ArgumentParser(description='Build the complete secret-free BeeGo transfer ZIP.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--package-name', default='BeeGo_FULL_TRANSFER_2026-09-22')
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    files = sorted(path for path in ROOT.rglob('*') if include(path, output))
    total = sum(path.stat().st_size for path in files)
    print(f'FILES={len(files)} SOURCE_BYTES={total}', flush=True)

    manifest = io.StringIO()
    manifest.write('sha256\tsize_bytes\tpath\n')
    manifest.write('# Secret-free package: .dev.vars is intentionally excluded.\n')
    manifest.write('# Reproducible directories excluded: .git, node_modules and tool caches.\n')
    hashed = 0
    next_report = 512 * 1024 * 1024
    for path in files:
        relative = path.relative_to(ROOT).as_posix()
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
        for path in files:
            relative = path.relative_to(ROOT).as_posix()
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
