from __future__ import annotations

import argparse
import hashlib
import zipfile
from pathlib import Path


PROJECT = Path(__file__).parents[1]
REPOSITORY = PROJECT.parent
PREFIX = 'LCT2_ALGORITHM_UI_HANDOFF'
EXCLUDED_PARTS = {'__pycache__', '.pytest_cache', '.mypy_cache'}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _tree(source: Path, destination: str):
    for path in sorted(source.rglob('*')):
        if not path.is_file():
            continue
        relative = path.relative_to(source)
        if any(part in EXCLUDED_PARTS for part in relative.parts):
            continue
        if path.name in {'.env', '.env.routing.local'}:
            continue
        yield path, f'{destination}/{relative.as_posix()}'


def _inputs() -> list[tuple[Path, str]]:
    files: list[tuple[Path, str]] = []
    for name in (
        'pyproject.toml', '.env.routing.example', 'algorithm_spec_draft.md',
        'mathematical_model.md', 'routing_README.md', 'INTEGRATION_HANDOFF.md',
        'INTERFACE_API_CONTRACT.md', 'NEW_DATA_RUNBOOK.md',
        'CODEX_INTEGRATION_PROMPT.md',
    ):
        files.append((PROJECT / name, name))
    for directory in ('src', 'tools', 'tests', 'handoff_assets', 'original_inputs'):
        files.extend(_tree(PROJECT / directory, directory))
    files.extend(_tree(
        PROJECT / 'work/dataset_v21/beeline_synthetic_dataset_v2_1',
        'work/dataset_v21/beeline_synthetic_dataset_v2_1',
    ))
    for name in (
        'normatives-exact-improved-explained-v2.json',
        'normatives-event-001-explained-v2.json',
        'counterfactual-EAST-EVENT-001-to-EAST-ENG-01.json',
        'counterfactual-EAST-EVENT-001-to-SOUTHEAST-ENG-01.json',
        'counterfactual-frozen-EAST-10245-to-EAST-ENG-01.json',
    ):
        files.append((PROJECT / 'work/planning' / name, f'work/planning/{name}'))
    files.append((
        PROJECT / 'work/integration-handoff/current-dataset-validation.json',
        'work/integration-handoff/current-dataset-validation.json',
    ))
    for suffix in ('.sqlite', '.manifest.json', '.surface_walk_transfers.json', '.walk_transfers.json'):
        source = PROJECT / 'work/transit' / f'moscow_2026-08-17{suffix}'
        files.append((source, f'work/transit/{source.name}'))
    files.extend(_tree(
        PROJECT / 'work/transit_normal_weekday_mcc_v2',
        'offline-assets/transit-sources/rail',
    ))
    files.extend(_tree(REPOSITORY / 'gtfs-inspect', 'offline-assets/transit-sources/gtfs'))
    files.append((
        REPOSITORY / 'research/mosmetro-api/schema.json',
        'offline-assets/transit-sources/metro/schema.json',
    ))
    for name in (
        'valhalla.json', 'valhalla_tiles.tar', 'admins.sqlite',
        'timezones.sqlite', 'default_speeds.json', 'file_hashes.txt',
    ):
        files.append((
            REPOSITORY / 'valhalla-data' / name,
            f'offline-assets/valhalla-data/{name}',
        ))
    return files


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Build the complete secret-free algorithm/UI integration handoff ZIP.'
    )
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        parser.error('Output already exists; choose a new ZIP path')
    entries = _inputs()
    missing = [str(path) for path, _ in entries if not path.is_file()]
    if missing:
        raise FileNotFoundError('Missing handoff inputs:\n' + '\n'.join(missing))
    destinations = [destination for _, destination in entries]
    if len(destinations) != len(set(destinations)):
        raise RuntimeError('Duplicate destination path in handoff package')
    total = sum(path.stat().st_size for path, _ in entries)
    print(f'FILES={len(entries)} SOURCE_BYTES={total}', flush=True)
    manifest = ['sha256\tsize_bytes\tpath']
    output.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    next_report = 256 * 1024 * 1024
    with zipfile.ZipFile(
        output, 'w', compression=zipfile.ZIP_DEFLATED,
        compresslevel=1, allowZip64=True,
    ) as archive:
        for path, destination in entries:
            digest = _sha256(path)
            size = path.stat().st_size
            manifest.append(f'{digest}\t{size}\t{destination}')
            archive.write(path, f'{PREFIX}/{destination}')
            written += size
            if written >= next_report:
                print(f'PACKED_SOURCE_BYTES={written}/{total}', flush=True)
                next_report += 256 * 1024 * 1024
        manifest_text = '\n'.join(manifest) + '\n'
        archive.writestr(
            f'{PREFIX}/PACKAGE_CONTENTS_SHA256.tsv',
            manifest_text.encode('utf-8'),
        )
    with zipfile.ZipFile(output, 'r') as archive:
        bad = archive.testzip()
        names = archive.namelist()
    if bad is not None:
        raise RuntimeError(f'ZIP CRC failure: {bad}')
    if f'{PREFIX}/INTEGRATION_HANDOFF.md' not in names:
        raise RuntimeError('ZIP entrypoint is missing')
    digest = _sha256(output)
    checksum = output.with_suffix(output.suffix + '.sha256')
    checksum.write_text(f'{digest}  {output.name}\n', encoding='ascii')
    print(f'ZIP_FILES={len(names)}', flush=True)
    print(f'ZIP_BYTES={output.stat().st_size}', flush=True)
    print('ZIP_CRC=PASS', flush=True)
    print(f'ZIP_SHA256={digest}', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
