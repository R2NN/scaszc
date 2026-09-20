from __future__ import annotations

import csv
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime, time
from pathlib import Path
from types import MappingProxyType
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from beeline_routing.errors import InvalidRoutingInput
from beeline_routing.models import Coordinate, TransportMode

from .domain import (
    Commitment,
    CommitmentType,
    Engineer,
    Equipment,
    EquipmentNeed,
    Event,
    EventType,
    Job,
    JobStatus,
    Office,
    PlanningDataset,
    Priority,
    RequiredTransport,
    SharedInventory,
)
from .errors import InvalidPlanningData


SUPPORTED_DATASET_VERSION = '2.1.0'
_CONDITION_PATTERN = re.compile(r'^gigabit_required == (.+)$')


def _read_csv(path: Path, required: Iterable[str]) -> list[dict[str, str]]:
    if not path.is_file():
        raise InvalidPlanningData(f'Missing required file: {path}')
    with path.open('r', encoding='utf-8-sig', newline='') as file:
        reader = csv.DictReader(file, delimiter=';')
        fields = tuple(reader.fieldnames or ())
        missing = sorted(set(required) - set(fields))
        if missing:
            raise InvalidPlanningData(f'{path}: missing columns {missing}')
        rows = list(reader)
    for number, row in enumerate(rows, start=2):
        if None in row:
            raise InvalidPlanningData(f'{path}:{number}: extra unnamed CSV values')
    return rows


def _required(row: dict[str, str], field: str, source: str) -> str:
    value = row[field].strip()
    if not value:
        raise InvalidPlanningData(f'{source}: {field} must not be empty')
    return value


def _parse_bool(value: str, source: str) -> bool:
    normalized = value.strip().lower()
    if normalized not in {'true', 'false'}:
        raise InvalidPlanningData(f'{source}: expected true/false, got {value!r}')
    return normalized == 'true'


def _parse_positive_int(value: str, source: str, *, allow_zero: bool = False) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise InvalidPlanningData(f'{source}: expected an integer, got {value!r}') from error
    lower = 0 if allow_zero else 1
    if parsed < lower:
        raise InvalidPlanningData(f'{source}: expected integer >= {lower}, got {parsed}')
    return parsed


def _parse_datetime(value: str, source: str, timezone: ZoneInfo) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise InvalidPlanningData(f'{source}: invalid ISO datetime {value!r}') from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise InvalidPlanningData(f'{source}: timezone offset is required')
    localized = parsed.astimezone(timezone)
    if localized.utcoffset() != parsed.utcoffset():
        raise InvalidPlanningData(f'{source}: datetime offset does not match {timezone.key}')
    return localized


def _parse_shift(value: str, planning_date: date, timezone: ZoneInfo, source: str) -> datetime:
    try:
        parsed_time = time.fromisoformat(value)
    except ValueError as error:
        raise InvalidPlanningData(f'{source}: invalid local time {value!r}') from error
    return datetime.combine(planning_date, parsed_time, timezone)


def _unique_by(rows: list[dict[str, str]], field: str, source: str) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for row in rows:
        key = _required(row, field, source)
        if key in result:
            raise InvalidPlanningData(f'{source}: duplicate {field}={key}')
        result[key] = row
    return result


def _verify_checksums(root: Path) -> str:
    checksum_path = root / 'CHECKSUMS.sha256'
    if not checksum_path.is_file():
        raise InvalidPlanningData(f'Missing checksum manifest: {checksum_path}')
    digest = hashlib.sha256()
    seen: set[str] = set()
    for line_number, line in enumerate(checksum_path.read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip():
            continue
        parts = line.split('  ', 1)
        if len(parts) != 2 or len(parts[0]) != 64:
            raise InvalidPlanningData(f'{checksum_path}:{line_number}: invalid checksum line')
        expected, relative = parts
        if relative in seen:
            raise InvalidPlanningData(f'{checksum_path}: duplicate entry {relative}')
        seen.add(relative)
        file_path = root / Path(relative)
        if not file_path.is_file():
            raise InvalidPlanningData(f'Checksum target is missing: {file_path}')
        actual = hashlib.sha256(file_path.read_bytes()).hexdigest()
        if actual != expected:
            raise InvalidPlanningData(f'Checksum mismatch: {relative}')
        digest.update(f'{expected}  {relative}\n'.encode('utf-8'))
    if not seen:
        raise InvalidPlanningData('Checksum manifest is empty')
    return digest.hexdigest()


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise InvalidPlanningData(f'Missing required file: {path}')
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InvalidPlanningData(f'Invalid JSON: {path}') from error
    if not isinstance(value, dict):
        raise InvalidPlanningData(f'{path}: root must be an object')
    return value


def _freeze_json(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze_json(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze_json(item) for item in value)
    return value


def _build_job_needs(
    row: dict[str, str],
    matrix_rows: list[dict[str, str]],
    equipment_catalog: dict[str, Equipment],
    source: str,
) -> tuple[EquipmentNeed, ...]:
    quantities: Counter[str] = Counter()
    hd_type = _required(row, 'hd_type', source)
    gigabit_required = _required(row, 'gigabit_required', source)
    for rule in matrix_rows:
        if rule['hd_type'] not in {hd_type, 'Любая работа'}:
            continue
        condition = _required(rule, 'condition', 'work_equipment_matrix.csv')
        applies = condition == 'ALWAYS'
        if not applies:
            match = _CONDITION_PATTERN.fullmatch(condition)
            if not match:
                raise InvalidPlanningData(
                    f'work_equipment_matrix.csv: unsupported condition {condition!r}'
                )
            applies = gigabit_required == match.group(1)
        if applies:
            equipment_id = _required(rule, 'equipment_id', 'work_equipment_matrix.csv')
            if equipment_id not in equipment_catalog:
                raise InvalidPlanningData(f'{source}: unknown equipment {equipment_id}')
            quantities[equipment_id] += _parse_positive_int(
                rule['quantity'], 'work_equipment_matrix.csv:quantity'
            )

    declared = tuple(code for code in row['required_equipment'].split('|') if code)
    if len(declared) != len(set(declared)):
        raise InvalidPlanningData(f'{source}: duplicate required_equipment code')
    if set(declared) != set(quantities):
        raise InvalidPlanningData(
            f'{source}: required_equipment disagrees with work_equipment_matrix.csv'
        )
    return tuple(
        EquipmentNeed(equipment_id, quantity)
        for equipment_id, quantity in sorted(quantities.items())
    )


def load_planning_dataset(dataset_root: Path, scenario: str) -> PlanningDataset:
    """Load dataset 2.1 strictly and validate every model-relevant relationship."""
    root = dataset_root.resolve()
    scenario_name = scenario.strip().lower()
    if scenario_name not in {'core', 'stress'}:
        raise InvalidPlanningData('scenario must be core or stress')

    dataset_sha256 = _verify_checksums(root)
    manifest = _load_json(root / 'manifest.json')
    version = manifest.get('dataset_version')
    if version != SUPPORTED_DATASET_VERSION or manifest.get('schema_version') != version:
        raise InvalidPlanningData(
            f'Planning requires dataset/schema {SUPPORTED_DATASET_VERSION}, got {version!r}'
        )
    timezone_name = manifest.get('timezone')
    if not isinstance(timezone_name, str):
        raise InvalidPlanningData('manifest.json: timezone must be a string')
    try:
        timezone = ZoneInfo(timezone_name)
    except Exception as error:
        raise InvalidPlanningData(f'Unknown timezone {timezone_name!r}') from error
    try:
        planning_date = date.fromisoformat(str(manifest['planning_date']))
    except (KeyError, ValueError) as error:
        raise InvalidPlanningData('manifest.json: invalid planning_date') from error
    initial_planning_at = _parse_datetime(
        str(manifest.get('initial_planning_at', '')),
        'manifest.json:initial_planning_at',
        timezone,
    )
    if initial_planning_at.date() != planning_date:
        raise InvalidPlanningData('initial_planning_at must belong to planning_date')

    policies = _load_json(root / 'common' / 'constraint_policies.json')
    if policies.get('policy_version') != SUPPORTED_DATASET_VERSION:
        raise InvalidPlanningData('constraint policy version does not match the dataset')
    route_policy = policies.get('route_semantics', {})
    if route_policy.get('unknown_route') != 'BLOCK_RUN_WITH_ROUTING_INCOMPLETE':
        raise InvalidPlanningData('UNKNOWN route policy must block the run')
    if route_policy.get('unreachable_route') != 'FORBID_ARC':
        raise InvalidPlanningData('UNREACHABLE route policy must forbid the arc')

    location_rows = _read_csv(
        root / 'common' / 'locations.csv',
        ('location_id', 'latitude', 'longitude', 'geocode_status'),
    )
    locations: dict[str, Coordinate] = {}
    for row in location_rows:
        location_id = _required(row, 'location_id', 'locations.csv')
        if location_id in locations:
            raise InvalidPlanningData(f'locations.csv: duplicate location_id={location_id}')
        if not row['geocode_status'].startswith('VERIFIED_'):
            raise InvalidPlanningData(f'{location_id}: coordinates are not verified')
        try:
            locations[location_id] = Coordinate(
                location_id=location_id,
                latitude=float(row['latitude']),
                longitude=float(row['longitude']),
            )
        except (ValueError, InvalidRoutingInput) as error:
            raise InvalidPlanningData(f'{location_id}: invalid coordinates') from error

    equipment_rows = _read_csv(
        root / 'common' / 'equipment.csv',
        ('equipment_id', 'category', 'reusable', 'shared_stock'),
    )
    equipment_catalog: dict[str, Equipment] = {}
    for row in equipment_rows:
        equipment_id = _required(row, 'equipment_id', 'equipment.csv')
        if equipment_id in equipment_catalog:
            raise InvalidPlanningData(f'equipment.csv: duplicate {equipment_id}')
        item = Equipment(
            equipment_id=equipment_id,
            category=_required(row, 'category', f'equipment.csv:{equipment_id}'),
            reusable=_parse_bool(row['reusable'], f'equipment.csv:{equipment_id}:reusable'),
            shared_stock=_parse_bool(
                row['shared_stock'], f'equipment.csv:{equipment_id}:shared_stock'
            ),
        )
        if item.reusable == item.shared_stock:
            raise InvalidPlanningData(
                f'{equipment_id}: expected reusable personal item or non-reusable shared stock'
            )
        equipment_catalog[equipment_id] = item

    office_rows = _read_csv(
        root / 'common' / 'offices.csv', ('office_id', 'zone_id', 'location_id')
    )
    offices: dict[str, Office] = {}
    for row in office_rows:
        office_id = _required(row, 'office_id', 'offices.csv')
        if office_id in offices:
            raise InvalidPlanningData(f'offices.csv: duplicate office_id={office_id}')
        location_id = _required(row, 'location_id', f'offices.csv:{office_id}')
        if location_id not in locations:
            raise InvalidPlanningData(f'{office_id}: unknown location_id={location_id}')
        offices[office_id] = Office(
            office_id=office_id,
            zone_id=_required(row, 'zone_id', f'offices.csv:{office_id}'),
            location_id=location_id,
        )

    skill_rows = _read_csv(
        root / 'common' / 'engineer_skills.csv', ('engineer_id', 'skill_id')
    )
    skills: defaultdict[str, set[str]] = defaultdict(set)
    for row in skill_rows:
        engineer_id = _required(row, 'engineer_id', 'engineer_skills.csv')
        skill_id = _required(row, 'skill_id', f'engineer_skills.csv:{engineer_id}')
        if skill_id in skills[engineer_id]:
            raise InvalidPlanningData(f'{engineer_id}: duplicate skill {skill_id}')
        skills[engineer_id].add(skill_id)

    engineer_equipment_rows = _read_csv(
        root / 'common' / 'engineer_equipment.csv',
        ('engineer_id', 'equipment_id', 'quantity'),
    )
    personal_equipment: defaultdict[str, Counter[str]] = defaultdict(Counter)
    for row in engineer_equipment_rows:
        engineer_id = _required(row, 'engineer_id', 'engineer_equipment.csv')
        equipment_id = _required(row, 'equipment_id', f'engineer_equipment.csv:{engineer_id}')
        catalog_item = equipment_catalog.get(equipment_id)
        if catalog_item is None or not catalog_item.reusable or catalog_item.shared_stock:
            raise InvalidPlanningData(f'{engineer_id}: {equipment_id} is not personal reusable equipment')
        if personal_equipment[engineer_id][equipment_id]:
            raise InvalidPlanningData(f'{engineer_id}: duplicate equipment row {equipment_id}')
        personal_equipment[engineer_id][equipment_id] = _parse_positive_int(
            row['quantity'], f'engineer_equipment.csv:{engineer_id}:{equipment_id}'
        )

    engineer_rows = _read_csv(
        root / 'common' / 'engineers.csv',
        (
            'engineer_id', 'zone_id', 'shift_start', 'shift_end', 'start_office_id',
            'transport_type', 'is_available', 'max_jobs', 'max_route_minutes',
        ),
    )
    engineers: dict[str, Engineer] = {}
    for row in engineer_rows:
        engineer_id = _required(row, 'engineer_id', 'engineers.csv')
        if engineer_id in engineers:
            raise InvalidPlanningData(f'engineers.csv: duplicate engineer_id={engineer_id}')
        office_id = _required(row, 'start_office_id', f'engineers.csv:{engineer_id}')
        office = offices.get(office_id)
        zone_id = _required(row, 'zone_id', f'engineers.csv:{engineer_id}')
        if office is None or office.zone_id != zone_id:
            raise InvalidPlanningData(f'{engineer_id}: start office is missing or belongs to another zone')
        shift_start = _parse_shift(
            row['shift_start'], planning_date, timezone, f'engineers.csv:{engineer_id}:shift_start'
        )
        shift_end = _parse_shift(
            row['shift_end'], planning_date, timezone, f'engineers.csv:{engineer_id}:shift_end'
        )
        if shift_end <= shift_start:
            raise InvalidPlanningData(f'{engineer_id}: shift_end must be after shift_start')
        if engineer_id not in skills:
            raise InvalidPlanningData(f'{engineer_id}: no skills')
        try:
            mode = TransportMode(row['transport_type'])
        except ValueError as error:
            raise InvalidPlanningData(f'{engineer_id}: unsupported transport') from error
        engineers[engineer_id] = Engineer(
            engineer_id=engineer_id,
            zone_id=zone_id,
            shift_start=shift_start,
            shift_end=shift_end,
            start_office_id=office_id,
            transport_mode=mode,
            is_available=_parse_bool(row['is_available'], f'engineers.csv:{engineer_id}'),
            max_jobs=_parse_positive_int(row['max_jobs'], f'engineers.csv:{engineer_id}:max_jobs'),
            max_route_minutes=_parse_positive_int(
                row['max_route_minutes'], f'engineers.csv:{engineer_id}:max_route_minutes'
            ),
            skills=frozenset(skills[engineer_id]),
            equipment=tuple(
                EquipmentNeed(item_id, quantity)
                for item_id, quantity in sorted(personal_equipment[engineer_id].items())
            ),
        )
    unknown_skill_engineers = sorted(set(skills) - set(engineers))
    unknown_equipment_engineers = sorted(set(personal_equipment) - set(engineers))
    if unknown_skill_engineers or unknown_equipment_engineers:
        raise InvalidPlanningData('Skill/equipment rows reference unknown engineers')

    skill_mapping_rows = _read_csv(
        root / 'common' / 'skill_mapping.csv', ('bk_type', 'required_skill')
    )
    skill_mapping = {
        row['bk_type']: row['required_skill'] for row in skill_mapping_rows
    }
    if len(skill_mapping) != len(skill_mapping_rows):
        raise InvalidPlanningData('skill_mapping.csv: duplicate bk_type')
    rule_rows = _read_csv(
        root / 'common' / 'work_rules.csv',
        ('bk_type', 'hd_type', 'service_duration_min'),
    )
    work_rules: dict[tuple[str, str], dict[str, str]] = {}
    for rule in rule_rows:
        key = (
            _required(rule, 'bk_type', 'work_rules.csv'),
            _required(rule, 'hd_type', 'work_rules.csv'),
        )
        if key in work_rules:
            raise InvalidPlanningData(f'work_rules.csv: duplicate bk_type/hd_type={key}')
        work_rules[key] = rule
    matrix_rows = _read_csv(
        root / 'common' / 'work_equipment_matrix.csv',
        ('hd_type', 'equipment_id', 'quantity', 'condition'),
    )

    job_rows = _read_csv(
        root / scenario_name / 'jobs.csv',
        (
            'scenario', 'job_id', 'zone_id', 'location_id', 'bk_type', 'hd_type',
            'window_start', 'window_end', 'created_at', 'service_duration_min', 'priority',
            'required_skill', 'required_transport', 'required_equipment', 'gigabit_required',
            'is_event_job', 'status',
        ),
    )
    jobs: dict[str, Job] = {}
    expected_scenario = scenario_name.upper()
    for row in job_rows:
        job_id = _required(row, 'job_id', f'{scenario_name}/jobs.csv')
        source = f'{scenario_name}/jobs.csv:{job_id}'
        if job_id in jobs:
            raise InvalidPlanningData(f'{source}: duplicate job_id')
        if row['scenario'] != expected_scenario:
            raise InvalidPlanningData(f'{source}: scenario mismatch')
        location_id = _required(row, 'location_id', source)
        if location_id not in locations:
            raise InvalidPlanningData(f'{source}: unknown location_id={location_id}')
        bk_type = _required(row, 'bk_type', source)
        required_skill = _required(row, 'required_skill', source)
        if skill_mapping.get(bk_type) != required_skill:
            raise InvalidPlanningData(f'{source}: required_skill disagrees with skill_mapping.csv')
        hd_type = _required(row, 'hd_type', source)
        rule = work_rules.get((bk_type, hd_type))
        if rule is None:
            raise InvalidPlanningData(
                f'{source}: bk_type/hd_type is absent from work_rules.csv'
            )
        duration = _parse_positive_int(row['service_duration_min'], f'{source}:service_duration_min')
        if duration != _parse_positive_int(rule['service_duration_min'], 'work_rules.csv'):
            raise InvalidPlanningData(f'{source}: service duration disagrees with work_rules.csv')
        window_start = _parse_datetime(row['window_start'], f'{source}:window_start', timezone)
        window_end = _parse_datetime(row['window_end'], f'{source}:window_end', timezone)
        created_at = _parse_datetime(row['created_at'], f'{source}:created_at', timezone)
        if window_end < window_start:
            raise InvalidPlanningData(f'{source}: window_end precedes window_start')
        if any(value.date() != planning_date for value in (window_start, window_end, created_at)):
            raise InvalidPlanningData(f'{source}: timestamps must belong to planning_date')
        try:
            priority = Priority(row['priority'])
            required_transport = RequiredTransport(row['required_transport'])
            status = JobStatus(row['status'])
        except ValueError as error:
            raise InvalidPlanningData(f'{source}: unsupported enum value') from error
        jobs[job_id] = Job(
            job_id=job_id,
            zone_id=_required(row, 'zone_id', source),
            location_id=location_id,
            window_start=window_start,
            window_end=window_end,
            created_at=created_at,
            service_duration_min=duration,
            priority=priority,
            required_skill=required_skill,
            required_transport=required_transport,
            required_equipment=_build_job_needs(
                row, matrix_rows, equipment_catalog, source
            ),
            is_event_job=_parse_bool(row['is_event_job'], f'{source}:is_event_job'),
            status=status,
        )

    inventory_rows = _read_csv(
        root / scenario_name / 'shared_inventory.csv',
        ('scenario', 'zone_id', 'equipment_id', 'quantity_available',
         'reservation_policy', 'replenishment_during_day'),
    )
    inventory: list[SharedInventory] = []
    inventory_keys: set[tuple[str, str]] = set()
    for row in inventory_rows:
        zone_id = _required(row, 'zone_id', f'{scenario_name}/shared_inventory.csv')
        equipment_id = _required(row, 'equipment_id', f'{scenario_name}/shared_inventory.csv')
        key = (zone_id, equipment_id)
        if key in inventory_keys:
            raise InvalidPlanningData(f'Duplicate shared inventory row {key}')
        inventory_keys.add(key)
        catalog_item = equipment_catalog.get(equipment_id)
        if catalog_item is None or catalog_item.reusable or not catalog_item.shared_stock:
            raise InvalidPlanningData(f'{key}: item is not shared consumable/device stock')
        if row['scenario'] != expected_scenario:
            raise InvalidPlanningData(f'{key}: inventory scenario mismatch')
        if row['reservation_policy'] != 'RESERVE_AT_SHIFT_START':
            raise InvalidPlanningData(f'{key}: unsupported reservation policy')
        if _parse_bool(row['replenishment_during_day'], f'{key}:replenishment'):
            raise InvalidPlanningData(f'{key}: replenishment is forbidden by this model')
        inventory.append(
            SharedInventory(
                zone_id=zone_id,
                equipment_id=equipment_id,
                quantity_available=_parse_positive_int(
                    row['quantity_available'], f'{key}:quantity_available', allow_zero=True
                ),
            )
        )
    required_inventory_keys = {
        (job.zone_id, need.equipment_id)
        for job in jobs.values()
        for need in job.required_equipment
        if equipment_catalog[need.equipment_id].shared_stock
    }
    missing_inventory = sorted(required_inventory_keys - inventory_keys)
    if missing_inventory:
        raise InvalidPlanningData(f'Missing shared inventory rows: {missing_inventory}')

    event_rows = _read_csv(
        root / scenario_name / 'events.csv',
        ('apply_order', 'event_id', 'event_time', 'event_type', 'target_id', 'zone_id',
         'unavailable_until', 'payload_json'),
    )
    events: list[Event] = []
    event_ids: set[str] = set()
    for row in event_rows:
        event_id = _required(row, 'event_id', f'{scenario_name}/events.csv')
        source = f'{scenario_name}/events.csv:{event_id}'
        if event_id in event_ids:
            raise InvalidPlanningData(f'{source}: duplicate event_id')
        event_ids.add(event_id)
        try:
            event_type = EventType(row['event_type'])
            payload = json.loads(row['payload_json'])
        except (ValueError, json.JSONDecodeError) as error:
            raise InvalidPlanningData(f'{source}: invalid event type or payload') from error
        if not isinstance(payload, dict):
            raise InvalidPlanningData(f'{source}: payload must be an object')
        unavailable_until = (
            _parse_datetime(row['unavailable_until'], f'{source}:unavailable_until', timezone)
            if row['unavailable_until'].strip()
            else None
        )
        if event_type == EventType.ENGINEER_UNAVAILABLE and unavailable_until is None:
            raise InvalidPlanningData(f'{source}: unavailable_until is required')
        if event_type != EventType.ENGINEER_UNAVAILABLE and unavailable_until is not None:
            raise InvalidPlanningData(f'{source}: unavailable_until is not applicable')
        target_id = _required(row, 'target_id', source)
        if event_type == EventType.ENGINEER_UNAVAILABLE and target_id not in engineers:
            raise InvalidPlanningData(f'{source}: unknown engineer target')
        if event_type != EventType.ENGINEER_UNAVAILABLE and target_id not in jobs:
            raise InvalidPlanningData(f'{source}: unknown job target')
        events.append(
            Event(
                apply_order=_parse_positive_int(row['apply_order'], f'{source}:apply_order'),
                event_id=event_id,
                event_time=_parse_datetime(row['event_time'], f'{source}:event_time', timezone),
                event_type=event_type,
                target_id=target_id,
                zone_id=_required(row, 'zone_id', source),
                unavailable_until=unavailable_until,
                payload=_freeze_json(payload),
            )
        )
    events.sort(key=lambda event: (event.event_time, event.apply_order))
    if len({event.apply_order for event in events}) != len(events):
        raise InvalidPlanningData('events.csv: apply_order values must be globally unique')

    commitments: list[Commitment] = []
    commitment_path = root / scenario_name / 'commitments.csv'
    if commitment_path.is_file():
        commitment_rows = _read_csv(
            commitment_path,
            ('commitment_id', 'job_id', 'engineer_id', 'constraint_type',
             'effective_from', 'release_event_id'),
        )
        seen_commitments: set[str] = set()
        for row in commitment_rows:
            commitment_id = _required(row, 'commitment_id', str(commitment_path))
            source = f'{scenario_name}/commitments.csv:{commitment_id}'
            if commitment_id in seen_commitments:
                raise InvalidPlanningData(f'{source}: duplicate commitment')
            seen_commitments.add(commitment_id)
            job_id = _required(row, 'job_id', source)
            engineer_id = _required(row, 'engineer_id', source)
            release_event_id = _required(row, 'release_event_id', source)
            if job_id not in jobs or engineer_id not in engineers or release_event_id not in event_ids:
                raise InvalidPlanningData(f'{source}: unknown job, engineer, or release event')
            try:
                commitment_type = CommitmentType(row['constraint_type'])
            except ValueError as error:
                raise InvalidPlanningData(f'{source}: unsupported commitment type') from error
            commitments.append(
                Commitment(
                    commitment_id=commitment_id,
                    job_id=job_id,
                    engineer_id=engineer_id,
                    commitment_type=commitment_type,
                    effective_from=_parse_datetime(
                        row['effective_from'], f'{source}:effective_from', timezone
                    ),
                    release_event_id=release_event_id,
                )
            )

    return PlanningDataset(
        root=root,
        dataset_version=version,
        dataset_sha256=dataset_sha256,
        scenario=expected_scenario,
        timezone_name=timezone_name,
        planning_date=planning_date.isoformat(),
        initial_planning_at=initial_planning_at,
        locations=MappingProxyType(locations),
        offices=MappingProxyType(offices),
        equipment_catalog=MappingProxyType(equipment_catalog),
        engineers=MappingProxyType(engineers),
        jobs=MappingProxyType(jobs),
        shared_inventory=tuple(sorted(inventory, key=lambda item: (item.zone_id, item.equipment_id))),
        events=tuple(events),
        commitments=tuple(commitments),
        constraint_policies=_freeze_json(policies),
    )
