from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from types import MappingProxyType
from typing import Mapping

from beeline_routing.models import TransportMode

from .domain import Engineer, Job, PlanningDataset, RequiredTransport
from .errors import InvalidPlanningData


class RejectionCode(StrEnum):
    JOB_NOT_CREATED = 'JOB_NOT_CREATED'
    ENGINEER_UNAVAILABLE = 'ENGINEER_UNAVAILABLE'
    ZONE_MISMATCH = 'ZONE_MISMATCH'
    SKILL_MISSING = 'SKILL_MISSING'
    TRANSPORT_MISMATCH = 'TRANSPORT_MISMATCH'
    PERSONAL_EQUIPMENT_MISSING = 'PERSONAL_EQUIPMENT_MISSING'
    HARD_COMMITMENT_TO_OTHER_ENGINEER = 'HARD_COMMITMENT_TO_OTHER_ENGINEER'
    SHIFT_WINDOW_NO_OVERLAP = 'SHIFT_WINDOW_NO_OVERLAP'
    ROUTING_MODE_UNAVAILABLE = 'ROUTING_MODE_UNAVAILABLE'


@dataclass(frozen=True, slots=True)
class CandidateIndex:
    planning_at: datetime
    active_job_ids: tuple[str, ...]
    eligible_engineers_by_job: Mapping[str, tuple[str, ...]]
    rejection_codes: Mapping[tuple[str, str], tuple[RejectionCode, ...]]

    def reasons(self, engineer_id: str, job_id: str) -> tuple[RejectionCode, ...]:
        return self.rejection_codes.get((engineer_id, job_id), ())


def _static_reasons(
    dataset: PlanningDataset,
    engineer: Engineer,
    job: Job,
    planning_at: datetime,
    committed_engineer_id: str | None,
) -> tuple[RejectionCode, ...]:
    reasons: list[RejectionCode] = []
    if job.created_at > planning_at:
        reasons.append(RejectionCode.JOB_NOT_CREATED)
    if not engineer.is_available:
        reasons.append(RejectionCode.ENGINEER_UNAVAILABLE)
    if engineer.zone_id != job.zone_id:
        reasons.append(RejectionCode.ZONE_MISMATCH)
    if job.required_skill not in engineer.skills:
        reasons.append(RejectionCode.SKILL_MISSING)
    if (
        job.required_transport == RequiredTransport.CAR
        and engineer.transport_mode != TransportMode.CAR
    ):
        reasons.append(RejectionCode.TRANSPORT_MISMATCH)
    for need in job.required_equipment:
        item = dataset.equipment_catalog[need.equipment_id]
        if item.reusable and engineer.equipment_quantity(need.equipment_id) < need.quantity:
            reasons.append(RejectionCode.PERSONAL_EQUIPMENT_MISSING)
            break
    if committed_engineer_id is not None and engineer.engineer_id != committed_engineer_id:
        reasons.append(RejectionCode.HARD_COMMITMENT_TO_OTHER_ENGINEER)

    earliest_start = max(job.window_start, engineer.shift_start, job.created_at, planning_at)
    latest_start = min(
        job.window_end,
        engineer.shift_end - timedelta(minutes=job.service_duration_min),
    )
    if earliest_start > latest_start:
        reasons.append(RejectionCode.SHIFT_WINDOW_NO_OVERLAP)
    return tuple(reasons)


def build_candidate_index(
    dataset: PlanningDataset,
    planning_at: datetime | None = None,
    *,
    applied_event_ids: frozenset[str] = frozenset(),
    unavailable_routing_modes: frozenset[TransportMode] = frozenset(),
) -> CandidateIndex:
    """Build exact static candidates and retain every rejection reason for explanations."""
    moment = planning_at or dataset.initial_planning_at
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise InvalidPlanningData('planning_at must include a timezone')
    commitments_by_job: dict[str, str] = {}
    for commitment in dataset.active_commitments_at(moment, applied_event_ids):
        existing = commitments_by_job.setdefault(commitment.job_id, commitment.engineer_id)
        if existing != commitment.engineer_id:
            raise InvalidPlanningData(
                f'Conflicting hard commitments for job {commitment.job_id}'
            )

    eligible: dict[str, tuple[str, ...]] = {}
    rejected: dict[tuple[str, str], tuple[RejectionCode, ...]] = {}
    active_jobs = dataset.active_jobs_at(moment)
    for job in active_jobs:
        candidates: list[str] = []
        for engineer in sorted(dataset.engineers.values(), key=lambda item: item.engineer_id):
            reasons = list(_static_reasons(
                dataset,
                engineer,
                job,
                moment,
                commitments_by_job.get(job.job_id),
            ))
            if engineer.transport_mode in unavailable_routing_modes:
                reasons.append(RejectionCode.ROUTING_MODE_UNAVAILABLE)
            if reasons:
                rejected[(engineer.engineer_id, job.job_id)] = tuple(reasons)
            else:
                candidates.append(engineer.engineer_id)
        eligible[job.job_id] = tuple(candidates)
    return CandidateIndex(
        planning_at=moment,
        active_job_ids=tuple(job.job_id for job in active_jobs),
        eligible_engineers_by_job=MappingProxyType(eligible),
        rejection_codes=MappingProxyType(rejected),
    )
