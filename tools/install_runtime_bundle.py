"""Install the checksummed, portable road/transit resources without copying operational DBs."""
from __future__ import annotations
import argparse
from contextlib import closing
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {'roads': 'docker-data/valhalla/valhalla_tiles.tar', 'transit-index': 'data/transit/moscow_2026-08-17.sqlite'}

def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): value.update(block)
    return value.hexdigest()

def inside(root, relative):
    if '\\' in relative or ':' in relative or relative.startswith('/'):
        raise ValueError('Unsafe runtime path: ' + relative)
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()): raise ValueError('Runtime path escapes its root')
    return target

class PartReader(io.RawIOBase):
    def __init__(self, files):
        super().__init__(); self.files = iter(files); self.current = None
    def readable(self): return True
    def readinto(self, buffer):
        while True:
            if self.current is None:
                try: self.current = next(self.files).open('rb')
                except StopIteration: return 0
            count = self.current.readinto(buffer)
            if count: return count
            self.current.close(); self.current = None
    def close(self):
        if self.current: self.current.close()
        super().close()

def verified_parts(bundle, resource):
    total = hashlib.sha256(); files = []
    for part in resource['parts']:
        file = inside(bundle, part['file']); current = hashlib.sha256()
        if not file.is_file() or file.stat().st_size != part['bytes']: raise ValueError('Missing/incomplete runtime part: ' + part['file'])
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''): current.update(block); total.update(block)
        if current.hexdigest() != part['sha256']: raise ValueError('Runtime part checksum mismatch: ' + part['file'])
        files.append(file)
    if total.hexdigest() != resource['sha256']: raise ValueError('Runtime resource checksum mismatch')
    return files

def database_counts(file, expected):
    with closing(sqlite3.connect(file.as_uri() + '?mode=ro', uri=True)) as db:
        return all(db.execute('SELECT count(*) FROM "' + table.replace('"','""') + '"').fetchone()[0] == count for table, count in expected.items())

def install(root, bundle):
    manifest = json.loads((bundle / 'manifest.json').read_text(encoding='utf-8'))
    if manifest['schemaVersion'] != 1: raise ValueError('Unsupported runtime manifest')
    resources = manifest['resources']
    if {item['id'] for item in resources} != {'roads','transit-index','transit-sources'}: raise ValueError('Unexpected runtime resources')
    # Verify the entire delivery before writing any installed resource.
    parts = {item['id']: verified_parts(bundle, item) for item in resources}
    receipt_path = root / 'runtime/runtime-installation.json'
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    installed = receipt.get('resources', {})
    for item in resources:
        name = item['id']; kind = item['kind']
        if name in TARGETS and item['target'] != TARGETS[name]: raise ValueError('Unexpected runtime target')
        target = inside(root, item['target'])
        if name == 'roads' and target.exists() and digest(target) == item['contentSha256']:
            installed[name] = item['sha256']; print(name + ': verified existing graph', flush=True); continue
        if name == 'transit-index' and target.exists():
            if (installed.get(name) == item['sha256'] or item.get('sourceDatabaseSha256') == digest(target)) and database_counts(target, item['tableCounts']):
                installed[name] = item['sha256']; print(name + ': verified existing public timetable', flush=True); continue
            raise ValueError('Existing transit index is preserved. Install into a clean checkout or use its existing verified runtime.')
        raw = io.BufferedReader(PartReader(parts[name]))
        with raw, gzip.GzipFile(fileobj=raw) as source:
            if kind == 'file':
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists(): raise ValueError('Existing road graph differs; preserved: ' + str(target))
                with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temp:
                    temporary = Path(temp.name); check = hashlib.sha256(); count = 0
                    for block in iter(lambda: source.read(1024 * 1024), b''): temp.write(block); check.update(block); count += len(block)
                if count != item['bytes'] or check.hexdigest() != item['contentSha256']: temporary.unlink(); raise ValueError('Unpacked graph checksum mismatch')
                os.replace(temporary, target)
                if 'mtime' in item: os.utime(target,(item['mtime'],item['mtime']))
            elif kind == 'sqlite-sql':
                target.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryDirectory(dir=target.parent) as temporary:
                    candidate = Path(temporary) / 'index.sqlite'; check = hashlib.sha256(); count = 0
                    with closing(sqlite3.connect(candidate, isolation_level=None)) as db:
                        db.execute('PRAGMA journal_mode=OFF'); db.execute('PRAGMA synchronous=OFF'); statement = ''
                        for line in io.TextIOWrapper(source, encoding='utf-8'):
                            data = line.encode('utf-8'); check.update(data); count += len(data); statement += line
                            if sqlite3.complete_statement(statement): db.execute(statement); statement = ''
                        if statement.strip(): raise ValueError('Incomplete public timetable SQL')
                        if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok': raise ValueError('Transit index integrity failed')
                    if count != item['bytes'] or check.hexdigest() != item['contentSha256'] or not database_counts(candidate, item['tableCounts']): raise ValueError('Public timetable export checksum/count mismatch')
                    os.replace(candidate, target)
            elif kind == 'tar' and name == 'transit-sources':
                with tarfile.open(fileobj=source, mode='r|') as archive:
                    for member in archive:
                        path = member.name
                        if not (path.startswith('offline-assets/transit-sources/gtfs/') and path.endswith('.txt') or path == 'offline-assets/transit-sources/metro/schema.json') or not member.isfile(): raise ValueError('Unexpected transit archive member: ' + path)
                        destination = inside(root, path); destination.parent.mkdir(parents=True, exist_ok=True)
                        with archive.extractfile(member) as incoming, tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temp:
                            temporary = Path(temp.name)
                            for block in iter(lambda: incoming.read(1024 * 1024), b''): temp.write(block)
                        if destination.exists():
                            same = digest(destination) == digest(temporary); temporary.unlink()
                            if not same: raise ValueError('Existing transit source differs; preserved: ' + path)
                        else: os.replace(temporary, destination)
            else: raise ValueError('Unknown runtime resource kind')
        installed[name] = item['sha256']
        # Persist completed stages so interrupted installation is safely repeatable.
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        receipt_path.write_text(json.dumps({'id':manifest['id'],'resources':installed},indent=2)+'\n')
        print(name + ': installed and verified', flush=True)
    config_path = root / 'docker-data/valhalla/valhalla.json'
    if not config_path.exists():
        config = json.loads((root / 'runtime/valhalla-runtime.json').read_text())
        config['mjolnir']['tile_extract'] = '/custom_files/valhalla_tiles.tar'
        config['mjolnir']['tile_dir'] = '/custom_files/valhalla_tiles'
        config_path.write_text(json.dumps(config, indent=2)+'\n')
    rail_installer = root / 'algorithm/tools/install_weekly_rail_snapshots.py'
    if rail_installer.exists() and not (root/'offline-assets/transit-sources/rail/manifest.json').exists():
        subprocess.run([sys.executable, str(rail_installer), '--destination', str(root/'offline-assets/transit-sources/rail')], check=True)
    print(json.dumps({'status':'READY','runtime':manifest['id'],'operationalDatabasesCopied':False}),flush=True)
    return manifest

def stage_docker_resources(root, roads, transit, sources):
    """Use Linux volumes for mmap/SQLite reads; Windows bind mounts are much slower."""
    def copy(source, destination):
        if source.is_symlink(): raise ValueError('Symlinks are not public runtime files')
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_file() and source.stat().st_size == destination.stat().st_size and digest(source) == digest(destination):
            os.chmod(destination, 0o644)
            os.utime(destination, ns=(source.stat().st_atime_ns, source.stat().st_mtime_ns)); return
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temp:
            temporary = Path(temp.name)
        try:
            shutil.copy2(source, temporary)
            if digest(source) != digest(temporary): raise ValueError('Docker routing copy checksum mismatch')
            os.replace(temporary, destination)
            os.chmod(destination, 0o644)
        finally:
            if temporary.exists(): temporary.unlink()
    copy(root / TARGETS['roads'], roads / 'valhalla_tiles.tar')
    for suffix in ['.sqlite', '.manifest.json', '.surface_walk_transfers.json', '.walk_transfers.json']:
        copy(root / ('data/transit/moscow_2026-08-17' + suffix), transit / ('moscow_2026-08-17' + suffix))
    source_root = root / 'offline-assets/transit-sources'
    for directory in ['gtfs', 'metro', 'rail']:
        for source in sorted((source_root / directory).rglob('*')):
            if source.is_file(): copy(source, sources / source.relative_to(source_root))
    print('Docker Linux routing volumes: copied and verified (no operational database)', flush=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--root', type=Path, default=ROOT); parser.add_argument('--bundle', type=Path)
    parser.add_argument('--stage-docker-volumes', action='store_true')
    args = parser.parse_args(); root = args.root.resolve(); bundle = (args.bundle or root/'data/runtime-bundle').resolve()
    try:
        install(root,bundle)
        if args.stage_docker_volumes:
            stage_docker_resources(root, Path('/portable-roads'), Path('/portable-transit'), Path('/portable-sources'))
    except (OSError, ValueError, sqlite3.Error, tarfile.TarError, subprocess.CalledProcessError) as issue:
        print(json.dumps({'status':'UNAVAILABLE','error':str(issue)}),flush=True); return 2
    return 0
if __name__ == '__main__': raise SystemExit(main())
