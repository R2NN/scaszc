"""Convert reviewed UI rows into a checksummed dataset for the existing exact pipeline."""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import shutil
import sys
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).parents[2]
REFERENCE = ROOT / 'data' / 'dataset'
EQUIPMENT_LABELS = {
    'диагностический комплект': 'DIAG_SET', 'аварийный комплект': 'DIAG_SET',
    'монтажный комплект': 'INSTALL_SET',
    'кабельный комплект': 'CABLE_SET', 'кабель': 'CABLE_PACK',
    'роутер': 'ROUTER', 'ont': 'ONT_GIGABIT', 'гигабитный ont': 'ONT_GIGABIT',
    'тв приставка': 'TV_BOX', 'тв-приставка': 'TV_BOX',
}
SKILLS = {
    'локальные работы': 'LOCAL', 'подключение': 'INSTALL',
    'аварийные работы': 'EMERGENCY', 'дозаказ': 'UPSELL',
}
TRANSPORT = {
    'автомобиль': 'CAR', 'пешком': 'WALKING', 'велосипед': 'BICYCLE',
    'общественный транспорт': 'PUBLIC_TRANSIT',
    'auto': 'CAR', 'car': 'CAR', 'foot': 'WALKING', 'walk': 'WALKING',
    'bike': 'BICYCLE', 'public transit': 'PUBLIC_TRANSIT',
}
ZONE_LABELS = {'восток': 'EAST', 'юго-восток': 'SOUTHEAST', 'югоцентр': 'SOUTHCENTER'}


def source_data(item: dict[str, Any]) -> dict[str, Any]:
    """Treat a missing source record as empty while rejecting malformed records."""
    value = item.get('sourceData')
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError('sourceData должен быть объектом с полями исходной строки')
    return value


def source_id(item: dict[str, Any], kind: str) -> str:
    value = item.get('sourceId') or source_data(item).get(kind) or item.get('id')
    result = str(value or '').strip().split(':')[-1]
    if not result or any(character in result for character in '\r\n;'):
        raise ValueError(f'Некорректный ID: {value!r}')
    return result


def zone(item: dict[str, Any]) -> str:
    raw = str(item.get('zoneId') or source_data(item).get('zone_id') or item.get('zone') or '').strip()
    if not raw:
        raise ValueError(f'Не указана территория: {item.get("id")}')
    return ZONE_LABELS.get(raw.casefold(), raw)


def skill(value: Any) -> str:
    raw = str(value or '').strip()
    result = SKILLS.get(raw.casefold(), raw.upper())
    if result not in {'LOCAL', 'INSTALL', 'EMERGENCY', 'UPSELL'}:
        raise ValueError(f'Неизвестный навык: {raw}')
    return result


def priority(value: Any) -> str:
    raw = str('NORMAL' if value is None else value).strip().casefold()
    if raw in {'', 'normal', 'обычная', 'обычный'}:
        return 'NORMAL'
    if raw in {
        'urgent', 'high', 'emergency', 'critical', 'срочная', 'срочный',
        'срочно', 'высокий', 'высокая', 'авария', 'аварийная', 'аварийный',
    }:
        return 'URGENT'
    raise ValueError(f'Неизвестный приоритет заявки: {value}')


def equipment(value: Any) -> list[str]:
    if isinstance(value, list):
        pieces = value
    else:
        pieces = re.split(r'\s*[|;,·]\s*', str(value or ''))
    result = []
    for piece in pieces:
        raw = str(piece).strip()
        if not raw:
            continue
        code = EQUIPMENT_LABELS.get(raw.casefold(), raw.upper())
        if code not in {'DIAG_SET', 'INSTALL_SET', 'CABLE_SET', 'CABLE_PACK', 'ROUTER', 'TV_BOX', 'ONT_GIGABIT'}:
            raise ValueError(f'Неизвестное оборудование: {raw}')
        if code not in result:
            result.append(code)
    return result


def coordinates(item: dict[str, Any], field: str) -> tuple[float, float]:
    point = item.get(field)
    if not isinstance(point, (list, tuple)) or len(point) != 2:
        raise ValueError(f'Для {item.get("id")} нужны проверенные координаты ({field}: широта, долгота)')
    try:
        latitude, longitude = (float(str(value).strip().replace(',', '.')) for value in point)
    except (TypeError, ValueError) as error:
        raise ValueError(f'Координаты {item.get("id")} должны быть числами: широта, долгота') from error
    if not (math.isfinite(latitude) and math.isfinite(longitude)
            and 40 < latitude < 70 and 20 < longitude < 60):
        raise ValueError(f'Координаты {item.get("id")} вне поддерживаемой карты')
    return latitude, longitude


def clock(value: Any, label: str) -> str:
    raw = str(value or '').strip()
    match = re.fullmatch(
        r'(?:(?:\d{4}-\d{1,2}-\d{1,2})[T\s])?'
        r'(\d{1,2})[:.](\d{2})(?::00)?(?:Z|[+-]\d{2}:?\d{2})?', raw,
    )
    if match is None or int(match[1]) > 23 or int(match[2]) > 59:
        raise ValueError(f'{label}: требуется время ЧЧ:ММ, например 09:30')
    return f'{int(match[1]):02}:{match[2]}'


def engineer_availability(item: dict[str, Any], engineer_id: str) -> bool:
    raw = item.get('status')
    if raw is None or not str(raw).strip():
        raw = source_data(item).get('is_available')
    if isinstance(raw, bool):
        return raw
    normalized = str(raw or '').strip().casefold()
    if normalized in {'доступен', 'доступен сегодня', 'на смене', 'available', 'true', 'да', '1'}:
        return True
    if normalized in {'недоступен', 'отсутствует', 'unavailable', 'false', 'нет', '0'}:
        return False
    raise ValueError(
        f'Инженер {engineer_id}: укажите доступность «Доступен» или «Недоступен»; '
        'неизвестный статус нельзя считать доступностью',
    )


def planning_day(value: Any) -> date:
    raw = str(value or '').strip()
    try:
        if re.fullmatch(r'\d{2}\.\d{2}\.\d{4}(?:\s+.*)?', raw):
            return datetime.strptime(raw[:10], '%d.%m.%Y').date()
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}(?:[T\s].*)?', raw):
            return date.fromisoformat(raw[:10])
        raise ValueError('unsupported date format')
    except ValueError as error:
        raise ValueError('Укажите дату планирования в формате ГГГГ-ММ-ДД или ДД.ММ.ГГГГ') from error


class InputDataError(ValueError):
    """Report every actionable row error before starting exact routing."""

    def __init__(self, issues: list[str]) -> None:
        self.issues = issues
        excerpt = '; '.join(issues[:5])
        suffix = f'; ещё {len(issues) - 5} ошибок' if len(issues) > 5 else ''
        super().__init__(f'Исправьте входные данные: {excerpt}{suffix}')


def preflight_ui_rows(orders: list[Any], team: list[Any], planning_date: date,
                      reference_offices: dict[str, dict[str, str]]) -> None:
    """Check fields that cannot be guessed and attach row numbers to failures."""
    issues: list[str] = []
    seen: dict[str, set[str]] = {'Заявки': set(), 'Инженеры': set()}
    for collection, rows in (('Инженеры', team), ('Заявки', orders)):
        for index, item in enumerate(rows, 1):
            label = f'{collection}, строка {index}'
            if not isinstance(item, dict):
                issues.append(f'{label}: нужна запись с полями, а не {type(item).__name__}')
                continue
            try:
                imported = source_data(item)
            except ValueError as error:
                issues.append(f'{label}, sourceData: {error}')
                continue
            kind = 'engineer_id' if collection == 'Инженеры' else 'job_id'
            try:
                item_id = source_id(item, kind)
                if item_id in seen[collection]:
                    issues.append(f'{label}, ID: повторяется {item_id}')
                seen[collection].add(item_id)
            except ValueError as error:
                issues.append(f'{label}, ID: {error}')
                item_id = str(index)
            try:
                row_zone = zone(item)
            except ValueError:
                row_zone = None
                issues.append(f'{label}, территория: укажите участок инженера или заявки')
            if collection == 'Инженеры':
                try:
                    engineer_availability(item, item_id)
                except ValueError as error:
                    issues.append(f'{label}, доступность: {error}')
                if str(item.get('startGeocodeStatus') or '').casefold() in {'error', 'needs_geocoding'}:
                    issues.append(f'{label}, адрес старта: {item.get("geocodeError") or "подтвердите точный адрес или укажите проверенные координаты"}')
                point = item.get('startCoords')
                if point is None:
                    office_id = str(imported.get('start_office_id') or '')
                    office = reference_offices.get(office_id)
                    if office is None or office['zone_id'] != row_zone:
                        issues.append(f'{label}, адрес старта: нужны координаты; адрес из файла сначала геокодируйте')
                else:
                    try:
                        coordinates(item, 'startCoords')
                    except ValueError as error:
                        issues.append(f'{label}, координаты старта: {error}')
                try:
                    start = clock(item.get('shiftStart'), 'Начало смены')
                    end = clock(item.get('shiftEnd'), 'Конец смены')
                    if end <= start:
                        issues.append(f'{label}, конец смены: должен быть позже начала')
                except ValueError as error:
                    issues.append(f'{label}, смена: {error}')
                if not item.get('skills') and not imported.get('skills'):
                    issues.append(f'{label}, навыки: укажите хотя бы один навык')
                else:
                    raw_skills = item.get('skills') or str(imported.get('skills') or '').split('|')
                    try:
                        for value in raw_skills:
                            if str(value).strip():
                                skill(value)
                    except ValueError as error:
                        issues.append(f'{label}, навыки: {error}')
                raw_transport = str(item.get('transport') or imported.get('transport_type') or '').strip()
                mode = TRANSPORT.get(raw_transport.casefold(), raw_transport.upper())
                if mode not in {'CAR', 'WALKING', 'BICYCLE', 'PUBLIC_TRANSIT'}:
                    issues.append(f'{label}, транспорт: неизвестное значение {raw_transport!r}')
                try:
                    equipment(item.get('equipment') or imported.get('equipment'))
                except ValueError as error:
                    issues.append(f'{label}, оборудование: {error}')
                for field, label_name in (('max_jobs', 'максимум заявок'), ('max_route_minutes', 'максимум маршрута')):
                    value = imported.get(field)
                    if value is not None and str(value).strip() and not re.fullmatch(r'[1-9]\d*', str(value).strip()):
                        issues.append(f'{label}, {label_name}: нужно целое положительное число')
            else:
                if item.get('serviceDate'):
                    try:
                        if planning_day(item['serviceDate']) != planning_date:
                            issues.append(f'{label}, дата выполнения: отличается от даты расчёта {planning_date}')
                    except ValueError as error:
                        issues.append(f'{label}, дата выполнения: {error}')
                if str(item.get('geocodeStatus') or '').casefold() in {'error', 'needs_geocoding'}:
                    issues.append(f'{label}, адрес: {item.get("geocodeError") or "подтвердите точный дом или укажите проверенные координаты"}')
                try:
                    coordinates(item, 'coords')
                except ValueError as error:
                    issues.append(f'{label}, координаты: {error}')
                try:
                    start = clock(item.get('start'), 'Начало окна')
                    end = clock(item.get('end'), 'Конец окна')
                    if end < start:
                        issues.append(f'{label}, конец окна: должен быть не раньше начала')
                except ValueError as error:
                    issues.append(f'{label}, окно: {error}')
                duration = item.get('duration')
                if isinstance(duration, bool) or not re.fullmatch(r'[1-9]\d*', str(duration or '').strip()):
                    issues.append(f'{label}, длительность: укажите целое положительное число минут')
                try:
                    skill(item.get('skill') or item.get('workType') or imported.get('required_skill'))
                except ValueError as error:
                    issues.append(f'{label}, навык: {error}')
                try:
                    priority(item.get('priority', imported.get('priority')))
                except ValueError as error:
                    issues.append(f'{label}, приоритет: {error}')
                try:
                    equipment(item.get('equipment') or imported.get('required_equipment'))
                except ValueError as error:
                    issues.append(f'{label}, оборудование: {error}')
                raw_transport = str(item.get('transport') or imported.get('required_transport') or 'ANY').strip()
                mode = TRANSPORT.get(raw_transport.casefold(), raw_transport.upper())
                if mode not in {'ANY', 'CAR', 'WALKING', 'BICYCLE', 'PUBLIC_TRANSIT'}:
                    issues.append(f'{label}, транспорт: неизвестное требование {raw_transport!r}')
    if issues:
        raise InputDataError(issues)


def write_csv(path: Path, fields: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8-sig', newline='') as target:
        writer = csv.DictWriter(target, fieldnames=fields, delimiter=';', extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)


def reference_csv(relative: str) -> list[dict[str, str]]:
    with (REFERENCE / relative).open('r', encoding='utf-8-sig', newline='') as source:
        return list(csv.DictReader(source, delimiter=';'))


def prepare(payload: dict[str, Any], destination: Path) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise InputDataError(['Нужен объект с массивами orders и engineers'])
    orders, team = payload.get('orders'), payload.get('engineers')
    if not isinstance(orders, list) or not orders or not isinstance(team, list) or not team:
        raise InputDataError(['Для нового точного расчёта загрузите непустые массивы заявок и инженеров'])
    raw_date = payload.get('planningDate') or (orders[0].get('serviceDate') if isinstance(orders[0], dict) else '')
    planning_date = planning_day(raw_date)
    planning_at = f'{planning_date}T07:00:00+03:00'
    reference_offices = {item['office_id']: item for item in reference_csv('common/offices.csv')}
    preflight_ui_rows(orders, team, planning_date, reference_offices)
    (destination / 'common').mkdir(parents=True)
    (destination / 'core').mkdir()
    (destination / 'stress').mkdir()
    for name in ('constraint_policies.json', 'equipment.csv', 'traffic_profiles.csv'):
        shutil.copy2(REFERENCE / 'common' / name, destination / 'common' / name)
    catalog = {item['equipment_id']: item for item in reference_csv('common/equipment.csv')}
    reference_locations = {item['location_id']: item for item in reference_csv('common/locations.csv')}
    locations = []
    offices = []
    engineers = []
    engineer_skills = []
    engineer_equipment = []
    office_by_key: dict[tuple[str, float, float], str] = {}
    seen_engineers: set[str] = set()
    zones: set[str] = set()
    for index, item in enumerate(team, 1):
        engineer_id = source_id(item, 'engineer_id')
        if engineer_id in seen_engineers:
            raise ValueError(f'Повторяется ID инженера {engineer_id}')
        seen_engineers.add(engineer_id)
        zone_id = zone(item)
        zones.add(zone_id)
        start_point = item.get('startCoords')
        if start_point is None:
            reference_office = reference_offices.get(str(source_data(item).get('start_office_id') or ''))
            if reference_office is None or reference_office['zone_id'] != zone_id:
                raise ValueError(f'Для инженера {engineer_id} нужен точный адрес старта или известный офис')
            reference_location = reference_locations[reference_office['location_id']]
            start_point = [float(reference_location['latitude']), float(reference_location['longitude'])]
        lat, lon = coordinates({'id': engineer_id, 'startCoords': start_point}, 'startCoords')
        office_key = (zone_id, lat, lon)
        if office_key not in office_by_key:
            office_id = f'OFFICE-UI-{len(offices)+1}'
            location_id = f'LOC-OFFICE-UI-{len(offices)+1}'
            office_by_key[office_key] = office_id
            locations.append({'location_id': location_id, 'latitude': lat, 'longitude': lon, 'geocode_status': 'VERIFIED_UI', 'address': item.get('startAddress') or ''})
            offices.append({'office_id': office_id, 'zone_id': zone_id, 'location_id': location_id})
        raw_mode = str(item.get('transport') or source_data(item).get('transport_type') or '').strip()
        mode = TRANSPORT.get(raw_mode.casefold(), raw_mode.upper())
        if mode not in {'CAR', 'WALKING', 'BICYCLE', 'PUBLIC_TRANSIT'}:
            raise ValueError(f'Неизвестный транспорт инженера {engineer_id}: {raw_mode}')
        start, end = clock(item.get('shiftStart'), 'Начало смены'), clock(item.get('shiftEnd'), 'Конец смены')
        if end <= start:
            raise ValueError(f'Смена инженера {engineer_id} заканчивается до начала')
        skills = item.get('skills') or str(source_data(item).get('skills') or '').split('|')
        normalized_skills = {skill(value) for value in skills if str(value).strip()}
        if not normalized_skills:
            raise ValueError(f'У инженера {engineer_id} не указаны навыки')
        engineer_skills.extend({'engineer_id': engineer_id, 'skill_id': value} for value in sorted(normalized_skills))
        equipment_codes = equipment(item.get('equipment') or source_data(item).get('equipment'))
        for code in equipment_codes:
            if not catalog[code]['reusable'] == 'true':
                continue
            engineer_equipment.append({'engineer_id': engineer_id, 'equipment_id': code, 'quantity': 1})
        engineers.append({'engineer_id': engineer_id, 'engineer_name': item.get('name') or engineer_id, 'zone_id': zone_id, 'shift_start': start, 'shift_end': end, 'start_office_id': office_by_key[office_key], 'transport_type': mode, 'is_available': 'true' if engineer_availability(item, engineer_id) else 'false', 'max_jobs': int(source_data(item).get('max_jobs') or 10), 'max_route_minutes': int(source_data(item).get('max_route_minutes') or 720)})
    jobs = []
    rules = []
    matrix = []
    skill_mapping = []
    seen_jobs: set[str] = set()
    shared_demand: Counter[tuple[str, str]] = Counter()
    for index, item in enumerate(orders, 1):
        job_id = source_id(item, 'job_id')
        if job_id in seen_jobs:
            raise ValueError(f'Повторяется ID заявки {job_id}')
        seen_jobs.add(job_id)
        zone_id = zone(item)
        if zone_id not in zones:
            raise ValueError(f'Для территории {zone_id} нет инженеров')
        if str(item.get('geocodeStatus') or '').casefold() in {'needs_geocoding', 'error'}:
            raise ValueError(f'Координаты заявки {job_id} требуют подтверждения')
        lat, lon = coordinates(item, 'coords')
        location_id = f'LOC-JOB-UI-{index}'
        locations.append({'location_id': location_id, 'latitude': lat, 'longitude': lon, 'geocode_status': 'VERIFIED_UI', 'address': item.get('address') or ''})
        start, end = clock(item.get('start'), 'Начало окна'), clock(item.get('end'), 'Конец окна')
        if end < start:
            raise ValueError(f'Окно заявки {job_id} заканчивается до начала')
        duration = int(item.get('duration') or 0)
        if duration < 1:
            raise ValueError(f'У заявки {job_id} не указана длительность')
        required_skill = skill(item.get('skill') or item.get('workType') or source_data(item).get('required_skill'))
        bk_type, hd_type = f'UI-{required_skill}', f'UI-WORK-{index}'
        if not any(row['bk_type'] == bk_type for row in skill_mapping):
            skill_mapping.append({'bk_type': bk_type, 'required_skill': required_skill})
        codes = equipment(item.get('equipment') or source_data(item).get('required_equipment'))
        for code in codes:
            matrix.append({'hd_type': hd_type, 'equipment_id': code, 'quantity': 1, 'condition': 'ALWAYS'})
            if catalog[code]['shared_stock'] == 'true':
                shared_demand[zone_id, code] += 1
        rules.append({'bk_type': bk_type, 'hd_type': hd_type, 'service_duration_min': duration})
        transport_value = str(item.get('transport') or source_data(item).get('required_transport') or 'ANY').strip()
        raw_transport = TRANSPORT.get(transport_value.casefold(), transport_value.upper())
        if raw_transport not in {'ANY', 'CAR', 'PUBLIC_TRANSIT', 'BICYCLE', 'WALKING'}:
            raise ValueError(f'Неизвестное требование к транспорту заявки {job_id}: {transport_value}')
        priority_value = item['priority'] if 'priority' in item else source_data(item).get('priority')
        job_priority = priority(priority_value)
        jobs.append({'scenario': 'CORE', 'job_id': job_id, 'source_job_id': job_id, 'zone_id': zone_id, 'location_id': location_id, 'bk_type': bk_type, 'hd_type': hd_type, 'window_start': f'{planning_date}T{start}:00+03:00', 'window_end': f'{planning_date}T{end}:00+03:00', 'created_at': planning_at, 'service_duration_min': duration, 'priority': job_priority, 'required_skill': required_skill, 'required_transport': raw_transport, 'required_equipment': '|'.join(codes), 'gigabit_required': 'Нет', 'is_event_job': 'false', 'status': 'PENDING'})
    stock_source: dict[tuple[str, str], int] = {}
    overrides = payload.get('sharedInventory', [])
    if not isinstance(overrides, list):
        raise ValueError('Остатки оборудования должны быть списком')
    overridden: set[tuple[str, str]] = set()
    for row in overrides:
        if not isinstance(row, dict):
            raise ValueError('Некорректная запись остатка оборудования')
        key = (str(row.get('zoneId') or '').strip(), str(row.get('equipmentId') or '').strip())
        amount = row.get('quantity')
        if not key[0] or key[1] not in catalog or catalog[key[1]]['shared_stock'] != 'true':
            raise ValueError(f'Неизвестное общее оборудование: {key}')
        if key in overridden:
            raise ValueError(f'Остаток {key[0]}/{key[1]} указан дважды')
        if isinstance(amount, bool) or not re.fullmatch(r'\d+', str(amount)):
            raise ValueError(f'Остаток {key[0]}/{key[1]} должен быть целым неотрицательным числом')
        overridden.add(key)
        stock_source[key] = int(amount)
    inventory = []
    for key in sorted(shared_demand):
        if key not in stock_source:
            raise ValueError(f'Для {key[0]} не указан фактический остаток {key[1]} на {planning_date}; добавьте его в sharedInventory (можно 0)')
        inventory.append({'scenario': 'CORE', 'zone_id': key[0], 'equipment_id': key[1], 'quantity_available': stock_source[key], 'reservation_policy': 'RESERVE_AT_SHIFT_START', 'replenishment_during_day': 'false'})
    write_csv(destination / 'common' / 'locations.csv', ['location_id', 'latitude', 'longitude', 'geocode_status', 'address'], locations)
    write_csv(destination / 'common' / 'offices.csv', ['office_id', 'zone_id', 'location_id'], offices)
    write_csv(destination / 'common' / 'engineers.csv', ['engineer_id', 'engineer_name', 'zone_id', 'shift_start', 'shift_end', 'start_office_id', 'transport_type', 'is_available', 'max_jobs', 'max_route_minutes'], engineers)
    write_csv(destination / 'common' / 'engineer_skills.csv', ['engineer_id', 'skill_id'], engineer_skills)
    write_csv(destination / 'common' / 'engineer_equipment.csv', ['engineer_id', 'equipment_id', 'quantity'], engineer_equipment)
    write_csv(destination / 'common' / 'skill_mapping.csv', ['bk_type', 'required_skill'], skill_mapping)
    write_csv(destination / 'common' / 'work_rules.csv', ['bk_type', 'hd_type', 'service_duration_min'], rules)
    write_csv(destination / 'common' / 'work_equipment_matrix.csv', ['hd_type', 'equipment_id', 'quantity', 'condition'], matrix)
    write_csv(destination / 'core' / 'jobs.csv', list(jobs[0]), jobs)
    write_csv(destination / 'stress' / 'jobs.csv', list(jobs[0]), [{**job, 'scenario': 'STRESS'} for job in jobs])
    for scenario in ('core', 'stress'):
        write_csv(destination / scenario / 'events.csv', ['apply_order', 'event_id', 'event_time', 'event_type', 'target_id', 'zone_id', 'unavailable_until', 'payload_json'], [])
        write_csv(destination / scenario / 'shared_inventory.csv', ['scenario', 'zone_id', 'equipment_id', 'quantity_available', 'reservation_policy', 'replenishment_during_day'], [{**row, 'scenario': scenario.upper()} for row in inventory])
    manifest = {'dataset_version': '2.1.0', 'schema_version': '2.1.0', 'planning_date': planning_date.isoformat(), 'initial_planning_at': planning_at, 'timezone': 'Europe/Moscow', 'source': 'reviewed_ui_import', 'requires_public_transit': any(engineer['transport_type'] == 'PUBLIC_TRANSIT' and engineer['is_available'] == 'true' for engineer in engineers)}
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    lines = []
    for path in sorted(destination.rglob('*')):
        if path.is_file() and path.name != 'CHECKSUMS.sha256':
            lines.append(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(destination).as_posix()}')
    (destination / 'CHECKSUMS.sha256').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return {'status': 'PREPARED', 'jobs': len(jobs), 'engineers': len(engineers), 'dataset': str(destination)}


if __name__ == '__main__':
    try:
        print(json.dumps(prepare(json.load(sys.stdin), Path(sys.argv[1])), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status': 'FAILED',
                          'code': 'INVALID_INPUT' if isinstance(error, ValueError) else 'PREPARATION_FAILED',
                          'error': str(error),
                          'details': error.issues if isinstance(error, InputDataError) else [str(error)]},
                         ensure_ascii=False))
        raise SystemExit(1)
