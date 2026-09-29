"""Exact, conservative rolling-horizon replanning after a daytime event.

This is an anytime feasibility heuristic, not an optimality claim. It preserves
started visits, keeps still-feasible future assignments, and repairs the suffix
using exact, departure-time routing before independent full-plan validation.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Callable, Mapping

from beeline_routing.errors import RoutingError
from beeline_routing.models import RouteStatus, TransportMode
from beeline_routing.oracle import ExactRoutingOracle, OracleQuery

from .domain import Event, EventType, PlanningDataset, Priority
from .departure_timing import retime_replanned_departures
from .eligibility import build_candidate_index
from .errors import InvalidPlanningData
from .plan import EngineerPlan, IdentityTravel, PlannedVisit, ProposedPlan
from .validator import (
    ValidationReport,
    ValidationStatus,
    validate_initial_plan,
    validate_replanned_plan,
)


class ReplanningStatus(StrEnum):
    EXACT_VALID = 'EXACT_VALID'
    ROUTING_INCOMPLETE = 'ROUTING_INCOMPLETE'
    REJECTED_ALREADY_STARTED = 'REJECTED_ALREADY_STARTED'


@dataclass(frozen=True, slots=True)
class ReplanningState:
    plan: ProposedPlan
    applied_event_ids: tuple[str, ...] = ()
    canceled_job_ids: frozenset[str] = frozenset()
    unavailable_until_by_engineer: Mapping[str, datetime] = field(default_factory=dict)
    last_event_time: datetime | None = None


@dataclass(frozen=True, slots=True)
class CandidateEvaluation:
    """One exact-feasible alternative considered for an urgent insertion."""

    engineer_id: str
    move_kind: str
    service_start_at: datetime
    response_minutes: int
    shifted_existing_minutes: int
    added_engineers: int
    added_distance_m: int
    displaced_job_id: str | None
    displaced_job_restored: bool
    selected: bool


@dataclass(frozen=True, slots=True)
class ReplanningResult:
    status: ReplanningStatus
    state: ReplanningState | None
    validation: ValidationReport | None
    event_id: str
    exact_route_checks: int
    budget_exhausted: bool
    unserved_reasons: Mapping[str, str]
    detail: str = ''
    candidate_evaluations: Mapping[str, tuple[CandidateEvaluation, ...]] = field(
        default_factory=dict
    )
    departure_timing_queries: int = 0
    departure_timing_changes: int = 0


@dataclass(frozen=True, slots=True)
class _RouteTrial:
    visits: tuple[PlannedVisit, ...] | None
    failed_job_id: str | None = None
    reason: str = ''


@dataclass(frozen=True, slots=True)
class _InsertionCandidate:
    engineer_id: str
    order: tuple[str, ...]
    urgent_start: datetime
    shifted_minutes: int
    added_engineers: int
    added_distance_m: int
    displaced_job_id: str | None = None
    restored_engineer_id: str | None = None
    restored_order: tuple[str, ...] | None = None

    @property
    def normal_jobs_lost(self) -> int:
        return int(self.displaced_job_id is not None and self.restored_order is None)


class _RoutingIncomplete(Exception):
    pass


def _started_prefix(route: EngineerPlan | None, at: datetime) -> tuple[PlannedVisit, ...]:
    if route is None:
        return ()
    return tuple(visit for visit in route.visits if visit.departure_at <= at)


def _check_next_event(dataset: PlanningDataset, state: ReplanningState, event: Event) -> None:
    ordered = dataset.events
    index = len(state.applied_event_ids)
    if state.applied_event_ids != tuple(item.event_id for item in ordered[:index]):
        raise InvalidPlanningData('Applied event IDs are not a dataset-order prefix')
    expected_time = ordered[index - 1].event_time if index else None
    if state.last_event_time != expected_time:
        raise InvalidPlanningData('Replanning state has an inconsistent last event time')
    cancellation_targets = {
        item.target_id for item in ordered[:index]
        if item.event_type == EventType.CANCEL_JOB
    }
    if not state.canceled_job_ids <= cancellation_targets:
        raise InvalidPlanningData('Canceled jobs are not supported by applied events')
    expected_unavailability: dict[str, datetime] = {}
    for applied in ordered[:index]:
        if applied.event_type == EventType.ENGINEER_UNAVAILABLE:
            expected_unavailability[applied.target_id] = max(
                applied.unavailable_until,
                expected_unavailability.get(applied.target_id, applied.event_time),
            )
        elif applied.event_type == EventType.CAPACITY_ADDED:
            expected_unavailability.pop(applied.target_id, None)
    if dict(state.unavailable_until_by_engineer) != expected_unavailability:
        raise InvalidPlanningData('Unavailability state differs from applied events')
    if index >= len(ordered) or ordered[index] != event:
        raise InvalidPlanningData('Events must be applied exactly once in dataset order')
    if event.event_time < (state.last_event_time or dataset.initial_planning_at):
        raise InvalidPlanningData('Event time precedes current planning state')
    if state.plan.planning_at > event.event_time:
        raise InvalidPlanningData('Source plan was created after the event')
    if event.zone_id not in {engineer.zone_id for engineer in dataset.engineers.values()}:
        raise InvalidPlanningData('Event references an unknown zone')
    if event.event_type in {EventType.ENGINEER_UNAVAILABLE, EventType.CAPACITY_ADDED}:
        engineer = dataset.engineers.get(event.target_id)
        if engineer is None or engineer.zone_id != event.zone_id:
            raise InvalidPlanningData('Engineer and event zone differ')
        if event.event_type == EventType.ENGINEER_UNAVAILABLE and (
            event.unavailable_until is None or event.unavailable_until <= event.event_time
        ):
            raise InvalidPlanningData('Engineer unavailability requires a later end time')
    else:
        job = dataset.jobs.get(event.target_id)
        if job is None or job.zone_id != event.zone_id:
            raise InvalidPlanningData('Event job and event zone differ')
        if event.event_type == EventType.CANCEL_JOB and job.created_at > event.event_time:
            raise InvalidPlanningData('Cannot cancel a job before it exists')
        if event.event_type in {EventType.NEW_JOB, EventType.NEW_URGENT_JOB}:
            if job.created_at != event.event_time:
                raise InvalidPlanningData('New job must be created at event time')
            if event.event_type == EventType.NEW_URGENT_JOB and job.priority != Priority.URGENT:
                raise InvalidPlanningData('New urgent job must be urgent')


def _static_eligible(dataset: PlanningDataset, engineer_id: str, job_id: str) -> bool:
    engineer = dataset.engineers[engineer_id]
    job = dataset.jobs[job_id]
    if not engineer.is_available or engineer.zone_id != job.zone_id:
        return False
    if job.required_skill not in engineer.skills:
        return False
    if not job.required_transport.allows(engineer.transport_mode):
        return False
    return all(
        not dataset.equipment_catalog[need.equipment_id].reusable
        or engineer.equipment_quantity(need.equipment_id) >= need.quantity
        for need in job.required_equipment
    )


def replan_after_event(
    dataset: PlanningDataset,
    state: ReplanningState,
    event: Event,
    oracle: ExactRoutingOracle,
    *,
    max_route_checks: int = 400,
    urgent_slack_minutes: int = 15,
    urgent_ejection_gain_minutes: int = 45,
    forced_engineer_by_job: Mapping[str, str] | None = None,
    source_dataset: PlanningDataset | None = None,
    progress_callback: Callable[[int], None] | None = None,
    rebuild_future: bool = False,
) -> ReplanningResult:
    """Apply one ordered event and return an exactly validated full-day plan.

    Search is bounded and may leave jobs unserved; it never claims optimality.
    Every started visit remains byte-for-byte the same logical route evidence.
    An unknown route on a required unchanged route blocks publication.
    """
    if max_route_checks < 1:
        raise ValueError('max_route_checks must be positive')
    if urgent_slack_minutes < 0 or urgent_ejection_gain_minutes < 1:
        raise ValueError('Urgency thresholds must be non-negative and positive respectively')
    forced_assignments = dict(forced_engineer_by_job or {})
    if len(forced_assignments) > 1:
        raise ValueError('At most one forced assignment is supported per run')
    for job_id, engineer_id in forced_assignments.items():
        if job_id not in dataset.jobs:
            raise InvalidPlanningData(f'Forced assignment has unknown job: {job_id}')
        if engineer_id not in dataset.engineers:
            raise InvalidPlanningData(
                f'Forced assignment has unknown engineer: {engineer_id}'
            )
    _check_next_event(dataset, state, event)
    if not state.applied_event_ids:
        source_validation = validate_initial_plan(source_dataset or dataset, state.plan)
    else:
        previous_event = dataset.events[len(state.applied_event_ids) - 1]
        source_validation = validate_replanned_plan(
            source_dataset or dataset,
            state.plan,
            state.plan,
            event_time=previous_event.event_time,
            applied_event_ids=frozenset(state.applied_event_ids),
            canceled_job_ids=state.canceled_job_ids,
            unavailable_until_by_engineer=state.unavailable_until_by_engineer,
        )
    if source_validation.status != ValidationStatus.VALID:
        raise InvalidPlanningData('Source plan must pass independent validation')

    old_routes = {route.engineer_id: route for route in state.plan.engineer_plans}
    frozen = {
        engineer_id: _started_prefix(old_routes.get(engineer_id), event.event_time)
        for engineer_id in dataset.engineers
    }
    frozen_job_ids = {visit.job_id for route in frozen.values() for visit in route}
    new_applied = state.applied_event_ids + (event.event_id,)
    canceled = set(state.canceled_job_ids)
    unavailable = dict(state.unavailable_until_by_engineer)
    if event.event_type == EventType.CANCEL_JOB:
        if event.target_id in canceled:
            raise InvalidPlanningData('Job is already canceled')
        if event.target_id in frozen_job_ids:
            next_state = ReplanningState(
                plan=state.plan,
                applied_event_ids=new_applied,
                canceled_job_ids=state.canceled_job_ids,
                unavailable_until_by_engineer=unavailable,
                last_event_time=event.event_time,
            )
            validation = validate_replanned_plan(
                dataset, state.plan, state.plan,
                event_time=event.event_time,
                applied_event_ids=frozenset(new_applied),
                canceled_job_ids=state.canceled_job_ids,
                unavailable_until_by_engineer=unavailable,
            )
            return ReplanningResult(
                ReplanningStatus.REJECTED_ALREADY_STARTED, next_state, validation,
                event.event_id, 0, False, {}, 'Cancellation rejected after departure',
            )
        canceled.add(event.target_id)
    elif event.event_type == EventType.ENGINEER_UNAVAILABLE:
        unavailable[event.target_id] = max(
            event.unavailable_until,
            unavailable.get(event.target_id, event.event_time),
        )
    elif event.event_type == EventType.CAPACITY_ADDED:
        unavailable.pop(event.target_id, None)

    active_job_ids = {
        job.job_id for job in dataset.active_jobs_at(event.event_time)
        if job.job_id not in canceled
    }
    if not frozen_job_ids <= active_job_ids:
        raise InvalidPlanningData('An already-started job cannot be removed from the active day')
    if not set(forced_assignments) <= active_job_ids:
        raise InvalidPlanningData('Forced assignment references an inactive job')
    frozen_owner = {
        visit.job_id: engineer_id
        for engineer_id, visits in frozen.items() for visit in visits
    }
    for job_id, engineer_id in forced_assignments.items():
        if job_id in frozen_owner and frozen_owner[job_id] != engineer_id:
            raise InvalidPlanningData(
                f'Forced assignment would change started activity: {job_id}'
            )
    commitments = {
        commitment.job_id: commitment.engineer_id
        for commitment in dataset.active_commitments_at(
            event.event_time, frozenset(new_applied)
        ) if commitment.job_id in active_job_ids
    }
    candidates = build_candidate_index(
        dataset, event.event_time, applied_event_ids=frozenset(new_applied)
    )

    def eligible_engineers(job_id: str) -> tuple[str, ...]:
        eligible = candidates.eligible_engineers_by_job.get(job_id, ())
        forced = forced_assignments.get(job_id)
        if forced is None:
            return eligible
        return (forced,) if forced in eligible else ()

    original_owner = {
        visit.job_id: route.engineer_id
        for route in state.plan.engineer_plans for visit in route.visits
    }
    original_departure = {
        visit.job_id: visit.departure_at
        for route in state.plan.engineer_plans for visit in route.visits
    }
    original_visits = {
        visit.job_id: visit
        for route in state.plan.engineer_plans for visit in route.visits
    }
    orders: dict[str, tuple[str, ...]] = {
        engineer_id: tuple(
            visit.job_id for visit in old_routes.get(
                engineer_id, EngineerPlan(engineer_id, ())
            ).visits if visit.departure_at > event.event_time
            and visit.job_id in active_job_ids
            and forced_assignments.get(visit.job_id, engineer_id) == engineer_id
        ) if not rebuild_future else ()
        for engineer_id in dataset.engineers
    }
    exact_checks = 0
    budget_exhausted = False
    unknown_by_job: set[str] = set()
    trial_cache: dict[tuple[str, tuple[str, ...]], _RouteTrial] = {}
    leg_cache: dict[tuple[str, str, str, datetime], object] = {}

    def schedule(engineer_id: str, order: tuple[str, ...]) -> _RouteTrial:
        nonlocal exact_checks, budget_exhausted
        key = (engineer_id, order)
        if key in trial_cache:
            return trial_cache[key]
        original_route = old_routes.get(engineer_id)
        original_suffix = tuple(
            visit.job_id for visit in original_route.visits
            if visit.departure_at > event.event_time
        ) if original_route else ()
        newly_unavailable = (
            event.event_type == EventType.ENGINEER_UNAVAILABLE
            and event.target_id == engineer_id
            and any(
                event.event_time < visit.departure_at < event.unavailable_until
                for visit in original_route.visits
            )
        ) if original_route else False
        shifted_window = (
            event.event_type == EventType.WINDOW_SHIFT
            and original_route is not None
            and any(
                visit.job_id == event.target_id
                and not dataset.jobs[visit.job_id].window_start <= visit.service_start_at <= dataset.jobs[visit.job_id].window_end
                for visit in original_route.visits
            )
        )
        # The source plan is independently validated above. An untouched route
        # has the same job order and exact route evidence after this event.
        if order == original_suffix and not newly_unavailable and not shifted_window:
            result = _RouteTrial(original_route.visits if original_route else ())
            trial_cache[key] = result
            return result
        if exact_checks >= max_route_checks:
            budget_exhausted = True
            return _RouteTrial(None, order[0] if order else None, 'SEARCH_BUDGET_EXHAUSTED')
        exact_checks += 1
        if progress_callback is not None and exact_checks % 25 == 0:
            progress_callback(exact_checks)
        engineer = dataset.engineers[engineer_id]
        visits = list(frozen[engineer_id])
        if len(visits) + len(order) > engineer.max_jobs:
            result = _RouteTrial(None, order[0] if order else None, 'MAX_JOBS')
            trial_cache[key] = result
            return result
        previous_location = (
            dataset.jobs[visits[-1].job_id].location_id if visits
            else dataset.offices[engineer.start_office_id].location_id
        )
        previous_completion = (
            visits[-1].service_start_at + timedelta(
                minutes=dataset.jobs[visits[-1].job_id].service_duration_min
            ) if visits else None
        )
        first_departure = visits[0].departure_at if visits else None
        for job_id in order:
            job = dataset.jobs[job_id]
            if not _static_eligible(dataset, engineer_id, job_id):
                result = _RouteTrial(None, job_id, 'STATIC_CONSTRAINT')
                trial_cache[key] = result
                return result
            if commitments.get(job_id, engineer_id) != engineer_id:
                result = _RouteTrial(None, job_id, 'HARD_COMMITMENT')
                trial_cache[key] = result
                return result
            departure = max(
                event.event_time,
                engineer.shift_start,
                job.created_at,
                unavailable.get(engineer_id, event.event_time),
                previous_completion or event.event_time,
                original_departure.get(job_id, event.event_time)
                if not rebuild_future and original_owner.get(job_id) == engineer_id
                else event.event_time,
            )
            if departure > job.window_end or departure >= engineer.shift_end:
                result = _RouteTrial(None, job_id, 'TIME_WINDOW_OR_SHIFT')
                trial_cache[key] = result
                return result

            def exact_leg(at: datetime):
                old_visit = original_visits.get(job_id)
                if (
                    old_visit is not None
                    and original_owner[job_id] == engineer_id
                    and old_visit.departure_at == at
                    and old_visit.travel.origin_id == previous_location
                    and old_visit.travel.destination_id == job.location_id
                ):
                    return old_visit.travel
                if previous_location == job.location_id:
                    return IdentityTravel(previous_location, at)
                leg_key = (engineer_id, previous_location, job.location_id, at)
                if leg_key not in leg_cache:
                    try:
                        leg_cache[leg_key] = oracle.query(OracleQuery(
                            mode=engineer.transport_mode,
                            origin=dataset.locations[previous_location],
                            destination=dataset.locations[job.location_id],
                            departure_at=at,
                        ))
                    except RoutingError as error:
                        raise _RoutingIncomplete(str(error)) from error
                return leg_cache[leg_key]

            travel = exact_leg(departure)
            if not isinstance(travel, IdentityTravel) and travel.status == RouteStatus.UNKNOWN:
                raise _RoutingIncomplete(
                    f'UNKNOWN {previous_location}->{job.location_id} at {departure.isoformat()}'
                )
            if not isinstance(travel, IdentityTravel) and travel.status == RouteStatus.UNREACHABLE:
                result = _RouteTrial(None, job_id, 'UNREACHABLE')
                trial_cache[key] = result
                return result
            arrival = departure + timedelta(minutes=travel.duration_minutes)
            # Waiting before the first activity can consume the whole route limit.
            # Shift departure close to the window and ask the router again at that minute.
            if first_departure is None and arrival < job.window_start:
                delayed_at = departure + (job.window_start - arrival)
                delayed = exact_leg(delayed_at)
                if not isinstance(delayed, IdentityTravel) and delayed.status == RouteStatus.UNKNOWN:
                    raise _RoutingIncomplete(
                        f'UNKNOWN {previous_location}->{job.location_id} at {delayed_at.isoformat()}'
                    )
                if isinstance(delayed, IdentityTravel) or delayed.status == RouteStatus.OK:
                    delayed_arrival = delayed_at + timedelta(minutes=delayed.duration_minutes)
                    if delayed_arrival <= job.window_end:
                        departure, travel, arrival = delayed_at, delayed, delayed_arrival
            service_start = max(arrival, job.window_start)
            service_end = service_start + timedelta(minutes=job.service_duration_min)
            if (
                service_start > job.window_end
                or service_end > engineer.shift_end
                or service_end - (first_departure or departure)
                > timedelta(minutes=engineer.max_route_minutes)
            ):
                result = _RouteTrial(None, job_id, 'TIME_WINDOW_SHIFT_OR_ROUTE_LIMIT')
                trial_cache[key] = result
                return result
            visits.append(PlannedVisit(job_id, departure, service_start, travel))
            first_departure = first_departure or departure
            previous_location = job.location_id
            previous_completion = service_end
        result = _RouteTrial(tuple(visits))
        trial_cache[key] = result
        return result

    # Recheck old route suffixes. A hard event may make a previously planned
    # visit impossible; release only that future visit, not any started prefix.
    try:
        for engineer_id in sorted(orders):
            while True:
                trial = schedule(engineer_id, orders[engineer_id])
                if trial.visits is not None:
                    break
                if trial.reason == 'SEARCH_BUDGET_EXHAUSTED':
                    return ReplanningResult(
                        ReplanningStatus.ROUTING_INCOMPLETE, None, None,
                        event.event_id, exact_checks, True, {},
                        'Budget exhausted before current routes were revalidated',
                    )
                if trial.failed_job_id is None:
                    raise InvalidPlanningData('Invalid frozen route cannot be repaired')
                if trial.failed_job_id in commitments:
                    raise InvalidPlanningData(
                        f'Active commitment is infeasible after event: {trial.failed_job_id}'
                    )
                orders[engineer_id] = tuple(
                    job_id for job_id in orders[engineer_id]
                    if job_id != trial.failed_job_id
                )
    except _RoutingIncomplete as error:
        return ReplanningResult(
            ReplanningStatus.ROUTING_INCOMPLETE, None, None,
            event.event_id, exact_checks, budget_exhausted, {}, str(error),
        )

    def assigned_jobs() -> set[str]:
        return frozen_job_ids | {job_id for order in orders.values() for job_id in order}

    inventory_available = {
        (item.zone_id, item.equipment_id): item.quantity_available
        for item in dataset.shared_inventory
    }

    stock_usage: Counter[tuple[str, str]] = Counter()

    def refresh_stock_usage() -> None:
        stock_usage.clear()
        for assigned_id in assigned_jobs():
            assigned_job = dataset.jobs[assigned_id]
            for need in assigned_job.required_equipment:
                if dataset.equipment_catalog[need.equipment_id].shared_stock:
                    stock_usage[assigned_job.zone_id, need.equipment_id] += need.quantity

    def stock_allows(job_id: str, removed: str | None = None) -> bool:
        job = dataset.jobs[job_id]
        removed_job = dataset.jobs[removed] if removed else None
        return all(
            not dataset.equipment_catalog[need.equipment_id].shared_stock
            or stock_usage[job.zone_id, need.equipment_id]
            - (sum(
                old_need.quantity for old_need in removed_job.required_equipment
                if old_need.equipment_id == need.equipment_id
            ) if removed_job is not None and removed_job.zone_id == job.zone_id else 0)
            + need.quantity
            <= inventory_available.get((job.zone_id, need.equipment_id), 0)
            for need in job.required_equipment
        )

    pending = sorted(
        active_job_ids - assigned_jobs(),
        key=lambda job_id: (
            not (rebuild_future and job_id == event.target_id
                 and event.event_type in {EventType.NEW_JOB, EventType.NEW_URGENT_JOB}),
            dataset.jobs[job_id].priority != Priority.URGENT,
            dataset.jobs[job_id].window_end,
            job_id,
        ),
    )
    reasons: dict[str, str] = {}
    candidate_evaluations: dict[str, tuple[CandidateEvaluation, ...]] = {}

    def candidate_for(
        engineer_id: str,
        old_order: tuple[str, ...],
        new_order: tuple[str, ...],
        trial: _RouteTrial,
        job_id: str,
        *,
        displaced: str | None = None,
        restoration: tuple[str, tuple[str, ...], _RouteTrial] | None = None,
    ) -> _InsertionCandidate:
        old_visits = schedule(engineer_id, old_order).visits or ()
        new_visits = trial.visits or ()
        old_starts = {visit.job_id: visit.service_start_at for visit in old_visits}
        shifted = sum(
            abs(int((visit.service_start_at - old_starts[visit.job_id]).total_seconds() // 60))
            for visit in new_visits if visit.job_id in old_starts
        )
        added_engineers = int(not bool(frozen[engineer_id] or old_order))
        added_distance = (
            sum(visit.travel.distance_m for visit in new_visits)
            - sum(visit.travel.distance_m for visit in old_visits)
        )
        restored_engineer_id = None
        restored_order = None
        if restoration is not None:
            restored_engineer_id, restored_order, restored_trial = restoration
            restored_old_order = orders[restored_engineer_id]
            restored_old_visits = schedule(restored_engineer_id, restored_old_order).visits or ()
            restored_new_visits = restored_trial.visits or ()
            restored_starts = {
                visit.job_id: visit.service_start_at for visit in restored_old_visits
            }
            shifted += sum(
                abs(int((visit.service_start_at - restored_starts[visit.job_id]).total_seconds() // 60))
                for visit in restored_new_visits if visit.job_id in restored_starts
            )
            added_engineers += int(not bool(
                frozen[restored_engineer_id] or restored_old_order
            ))
            added_distance += (
                sum(visit.travel.distance_m for visit in restored_new_visits)
                - sum(visit.travel.distance_m for visit in restored_old_visits)
            )
        inserted = next(visit for visit in new_visits if visit.job_id == job_id)
        return _InsertionCandidate(
            engineer_id, new_order, inserted.service_start_at,
            shifted, added_engineers, added_distance,
            displaced, restored_engineer_id, restored_order,
        )

    def choose_urgent(options: list[_InsertionCandidate]) -> _InsertionCandidate | None:
        if not options:
            return None
        earliest = min(item.urgent_start for item in options)
        near_earliest = [
            item for item in options
            if item.urgent_start <= earliest + timedelta(minutes=urgent_slack_minutes)
        ]
        return min(near_earliest, key=lambda item: (
            item.normal_jobs_lost,
            item.shifted_minutes,
            item.added_engineers,
            item.added_distance_m,
            item.urgent_start,
            item.engineer_id,
            item.order,
        ))

    def can_fit_time_lower_bound(
        engineer_id: str, old_order: tuple[str, ...], position: int, job_id: str
    ) -> bool:
        """Skip insertions impossible even with zero travel time."""
        engineer = dataset.engineers[engineer_id]
        if len(frozen[engineer_id]) + len(old_order) >= engineer.max_jobs:
            return False
        previous_visits = schedule(engineer_id, old_order).visits or ()
        prefix_length = len(frozen[engineer_id]) + position
        previous = previous_visits[prefix_length - 1] if prefix_length else None
        next_visit = (
            previous_visits[prefix_length]
            if prefix_length < len(previous_visits) else None
        )
        job = dataset.jobs[job_id]
        earliest_departure = max(
            event.event_time,
            engineer.shift_start,
            job.created_at,
            unavailable.get(engineer_id, event.event_time),
            previous.service_start_at + timedelta(
                minutes=dataset.jobs[previous.job_id].service_duration_min
            ) if previous else event.event_time,
            original_departure.get(job_id, event.event_time)
            if not rebuild_future and original_owner.get(job_id) == engineer_id
            else event.event_time,
        )
        earliest_finish = max(earliest_departure, job.window_start) + timedelta(
            minutes=job.service_duration_min
        )
        return (
            earliest_departure <= job.window_end
            and earliest_finish <= engineer.shift_end
            and (next_visit is None or earliest_finish <= dataset.jobs[next_visit.job_id].window_end)
        )

    for job_id in pending:
        if budget_exhausted:
            reasons[job_id] = 'SEARCH_BUDGET_EXHAUSTED'
            continue
        refresh_stock_usage()
        stock_is_available = stock_allows(job_id)
        direct_options: list[_InsertionCandidate] = []
        for engineer_id in eligible_engineers(job_id) if stock_is_available else ():
            if dataset.engineers[engineer_id].zone_id != dataset.jobs[job_id].zone_id:
                continue
            old_order = orders[engineer_id]
            for position in range(len(old_order) + 1):
                if not can_fit_time_lower_bound(engineer_id, old_order, position, job_id):
                    continue
                candidate_order = old_order[:position] + (job_id,) + old_order[position:]
                try:
                    trial = schedule(engineer_id, candidate_order)
                except _RoutingIncomplete:
                    unknown_by_job.add(job_id)
                    continue
                if trial.reason == 'SEARCH_BUDGET_EXHAUSTED':
                    break
                if trial.visits is None:
                    continue
                direct_options.append(candidate_for(
                    engineer_id, old_order, candidate_order, trial, job_id
                ))
            if budget_exhausted:
                break
        is_urgent = dataset.jobs[job_id].priority == Priority.URGENT
        if is_urgent:
            selected = choose_urgent(direct_options)
        else:
            selected = min(direct_options, key=lambda item: (
                item.added_engineers,
                item.shifted_minutes,
                item.added_distance_m,
                item.engineer_id,
                item.order,
            )) if direct_options else None

        # A large delay justifies looking for a faster response that displaces
        # at most one future normal job. Try to restore that job elsewhere first.
        direct_start = selected.urgent_start if selected is not None else None
        should_try_ejection = (
            is_urgent and (
                selected is None
                or direct_start - event.event_time
                > timedelta(minutes=urgent_ejection_gain_minutes)
            )
        ) or (
            event.event_type == EventType.NEW_JOB
            and job_id == event.target_id
            and selected is None
        )
        ejection_options: list[_InsertionCandidate] = []
        if should_try_ejection and not budget_exhausted:
            for engineer_id in eligible_engineers(job_id):
                if dataset.engineers[engineer_id].zone_id != dataset.jobs[job_id].zone_id:
                    continue
                old_order = orders[engineer_id]
                for displaced in old_order:
                    if dataset.jobs[displaced].priority == Priority.URGENT or displaced in commitments:
                        continue
                    if not stock_allows(job_id, displaced):
                        continue
                    reduced = tuple(item for item in old_order if item != displaced)
                    for position in range(len(reduced) + 1):
                        candidate_order = reduced[:position] + (job_id,) + reduced[position:]
                        try:
                            trial = schedule(engineer_id, candidate_order)
                        except _RoutingIncomplete:
                            unknown_by_job.add(job_id)
                            continue
                        if trial.reason == 'SEARCH_BUDGET_EXHAUSTED':
                            break
                        if trial.visits is None:
                            continue
                        urgent_start = next(
                            visit.service_start_at for visit in trial.visits
                            if visit.job_id == job_id
                        )
                        if direct_start is not None and (
                            direct_start - urgent_start
                            < timedelta(minutes=urgent_ejection_gain_minutes)
                        ):
                            continue
                        restoration = None
                        if stock_is_available:
                            restorers = sorted(
                                candidates.eligible_engineers_by_job[displaced],
                                key=lambda item: (
                                    not bool(frozen[item] or orders[item]),
                                    len(orders[item]),
                                    item,
                                ),
                            )
                            for restorer_id in restorers:
                                if restorer_id == engineer_id:
                                    continue
                                if dataset.engineers[restorer_id].zone_id != dataset.jobs[displaced].zone_id:
                                    continue
                                restorer_order = orders[restorer_id]
                                for restore_at in range(len(restorer_order), -1, -1):
                                    restored_order = (
                                        restorer_order[:restore_at] + (displaced,)
                                        + restorer_order[restore_at:]
                                    )
                                    try:
                                        restored_trial = schedule(restorer_id, restored_order)
                                    except _RoutingIncomplete:
                                        unknown_by_job.add(displaced)
                                        continue
                                    if restored_trial.visits is not None:
                                        restoration = (restorer_id, restored_order, restored_trial)
                                        break
                                    if budget_exhausted:
                                        break
                                if restoration is not None or budget_exhausted:
                                    break
                        option = candidate_for(
                            engineer_id, old_order, candidate_order, trial, job_id,
                            displaced=displaced, restoration=restoration,
                        )
                        if (not is_urgent and restoration is not None) or (
                            is_urgent and (direct_start is None or restoration is not None or (
                                direct_start - urgent_start
                                >= timedelta(minutes=2 * urgent_ejection_gain_minutes)
                            ))
                        ):
                            ejection_options.append(option)
                        if budget_exhausted:
                            break
                    if budget_exhausted:
                        break
                if budget_exhausted:
                    break
        if ejection_options:
            selected = choose_urgent(ejection_options) if is_urgent else min(
                ejection_options,
                key=lambda item: (
                    item.shifted_minutes,
                    item.added_engineers,
                    item.added_distance_m,
                    item.engineer_id,
                    item.order,
                ),
            )
        if is_urgent:
            all_options = direct_options + ejection_options
            ranked = sorted(all_options, key=lambda item: (
                item.urgent_start,
                item.normal_jobs_lost,
                item.shifted_minutes,
                item.added_engineers,
                item.added_distance_m,
                item.engineer_id,
            ))
            visible = ranked[:5]
            if selected is not None and selected not in visible:
                visible.append(selected)
            response_origin = max(event.event_time, dataset.jobs[job_id].created_at)
            candidate_evaluations[job_id] = tuple(
                CandidateEvaluation(
                    engineer_id=option.engineer_id,
                    move_kind=(
                        'DIRECT_INSERT' if option.displaced_job_id is None
                        else 'EJECTION_WITH_RESTORATION'
                        if option.restored_order is not None
                        else 'EJECTION_WITH_UNSERVED_NORMAL'
                    ),
                    service_start_at=option.urgent_start,
                    response_minutes=int(
                        (option.urgent_start - response_origin).total_seconds() // 60
                    ),
                    shifted_existing_minutes=option.shifted_minutes,
                    added_engineers=option.added_engineers,
                    added_distance_m=option.added_distance_m,
                    displaced_job_id=option.displaced_job_id,
                    displaced_job_restored=option.restored_order is not None,
                    selected=option == selected,
                )
                for option in visible
            )
        if selected is not None:
            orders[selected.engineer_id] = selected.order
            if selected.restored_engineer_id is not None:
                orders[selected.restored_engineer_id] = selected.restored_order
            elif selected.displaced_job_id is not None:
                pending.append(selected.displaced_job_id)
            reasons.pop(job_id, None)
        elif budget_exhausted:
            reasons[job_id] = 'SEARCH_BUDGET_EXHAUSTED'
        elif job_id in unknown_by_job:
            reasons[job_id] = 'ROUTING_UNVERIFIED'
        elif not stock_is_available:
            reasons[job_id] = 'SHARED_STOCK_SHORTAGE'
        elif job_id in forced_assignments and not eligible_engineers(job_id):
            reasons[job_id] = 'FORCED_ENGINEER_STATICALLY_INELIGIBLE'
        elif not candidates.eligible_engineers_by_job.get(job_id):
            reasons[job_id] = 'NO_STATIC_ELIGIBLE_ENGINEER'
        else:
            reasons[job_id] = 'NO_EXACT_FEASIBLE_INSERTION_IN_CURRENT_ROUTES'

    unresolved_routing = unknown_by_job & (active_job_ids - assigned_jobs())
    if unresolved_routing:
        return ReplanningResult(
            ReplanningStatus.ROUTING_INCOMPLETE, None, None,
            event.event_id, exact_checks, budget_exhausted, reasons,
            'Some unserved jobs have unverified route candidates: '
            + ', '.join(sorted(unresolved_routing)),
        )

    try:
        engineer_plans = tuple(
            EngineerPlan(engineer_id, schedule(engineer_id, orders[engineer_id]).visits or ())
            for engineer_id in sorted(dataset.engineers)
        )
    except _RoutingIncomplete as error:
        return ReplanningResult(
            ReplanningStatus.ROUTING_INCOMPLETE, None, None,
            event.event_id, exact_checks, budget_exhausted, reasons, str(error),
        )
    plan = ProposedPlan(
        planning_at=state.plan.planning_at,
        engineer_plans=engineer_plans,
        unserved_job_ids=tuple(sorted(active_job_ids - assigned_jobs())),
    )
    validation = validate_replanned_plan(
        dataset, plan, state.plan,
        event_time=event.event_time,
        applied_event_ids=frozenset(new_applied),
        canceled_job_ids=frozenset(canceled),
        unavailable_until_by_engineer=unavailable,
    )
    if validation.status != ValidationStatus.VALID:
        raise InvalidPlanningData(
            'Replanning produced an invalid plan: '
            + ', '.join(f'{item.code.value}:{item.subject_id}' for item in validation.violations)
        )
    timing = retime_replanned_departures(
        dataset, plan, state.plan, oracle,
        event_time=event.event_time,
        applied_event_ids=frozenset(new_applied),
        canceled_job_ids=frozenset(canceled),
        unavailable_until_by_engineer=unavailable,
    )
    plan = timing.plan
    validation = validate_replanned_plan(
        dataset, plan, state.plan,
        event_time=event.event_time,
        applied_event_ids=frozenset(new_applied),
        canceled_job_ids=frozenset(canceled),
        unavailable_until_by_engineer=unavailable,
    )
    next_state = ReplanningState(
        plan=plan,
        applied_event_ids=new_applied,
        canceled_job_ids=frozenset(canceled),
        unavailable_until_by_engineer=unavailable,
        last_event_time=event.event_time,
    )
    return ReplanningResult(
        ReplanningStatus.EXACT_VALID, next_state, validation,
        event.event_id, exact_checks, budget_exhausted, reasons,
        candidate_evaluations=candidate_evaluations,
        departure_timing_queries=timing.exact_queries,
        departure_timing_changes=timing.changed_legs,
    )
