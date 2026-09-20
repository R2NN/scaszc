from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from beeline_routing.models import DetailedRoute


@dataclass(frozen=True, slots=True)
class IdentityTravel:
    """Exact zero movement proof for two jobs at the identical dataset location."""

    location_id: str
    departure_at: datetime

    @property
    def origin_id(self) -> str:
        return self.location_id

    @property
    def destination_id(self) -> str:
        return self.location_id

    @property
    def duration_seconds(self) -> int:
        return 0

    @property
    def duration_minutes(self) -> int:
        return 0

    @property
    def distance_m(self) -> int:
        return 0


TravelEvidence = DetailedRoute | IdentityTravel


@dataclass(frozen=True, slots=True)
class PlannedVisit:
    job_id: str
    departure_at: datetime
    service_start_at: datetime
    travel: TravelEvidence


@dataclass(frozen=True, slots=True)
class EngineerPlan:
    engineer_id: str
    visits: tuple[PlannedVisit, ...]


@dataclass(frozen=True, slots=True)
class ProposedPlan:
    planning_at: datetime
    engineer_plans: tuple[EngineerPlan, ...]
    unserved_job_ids: tuple[str, ...]
