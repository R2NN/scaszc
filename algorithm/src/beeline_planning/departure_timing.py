"""Move idle time before a trip only when a new exact route proves it is safe."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Callable, Mapping

from beeline_routing.errors import RoutingError
from beeline_routing.models import RouteStatus
from beeline_routing.oracle import ExactRoutingOracle, OracleQuery

from .domain import PlanningDataset
from .plan import IdentityTravel, ProposedPlan
from .validator import (
    ValidationReport, ValidationStatus, validate_initial_plan, validate_replanned_plan,
)


@dataclass(frozen=True, slots=True)
class DepartureTimingResult:
    plan: ProposedPlan
    changed_legs: int
    exact_queries: int
    client_wait_before_minutes: int
    client_wait_after_minutes: int
    worst_client_wait_before_minutes: int
    worst_client_wait_after_minutes: int


def _client_wait_minutes(plan: ProposedPlan) -> list[int]:
    return [
        int((visit.service_start_at - visit.departure_at).total_seconds() // 60)
        - visit.travel.duration_minutes
        for route in plan.engineer_plans
        for visit in route.visits
    ]


def _retime_departures(
    dataset: PlanningDataset,
    plan: ProposedPlan,
    oracle: ExactRoutingOracle,
    *,
    validate: Callable[[ProposedPlan], ValidationReport],
    frozen_at: datetime | None,
    arrival_buffer_minutes: int = 15,
    minimum_wait_reduction_minutes: int = 5,
    max_queries_per_leg: int = 3,
    max_total_queries: int = 64,
) -> DepartureTimingResult:
    """Delay trips toward service start, rerouting each changed leg at its new time.

    Visit order and service starts remain fixed. Failed or slow new routes leave the
    original evidence untouched. The complete result is independently validated;
    if validation fails, the original plan is returned.
    """
    if arrival_buffer_minutes < 0 or minimum_wait_reduction_minutes < 1:
        raise ValueError('Arrival buffer must be non-negative and minimum saving positive')
    if max_queries_per_leg < 1 or max_total_queries < 0:
        raise ValueError('Query limits must be positive per leg and non-negative overall')
    if validate(plan).status != ValidationStatus.VALID:
        raise ValueError('Departure timing requires an independently valid source plan')

    before = _client_wait_minutes(plan)
    buffer = timedelta(minutes=arrival_buffer_minutes)
    one_minute = timedelta(minutes=1)
    candidates = []
    for route_index, route in enumerate(plan.engineer_plans):
        for visit_index, visit in enumerate(route.visits):
            if frozen_at is not None and visit.departure_at <= frozen_at:
                continue
            wait = int((visit.service_start_at - visit.departure_at).total_seconds() // 60)
            wait -= visit.travel.duration_minutes
            if wait >= arrival_buffer_minutes + minimum_wait_reduction_minutes:
                candidates.append((wait, route_index, visit_index))
    candidates.sort(reverse=True)

    updated_routes = [list(route.visits) for route in plan.engineer_plans]
    exact_queries = 0
    changed_legs = 0
    for _, route_index, visit_index in candidates:
        route = plan.engineer_plans[route_index]
        visit = route.visits[visit_index]
        engineer = dataset.engineers[route.engineer_id]
        job = dataset.jobs[visit.job_id]
        target_arrival = visit.service_start_at - buffer
        original_arrival = visit.departure_at + timedelta(
            minutes=visit.travel.duration_minutes
        )
        if target_arrival <= original_arrival:
            continue
        earliest = max(
            visit.departure_at + one_minute,
            plan.planning_at,
            engineer.shift_start,
            job.created_at,
        )
        if visit_index:
            previous = route.visits[visit_index - 1]
            earliest = max(
                earliest,
                previous.service_start_at + timedelta(
                    minutes=dataset.jobs[previous.job_id].service_duration_min
                ),
            )
        departure = target_arrival - timedelta(minutes=visit.travel.duration_minutes)
        if departure < earliest:
            continue
        best = None
        tried = set()
        for _ in range(max_queries_per_leg):
            if departure < earliest or departure in tried:
                break
            tried.add(departure)
            if isinstance(visit.travel, IdentityTravel):
                travel = IdentityTravel(visit.travel.location_id, departure)
            else:
                if exact_queries >= max_total_queries:
                    break
                exact_queries += 1
                try:
                    travel = oracle.query(OracleQuery(
                        mode=engineer.transport_mode,
                        origin=dataset.locations[visit.travel.origin_id],
                        destination=dataset.locations[job.location_id],
                        departure_at=departure,
                    ))
                except RoutingError:
                    break
                if travel.status != RouteStatus.OK or travel.duration_minutes is None:
                    break
            arrival = departure + timedelta(minutes=travel.duration_minutes)
            if arrival <= target_arrival:
                old_wait = int((visit.service_start_at - original_arrival).total_seconds() // 60)
                new_wait = int((visit.service_start_at - arrival).total_seconds() // 60)
                if old_wait - new_wait >= minimum_wait_reduction_minutes:
                    best = replace(visit, departure_at=departure, travel=travel)
                gap = int((target_arrival - arrival).total_seconds() // 60)
                if gap < minimum_wait_reduction_minutes:
                    break
                departure += timedelta(minutes=gap)
            else:
                late = int((arrival - target_arrival).total_seconds() // 60)
                departure -= timedelta(minutes=max(1, late + 1))
        if best is not None:
            updated_routes[route_index][visit_index] = best
            changed_legs += 1

    updated = replace(plan, engineer_plans=tuple(
        replace(route, visits=tuple(updated_routes[index]))
        for index, route in enumerate(plan.engineer_plans)
    ))
    if validate(updated).status != ValidationStatus.VALID:
        updated = plan
        changed_legs = 0
    after = _client_wait_minutes(updated)
    return DepartureTimingResult(
        updated,
        changed_legs,
        exact_queries,
        sum(before),
        sum(after),
        max(before, default=0),
        max(after, default=0),
    )


def retime_initial_departures(
    dataset: PlanningDataset,
    plan: ProposedPlan,
    oracle: ExactRoutingOracle,
    *,
    arrival_buffer_minutes: int = 15,
    minimum_wait_reduction_minutes: int = 5,
    max_queries_per_leg: int = 3,
    max_total_queries: int = 64,
) -> DepartureTimingResult:
    """Retime an initial plan while preserving every service start and assignment."""
    return _retime_departures(
        dataset, plan, oracle,
        validate=lambda candidate: validate_initial_plan(dataset, candidate),
        frozen_at=None,
        arrival_buffer_minutes=arrival_buffer_minutes,
        minimum_wait_reduction_minutes=minimum_wait_reduction_minutes,
        max_queries_per_leg=max_queries_per_leg,
        max_total_queries=max_total_queries,
    )


def retime_replanned_departures(
    dataset: PlanningDataset,
    plan: ProposedPlan,
    previous_plan: ProposedPlan,
    oracle: ExactRoutingOracle,
    *,
    event_time: datetime,
    applied_event_ids: frozenset[str],
    canceled_job_ids: frozenset[str],
    unavailable_until_by_engineer: Mapping[str, datetime],
    arrival_buffer_minutes: int = 15,
    minimum_wait_reduction_minutes: int = 5,
    max_queries_per_leg: int = 3,
    max_total_queries: int = 24,
) -> DepartureTimingResult:
    """Retime only future legs; started event activity remains unchanged."""
    return _retime_departures(
        dataset, plan, oracle,
        validate=lambda candidate: validate_replanned_plan(
            dataset, candidate, previous_plan,
            event_time=event_time,
            applied_event_ids=applied_event_ids,
            canceled_job_ids=canceled_job_ids,
            unavailable_until_by_engineer=unavailable_until_by_engineer,
        ),
        frozen_at=event_time,
        arrival_buffer_minutes=arrival_buffer_minutes,
        minimum_wait_reduction_minutes=minimum_wait_reduction_minutes,
        max_queries_per_leg=max_queries_per_leg,
        max_total_queries=max_total_queries,
    )
