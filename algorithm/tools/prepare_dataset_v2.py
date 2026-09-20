from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd


CSV_SEPARATOR = ';'
INITIAL_PLANNING_AT = '2026-08-17T07:00:00+03:00'
VERIFIED_AT = '2026-09-15'

OFFICE_ADDRESS_CORRECTIONS = {
    'OFFICE-EAST': 'Город Москва, ул.Юных Ленинцев, д. 83 к 4',
    'OFFICE-SOUTHEAST': 'Город Москва, ул.Бирюлёвская, д. 1 к 1',
}

EVENT_ADDRESS_CORRECTIONS = {
    'EAST-EVENT-001': 'Город Москва, ул.Зеленодольская, д. 32 к 1',
    'SOUTHEAST-EVENT-002': 'Домодедово, Каширское шоссе, д. 7',
}

ADDITIONAL_OSM_RESULTS: dict[str, dict[str, Any]] = {
    'Город Москва, ул.Зеленодольская, д. 32 к 1': {
        'query': 'Москва, Зенодольская улица, 32к1',
        'status': 'BUILDING',
        'lat': 55.7104451,
        'lon': 37.7691714,
        'display_name': '32 к1, Зеленодольская улица, район Кузьминки, Москва, 109443, Россия',
        'osm_type': 'way',
        'osm_id': 620857822,
        'licence': 'Data © OpenStreetMap contributors, ODbL 1.0',
    },
    'Домодедово, Каширское шоссе, д. 7': {
        'query': 'Домодедово, Каширское шоссе, 7',
        'status': 'BUILDING',
        'lat': 55.44809,
        'lon': 37.7649116,
        'display_name': '7, Каширское шоссе, микрорайон Северный, Домодедово, Московская область, 142000, Россия',
        'osm_type': 'relation',
        'osm_id': 17589379,
        'licence': 'Data © OpenStreetMap contributors, ODbL 1.0',
    },
    'Город Москва, ул.Бирюлёвская, д. 1 к 1': {
        'query': 'Москва, Бирюлёвская улица, 1к1',
        'status': 'BUILDING',
        'lat': 55.6020854,
        'lon': 37.6653422,
        'display_name': '1 к1, Бирюлёвская улица, район Бирюлёво Восточное, Москва, 115404, Россия',
        'osm_type': 'way',
        'osm_id': 28456829,
        'licence': 'Data © OpenStreetMap contributors, ODbL 1.0',
    },
    'Город Москва, ул.Юных Ленинцев, д. 83 к 4': {
        'query': 'Москва, Юных Ленинцев улица, 83к4',
        'status': 'BUILDING',
        'lat': 55.7022013,
        'lon': 37.7739593,
        'display_name': '83 к4, улица Юных Ленинцев, район Кузьминки, Москва, 109443, Россия',
        'osm_type': 'way',
        'osm_id': 85397778,
        'licence': 'Data © OpenStreetMap contributors, ODbL 1.0',
    },
}

EXPECTED_2GIS_OBJECTS = {
    'Город Москва, ул.Академика Миллионщикова, д. 13 к 1': '4504235282606690',
    'Город Москва, ул.Дубининская, д. 59 к 2': '70000001088745753',
    'Город Москва, ул.Красноказарменная, д. 9Б стр. 1': '70030076167731661',
    'Город Москва, ул.Машкова, д. 13 стр. 1': '4504235282728106',
    'Город Москва, ул.Москворечье, д. 4 к 6': '4504235282612790',
    'Домодедово, ул.Гагарина, д. 55/2': '4504235282639271',
    'МО, г. Кашира Кржижановского ул. д. 5/1': '70030076201315613',
    'МО, г. Кашира Кржижановского ул. д. 5/2': '70030076201315501',
    'МО, г. Кашира Кржижановского ул. д. 5/3': '70030076201315500',
    'МО, г. Кашира Кржижановского ул. д. 7к2': '70030076201315499',
    'Москва Булатниковский пр-зд. д. 6к1': '4504235282620774',
}


def read_csv(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, sep=CSV_SEPARATOR, encoding='utf-8-sig', dtype=str).fillna('')


def write_csv(frame: pd.DataFrame, path: Path) -> None:
    frame.to_csv(path, sep=CSV_SEPARATOR, encoding='utf-8-sig', index=False, lineterminator='\n')


def shift_duration_minutes(start: str, end: str) -> int:
    start_dt = datetime.strptime(start, '%H:%M')
    end_dt = datetime.strptime(end, '%H:%M')
    return int((end_dt - start_dt).total_seconds() // 60)


def osm_location(address: str, result: dict[str, Any]) -> dict[str, Any]:
    return {
        'address': address,
        'normalized_address': result['query'],
        'latitude': float(result['lat']),
        'longitude': float(result['lon']),
        'geocode_status': 'VERIFIED_BUILDING',
        'coordinate_accuracy': 'BUILDING_CENTROID',
        'geocode_provider': 'OpenStreetMap/Nominatim',
        'geocode_object_id': f'{result["osm_type"]}/{result["osm_id"]}',
        'geocode_display_name': result.get('display_name') or '',
        'provider_source_url': f'https://www.openstreetmap.org/{result["osm_type"]}/{result["osm_id"]}',
        'provider_license': result.get('licence') or 'OpenStreetMap ODbL 1.0',
        'verified_at': VERIFIED_AT,
        'audit_note': '',
    }


def fallback_location(address: str, result: dict[str, Any]) -> dict[str, Any]:
    candidate = result['candidates'][0]
    if str(candidate['object_id']) != EXPECTED_2GIS_OBJECTS[address]:
        raise ValueError(f'Unexpected 2GIS object for {address}: {candidate}')
    is_site = address == 'Город Москва, ул.Дубининская, д. 59 к 2'
    note = ''
    if is_site:
        note = (
            'Исходное здание демонтировано; адрес относится к участку редевелопмента. '
            'Для маршрутизации используется центроид адресного участка, а не несуществующего здания.'
        )
    return {
        'address': address,
        'normalized_address': result['query'],
        'latitude': float(candidate['latitude']),
        'longitude': float(candidate['longitude']),
        'geocode_status': 'VERIFIED_SITE' if is_site else 'VERIFIED_BUILDING',
        'coordinate_accuracy': 'SITE_CENTROID' if is_site else 'BUILDING_CENTROID',
        'geocode_provider': '2GIS public map',
        'geocode_object_id': str(candidate['object_id']),
        'geocode_display_name': candidate.get('address_name') or candidate.get('full_name') or '',
        'provider_source_url': result['source_url'],
        'provider_license': 'Public map fact; source URL retained for verification',
        'verified_at': VERIFIED_AT,
        'audit_note': note,
    }


def build_locations(
    addresses: set[str],
    osm_cache: dict[str, Any],
    fallback_cache: dict[str, Any],
) -> tuple[pd.DataFrame, dict[str, dict[str, Any]]]:
    resolved: dict[str, dict[str, Any]] = {}
    for address in sorted(addresses):
        if address in ADDITIONAL_OSM_RESULTS:
            resolved[address] = osm_location(address, ADDITIONAL_OSM_RESULTS[address])
        elif address in osm_cache and osm_cache[address].get('status') == 'BUILDING':
            resolved[address] = osm_location(address, osm_cache[address])
        elif address in fallback_cache and address in EXPECTED_2GIS_OBJECTS:
            resolved[address] = fallback_location(address, fallback_cache[address])
        else:
            raise ValueError(f'Address has no verified coordinates: {address}')

    records: list[dict[str, Any]] = []
    by_address: dict[str, dict[str, Any]] = {}
    for index, address in enumerate(sorted(resolved), start=1):
        record = {'location_id': f'LOC-{index:04d}', **resolved[address]}
        records.append(record)
        by_address[address] = record
    return pd.DataFrame(records), by_address


def apply_locations(frame: pd.DataFrame, by_address: dict[str, dict[str, Any]]) -> pd.DataFrame:
    fields = (
        'location_id',
        'latitude',
        'longitude',
        'geocode_status',
        'coordinate_accuracy',
        'geocode_provider',
        'geocode_object_id',
    )
    for field in fields:
        frame[field] = frame['address'].map(lambda value: by_address[value][field])
    return frame


def update_traffic_profiles(path: Path) -> None:
    frame = pd.DataFrame(
        [
            {
                'profile_id': 'CAR-WD',
                'transport_type': 'CAR',
                'day_type': 'WEEKDAY',
                'router_capability': 'TIME_DEPENDENT_ROAD_ROUTER',
                'time_dependency': 'DEPARTURE_TIME_DEPENDENT',
                'required_outputs': 'duration_min|distance_m|geometry|itinerary|provenance',
                'unknown_behavior': 'BLOCK_RUN',
                'unreachable_behavior': 'FORBID_ARC',
            },
            {
                'profile_id': 'TRANSIT-WD',
                'transport_type': 'PUBLIC_TRANSIT',
                'day_type': 'WEEKDAY',
                'router_capability': 'TIMETABLE_AWARE_TRANSIT_ROUTER',
                'time_dependency': 'DEPARTURE_TIME_DEPENDENT',
                'required_outputs': 'duration_min|distance_m|geometry|itinerary|provenance',
                'unknown_behavior': 'BLOCK_RUN',
                'unreachable_behavior': 'FORBID_ARC',
            },
            {
                'profile_id': 'BICYCLE-WD',
                'transport_type': 'BICYCLE',
                'day_type': 'WEEKDAY',
                'router_capability': 'BICYCLE_NETWORK_ROUTER',
                'time_dependency': 'STATIC_ROUTING_GRAPH',
                'required_outputs': 'duration_min|distance_m|geometry|itinerary|provenance',
                'unknown_behavior': 'BLOCK_RUN',
                'unreachable_behavior': 'FORBID_ARC',
            },
            {
                'profile_id': 'WALKING-WD',
                'transport_type': 'WALKING',
                'day_type': 'WEEKDAY',
                'router_capability': 'PEDESTRIAN_NETWORK_ROUTER',
                'time_dependency': 'STATIC_ROUTING_GRAPH',
                'required_outputs': 'duration_min|distance_m|geometry|itinerary|provenance',
                'unknown_behavior': 'BLOCK_RUN',
                'unreachable_behavior': 'FORBID_ARC',
            },
        ]
    )
    write_csv(frame, path)


def create_policies(root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    planning_context = {
        'planning_date': '2026-08-17',
        'initial_planning_at': INITIAL_PLANNING_AT,
        'timezone': 'Europe/Moscow',
        'day_type': 'WEEKDAY',
        'event_application_order': 'event_time ascending, then apply_order ascending',
        'event_time_tie_break': 'apply_order ascending',
        'live_state_derivation': (
            'Перед каждым событием состояния COMPLETED/IN_SERVICE/IN_TRANSIT_TO_JOB/'
            'NOT_STARTED/CANCELED однозначно выводятся из текущего плана и времени события.'
        ),
    }
    policies = {
        'policy_version': '2.1.0',
        'hard_constraints': {
            'assignment': 'Каждая выполненная заявка назначается ровно одному инженеру.',
            'zone_policy': 'HARD',
            'skills': 'required_skill должен входить в engineer_skills.',
            'transport': 'required_transport=CAR разрешает только CAR; ANY разрешает любой тип.',
            'time_window_semantics': 'SERVICE_START_WITHIN_WINDOW',
            'time_window_interval': 'CLOSED',
            'service_completion_after_window_end': 'ALLOWED_IF_WITHIN_SHIFT',
            'shift': 'Выезд, начало и завершение работы находятся внутри смены.',
            'max_jobs': 'Число выполненных заявок не превышает max_jobs.',
            'max_route_minutes': (
                'Путевое время = поездки + ожидание + работы от выезда из офиса до окончания '
                'последней работы; оно не превышает max_route_minutes.'
            ),
            'equipment': 'Личные комплекты должны быть у инженера; зональные расходники резервируются по правилам inventory_semantics.',
            'commitments': 'Записи stress/commitments.csv являются абсолютными жёсткими ограничениями до release_event_id.',
        },
        'route_semantics': {
            'start': 'start_office_id',
            'return_to_office': False,
            'travel_time_rounding': 'CEILING_TO_INTEGER_MINUTE',
            'time_dependent_query_uses': 'DEPARTURE_TIME_FROM_PREVIOUS_NODE',
            'required_outputs': ['duration_min', 'distance_m', 'geometry', 'itinerary', 'provenance'],
            'unknown_route': 'BLOCK_RUN_WITH_ROUTING_INCOMPLETE',
            'unreachable_route': 'FORBID_ARC',
        },
        'inventory_semantics': {
            'toolkits_reusable': True,
            'shared_consumables_reservation': 'RESERVE_FOR_ASSIGNED_JOBS_AT_PLAN_PUBLICATION',
            'shared_consumables_decrement': 'ON_JOB_COMPLETION_FROM_RESERVED_QUANTITY',
            'in_progress_reservations_on_replan': 'KEEP_RESERVED',
            'not_started_reservations_on_replan': 'RELEASE_AND_REALLOCATE',
            'replenishment_during_day': False,
            'event_jobs_use_remaining_stock': True,
            'shortage_behavior': 'JOB_MUST_REMAIN_UNSERVED_WITH_EXPLICIT_REASON',
        },
        'replanning_semantics': {
            'completed_jobs': 'FROZEN',
            'in_service_jobs': 'FROZEN',
            'in_transit_to_job': 'FROZEN',
            'not_started_jobs': 'REOPTIMIZABLE',
            'activity_start': 'DEPARTURE_TO_JOB',
            'cancel_not_started': 'CANCELED_AND_RESERVATION_RELEASED',
            'cancel_started': 'REJECTED_ALREADY_STARTED',
            'engineer_unavailable': 'EFFECTIVE_AFTER_CURRENT_STARTED_ACTIVITY',
            'consumed_inventory': 'NOT_RESTORED',
            'elapsed_travel_and_service': 'ACCOUNTED',
        },
        'objective_contract': {
            'method': 'LEXICOGRAPHIC_SEQUENTIAL_FIXING',
            'initial_planning': [
                {'tier': 1, 'sense': 'MIN', 'metric': 'unserved_urgent_jobs'},
                {'tier': 2, 'sense': 'MIN', 'metric': 'unserved_normal_jobs'},
                {'tier': 3, 'sense': 'MIN', 'metric': 'used_engineers'},
                {'tier': 4, 'sense': 'MIN', 'metric': 'total_distance_m'},
                {'tier': 5, 'sense': 'MIN', 'metric': 'total_travel_minutes'},
                {'tier': 6, 'sense': 'MIN', 'metric': 'total_waiting_minutes'},
                {'tier': 7, 'sense': 'MIN', 'metric': 'workload_imbalance_minutes'},
                {'tier': 8, 'sense': 'MIN', 'metric': 'deterministic_tie_break'},
            ],
            'replanning': [
                {'tier': 1, 'sense': 'MIN', 'metric': 'unserved_urgent_jobs'},
                {'tier': 2, 'sense': 'MIN', 'metric': 'unserved_normal_jobs'},
                {'tier': 3, 'sense': 'MIN', 'metric': 'changed_not_started_assignments'},
                {'tier': 4, 'sense': 'MIN', 'metric': 'preserved_job_start_shift_minutes'},
                {'tier': 5, 'sense': 'MIN', 'metric': 'used_engineers'},
                {'tier': 6, 'sense': 'MIN', 'metric': 'total_distance_m'},
                {'tier': 7, 'sense': 'MIN', 'metric': 'total_travel_minutes'},
                {'tier': 8, 'sense': 'MIN', 'metric': 'workload_imbalance_minutes'},
                {'tier': 9, 'sense': 'MIN', 'metric': 'deterministic_tie_break'},
            ],
            'forbidden_soft_metrics': ['hard_commitment_violations', 'total_lateness_minutes'],
        },
        'required_report_metrics': [
            'used_engineers',
            'distance_m_by_engineer',
            'total_distance_m',
            'travel_minutes_by_engineer',
            'total_travel_minutes',
        ],
        'forbidden_approximations': [
            'coordinates 0,0',
            'Euclidean distance used as travel time',
            'constant speed used instead of a routing graph',
            'silent violation of a hard constraint',
            'implicit default for an unknown required field',
            'synthetic traffic multiplier applied to routed duration',
            'UNKNOWN route treated as UNREACHABLE',
        ],
    }
    (root / 'common' / 'planning_context.json').write_text(
        json.dumps(planning_context, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    (root / 'common' / 'constraint_policies.json').write_text(
        json.dumps(policies, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    return planning_context, policies


INTEGER_FIELDS = {
    'service_duration_min', 'apply_order', 'quantity', 'quantity_available',
    'max_jobs', 'max_route_minutes', 'fixed_minutes',
}
FLOAT_FIELDS = {'latitude', 'longitude'}
BOOLEAN_FIELDS = {'is_event_job', 'is_available', 'reusable', 'shared_stock', 'replenishment_during_day'}


def coerce_csv_value(key: str, value: str) -> Any:
    if value == '':
        return None
    if key in INTEGER_FIELDS:
        return int(value)
    if key in FLOAT_FIELDS:
        return float(value)
    if key in BOOLEAN_FIELDS:
        return value.lower() == 'true'
    return value


def csv_records(path: Path) -> list[dict[str, Any]]:
    with path.open('r', encoding='utf-8-sig', newline='') as file:
        return [
            {key: coerce_csv_value(key, value) for key, value in row.items()}
            for row in csv.DictReader(file, delimiter=CSV_SEPARATOR)
        ]


def rebuild_scenario_json(
    root: Path,
    scenario: str,
    planning_context: dict[str, Any],
    policies: dict[str, Any],
) -> None:
    scenario_dir = root / scenario
    common_dir = root / 'common'
    common_files = (
        'engineers', 'engineer_skills', 'engineer_equipment', 'offices',
        'equipment', 'skill_mapping', 'work_rules', 'work_equipment_matrix',
        'traffic_profiles', 'locations',
    )
    payload: dict[str, Any] = {
        'scenario': scenario.upper(),
        'seed': 20260915,
        'planning_context': planning_context,
        'constraint_policies': policies,
        'jobs': csv_records(scenario_dir / 'jobs.csv'),
        'shared_inventory': csv_records(scenario_dir / 'shared_inventory.csv'),
        'events': csv_records(scenario_dir / 'events.csv'),
        'commitments': csv_records(scenario_dir / 'commitments.csv') if (scenario_dir / 'commitments.csv').exists() else [],
    }
    for name in common_files:
        payload[name] = csv_records(common_dir / f'{name}.csv')
    (scenario_dir / 'dataset.json').write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )


def write_readme(root: Path) -> None:
    text = '''# Проверенный набор данных для планирования маршрутов

Версия 2.1.0. Дата планирования: 2026-08-17, часовой пояс Europe/Moscow. Начальный срез: 07:00.

## Что гарантирует версия 2

- Все заявки и офисы имеют проверенные координаты, источник и точность.
- Нет нулевых координат, скоростных замен маршрутизатора или молчаливых значений по умолчанию.
- Все неоднозначные правила зафиксированы в `common/constraint_policies.json`.
- Временное окно относится к началу обслуживания и включает обе границы.
- Активность заявки начинается в момент выезда инженера к ней.
- Жёсткие обязательства и временные окна никогда не переводятся в штрафы цели.
- CSV и JSON содержат одинаковые сущности; это проверяется автоматически.
- Любое нарушение жёсткого ограничения делает план недопустимым; оптимизатор не имеет права его скрыть.

## Сценарии

- `core`: 205 исходных заявок + 1 новая срочная заявка; запаса расходников достаточно.
- `stress`: 205 исходных + 2 срочных; недоступность инженера, отмена заявки и доказуемый дефицит 1 ONT.
- `stress/commitments.csv` закрепляет позднюю заявку за инженером, который станет недоступен. Это гарантирует, что событие реально проверяет перепланирование.

## Координаты

`common/locations.csv` — единый справочник локаций. Для каждой записи хранятся исходный и нормализованный адрес, WGS84-координаты, тип точности, идентификатор объекта и URL проверки.

Адрес Дубининская, 59 к2 в исходных данных указывает на территорию снесённого здания. Он помечен `VERIFIED_SITE`, а не ложным `VERIFIED_BUILDING`.

## Время в пути

`common/traffic_profiles.csv` задаёт проверяемые требования к маршрутизатору без синтетических коэффициентов. До запуска оптимизатора нужно материализовать полную матрицу по дорожному/пешеходному/велосипедному графу и транзитному расписанию. Для каждой дуги обязательны длительность, расстояние, геометрия, маршрут и происхождение данных. `UNKNOWN` блокирует запуск, `UNREACHABLE` запрещает только подтверждённо недостижимую дугу.

## Проверка

```bash
python validate_dataset.py .
```

Скрипт завершается с кодом 1 при любой ошибке. `validation_report.json` и `audit.csv` — результат прогона перед упаковкой.
'''
    (root / 'README.md').write_text(text, encoding='utf-8')


def write_checksums(root: Path) -> None:
    lines: list[str] = []
    for path in sorted(root.rglob('*')):
        if not path.is_file() or path.name == 'CHECKSUMS.sha256':
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f'{digest}  {path.relative_to(root).as_posix()}')
    (root / 'CHECKSUMS.sha256').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('source_root', type=Path)
    parser.add_argument('destination_root', type=Path)
    parser.add_argument('osm_cache', type=Path)
    parser.add_argument('fallback_cache', type=Path)
    parser.add_argument('validator_script', type=Path)
    parser.add_argument('algorithm_spec', type=Path)
    args = parser.parse_args()

    if args.destination_root.exists():
        raise SystemExit(f'Destination already exists: {args.destination_root}')
    shutil.copytree(args.source_root, args.destination_root)
    root = args.destination_root

    osm_cache = json.loads(args.osm_cache.read_text(encoding='utf-8'))
    fallback_cache = json.loads(args.fallback_cache.read_text(encoding='utf-8'))

    offices = read_csv(root / 'common' / 'offices.csv')
    for office_id, address in OFFICE_ADDRESS_CORRECTIONS.items():
        offices.loc[offices['office_id'] == office_id, 'address'] = address

    scenario_frames: dict[str, pd.DataFrame] = {}
    all_addresses = set(offices['address'])
    for scenario in ('core', 'stress'):
        jobs = read_csv(root / scenario / 'jobs.csv')
        for job_id, address in EVENT_ADDRESS_CORRECTIONS.items():
            jobs.loc[jobs['job_id'] == job_id, 'address'] = address
        scenario_frames[scenario] = jobs
        all_addresses.update(jobs['address'])

    locations, by_address = build_locations(all_addresses, osm_cache, fallback_cache)
    write_csv(locations, root / 'common' / 'locations.csv')
    write_csv(locations, root / 'common' / 'geocoding_audit.csv')

    offices = apply_locations(offices, by_address)
    write_csv(offices, root / 'common' / 'offices.csv')
    for scenario, jobs in scenario_frames.items():
        jobs['scenario'] = scenario.upper()
        jobs = apply_locations(jobs, by_address)
        write_csv(jobs, root / scenario / 'jobs.csv')

    engineers = read_csv(root / 'common' / 'engineers.csv')
    engineers['max_route_minutes'] = engineers.apply(
        lambda row: str(shift_duration_minutes(row['shift_start'], row['shift_end'])), axis=1
    )
    engineers['source'] = 'hybrid_synthetic_v2_1'
    write_csv(engineers, root / 'common' / 'engineers.csv')

    work_rules = read_csv(root / 'common' / 'work_rules.csv')
    work_rules['rule_version'] = 'v2.1'
    write_csv(work_rules, root / 'common' / 'work_rules.csv')
    update_traffic_profiles(root / 'common' / 'traffic_profiles.csv')

    commitments = pd.DataFrame(
        [
            {
                'commitment_id': 'STRESS-COMMIT-001',
                'job_id': 'SOUTHEAST-84466',
                'engineer_id': 'SOUTHEAST-ENG-01',
                'constraint_type': 'HARD_ASSIGNMENT',
                'effective_from': INITIAL_PLANNING_AT,
                'release_event_id': 'STRESS-EVT-002',
                'reason': 'Контрольное предварительное назначение: гарантирует проверку перепланирования при недоступности инженера.',
            }
        ]
    )
    write_csv(commitments, root / 'stress' / 'commitments.csv')

    stress_events = read_csv(root / 'stress' / 'events.csv')
    event_mask = stress_events['event_id'] == 'STRESS-EVT-002'
    stress_events.loc[event_mask, 'payload_json'] = json.dumps(
        {
            'engineer_id': 'SOUTHEAST-ENG-01',
            'freeze_in_progress': True,
            'release_commitment_id': 'STRESS-COMMIT-001',
            'required_future_job_id': 'SOUTHEAST-84466',
        },
        ensure_ascii=False,
        separators=(',', ':'),
    )
    write_csv(stress_events, root / 'stress' / 'events.csv')

    planning_context, policies = create_policies(root)
    rebuild_scenario_json(root, 'core', planning_context, policies)
    rebuild_scenario_json(root, 'stress', planning_context, policies)

    manifest = {
        'dataset_version': '2.1.0',
        'schema_version': '2.1.0',
        'generated_at': VERIFIED_AT,
        'planning_date': '2026-08-17',
        'initial_planning_at': INITIAL_PLANNING_AT,
        'timezone': 'Europe/Moscow',
        'deterministic_seed': 20260915,
        'csv_encoding': 'UTF-8 with BOM',
        'csv_delimiter': CSV_SEPARATOR,
        'list_delimiter_inside_fields': '|',
        'source_job_counts': {'EAST': 66, 'SOUTHEAST': 83, 'SOUTHCENTER': 56},
        'scenario_counts': {'core_jobs_total': 206, 'stress_jobs_total': 207, 'engineers': 35},
        'coordinate_reference_system': 'WGS84 (EPSG:4326)',
        'coordinate_policy': (
            'Каждая локация имеет проверенный адресный объект, точность, провайдер, ID объекта и URL. '
            'Нулевые и неподтверждённые координаты запрещены.'
        ),
        'constraint_policy_file': 'common/constraint_policies.json',
        'planning_context_file': 'common/planning_context.json',
        'routing_profile_file': 'common/traffic_profiles.csv',
        'algorithm_contract_file': 'ALGORITHM_SPEC.md',
        'validation_command': 'python validate_dataset.py .',
        'stress_expected_result': 'Дефицит 1 ONT_GIGABIT в SOUTHEAST после SOUTHEAST-EVENT-002.',
    }
    (root / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    write_readme(root)
    shutil.copy2(args.validator_script, root / 'validate_dataset.py')
    shutil.copy2(args.algorithm_spec, root / 'ALGORITHM_SPEC.md')

    (root / 'audit.csv').unlink(missing_ok=True)
    write_checksums(root)


if __name__ == '__main__':
    main()
