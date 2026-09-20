from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from beeline_routing.models import TransportMode

from .domain import PlanningDataset
from .eligibility import CandidateIndex, build_candidate_index
from .errors import HardModelInfeasible, InvalidPlanningData
from .screening import ScreeningMatrices


@dataclass(frozen=True, slots=True)
class MasterArc:
    engineer_id: str
    origin_node_id: str
    origin_location_id: str
    destination_job_id: str
    destination_location_id: str
    screening_duration_minutes: int
    screening_distance_m: int
    screening_source_mode: TransportMode
    screening_is_surrogate: bool


@dataclass(frozen=True, slots=True)
class MasterModelInput:
    planning_at: datetime
    candidate_index: CandidateIndex
    arcs: tuple[MasterArc, ...]
    hard_assignments: tuple[tuple[str, str], ...]
    screening_snapshot_sha256: str

    @property
    def assignment_variable_count(self) -> int:
        return sum(
            len(engineers)
            for engineers in self.candidate_index.eligible_engineers_by_job.values()
        )

    @property
    def unserved_variable_count(self) -> int:
        return len(self.candidate_index.active_job_ids)

    @property
    def route_arc_variable_count(self) -> int:
        return len(self.arcs)


def _safe_zero_travel_precedence_possible(
    dataset: PlanningDataset,
    engineer_id: str,
    origin_job_id: str,
    destination_job_id: str,
    planning_at: datetime,
) -> bool:
    """Prune only precedences impossible even with an ideal zero-minute movement."""
    engineer = dataset.engineers[engineer_id]
    origin = dataset.jobs[origin_job_id]
    destination = dataset.jobs[destination_job_id]
    origin_earliest_start = max(
        planning_at,
        origin.created_at,
        origin.window_start,
        engineer.shift_start,
    )
    origin_earliest_completion = origin_earliest_start + timedelta(
        minutes=origin.service_duration_min
    )
    destination_latest_start = min(
        destination.window_end,
        engineer.shift_end - timedelta(minutes=destination.service_duration_min),
    )
    return origin_earliest_completion <= destination_latest_start


def build_master_model_input(
    dataset: PlanningDataset,
    screening: ScreeningMatrices,
    planning_at: datetime | None = None,
    *,
    applied_event_ids: frozenset[str] = frozenset(),
    unavailable_routing_modes: frozenset[TransportMode] = frozenset(),
) -> MasterModelInput:
    """Build solver-neutral variables/arcs without treating screening as route proof."""
    moment = planning_at or dataset.initial_planning_at
    candidates = build_candidate_index(
        dataset,
        moment,
        applied_event_ids=applied_event_ids,
        unavailable_routing_modes=unavailable_routing_modes,
    )
    active_commitments = dataset.active_commitments_at(moment, applied_event_ids)
    for commitment in active_commitments:
        eligible = candidates.eligible_engineers_by_job.get(commitment.job_id, ())
        if commitment.engineer_id not in eligible:
            reasons = candidates.reasons(commitment.engineer_id, commitment.job_id)
            raise HardModelInfeasible(
                f'Hard assignment {commitment.commitment_id} has no feasible candidate: '
                f'{tuple(reason.value for reason in reasons)}'
            )

    eligible_jobs_by_engineer: dict[str, list[str]] = {
        engineer_id: [] for engineer_id in dataset.engineers
    }
    for job_id, engineer_ids in candidates.eligible_engineers_by_job.items():
        for engineer_id in engineer_ids:
            eligible_jobs_by_engineer[engineer_id].append(job_id)

    arcs: list[MasterArc] = []
    for engineer_id in sorted(dataset.engineers):
        engineer = dataset.engineers[engineer_id]
        office = dataset.offices[engineer.start_office_id]
        job_ids = sorted(eligible_jobs_by_engineer[engineer_id])
        for destination_job_id in job_ids:
            destination = dataset.jobs[destination_job_id]
            estimate = screening.estimate(
                engineer.zone_id,
                engineer.transport_mode,
                office.location_id,
                destination.location_id,
            )
            arcs.append(
                MasterArc(
                    engineer_id=engineer_id,
                    origin_node_id=f'START:{engineer_id}',
                    origin_location_id=office.location_id,
                    destination_job_id=destination_job_id,
                    destination_location_id=destination.location_id,
                    screening_duration_minutes=estimate.duration_minutes,
                    screening_distance_m=estimate.distance_m,
                    screening_source_mode=estimate.source_mode,
                    screening_is_surrogate=estimate.is_surrogate,
                )
            )
        for origin_job_id in job_ids:
            origin = dataset.jobs[origin_job_id]
            for destination_job_id in job_ids:
                if origin_job_id == destination_job_id:
                    continue
                if not _safe_zero_travel_precedence_possible(
                    dataset,
                    engineer_id,
                    origin_job_id,
                    destination_job_id,
                    moment,
                ):
                    continue
                destination = dataset.jobs[destination_job_id]
                estimate = screening.estimate(
                    engineer.zone_id,
                    engineer.transport_mode,
                    origin.location_id,
                    destination.location_id,
                )
                arcs.append(
                    MasterArc(
                        engineer_id=engineer_id,
                        origin_node_id=origin_job_id,
                        origin_location_id=origin.location_id,
                        destination_job_id=destination_job_id,
                        destination_location_id=destination.location_id,
                        screening_duration_minutes=estimate.duration_minutes,
                        screening_distance_m=estimate.distance_m,
                        screening_source_mode=estimate.source_mode,
                        screening_is_surrogate=estimate.is_surrogate,
                    )
                )
    arc_keys = {
        (arc.engineer_id, arc.origin_node_id, arc.destination_job_id)
        for arc in arcs
    }
    if len(arc_keys) != len(arcs):
        raise InvalidPlanningData('Master graph contains duplicate arcs')
    return MasterModelInput(
        planning_at=moment,
        candidate_index=candidates,
        arcs=tuple(arcs),
        hard_assignments=tuple(
            sorted((item.engineer_id, item.job_id) for item in active_commitments)
        ),
        screening_snapshot_sha256=screening.snapshot_sha256,
    )
