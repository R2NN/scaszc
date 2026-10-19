"""Verify the portable checkout without installing dependencies or changing data."""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def checked_path(parent: Path, relative: str) -> Path:
    """Resolve a manifest entry strictly within its resource directory."""
    target = (parent / relative).resolve()
    if not target.is_relative_to(parent.resolve()) or not target.is_file():
        raise ValueError(f'Missing or invalid resource: {relative}')
    return target


def digest_file(file: Path, combined=None) -> str:
    """Hash file bytes, optionally also extending a multipart stream digest."""
    digest = hashlib.sha256()
    with file.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
            if combined is not None:
                combined.update(block)
    return digest.hexdigest()


def verify_repository(root: Path) -> dict[str, int | str]:
    """Check dataset bytes, runtime parts, retained examples and launch files."""
    required = (
        'README.md', 'AGENTS.md', 'Dockerfile', 'compose.complete.yaml',
        'site/package.json', 'site/pnpm-lock.yaml', 'site/server/main.mjs',
        'site/models/demand-forecast-catboost.cbm',
        'algorithm/artifacts/complexity/initial-exact.json',
        'algorithm/artifacts/current/initial-exact-205-of-205-retimed.json',
        'data/fixtures/explanations/initial-plan.json',
        'data/fixtures/explanations/event-plan.json',
        'docs/operations/quickstart.md', 'docs/development/contributing.md',
    )
    for relative in required:
        checked_path(root, relative)

    files_checked = 0
    for directory in (
        'data/dataset', 'data/object-complexity/dataset',
        'data/fixtures/planning-v2.1',
        'algorithm/artifacts/tz3/home-starts/dataset',
    ):
        dataset = root / directory
        checksums = checked_path(dataset, 'CHECKSUMS.sha256')
        for line in checksums.read_text(encoding='utf-8-sig').splitlines():
            if not line.strip():
                continue
            expected, relative = line.split('  ', 1)
            if digest_file(checked_path(dataset, relative)) != expected:
                raise ValueError(f'Dataset checksum mismatch: {directory}/{relative}')
            files_checked += 1

    bundle = root / 'data/runtime-bundle'
    manifest = json.loads(checked_path(bundle, 'manifest.json').read_text())
    parts_checked = 0
    for resource in manifest['resources']:
        combined = hashlib.sha256()
        byte_count = 0
        for part in resource['parts']:
            file = checked_path(bundle, part['file'])
            if file.stat().st_size != part['bytes'] or digest_file(file, combined) != part['sha256']:
                raise ValueError(f'Runtime part mismatch: {part["file"]}')
            byte_count += file.stat().st_size
            parts_checked += 1
        if byte_count != resource['compressedBytes'] or combined.hexdigest() != resource['sha256']:
            raise ValueError(f'Runtime stream mismatch: {resource["id"]}')

    homes = root / 'algorithm/artifacts/tz3/home-starts'
    home_manifest = json.loads(checked_path(homes, 'manifest.json').read_text())
    for name, key in (('initial-exact.json.gz', 'rawFileSha256'), ('input.json.gz', 'inputFileSha256')):
        raw = gzip.decompress(checked_path(homes, name).read_bytes())
        if hashlib.sha256(raw).hexdigest() != home_manifest[key]:
            raise ValueError(f'Home-start resource mismatch: {name}')

    return {'status': 'OK', 'datasetFiles': files_checked, 'runtimeParts': parts_checked}


if __name__ == '__main__':
    print(json.dumps(verify_repository(ROOT), ensure_ascii=False))
