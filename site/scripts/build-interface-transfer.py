"""Build a small, secret-free BeeGo interface/API transfer archive.

Unlike build-portable-archive.py this deliberately excludes the former
algorithm, model binaries and Valhalla map tiles. Python is only needed on
the packaging PC; the receiving PC only needs Node.js.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import sqlite3
import sys
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NAME = "BeeGo_INTERFACE_TRANSFER_2026-09-28"
FILES = (
    ".dev.vars.example",
    ".npmrc",
    ".openai/hosting.json",
    "index.html",
    "package.json",
    "package-lock.json",
    "vite.config.mjs",
    "START_INTERFACE.ps1",
    "STOP_INTERFACE.ps1",
    "INTERFACE_TRANSFER_RU.md",
    "scripts/dev-api.mjs",
    "scripts/prepare-sites-build.mjs",
    "scripts/backup-shifts.mjs",
    "scripts/build-interface-transfer.py",
)
DIRECTORIES = (
    "src",
    "public",
    "worker",
    "server",
    "docs",
    "tests",
    "dist/client",
    "dist/server",
    "dist/.openai",
)
EXCLUDE_NAMES = {".dev.vars", ".DS_Store", "Thumbs.db"}
EXCLUDE_PARTS = {"__pycache__", ".vite", ".pytest_cache"}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".log", ".tmp", ".partial"}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def selected() -> list[tuple[str, Path]]:
    result: list[tuple[str, Path]] = []
    for item in FILES:
        path = ROOT / item
        if not path.is_file():
            raise FileNotFoundError(f"Required file is absent: {item}")
        result.append((item, path))
    for directory in DIRECTORIES:
        base = ROOT / directory
        if not base.is_dir():
            raise FileNotFoundError(f"Required directory is absent: {directory}; run npm run build first")
        for path in sorted(base.rglob("*")):
            relative = path.relative_to(ROOT)
            if path.is_file() and not any(part in EXCLUDE_PARTS for part in relative.parts) and path.name not in EXCLUDE_NAMES and path.suffix.lower() not in EXCLUDE_SUFFIXES:
                result.append((relative.as_posix(), path))
    return sorted(result)


def prevent_embedded_secrets(files: list[tuple[str, Path]]) -> None:
    secret_file = ROOT / ".dev.vars"
    if not secret_file.is_file():
        return
    candidates = []
    for raw in secret_file.read_text(encoding="utf-8-sig").splitlines():
        if "=" not in raw or raw.lstrip().startswith("#"):
            continue
        key, value = raw.split("=", 1)
        if key.strip().endswith(("KEY", "TOKEN", "SECRET")) and len(value.strip()) >= 12 and not value.strip().startswith("your_"):
            candidates.append(value.strip().encode("utf-8"))
    for relative, path in files:
        if candidates and any(secret in path.read_bytes() for secret in candidates):
            raise RuntimeError(f"A configured API secret appears in a packaged file: {relative}")


def database_snapshot(target: Path) -> None:
    source = ROOT / ".beego-data/shifts.sqlite3"
    if not source.is_file():
        raise FileNotFoundError("Current shift database is absent: .beego-data/shifts.sqlite3")
    with closing(sqlite3.connect(str(source))) as original, closing(sqlite3.connect(str(target))) as copy:
        original.backup(copy)
        check = copy.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError(f"SQLite snapshot failed integrity check: {check}")
    os.utime(target, None)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT.parent / f"{NAME}.zip")
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    if output.exists():
        raise FileExistsError(f"Output already exists; choose a different --output: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    files = selected()
    prevent_embedded_secrets(files)

    with tempfile.TemporaryDirectory(prefix="beego-transfer-") as temporary:
        snapshot = Path(temporary) / "shifts.sqlite3"
        database_snapshot(snapshot)
        files.append((".beego-data/shifts.sqlite3", snapshot))
        files.sort()

        manifest = io.StringIO()
        manifest.write("sha256\tsize_bytes\tpath\n")
        total = 0
        for relative, path in files:
            size = path.stat().st_size
            manifest.write(f"{digest(path)}\t{size}\t{relative}\n")
            total += size

        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True, strict_timestamps=False) as archive:
            for relative, path in files:
                archive.write(path, f"{NAME}/{relative}")
            archive.writestr(f"{NAME}/PACKAGE_MANIFEST_SHA256.tsv", manifest.getvalue().encode("utf-8"))

    with zipfile.ZipFile(output) as archive:
        broken = archive.testzip()
        if broken:
            raise RuntimeError(f"ZIP CRC failed: {broken}")
        required = {
            f"{NAME}/START_INTERFACE.ps1",
            f"{NAME}/INTERFACE_TRANSFER_RU.md",
            f"{NAME}/.beego-data/shifts.sqlite3",
            f"{NAME}/dist/client/index.html",
            f"{NAME}/public/data/beego-exact-plans.json",
            f"{NAME}/src/App.jsx",
            f"{NAME}/server/operationsApi.mjs",
            f"{NAME}/worker/index.js",
        }
        absent = sorted(required - set(archive.namelist()))
        if absent:
            raise RuntimeError(f"Required ZIP files are absent: {absent}")
        forbidden = [name for name in archive.namelist() if name.endswith("/.dev.vars") or "/node_modules/" in name or "/valhalla-data/" in name or "/algorithm/" in name]
        if forbidden:
            raise RuntimeError(f"Forbidden files entered ZIP: {forbidden[:5]}")

    checksum = digest(output)
    output.with_suffix(output.suffix + ".sha256").write_text(f"{checksum}  {output.name}\n", encoding="ascii")
    print(f"FILES={len(files)} SOURCE_BYTES={total} ZIP_BYTES={output.stat().st_size}")
    print(f"ZIP_CRC=PASS ZIP_SHA256={checksum}")
    print(f"ZIP_PATH={output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR={error}", file=sys.stderr)
        raise
