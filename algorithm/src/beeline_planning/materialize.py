from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum
from threading import Lock, local
from typing import Callable

from beeline_routing.errors import RoutingError
from beeline_routing.models import RouteStatus
from beeline_routing.oracle import ExactRoutingOracle, OracleQuery

from .domain import PlanningDataset
from .plan import EngineerPlan, IdentityTravel, PlannedVisit, ProposedPlan, TravelEvidence
from .solver import MasterSolution
from .validator import ValidationReport, ValidationStatus, validate_initial_plan


class MaterializationStatus(StrEnum):
    EXACT_VALID = 'EXACT_VALID'
    ORDER_INFEASIBLE = 'ORDER_INFEASIBLE'
    ROUTING_INCOMPLETE = 'ROUTING_INCOMPLETE'


@dataclass(frozen=True, slots=True)
class MaterializationFailure:
    engineer_id: str
    job_id: str
    origin_location_id: str
    destination_location_id: str
    departure_at: str
    reason: str


@dataclass(frozen=True, slots=True)
class MaterializationResult:
    status: MaterializationStatus
    plan: ProposedPlan | None
    validation: ValidationReport | None
    failure: MaterializationFailure | None
    exact_provider_queries: int
    identity_legs: int
    dropped_job_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class _RouteResult:
    plan: EngineerPlan | None
    failure: MaterializationFailure | None
    failure_status: MaterializationStatus | None
    exact_queries: int
    identity_legs: int
    dropped_job_ids: tuple[str, ...]


def _materialize_route(
    dataset: PlanningDataset,
    master_route,
    oracle: ExactRoutingOracle,
    *,
    drop_order_infeasible: bool,
) -> _RouteResult:
    """Materialize one engineer route; ordering inside the route stays sequential."""
    engineer = dataset.engineers[master_route.engineer_id]
    previous_location_id = dataset.offices[engineer.start_office_id].location_id
    previous_completion = None
    route_start = None
    visits: list[PlannedVisit] = []
    exact_queries = 0
    identity_legs = 0
    dropped_job_ids: list[str] = []
    for master_visit in master_route.visits:
        job = dataset.jobs[master_visit.job_id]
        departure_at = (
            max(dataset.initial_planning_at, engineer.shift_start, job.created_at)
            if previous_completion is None
            else previous_completion
        )
        travel: TravelEvidence
        if previous_location_id == job.location_id:
            travel = IdentityTravel(
                location_id=previous_location_id,
                departure_at=departure_at,
            )
            identity_legs += 1
        else:
            exact_queries += 1
            try:
                exact_route = oracle.query(
                    OracleQuery(
                        mode=engineer.transport_mode,
                        origin=dataset.locations[previous_location_id],
                        destination=dataset.locations[job.location_id],
                        departure_at=departure_at,
                    )
                )
            except RoutingError as error:
                return _RouteResult(
                    None,
                    MaterializationFailure(
                        engineer.engineer_id,
                        job.job_id,
                        previous_location_id,
                        job.location_id,
                        departure_at.isoformat(),
                        str(error),
                    ),
                    MaterializationStatus.ROUTING_INCOMPLETE,
                    exact_queries,
                    identity_legs,
                    tuple(dropped_job_ids),
                )
            if exact_route.status != RouteStatus.OK:
                status = (
                    MaterializationStatus.ROUTING_INCOMPLETE
                    if exact_route.status == RouteStatus.UNKNOWN
                    else MaterializationStatus.ORDER_INFEASIBLE
                )
                return _RouteResult(
                    None,
                    MaterializationFailure(
                        engineer.engineer_id,
                        job.job_id,
                        previous_location_id,
                        job.location_id,
                        departure_at.isoformat(),
                        f'{exact_route.status.value}: {exact_route.provider_status}',
                    ),
                    status,
                    exact_queries,
                    identity_legs,
                    tuple(dropped_job_ids),
                )
            travel = exact_route
        duration_minutes = travel.duration_minutes
        if duration_minutes is None:
            return _RouteResult(
                None,
                MaterializationFailure(
                    engineer.engineer_id,
                    job.job_id,
                    previous_location_id,
                    job.location_id,
                    departure_at.isoformat(),
                    'route evidence has no duration_minutes',
                ),
                MaterializationStatus.ROUTING_INCOMPLETE,
                exact_queries,
                identity_legs,
                tuple(dropped_job_ids),
            )
        arrival = departure_at + timedelta(minutes=duration_minutes)
        service_start = max(arrival, job.window_start)
        service_end = service_start + timedelta(minutes=job.service_duration_min)
        if service_start > job.window_end:
            reason = 'exact arrival makes the closed service-start window impossible'
        elif departure_at < engineer.shift_start or service_end > engineer.shift_end:
            reason = 'exact schedule exceeds the engineer shift'
        elif route_start is not None and (
            service_end - route_start > timedelta(minutes=engineer.max_route_minutes)
        ):
            reason = 'exact schedule exceeds max_route_minutes'
        else:
            reason = ''
        if reason:
            if drop_order_infeasible:
                dropped_job_ids.append(job.job_id)
                continue
            return _RouteResult(
                None,
                MaterializationFailure(
                    engineer.engineer_id,
                    job.job_id,
                    previous_location_id,
                    job.location_id,
                    departure_at.isoformat(),
                    reason,
                ),
                MaterializationStatus.ORDER_INFEASIBLE,
                exact_queries,
                identity_legs,
                tuple(dropped_job_ids),
            )
        if route_start is None:
            route_start = departure_at
        visits.append(
            PlannedVisit(
                job_id=job.job_id,
                departure_at=departure_at,
                service_start_at=service_start,
                travel=travel,
            )
        )
        previous_location_id = job.location_id
        previous_completion = service_end
    return _RouteResult(
        EngineerPlan(engineer_id=engineer.engineer_id, visits=tuple(visits)),
        None,
        None,
        exact_queries,
        identity_legs,
        tuple(dropped_job_ids),
    )


def materialize_exact_initial_plan(
    dataset: PlanningDataset,
    master_solution: MasterSolution,
    oracle: ExactRoutingOracle,
    *,
    drop_order_infeasible: bool = False,
    max_workers: int = 1,
    oracle_factory: Callable[[], ExactRoutingOracle] | None = None,
) -> MaterializationResult:
    """Recalculate routes exactly, parallelizing only independent engineers."""
    if max_workers < 1:
        raise ValueError('max_workers must be positive')
    if max_workers > 1 and oracle_factory is None:
        raise ValueError('oracle_factory is required when max_workers > 1')
    created_clients: list[object] = []
    clients_lock = Lock()
    thread_state = local()

    def process(master_route) -> _RouteResult:
        route_oracle = oracle
        if oracle_factory is not None:
            route_oracle = getattr(thread_state, 'oracle', None)
            if route_oracle is None:
                route_oracle = oracle_factory()
                thread_state.oracle = route_oracle
                with clients_lock:
                    created_clients.append(route_oracle)
        return _materialize_route(
            dataset,
            master_route,
            route_oracle,
            drop_order_infeasible=drop_order_infeasible,
        )

    try:
        if max_workers == 1:
            route_results = [process(route) for route in master_solution.routes]
        else:
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                route_results = list(executor.map(process, master_solution.routes))
    finally:
        for route_oracle in created_clients:
            client = getattr(route_oracle, 'client', None)
            close = getattr(client, 'close', None)
            if close is not None:
                close()

    exact_queries = sum(item.exact_queries for item in route_results)
    identity_legs = sum(item.identity_legs for item in route_results)
    dropped_job_ids = [
        job_id for item in route_results for job_id in item.dropped_job_ids
    ]
    for item in route_results:
        if item.failure is not None:
            return MaterializationResult(
                status=item.failure_status or MaterializationStatus.ORDER_INFEASIBLE,
                plan=None,
                validation=None,
                failure=item.failure,
                exact_provider_queries=exact_queries,
                identity_legs=identity_legs,
                dropped_job_ids=tuple(dropped_job_ids),
            )
    engineer_plans = [item.plan for item in route_results if item.plan is not None]

    plan = ProposedPlan(
        planning_at=master_solution.planning_at,
        engineer_plans=tuple(engineer_plans),
        unserved_job_ids=tuple(
            sorted(set(master_solution.unserved_job_ids) | set(dropped_job_ids))
        ),
    )
    validation = validate_initial_plan(dataset, plan)
    if validation.status == ValidationStatus.ROUTING_INCOMPLETE:
        status = MaterializationStatus.ROUTING_INCOMPLETE
    elif validation.status == ValidationStatus.INVALID:
        status = MaterializationStatus.ORDER_INFEASIBLE
    else:
        status = MaterializationStatus.EXACT_VALID
    return MaterializationResult(
        status=status,
        plan=plan,
        validation=validation,
        failure=None,
        exact_provider_queries=exact_queries,
        identity_legs=identity_legs,
        dropped_job_ids=tuple(dropped_job_ids),
    )
