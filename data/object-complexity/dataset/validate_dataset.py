from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable


CSV_SEPARATOR = ';'
EXPECTED_SOURCE_COUNTS = {'EAST': 66, 'SOUTHEAST': 83, 'SOUTHCENTER': 56}
ACCEPTED_GEOCODE_STATUSES = {'VERIFIED_BUILDING', 'VERIFIED_SITE'}

INTEGER_FIELDS = {
    'service_duration_min', 'apply_order', 'quantity', 'quantity_available',
    'max_jobs', 'max_route_minutes', 'road_reference_min', 'technical_minutes',
    'document_minutes',
}
FLOAT_FIELDS = {'latitude', 'longitude'}
BOOLEAN_FIELDS = {'is_event_job', 'is_available', 'reusable', 'shared_stock', 'replenishment_during_day'}


class Validation:
    def __init__(self) -> None:
        self.results: list[dict[str, str]] = []

    def check(self, name: str, condition: bool, details: str) -> None:
        self.results.append(
            {'check': name, 'status': 'PASS' if condition else 'FAIL', 'details': details}
        )

    def run(self, name: str, function: Callable[[], tuple[bool, str]]) -> None:
        try:
            condition, details = function()
        except Exception as error:
            condition = False
            details = f'{type(error).__name__}: {error}'
        self.check(name, condition, details)

    @property
    def failures(self) -> list[dict[str, str]]:
        return [result for result in self.results if result['status'] == 'FAIL']


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open('r', encoding='utf-8-sig', newline='') as file:
        return list(csv.DictReader(file, delimiter=CSV_SEPARATOR))


def coerce_value(key: str, value: str) -> Any:
    if value == '':
        return None
    if key in INTEGER_FIELDS:
        return int(value)
    if key in FLOAT_FIELDS:
        return float(value)
    if key in BOOLEAN_FIELDS:
        return value.lower() == 'true'
    return value


def typed_records(path: Path) -> list[dict[str, Any]]:
    return [
        {key: coerce_value(key, value) for key, value in row.items()}
        for row in read_csv(path)
    ]


def minutes_between(start: str, end: str) -> int:
    start_dt = datetime.strptime(start, '%H:%M')
    end_dt = datetime.strptime(end, '%H:%M')
    return int((end_dt - start_dt).total_seconds() // 60)


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


def validate_checksums(root: Path) -> tuple[bool, str]:
    checksum_file = root / 'CHECKSUMS.sha256'
    if not checksum_file.exists():
        return False, 'CHECKSUMS.sha256 отсутствует'
    mismatches: list[str] = []
    listed: set[str] = set()
    for line in checksum_file.read_text(encoding='utf-8').splitlines():
        expected, relative = line.split('  ', 1)
        listed.add(relative)
        path = root / Path(relative)
        if not path.is_file():
            mismatches.append(f'missing:{relative}')
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            mismatches.append(f'hash:{relative}')
    expected_files = {
        path.relative_to(root).as_posix()
        for path in root.rglob('*')
        if path.is_file() and path.name != 'CHECKSUMS.sha256'
    }
    unlisted = sorted(expected_files - listed)
    mismatches.extend(f'unlisted:{relative}' for relative in unlisted)
    return not mismatches, 'Расхождения: ' + (', '.join(mismatches) if mismatches else '0')


def write_reports(root: Path, validation: Validation) -> None:
    audit_path = root / 'audit.csv'
    with audit_path.open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.DictWriter(
            file,
            fieldnames=['check', 'status', 'details'],
            delimiter=CSV_SEPARATOR,
            lineterminator='\n',
        )
        writer.writeheader()
        writer.writerows(validation.results)
    manifest_path = root / 'manifest.json'
    dataset_version = None
    if manifest_path.is_file():
        dataset_version = json.loads(manifest_path.read_text(encoding='utf-8')).get('dataset_version')
    report = {
        'dataset_version': dataset_version,
        'validated_at': '2026-09-15',
        'checks_total': len(validation.results),
        'checks_passed': len(validation.results) - len(validation.failures),
        'checks_failed': len(validation.failures),
        'status': 'PASS' if not validation.failures else 'FAIL',
        'results': validation.results,
    }
    (root / 'validation_report.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('dataset_root', type=Path)
    parser.add_argument('--write-reports', action='store_true')
    args = parser.parse_args()
    root = args.dataset_root.resolve()
    validation = Validation()

    required_files = [
        'manifest.json', 'README.md', 'ALGORITHM_SPEC.md', 'common/constraint_policies.json',
        'common/planning_context.json', 'common/locations.csv',
        'common/geocoding_audit.csv', 'common/engineers.csv',
        'common/engineer_skills.csv', 'common/engineer_equipment.csv',
        'common/offices.csv', 'common/equipment.csv', 'common/skill_mapping.csv',
        'common/work_rules.csv', 'common/work_equipment_matrix.csv',
        'common/traffic_profiles.csv', 'core/jobs.csv', 'core/events.csv',
        'core/shared_inventory.csv', 'core/dataset.json', 'stress/jobs.csv',
        'stress/events.csv', 'stress/shared_inventory.csv', 'stress/commitments.csv',
        'stress/dataset.json', 'validate_dataset.py', 'CHECKSUMS.sha256',
    ]
    missing = [relative for relative in required_files if not (root / relative).is_file()]
    validation.check('Обязательные файлы', not missing, f'Отсутствуют: {missing or "нет"}')
    if missing:
        if args.write_reports:
            write_reports(root, validation)
        print(json.dumps(validation.results, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    policies = json.loads((root / 'common' / 'constraint_policies.json').read_text(encoding='utf-8'))
    planning = json.loads((root / 'common' / 'planning_context.json').read_text(encoding='utf-8'))
    locations = read_csv(root / 'common' / 'locations.csv')
    offices = read_csv(root / 'common' / 'offices.csv')
    engineers = read_csv(root / 'common' / 'engineers.csv')
    engineer_skills = read_csv(root / 'common' / 'engineer_skills.csv')
    engineer_equipment = read_csv(root / 'common' / 'engineer_equipment.csv')
    equipment = read_csv(root / 'common' / 'equipment.csv')
    skill_mapping = read_csv(root / 'common' / 'skill_mapping.csv')
    work_rules = read_csv(root / 'common' / 'work_rules.csv')
    work_equipment = read_csv(root / 'common' / 'work_equipment_matrix.csv')
    traffic = read_csv(root / 'common' / 'traffic_profiles.csv')
    core_jobs = read_csv(root / 'core' / 'jobs.csv')
    stress_jobs = read_csv(root / 'stress' / 'jobs.csv')
    core_inventory = read_csv(root / 'core' / 'shared_inventory.csv')
    stress_inventory = read_csv(root / 'stress' / 'shared_inventory.csv')
    core_events = read_csv(root / 'core' / 'events.csv')
    stress_events = read_csv(root / 'stress' / 'events.csv')
    commitments = read_csv(root / 'stress' / 'commitments.csv')

    validation.check(
        'Версия набора',
        manifest.get('dataset_version') == manifest.get('schema_version') == '2.1.0',
        f'dataset={manifest.get("dataset_version")}; schema={manifest.get("schema_version")}',
    )
    validation.check(
        'Начальный момент планирования',
        planning.get('initial_planning_at') == manifest.get('initial_planning_at') == '2026-08-17T07:00:00+03:00',
        str(planning.get('initial_planning_at')),
    )
    hard = policies.get('hard_constraints', {})
    validation.check(
        'Семантика окна и зоны',
        hard.get('time_window_semantics') == 'SERVICE_START_WITHIN_WINDOW'
        and hard.get('time_window_interval') == 'CLOSED'
        and hard.get('service_completion_after_window_end') == 'ALLOWED_IF_WITHIN_SHIFT'
        and hard.get('zone_policy') == 'HARD',
        'SERVICE_START_WITHIN_WINDOW; interval=CLOSED; completion=ALLOWED_IF_WITHIN_SHIFT; zone=HARD',
    )

    objective = policies.get('objective_contract', {})
    initial_metrics = [row.get('metric') for row in objective.get('initial_planning', [])]
    replanning_metrics = [row.get('metric') for row in objective.get('replanning', [])]
    objective_metrics = initial_metrics + replanning_metrics
    forbidden_soft = {'hard_commitment_violations', 'total_lateness_minutes'}
    expected_initial = [
        'unserved_urgent_jobs', 'unserved_normal_jobs', 'used_engineers',
        'total_distance_m', 'total_travel_minutes', 'total_waiting_minutes',
        'workload_imbalance_minutes', 'deterministic_tie_break',
    ]
    expected_replanning = [
        'unserved_urgent_jobs', 'unserved_normal_jobs', 'changed_not_started_assignments',
        'preserved_job_start_shift_minutes', 'used_engineers', 'total_distance_m',
        'total_travel_minutes', 'workload_imbalance_minutes', 'deterministic_tie_break',
    ]
    validation.check(
        'Лексикографическая цель без смягчения жёстких ограничений',
        objective.get('method') == 'LEXICOGRAPHIC_SEQUENTIAL_FIXING'
        and initial_metrics == expected_initial
        and replanning_metrics == expected_replanning
        and not forbidden_soft.intersection(objective_metrics)
        and set(objective.get('forbidden_soft_metrics', [])) == forbidden_soft,
        f'initial={initial_metrics}; replanning={replanning_metrics}',
    )
    required_report_metrics = set(policies.get('required_report_metrics', []))
    validation.check(
        'Обязательные метрики персонала и пробега',
        {'used_engineers', 'distance_m_by_engineer', 'total_distance_m'}.issubset(required_report_metrics),
        str(sorted(required_report_metrics)),
    )

    inventory_policy = policies.get('inventory_semantics', {})
    validation.check(
        'Однозначное резервирование расходников',
        inventory_policy.get('shared_consumables_reservation')
        == 'RESERVE_FOR_ASSIGNED_JOBS_AT_PLAN_PUBLICATION'
        and inventory_policy.get('shared_consumables_decrement')
        == 'ON_JOB_COMPLETION_FROM_RESERVED_QUANTITY'
        and inventory_policy.get('in_progress_reservations_on_replan') == 'KEEP_RESERVED'
        and inventory_policy.get('not_started_reservations_on_replan') == 'RELEASE_AND_REALLOCATE',
        json.dumps(inventory_policy, ensure_ascii=False, sort_keys=True),
    )

    replanning_policy = policies.get('replanning_semantics', {})
    validation.check(
        'Начало активности и состояния перепланирования',
        replanning_policy.get('activity_start') == 'DEPARTURE_TO_JOB'
        and replanning_policy.get('in_transit_to_job') == 'FROZEN'
        and replanning_policy.get('in_service_jobs') == 'FROZEN'
        and replanning_policy.get('not_started_jobs') == 'REOPTIMIZABLE',
        json.dumps(replanning_policy, ensure_ascii=False, sort_keys=True),
    )

    route_policy = policies.get('route_semantics', {})
    validation.check(
        'UNKNOWN и UNREACHABLE разделены',
        route_policy.get('unknown_route') == 'BLOCK_RUN_WITH_ROUTING_INCOMPLETE'
        and route_policy.get('unreachable_route') == 'FORBID_ARC',
        f'UNKNOWN={route_policy.get("unknown_route")}; UNREACHABLE={route_policy.get("unreachable_route")}',
    )

    csv_files = sorted(root.rglob('*.csv'))
    no_bom = [path.relative_to(root).as_posix() for path in csv_files if not path.read_bytes().startswith(b'\xef\xbb\xbf')]
    validation.check('CSV UTF-8 BOM', not no_bom, f'Без BOM: {no_bom or "нет"}')

    for name, jobs, expected in (
        ('CORE', core_jobs, 206),
        ('STRESS', stress_jobs, 207),
    ):
        ids = [job['job_id'] for job in jobs]
        validation.check(f'{name}: число заявок', len(jobs) == expected, f'{len(jobs)} / {expected}')
        validation.check(f'{name}: уникальность job_id', len(ids) == len(set(ids)), f'{len(ids)} записей')

    source_core = [job for job in core_jobs if job['is_event_job'].lower() == 'false']
    counts = Counter(job['zone_id'] for job in source_core)
    validation.check('Исходные заявки по зонам', dict(counts) == EXPECTED_SOURCE_COUNTS, str(dict(counts)))
    core_source_ids = {job['source_job_id'] for job in source_core}
    stress_source_ids = {job['source_job_id'] for job in stress_jobs if job['is_event_job'].lower() == 'false'}
    validation.check('Одинаковые исходные заявки CORE/STRESS', core_source_ids == stress_source_ids, f'{len(core_source_ids)} ID')

    location_ids = [location['location_id'] for location in locations]
    addresses = [location['address'] for location in locations]
    validation.check('Уникальность локаций', len(location_ids) == len(set(location_ids)) == len(set(addresses)), f'{len(locations)} локаций')
    invalid_locations: list[str] = []
    for location in locations:
        try:
            lat = float(location['latitude'])
            lon = float(location['longitude'])
        except ValueError:
            invalid_locations.append(location['location_id'] + ':not_numeric')
            continue
        if not (53.8 <= lat <= 56.7 and 35.0 <= lon <= 40.5) or (lat == 0 and lon == 0):
            invalid_locations.append(location['location_id'] + ':out_of_region')
        if location['geocode_status'] not in ACCEPTED_GEOCODE_STATUSES:
            invalid_locations.append(location['location_id'] + ':status')
        required_provenance = ('geocode_provider', 'geocode_object_id', 'provider_source_url', 'coordinate_accuracy')
        if any(not location[field] for field in required_provenance):
            invalid_locations.append(location['location_id'] + ':provenance')
    validation.check('Координаты и происхождение', not invalid_locations, f'Ошибки: {invalid_locations or "0"}')
    site_locations = [location for location in locations if location['geocode_status'] == 'VERIFIED_SITE']
    validation.check('Явная аномалия Дубининской', len(site_locations) == 1 and '59 к 2' in site_locations[0]['address'] and bool(site_locations[0]['audit_note']), str([(item['location_id'], item['address']) for item in site_locations]))

    by_location = {location['location_id']: location for location in locations}
    coordinate_mismatches: list[str] = []
    for entity in core_jobs + stress_jobs + offices:
        location = by_location.get(entity['location_id'])
        if location is None:
            coordinate_mismatches.append(entity.get('job_id') or entity.get('office_id') or '?')
            continue
        for field in ('latitude', 'longitude', 'geocode_status', 'coordinate_accuracy', 'geocode_provider', 'geocode_object_id'):
            if str(entity[field]) != str(location[field]):
                coordinate_mismatches.append((entity.get('job_id') or entity.get('office_id') or '?') + ':' + field)
    validation.check('Связь заявок/офисов с locations', not coordinate_mismatches, f'Расхождения: {coordinate_mismatches or "0"}')
    validation.check('Аудит геокодирования полон', typed_records(root / 'common' / 'geocoding_audit.csv') == typed_records(root / 'common' / 'locations.csv'), f'{len(locations)} записей')

    corrected_offices = {office['office_id']: office['address'] for office in offices}
    validation.check(
        'Адреса синтетических офисов исправлены',
        corrected_offices['OFFICE-EAST'].endswith('д. 83 к 4')
        and corrected_offices['OFFICE-SOUTHEAST'].endswith('д. 1 к 1'),
        str(corrected_offices),
    )

    shift_errors = [
        engineer['engineer_id']
        for engineer in engineers
        if int(engineer['max_route_minutes']) != minutes_between(engineer['shift_start'], engineer['shift_end'])
    ]
    validation.check('max_route_minutes согласован со сменой', not shift_errors, f'Ошибки: {shift_errors or "0"}')

    engineer_ids = {engineer['engineer_id'] for engineer in engineers}
    skill_ids = {mapping['required_skill'] for mapping in skill_mapping}
    equipment_ids = {item['equipment_id'] for item in equipment}
    reference_errors: list[str] = []
    reference_errors += [row['engineer_id'] for row in engineer_skills if row['engineer_id'] not in engineer_ids]
    reference_errors += [row['engineer_id'] for row in engineer_equipment if row['engineer_id'] not in engineer_ids]
    reference_errors += [row['equipment_id'] for row in engineer_equipment if row['equipment_id'] not in equipment_ids]
    reference_errors += [row['equipment_id'] for row in work_equipment if row['equipment_id'] not in equipment_ids]
    validation.check('Ссылочная целостность', not reference_errors, f'Ошибки: {reference_errors or "0"}')

    skills_by_engineer: dict[str, set[str]] = defaultdict(set)
    for row in engineer_skills:
        skills_by_engineer[row['engineer_id']].add(row['skill_id'])
    engineers_by_id = {engineer['engineer_id']: engineer for engineer in engineers}
    candidate_counts: dict[str, int] = {}
    for job in core_jobs:
        count = 0
        for engineer in engineers:
            transport_ok = job['required_transport'] == 'ANY' or job['required_transport'] == engineer['transport_type']
            if engineer['zone_id'] == job['zone_id'] and job['required_skill'] in skills_by_engineer[engineer['engineer_id']] and transport_ok:
                count += 1
        candidate_counts[job['job_id']] = count
    insufficient = [job_id for job_id, count in candidate_counts.items() if count < 2]
    validation.check('Минимум 2 статических кандидата на CORE-заявку', not insufficient, f'Минимум={min(candidate_counts.values())}; ошибки={insufficient}')
    validation.check('Все required_skill определены', all(job['required_skill'] in skill_ids for job in core_jobs + stress_jobs), f'Допустимые: {sorted(skill_ids)}')
    rule_keys = {(rule['bk_type'], rule['hd_type']) for rule in work_rules}
    job_rule_keys = {(job['bk_type'], job['hd_type']) for job in core_jobs + stress_jobs}
    duplicate_rule_keys = len(rule_keys) != len(work_rules)
    duration_errors = [
        job['job_id']
        for job in core_jobs + stress_jobs
        if not any(
            rule['bk_type'] == job['bk_type']
            and rule['hd_type'] == job['hd_type']
            and rule['service_duration_min'] == job['service_duration_min']
            and int(rule['service_duration_min'])
            == int(rule['technical_minutes']) + int(rule['document_minutes'])
            and int(rule['road_reference_min']) == 20
            for rule in work_rules
        )
    ]
    validation.check(
        'Все виды работ имеют норматив без дороги',
        not duplicate_rule_keys and job_rule_keys <= rule_keys and not duration_errors,
        f'{len(work_rules)} правил; ошибки={duration_errors or "0"}',
    )

    time_errors: list[str] = []
    initial_time = parse_timestamp(planning['initial_planning_at'])
    for job in core_jobs + stress_jobs:
        start = parse_timestamp(job['window_start'])
        end = parse_timestamp(job['window_end'])
        created = parse_timestamp(job['created_at'])
        if not start < end or created > end or int(job['service_duration_min']) <= 0:
            time_errors.append(job['job_id'])
        if job['is_event_job'].lower() == 'false' and created != initial_time:
            time_errors.append(job['job_id'] + ':created_at')
    validation.check('Временная целостность заявок', not time_errors, f'Ошибки: {time_errors or "0"}')

    event_addresses = [job['address'] for job in stress_jobs if job['is_event_job'].lower() == 'true']
    source_addresses = {job['address'] for job in stress_jobs if job['is_event_job'].lower() == 'false'}
    validation.check('Адреса срочных заявок новые', len(event_addresses) == len(set(event_addresses)) and not (set(event_addresses) & source_addresses), str(event_addresses))

    event_order = [(event['event_time'], int(event['apply_order'])) for event in stress_events]
    validation.check('Порядок stress-событий', event_order == sorted(event_order), str(event_order))
    all_stress_jobs = {job['job_id'] for job in stress_jobs}
    event_reference_errors: list[str] = []
    for event in core_events + stress_events:
        payload = json.loads(event['payload_json'])
        if event['event_type'] in {'NEW_URGENT_JOB', 'CANCEL_JOB'} and payload['job_id'] not in all_stress_jobs:
            event_reference_errors.append(event['event_id'])
        if event['event_type'] == 'ENGINEER_UNAVAILABLE' and payload['engineer_id'] not in engineer_ids:
            event_reference_errors.append(event['event_id'])
    validation.check('Ссылки событий', not event_reference_errors, f'Ошибки: {event_reference_errors or "0"}')

    commitment_ok = False
    if len(commitments) == 1:
        commitment = commitments[0]
        job = next((item for item in stress_jobs if item['job_id'] == commitment['job_id']), None)
        engineer = engineers_by_id.get(commitment['engineer_id'])
        event = next((item for item in stress_events if item['event_id'] == commitment['release_event_id']), None)
        if job and engineer and event:
            commitment_ok = (
                job['zone_id'] == engineer['zone_id']
                and job['required_skill'] in skills_by_engineer[engineer['engineer_id']]
                and (job['required_transport'] == 'ANY' or job['required_transport'] == engineer['transport_type'])
                and parse_timestamp(job['window_start']) > parse_timestamp(event['event_time'])
                and event['target_id'] == engineer['engineer_id']
            )
    validation.check('Контрольное назначение делает недоступность значимой', commitment_ok, str(commitments))

    shared_ids = {item['equipment_id'] for item in equipment if item['shared_stock'].lower() == 'true'}
    def inventory_deficits(jobs: list[dict[str, str]], inventory: list[dict[str, str]]) -> dict[tuple[str, str], int]:
        demand: Counter[tuple[str, str]] = Counter()
        for job in jobs:
            for equipment_id in filter(None, job['required_equipment'].split('|')):
                if equipment_id in shared_ids:
                    demand[(job['zone_id'], equipment_id)] += 1
        available = {(row['zone_id'], row['equipment_id']): int(row['quantity_available']) for row in inventory}
        return {key: quantity - available.get(key, 0) for key, quantity in demand.items() if quantity > available.get(key, 0)}
    core_deficits = inventory_deficits(core_jobs, core_inventory)
    stress_deficits = inventory_deficits(stress_jobs, stress_inventory)
    validation.check('CORE: инвентарь покрывает спрос', not core_deficits, str(core_deficits))
    validation.check('STRESS: единственный дефицит ONT=1', stress_deficits == {('SOUTHEAST', 'ONT_GIGABIT'): 1}, str(stress_deficits))

    transports = {engineer['transport_type'] for engineer in engineers}
    validation.check('Все 4 типа транспорта', transports == {'CAR', 'PUBLIC_TRANSIT', 'BICYCLE', 'WALKING'}, str(sorted(transports)))
    expected_traffic_fields = {
        'profile_id', 'transport_type', 'day_type', 'router_capability',
        'time_dependency', 'required_outputs', 'unknown_behavior', 'unreachable_behavior',
    }
    actual_traffic_fields = set(traffic[0]) if traffic else set()
    legacy_traffic_fields = {'multiplier', 'fixed_minutes', 'base_speed_kmh', 'base_source'}
    validation.check(
        'Нет синтетических коэффициентов трафика',
        actual_traffic_fields == expected_traffic_fields
        and not actual_traffic_fields.intersection(legacy_traffic_fields),
        f'Поля: {sorted(actual_traffic_fields)}',
    )
    required_route_outputs = {'duration_min', 'distance_m', 'geometry', 'itinerary', 'provenance'}
    routing_profile_errors = [
        row.get('profile_id', '<missing>')
        for row in traffic
        if not row.get('router_capability')
        or set(row.get('required_outputs', '').split('|')) != required_route_outputs
        or row.get('unknown_behavior') != 'BLOCK_RUN'
        or row.get('unreachable_behavior') != 'FORBID_ARC'
    ]
    validation.check(
        'Маршрутные профили полны и проверяемы',
        len(traffic) == 4
        and {row.get('transport_type') for row in traffic} == transports
        and not routing_profile_errors,
        f'Профили={len(traffic)}; ошибки={routing_profile_errors or "0"}',
    )

    common_csv_keys = {
        'engineers': 'engineers.csv', 'engineer_skills': 'engineer_skills.csv',
        'engineer_equipment': 'engineer_equipment.csv', 'offices': 'offices.csv',
        'equipment': 'equipment.csv', 'skill_mapping': 'skill_mapping.csv',
        'work_rules': 'work_rules.csv', 'work_equipment_matrix': 'work_equipment_matrix.csv',
        'traffic_profiles': 'traffic_profiles.csv', 'locations': 'locations.csv',
    }
    parity_errors: list[str] = []
    for scenario in ('core', 'stress'):
        dataset = json.loads((root / scenario / 'dataset.json').read_text(encoding='utf-8'))
        scenario_keys = {
            'jobs': 'jobs.csv', 'shared_inventory': 'shared_inventory.csv', 'events': 'events.csv'
        }
        for key, filename in scenario_keys.items():
            if dataset[key] != typed_records(root / scenario / filename):
                parity_errors.append(f'{scenario}:{key}')
        expected_commitments = typed_records(root / scenario / 'commitments.csv') if (root / scenario / 'commitments.csv').exists() else []
        if dataset['commitments'] != expected_commitments:
            parity_errors.append(f'{scenario}:commitments')
        for key, filename in common_csv_keys.items():
            if dataset[key] != typed_records(root / 'common' / filename):
                parity_errors.append(f'{scenario}:{key}')
        if dataset['planning_context'] != planning or dataset['constraint_policies'] != policies:
            parity_errors.append(f'{scenario}:policies')
    validation.check('Точное совпадение CSV/JSON', not parity_errors, f'Расхождения: {parity_errors or "0"}')

    validation.run('Целостность SHA-256', lambda: validate_checksums(root))

    if args.write_reports:
        write_reports(root, validation)
    for result in validation.results:
        print(f'{result["status"]}: {result["check"]} — {result["details"]}')
    print(f'RESULT: {"PASS" if not validation.failures else "FAIL"}; checks={len(validation.results)}; failures={len(validation.failures)}')
    raise SystemExit(1 if validation.failures else 0)


if __name__ == '__main__':
    main()
