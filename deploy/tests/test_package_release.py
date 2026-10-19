"""Keep every checksummed dataset reproducible when packaging Git blobs."""

import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'package_release', Path(__file__).resolve().parents[1] / 'package_release.py',
)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseDatasetTests(unittest.TestCase):
    def test_collects_current_and_fixture_manifests(self):
        roots = ('data/dataset', 'data/object-complexity/dataset', 'data/fixtures/planning-v2.1')
        entries = '\n'.join(f'{root}/CHECKSUMS.sha256' for root in roots).encode()
        manifest = f'{"a" * 64}  common/engineers.csv\n'.encode()

        def git(*args):
            return entries if args[0] == 'ls-tree' else manifest

        with patch.object(release, 'git', side_effect=git):
            expected = release.canonical_dataset_files()
        self.assertEqual(set(expected), {f'{root}/common/engineers.csv' for root in roots})

    def test_restores_fixture_crlf_from_normalized_git_blob(self):
        original = b'id;shift\r\nENG-1;08:00\r\n'
        name = 'data/fixtures/planning-v2.1/common/engineers.csv'
        expected = {name: hashlib.sha256(original).hexdigest()}
        self.assertEqual(release.checked_dataset_bytes(name, original.replace(b'\r\n', b'\n'), expected), original)

    def test_rejects_changed_data_instead_of_rewriting_checksum(self):
        name = 'data/fixtures/planning-v2.1/core/jobs.csv'
        expected = {name: hashlib.sha256(b'original\n').hexdigest()}
        with self.assertRaisesRegex(ValueError, 'checksum cannot be restored'):
            release.checked_dataset_bytes(name, b'changed\n', expected)

    def test_leaves_unlisted_source_bytes_untouched(self):
        self.assertEqual(release.checked_dataset_bytes('site/src/App.jsx', b'a\r\nb\n', {}), b'a\r\nb\n')


if __name__ == '__main__':
    unittest.main()
