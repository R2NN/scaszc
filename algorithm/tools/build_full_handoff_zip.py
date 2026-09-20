from __future__ import annotations

import argparse
import hashlib
import os
import zipfile
from pathlib import Path


EXCLUDED_FILES = {
    'handoff/.env.routing.local',
    'handoff/work/planning/mapbox-token-recheck.json',
    'research/moscow-metro-isochrone/.env',
    'valhalla-data/central-fed-district-latest.osm.pbf.partial',
}
EXCLUDED_PARTS = {'.mypy_cache', '.pytest_cache', '__pycache__'}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _included(root: Path, path: Path) -> bool:
    relative = path.relative_to(root).as_posix()
    if relative in EXCLUDED_FILES:
        return False
    if any(part in EXCLUDED_PARTS for part in path.relative_to(root).parts):
        return False
    if path.name == 'PACKAGE_MANIFEST_SHA256.tsv':
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description='Build a secret-free full project handoff ZIP.')
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--package-name', required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    output = args.output.resolve()
    files = sorted(
        path for path in root.rglob('*') if path.is_file() and _included(root, path)
    )
    total = sum(path.stat().st_size for path in files)
    print(f'FILES={len(files)} BYTES={total}', flush=True)

    manifest_path = root / 'handoff' / 'PACKAGE_MANIFEST_SHA256.tsv'
    manifest_lines = [
        'sha256\tsize_bytes\tpath',
        '# Excluded secrets: handoff/.env.routing.local; research/moscow-metro-isochrone/.env',
        '# Excluded obsolete/incomplete data: handoff/work/planning/mapbox-token-recheck.json; valhalla-data/*.partial',
    ]
    hashed = 0
    next_report = 512 * 1024 * 1024
    for path in files:
        size = path.stat().st_size
        relative = path.relative_to(root).as_posix()
        manifest_lines.append(f'{_sha256(path)}\t{size}\t{relative}')
        hashed += size
        if hashed >= next_report:
            print(f'HASHED={hashed}/{total}', flush=True)
            next_report += 512 * 1024 * 1024
    manifest_path.write_text('\n'.join(manifest_lines) + '\n', encoding='utf-8')
    files.append(manifest_path)

    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()
    prefix = f'{args.package_name}/LCT2-routing'
    written = 0
    next_report = 512 * 1024 * 1024
    with zipfile.ZipFile(
        output,
        'w',
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=1,
        allowZip64=True,
    ) as archive:
        for path in files:
            relative = path.relative_to(root).as_posix()
            archive.write(path, f'{prefix}/{relative}')
            written += path.stat().st_size
            if written >= next_report:
                print(f'PACKED={written}/{total}', flush=True)
                next_report += 512 * 1024 * 1024

    print(f'ZIP_BYTES={output.stat().st_size}', flush=True)
    with zipfile.ZipFile(output, 'r') as archive:
        bad = archive.testzip()
    if bad is not None:
        raise RuntimeError(f'ZIP CRC verification failed at {bad}')
    print('ZIP_CRC=PASS', flush=True)
    zip_hash = _sha256(output)
    hash_path = output.with_suffix(output.suffix + '.sha256')
    hash_path.write_text(f'{zip_hash}  {output.name}\n', encoding='ascii')
    print(f'ZIP_SHA256={zip_hash}', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
