"""Dataset-independent lexicographic quality comparison for screening solutions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from .domain import PlanningDataset, Priority
from .solver import MasterSolution


@dataclass(frozen=True, slots=True)
class ScreeningSolutionQuality:
    """Business objective values in their strict comparison order."""

    unserved_urgent_jobs: int
    unserved_normal_jobs: int
    used_engineers: int
    urgent_response_minutes: int
    screening_total_distance_m: int
    screening_total_travel_minutes: int
    screening_total_waiting_minutes: int
    screening_workload_imbalance_minutes: int
    deterministic_route_signature: tuple[tuple[str, tuple[str, ...]], ...]

    @property
    def key(self) -> tuple[object, ...]:
        """Return the complete lexicographic minimization key."""
        return (
            self.unserved_urgent_jobs,
            self.unserved_normal_jobs,
            self.used_engineers,
            self.urgent_response_minutes,
            self.screening_total_distance_m,
            self.screening_total_travel_minutes,
            self.screening_total_waiting_minutes,
            self.screening_workload_imbalance_minutes,
            self.deterministic_route_signature,
        )

    def as_dict(self) -> dict[str, object]:
        """Serialize every comparison tier for audit artifacts."""
        return {
            'unserved_urgent_jobs': self.unserved_urgent_jobs,
            'unserved_normal_jobs': self.unserved_normal_jobs,
            'used_engineers': self.used_engineers,
            'urgent_response_minutes': self.urgent_response_minutes,
            'screening_total_distance_m': self.screening_total_distance_m,
            'screening_total_travel_minutes': self.screening_total_travel_minutes,
            'screening_total_waiting_minutes': self.screening_total_waiting_minutes,
            'screening_workload_imbalance_minutes': (
                self.screening_workload_imbalance_minutes
            ),
            'deterministic_route_signature': [
                [engineer_id, list(job_ids)]
                for engineer_id, job_ids in self.deterministic_route_signature
            ],
        }


def screening_solution_quality(
    dataset: PlanningDataset,
    solution: MasterSolution,
) -> ScreeningSolutionQuality:
    """Calculate the compact-team objective vector from a concrete solution."""
    unserved_urgent = sum(
        dataset.jobs[job_id].priority == Priority.URGENT
        for job_id in solution.unserved_job_ids
    )
    unserved_normal = len(solution.unserved_job_ids) - unserved_urgent
    urgent_response = 0
    distance = 0
    travel = 0
    waiting = 0
    route_loads: list[int] = []
    signature: list[tuple[str, tuple[str, ...]]] = []
    for route in sorted(solution.routes, key=lambda item: item.engineer_id):
        signature.append((
            route.engineer_id,
            tuple(visit.job_id for visit in route.visits),
        ))
        if route.visits:
            first_departure = route.visits[0].departure_at
            last_visit = route.visits[-1]
            last_completion = (
                last_visit.service_start_at
                + timedelta(
                    minutes=dataset.jobs[last_visit.job_id].service_duration_min
                )
            )
            route_loads.append(
                max(0, int((last_completion - first_departure).total_seconds() // 60))
            )
        for visit in route.visits:
            job = dataset.jobs[visit.job_id]
            if job.priority == Priority.URGENT:
                urgent_response += max(0, int((
                    visit.service_start_at - max(solution.planning_at, job.created_at)
                ).total_seconds() // 60))
            distance += visit.screening_distance_m
            travel += visit.screening_duration_minutes
            waiting += max(0, int((
                visit.service_start_at - visit.departure_at
            ).total_seconds() // 60) - visit.screening_duration_minutes)
    imbalance = sum(
        abs(left - right)
        for index, left in enumerate(route_loads)
        for right in route_loads[index + 1:]
    )
    return ScreeningSolutionQuality(
        unserved_urgent,
        unserved_normal,
        len(solution.routes),
        urgent_response,
        distance,
        travel,
        waiting,
        imbalance,
        tuple(signature),
    )
