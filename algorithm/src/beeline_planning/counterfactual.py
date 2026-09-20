"""Exact, bounded answers to "what if job J were assigned to engineer E?"."""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum
from types import MappingProxyType
from typing import Any

from beeline_routing.oracle import ExactRoutingOracle

from .domain import Event, EventType, PlanningDataset
from .eligibility import CandidateIndex, build_candidate_index
from .errors import InvalidPlanningData
from .exact_repair import find_coverage_move, master_from_orders
from .materialize import (
    MaterializationStatus,
    materialize_exact_initial_plan,
)
from .plan import ProposedPlan
from .replanning import (
    ReplanningState,
    ReplanningStatus,
    replan_after_event,
)
from .validator import (
    ValidationReport,
    ValidationStatus,
    validate_initial_plan,
    validate_replanned_plan,
)


class CounterfactualStatus(StrEnum):
    FEASIBLE = 'FEASIBLE'
    ALREADY_ACTUAL = 'ALREADY_ACTUAL'
    STATICALLY_INELIGIBLE = 'STATICALLY_INELIGIBLE'
    STARTED_ACTIVITY_FROZEN = 'STARTED_ACTIVITY_FROZEN'
    NO_LOCAL_FEASIBLE_PLAN = 'NO_LOCAL_FEASIBLE_PLAN'
    SEARCH_LIMIT_REACHED = 'SEARCH_LIMIT_REACHED'
    ROUTING_INCOMPLETE = 'ROUTING_INCOMPLETE'


@dataclass(frozen=True, slots=True)
class CounterfactualResult:
    status: CounterfactualStatus
    job_id: str
    forced_engineer_id: str
    actual_engineer_id: str | None
    actual_service_start_at: str | None
    plan: ProposedPlan | None
    validation: ValidationReport | None
    static_rejection_codes: tuple[str, ...]
    route_checks: int
    budget_exhausted: bool
    move_kind: str | None
    displaced_job_ids: tuple[str, ...]
    metrics_delta: dict[str, int]
    changes: dict[str, list[dict[str, Any]]]
    reason: str
    claim_level: str


def _records(plan: ProposedPlan) -> dict[str, tuple[str, str]]:
    return {
        visit.job_id: (route.engineer_id, visit.service_start_at.isoformat())
        for route in plan.engineer_plans for visit in route.visits
    }


def _actual(plan: ProposedPlan, job_id: str) -> tuple[str | None, str | None]:
    record = _records(plan).get(job_id)
    return record if record is not None else (None, None)


def _metric_delta(
    actual: ValidationReport,
    counterfactual: ValidationReport,
) -> dict[str, int]:
    before = actual.metrics
    after = counterfactual.metrics
    return {
        'served_urgent_jobs': after.served_urgent_jobs - before.served_urgent_jobs,
        'served_normal_jobs': after.served_normal_jobs - before.served_normal_jobs,
        'unserved_urgent_jobs': after.unserved_urgent_jobs - before.unserved_urgent_jobs,
        'unserved_normal_jobs': after.unserved_normal_jobs - before.unserved_normal_jobs,
        'used_engineers': after.used_engineers - before.used_engineers,
        'total_distance_m': after.total_distance_m - before.total_distance_m,
        'total_travel_minutes': (
            after.total_travel_minutes - before.total_travel_minutes
        ),
        'total_waiting_minutes': (
            after.total_waiting_minutes - before.total_waiting_minutes
        ),
    }


def _changes(before: ProposedPlan, after: ProposedPlan) -> dict[str, list[dict[str, Any]]]:
    old = _records(before)
    new = _records(after)
    return {
        'newly_assigned': [
            {'job_id': job_id, 'engineer_id': new[job_id][0]}
            for job_id in sorted(new.keys() - old.keys())
        ],
        'removed_from_route': [
            {'job_id': job_id, 'engineer_id': old[job_id][0]}
            for job_id in sorted(old.keys() - new.keys())
        ],
        'changed_assignment': [
            {'job_id': job_id, 'from': old[job_id][0], 'to': new[job_id][0]}
            for job_id in sorted(old.keys() & new.keys())
            if old[job_id][0] != new[job_id][0]
        ],
        'changed_visit_time': [
            {'job_id': job_id, 'from': old[job_id][1], 'to': new[job_id][1]}
            for job_id in sorted(old.keys() & new.keys())
            if old[job_id][1] != new[job_id][1]
        ],
    }


def _empty_result(
    status: CounterfactualStatus,
    plan: ProposedPlan,
    job_id: str,
    engineer_id: str,
    *,
    rejection_codes: tuple[str, ...] = (),
    reason: str,
    claim_level: str,
    route_checks: int = 0,
    budget_exhausted: bool = False,
) -> CounterfactualResult:
    actual_engineer, actual_start = _actual(plan, job_id)
    return CounterfactualResult(
        status=status,
        job_id=job_id,
        forced_engineer_id=engineer_id,
        actual_engineer_id=actual_engineer,
        actual_service_start_at=actual_start,
        plan=None,
        validation=None,
        static_rejection_codes=rejection_codes,
        route_checks=route_checks,
        budget_exhausted=budget_exhausted,
        move_kind=None,
        displaced_job_ids=(),
        metrics_delta={},
        changes={
            'newly_assigned': [], 'removed_from_route': [],
            'changed_assignment': [], 'changed_visit_time': [],
        },
        reason=reason,
        claim_level=claim_level,
    )


def _check_query(
    dataset: PlanningDataset,
    job_id: str,
    engineer_id: str,
) -> None:
    if job_id not in dataset.jobs:
        raise InvalidPlanningData(f'Unknown job: {job_id}')
    if engineer_id not in dataset.engineers:
        raise InvalidPlanningData(f'Unknown engineer: {engineer_id}')


def evaluate_initial_assignment_counterfactual(
    dataset: PlanningDataset,
    actual_plan: ProposedPlan,
    job_id: str,
    engineer_id: str,
    oracle: ExactRoutingOracle,
    *,
    max_route_checks: int = 400,
    max_displacements: int = 2,
) -> CounterfactualResult:
    """Force one initial-plan assignment using bounded exact local repair."""
    _check_query(dataset, job_id, engineer_id)
    actual_validation = validate_initial_plan(dataset, actual_plan)
    if actual_validation.status != ValidationStatus.VALID:
        raise InvalidPlanningData('Actual plan must pass independent validation')
    if job_id not in {job.job_id for job in dataset.active_jobs_at(dataset.initial_planning_at)}:
        raise InvalidPlanningData('Job is not active at initial planning time')
    actual_engineer, actual_start = _actual(actual_plan, job_id)
    if actual_engineer == engineer_id:
        return CounterfactualResult(
            CounterfactualStatus.ALREADY_ACTUAL, job_id, engineer_id,
            actual_engineer, actual_start, actual_plan, actual_validation, (),
            0, False, 'UNCHANGED', (),
            {key: 0 for key in _metric_delta(actual_validation, actual_validation)},
            _changes(actual_plan, actual_plan),
            'Заявка уже назначена выбранной бригаде; контрфактический план совпадает с фактическим.',
            'EXACT_VALIDATED',
        )

    candidates = build_candidate_index(dataset)
    rejection_codes = tuple(
        reason.value for reason in candidates.reasons(engineer_id, job_id)
    )
    if rejection_codes:
        return _empty_result(
            CounterfactualStatus.STATICALLY_INELIGIBLE,
            actual_plan, job_id, engineer_id,
            rejection_codes=rejection_codes,
            reason='Принудительная пара нарушает статические жёсткие ограничения.',
            claim_level='EXACT_FACT',
        )

    routes = {
        route.engineer_id: tuple(
            visit.job_id for visit in route.visits if visit.job_id != job_id
        )
        for route in actual_plan.engineer_plans
    }
    for known_engineer_id in dataset.engineers:
        routes.setdefault(known_engineer_id, ())
    unserved = set(actual_plan.unserved_job_ids) | {job_id}
    base = materialize_exact_initial_plan(
        dataset, master_from_orders(dataset, routes, unserved), oracle
    )
    if base.status == MaterializationStatus.ROUTING_INCOMPLETE:
        return _empty_result(
            CounterfactualStatus.ROUTING_INCOMPLETE,
            actual_plan, job_id, engineer_id,
            reason='После снятия заявки маршрутные данные не удалось подтвердить.',
            claim_level='ROUTING_UNVERIFIED',
        )
    if base.status != MaterializationStatus.EXACT_VALID:
        return _empty_result(
            CounterfactualStatus.NO_LOCAL_FEASIBLE_PLAN,
            actual_plan, job_id, engineer_id,
            reason='Базовая локальная перестройка после снятия заявки недопустима.',
            claim_level='LOCAL_IMPOSSIBILITY',
        )

    forced_eligible = dict(candidates.eligible_engineers_by_job)
    forced_eligible[job_id] = (engineer_id,)
    forced_candidates = CandidateIndex(
        planning_at=candidates.planning_at,
        active_job_ids=candidates.active_job_ids,
        eligible_engineers_by_job=MappingProxyType(forced_eligible),
        rejection_codes=candidates.rejection_codes,
    )
    active_job_ids = set(candidates.active_job_ids)
    single_route_dataset = replace(dataset, commitments=())
    routing_incomplete_seen = False

    def exact_route_valid(target_engineer_id: str, order: tuple[str, ...]) -> bool:
        nonlocal routing_incomplete_seen
        proposal = master_from_orders(
            single_route_dataset,
            {target_engineer_id: order},
            active_job_ids - set(order),
        )
        result = materialize_exact_initial_plan(
            single_route_dataset, proposal, oracle
        )
        if result.status == MaterializationStatus.ROUTING_INCOMPLETE:
            routing_incomplete_seen = True
        return result.status == MaterializationStatus.EXACT_VALID

    report = find_coverage_move(
        dataset,
        routes,
        {job_id},
        forced_candidates,
        exact_route_valid,
        max_route_checks=max_route_checks,
        max_displacements=max_displacements,
    )
    if report.move is None:
        if routing_incomplete_seen:
            return _empty_result(
                CounterfactualStatus.ROUTING_INCOMPLETE,
                actual_plan, job_id, engineer_id,
                reason=(
                    'Хотя бы один необходимый маршрут не подтверждён; '
                    'невозможность принудительного назначения не объявляется.'
                ),
                claim_level='ROUTING_UNVERIFIED',
                route_checks=report.route_checks,
                budget_exhausted=report.budget_exhausted,
            )
        return _empty_result(
            CounterfactualStatus.SEARCH_LIMIT_REACHED
            if report.budget_exhausted
            else CounterfactualStatus.NO_LOCAL_FEASIBLE_PLAN,
            actual_plan, job_id, engineer_id,
            reason=(
                'Контрфактический поиск остановлен по лимиту; невозможность не доказана.'
                if report.budget_exhausted else
                'В проверенном локальном поиске допустимый принудительный план не найден.'
            ),
            claim_level=(
                'SEARCH_LIMIT_REACHED' if report.budget_exhausted
                else 'LOCAL_IMPOSSIBILITY'
            ),
            route_checks=report.route_checks,
            budget_exhausted=report.budget_exhausted,
        )

    trial_routes = dict(routes)
    trial_routes.update(report.move.routes)
    trial = materialize_exact_initial_plan(
        dataset,
        master_from_orders(dataset, trial_routes, unserved - {job_id}),
        oracle,
    )
    if trial.status != MaterializationStatus.EXACT_VALID:
        return _empty_result(
            CounterfactualStatus.ROUTING_INCOMPLETE
            if trial.status == MaterializationStatus.ROUTING_INCOMPLETE
            else CounterfactualStatus.NO_LOCAL_FEASIBLE_PLAN,
            actual_plan, job_id, engineer_id,
            reason='Найденный локальный ход не прошёл итоговую проверку полного плана.',
            claim_level=(
                'ROUTING_UNVERIFIED'
                if trial.status == MaterializationStatus.ROUTING_INCOMPLETE
                else 'LOCAL_IMPOSSIBILITY'
            ),
            route_checks=report.route_checks,
            budget_exhausted=report.budget_exhausted,
        )
    forced_actual, _ = _actual(trial.plan, job_id)
    if forced_actual != engineer_id:
        raise RuntimeError('Counterfactual search violated its forced assignment')
    return CounterfactualResult(
        CounterfactualStatus.FEASIBLE, job_id, engineer_id,
        actual_engineer, actual_start, trial.plan, trial.validation, (),
        report.route_checks, report.budget_exhausted, report.move.kind,
        report.move.displaced_job_ids,
        _metric_delta(actual_validation, trial.validation),
        _changes(actual_plan, trial.plan),
        'Принудительное назначение найдено и полный план независимо проверен.',
        'EXACT_VALIDATED',
    )


def evaluate_event_assignment_counterfactual(
    dataset: PlanningDataset,
    source_state: ReplanningState,
    event: Event,
    actual_plan: ProposedPlan,
    job_id: str,
    engineer_id: str,
    oracle: ExactRoutingOracle,
    *,
    max_route_checks: int = 400,
    urgent_slack_minutes: int = 15,
    urgent_ejection_gain_minutes: int = 45,
) -> CounterfactualResult:
    """Replay one event while forcing one not-started job to one engineer."""
    _check_query(dataset, job_id, engineer_id)
    applied = frozenset(source_state.applied_event_ids + (event.event_id,))
    frozen_owner = {
        visit.job_id: route.engineer_id
        for route in source_state.plan.engineer_plans
        for visit in route.visits
        if visit.departure_at <= event.event_time
    }
    post_canceled = set(source_state.canceled_job_ids)
    if event.event_type == EventType.CANCEL_JOB and event.target_id not in frozen_owner:
        post_canceled.add(event.target_id)
    post_unavailable = dict(source_state.unavailable_until_by_engineer)
    if event.event_type == EventType.ENGINEER_UNAVAILABLE:
        post_unavailable[event.target_id] = max(
            event.unavailable_until,
            post_unavailable.get(event.target_id, event.event_time),
        )
    actual_validation = validate_replanned_plan(
        dataset,
        actual_plan,
        source_state.plan,
        event_time=event.event_time,
        applied_event_ids=applied,
        canceled_job_ids=frozenset(post_canceled),
        unavailable_until_by_engineer=post_unavailable,
    )
    if actual_validation.status != ValidationStatus.VALID:
        raise InvalidPlanningData('Actual event plan must pass independent validation')
    actual_engineer, actual_start = _actual(actual_plan, job_id)
    if actual_engineer == engineer_id:
        return CounterfactualResult(
            CounterfactualStatus.ALREADY_ACTUAL, job_id, engineer_id,
            actual_engineer, actual_start, actual_plan, actual_validation, (),
            0, False, 'UNCHANGED', (),
            {key: 0 for key in _metric_delta(actual_validation, actual_validation)},
            _changes(actual_plan, actual_plan),
            'Заявка уже назначена выбранной бригаде; контрфактический план совпадает с фактическим.',
            'EXACT_VALIDATED',
        )

    if job_id in post_canceled:
        return _empty_result(
            CounterfactualStatus.STATICALLY_INELIGIBLE,
            actual_plan, job_id, engineer_id,
            rejection_codes=('CANCELED_BY_EVENT',),
            reason='Отменённую этим событием заявку нельзя назначить бригаде.',
            claim_level='EXACT_FACT',
        )
    if job_id in frozen_owner:
        return _empty_result(
            CounterfactualStatus.STARTED_ACTIVITY_FROZEN,
            actual_plan, job_id, engineer_id,
            rejection_codes=('STARTED_ACTIVITY_FROZEN',),
            reason='К моменту события бригада уже выехала; начатую активность менять нельзя.',
            claim_level='EXACT_FACT',
        )

    candidates = build_candidate_index(
        dataset, event.event_time, applied_event_ids=applied
    )
    rejection_codes = tuple(
        reason.value for reason in candidates.reasons(engineer_id, job_id)
    )
    if rejection_codes:
        return _empty_result(
            CounterfactualStatus.STATICALLY_INELIGIBLE,
            actual_plan, job_id, engineer_id,
            rejection_codes=rejection_codes,
            reason='Принудительная пара нарушает статические жёсткие ограничения.',
            claim_level='EXACT_FACT',
        )

    replanned = replan_after_event(
        dataset,
        source_state,
        event,
        oracle,
        max_route_checks=max_route_checks,
        urgent_slack_minutes=urgent_slack_minutes,
        urgent_ejection_gain_minutes=urgent_ejection_gain_minutes,
        forced_engineer_by_job={job_id: engineer_id},
    )
    if replanned.status == ReplanningStatus.ROUTING_INCOMPLETE or replanned.state is None:
        return _empty_result(
            CounterfactualStatus.ROUTING_INCOMPLETE,
            actual_plan, job_id, engineer_id,
            reason=replanned.detail or 'Маршрутные данные не подтверждены.',
            claim_level='ROUTING_UNVERIFIED',
            route_checks=replanned.exact_route_checks,
            budget_exhausted=replanned.budget_exhausted,
        )
    forced_actual, _ = _actual(replanned.state.plan, job_id)
    if forced_actual != engineer_id:
        reason_code = replanned.unserved_reasons.get(job_id, '')
        return _empty_result(
            CounterfactualStatus.SEARCH_LIMIT_REACHED
            if replanned.budget_exhausted
            else CounterfactualStatus.NO_LOCAL_FEASIBLE_PLAN,
            actual_plan, job_id, engineer_id,
            rejection_codes=(reason_code,) if reason_code else (),
            reason=(
                'Контрфактический поиск остановлен по лимиту; невозможность не доказана.'
                if replanned.budget_exhausted else
                'В проверенном локальном поиске принудительное назначение не найдено.'
            ),
            claim_level=(
                'SEARCH_LIMIT_REACHED' if replanned.budget_exhausted
                else 'LOCAL_IMPOSSIBILITY'
            ),
            route_checks=replanned.exact_route_checks,
            budget_exhausted=replanned.budget_exhausted,
        )
    selected = next(
        (
            item for item in replanned.candidate_evaluations.get(job_id, ())
            if item.selected
        ),
        None,
    )
    return CounterfactualResult(
        CounterfactualStatus.FEASIBLE, job_id, engineer_id,
        actual_engineer, actual_start,
        replanned.state.plan, replanned.validation, (),
        replanned.exact_route_checks, replanned.budget_exhausted,
        selected.move_kind if selected is not None else 'FORCED_REPLAN',
        ((selected.displaced_job_id,) if selected is not None
         and selected.displaced_job_id is not None else ()),
        _metric_delta(actual_validation, replanned.validation),
        _changes(actual_plan, replanned.state.plan),
        'Событие пересчитано с принудительным назначением; полный план независимо проверен.',
        'EXACT_VALIDATED',
    )


def counterfactual_result_dict(result: CounterfactualResult) -> dict[str, Any]:
    """Serialize the explanation without presenting a hypothetical plan as operational."""
    counterfactual_assignment = (
        _records(result.plan).get(result.job_id) if result.plan is not None else None
    )
    return {
        'status': result.status.value,
        'counterfactual_only': True,
        'publication_allowed': False,
        'query': {
            'job_id': result.job_id,
            'forced_engineer_id': result.forced_engineer_id,
        },
        'actual': {
            'engineer_id': result.actual_engineer_id,
            'service_start_at': result.actual_service_start_at,
        },
        'counterfactual': {
            'engineer_id': (
                counterfactual_assignment[0]
                if counterfactual_assignment is not None else None
            ),
            'service_start_at': (
                counterfactual_assignment[1]
                if counterfactual_assignment is not None else None
            ),
            'move_kind': result.move_kind,
            'displaced_job_ids': list(result.displaced_job_ids),
        },
        'explanation': {
            'summary_ru': result.reason,
            'claim_level': result.claim_level,
            'static_rejection_codes': list(result.static_rejection_codes),
            'forced_pair_infeasibility_proven': result.status in {
                CounterfactualStatus.STATICALLY_INELIGIBLE,
                CounterfactualStatus.STARTED_ACTIVITY_FROZEN,
            },
            'global_optimality_proven': False,
            'global_impossibility_proven': False,
        },
        'comparison': {
            'metrics_delta_counterfactual_minus_actual': result.metrics_delta,
            'changes': result.changes,
        },
        'search': {
            'exact_route_checks': result.route_checks,
            'budget_exhausted': result.budget_exhausted,
        },
    }
