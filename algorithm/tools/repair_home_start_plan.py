"""Reproduce an exact home-start insertion while retaining the other day routes."""
from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from beeline_planning import load_planning_dataset, validate_initial_plan
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import _materialize_route, MaterializationResult, MaterializationStatus
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def main() -> int:
    """Try every insertion position using exact routes and full-plan validation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dataset', type=Path, required=True)
    parser.add_argument('--source-plan', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--engineer', required=True)
    parser.add_argument('--job', required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    original = load_planning_dataset(args.source_dataset, 'core')
    dataset = load_planning_dataset(args.dataset, 'core')
    plan, source = load_exact_plan_artifact(args.source_plan, original.dataset_sha256)
    if not validate_initial_plan(original, plan).is_valid:
        raise ValueError('The original plan must pass independent validation')
    if dataset.jobs != original.jobs or args.job not in plan.unserved_job_ids:
        raise ValueError('Repair must retain the original jobs and target an unassigned job')
    for key, engineer in dataset.engineers.items():
        prior = original.engineers[key]
        if replace(engineer, start_office_id=prior.start_office_id) != prior:
            raise ValueError('Only the day origin may change; staff constraints must remain intact')
    oracle = ExactRoutingOracle(create_route_client(RoutingCache(args.cache),
        'valhalla-local-transit', timeout_seconds=30, max_attempts=2,
        transit_index=args.transit_index, metro_wait_seconds=180))
    route = next(r for r in plan.engineer_plans if r.engineer_id == args.engineer)
    best = None
    checks = []
    exact_queries = 0
    identity_legs = 0
    for position in range(len(route.visits) + 1):
        jobs = [v.job_id for v in route.visits]
        jobs.insert(position, args.job)
        result = _materialize_route(dataset, SimpleNamespace(engineer_id=args.engineer,
            visits=[SimpleNamespace(job_id=key) for key in jobs]), oracle, drop_order_infeasible=False)
        exact_queries += result.exact_queries
        identity_legs += result.identity_legs
        checks.append({'position': position, 'route_feasible': result.plan is not None,
            'failure': str(result.failure) if result.failure else None})
        if result.plan is None:
            continue
        candidate = replace(plan, engineer_plans=tuple(result.plan if r.engineer_id == args.engineer else r for r in plan.engineer_plans),
            unserved_job_ids=tuple(key for key in plan.unserved_job_ids if key != args.job))
        report = validate_initial_plan(dataset, candidate)
        if report.is_valid and (best is None or report.metrics.total_distance_m < best[1].metrics.total_distance_m):
            best = candidate, report
    if best is None:
        raise ValueError('No independently valid coverage improvement found')
    plan, report = best
    raw = materialization_result_dict(MaterializationResult(MaterializationStatus.EXACT_VALID, plan, report, None, exact_queries, identity_legs))
    raw.update(artifact_type='EXACT_INITIAL_PLAN_HOME_STARTS', dataset_sha256=dataset.dataset_sha256,
        source_plan_content_sha256=source['content_sha256'], global_optimality_proven=False,
        search_phase='VERIFIED_BASELINE_REPAIR_WITH_TWO_HOME_STARTS')
    raw['content_sha256'] = payload_sha256(raw)
    write_json_atomic(args.output, raw)
    write_json_atomic(args.output.with_suffix('.search.json'), checks)
    print(json.dumps({'status': raw['status'], 'content_sha256': raw['content_sha256'],
        'unserved': plan.unserved_job_ids}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
