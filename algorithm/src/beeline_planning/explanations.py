"""Auditable explanations derived only from planning facts and saved search evidence."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any, Mapping, Sequence

from beeline_routing.models import DetailedRoute

from .domain import Event, EventType, PlanningDataset, Priority, RequiredTransport
from .eligibility import RejectionCode, build_candidate_index
from .errors import InvalidPlanningData
from .plan import ProposedPlan
from .replanning import CandidateEvaluation
from .validator import ValidationReport, ValidationStatus


class ClaimLevel(StrEnum):
    EXACT_FACT = 'EXACT_FACT'
    EXACT_VALIDATED = 'EXACT_VALIDATED'
    BEST_CHECKED = 'BEST_CHECKED'
    LOCAL_IMPOSSIBILITY = 'LOCAL_IMPOSSIBILITY'
    PROVEN_INFEASIBLE = 'PROVEN_INFEASIBLE'
    SEARCH_LIMIT_REACHED = 'SEARCH_LIMIT_REACHED'
    ROUTING_UNVERIFIED = 'ROUTING_UNVERIFIED'


_UNSERVED_TEXT = {
    'NO_STATIC_ELIGIBLE_ENGINEER': (
        'Нет бригады своего района, одновременно удовлетворяющей навыку, '
        'транспорту, оснащению, смене и активным обязательствам.'
    ),
    'SHARED_STOCK_SHORTAGE': (
        'Заявка не назначена из-за подтверждённой нехватки общего расходного материала.'
    ),
    'NO_EXACT_FEASIBLE_INSERTION_IN_CURRENT_ROUTES': (
        'Точная допустимая вставка в рассмотренные текущие маршруты не найдена. '
        'Это не доказательство глобальной невозможности после полной перестройки.'
    ),
    'SEARCH_BUDGET_EXHAUSTED': (
        'Поиск остановлен по установленному лимиту. Невозможность выполнения не доказана.'
    ),
    'ROUTING_UNVERIFIED': (
        'Маршрутный источник не подтвердил все необходимые варианты. '
        'Заявка не объявляется физически недостижимой.'
    ),
    'STATIC_ELIGIBLE_BUT_UNSERVED': (
        'Есть статически подходящие бригады, но подтверждённый допустимый маршрут '
        'для заявки в опубликованном плане не найден.'
    ),
    'FORCED_ENGINEER_STATICALLY_INELIGIBLE': (
        'Выбранная пользователем бригада нарушает одно или несколько жёстких '
        'статических ограничений заявки.'
    ),
}


def _claim_for_reason(reason: str) -> ClaimLevel:
    if reason in {
        'NO_STATIC_ELIGIBLE_ENGINEER',
        'SHARED_STOCK_SHORTAGE',
        'FORCED_ENGINEER_STATICALLY_INELIGIBLE',
    }:
        return ClaimLevel.EXACT_FACT
    if reason == 'SEARCH_BUDGET_EXHAUSTED':
        return ClaimLevel.SEARCH_LIMIT_REACHED
    if reason == 'ROUTING_UNVERIFIED':
        return ClaimLevel.ROUTING_UNVERIFIED
    if reason == 'PROVEN_INFEASIBLE':
        return ClaimLevel.PROVEN_INFEASIBLE
    return ClaimLevel.LOCAL_IMPOSSIBILITY


def _candidate_dict(value: CandidateEvaluation) -> dict[str, Any]:
    return {
        'engineer_id': value.engineer_id,
        'move_kind': value.move_kind,
        'service_start_at': value.service_start_at.isoformat(),
        'response_minutes': value.response_minutes,
        'shifted_existing_minutes': value.shifted_existing_minutes,
        'added_engineers': value.added_engineers,
        'added_distance_m': value.added_distance_m,
        'displaced_job_id': value.displaced_job_id,
        'displaced_job_restored': value.displaced_job_restored,
        'selected': value.selected,
    }


def _urgent_selection_rationale(
    values: Sequence[CandidateEvaluation],
    urgency_policy: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    selected = next((value for value in values if value.selected), None)
    if selected is None:
        return None
    earliest = min(value.service_start_at for value in values)
    slack_minutes = int((urgency_policy or {}).get('near_earliest_slack_minutes', 0))
    cutoff = earliest + timedelta(minutes=slack_minutes)
    comparison = min(
        (value for value in values if not value.selected),
        key=lambda value: (
            value.service_start_at,
            value.shifted_existing_minutes,
            value.added_engineers,
            value.added_distance_m,
            value.engineer_id,
        ),
        default=None,
    )
    return {
        'policy': 'URGENT_EARLY_BAND_THEN_STABILITY',
        'ranking_order': [
            'service_start_within_early_band',
            'normal_jobs_lost',
            'shifted_existing_minutes',
            'added_engineers',
            'added_distance_m',
            'deterministic_tie_break',
        ],
        'saved_exact_feasible_alternatives': len(values),
        'earliest_saved_start_at': earliest.isoformat(),
        'near_earliest_cutoff_at': cutoff.isoformat(),
        'selected_inside_early_band': selected.service_start_at <= cutoff,
        'selected_impact': {
            'response_minutes': selected.response_minutes,
            'shifted_existing_minutes': selected.shifted_existing_minutes,
            'added_engineers': selected.added_engineers,
            'added_distance_m': selected.added_distance_m,
            'normal_jobs_lost': int(
                selected.displaced_job_id is not None
                and not selected.displaced_job_restored
            ),
        },
        'comparison_with_earliest_other_saved': (
            {
                'engineer_id': comparison.engineer_id,
                'service_start_at': comparison.service_start_at.isoformat(),
                'selected_starts_minutes_earlier': int(
                    (
                        comparison.service_start_at - selected.service_start_at
                    ).total_seconds()
                    // 60
                ),
                'selected_added_engineers_delta': (
                    selected.added_engineers - comparison.added_engineers
                ),
                'selected_added_distance_m_delta': (
                    selected.added_distance_m - comparison.added_distance_m
                ),
                'selected_shifted_minutes_delta': (
                    selected.shifted_existing_minutes
                    - comparison.shifted_existing_minutes
                ),
            }
            if comparison is not None else None
        ),
        'summary_ru': (
            f'Вариант {selected.engineer_id} попал в раннюю полосу до '
            f'{cutoff:%H:%M}. Внутри неё варианты сравнивались сначала по '
            'потере обычных заявок и сдвигу расписания, затем по числу новых '
            'бригад и добавочному пробегу.'
        ),
    }


def _records(plan: ProposedPlan) -> dict[str, tuple[str, int, Any]]:
    return {
        visit.job_id: (route.engineer_id, sequence, visit)
        for route in plan.engineer_plans
        for sequence, visit in enumerate(route.visits, 1)
    }


def _rejection_summary(dataset: PlanningDataset, candidates, job_id: str) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for engineer_id in dataset.engineers:
        for reason in candidates.reasons(engineer_id, job_id):
            counts[reason.value] += 1
    return dict(sorted(counts.items()))


def _static_checks(dataset: PlanningDataset, engineer_id: str, job_id: str) -> dict[str, str]:
    engineer = dataset.engineers[engineer_id]
    job = dataset.jobs[job_id]
    reusable_ok = all(
        not dataset.equipment_catalog[need.equipment_id].reusable
        or engineer.equipment_quantity(need.equipment_id) >= need.quantity
        for need in job.required_equipment
    )
    return {
        'zone': 'PASS' if engineer.zone_id == job.zone_id else 'FAIL',
        'skill': 'PASS' if job.required_skill in engineer.skills else 'FAIL',
        'transport': 'PASS' if (
            job.required_transport == RequiredTransport.ANY
            or engineer.transport_mode.value == job.required_transport.value
        ) else 'FAIL',
        'personal_equipment': 'PASS' if reusable_ok else 'FAIL',
        'time_window': 'PASS',
        'shift': 'PASS',
        'route_evidence': 'PASS',
    }


def _assigned_summary(
    job_id: str,
    engineer_id: str,
    service_start_at: datetime,
    *,
    event: Event | None,
    frozen: bool,
    changed_assignment: bool,
    shifted: bool,
) -> tuple[str, str]:
    if frozen:
        code = 'FROZEN_STARTED_ACTIVITY'
        text = (
            f'Заявка {job_id} сохранена у {engineer_id}: к моменту события '
            'бригада уже выехала, поэтому начатая активность не изменяется.'
        )
    elif event is not None and event.event_type == EventType.NEW_URGENT_JOB and job_id == event.target_id:
        code = 'EARLY_URGENT_WITH_CONTROLLED_DISRUPTION'
        text = (
            f'Срочная заявка {job_id} назначена {engineer_id} на '
            f'{service_start_at:%H:%M}. Выбран ранний точно допустимый вариант '
            'с учётом влияния на уже опубликованный план.'
        )
    elif changed_assignment:
        code = 'REASSIGNED_AFTER_EVENT'
        text = (
            f'После события заявка {job_id} переназначена на {engineer_id}; '
            'новый полный план прошёл независимую проверку.'
        )
    elif shifted:
        code = 'RESCHEDULED_AFTER_EVENT'
        text = (
            f'После события время заявки {job_id} изменено на '
            f'{service_start_at:%H:%M}; исполнитель сохранён.'
        )
    else:
        code = 'EXACT_VALID_ASSIGNMENT'
        text = (
            f'Заявка {job_id} назначена {engineer_id} на {service_start_at:%H:%M}; '
            'район, навык, транспорт, оборудование, окно и смена проверены.'
        )
    return code, text


def build_explanation_bundle(
    dataset: PlanningDataset,
    plan: ProposedPlan,
    validation: ValidationReport,
    *,
    explanation_at: datetime | None = None,
    applied_event_ids: frozenset[str] = frozenset(),
    canceled_job_ids: frozenset[str] = frozenset(),
    previous_plan: ProposedPlan | None = None,
    event: Event | None = None,
    unserved_reasons: Mapping[str, str] | None = None,
    insertion_diagnostics: Mapping[str, Mapping[str, int]] | None = None,
    candidate_evaluations: Mapping[str, Sequence[CandidateEvaluation]] | None = None,
    search_budget_exhausted: bool = False,
    exact_route_checks: int | None = None,
    exact_provider_queries: int | None = None,
    global_optimality_proven: bool = False,
    urgency_policy: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build concise Russian explanations without inventing causal claims."""
    if validation.status != ValidationStatus.VALID:
        raise InvalidPlanningData('Explanations require an independently valid plan')
    moment = explanation_at or (
        event.event_time if event is not None else plan.planning_at
    )
    candidates = build_candidate_index(
        dataset, moment, applied_event_ids=applied_event_ids
    )
    current = _records(plan)
    previous = _records(previous_plan) if previous_plan is not None else {}
    active_job_ids = {
        job.job_id for job in dataset.active_jobs_at(moment)
        if job.job_id not in canceled_job_ids
    }
    reason_map = dict(unserved_reasons or {})
    diagnostics = insertion_diagnostics or {}
    alternatives = candidate_evaluations or {}
    jobs: list[dict[str, Any]] = []

    for job_id in sorted(active_job_ids):
        job = dataset.jobs[job_id]
        eligible = candidates.eligible_engineers_by_job.get(job_id, ())
        base: dict[str, Any] = {
            'job_id': job_id,
            'priority': job.priority.value,
            'zone_id': job.zone_id,
            'required_skill': job.required_skill,
            'required_transport': job.required_transport.value,
            'static_eligible_engineers': len(eligible),
            'static_rejection_counts': _rejection_summary(dataset, candidates, job_id),
        }
        if job_id in current:
            engineer_id, sequence, visit = current[job_id]
            old = previous.get(job_id)
            frozen = bool(
                event is not None and old is not None
                and old[2].departure_at <= event.event_time
            )
            changed_assignment = old is not None and old[0] != engineer_id
            shifted = old is not None and old[2].service_start_at != visit.service_start_at
            code, summary = _assigned_summary(
                job_id, engineer_id, visit.service_start_at,
                event=event, frozen=frozen,
                changed_assignment=changed_assignment, shifted=shifted,
            )
            route = visit.travel
            base.update({
                'status': 'ASSIGNED',
                'decision_kind': code,
                'summary_ru': summary,
                'claim_level': ClaimLevel.EXACT_VALIDATED.value,
                'optimality': (
                    'PROVEN_OPTIMAL' if global_optimality_proven
                    else 'BEST_CHECKED_NOT_GLOBAL_OPTIMUM'
                ),
                'engineer_id': engineer_id,
                'sequence': sequence,
                'departure_at': visit.departure_at.isoformat(),
                'service_start_at': visit.service_start_at.isoformat(),
                'service_end_at': (
                    visit.service_start_at
                    + timedelta(minutes=job.service_duration_min)
                ).isoformat(),
                'response_minutes': int(
                    (
                        visit.service_start_at
                        - max(plan.planning_at, job.created_at)
                    ).total_seconds()
                    // 60
                ),
                'constraint_checks': _static_checks(dataset, engineer_id, job_id),
                'travel': {
                    'duration_minutes': route.duration_minutes,
                    'distance_m': route.distance_m,
                    'origin_location_id': route.origin_id,
                    'destination_location_id': route.destination_id,
                    'evidence_type': (
                        'PROVIDER_ROUTE' if isinstance(route, DetailedRoute) else 'IDENTITY'
                    ),
                },
                'change_from_previous_plan': {
                    'frozen_started_activity': frozen,
                    'assignment_changed': changed_assignment,
                    'time_changed': shifted,
                    'previous_engineer_id': old[0] if old is not None else None,
                    'previous_service_start_at': (
                        old[2].service_start_at.isoformat() if old is not None else None
                    ),
                },
                'checked_alternatives': [
                    _candidate_dict(item) for item in alternatives.get(job_id, ())
                ],
                'selection_rationale': _urgent_selection_rationale(
                    alternatives.get(job_id, ()), urgency_policy
                ),
            })
        else:
            reason = reason_map.get(job_id)
            if reason is None:
                reason = (
                    'NO_STATIC_ELIGIBLE_ENGINEER' if not eligible
                    else 'STATIC_ELIGIBLE_BUT_UNSERVED'
                )
            detail = dict(diagnostics.get(job_id, {}))
            if detail and reason == 'STATIC_ELIGIBLE_BUT_UNSERVED':
                reason = 'NO_EXACT_FEASIBLE_INSERTION_IN_CURRENT_ROUTES'
            base.update({
                'status': 'UNSERVED',
                'decision_kind': reason,
                'summary_ru': _UNSERVED_TEXT.get(
                    reason,
                    'Заявка не назначена; причина сохранена в структурированном протоколе.',
                ),
                'claim_level': _claim_for_reason(reason).value,
                'optimality': (
                    'PROVEN_INFEASIBLE' if reason == 'PROVEN_INFEASIBLE'
                    else 'GLOBAL_IMPOSSIBILITY_NOT_PROVEN'
                ),
                'diagnostics': detail,
                'checked_alternatives': [
                    _candidate_dict(item) for item in alternatives.get(job_id, ())
                ],
            })
        jobs.append(base)

    event_explanation = None
    if event is not None:
        frozen_count = sum(
            old[2].departure_at <= event.event_time for old in previous.values()
        )
        changed_assignments = sum(
            job_id in current and current[job_id][0] != old[0]
            for job_id, old in previous.items()
        )
        shifted_jobs = sum(
            job_id in current
            and current[job_id][2].service_start_at != old[2].service_start_at
            for job_id, old in previous.items()
        )
        removed_jobs = sorted(set(previous) - set(current) - canceled_job_ids)
        event_explanation = {
            'event_id': event.event_id,
            'event_type': event.event_type.value,
            'event_time': event.event_time.isoformat(),
            'target_id': event.target_id,
            'zone_id': event.zone_id,
            'frozen_started_visits': frozen_count,
            'changed_assignments': changed_assignments,
            'shifted_existing_jobs': shifted_jobs,
            'removed_but_not_canceled_jobs': removed_jobs,
            'summary_ru': (
                f'Событие {event.event_id} обработано. Начатых визитов сохранено: '
                f'{frozen_count}; переназначений: {changed_assignments}; '
                f'сдвигов времени: {shifted_jobs}.'
            ),
        }

    return {
        'schema_version': '1.0.0',
        'language': 'ru',
        'generated_from_structured_facts': True,
        'free_form_model_used': False,
        'event': event_explanation,
        'jobs': jobs,
        'run_certificate': {
            'dataset_sha256': dataset.dataset_sha256,
            'validation_status': validation.status.value,
            'validation_violations': len(validation.violations),
            'publication_allowed': validation.status == ValidationStatus.VALID,
            'coverage_complete': not plan.unserved_job_ids,
            'served_jobs': (
                validation.metrics.served_urgent_jobs
                + validation.metrics.served_normal_jobs
            ),
            'unserved_jobs': (
                validation.metrics.unserved_urgent_jobs
                + validation.metrics.unserved_normal_jobs
            ),
            'global_optimality_proven': global_optimality_proven,
            'search_budget_exhausted': search_budget_exhausted,
            'exact_route_checks': exact_route_checks,
            'exact_provider_queries': exact_provider_queries,
            'urgency_policy': dict(urgency_policy or {}),
            'claim_legend': {
                item.value: {
                    ClaimLevel.EXACT_FACT: 'Факт напрямую следует из входных данных.',
                    ClaimLevel.EXACT_VALIDATED: (
                        'План, включая явный список неназначенных заявок, '
                        'прошёл независимую проверку.'
                    ),
                    ClaimLevel.BEST_CHECKED: 'Лучший из сохранённых проверенных вариантов.',
                    ClaimLevel.LOCAL_IMPOSSIBILITY: 'Нет решения в проверенном локальном поиске.',
                    ClaimLevel.PROVEN_INFEASIBLE: 'Невозможность доказана решателем.',
                    ClaimLevel.SEARCH_LIMIT_REACHED: 'Поиск остановлен по лимиту.',
                    ClaimLevel.ROUTING_UNVERIFIED: 'Маршрутные данные не подтверждены.',
                }[item]
                for item in ClaimLevel
            },
        },
    }
