"""Build a deployment archive from committed Git blobs without newline conversion."""

from __future__ import annotations

import argparse
import hashlib
import io
import subprocess
import tarfile
from pathlib import Path


def git(*args: str) -> bytes:
    return subprocess.check_output(('git', *args))


def canonical_dataset_files() -> dict[str, str]:
    manifest = git('cat-file', 'blob', 'HEAD:data/dataset/CHECKSUMS.sha256')
    return {
        f'data/dataset/{relative}': digest
        for line in manifest.decode('utf-8').splitlines()
        for digest, relative in (line.split('  ', 1),)
        if line
    }


def checked_dataset_bytes(name: str, data: bytes, expected: dict[str, str]) -> bytes:
    digest = expected.get(name)
    if digest is None:
        return data
    candidates = (data, data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))
    for candidate in candidates:
        if hashlib.sha256(candidate).hexdigest() == digest:
            return candidate
    raise ValueError(f'Dataset checksum cannot be restored from Git: {name}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='Destination .tar.gz path')
    arguments = parser.parse_args()
    entries = git('ls-tree', '-rz', 'HEAD').split(b'\0')
    expected_dataset = canonical_dataset_files()
    checked = set()
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with tarfile.open(arguments.output, 'w:gz') as archive:
        for entry in entries:
            if not entry:
                continue
            metadata, raw_path = entry.split(b'\t', 1)
            mode, kind, object_id = metadata.decode('ascii').split()
            if kind != 'blob':
                continue
            data = git('cat-file', 'blob', object_id)
            name = raw_path.decode('utf-8')
            data = checked_dataset_bytes(name, data, expected_dataset)
            if name in expected_dataset:
                checked.add(name)
            info = tarfile.TarInfo(name)
            info.mtime = 0
            if mode == '120000':
                info.type = tarfile.SYMTYPE
                info.linkname = data.decode('utf-8')
                info.mode = 0o777
                archive.addfile(info)
            else:
                info.size = len(data)
                info.mode = 0o755 if mode == '100755' else 0o644
                archive.addfile(info, io.BytesIO(data))
            count += 1
    if checked != set(expected_dataset):
        raise ValueError('Dataset checksum manifest references files missing from the commit')
    print(f'Packaged {count} committed files: {arguments.output}')


if __name__ == '__main__':
    main()
