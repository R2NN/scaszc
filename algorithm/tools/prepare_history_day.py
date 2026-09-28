"""Turn one synthetic history workload into a checksummed, date-specific dataset.

The requests and team come from analytics history. Their addresses, skills,
equipment, durations and windows come from the canonical source dataset.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import date
from pathlib import Path


def prepare(source_dataset: Path, history: Path, history_date: str, output: Path) -> dict:
    target_date = date.fromisoformat(history_date)
    source_manifest = json.loads((source_dataset / 'manifest.json').read_text(encoding='utf-8'))
    source_date = source_manifest['planning_date']
    if history_date == source_date:
        raise ValueError('Historical date must differ from the canonical source date')
    subprocess.run([
        sys.executable, str(Path(__file__).with_name('prepare_history_benchmark.py')),
        '--source-dataset', str(source_dataset), '--history', str(history),
        '--history-date', history_date, '--output', str(output),
    ], check=True, stdout=subprocess.DEVNULL)

    # These reports describe the source day and must not masquerade as checks
    # or execution evidence for the newly generated historical workload.
    for stale in ('validation_report.json', 'audit.csv'):
        (output / stale).unlink(missing_ok=True)

    for file in output.rglob('*'):
        if file.suffix not in {'.csv', '.json'}:
            continue
        contents = file.read_text(encoding='utf-8-sig')
        contents = contents.replace(source_date, history_date)
        if file.name == 'traffic_profiles.csv':
            contents = contents.replace('WEEKDAY', 'WEEKEND' if target_date.weekday() >= 5 else 'WEEKDAY')
            if target_date.weekday() >= 5:
                contents = contents.replace('-WD;', '-WE;')
        if file.name in {'planning_context.json', 'dataset.json'}:
            payload = json.loads(contents)
            context = payload if file.name == 'planning_context.json' else payload['planning_context']
            context['day_type'] = 'WEEKEND' if target_date.weekday() >= 5 else 'WEEKDAY'
            contents = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
        if file.name == 'manifest.json':
            payload = json.loads(contents)
            payload['source'] = 'synthetic_history_from_canonical_workload'
            payload['history_date'] = history_date
            contents = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
        file.write_text(contents, encoding='utf-8-sig' if file.suffix == '.csv' else 'utf-8')

    lines = []
    for file in sorted(output.rglob('*')):
        if file.is_file() and file.name != 'CHECKSUMS.sha256':
            lines.append(f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.relative_to(output).as_posix()}')
    (output / 'CHECKSUMS.sha256').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    provenance_path = output.parent / 'benchmark-provenance.json'
    provenance = json.loads(provenance_path.read_text(encoding='utf-8'))
    provenance.update({
        'history_kind': 'SYNTHETIC_DATE_SPECIFIC_INPUT',
        'routing_date': history_date,
        'limitation': 'Synthetic historical workload; rail may use a same-weekday timetable reference.',
    })
    provenance_path.unlink()
    (output.parent / 'dataset-provenance.json').write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    return provenance


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dataset', type=Path, required=True)
    parser.add_argument('--history', type=Path, required=True)
    parser.add_argument('--history-date', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source_dataset, args.history, args.history_date, args.output), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
