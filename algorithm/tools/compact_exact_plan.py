from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path

from beeline_planning import (
    EngineerPlan,
    MaterializationStatus,
    MaterializationResult,
    Priority,
    ProposedPlan,
    build_candidate_index,
    build_explanation_bundle,
    build_screening_route_evaluator,
    find_team_elimination_candidates,
    load_planning_dataset,
    load_screening_matrices,
    materialize_exact_initial_plan,
    validate_initial_plan,
)
from beeline_planning.exact_repair import master_from_orders
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.oracle import ExactRoutingOracle


def _priority_counts(dataset, job_ids: set[str]) -> tuple[int, int]:
    urgent = sum(dataset.jobs[job_id].priority == Priority.URGENT for job_id in job_ids)
    return urgent, len(job_ids) - urgent


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            'Remove complete engineer routes while preserving exact-valid coverage.'
        )
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--screening-root', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--beam-width', type=int, default=64)
    parser.add_argument('--max-screening-candidates', type=int, default=12)
    parser.add_argument('--max-candidates-per-engineer', type=int, default=2)
    parser.add_argument('--max-screening-states', type=int, default=100_000)
    parser.add_argument('--max-exact-route-checks', type=int, default=12)
    parser.add_argument('--max-passes', type=int, default=3)
    parser.add_argument('--focus-engineer')
    parser.add_argument('--timeout-seconds', type=float, default=30)
    parser.add_argument('--max-attempts', type=int, default=2)
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument(
        '--trust-input-validation',
        action='store_true',
        help=(
            'Do not rematerialize a checksummed published input. Every '
            'candidate is still checked with exact routing.'
        ),
    )
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('Exact team compaction requires explicit --execute')
    if args.output.resolve() == args.input_plan.resolve() or args.output.exists():
        parser.error('Output must be a new file, distinct from the input plan')
    if (
        args.beam_width < 1
        or args.max_screening_candidates < 1
        or args.max_candidates_per_engineer < 1
        or args.max_screening_states < 1
        or args.max_exact_route_checks < 1
        or args.max_passes < 1
    ):
        parser.error('Search budgets must be positive')

    dataset = load_planning_dataset(args.dataset, args.scenario)
    source = json.loads(args.input_plan.read_text(encoding='utf-8'))
    unsigned_source = dict(source)
    expected_checksum = unsigned_source.pop('content_sha256', None)
    if expected_checksum != payload_sha256(unsigned_source):
        parser.error('Input plan content checksum mismatch')
    if (
        source.get('status') != 'EXACT_VALID'
        or source.get('publication_allowed') is not True
        or source.get('dataset_sha256') != dataset.dataset_sha256
        or source.get('validation', {}).get('status') != 'VALID'
    ):
        parser.error('Input must be a validated, published exact plan for this dataset')
    if source.get('plan', {}).get('planning_at') != dataset.initial_planning_at.isoformat():
        parser.error('Only the initial plan at dataset.initial_planning_at is supported')
    source_plan, _ = load_exact_plan_artifact(args.input_plan, dataset.dataset_sha256)

    routes = {
        route['engineer_id']: tuple(
            visit['job_id'] for visit in route.get('visits', ())
        )
        for route in source['plan']['engineer_plans']
    }
    for engineer_id in dataset.engineers:
        routes.setdefault(engineer_id, ())
    unserved = set(source['plan']['unserved_job_ids'])
    active = {
        job.job_id for job in dataset.active_jobs_at(dataset.initial_planning_at)
    }
    assigned = [job_id for order in routes.values() for job_id in order]
    if (
        len(assigned) != len(set(assigned))
        or set(assigned) | unserved != active
        or set(assigned) & unserved
    ):
        parser.error('Input plan has duplicate, missing, or contradictory job results')
    original_priority_counts = _priority_counts(dataset, unserved)
    original_used_engineers = sum(bool(order) for order in routes.values())

    cache = RoutingCache(args.cache)

    def make_oracle() -> ExactRoutingOracle:
        return ExactRoutingOracle(create_route_client(
            cache,
            'valhalla-local-transit',
            timeout_seconds=args.timeout_seconds,
            max_attempts=args.max_attempts,
            transit_index=args.transit_index,
            metro_wait_seconds=args.metro_wait_seconds,
        ))

    oracle = make_oracle()
    current = None
    total_exact_queries = 0
    if not args.trust_input_validation:
        current = materialize_exact_initial_plan(
            dataset,
            master_from_orders(dataset, routes, unserved),
            oracle,
        )
        total_exact_queries += current.exact_provider_queries
        if current.status != MaterializationStatus.EXACT_VALID:
            parser.error(f'Input route orders fail exact rematerialization: {current.failure}')

    candidates = build_candidate_index(dataset)
    screening = load_screening_matrices(args.screening_root, dataset)
    evaluate_route = build_screening_route_evaluator(
        dataset,
        screening,
        candidates,
    )
    single_route_dataset = replace(dataset, commitments=())
    exact_route_results: dict[tuple[str, tuple[str, ...]], bool] = {
        (engineer_id, order): True
        for engineer_id, order in routes.items()
        if order
    }
    exact_route_materializations: dict[
        tuple[str, tuple[str, ...]], MaterializationResult
    ] = {}
    exact_route_statuses: dict[tuple[str, tuple[str, ...]], str] = {}
    exact_route_failures: dict[tuple[str, tuple[str, ...]], dict[str, object]] = {}
    exact_budget_exhausted = False

    def exact_route_valid(engineer_id: str, order: tuple[str, ...]) -> bool:
        nonlocal exact_budget_exhausted, total_exact_queries
        key = (engineer_id, order)
        if key not in exact_route_results:
            if len(exact_route_statuses) >= args.max_exact_route_checks:
                exact_budget_exhausted = True
                exact_route_statuses[key] = 'EXACT_QUERY_BUDGET_EXHAUSTED'
                return False
            result = materialize_exact_initial_plan(
                single_route_dataset,
                master_from_orders(
                    single_route_dataset,
                    {engineer_id: order},
                    active - set(order),
                ),
                oracle,
            )
            total_exact_queries += result.exact_provider_queries
            exact_route_materializations[key] = result
            exact_route_results[key] = (
                result.status == MaterializationStatus.EXACT_VALID
            )
            exact_route_statuses[key] = result.status.value
            if result.failure is not None:
                exact_route_failures[key] = {
                    'status': result.status.value,
                    'engineer_id': result.failure.engineer_id,
                    'job_id': result.failure.job_id,
                    'origin_location_id': result.failure.origin_location_id,
                    'destination_location_id': result.failure.destination_location_id,
                    'departure_at': str(result.failure.departure_at),
                    'reason': result.failure.reason,
                }
        return exact_route_results[key]

    def delta_exact_plan(
        eliminated_engineer_id: str,
        route_updates: dict[str, tuple[str, ...]],
    ) -> MaterializationResult:
        """Validate a delta against checksummed proofs for untouched routes.

        The source artifact is cryptographically verified above. Re-querying its
        untouched exact legs is both redundant and can make a valid historical
        proof depend on temporary routing-service availability. Each changed
        route is rematerialized with the live exact oracle before this merge.
        """
        updated_plans: dict[str, EngineerPlan] = {}
        for engineer_id, order in route_updates.items():
            result = exact_route_materializations[(engineer_id, order)]
            if result.plan is None or result.status != MaterializationStatus.EXACT_VALID:
                raise RuntimeError('Cannot merge a route that lacks an exact proof')
            updated_plans[engineer_id] = result.plan.engineer_plans[0]
        merged_routes: list[EngineerPlan] = []
        for route in source_plan.engineer_plans:
            if route.engineer_id == eliminated_engineer_id:
                continue
            merged_routes.append(updated_plans.get(route.engineer_id, route))
        plan = ProposedPlan(
            planning_at=source_plan.planning_at,
            engineer_plans=tuple(merged_routes),
            unserved_job_ids=source_plan.unserved_job_ids,
        )
        validation = validate_initial_plan(dataset, plan)
        status = (
            MaterializationStatus.EXACT_VALID
            if validation.is_valid
            else MaterializationStatus.ORDER_INFEASIBLE
        )
        return MaterializationResult(
            status=status,
            plan=plan,
            validation=validation,
            failure=None,
            exact_provider_queries=0,
            identity_legs=0,
        )

    accepted: list[dict[str, object]] = []
    attempts: list[dict[str, object]] = []
    search_reports: list[dict[str, object]] = []
    for pass_number in range(1, args.max_passes + 1):
        report = find_team_elimination_candidates(
            dataset,
            routes,
            candidates,
            evaluate_route,
            beam_width=args.beam_width,
            max_candidates=args.max_screening_candidates,
            max_candidates_per_source=args.max_candidates_per_engineer,
            max_states=args.max_screening_states,
            focus_engineer_id=args.focus_engineer,
        )
        search_reports.append({
            'pass': pass_number,
            'screening_candidates': len(report.candidates),
            'evaluated_route_orders': report.evaluated_route_orders,
            'expanded_states': report.expanded_states,
            'budget_exhausted': report.budget_exhausted,
        })
        accepted_this_pass = False
        for candidate_number, candidate in enumerate(report.candidates, start=1):
            route_updates = candidate.route_updates()
            changed_statuses: dict[str, str] = {}
            all_routes_exact = True
            for engineer_id, order in route_updates.items():
                if not exact_route_valid(engineer_id, order):
                    all_routes_exact = False
                changed_statuses[engineer_id] = exact_route_statuses.get(
                    (engineer_id, order),
                    'EXACT_VALID_INCUMBENT',
                )
            attempt: dict[str, object] = {
                'pass': pass_number,
                'candidate': candidate_number,
                'eliminated_engineer_id': candidate.eliminated_engineer_id,
                'moved_job_ids': list(candidate.moved_job_ids),
                'changed_engineer_ids': sorted(route_updates),
                'screening_score': list(candidate.screening_score),
                'exact_route_statuses': changed_statuses,
                'accepted': False,
            }
            failures = [
                exact_route_failures[key]
                for key in (
                    (engineer_id, order)
                    for engineer_id, order in route_updates.items()
                )
                if key in exact_route_failures
            ]
            if failures:
                attempt['exact_route_failures'] = failures
            attempts.append(attempt)
            if not all_routes_exact:
                continue
            trial_routes = dict(routes)
            trial_routes[candidate.eliminated_engineer_id] = ()
            trial_routes.update(route_updates)
            if args.trust_input_validation:
                trial = delta_exact_plan(
                    candidate.eliminated_engineer_id,
                    route_updates,
                )
                attempt['exact_proof'] = 'CHECKSUMMED_INCUMBENT_PLUS_CHANGED_ROUTE'
            else:
                trial = materialize_exact_initial_plan(
                    dataset,
                    master_from_orders(dataset, trial_routes, unserved),
                    oracle,
                )
                total_exact_queries += trial.exact_provider_queries
            attempt['complete_plan_status'] = trial.status.value
            if trial.failure is not None:
                attempt['complete_plan_failure'] = {
                    'engineer_id': trial.failure.engineer_id,
                    'job_id': trial.failure.job_id,
                    'origin_location_id': trial.failure.origin_location_id,
                    'destination_location_id': trial.failure.destination_location_id,
                    'departure_at': str(trial.failure.departure_at),
                    'reason': trial.failure.reason,
                }
            if trial.status != MaterializationStatus.EXACT_VALID:
                continue
            trial_used = sum(bool(order) for order in trial_routes.values())
            if (
                _priority_counts(dataset, unserved) != original_priority_counts
                or trial_used != sum(bool(order) for order in routes.values()) - 1
                or trial.validation is None
                or trial.validation.metrics.used_engineers != trial_used
            ):
                raise RuntimeError('Compaction candidate violated the quality guard')
            routes = trial_routes
            current = trial
            attempt['accepted'] = True
            accepted.append({
                'pass': pass_number,
                'eliminated_engineer_id': candidate.eliminated_engineer_id,
                'moved_job_ids': list(candidate.moved_job_ids),
                'changed_engineer_ids': sorted(route_updates),
                'used_engineers_after': trial_used,
            })
            accepted_this_pass = True
            print(
                f'Pass {pass_number}: removed {candidate.eliminated_engineer_id}; '
                f'{trial_used} engineers remain',
                flush=True,
            )
            break
        if not accepted_this_pass or args.focus_engineer is not None:
            break

    payload = (
        materialization_result_dict(current)
        if current is not None and accepted
        else dict(unsigned_source)
    )
    payload['artifact_type'] = 'EXACT_PLAN_TEAM_COMPACTION'
    payload['source_plan'] = str(args.input_plan)
    payload['accepted_eliminations'] = accepted
    payload['elimination_attempts'] = attempts
    payload['search_reports'] = search_reports
    payload['compaction_exact_provider_queries'] = total_exact_queries
    payload['search_configuration'] = {
        'beam_width': args.beam_width,
        'max_screening_candidates_per_pass': args.max_screening_candidates,
        'max_candidates_per_engineer': args.max_candidates_per_engineer,
        'max_screening_states_per_pass': args.max_screening_states,
        'max_exact_route_checks': args.max_exact_route_checks,
        'exact_query_budget_exhausted': exact_budget_exhausted,
        'max_passes': args.max_passes,
        'focus_engineer': args.focus_engineer,
        'targets_limited_to_already_used_engineers': True,
        'coverage_by_priority_fixed': list(original_priority_counts),
        'provider': 'valhalla-local-transit',
        'transit_index': str(args.transit_index),
        'metro_wait_assumption_seconds': args.metro_wait_seconds,
        'global_optimality_proven': False,
        'input_exact_validation_repeated': not args.trust_input_validation,
    }
    if accepted and current is not None and current.plan is not None and current.validation is not None:
        payload['explanations'] = build_explanation_bundle(
            dataset,
            current.plan,
            current.validation,
            search_budget_exhausted=any(
                report['budget_exhausted'] for report in search_reports
            ),
            exact_route_checks=len(exact_route_statuses),
            exact_provider_queries=total_exact_queries,
            global_optimality_proven=False,
        )
    payload['dataset_sha256'] = dataset.dataset_sha256
    payload.pop('content_sha256', None)
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    final_used = (
        payload.get('validation', {}).get('metrics', {}).get(
            'used_engineers',
            original_used_engineers,
        )
    )
    print(json.dumps({
        'status': payload['status'],
        'served_jobs': len(active) - len(unserved),
        'unserved_jobs': len(unserved),
        'used_engineers_before': original_used_engineers,
        'used_engineers_after': final_used,
        'accepted_eliminations': len(accepted),
        'exact_route_checks': len(exact_route_statuses),
        'exact_provider_queries': total_exact_queries,
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
