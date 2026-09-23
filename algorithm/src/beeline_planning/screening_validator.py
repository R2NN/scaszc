"""Independent validation of a screening master solution without routing calls."""

from __future__ import annotations

from datetime import timedelta

from .domain import PlanningDataset
from .master import MasterModelInput
from .solver import MasterSolution, MasterSolveStatus


def validate_screening_solution(
    dataset: PlanningDataset,
    master: MasterModelInput,
    solution: MasterSolution,
) -> tuple[str, ...]:
    """Check the concrete screening schedule against its dataset and matrix graph.

    This proves screening feasibility only. Exact, time-dependent route
    feasibility still requires the independent exact-plan validator.
    """
    errors: list[str] = []
    if solution.status in {
        MasterSolveStatus.SCREENING_INFEASIBLE,
        MasterSolveStatus.NO_SOLUTION_WITHIN_LIMIT,
    }:
        errors.append(f'No feasible screening solution: {solution.status.value}')
    if solution.dataset_sha256 != dataset.dataset_sha256:
        errors.append('Dataset checksum differs from solution')
    if solution.screening_snapshot_sha256 != master.screening_snapshot_sha256:
        errors.append('Screening checksum differs from solution')
    if solution.planning_at != master.planning_at:
        errors.append('Planning time differs from master input')

    active = set(master.candidate_index.active_job_ids)
    unserved = set(solution.unserved_job_ids)
    if len(unserved) != len(solution.unserved_job_ids):
        errors.append('Duplicate unserved job')
    if unserved - active:
        errors.append(f'Unknown unserved jobs: {sorted(unserved - active)}')
    arcs = {
        (arc.engineer_id, arc.origin_node_id, arc.destination_job_id): arc
        for arc in master.arcs
    }
    seen: set[str] = set()
    routed_engineers: set[str] = set()
    for route in solution.routes:
        engineer_id = route.engineer_id
        engineer = dataset.engineers.get(engineer_id)
        if engineer is None:
            errors.append(f'Unknown engineer: {engineer_id}')
            continue
        if engineer_id in routed_engineers:
            errors.append(f'Duplicate engineer route: {engineer_id}')
        routed_engineers.add(engineer_id)
        if not route.visits:
            errors.append(f'Empty engineer route: {engineer_id}')
            continue
        if len(route.visits) > engineer.max_jobs:
            errors.append(f'Max jobs exceeded: {engineer_id}')
        origin = f'START:{engineer_id}'
        first_departure = route.visits[0].departure_at
        previous_completion = None
        for sequence, visit in enumerate(route.visits, start=1):
            job_id = visit.job_id
            job = dataset.jobs.get(job_id)
            if job is None or job_id not in active:
                errors.append(f'Unknown or inactive job: {job_id}')
                continue
            if job_id in seen:
                errors.append(f'Duplicate served job: {job_id}')
            seen.add(job_id)
            if engineer_id not in master.candidate_index.eligible_engineers_by_job[job_id]:
                errors.append(f'Ineligible assignment: {engineer_id}/{job_id}')
            if visit.sequence != sequence or visit.origin_node_id != origin:
                errors.append(f'Broken route order: {engineer_id}/{job_id}')
            arc = arcs.get((engineer_id, origin, job_id))
            if arc is None:
                errors.append(f'Unknown screening arc: {engineer_id}/{origin}/{job_id}')
            elif (
                visit.screening_duration_minutes != arc.screening_duration_minutes
                or visit.screening_distance_m != arc.screening_distance_m
                or visit.screening_source_mode != arc.screening_source_mode.value
                or visit.screening_is_surrogate != arc.screening_is_surrogate
            ):
                errors.append(f'Screening arc data changed: {engineer_id}/{job_id}')
            earliest_departure = max(
                master.planning_at, engineer.shift_start, job.created_at
            )
            if visit.departure_at < earliest_departure:
                errors.append(f'Departure too early: {engineer_id}/{job_id}')
            if previous_completion is not None and visit.departure_at != previous_completion:
                errors.append(f'Route timing discontinuity: {engineer_id}/{job_id}')
            if not job.window_start <= visit.service_start_at <= job.window_end:
                errors.append(f'Client window violated: {engineer_id}/{job_id}')
            if visit.service_start_at < job.created_at:
                errors.append(f'Job started before creation: {engineer_id}/{job_id}')
            if visit.service_start_at < visit.departure_at + timedelta(
                minutes=visit.screening_duration_minutes
            ):
                errors.append(f'Travel time violated: {engineer_id}/{job_id}')
            previous_completion = visit.service_start_at + timedelta(
                minutes=job.service_duration_min
            )
            if previous_completion > engineer.shift_end:
                errors.append(f'Shift end violated: {engineer_id}/{job_id}')
            origin = job_id
        if (
            previous_completion is not None
            and previous_completion - first_departure
            > timedelta(minutes=engineer.max_route_minutes)
        ):
            errors.append(f'Max route time exceeded: {engineer_id}')

    if seen & unserved:
        errors.append(f'Jobs both served and unserved: {sorted(seen & unserved)}')
    if (seen | unserved) != active:
        errors.append(f'Missing jobs: {sorted(active - seen - unserved)}')
    for engineer_id, job_id in master.hard_assignments:
        if job_id not in seen or not any(
            route.engineer_id == engineer_id
            and any(visit.job_id == job_id for visit in route.visits)
            for route in solution.routes
        ):
            errors.append(f'Hard assignment violated: {engineer_id}/{job_id}')

    inventory = {
        (item.zone_id, item.equipment_id): item.quantity_available
        for item in dataset.shared_inventory
    }
    for job_id in seen:
        job = dataset.jobs[job_id]
        for need in job.required_equipment:
            key = (job.zone_id, need.equipment_id)
            if key in inventory:
                inventory[key] -= need.quantity
    for key, remaining in inventory.items():
        if remaining < 0:
            errors.append(f'Shared equipment exceeded: {key}')
    return tuple(errors)
