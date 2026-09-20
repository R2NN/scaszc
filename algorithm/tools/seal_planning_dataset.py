from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            'Recalculate CHECKSUMS.sha256 after authorized replacement of data '
            'inside an existing schema-2.1.0 dataset template.'
        )
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Checksum replacement requires explicit --execute')
    root = args.dataset.resolve()
    checksum_path = root / 'CHECKSUMS.sha256'
    if not checksum_path.is_file():
        parser.error('The dataset must start from a template with CHECKSUMS.sha256')
    relative_paths = []
    for line_number, line in enumerate(
        checksum_path.read_text(encoding='utf-8').splitlines(), 1
    ):
        if not line.strip():
            continue
        parts = line.split('  ', 1)
        if len(parts) != 2:
            parser.error(f'Invalid existing checksum line {line_number}')
        relative = Path(parts[1])
        if relative.is_absolute() or '..' in relative.parts:
            parser.error(f'Unsafe checksum target at line {line_number}')
        target = root / relative
        if not target.is_file():
            parser.error(f'Missing template file: {relative.as_posix()}')
        relative_paths.append(relative)
    lines = [
        f'{_sha256(root / relative)}  {relative.as_posix()}'
        for relative in sorted(relative_paths, key=lambda item: item.as_posix())
    ]
    checksum_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'SEALED={checksum_path} FILES={len(lines)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
