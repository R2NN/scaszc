"""Prepare an isolated workload benchmark from a synthetic analytics-history day.

The source routing date is deliberately retained: this benchmarks computation,
not the historical day's transit timetable or the validity of its published plan.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from collections import Counter
from pathlib import Path


def _read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open('r', encoding='utf-8-sig', newline='') as source:
        reader = csv.DictReader(source, delimiter=';')
        return list(reader.fieldnames or ()), list(reader)


def _write_csv(path: Path, fields: list[str], rows: list[dict[str, str]]) -> None:
    with path.open('w', encoding='utf-8-sig', newline='') as target:
        writer = csv.DictWriter(target, fieldnames=fields, delimiter=';')
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dataset', type=Path, required=True)
    parser.add_argument('--history', type=Path, required=True)
    parser.add_argument('--history-date', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()

    history = json.loads(args.history.read_text(encoding='utf-8'))
    day = next((day for day in history['days'] if day['date'] == args.history_date), None)
    if day is None:
        parser.error(f'Date {args.history_date} is missing from analytics history')
    selected_ids = {order['sourceId'] for order in day['orders']}
    available_ids = {engineer['id'] for engineer in day['team']}
    if len(selected_ids) != len(day['orders']):
        parser.error('Analytics day has duplicate source job IDs')
    if args.output.exists():
        parser.error('Output already exists; choose a fresh benchmark directory')

    shutil.copytree(args.source_dataset, args.output)
    all_engineer_fields, all_engineers = _read_csv(args.output / 'common' / 'engineers.csv')
    if not available_ids <= {row['engineer_id'] for row in all_engineers}:
        raise ValueError('Analytics day references an unknown engineer')
    for row in all_engineers:
        row['is_available'] = 'true' if row['engineer_id'] in available_ids else 'false'
    _write_csv(args.output / 'common' / 'engineers.csv', all_engineer_fields, all_engineers)

    zone_counts: Counter[str] = Counter()
    for scenario in ('core', 'stress'):
        directory = args.output / scenario
        fields, jobs = _read_csv(directory / 'jobs.csv')
        jobs = [row for row in jobs if row['job_id'] in selected_ids]
        if {row['job_id'] for row in jobs} != selected_ids:
            raise ValueError(f'{scenario} is missing selected history jobs')
        if scenario == 'core':
            zone_counts.update(row['zone_id'] for row in jobs)
        _write_csv(directory / 'jobs.csv', fields, jobs)
        for name in ('events.csv', 'commitments.csv'):
            source = directory / name
            if source.is_file():
                csv_fields, _ = _read_csv(source)
                _write_csv(source, csv_fields, [])

        snapshot_path = directory / 'dataset.json'
        snapshot = json.loads(snapshot_path.read_text(encoding='utf-8'))
        snapshot['jobs'] = [job for job in snapshot['jobs'] if job['job_id'] in selected_ids]
        snapshot['events'] = []
        snapshot['commitments'] = []
        for engineer in snapshot['engineers']:
            engineer['is_available'] = engineer['engineer_id'] in available_ids
        snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    manifest_path = args.output / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest['source_job_counts'] = dict(zone_counts)
    manifest['scenario_counts'] = {
        'core_jobs_total': len(selected_ids),
        'stress_jobs_total': len(selected_ids),
        'engineers': len(all_engineers),
    }
    manifest['stress_expected_result'] = 'Not applicable to workload benchmark'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    provenance = {
        'history_date': args.history_date,
        'history_kind': 'SYNTHETIC_UNOPTIMIZED',
        'workload_jobs': len(selected_ids),
        'available_engineers': len(available_ids),
        'routing_date': manifest['planning_date'],
        'limitation': 'Routing uses the source date timetable; this is a runtime benchmark, not an exact historical plan.',
    }
    (args.output.parent / 'benchmark-provenance.json').write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    print(json.dumps(provenance, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
