"""Select rated crews for complete verified routes, then independently validate.

This mode preserves the road-validated visit order and all appointments. It does
not claim a global optimum over new route sequences. Within each identical
operational profile it maximizes the visit-weighted rating by a sorted matching.
No fleet-size objective or unchecked travel estimates are used.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from dataclasses import replace
from pathlib import Path

from rating_inputs import validate_rating_inputs
from beeline_planning import load_planning_dataset, validate_initial_plan
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import MaterializationResult, MaterializationStatus
from beeline_planning.plan import EngineerPlan
from beeline_routing.export import payload_sha256, write_json_atomic


def operational_profile(engineer):
    return (engineer.zone_id, engineer.shift_start, engineer.shift_end,
            engineer.start_office_id, engineer.transport_mode, engineer.is_available,
            engineer.max_jobs, engineer.max_route_minutes, engineer.skills, engineer.equipment)


def rated_assignment(dataset, source_plan, candidates, manual_engineers=frozenset()):
    engineers = dict(dataset.engineers)
    ratings = {}
    for item in candidates:
        template = dataset.engineers.get(item['templateId'])
        if template is None or not template.is_available:
            continue
        identifier = str(item['id'])
        # The server checks the public model against its retained source profile.
        engineers[identifier] = replace(template, engineer_id=identifier)
        ratings[identifier] = float(item['rating']['score'])
    grouped_routes = defaultdict(list)
    assigned = []
    reserved = set(manual_engineers)
    for route in source_plan.engineer_plans:
        if not route.visits:
            continue
        if route.engineer_id in manual_engineers:
            assigned.append(route)
        else:
            grouped_routes[operational_profile(dataset.engineers[route.engineer_id])].append(route)
    matches = []
    for profile, routes in grouped_routes.items():
        eligible = [key for key, value in engineers.items()
                    if key in ratings and key not in reserved and operational_profile(value) == profile]
        eligible.sort(key=lambda key: (-ratings[key], key))
        routes.sort(key=lambda route: (-len(route.visits), route.engineer_id))
        if len(eligible) < len(routes):
            raise ValueError('Недостаточно доступных инженеров с подтверждённым совместимым профилем')
        for route, target in zip(routes, eligible):
            reserved.add(target)
            assigned.append(EngineerPlan(target, route.visits))
            matches.append({'sourceEngineerId': route.engineer_id, 'engineerId': target,
                            'visits': len(route.visits), 'rating': ratings[target],
                            'eligibleCount': len(eligible)})
    scored = replace(source_plan, engineer_plans=tuple(sorted(assigned, key=lambda item: item.engineer_id)))
    return replace(dataset, engineers=engineers), scored, matches


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    dataset = load_planning_dataset(args.dataset, 'core')
    validate_rating_inputs(dataset, payload.get('sourceInputs'))
    plan, source = load_exact_plan_artifact(args.input_plan, dataset.dataset_sha256)
    if not validate_initial_plan(dataset, plan).is_valid:
        raise ValueError('Исходный план не прошёл проверку. Нужен точный план выбранного дня.')
    locked = frozenset(item.engineer_id for item in dataset.active_commitments_at(plan.planning_at)) | frozenset(payload.get('lockedEngineerIds', []))
    rated_dataset, rated_plan, matches = rated_assignment(dataset, plan, payload['candidates'], locked)
    validation = validate_initial_plan(rated_dataset, rated_plan)
    if not validation.is_valid:
        raise ValueError('План по рейтингу не прошёл независимую проверку ограничений')
    result = materialization_result_dict(MaterializationResult(
        status=MaterializationStatus.EXACT_VALID, plan=rated_plan, validation=validation,
        failure=None, exact_provider_queries=0, identity_legs=0))
    result.update({'artifact_type': 'RATING_ROUTE_ASSIGNMENT', 'dataset_sha256': dataset.dataset_sha256,
                   'source_plan_content_sha256': source['content_sha256'], 'rating_assignments': matches,
                   'rating_version': payload['ratingVersion'], 'global_optimality_proven': False,
                   'search_scope': 'MAX_VISIT_WEIGHTED_RATING_WITHIN_IDENTICAL_OPERATIONAL_PROFILES',
                   'road_evidence': 'REUSED_IDENTICAL_START_MODE_ORDER_AND_DEPARTURES',
                   'candidate_profiles': payload['candidates']})
    result['content_sha256'] = payload_sha256(result)
    write_json_atomic(args.output, result)
    print(json.dumps({'status': result['status'], 'output': str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
