from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from beeline_routing.errors import RoutingError
from beeline_routing.models import RouteStatus
from beeline_routing.oracle import ExactRoutingOracle, OracleQuery

from .domain import Engineer, Job, PlanningDataset
from .eligibility import build_candidate_index
from .materialize import (
    MaterializationFailure,
    MaterializationResult,
    MaterializationStatus,
)
from .plan import EngineerPlan, IdentityTravel, PlannedVisit, ProposedPlan, TravelEvidence
from .validator import ValidationStatus, validate_initial_plan


@dataclass(slots=True)
class _EngineerState:
    engineer: Engineer
    visits: list[PlannedVisit] = field(default_factory=list)
    previous_location_id: str = ''
    previous_completion: datetime | None = None
    first_departure: datetime | None = None


def _shared_needs(dataset: PlanningDataset, job: Job) -> Counter[tuple[str, str]]:
    needs: Counter[tuple[str, str]] = Counter()
    for need in job.required_equipment:
        if dataset.equipment_catalog[need.equipment_id].shared_stock:
            needs[(job.zone_id, need.equipment_id)] += need.quantity
    return needs


def build_exact_fcfs_baseline(
    dataset: PlanningDataset,
    oracle: ExactRoutingOracle,
) -> MaterializationResult:
    """Build the deterministic FCFS baseline with exact route evidence.

    Jobs and engineers keep source-file order as the deterministic tie-breaker.
    A job is appended to the first engineer whose current route remains valid;
    accepted decisions are never reordered. Every selected leg comes from the
    same exact routing oracle used by the optimized plan, and the completed
    result is checked by the independent plan validator.
    """
    planning_at = dataset.initial_planning_at
    candidate_index = build_candidate_index(dataset, planning_at)
    job_source_order = {job_id: index for index, job_id in enumerate(dataset.jobs)}
    jobs = sorted(
        dataset.active_jobs_at(planning_at),
        key=lambda job: (job.created_at, job_source_order[job.job_id], job.job_id),
    )
    states = [
        _EngineerState(
            engineer=engineer,
            previous_location_id=dataset.offices[engineer.start_office_id].location_id,
        )
        for engineer in dataset.engineers.values()
    ]
    shared_remaining = Counter({
        (item.zone_id, item.equipment_id): item.quantity_available
        for item in dataset.shared_inventory
    })
    unserved: list[str] = []
    exact_queries = 0
    identity_legs = 0

    for job in jobs:
        shared_needs = _shared_needs(dataset, job)
        if any(shared_remaining[key] < quantity for key, quantity in shared_needs.items()):
            unserved.append(job.job_id)
            continue

        assigned = False
        eligible_ids = set(candidate_index.eligible_engineers_by_job[job.job_id])
        for state in states:
            engineer = state.engineer
            if engineer.engineer_id not in eligible_ids:
                continue
            if len(state.visits) >= engineer.max_jobs:
                continue

            departure_at = (
                max(planning_at, engineer.shift_start, job.created_at)
                if state.previous_completion is None
                else state.previous_completion
            )
            # These bounds do not depend on routing and avoid expensive exact
            # queries after a crew has no time left even for a zero-minute leg.
            earliest_service_start = max(departure_at, job.window_start, job.created_at)
            earliest_service_end = earliest_service_start + timedelta(
                minutes=job.service_duration_min
            )
            first_departure = state.first_departure or departure_at
            if earliest_service_start > job.window_end or earliest_service_end > engineer.shift_end:
                continue
            if earliest_service_end - first_departure > timedelta(
                minutes=engineer.max_route_minutes
            ):
                continue

            travel: TravelEvidence
            if state.previous_location_id == job.location_id:
                travel = IdentityTravel(
                    location_id=state.previous_location_id,
                    departure_at=departure_at,
                )
                identity_legs += 1
            else:
                exact_queries += 1
                try:
                    route = oracle.query(
                        OracleQuery(
                            mode=engineer.transport_mode,
                            origin=dataset.locations[state.previous_location_id],
                            destination=dataset.locations[job.location_id],
                            departure_at=departure_at,
                        )
                    )
                except RoutingError as error:
                    return MaterializationResult(
                        status=MaterializationStatus.ROUTING_INCOMPLETE,
                        plan=None,
                        validation=None,
                        failure=MaterializationFailure(
                            engineer.engineer_id,
                            job.job_id,
                            state.previous_location_id,
                            job.location_id,
                            departure_at.isoformat(),
                            str(error),
                        ),
                        exact_provider_queries=exact_queries,
                        identity_legs=identity_legs,
                    )
                if route.status == RouteStatus.UNKNOWN:
                    return MaterializationResult(
                        status=MaterializationStatus.ROUTING_INCOMPLETE,
                        plan=None,
                        validation=None,
                        failure=MaterializationFailure(
                            engineer.engineer_id,
                            job.job_id,
                            state.previous_location_id,
                            job.location_id,
                            departure_at.isoformat(),
                            f'{route.status.value}: {route.provider_status}',
                        ),
                        exact_provider_queries=exact_queries,
                        identity_legs=identity_legs,
                    )
                if route.status == RouteStatus.UNREACHABLE:
                    continue
                travel = route

            duration_minutes = travel.duration_minutes
            if duration_minutes is None:
                return MaterializationResult(
                    status=MaterializationStatus.ROUTING_INCOMPLETE,
                    plan=None,
                    validation=None,
                    failure=MaterializationFailure(
                        engineer.engineer_id,
                        job.job_id,
                        state.previous_location_id,
                        job.location_id,
                        departure_at.isoformat(),
                        'route evidence has no duration_minutes',
                    ),
                    exact_provider_queries=exact_queries,
                    identity_legs=identity_legs,
                )

            arrival = departure_at + timedelta(minutes=duration_minutes)
            service_start = max(arrival, job.window_start, job.created_at)
            service_end = service_start + timedelta(minutes=job.service_duration_min)
            if service_start > job.window_end or service_end > engineer.shift_end:
                continue
            if service_end - first_departure > timedelta(minutes=engineer.max_route_minutes):
                continue

            state.visits.append(
                PlannedVisit(
                    job_id=job.job_id,
                    departure_at=departure_at,
                    service_start_at=service_start,
                    travel=travel,
                )
            )
            state.previous_location_id = job.location_id
            state.previous_completion = service_end
            state.first_departure = first_departure
            for key, quantity in shared_needs.items():
                shared_remaining[key] -= quantity
            assigned = True
            break

        if not assigned:
            unserved.append(job.job_id)

    plan = ProposedPlan(
        planning_at=planning_at,
        engineer_plans=tuple(
            EngineerPlan(state.engineer.engineer_id, tuple(state.visits))
            for state in states if state.visits
        ),
        unserved_job_ids=tuple(unserved),
    )
    validation = validate_initial_plan(dataset, plan)
    status = (
        MaterializationStatus.EXACT_VALID
        if validation.status == ValidationStatus.VALID
        else MaterializationStatus.ROUTING_INCOMPLETE
        if validation.status == ValidationStatus.ROUTING_INCOMPLETE
        else MaterializationStatus.ORDER_INFEASIBLE
    )
    return MaterializationResult(
        status=status,
        plan=plan,
        validation=validation,
        failure=None,
        exact_provider_queries=exact_queries,
        identity_legs=identity_legs,
    )
