from __future__ import annotations

import argparse
import json
from datetime import timedelta
from pathlib import Path

from beeline_planning import (
    MasterEngineerRoute,
    MasterSolution,
    MasterSolveStatus,
    MasterVisit,
    build_explanation_bundle,
    build_candidate_index,
    load_planning_dataset,
    materialize_exact_initial_plan,
)
from beeline_planning.export import materialization_result_dict
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle
from beeline_planning.domain import Priority


def _master(dataset, routes: dict[str, list[str]], unserved: set[str]) -> MasterSolution:
    master_routes = []
    for engineer_id, job_ids in sorted(routes.items()):
        if not job_ids:
            continue
        visits = []
        for index, job_id in enumerate(job_ids):
            origin = f'START:{engineer_id}' if index == 0 else job_ids[index - 1]
            job = dataset.jobs[job_id]
            visits.append(
                MasterVisit(
                    sequence=index + 1,
                    job_id=job_id,
                    origin_node_id=origin,
                    departure_at=max(
                        dataset.initial_planning_at,
                        dataset.engineers[engineer_id].shift_start,
                        job.created_at,
                    ),
                    service_start_at=job.window_start,
                    screening_duration_minutes=0,
                    screening_distance_m=0,
                    screening_source_mode=dataset.engineers[engineer_id].transport_mode.value,
                    screening_is_surrogate=False,
                )
            )
        master_routes.append(
            MasterEngineerRoute(engineer_id=engineer_id, visits=tuple(visits))
        )
    return MasterSolution(
        status=MasterSolveStatus.SCREENING_FEASIBLE,
        planning_at=dataset.initial_planning_at,
        routes=tuple(master_routes),
        unserved_job_ids=tuple(sorted(unserved)),
        objective_proofs=(),
        dataset_sha256=dataset.dataset_sha256,
        screening_snapshot_sha256='0' * 64,
        solver_version='exact-insertion-repair',
        search_graph_complete=False,
        searched_arc_count=0,
        operationally_excluded_arcs=(),
    )


def _insertion_master(dataset, routes, engineer_id, trial, active_job_ids):
    """Retain other teams so shared inventory and commitments are checked globally."""
    trial_routes = {**routes, engineer_id: trial}
    trial_jobs = {item for jobs in trial_routes.values() for item in jobs}
    return _master(dataset, trial_routes, set(active_job_ids) - trial_jobs)


def _zero_travel_window_conflict(dataset, engineer_id: str, job_ids: list[str]) -> dict | None:
    """Save the first lower-bound violation for this particular route ordering."""
    engineer = dataset.engineers[engineer_id]
    moment = max(dataset.initial_planning_at, engineer.shift_start)
    route_start = None
    for job_id in job_ids:
        job = dataset.jobs[job_id]
        moment = max(moment, job.created_at, job.window_start)
        start = moment
        end = start + timedelta(minutes=job.service_duration_min)
        if route_start is None:
            route_start = start
        limit = job.window_end if start > job.window_end else engineer.shift_end
        actual = start if start > job.window_end else end
        constraint = 'client_window' if start > job.window_end else 'shift'
        if actual <= limit and end - route_start > timedelta(minutes=engineer.max_route_minutes):
            actual, limit = end, route_start + timedelta(minutes=engineer.max_route_minutes)
            constraint = 'route_limit'
        if actual > limit:
            return {'conflicting_job_id': job_id, 'constraint': constraint, 'service_start_at': start.isoformat(), 'service_end_at': end.isoformat(), 'limit_at': limit.isoformat(), 'violation_minutes': int((actual - limit).total_seconds() // 60), 'proof_level': 'ZERO_TRAVEL_LOWER_BOUND_FOR_THIS_ORDER'}
        moment = end
    return None


def _zero_travel_window_feasible(dataset, engineer_id: str, job_ids: list[str]) -> bool:
    return _zero_travel_window_conflict(dataset, engineer_id, job_ids) is None


def _insertion_job_order(dataset, job_ids):
    """Try every unserved emergency before ordinary work can consume capacity."""
    return sorted(job_ids, key=lambda job_id: (
        dataset.jobs[job_id].priority != Priority.URGENT, job_id,
    ))


def _save_insertion_checkpoint(output, result, *, dataset_sha256, source_plan,
                               inserted_jobs, diagnostics):
    """Keep each validated improvement if a later insertion exhausts its budget."""
    payload = materialization_result_dict(result)
    if not payload['publication_allowed']:
        raise ValueError('An insertion checkpoint must pass independent validation')
    payload.update({
        'artifact_type': 'EXACT_PLAN_INSERTION_IMPROVEMENT',
        'dataset_sha256': dataset_sha256,
        'source_plan': str(source_plan),
        'inserted_jobs': list(inserted_jobs),
        'unserved_insertion_diagnostics': diagnostics,
        'checkpoint': True,
    })
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(output, payload)


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Insert unserved jobs only when the resulting exact route stays valid.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument('--timeout-seconds', type=float, default=30)
    parser.add_argument('--max-attempts', type=int, default=2)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Exact insertion improvement requires explicit --execute')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    source = json.loads(args.input_plan.read_text(encoding='utf-8'))
    if source.get('status') != 'EXACT_VALID' or not source.get('publication_allowed'):
        raise ValueError('Input must be an exact valid published plan artifact')
    if source.get('dataset_sha256') != dataset.dataset_sha256:
        raise ValueError('Input plan belongs to another dataset checksum')

    routes = {
        route['engineer_id']: [visit['job_id'] for visit in route['visits']]
        for route in source['plan']['engineer_plans']
    }
    for engineer_id in dataset.engineers:
        routes.setdefault(engineer_id, [])
    unserved = set(source['plan']['unserved_job_ids'])
    candidates = build_candidate_index(dataset)
    oracle = ExactRoutingOracle(
        create_route_client(
            RoutingCache(args.cache),
            'valhalla-local-transit',
            timeout_seconds=args.timeout_seconds,
            max_attempts=args.max_attempts,
            transit_index=args.transit_index,
            metro_wait_seconds=args.metro_wait_seconds,
        )
    )

    inserted: list[dict[str, object]] = []
    insertion_diagnostics: dict[str, dict] = {}
    exact_provider_queries = 0
    exact_route_checks = 0
    changed = True
    while changed:
        changed = False
        for job_id in _insertion_job_order(dataset, unserved):
            selected = None
            counters = {
                'static_eligible_engineers': len(
                    candidates.eligible_engineers_by_job[job_id]
                ),
                'engineers_at_max_jobs': 0,
                'candidate_positions': 0,
                'zero_travel_window_rejections': 0,
                'exact_route_evaluations': 0,
                'exact_schedule_rejections': 0,
                'routing_unverified': 0,
                'checked_positions': [],
                'proof_level': 'CURRENT_ROUTES_ONLY_NOT_GLOBAL_INFEASIBILITY',
            }
            for engineer_id in candidates.eligible_engineers_by_job[job_id]:
                current = routes[engineer_id]
                if len(current) >= dataset.engineers[engineer_id].max_jobs:
                    counters['engineers_at_max_jobs'] += 1
                    counters['checked_positions'].append({'engineer_id': engineer_id, 'constraint': 'max_jobs', 'actual': len(current) + 1, 'limit': dataset.engineers[engineer_id].max_jobs, 'proof_level': 'STATIC_CURRENT_ROUTE'})
                    continue
                for position in range(len(current) + 1):
                    counters['candidate_positions'] += 1
                    trial = current[:position] + [job_id] + current[position:]
                    conflict = _zero_travel_window_conflict(dataset, engineer_id, trial)
                    if conflict:
                        counters['checked_positions'].append({'engineer_id': engineer_id, 'position': position + 1, **conflict})
                        counters['zero_travel_window_rejections'] += 1
                        continue
                    counters['exact_route_evaluations'] += 1
                    exact_route_checks += 1
                    trial_master = _insertion_master(dataset, routes, engineer_id, trial, candidates.active_job_ids)
                    result = materialize_exact_initial_plan(dataset, trial_master, oracle)
                    exact_provider_queries += result.exact_provider_queries
                    if result.status.value != 'EXACT_VALID' or result.validation is None:
                        counters['exact_schedule_rejections'] += 1
                        counters['routing_unverified'] += int(result.status.value == 'ROUTING_INCOMPLETE')
                        failure = materialization_result_dict(result)['failure']
                        counters['checked_positions'].append({'engineer_id': engineer_id, 'position': position + 1, 'proof_level': 'ROUTING_UNVERIFIED' if result.status.value == 'ROUTING_INCOMPLETE' else 'EXACT_CURRENT_ORDER', **(failure or {'constraint': 'validation', 'violations': [str(item) for item in result.validation.violations] if result.validation else []})})
                        continue
                    selected = (engineer_id, position)
                    break
                if selected is not None:
                    break
            if selected is None:
                insertion_diagnostics[job_id] = counters
                write_json_atomic(args.output.with_suffix('.diagnostics.json'), {'dataset_sha256': dataset.dataset_sha256, 'status': 'CURRENT_ROUTE_INSERTIONS_CHECKED', 'global_infeasibility_proven': False, 'jobs': insertion_diagnostics})
                continue
            engineer_id, position = selected
            routes[engineer_id].insert(position, job_id)
            unserved.remove(job_id)
            inserted.append(
                {'job_id': job_id, 'engineer_id': engineer_id, 'position': position + 1}
            )
            insertion_diagnostics.pop(job_id, None)
            _save_insertion_checkpoint(
                args.output, result, dataset_sha256=dataset.dataset_sha256,
                source_plan=args.input_plan, inserted_jobs=inserted,
                diagnostics=insertion_diagnostics,
            )
            changed = True

    final_master = _master(dataset, routes, unserved)
    result = materialize_exact_initial_plan(dataset, final_master, oracle)
    exact_provider_queries += result.exact_provider_queries
    payload = materialization_result_dict(result)
    payload['artifact_type'] = 'EXACT_PLAN_INSERTION_IMPROVEMENT'
    payload['source_plan'] = str(args.input_plan)
    payload['inserted_jobs'] = inserted
    payload['unserved_insertion_diagnostics'] = insertion_diagnostics
    payload['exact_route_checks'] = exact_route_checks
    payload['exact_provider_queries_total'] = exact_provider_queries
    if result.plan is not None and result.validation is not None and payload['publication_allowed']:
        payload['explanations'] = build_explanation_bundle(
            dataset,
            result.plan,
            result.validation,
            insertion_diagnostics=insertion_diagnostics,
            exact_route_checks=payload['exact_route_checks'],
            exact_provider_queries=exact_provider_queries,
            global_optimality_proven=False,
        )
    payload['routing_configuration'] = {
        'provider': 'valhalla-local-transit',
        'transit_index': str(args.transit_index),
        'metro_wait_assumption_seconds': args.metro_wait_seconds,
        'query_time_api_key_required': False,
        'exact_historical_metro_timetable_proof': False,
    }
    payload['dataset_sha256'] = dataset.dataset_sha256
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(
        json.dumps(
            {
                'status': result.status.value,
                'output': str(args.output),
                'inserted_jobs': inserted,
                'served_jobs': sum(
                    len(route['visits']) for route in payload['plan']['engineer_plans']
                ) if payload['plan'] else 0,
                'unserved_jobs': len(payload['plan']['unserved_job_ids']) if payload['plan'] else 0,
                'publication_allowed': payload['publication_allowed'],
            },
            ensure_ascii=False,
        )
    )
    return 0 if payload['publication_allowed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
