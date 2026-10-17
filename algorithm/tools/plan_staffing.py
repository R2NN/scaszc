"""Bounded exact route elimination and quality-constrained crew composition.

Unchanged routes retain checksummed road evidence. Every changed route is
materialized at its actual departure times and the complete plan is validated.
The result is a sufficient composition found by local search, never a proof of
the city-wide minimum. Missing quality profiles remain explicitly unserved.
"""
from __future__ import annotations
import argparse
import json
import sys
import time
from dataclasses import replace
from collections import defaultdict
from pathlib import Path

from beeline_planning import load_planning_dataset, validate_initial_plan, build_candidate_index
from beeline_planning.exact_repair import master_from_orders
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import MaterializationResult, MaterializationStatus, _materialize_route
from beeline_planning.plan import EngineerPlan
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.oracle import ExactRoutingOracle
from beeline_routing.export import payload_sha256, write_json_atomic
from plan_by_rating import operational_profile


def compact(dataset, plan, locked, oracle, budget=36, seconds=40):
    """Try eliminating a whole crew by inserting all its visits elsewhere."""
    index = build_candidate_index(dataset)
    routes = {r.engineer_id: r for r in plan.engineer_plans if r.visits}
    checks, queries, accepted, incomplete = 0, 0, [], 0
    deadline = time.monotonic() + seconds
    # A failed elimination never leaks its partial insertions into the result.
    for source in sorted(tuple(routes), key=lambda key: (len(routes[key].visits), key)):
        if source in locked or source not in routes or checks >= budget or time.monotonic() >= deadline:
            continue
        trial = dict(routes)
        moved = sorted(trial.pop(source).visits, key=lambda v: (dataset.jobs[v.job_id].window_end, v.job_id))
        success = True
        for visit in moved:
            inserted = False
            job = dataset.jobs[visit.job_id]
            targets = sorted((key for key in trial if key not in locked and key in index.eligible_engineers_by_job[job.job_id]),
                             key=lambda key: (len(trial[key].visits), key))
            for target in targets:
                old = tuple(v.job_id for v in trial[target].visits)
                if len(old) >= dataset.engineers[target].max_jobs:
                    continue
                for position in range(len(old) + 1):
                    order = old[:position] + (job.job_id,) + old[position:]
                    # Zero-travel window rejection avoids spending road queries
                    # on sequences which cannot fit even without movement.
                    moment = max(plan.planning_at, dataset.engineers[target].shift_start)
                    possible = True
                    from datetime import timedelta
                    for identifier in order:
                        item = dataset.jobs[identifier]
                        moment = max(moment, item.window_start)
                        if moment > item.window_end:
                            possible = False
                            break
                        moment += timedelta(minutes=item.service_duration_min)
                    if not possible or moment > dataset.engineers[target].shift_end:
                        continue
                    if checks >= budget or time.monotonic() >= deadline:
                        break
                    checks += 1
                    print(json.dumps({'type':'progress','phase':'COMPACTING_TEAM','routeChecks':checks,'bestTeam':len(routes)}), flush=True)
                    master = master_from_orders(dataset, {target: order}, set())
                    result = _materialize_route(dataset, master.routes[0], oracle, drop_order_infeasible=False)
                    queries += result.exact_queries
                    if result.plan is None:
                        incomplete += int(result.failure_status == MaterializationStatus.ROUTING_INCOMPLETE)
                        continue
                    trial[target] = result.plan
                    inserted = True
                    break
                if inserted:
                    break
            if not inserted:
                success = False
                break
        if success:
            proposed = replace(plan, engineer_plans=tuple(trial.values()))
            if validate_initial_plan(dataset, proposed).is_valid:
                routes = trial
                plan = proposed
                accepted.append(source)
    return plan, {'routeChecks': checks, 'providerQueries': queries, 'eliminated': accepted, 'routingIncomplete': incomplete,
                  'budgetReached': checks >= budget or time.monotonic() >= deadline,
                  'globalMinimumProven': False}


def compose(dataset, plan, candidates, floor, locked, ceiling=5):
    engineers = dict(dataset.engineers)
    available = defaultdict(list)
    lookup = {}
    for item in candidates:
        template = dataset.engineers.get(item['templateId'])
        if not template or not template.is_available:
            continue
        engineers[item['id']] = replace(template, engineer_id=item['id'])
        lookup[item['id']] = item
        if floor <= item['rating']['score'] <= ceiling:
            available[operational_profile(template)].append(item)
    for values in available.values():
        values.sort(key=lambda item: (-item['rating']['score'], item['id']))
    assigned, missing, matches, used = [], [], [], set(locked)
    # Locked routes keep their actual performer, even if below the quality target.
    for route in plan.engineer_plans:
        if route.engineer_id in locked:
            assigned.append(route)
    for route in sorted(plan.engineer_plans, key=lambda r: (-len(r.visits), r.engineer_id)):
        if route.engineer_id in locked:
            continue
        profile = operational_profile(dataset.engineers[route.engineer_id])
        target = next((item for item in available[profile] if item['id'] not in used), None)
        if target:
            used.add(target['id'])
            assigned.append(EngineerPlan(target['id'], route.visits))
            matches.append({'sourceEngineerId': route.engineer_id, 'engineerId': target['id'],
                            'visits': len(route.visits), 'rating': target['rating']['score']})
        else:
            missing.append({'templateId': route.engineer_id,
                            'jobIds': [v.job_id for v in route.visits]})
    unserved = set(plan.unserved_job_ids) | {key for item in missing for key in item['jobIds']}
    result = replace(plan, engineer_plans=tuple(assigned), unserved_job_ids=tuple(sorted(unserved)))
    return replace(dataset, engineers=engineers), result, missing, matches


def main():
    parser = argparse.ArgumentParser()
    for name in ['dataset', 'input-plan', 'output', 'cache', 'transit-index']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    dataset = load_planning_dataset(args.dataset, 'core')
    plan, source = load_exact_plan_artifact(args.input_plan, dataset.dataset_sha256)
    if not validate_initial_plan(dataset, plan).is_valid:
        raise ValueError('Исходный план не прошёл независимую проверку')
    plan = replace(plan, engineer_plans=tuple(route for route in plan.engineer_plans if route.visits))
    locked = frozenset(r.engineer_id for r in dataset.active_commitments_at(plan.planning_at)) | frozenset(payload.get('lockedEngineerIds', []))
    oracle = ExactRoutingOracle(create_route_client(RoutingCache(args.cache), 'valhalla-local-transit',
        timeout_seconds=3, max_attempts=1, transit_index=args.transit_index, metro_wait_seconds=180))
    reduced, search = compact(dataset, plan, locked, oracle)
    print(json.dumps({'type':'progress','phase':'SELECTING_ENGINEERS','routeChecks':search['routeChecks']}), flush=True)
    rated_dataset, final, missing, matches = compose(dataset, reduced, payload['candidates'], payload['qualityFloor'], locked, payload.get('qualityCeiling', 5))
    validation = validate_initial_plan(rated_dataset, final)
    if not validation.is_valid:
        raise ValueError('Состав не прошёл независимую проверку ограничений')
    result = materialization_result_dict(MaterializationResult(status=MaterializationStatus.EXACT_VALID,
        plan=final, validation=validation, failure=None, exact_provider_queries=search['providerQueries'], identity_legs=0))
    result.update({'artifact_type': 'STAFFING_COMPOSITION', 'dataset_sha256': dataset.dataset_sha256,
        'source_plan_content_sha256': source['content_sha256'], 'candidate_profiles': payload['candidates'],
        'rating_version': payload['ratingVersion'], 'rating_assignments': matches,
        'search_scope': 'BOUNDED_EXACT_CREW_ELIMINATION_AND_PROFILE_MATCHING',
        'global_optimality_proven': False, 'staffing': {'needed': len(reduced.engineer_plans),
            'sourceUsed': len(plan.engineer_plans), 'missing': missing, 'search': search,
            'lockedEngineerIds': sorted(locked), 'qualityExceptions': [key for key in locked if not payload['qualityFloor'] <= next((c['rating']['score'] for c in payload['candidates'] if c['id'] == key), 0) <= payload.get('qualityCeiling', 5)]}})
    result['content_sha256'] = payload_sha256(result)
    write_json_atomic(args.output, result)
    print(json.dumps({'status': result['status'], 'staffing': result['staffing']}))


if __name__ == '__main__':
    main()
