from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum
from typing import Callable, MutableMapping

from beeline_routing.errors import RoutingError
from beeline_routing.models import RouteStatus
from beeline_routing.oracle import ExactRoutingOracle, OracleQuery

from .domain import PlanningDataset
from .solver import MasterSolution


class ProbeFailureKind(StrEnum):
    """Provider outcomes that require different refinement decisions."""

    UNKNOWN = 'UNKNOWN'
    UNREACHABLE = 'UNREACHABLE'


class RefinementFailureKind(StrEnum):
    """Exact outcomes used by the automatic solve/check/refine loop."""

    ROUTING_UNKNOWN = 'ROUTING_UNKNOWN'
    UNREACHABLE = 'UNREACHABLE'
    WINDOW = 'WINDOW'
    SHIFT = 'SHIFT'
    ROUTE_LIMIT = 'ROUTE_LIMIT'


@dataclass(frozen=True, slots=True)
class ExactArcObservation:
    """One exact duration that can tighten the screening search model."""

    engineer_id: str
    zone_id: str
    origin_node_id: str
    destination_job_id: str
    departure_at: str
    screening_duration_minutes: int
    exact_duration_minutes: int
    exact_distance_m: int


@dataclass(frozen=True, slots=True)
class ExactRefinementFailure:
    """First exact failure on one route, with an actionable arc identity."""

    kind: RefinementFailureKind
    engineer_id: str
    zone_id: str
    origin_node_id: str
    destination_job_id: str
    departure_at: str
    reason: str


@dataclass(frozen=True, slots=True)
class ExactRefinementReport:
    """Exact observations and at most one failure for each engineer route."""

    observations: tuple[ExactArcObservation, ...]
    failures: tuple[ExactRefinementFailure, ...]
    complete_engineer_ids: tuple[str, ...]
    exact_provider_queries: int
    identity_legs: int


@dataclass(frozen=True, slots=True)
class RefinementActions:
    """Deterministic model changes derived from one exact inspection."""

    changed_zones: frozenset[str]
    duration_updates: tuple[ExactArcObservation, ...]
    new_cuts: tuple[tuple[str, str, str], ...]
    blocked_unknown: bool


def apply_refinement_report(
    report: ExactRefinementReport,
    *,
    duration_overrides: dict[tuple[str, str, str], int],
    cuts: set[tuple[str, str, str]],
    failure_counts: MutableMapping[tuple[str, tuple[str, str, str]], int],
    max_unknown_retries: int,
) -> RefinementActions:
    """Update exact duration/cut state without treating UNKNOWN as unreachable."""
    if max_unknown_retries < 1:
        raise ValueError('max_unknown_retries must be positive')
    failure_zones = {failure.zone_id for failure in report.failures}
    observations = {
        (item.engineer_id, item.origin_node_id, item.destination_job_id): item
        for item in report.observations
        if item.zone_id in failure_zones
    }
    changed_zones: set[str] = set()
    duration_updates: list[ExactArcObservation] = []
    for key, observation in observations.items():
        previous = duration_overrides.get(
            key,
            observation.screening_duration_minutes,
        )
        if observation.exact_duration_minutes > previous:
            duration_overrides[key] = observation.exact_duration_minutes
            changed_zones.add(observation.zone_id)
            duration_updates.append(observation)

    new_cuts: list[tuple[str, str, str]] = []
    blocked_unknown = False
    for failure in report.failures:
        key = (
            failure.engineer_id,
            failure.origin_node_id,
            failure.destination_job_id,
        )
        counter_key = (failure.kind.value, key)
        failure_counts[counter_key] = failure_counts.get(counter_key, 0) + 1
        if failure.kind == RefinementFailureKind.ROUTING_UNKNOWN:
            if failure_counts[counter_key] > max_unknown_retries:
                blocked_unknown = True
            continue
        should_cut = failure.kind == RefinementFailureKind.UNREACHABLE
        if failure.kind in {
            RefinementFailureKind.WINDOW,
            RefinementFailureKind.SHIFT,
            RefinementFailureKind.ROUTE_LIMIT,
        }:
            observation = observations.get(key)
            should_cut = (
                observation is None
                or (
                    observation.exact_duration_minutes
                    <= duration_overrides.get(
                        key,
                        observation.screening_duration_minutes,
                    )
                    and failure_counts[counter_key] > 1
                )
            )
        if should_cut and key not in cuts:
            cuts.add(key)
            changed_zones.add(failure.zone_id)
            new_cuts.append(key)
    return RefinementActions(
        frozenset(changed_zones),
        tuple(duration_updates),
        tuple(new_cuts),
        blocked_unknown,
    )


def inspect_exact_candidate(
    dataset: PlanningDataset,
    master_solution: MasterSolution,
    oracle: ExactRoutingOracle,
) -> ExactRefinementReport:
    """Inspect a candidate and emit exact durations and actionable failures."""
    observations: list[ExactArcObservation] = []
    failures: list[ExactRefinementFailure] = []
    complete_engineer_ids: list[str] = []
    exact_queries = 0
    identity_legs = 0
    for master_route in master_solution.routes:
        engineer = dataset.engineers[master_route.engineer_id]
        previous_location_id = dataset.offices[engineer.start_office_id].location_id
        previous_completion = None
        route_start = None
        route_failed = False
        for master_visit in master_route.visits:
            job = dataset.jobs[master_visit.job_id]
            departure_at = (
                max(dataset.initial_planning_at, engineer.shift_start, job.created_at)
                if previous_completion is None
                else previous_completion
            )
            duration_minutes = 0
            if previous_location_id == job.location_id:
                identity_legs += 1
                distance_m = 0
            else:
                exact_queries += 1
                try:
                    route = oracle.query(
                        OracleQuery(
                            mode=engineer.transport_mode,
                            origin=dataset.locations[previous_location_id],
                            destination=dataset.locations[job.location_id],
                            departure_at=departure_at,
                        )
                    )
                except RoutingError as error:
                    failures.append(
                        ExactRefinementFailure(
                            RefinementFailureKind.ROUTING_UNKNOWN,
                            engineer.engineer_id,
                            engineer.zone_id,
                            master_visit.origin_node_id,
                            job.job_id,
                            departure_at.isoformat(),
                            str(error),
                        )
                    )
                    route_failed = True
                    break
                if route.status != RouteStatus.OK or route.duration_minutes is None:
                    kind = (
                        RefinementFailureKind.UNREACHABLE
                        if route.status == RouteStatus.UNREACHABLE
                        else RefinementFailureKind.ROUTING_UNKNOWN
                    )
                    failures.append(
                        ExactRefinementFailure(
                            kind,
                            engineer.engineer_id,
                            engineer.zone_id,
                            master_visit.origin_node_id,
                            job.job_id,
                            departure_at.isoformat(),
                            f'{route.status.value}: {route.provider_status}',
                        )
                    )
                    route_failed = True
                    break
                duration_minutes = route.duration_minutes
                distance_m = route.distance_m or 0
                observations.append(
                    ExactArcObservation(
                        engineer.engineer_id,
                        engineer.zone_id,
                        master_visit.origin_node_id,
                        job.job_id,
                        departure_at.isoformat(),
                        master_visit.screening_duration_minutes,
                        duration_minutes,
                        distance_m,
                    )
                )
            arrival = departure_at + timedelta(minutes=duration_minutes)
            service_start = max(arrival, job.window_start, job.created_at)
            service_end = service_start + timedelta(minutes=job.service_duration_min)
            if service_start > job.window_end:
                kind = RefinementFailureKind.WINDOW
                reason = 'exact arrival exceeds the closed service-start window'
            elif service_end > engineer.shift_end:
                kind = RefinementFailureKind.SHIFT
                reason = 'exact schedule exceeds the engineer shift'
            elif route_start is not None and (
                service_end - route_start > timedelta(minutes=engineer.max_route_minutes)
            ):
                kind = RefinementFailureKind.ROUTE_LIMIT
                reason = 'exact schedule exceeds max_route_minutes'
            else:
                kind = None
                reason = ''
            if kind is not None:
                failures.append(
                    ExactRefinementFailure(
                        kind,
                        engineer.engineer_id,
                        engineer.zone_id,
                        master_visit.origin_node_id,
                        job.job_id,
                        departure_at.isoformat(),
                        reason,
                    )
                )
                route_failed = True
                break
            if route_start is None:
                route_start = departure_at
            previous_location_id = job.location_id
            previous_completion = service_end
        if not route_failed:
            complete_engineer_ids.append(engineer.engineer_id)
    return ExactRefinementReport(
        tuple(observations),
        tuple(failures),
        tuple(complete_engineer_ids),
        exact_queries,
        identity_legs,
    )


@dataclass(frozen=True, slots=True)
class ExactRouteProbeFailure:
    """First exact-routing failure found on one engineer's selected route."""

    kind: ProbeFailureKind
    engineer_id: str
    origin_node_id: str
    job_id: str
    origin_location_id: str
    destination_location_id: str
    departure_at: str
    reason: str


@dataclass(frozen=True, slots=True)
class ExactRouteProbeReport:
    """Non-authoritative routing diagnostics for a screening solution."""

    failures: tuple[ExactRouteProbeFailure, ...]
    complete_engineer_ids: tuple[str, ...]
    exact_provider_queries: int
    identity_legs: int


def probe_exact_initial_plan_routes(
    dataset: PlanningDataset,
    master_solution: MasterSolution,
    oracle: ExactRoutingOracle,
    *,
    on_progress: Callable[[ExactRouteProbeReport], None] | None = None,
    resume_from: ExactRouteProbeReport | None = None,
) -> ExactRouteProbeReport:
    """Collect at most one exact-routing failure per independent engineer route.

    A failed leg makes the departure times of later legs on the same route unknown,
    so that route is stopped. Other engineers are independent and remain safe to
    probe. This function is diagnostic only and never validates or publishes a plan.
    """
    failures: list[ExactRouteProbeFailure] = (
        list(resume_from.failures) if resume_from is not None else []
    )
    complete_engineer_ids: list[str] = (
        list(resume_from.complete_engineer_ids) if resume_from is not None else []
    )
    exact_queries = resume_from.exact_provider_queries if resume_from is not None else 0
    identity_legs = resume_from.identity_legs if resume_from is not None else 0
    processed = len(failures) + len(complete_engineer_ids)
    previous_ids = complete_engineer_ids + [failure.engineer_id for failure in failures]
    expected_ids = [route.engineer_id for route in master_solution.routes[:processed]]
    if len(set(previous_ids)) != processed or set(previous_ids) != set(expected_ids):
        raise ValueError('Probe checkpoint does not match the master route prefix')

    def report() -> ExactRouteProbeReport:
        return ExactRouteProbeReport(
            failures=tuple(failures),
            complete_engineer_ids=tuple(complete_engineer_ids),
            exact_provider_queries=exact_queries,
            identity_legs=identity_legs,
        )

    for master_route in master_solution.routes[processed:]:
        engineer = dataset.engineers[master_route.engineer_id]
        previous_location_id = dataset.offices[engineer.start_office_id].location_id
        previous_completion = None
        route_failed = False

        for master_visit in master_route.visits:
            job = dataset.jobs[master_visit.job_id]
            departure_at = (
                master_visit.departure_at
                if previous_completion is None
                else previous_completion
            )
            duration_minutes = 0
            if previous_location_id == job.location_id:
                identity_legs += 1
            else:
                exact_queries += 1
                try:
                    route = oracle.query(
                        OracleQuery(
                            mode=engineer.transport_mode,
                            origin=dataset.locations[previous_location_id],
                            destination=dataset.locations[job.location_id],
                            departure_at=departure_at,
                        )
                    )
                except RoutingError as error:
                    failures.append(
                        ExactRouteProbeFailure(
                            kind=ProbeFailureKind.UNKNOWN,
                            engineer_id=engineer.engineer_id,
                            origin_node_id=master_visit.origin_node_id,
                            job_id=job.job_id,
                            origin_location_id=previous_location_id,
                            destination_location_id=job.location_id,
                            departure_at=departure_at.isoformat(),
                            reason=str(error),
                        )
                    )
                    route_failed = True
                    break
                if route.status != RouteStatus.OK or route.duration_minutes is None:
                    kind = (
                        ProbeFailureKind.UNREACHABLE
                        if route.status == RouteStatus.UNREACHABLE
                        else ProbeFailureKind.UNKNOWN
                    )
                    failures.append(
                        ExactRouteProbeFailure(
                            kind=kind,
                            engineer_id=engineer.engineer_id,
                            origin_node_id=master_visit.origin_node_id,
                            job_id=job.job_id,
                            origin_location_id=previous_location_id,
                            destination_location_id=job.location_id,
                            departure_at=departure_at.isoformat(),
                            reason=f'{route.status.value}: {route.provider_status}',
                        )
                    )
                    route_failed = True
                    break
                duration_minutes = route.duration_minutes

            arrival_at = departure_at + timedelta(minutes=duration_minutes)
            service_start_at = max(arrival_at, job.window_start)
            previous_completion = service_start_at + timedelta(
                minutes=job.service_duration_min
            )
            previous_location_id = job.location_id

        if not route_failed:
            complete_engineer_ids.append(engineer.engineer_id)
        if on_progress is not None:
            on_progress(report())

    return report()
