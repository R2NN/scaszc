from __future__ import annotations

import argparse
import zipfile
from pathlib import Path


ARCHIVE_TIMESTAMP = (2026, 9, 15, 0, 0, 0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('dataset_root', type=Path)
    parser.add_argument('output_archive', type=Path)
    args = parser.parse_args()
    root = args.dataset_root.resolve()
    output = args.output_archive.resolve()
    if output.exists():
        raise SystemExit(f'Output archive already exists: {output}')
    if not root.is_dir():
        raise SystemExit(f'Dataset root does not exist: {root}')

    with zipfile.ZipFile(
        output,
        mode='x',
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:
        for path in sorted(root.rglob('*')):
            if not path.is_file():
                continue
            relative = Path(root.name) / path.relative_to(root)
            info = zipfile.ZipInfo(relative.as_posix(), ARCHIVE_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)


if __name__ == '__main__':
    main()
