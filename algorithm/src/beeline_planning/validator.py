from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from types import MappingProxyType
from typing import Mapping

from beeline_routing.models import DetailedRoute, RouteStatus, TransportMode

from .domain import Commitment, Job, PlanningDataset, Priority
from .plan import IdentityTravel, ProposedPlan


class ValidationStatus(StrEnum):
    VALID = 'VALID'
    INVALID = 'INVALID'
    ROUTING_INCOMPLETE = 'ROUTING_INCOMPLETE'


class ViolationCode(StrEnum):
    DURATION_SNAPSHOT_MISMATCH = 'DURATION_SNAPSHOT_MISMATCH'
    DUPLICATE_ENGINEER_PLAN = 'DUPLICATE_ENGINEER_PLAN'
    UNKNOWN_ENGINEER = 'UNKNOWN_ENGINEER'
    UNKNOWN_OR_INACTIVE_JOB = 'UNKNOWN_OR_INACTIVE_JOB'
    DUPLICATE_ASSIGNMENT = 'DUPLICATE_ASSIGNMENT'
    ASSIGNED_AND_UNSERVED = 'ASSIGNED_AND_UNSERVED'
    JOB_RESULT_MISSING = 'JOB_RESULT_MISSING'
    DUPLICATE_UNSERVED_JOB = 'DUPLICATE_UNSERVED_JOB'
    ZONE_MISMATCH = 'ZONE_MISMATCH'
    SKILL_MISSING = 'SKILL_MISSING'
    TRANSPORT_MISMATCH = 'TRANSPORT_MISMATCH'
    PERSONAL_EQUIPMENT_MISSING = 'PERSONAL_EQUIPMENT_MISSING'
    SHARED_INVENTORY_EXCEEDED = 'SHARED_INVENTORY_EXCEEDED'
    HARD_COMMITMENT_VIOLATED = 'HARD_COMMITMENT_VIOLATED'
    ENGINEER_UNAVAILABLE = 'ENGINEER_UNAVAILABLE'
    MAX_JOBS_EXCEEDED = 'MAX_JOBS_EXCEEDED'
    MAX_ROUTE_MINUTES_EXCEEDED = 'MAX_ROUTE_MINUTES_EXCEEDED'
    ROUTE_CHAIN_BROKEN = 'ROUTE_CHAIN_BROKEN'
    ROUTE_MODE_MISMATCH = 'ROUTE_MODE_MISMATCH'
    ROUTE_DEPARTURE_MISMATCH = 'ROUTE_DEPARTURE_MISMATCH'
    ROUTE_UNKNOWN = 'ROUTE_UNKNOWN'
    ROUTE_UNREACHABLE = 'ROUTE_UNREACHABLE'
    ROUTE_ROUNDING_INVALID = 'ROUTE_ROUNDING_INVALID'
    IDENTITY_ROUTE_INVALID = 'IDENTITY_ROUTE_INVALID'
    NON_MINUTE_TIMESTAMP = 'NON_MINUTE_TIMESTAMP'
    ACTIVITY_BEFORE_PLANNING = 'ACTIVITY_BEFORE_PLANNING'
    ACTIVITY_BEFORE_JOB_CREATED = 'ACTIVITY_BEFORE_JOB_CREATED'
    DEPARTURE_BEFORE_PREVIOUS_COMPLETION = 'DEPARTURE_BEFORE_PREVIOUS_COMPLETION'
    SERVICE_BEFORE_ARRIVAL = 'SERVICE_BEFORE_ARRIVAL'
    TIME_WINDOW_VIOLATED = 'TIME_WINDOW_VIOLATED'
    SHIFT_VIOLATED = 'SHIFT_VIOLATED'
    FROZEN_ACTIVITY_CHANGED = 'FROZEN_ACTIVITY_CHANGED'
    UNAVAILABLE_AFTER_EVENT = 'UNAVAILABLE_AFTER_EVENT'


@dataclass(frozen=True, slots=True)
class Violation:
    code: ViolationCode
    subject_id: str
    detail: str


@dataclass(frozen=True, slots=True)
class PlanMetrics:
    served_urgent_jobs: int
    served_normal_jobs: int
    unserved_urgent_jobs: int
    unserved_normal_jobs: int
    used_engineers: int
    distance_m_by_engineer: Mapping[str, int]
    total_distance_m: int
    travel_minutes_by_engineer: Mapping[str, int]
    total_travel_minutes: int
    waiting_minutes_by_engineer: Mapping[str, int]
    total_waiting_minutes: int
    route_minutes_by_engineer: Mapping[str, int]


@dataclass(frozen=True, slots=True)
class ValidationReport:
    status: ValidationStatus
    violations: tuple[Violation, ...]
    metrics: PlanMetrics

    @property
    def is_valid(self) -> bool:
        return self.status == ValidationStatus.VALID


def _whole_minute(value: datetime) -> bool:
    return value.second == 0 and value.microsecond == 0


def _minutes(delta: timedelta) -> int:
    seconds = delta.total_seconds()
    if seconds < 0 or seconds % 60:
        raise ValueError('Expected a non-negative whole-minute duration')
    return int(seconds // 60)


def _validate_plan(
    dataset: PlanningDataset,
    plan: ProposedPlan,
    *,
    active_jobs: Mapping[str, Job],
    commitments: tuple[Commitment, ...],
    previous_plan: ProposedPlan | None = None,
    event_time: datetime | None = None,
    unavailable_until_by_engineer: Mapping[str, datetime] | None = None,
    protected_job_ids: frozenset[str] = frozenset(),
    locked_engineer_ids: frozenset[str] = frozenset(),
    available_after_by_engineer: Mapping[str, datetime] | None = None,
) -> ValidationReport:
    violations: list[Violation] = []
    assigned_to: dict[str, str] = {}
    distance_by_engineer: dict[str, int] = {}
    travel_by_engineer: dict[str, int] = {}
    waiting_by_engineer: dict[str, int] = {}
    route_minutes_by_engineer: dict[str, int] = {}
    seen_engineers: set[str] = set()
    old_routes = (
        {route.engineer_id: route.visits for route in previous_plan.engineer_plans}
        if previous_plan is not None else {}
    )
    unavailable = unavailable_until_by_engineer or {}
    for job in dataset.jobs.values():
        if job.authoritative_duration_min is not None and (job.service_duration_min != job.authoritative_duration_min or not job.duration_snapshot_id):
            violations.append(Violation(ViolationCode.DURATION_SNAPSHOT_MISMATCH, job.job_id, 'Service duration differs from the immutable server snapshot'))

    if plan.planning_at.tzinfo is None or plan.planning_at.utcoffset() is None:
        violations.append(
            Violation(ViolationCode.NON_MINUTE_TIMESTAMP, 'plan', 'planning_at has no timezone')
        )
    elif not _whole_minute(plan.planning_at):
        violations.append(
            Violation(ViolationCode.NON_MINUTE_TIMESTAMP, 'plan', 'planning_at is not a whole minute')
        )

    for engineer_plan in plan.engineer_plans:
        engineer_id = engineer_plan.engineer_id
        if engineer_id in seen_engineers:
            violations.append(
                Violation(ViolationCode.DUPLICATE_ENGINEER_PLAN, engineer_id, 'more than one route')
            )
            continue
        seen_engineers.add(engineer_id)
        engineer = dataset.engineers.get(engineer_id)
        if engineer is None:
            violations.append(
                Violation(ViolationCode.UNKNOWN_ENGINEER, engineer_id, 'engineer is absent from dataset')
            )
            continue
        if engineer_plan.visits and not engineer.is_available:
            violations.append(
                Violation(ViolationCode.ENGINEER_UNAVAILABLE, engineer_id, 'engineer is unavailable')
            )
        from .dispatch import verify_checkpoint
        interruptions = {item['source_job_id']: item for item in engineer_plan.movements if item['measured_at'] == (event_time.isoformat() if event_time else '')}
        old_movement_route = next((r for r in previous_plan.engineer_plans if r.engineer_id == engineer_id), None) if previous_plan else None
        if old_movement_route and engineer_plan.movements[:len(old_movement_route.movements)] != old_movement_route.movements:
            violations.append(Violation(ViolationCode.FROZEN_ACTIVITY_CHANGED, engineer_id, 'elapsed movement history changed'))
        if old_movement_route and engineer_plan.dispatches[:len(old_movement_route.dispatches)] != old_movement_route.dispatches:
            violations.append(Violation(ViolationCode.FROZEN_ACTIVITY_CHANGED, engineer_id, 'dispatch history changed'))
        for item in engineer_plan.movements:
            try:
                valid_movement = verify_checkpoint(item, dataset.locations)
                if old_movement_route and item not in old_movement_route.movements:
                    source_visit = next((v for v in old_movement_route.visits if v.job_id == item['source_job_id']), None)
                    from beeline_routing.export import detailed_route_dict
                    valid_movement = valid_movement and source_visit is not None and detailed_route_dict(source_visit.travel) == item['source_travel'] and source_visit.service_start_at > event_time
                if not valid_movement:
                    raise ValueError('movement differs from routed history')
            except (ValueError, KeyError, TypeError, AttributeError):
                violations.append(Violation(ViolationCode.ROUTE_CHAIN_BROKEN, engineer_id, 'invalid elapsed movement checkpoint'))
        frozen_count = 0
        for dispatch in engineer_plan.dispatches:
            dispatch_at = datetime.fromisoformat(dispatch['at'])
            protected_prefix = dispatch.get('prefix_job_ids', [])
            if event_time is not None and dispatch_at == event_time and (not old_movement_route or dispatch not in old_movement_route.dispatches):
                previous_visits = old_routes.get(engineer_id, ())
                expected_prefix = tuple(visit for visit in previous_visits if visit.departure_at <= event_time and visit.job_id not in interruptions)
                last_protected = max((i for i, visit in enumerate(previous_visits) if visit.job_id in protected_job_ids), default=-1)
                if last_protected >= 0:
                    expected_prefix = previous_visits[:max(last_protected + 1, len(expected_prefix))]
                if protected_prefix != [visit.job_id for visit in expected_prefix]:
                    violations.append(Violation(ViolationCode.FROZEN_ACTIVITY_CHANGED, engineer_id, 'dispatch prefix is not backed by prior activity or facts'))
                release = (available_after_by_engineer or {}).get(engineer_id, event_time)
                if datetime.fromisoformat(dispatch.get('available_after', dispatch['at'])) < release:
                    violations.append(Violation(ViolationCode.UNAVAILABLE_AFTER_EVENT, engineer_id, 'dispatch release differs from operational facts'))
            first_future = next((visit for visit in engineer_plan.visits if visit.job_id not in protected_prefix
                and (visit.service_start_at > dispatch_at or visit.job_id == dispatch['job_id'] and visit.service_start_at == dispatch_at)), None)
            handoff = next((movement for movement in engineer_plan.movements
                if movement['source_job_id'] == dispatch['job_id']
                and datetime.fromisoformat(movement['measured_at']) >= dispatch_at
                and datetime.fromisoformat(movement['departure_at']) >= dispatch_at), None)
            recipient = next((visit for route in plan.engineer_plans if route.engineer_id != engineer_id
                for visit in route.visits if visit.job_id == dispatch['job_id']), None)
            historical_handoff = handoff and old_movement_route and handoff in old_movement_route.movements
            if handoff and recipient and (historical_handoff or dispatch['job_id'] not in protected_job_ids) and recipient.departure_at >= datetime.fromisoformat(handoff['measured_at']):
                # The prior decision remains in history; its still-future visit
                # has been handed off after a verified interruption of its trip.
                continue
            if first_future is None or first_future.job_id != dispatch['job_id']:
                violations.append(Violation(ViolationCode.FROZEN_ACTIVITY_CHANGED, engineer_id, 'emergency must be the first unstarted service after dispatch'))
            if first_future and first_future.departure_at < datetime.fromisoformat(dispatch.get('available_after', dispatch['at'])):
                violations.append(Violation(ViolationCode.UNAVAILABLE_AFTER_EVENT, engineer_id, 'emergency departure precedes service release'))
        if event_time is not None and previous_plan is not None:
            frozen = tuple(
                visit for visit in old_routes.get(engineer_id, ())
                if visit.departure_at <= event_time and visit.job_id not in interruptions
            )
            previous_visits = old_routes.get(engineer_id, ())
            last_protected = max((i for i, visit in enumerate(previous_visits) if visit.job_id in protected_job_ids), default=-1)
            if engineer_id in locked_engineer_ids:
                frozen = previous_visits
            elif last_protected >= 0:
                frozen = previous_visits[:max(last_protected + 1, len(frozen))]
            frozen_count = len(frozen)
            if engineer_plan.visits[:frozen_count] != frozen:
                violations.append(
                    Violation(
                        ViolationCode.FROZEN_ACTIVITY_CHANGED,
                        engineer_id,
                        'completed, in-service or in-transit visit changed',
                    )
                )
        if len(engineer_plan.visits) > engineer.max_jobs:
            violations.append(
                Violation(
                    ViolationCode.MAX_JOBS_EXCEEDED,
                    engineer_id,
                    f'{len(engineer_plan.visits)} > {engineer.max_jobs}',
                )
            )

        previous_location = dataset.offices[engineer.start_office_id].location_id
        previous_completion: datetime | None = None
        first_departure: datetime | None = None
        total_distance = sum(item['distance_m'] for item in engineer_plan.movements)
        total_travel = sum(item['travel_minutes'] for item in engineer_plan.movements)
        total_waiting = 0
        for sequence, visit in enumerate(engineer_plan.visits, start=1):
            boundary = engineer_plan.visits[sequence-2].job_id if sequence > 1 else None
            for movement in engineer_plan.movements:
                if movement['after_job_id'] == boundary:
                    if movement['origin_id'] != previous_location or (previous_completion and datetime.fromisoformat(movement['departure_at']) < previous_completion):
                        violations.append(Violation(ViolationCode.ROUTE_CHAIN_BROKEN, engineer_id, 'interruption is disconnected from earlier activity'))
                    movement_departure = datetime.fromisoformat(movement['departure_at'])
                    movement_end = datetime.fromisoformat(movement['at'])
                    if previous_completion and movement_departure >= previous_completion:
                        total_waiting += _minutes(movement_departure - previous_completion)
                    total_waiting += max(0, _minutes(movement_end - movement_departure) - movement['travel_minutes'])
                    previous_location = movement['location_id']
                    previous_completion = movement_end
                    if first_departure is None:
                        first_departure = datetime.fromisoformat(movement['departure_at'])
            subject = f'{engineer_id}:{sequence}:{visit.job_id}'
            job = active_jobs.get(visit.job_id)
            if job is None:
                violations.append(
                    Violation(
                        ViolationCode.UNKNOWN_OR_INACTIVE_JOB,
                        subject,
                        'job is unknown or was not created by planning_at',
                    )
                )
                continue
            if visit.job_id in assigned_to:
                violations.append(
                    Violation(
                        ViolationCode.DUPLICATE_ASSIGNMENT,
                        visit.job_id,
                        f'assigned to {assigned_to[visit.job_id]} and {engineer_id}',
                    )
                )
            else:
                assigned_to[visit.job_id] = engineer_id

            if engineer.zone_id != job.zone_id:
                violations.append(Violation(ViolationCode.ZONE_MISMATCH, subject, 'zones differ'))
            if job.required_skill not in engineer.skills:
                violations.append(
                    Violation(ViolationCode.SKILL_MISSING, subject, job.required_skill)
                )
            if not job.required_transport.allows(engineer.transport_mode):
                violations.append(
                    Violation(
                        ViolationCode.TRANSPORT_MISMATCH,
                        subject,
                        f'{job.required_transport.value} is required',
                    )
                )
            for need in job.required_equipment:
                item = dataset.equipment_catalog[need.equipment_id]
                if item.reusable and engineer.equipment_quantity(need.equipment_id) < need.quantity:
                    violations.append(
                        Violation(
                            ViolationCode.PERSONAL_EQUIPMENT_MISSING,
                            subject,
                            f'{need.equipment_id}: needs {need.quantity}',
                        )
                    )

            for timestamp_name, timestamp in (
                ('departure_at', visit.departure_at),
                ('service_start_at', visit.service_start_at),
            ):
                if timestamp.tzinfo is None or timestamp.utcoffset() is None or not _whole_minute(timestamp):
                    violations.append(
                        Violation(
                            ViolationCode.NON_MINUTE_TIMESTAMP,
                            subject,
                            f'{timestamp_name} must be a timezone-aware whole minute',
                        )
                    )
            if first_departure is None:
                first_departure = visit.departure_at
            if visit.departure_at < plan.planning_at:
                violations.append(
                    Violation(ViolationCode.ACTIVITY_BEFORE_PLANNING, subject, 'departure before run')
                )
            if event_time is not None and sequence > frozen_count:
                if visit.departure_at < event_time:
                    violations.append(
                        Violation(
                            ViolationCode.FROZEN_ACTIVITY_CHANGED,
                            subject,
                            'new route activity starts before event time',
                        )
                    )
                unavailable_until = unavailable.get(engineer_id)
                if unavailable_until is not None and visit.departure_at < unavailable_until:
                    violations.append(
                        Violation(
                            ViolationCode.UNAVAILABLE_AFTER_EVENT,
                            subject,
                            f'engineer unavailable until {unavailable_until.isoformat()}',
                        )
                    )
            if visit.departure_at < job.created_at:
                violations.append(
                    Violation(
                        ViolationCode.ACTIVITY_BEFORE_JOB_CREATED,
                        subject,
                        'departure precedes created_at',
                    )
                )
            if previous_completion is not None:
                if visit.departure_at < previous_completion:
                    violations.append(
                        Violation(
                            ViolationCode.DEPARTURE_BEFORE_PREVIOUS_COMPLETION,
                            subject,
                            'route overlaps previous service',
                        )
                    )
                elif _whole_minute(visit.departure_at) and _whole_minute(previous_completion):
                    total_waiting += _minutes(visit.departure_at - previous_completion)

            travel = visit.travel
            origin_point = dataset.locations.get(previous_location)
            if origin_point and origin_point.heading is not None and engineer.transport_mode.value == 'CAR' and not isinstance(travel, IdentityTravel):
                if not hasattr(travel, 'provenance') or travel.provenance.provider_metadata.get('origin_heading') != origin_point.heading:
                    violations.append(Violation(ViolationCode.ROUTE_CHAIN_BROKEN, subject, 'road direction at interruption was not checked'))
            if travel.origin_id != previous_location or travel.destination_id != job.location_id:
                violations.append(
                    Violation(
                        ViolationCode.ROUTE_CHAIN_BROKEN,
                        subject,
                        f'expected {previous_location}->{job.location_id}, got '
                        f'{travel.origin_id}->{travel.destination_id}',
                    )
                )
            if travel.departure_at != visit.departure_at:
                violations.append(
                    Violation(
                        ViolationCode.ROUTE_DEPARTURE_MISMATCH,
                        subject,
                        'route evidence was calculated for another departure time',
                    )
                )

            duration_minutes = travel.duration_minutes
            distance_m = travel.distance_m
            if isinstance(travel, IdentityTravel):
                if previous_location != job.location_id:
                    violations.append(
                        Violation(
                            ViolationCode.IDENTITY_ROUTE_INVALID,
                            subject,
                            'identity travel is allowed only for the same location_id',
                        )
                    )
            elif isinstance(travel, DetailedRoute):
                if travel.status == RouteStatus.UNKNOWN:
                    violations.append(
                        Violation(ViolationCode.ROUTE_UNKNOWN, subject, travel.provider_status)
                    )
                    duration_minutes = None
                    distance_m = None
                elif travel.status == RouteStatus.UNREACHABLE:
                    violations.append(
                        Violation(ViolationCode.ROUTE_UNREACHABLE, subject, travel.provider_status)
                    )
                    duration_minutes = None
                    distance_m = None
                else:
                    if travel.mode != engineer.transport_mode:
                        violations.append(
                            Violation(
                                ViolationCode.ROUTE_MODE_MISMATCH,
                                subject,
                                f'{travel.mode} != {engineer.transport_mode}',
                            )
                        )
                    expected_minutes = math.ceil((travel.duration_seconds or 0) / 60)
                    if travel.duration_minutes != expected_minutes:
                        violations.append(
                            Violation(
                                ViolationCode.ROUTE_ROUNDING_INVALID,
                                subject,
                                f'{travel.duration_minutes} != ceil({travel.duration_seconds}/60)',
                            )
                        )

            if duration_minutes is None or distance_m is None:
                previous_location = job.location_id
                previous_completion = visit.service_start_at + timedelta(
                    minutes=job.service_duration_min
                )
                continue
            total_distance += distance_m
            total_travel += duration_minutes
            arrival = visit.departure_at + timedelta(minutes=duration_minutes)
            if visit.service_start_at < arrival:
                violations.append(
                    Violation(
                        ViolationCode.SERVICE_BEFORE_ARRIVAL,
                        subject,
                        f'arrival is {arrival.isoformat()}',
                    )
                )
            elif _whole_minute(visit.service_start_at) and _whole_minute(arrival):
                total_waiting += _minutes(visit.service_start_at - arrival)
            service_end = visit.service_start_at + timedelta(minutes=job.service_duration_min)
            if not job.window_start <= visit.service_start_at <= job.window_end:
                violations.append(
                    Violation(
                        ViolationCode.TIME_WINDOW_VIOLATED,
                        subject,
                        'service start is outside the closed time window',
                    )
                )
            if (
                visit.departure_at < engineer.shift_start
                or visit.service_start_at < engineer.shift_start
                or service_end > engineer.shift_end
            ):
                violations.append(
                    Violation(ViolationCode.SHIFT_VIOLATED, subject, 'activity is outside shift')
                )
            previous_location = job.location_id
            previous_completion = service_end

        route_minutes = 0
        if first_departure is not None and previous_completion is not None:
            if previous_completion >= first_departure and _whole_minute(first_departure):
                route_minutes = _minutes(previous_completion - first_departure)
                if route_minutes > engineer.max_route_minutes:
                    violations.append(
                        Violation(
                            ViolationCode.MAX_ROUTE_MINUTES_EXCEEDED,
                            engineer_id,
                            f'{route_minutes} > {engineer.max_route_minutes}',
                        )
                    )
        distance_by_engineer[engineer_id] = total_distance
        travel_by_engineer[engineer_id] = total_travel
        waiting_by_engineer[engineer_id] = total_waiting
        route_minutes_by_engineer[engineer_id] = route_minutes

    unserved_counts = Counter(plan.unserved_job_ids)
    for job_id, count in unserved_counts.items():
        if count > 1:
            violations.append(
                Violation(ViolationCode.DUPLICATE_UNSERVED_JOB, job_id, f'listed {count} times')
            )
        if job_id not in active_jobs:
            violations.append(
                Violation(
                    ViolationCode.UNKNOWN_OR_INACTIVE_JOB,
                    job_id,
                    'unserved job is unknown or inactive',
                )
            )
        if job_id in assigned_to:
            violations.append(
                Violation(
                    ViolationCode.ASSIGNED_AND_UNSERVED,
                    job_id,
                    f'assigned to {assigned_to[job_id]}',
                )
            )
    represented_jobs = set(assigned_to) | set(unserved_counts)
    for job_id in sorted(set(active_jobs) - represented_jobs):
        violations.append(
            Violation(ViolationCode.JOB_RESULT_MISSING, job_id, 'neither assigned nor unserved')
        )

    if event_time is not None and previous_plan is not None:
        for engineer_id in sorted(set(old_routes) - seen_engineers):
            if any(visit.departure_at <= event_time for visit in old_routes[engineer_id]):
                violations.append(
                    Violation(
                        ViolationCode.FROZEN_ACTIVITY_CHANGED,
                        engineer_id,
                        'route containing started activity was removed',
                    )
                )

    for commitment in commitments:
        actual = assigned_to.get(commitment.job_id)
        if actual != commitment.engineer_id:
            violations.append(
                Violation(
                    ViolationCode.HARD_COMMITMENT_VIOLATED,
                    commitment.job_id,
                    f'required {commitment.engineer_id}, got {actual or "UNSERVED"}',
                )
            )

    inventory_use: Counter[tuple[str, str]] = Counter()
    for job_id in assigned_to:
        job = active_jobs[job_id]
        for need in job.required_equipment:
            if dataset.equipment_catalog[need.equipment_id].shared_stock:
                inventory_use[(job.zone_id, need.equipment_id)] += need.quantity
    inventory_available = {
        (item.zone_id, item.equipment_id): item.quantity_available
        for item in dataset.shared_inventory
    }
    for key, used in sorted(inventory_use.items()):
        available = inventory_available[key]
        if used > available:
            violations.append(
                Violation(
                    ViolationCode.SHARED_INVENTORY_EXCEEDED,
                    f'{key[0]}:{key[1]}',
                    f'{used} > {available}',
                )
            )

    served_jobs = [active_jobs[job_id] for job_id in assigned_to if job_id in active_jobs]
    unserved_jobs = [active_jobs[job_id] for job_id in unserved_counts if job_id in active_jobs]
    metrics = PlanMetrics(
        served_urgent_jobs=sum(job.priority == Priority.URGENT for job in served_jobs),
        served_normal_jobs=sum(job.priority == Priority.NORMAL for job in served_jobs),
        unserved_urgent_jobs=sum(job.priority == Priority.URGENT for job in unserved_jobs),
        unserved_normal_jobs=sum(job.priority == Priority.NORMAL for job in unserved_jobs),
        used_engineers=sum(bool(route.visits) for route in plan.engineer_plans),
        distance_m_by_engineer=MappingProxyType(distance_by_engineer),
        total_distance_m=sum(distance_by_engineer.values()),
        travel_minutes_by_engineer=MappingProxyType(travel_by_engineer),
        total_travel_minutes=sum(travel_by_engineer.values()),
        waiting_minutes_by_engineer=MappingProxyType(waiting_by_engineer),
        total_waiting_minutes=sum(waiting_by_engineer.values()),
        route_minutes_by_engineer=MappingProxyType(route_minutes_by_engineer),
    )
    has_unknown = any(item.code == ViolationCode.ROUTE_UNKNOWN for item in violations)
    has_proven_invalidity = any(item.code != ViolationCode.ROUTE_UNKNOWN for item in violations)
    status = (
        ValidationStatus.INVALID
        if has_proven_invalidity
        else ValidationStatus.ROUTING_INCOMPLETE
        if has_unknown
        else ValidationStatus.VALID
    )
    return ValidationReport(status=status, violations=tuple(violations), metrics=metrics)


def validate_initial_plan(dataset: PlanningDataset, plan: ProposedPlan) -> ValidationReport:
    """Independently validate an initial plan using inputs and route evidence."""
    return _validate_plan(
        dataset,
        plan,
        active_jobs={job.job_id: job for job in dataset.active_jobs_at(plan.planning_at)},
        commitments=dataset.active_commitments_at(plan.planning_at),
    )


def validate_replanned_plan(
    dataset: PlanningDataset,
    plan: ProposedPlan,
    previous_plan: ProposedPlan,
    *,
    event_time: datetime,
    applied_event_ids: frozenset[str],
    canceled_job_ids: frozenset[str],
    unavailable_until_by_engineer: Mapping[str, datetime],
    protected_job_ids: frozenset[str] = frozenset(),
    locked_engineer_ids: frozenset[str] = frozenset(),
    available_after_by_engineer: Mapping[str, datetime] | None = None,
) -> ValidationReport:
    """Validate a full-day plan after an event, including its immutable started prefix."""
    active_jobs = {
        job.job_id: job for job in dataset.active_jobs_at(event_time)
        if job.job_id not in canceled_job_ids
    }
    commitments = tuple(
        commitment for commitment in dataset.active_commitments_at(
            event_time, applied_event_ids
        ) if commitment.job_id in active_jobs
    )
    return _validate_plan(
        dataset,
        plan,
        active_jobs=active_jobs,
        commitments=commitments,
        previous_plan=previous_plan,
        event_time=event_time,
        unavailable_until_by_engineer=unavailable_until_by_engineer,
        protected_job_ids=protected_job_ids,
        locked_engineer_ids=locked_engineer_ids,
        available_after_by_engineer=available_after_by_engineer,
    )
