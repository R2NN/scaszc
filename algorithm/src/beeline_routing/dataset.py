from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path

from .errors import InvalidRoutingInput
from .models import Coordinate, TransportMode


@dataclass(frozen=True, slots=True)
class DatasetLocations:
    dataset_root: Path
    dataset_version: str
    locations: dict[str, Coordinate]
    zone_location_ids: dict[str, tuple[str, ...]]
    zone_modes: dict[str, tuple[TransportMode, ...]]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open('r', encoding='utf-8-sig', newline='') as file:
        return list(csv.DictReader(file, delimiter=';'))


def load_dataset_locations(dataset_root: Path, scenario: str) -> DatasetLocations:
    root = dataset_root.resolve()
    scenario_name = scenario.lower()
    if scenario_name not in {'core', 'stress'}:
        raise InvalidRoutingInput('scenario must be core or stress')
    manifest_path = root / 'manifest.json'
    if not manifest_path.is_file():
        raise InvalidRoutingInput(f'Missing manifest: {manifest_path}')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('dataset_version') != '2.1.0':
        raise InvalidRoutingInput(
            f'Routing requires dataset 2.1.0, got {manifest.get("dataset_version")}'
        )

    location_rows = read_csv(root / 'common' / 'locations.csv')
    locations: dict[str, Coordinate] = {}
    for row in location_rows:
        location_id = row['location_id']
        if location_id in locations:
            raise InvalidRoutingInput(f'Duplicate location_id: {location_id}')
        locations[location_id] = Coordinate(
            location_id=row['location_id'],
            latitude=float(row['latitude']),
            longitude=float(row['longitude']),
        )
    jobs = read_csv(root / scenario_name / 'jobs.csv')
    offices = read_csv(root / 'common' / 'offices.csv')
    engineers = read_csv(root / 'common' / 'engineers.csv')

    zone_ids = sorted({job['zone_id'] for job in jobs})
    zone_location_ids: dict[str, tuple[str, ...]] = {}
    zone_modes: dict[str, tuple[TransportMode, ...]] = {}
    for zone_id in zone_ids:
        job_ids = {job['location_id'] for job in jobs if job['zone_id'] == zone_id}
        office_ids = {office['location_id'] for office in offices if office['zone_id'] == zone_id}
        all_ids = tuple(sorted(job_ids | office_ids))
        missing = [location_id for location_id in all_ids if location_id not in locations]
        if missing:
            raise InvalidRoutingInput(f'Unknown location IDs in zone {zone_id}: {missing}')
        zone_location_ids[zone_id] = all_ids
        zone_modes[zone_id] = tuple(
            sorted(
                {
                    TransportMode(engineer['transport_type'])
                    for engineer in engineers
                    if engineer['zone_id'] == zone_id and engineer['is_available'].lower() == 'true'
                },
                key=lambda mode: mode.value,
            )
        )
        if not zone_modes[zone_id]:
            raise InvalidRoutingInput(f'No available engineer transport modes in zone {zone_id}')
    return DatasetLocations(
        dataset_root=root,
        dataset_version='2.1.0',
        locations=locations,
        zone_location_ids=zone_location_ids,
        zone_modes=zone_modes,
    )
