from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
import zipfile
from datetime import date, timedelta
from pathlib import Path

from algorithm.tools.install_weekly_rail_snapshots import install


class WeeklyRailInstallTests(unittest.TestCase):
    def make_archive(self, path: Path, *, corrupt: bool = False) -> None:
        source = 'offline-assets/transit-sources/rail/'
        files = {source + name: b'base' for name in (
            'manifest.json', 'rail_schedule.json', 'rail_station_map.json',
            'yandex_stations.json')}
        tuesday = date(2026, 9, 29)
        for offset in range(6):
            day = (tuesday + timedelta(days=offset)).isoformat()
            folder = source + f'dates/{day}/'
            files[folder + 'manifest.json'] = json.dumps({
                'source_date': day, 'schedule_scope': 'exact_date',
                'coverage_complete': True,
            }).encode()
            for name in ('rail_schedule.json', 'rail_station_map.json', 'yandex_stations.json'):
                files[folder + name] = f'{day}:{name}'.encode()
        sums = ['sha256\tsize_bytes\tpath']
        for name, contents in files.items():
            sums.append(f'{hashlib.sha256(contents).hexdigest()}\t{len(contents)}\t{name}')
        with zipfile.ZipFile(path, 'w') as archive:
            prefix = 'bundle/'
            archive.writestr(prefix + 'SHA256SUMS.tsv', '\n'.join(sums))
            for name, contents in files.items():
                archive.writestr(prefix + name, b'wrong' if corrupt and name.endswith(
                    'dates/2026-09-29/rail_schedule.json') else contents)

    def test_install_is_complete_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'week.zip'
            destination = root / 'rail'
            self.make_archive(archive)
            self.assertEqual(len(install(archive, destination)), 10)
            self.assertEqual(install(archive, destination), [])
            self.assertTrue((destination / 'dates' / '2026-09-29' / 'rail_schedule.json').is_file())
            self.assertEqual(len(list((destination / 'dates').iterdir())), 6)

    def test_rejects_corrupt_archive_without_installing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'week.zip'
            destination = root / 'rail'
            self.make_archive(archive, corrupt=True)
            with self.assertRaisesRegex(ValueError, 'Контрольная сумма'):
                install(archive, destination)
            self.assertFalse(destination.exists())

    def test_preserves_different_existing_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'week.zip'
            destination = root / 'rail'
            self.make_archive(archive)
            existing = destination / 'dates' / '2026-09-29' / 'rail_schedule.json'
            existing.parent.mkdir(parents=True)
            existing.write_bytes(b'previous')
            with self.assertRaises(FileExistsError):
                install(archive, destination)
            self.assertEqual(existing.read_bytes(), b'previous')
            self.assertFalse((destination / 'dates' / '2026-09-30').exists())


if __name__ == '__main__':
    unittest.main()
