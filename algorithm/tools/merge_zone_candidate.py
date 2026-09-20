from __future__ import annotations

import argparse
from pathlib import Path

from beeline_planning import load_planning_dataset
from beeline_planning.exact_repair import master_from_orders
from beeline_planning.export import (
    load_exact_plan_artifact,
    load_master_solution,
    master_solution_dict,
)
from beeline_routing.export import payload_sha256, write_json_atomic


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Replace one zone in an exact plan with a screening candidate.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--base-exact-plan', type=Path, required=True)
    parser.add_argument('--zone-candidate', type=Path, required=True)
    parser.add_argument('--zone', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()

    dataset = load_planning_dataset(args.dataset, args.scenario)
    base_plan, _ = load_exact_plan_artifact(args.base_exact_plan, dataset.dataset_sha256)
    candidate = load_master_solution(args.zone_candidate)
    if candidate.dataset_sha256 != dataset.dataset_sha256:
        raise ValueError('Zone candidate belongs to another dataset')

    routes: dict[str, tuple[str, ...]] = {
        route.engineer_id: tuple(visit.job_id for visit in route.visits)
        for route in base_plan.engineer_plans
        if dataset.engineers[route.engineer_id].zone_id != args.zone
    }
    for route in candidate.routes:
        engineer = dataset.engineers[route.engineer_id]
        if engineer.zone_id != args.zone:
            raise ValueError(
                f'Candidate route {route.engineer_id} belongs to {engineer.zone_id}, not {args.zone}'
            )
        routes[route.engineer_id] = tuple(visit.job_id for visit in route.visits)

    assigned = [job_id for route in routes.values() for job_id in route]
    if len(assigned) != len(set(assigned)):
        raise ValueError('Merged candidate assigns at least one job more than once')
    expected = {
        job.job_id for job in dataset.active_jobs_at(dataset.initial_planning_at)
    }
    actual = set(assigned)
    unserved = set(candidate.unserved_job_ids)
    if actual & unserved:
        raise ValueError('Merged candidate assigns a job also listed as unserved')
    if actual | unserved != expected:
        raise ValueError(
            f'Merged candidate coverage mismatch: missing={sorted(expected - actual - unserved)}, '
            f'extra={sorted(actual - expected)}'
        )

    merged = master_from_orders(dataset, routes, unserved)
    payload = master_solution_dict(merged)
    payload['merge_provenance'] = {
        'base_exact_plan': str(args.base_exact_plan),
        'zone_candidate': str(args.zone_candidate),
        'replaced_zone': args.zone,
    }
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(
        f'Wrote {args.output}: {len(actual)} jobs, {len(routes)} routes, '
        f'{len(unserved)} unserved (exact validation still required)'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
