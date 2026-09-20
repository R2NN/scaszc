from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path


NORMATIVES = {
    'Подключение': {'road': 20, 'technical': 60, 'documents': 10},
    'Глобальная проблема': {'road': 20, 'technical': 80, 'documents': 0},
    'Дозаказ': {'road': 20, 'technical': 10, 'documents': 10},
    'Локальная заявка': {'road': 20, 'technical': 30, 'documents': 0},
}

INTEGER_FIELDS = {
    'service_duration_min', 'apply_order', 'quantity', 'quantity_available',
    'max_jobs', 'max_route_minutes', 'road_reference_min', 'technical_minutes',
    'document_minutes',
}
FLOAT_FIELDS = {'latitude', 'longitude'}
BOOLEAN_FIELDS = {
    'is_event_job', 'is_available', 'reusable', 'shared_stock',
    'replenishment_during_day',
}


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open('r', encoding='utf-8-sig', newline='') as file:
        return list(csv.DictReader(file, delimiter=';'))


def write_csv(path: Path, rows: list[dict[str, object]], fieldnames: list[str]) -> None:
    with path.open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames, delimiter=';', lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)


def typed_rows(path: Path) -> list[dict[str, object]]:
    result = []
    for row in read_csv(path):
        typed = {}
        for key, value in row.items():
            if value == '':
                typed[key] = None
            elif key in INTEGER_FIELDS:
                typed[key] = int(value)
            elif key in FLOAT_FIELDS:
                typed[key] = float(value)
            elif key in BOOLEAN_FIELDS:
                typed[key] = value.lower() == 'true'
            else:
                typed[key] = value
        result.append(typed)
    return result


def refresh_dataset_json(root: Path, scenario: str) -> None:
    path = root / scenario / 'dataset.json'
    payload = json.loads(path.read_text(encoding='utf-8'))
    payload['jobs'] = typed_rows(root / scenario / 'jobs.csv')
    payload['work_rules'] = typed_rows(root / 'common' / 'work_rules.csv')
    payload['constraint_policies'] = json.loads(
        (root / 'common' / 'constraint_policies.json').read_text(encoding='utf-8')
    )
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def refresh_checksums(root: Path) -> None:
    checksum_path = root / 'CHECKSUMS.sha256'
    paths = sorted(
        path for path in root.rglob('*')
        if path.is_file() and path != checksum_path
    )
    lines = [
        f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root).as_posix()}'
        for path in paths
    ]
    checksum_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def apply(root: Path) -> None:
    old_rules = {row['hd_type']: row for row in read_csv(root / 'common' / 'work_rules.csv')}
    all_jobs: dict[tuple[str, str], dict[str, str]] = {}
    for scenario in ('core', 'stress'):
        path = root / scenario / 'jobs.csv'
        rows = read_csv(path)
        for row in rows:
            normative = NORMATIVES[row['bk_type']]
            row['service_duration_min'] = str(normative['technical'] + normative['documents'])
            all_jobs[(row['bk_type'], row['hd_type'])] = row
        write_csv(path, rows, list(rows[0]))

    rules = []
    for bk_type, hd_type in sorted(all_jobs):
        normative = NORMATIVES[bk_type]
        old = old_rules[hd_type]
        rules.append({
            'bk_type': bk_type,
            'hd_type': hd_type,
            'road_reference_min': normative['road'],
            'technical_minutes': normative['technical'],
            'document_minutes': normative['documents'],
            'service_duration_min': normative['technical'] + normative['documents'],
            'default_priority': old['default_priority'],
            'equipment_codes': old['equipment_codes'],
            'rule_version': 'v2.2-published-normatives',
            'source': 'Нормативы.xlsx; road replaced by routed travel time',
        })
    write_csv(
        root / 'common' / 'work_rules.csv',
        rules,
        [
            'bk_type', 'hd_type', 'road_reference_min', 'technical_minutes',
            'document_minutes', 'service_duration_min', 'default_priority',
            'equipment_codes', 'rule_version', 'source',
        ],
    )

    policies_path = root / 'common' / 'constraint_policies.json'
    policies = json.loads(policies_path.read_text(encoding='utf-8'))
    policies['service_duration_semantics'] = {
        'source': 'Нормативы.xlsx',
        'arrival_and_service_start': 'WITHIN_CLOSED_CUSTOMER_WINDOW',
        'service_completion_after_window_end': 'ALLOWED_IF_WITHIN_SHIFT',
        'road_reference_minutes': 20,
        'road_reference_usage': 'NOT_ADDED; REPLACED_BY_ROUTER_TRAVEL_TIME',
        'service_duration': 'technical_minutes + document_minutes',
    }
    policies_path.write_text(
        json.dumps(policies, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )

    for scenario in ('core', 'stress'):
        refresh_dataset_json(root, scenario)
    refresh_checksums(root)


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Apply published work normatives without adding the 20-minute road reference.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    args = parser.parse_args()
    apply(args.dataset.resolve())
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
