"""Independently check a screening plan without querying a route provider."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from beeline_planning import (
    build_master_model_input,
    load_planning_dataset,
    load_screening_matrices,
    validate_screening_solution,
)
from beeline_planning.export import load_master_solution


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--screening-root', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    args = parser.parse_args()

    dataset = load_planning_dataset(args.dataset, args.scenario)
    screening = load_screening_matrices(args.screening_root, dataset)
    master = build_master_model_input(dataset, screening)
    solution = load_master_solution(args.candidate)
    violations = validate_screening_solution(dataset, master, solution)
    print(json.dumps({
        'status': 'VALID' if not violations else 'INVALID',
        'planning_date': dataset.planning_date,
        'served_jobs': sum(len(route.visits) for route in solution.routes),
        'unserved_jobs': len(solution.unserved_job_ids),
        'used_engineers': len(solution.routes),
        'violations': violations,
        'exact_routing_validated': False,
    }, ensure_ascii=False))
    return int(bool(violations))


if __name__ == '__main__':
    raise SystemExit(main())
