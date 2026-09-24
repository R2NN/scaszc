from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from typing import Any, Mapping

from beeline_routing.models import Coordinate, TransportMode


class Priority(StrEnum):
    NORMAL = 'NORMAL'
    URGENT = 'URGENT'


class RequiredTransport(StrEnum):
    ANY = 'ANY'
    CAR = 'CAR'
    PUBLIC_TRANSIT = 'PUBLIC_TRANSIT'
    BICYCLE = 'BICYCLE'
    WALKING = 'WALKING'

    def allows(self, mode: TransportMode) -> bool:
        """Allow any mode for ANY, otherwise require the engineer's exact mode."""
        return self is RequiredTransport.ANY or self.value == mode.value


class JobStatus(StrEnum):
    PENDING = 'PENDING'


class EventType(StrEnum):
    NEW_URGENT_JOB = 'NEW_URGENT_JOB'
    ENGINEER_UNAVAILABLE = 'ENGINEER_UNAVAILABLE'
    CANCEL_JOB = 'CANCEL_JOB'
    MANUAL_ASSIGNMENT = 'MANUAL_ASSIGNMENT'


class CommitmentType(StrEnum):
    HARD_ASSIGNMENT = 'HARD_ASSIGNMENT'


@dataclass(frozen=True, slots=True, order=True)
class EquipmentNeed:
    equipment_id: str
    quantity: int


@dataclass(frozen=True, slots=True)
class Equipment:
    equipment_id: str
    category: str
    reusable: bool
    shared_stock: bool


@dataclass(frozen=True, slots=True)
class Office:
    office_id: str
    zone_id: str
    location_id: str


@dataclass(frozen=True, slots=True)
class Engineer:
    engineer_id: str
    zone_id: str
    shift_start: datetime
    shift_end: datetime
    start_office_id: str
    transport_mode: TransportMode
    is_available: bool
    max_jobs: int
    max_route_minutes: int
    skills: frozenset[str]
    equipment: tuple[EquipmentNeed, ...]

    def equipment_quantity(self, equipment_id: str) -> int:
        return next(
            (need.quantity for need in self.equipment if need.equipment_id == equipment_id),
            0,
        )


@dataclass(frozen=True, slots=True)
class Job:
    job_id: str
    zone_id: str
    location_id: str
    window_start: datetime
    window_end: datetime
    created_at: datetime
    service_duration_min: int
    priority: Priority
    required_skill: str
    required_transport: RequiredTransport
    required_equipment: tuple[EquipmentNeed, ...]
    is_event_job: bool
    status: JobStatus


@dataclass(frozen=True, slots=True)
class SharedInventory:
    zone_id: str
    equipment_id: str
    quantity_available: int


@dataclass(frozen=True, slots=True)
class Event:
    apply_order: int
    event_id: str
    event_time: datetime
    event_type: EventType
    target_id: str
    zone_id: str
    unavailable_until: datetime | None
    payload: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class Commitment:
    commitment_id: str
    job_id: str
    engineer_id: str
    commitment_type: CommitmentType
    effective_from: datetime
    release_event_id: str


@dataclass(frozen=True, slots=True)
class PlanningDataset:
    root: Path
    dataset_version: str
    dataset_sha256: str
    scenario: str
    timezone_name: str
    planning_date: str
    initial_planning_at: datetime
    locations: Mapping[str, Coordinate]
    offices: Mapping[str, Office]
    equipment_catalog: Mapping[str, Equipment]
    engineers: Mapping[str, Engineer]
    jobs: Mapping[str, Job]
    shared_inventory: tuple[SharedInventory, ...]
    events: tuple[Event, ...]
    commitments: tuple[Commitment, ...]
    constraint_policies: Mapping[str, Any]

    def active_jobs_at(self, moment: datetime) -> tuple[Job, ...]:
        """Return jobs known by `moment`; canceled state is applied by the event engine later."""
        return tuple(
            sorted(
                (job for job in self.jobs.values() if job.created_at <= moment),
                key=lambda job: job.job_id,
            )
        )

    def active_commitments_at(
        self,
        moment: datetime,
        applied_event_ids: frozenset[str] = frozenset(),
    ) -> tuple[Commitment, ...]:
        return tuple(
            commitment
            for commitment in self.commitments
            if commitment.effective_from <= moment
            and commitment.release_event_id not in applied_event_ids
        )
