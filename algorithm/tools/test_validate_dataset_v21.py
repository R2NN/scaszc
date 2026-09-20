from __future__ import annotations

import argparse
import csv
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

from prepare_dataset_v2 import write_checksums


Mutation = Callable[[Path], None]


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def save_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def mutate_policy(root: Path, change: Callable[[dict], None]) -> None:
    policy_path = root / 'common' / 'constraint_policies.json'
    policy = load_json(policy_path)
    change(policy)
    save_json(policy_path, policy)

    for scenario in ('core', 'stress'):
        dataset_path = root / scenario / 'dataset.json'
        dataset = load_json(dataset_path)
        dataset['constraint_policies'] = policy
        save_json(dataset_path, dataset)


def add_soft_hard_commitment(root: Path) -> None:
    def change(policy: dict) -> None:
        policy['objective_contract']['initial_planning'].insert(
            2,
            {'tier': 3, 'sense': 'MIN', 'metric': 'hard_commitment_violations'},
        )

    mutate_policy(root, change)


def add_lateness_metric(root: Path) -> None:
    def change(policy: dict) -> None:
        policy['objective_contract']['initial_planning'].insert(
            2,
            {'tier': 3, 'sense': 'MIN', 'metric': 'total_lateness_minutes'},
        )

    mutate_policy(root, change)


def remove_required_distance_metric(root: Path) -> None:
    def change(policy: dict) -> None:
        policy['required_report_metrics'].remove('total_distance_m')

    mutate_policy(root, change)


def add_synthetic_traffic_multiplier(root: Path) -> None:
    path = root / 'common' / 'traffic_profiles.csv'
    with path.open('r', encoding='utf-8-sig', newline='') as file:
        rows = list(csv.DictReader(file, delimiter=';'))
    fieldnames = [*rows[0], 'multiplier']
    for row in rows:
        row['multiplier'] = '1.45' if row['transport_type'] == 'CAR' else '1'
    with path.open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames, delimiter=';', lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)


def make_inventory_ambiguous(root: Path) -> None:
    mutate_policy(
        root,
        lambda policy: policy['inventory_semantics'].__setitem__(
            'not_started_reservations_on_replan', 'KEEP_RESERVED'
        ),
    )


def move_activity_start_to_service(root: Path) -> None:
    mutate_policy(
        root,
        lambda policy: policy['replanning_semantics'].__setitem__(
            'activity_start', 'SERVICE_START'
        ),
    )


def make_window_end_exclusive(root: Path) -> None:
    mutate_policy(
        root,
        lambda policy: policy['hard_constraints'].__setitem__(
            'time_window_interval', 'LEFT_CLOSED_RIGHT_OPEN'
        ),
    )


def merge_unknown_with_unreachable(root: Path) -> None:
    mutate_policy(
        root,
        lambda policy: policy['route_semantics'].__setitem__(
            'unknown_route', 'FORBID_ARC'
        ),
    )


MUTATIONS: dict[str, Mutation] = {
    'hard_commitment_as_soft_metric': add_soft_hard_commitment,
    'lateness_as_soft_metric': add_lateness_metric,
    'missing_distance_metric': remove_required_distance_metric,
    'synthetic_traffic_multiplier': add_synthetic_traffic_multiplier,
    'ambiguous_inventory_reservation': make_inventory_ambiguous,
    'activity_starts_at_service': move_activity_start_to_service,
    'exclusive_window_end': make_window_end_exclusive,
    'unknown_equals_unreachable': merge_unknown_with_unreachable,
}


def run_validator(validator: Path, dataset: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(validator), str(dataset)],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        check=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('dataset_root', type=Path)
    parser.add_argument('validator', type=Path)
    args = parser.parse_args()

    source = args.dataset_root.resolve()
    validator = args.validator.resolve()
    base_result = run_validator(validator, source)
    if base_result.returncode != 0:
        raise SystemExit('Base dataset must pass before mutation tests')

    passed = 0
    with tempfile.TemporaryDirectory(prefix='beeline-v21-mutations-') as temp_dir:
        temp_root = Path(temp_dir)
        for name, mutation in MUTATIONS.items():
            case_root = temp_root / name
            shutil.copytree(source, case_root)
            mutation(case_root)
            write_checksums(case_root)
            result = run_validator(validator, case_root)
            if result.returncode == 0:
                print(f'FAIL: validator accepted mutation {name}')
                continue
            passed += 1
            print(f'PASS: validator rejected mutation {name}')

    print(f'RESULT: {passed}/{len(MUTATIONS)} mutations rejected')
    raise SystemExit(0 if passed == len(MUTATIONS) else 1)


if __name__ == '__main__':
    main()
