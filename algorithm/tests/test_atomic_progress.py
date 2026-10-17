from pathlib import Path
from unittest.mock import patch

import pytest

from beeline_routing.export import write_json_atomic


def test_progress_replace_retries_a_transient_windows_reader_lock(tmp_path):
    output = tmp_path / 'progress.json'
    output.write_text('old', encoding='utf-8')
    replace = Path.replace
    calls = []

    def locked_once(source, target):
        calls.append(target)
        if len(calls) == 1:
            raise PermissionError('reader holds the progress file')
        return replace(source, target)

    with patch.object(Path, 'replace', locked_once), patch('beeline_routing.export.time.sleep'):
        write_json_atomic(output, {'candidates': 2})
    assert len(calls) == 2
    assert '"candidates": 2' in output.read_text(encoding='utf-8')


def test_permanent_progress_write_failure_is_reported(tmp_path):
    with patch.object(Path, 'replace', side_effect=PermissionError('denied')), patch('beeline_routing.export.time.sleep'):
        with pytest.raises(PermissionError):
            write_json_atomic(tmp_path / 'progress.json', {})
