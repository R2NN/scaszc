"""Collect and verify an exact-date MCC/MCD timetable, resuming partial work."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

if __package__:
    from .complete_missing_mcc_schedule import MISSING_CODES, build as complete_mcc
else:
    from complete_missing_mcc_schedule import MISSING_CODES, build as complete_mcc


def collect(
    base_rail: Path,
    metro_schema: Path,
    output: Path,
    scenario: date,
    credentials: Path | None,
    max_requests: int = 450,
) -> dict:
    """Save only API-backed trains and mark the snapshot ready after full coverage."""
    if max_requests < 1:
        raise ValueError('max_requests must be positive')
    source_map = json.loads((base_rail / 'rail_station_map.json').read_text(encoding='utf-8'))
    expected_codes = {item['yandex_code'] for item in source_map.values()}
    output.mkdir(parents=True, exist_ok=True)
    for name in ('yandex_stations.json', 'rail_station_map.json'):
        destination = output / name
        if not destination.exists() and (base_rail / name).exists():
            shutil.copyfile(base_rail / name, destination)
    manifest_path = output / 'manifest.json'
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding='utf-8'))
        if (existing.get('source_date') or existing.get('normal_weekday_reference_date')) != scenario.isoformat():
            raise ValueError('Rail output contains a different schedule date')
    script = Path(__file__).with_name('freeze_regular_rail_schedule.py')
    command = [sys.executable, str(script), '--metro-schema', str(metro_schema),
               '--output', str(output), '--date', scenario.isoformat(),
               '--max-requests', str(max_requests)]
    if credentials is not None:
        command.extend(('--credentials', str(credentials)))
    finished = subprocess.run(command, capture_output=True, text=True, check=False)
    if finished.returncode:
        raise RuntimeError(f'Rail collection failed: {(finished.stderr or finished.stdout).strip()}')

    schedules = json.loads((output / 'rail_schedule.json').read_text(encoding='utf-8'))
    missing_regular = expected_codes - set(schedules) - set(MISSING_CODES.values())
    if missing_regular:
        return {'status': 'PARTIAL', 'date': scenario.isoformat(),
                'stations_ready': len(expected_codes & set(schedules)),
                'stations_total': len(expected_codes), 'missing_stations': len(missing_regular)}

    if expected_codes - set(schedules):
        complete_mcc(output, metro_schema, credentials)
        schedules = json.loads((output / 'rail_schedule.json').read_text(encoding='utf-8'))
    missing = expected_codes - set(schedules)
    if missing:
        raise RuntimeError(f'Rail snapshot has {len(missing)} missing station timetables')
    if not any(item.get('entries') for item in schedules.values()):
        raise RuntimeError(f'Yandex Rasp returned no railway departures for {scenario}')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest.update({'source_date': scenario.isoformat(), 'schedule_scope': 'exact_date',
                     'coverage_complete': True, 'station_schedules_frozen': len(schedules)})
    temporary = manifest_path.with_suffix('.tmp.json')
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(manifest_path)
    return {'status': 'COMPLETE', 'date': scenario.isoformat(),
            'stations_ready': len(schedules), 'stations_total': len(expected_codes)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-rail', type=Path, required=True)
    parser.add_argument('--metro-schema', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--date', type=date.fromisoformat, required=True)
    parser.add_argument('--credentials', type=Path)
    parser.add_argument('--max-requests', type=int, default=450)
    args = parser.parse_args()
    report = collect(args.base_rail, args.metro_schema, args.output, args.date,
                     args.credentials, args.max_requests)
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report['status'] == 'COMPLETE' else 3


if __name__ == '__main__':
    raise SystemExit(main())
