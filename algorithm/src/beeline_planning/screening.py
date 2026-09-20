from __future__ import annotations

import csv
import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import MappingProxyType
from typing import Mapping

from beeline_routing.models import RouteStatus, TransportMode
from beeline_routing.export import payload_sha256

from .domain import PlanningDataset
from .errors import InvalidPlanningData


SCREENING_PURPOSE = 'SCREENING_ONLY_NOT_AUTHORITATIVE_FOR_TIME_DEPENDENT_CONSTRAINTS'
SCREENING_MODES = (
    TransportMode.CAR,
    TransportMode.BICYCLE,
    TransportMode.WALKING,
)
OPTIONAL_SCREENING_MODE = TransportMode.PUBLIC_TRANSIT


@dataclass(frozen=True, slots=True)
class ScreeningCell:
    origin_id: str
    destination_id: str
    source_mode: TransportMode
    duration_minutes: int
    distance_m: int


@dataclass(frozen=True, slots=True)
class ScreeningEstimate:
    requested_mode: TransportMode
    source_mode: TransportMode
    duration_minutes: int
    distance_m: int

    @property
    def is_surrogate(self) -> bool:
        return self.requested_mode != self.source_mode


@dataclass(frozen=True, slots=True)
class ScreeningMatrices:
    snapshot_sha256: str
    cells: Mapping[tuple[str, TransportMode, str, str], ScreeningCell]

    def estimate(
        self,
        zone_id: str,
        mode: TransportMode,
        origin_id: str,
        destination_id: str,
    ) -> ScreeningEstimate:
        # Older snapshots use walking as an explicit PT search surrogate. A local
        # transit screening matrix is preferred when the complete snapshot exists.
        direct_key = (zone_id, mode, origin_id, destination_id)
        source_mode = (
            mode
            if direct_key in self.cells
            else TransportMode.WALKING if mode == TransportMode.PUBLIC_TRANSIT else mode
        )
        try:
            cell = self.cells[(zone_id, source_mode, origin_id, destination_id)]
        except KeyError as error:
            raise InvalidPlanningData(
                f'Missing screening cell {zone_id}/{source_mode}/{origin_id}->{destination_id}'
            ) from error
        return ScreeningEstimate(
            requested_mode=mode,
            source_mode=source_mode,
            duration_minutes=cell.duration_minutes,
            distance_m=cell.distance_m,
        )


def _read_rows(path: Path) -> list[dict[str, str]]:
    with path.open('r', encoding='utf-8-sig', newline='') as file:
        return list(csv.DictReader(file, delimiter=';'))


def load_screening_matrices(
    screening_root: Path,
    dataset: PlanningDataset,
) -> ScreeningMatrices:
    """Load and verify the complete screening snapshot for every zone and base mode."""
    root = screening_root.resolve()
    cells: dict[tuple[str, TransportMode, str, str], ScreeningCell] = {}
    snapshot = hashlib.sha256()
    zone_ids = sorted({job.zone_id for job in dataset.jobs.values()})
    optional_transit_complete = all(
        (root / f'{zone_id.lower()}-{OPTIONAL_SCREENING_MODE.value.lower()}.csv').is_file()
        and (root / f'{zone_id.lower()}-{OPTIONAL_SCREENING_MODE.value.lower()}.manifest.json').is_file()
        for zone_id in zone_ids
    )
    modes = SCREENING_MODES + ((OPTIONAL_SCREENING_MODE,) if optional_transit_complete else ())
    for zone_id in zone_ids:
        location_ids = {
            job.location_id for job in dataset.jobs.values() if job.zone_id == zone_id
        }
        location_ids.update(
            office.location_id for office in dataset.offices.values() if office.zone_id == zone_id
        )
        expected_pairs = {
            (origin_id, destination_id)
            for origin_id in location_ids
            for destination_id in location_ids
        }
        for mode in modes:
            stem = f'{zone_id.lower()}-{mode.value.lower()}'
            csv_path = root / f'{stem}.csv'
            manifest_path = root / f'{stem}.manifest.json'
            if not csv_path.is_file() or not manifest_path.is_file():
                raise InvalidPlanningData(f'Missing screening matrix or manifest: {stem}')
            try:
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise InvalidPlanningData(f'Invalid screening manifest: {manifest_path}') from error
            actual_file_hash = hashlib.sha256(csv_path.read_bytes()).hexdigest()
            checks = {
                'dataset_version': dataset.dataset_version,
                'purpose': SCREENING_PURPOSE,
                'zone_id': zone_id,
                'mode': mode.value,
                'matrix_file': csv_path.name,
                'matrix_file_sha256': actual_file_hash,
            }
            for field, expected in checks.items():
                if manifest.get(field) != expected:
                    raise InvalidPlanningData(
                        f'{manifest_path}: {field}={manifest.get(field)!r}, expected {expected!r}'
                    )
            rows = _read_rows(csv_path)
            manifest_locations = manifest.get('locations')
            manifest_cells = manifest.get('cells')
            if (
                not isinstance(manifest_locations, int)
                or not isinstance(manifest_cells, int)
                or manifest_cells != manifest_locations * manifest_locations
                or len(rows) != manifest_cells
            ):
                raise InvalidPlanningData(f'{csv_path}: incomplete row count')
            seen_pairs: set[tuple[str, str]] = set()
            content_payload: list[tuple[str, str, str, int, int, str]] = []
            for row_number, row in enumerate(rows, start=2):
                source = f'{csv_path}:{row_number}'
                try:
                    row_mode = TransportMode(row['mode'])
                    status = RouteStatus(row['status'])
                    departure_at = datetime.fromisoformat(row['departure_at'])
                    duration_seconds = int(row['duration_seconds'])
                    duration_minutes = int(row['duration_minutes'])
                    distance_m = int(row['distance_m'])
                except (KeyError, ValueError) as error:
                    raise InvalidPlanningData(f'{source}: malformed screening cell') from error
                if row_mode != mode or status != RouteStatus.OK:
                    raise InvalidPlanningData(f'{source}: mode/status mismatch')
                if departure_at.tzinfo is None or departure_at.utcoffset() is None:
                    raise InvalidPlanningData(f'{source}: departure_at must have a timezone')
                if duration_seconds < 0 or duration_minutes != math.ceil(duration_seconds / 60):
                    raise InvalidPlanningData(f'{source}: invalid duration rounding')
                if distance_m < 0:
                    raise InvalidPlanningData(f'{source}: negative distance')
                pair = (row['origin_id'], row['destination_id'])
                if pair in seen_pairs:
                    raise InvalidPlanningData(f'{source}: duplicate OD pair')
                seen_pairs.add(pair)
                key = (zone_id, mode, *pair)
                cells[key] = ScreeningCell(
                    origin_id=pair[0],
                    destination_id=pair[1],
                    source_mode=mode,
                    duration_minutes=duration_minutes,
                    distance_m=distance_m,
                )
                content_payload.append(
                    (
                        pair[0],
                        pair[1],
                        status.value,
                        duration_seconds,
                        distance_m,
                        row['response_sha256'],
                    )
                )
            actual_location_ids = {
                location_id for pair in seen_pairs for location_id in pair
            }
            actual_pairs = {
                (origin_id, destination_id)
                for origin_id in actual_location_ids
                for destination_id in actual_location_ids
            }
            if (
                len(actual_location_ids) != manifest_locations
                or seen_pairs != actual_pairs
                or not expected_pairs.issubset(seen_pairs)
                or not actual_location_ids.issubset(dataset.locations)
            ):
                missing = sorted(expected_pairs - seen_pairs)[:3]
                extra = sorted(actual_location_ids - set(dataset.locations))[:3]
                raise InvalidPlanningData(
                    f'{csv_path}: OD domain mismatch; missing={missing}, unknown_locations={extra}'
                )
            content_digest = payload_sha256(content_payload)
            if content_digest != manifest.get('matrix_content_sha256'):
                raise InvalidPlanningData(f'{csv_path}: content checksum mismatch')
            snapshot.update(
                f'{manifest_path.name}|{actual_file_hash}|{content_digest}\n'.encode('utf-8')
            )
    return ScreeningMatrices(
        snapshot_sha256=snapshot.hexdigest(),
        cells=MappingProxyType(cells),
    )
