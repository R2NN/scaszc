"""Convert reviewed UI rows into a checksummed dataset for the existing exact pipeline."""

from __future__ import annotations

import csv
import hashlib
import json
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
    'диагностический комплект': 'DIAG_SET', 'монтажный комплект': 'INSTALL_SET',
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
    'auto': 'CAR', 'foot': 'WALKING', 'bike': 'BICYCLE',
}
ZONE_LABELS = {'восток': 'EAST', 'юго-восток': 'SOUTHEAST', 'югоцентр': 'SOUTHCENTER'}


def source_id(item: dict[str, Any], kind: str) -> str:
    value = item.get('sourceId') or item.get('sourceData', {}).get(kind) or item.get('id')
    result = str(value or '').strip().split(':')[-1]
    if not result or any(character in result for character in '\r\n;'):
        raise ValueError(f'Некорректный ID: {value!r}')
    return result


def zone(item: dict[str, Any]) -> str:
    raw = str(item.get('zoneId') or item.get('sourceData', {}).get('zone_id') or item.get('zone') or '').strip()
    if not raw:
        raise ValueError(f'Не указана территория: {item.get("id")}')
    return ZONE_LABELS.get(raw.casefold(), raw)


def skill(value: Any) -> str:
    raw = str(value or '').strip()
    result = SKILLS.get(raw.casefold(), raw.upper())
    if result not in {'LOCAL', 'INSTALL', 'EMERGENCY', 'UPSELL'}:
        raise ValueError(f'Неизвестный навык: {raw}')
    return result


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
    if not isinstance(point, list) or len(point) != 2:
        raise ValueError(f'Для {item.get("id")} нужны проверенные координаты')
    latitude, longitude = map(float, point)
    if not (40 < latitude < 70 and 20 < longitude < 60):
        raise ValueError(f'Координаты {item.get("id")} вне поддерживаемой карты')
    return latitude, longitude


def clock(value: Any, label: str) -> str:
    raw = str(value or '').strip()
    if 'T' in raw:
        raw = raw.split('T', 1)[1][:5]
    if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', raw):
        raise ValueError(f'{label}: требуется время ЧЧ:ММ')
    return raw


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
    orders, team = payload.get('orders'), payload.get('engineers')
    if not isinstance(orders, list) or not orders or not isinstance(team, list) or not team:
        raise ValueError('Для нового точного расчёта загрузите заявки и инженеров')
    raw_date = str(payload.get('planningDate') or orders[0].get('serviceDate') or '').strip()[:10]
    try:
        planning_date = date.fromisoformat(raw_date)
    except ValueError as error:
        raise ValueError('Укажите дату планирования в данных заявок') from error
    transit_meta = json.loads((ROOT / 'data' / 'transit' / 'moscow_2026-08-17.manifest.json').read_text(encoding='utf-8'))
    planning_at = f'{planning_date}T07:00:00+03:00'
    (destination / 'common').mkdir(parents=True)
    (destination / 'core').mkdir()
    (destination / 'stress').mkdir()
    for name in ('constraint_policies.json', 'equipment.csv', 'traffic_profiles.csv'):
        shutil.copy2(REFERENCE / 'common' / name, destination / 'common' / name)
    catalog = {item['equipment_id']: item for item in reference_csv('common/equipment.csv')}
    reference_locations = {item['location_id']: item for item in reference_csv('common/locations.csv')}
    reference_offices = {item['office_id']: item for item in reference_csv('common/offices.csv')}
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
            reference_office = reference_offices.get(str(item.get('sourceData', {}).get('start_office_id') or ''))
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
        raw_mode = str(item.get('transport') or item.get('sourceData', {}).get('transport_type') or '').strip()
        mode = TRANSPORT.get(raw_mode.casefold(), raw_mode.upper())
        if mode not in {'CAR', 'WALKING', 'BICYCLE', 'PUBLIC_TRANSIT'}:
            raise ValueError(f'Неизвестный транспорт инженера {engineer_id}: {raw_mode}')
        start, end = clock(item.get('shiftStart'), 'Начало смены'), clock(item.get('shiftEnd'), 'Конец смены')
        if end <= start:
            raise ValueError(f'Смена инженера {engineer_id} заканчивается до начала')
        skills = item.get('skills') or str(item.get('sourceData', {}).get('skills') or '').split('|')
        normalized_skills = {skill(value) for value in skills if str(value).strip()}
        if not normalized_skills:
            raise ValueError(f'У инженера {engineer_id} не указаны навыки')
        engineer_skills.extend({'engineer_id': engineer_id, 'skill_id': value} for value in sorted(normalized_skills))
        equipment_codes = equipment(item.get('equipment') or item.get('sourceData', {}).get('equipment'))
        for code in equipment_codes:
            if not catalog[code]['reusable'] == 'true':
                continue
            engineer_equipment.append({'engineer_id': engineer_id, 'equipment_id': code, 'quantity': 1})
        engineers.append({'engineer_id': engineer_id, 'engineer_name': item.get('name') or engineer_id, 'zone_id': zone_id, 'shift_start': start, 'shift_end': end, 'start_office_id': office_by_key[office_key], 'transport_type': mode, 'is_available': 'false' if str(item.get('status') or '').casefold() in {'недоступен', 'unavailable'} else 'true', 'max_jobs': int(item.get('sourceData', {}).get('max_jobs') or 10), 'max_route_minutes': int(item.get('sourceData', {}).get('max_route_minutes') or 720)})
    if any(engineer['transport_type'] == 'PUBLIC_TRANSIT' for engineer in engineers) and planning_date.isoformat() != transit_meta['scenario_date']:
        raise ValueError(f'Для общественного транспорта на {planning_date} нужен маршрутный индекс с расписанием на эту дату')
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
        if str(item.get('geocodeStatus') or '').casefold() in {'review', 'needs_geocoding', 'error'}:
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
        required_skill = skill(item.get('skill') or item.get('workType') or item.get('sourceData', {}).get('required_skill'))
        bk_type, hd_type = f'UI-{required_skill}', f'UI-WORK-{index}'
        if not any(row['bk_type'] == bk_type for row in skill_mapping):
            skill_mapping.append({'bk_type': bk_type, 'required_skill': required_skill})
        codes = equipment(item.get('equipment') or item.get('sourceData', {}).get('required_equipment'))
        for code in codes:
            matrix.append({'hd_type': hd_type, 'equipment_id': code, 'quantity': 1, 'condition': 'ALWAYS'})
            if catalog[code]['shared_stock'] == 'true':
                shared_demand[zone_id, code] += 1
        rules.append({'bk_type': bk_type, 'hd_type': hd_type, 'service_duration_min': duration})
        transport_value = str(item.get('transport') or item.get('sourceData', {}).get('required_transport') or 'ANY').strip()
        raw_transport = TRANSPORT.get(transport_value.casefold(), transport_value.upper())
        if raw_transport not in {'ANY', 'CAR', 'PUBLIC_TRANSIT', 'BICYCLE', 'WALKING'}:
            raise ValueError(f'Неизвестное требование к транспорту заявки {job_id}: {transport_value}')
        raw_priority = str(item.get('priority') or '').casefold()
        priority = 'URGENT' if raw_priority in {'urgent', 'авария', 'срочная'} else 'NORMAL'
        jobs.append({'scenario': 'CORE', 'job_id': job_id, 'source_job_id': job_id, 'zone_id': zone_id, 'location_id': location_id, 'bk_type': bk_type, 'hd_type': hd_type, 'window_start': f'{planning_date}T{start}:00+03:00', 'window_end': f'{planning_date}T{end}:00+03:00', 'created_at': planning_at, 'service_duration_min': duration, 'priority': priority, 'required_skill': required_skill, 'required_transport': raw_transport, 'required_equipment': '|'.join(codes), 'gigabit_required': 'Нет', 'is_event_job': 'false', 'status': 'PENDING'})
    stock_source = {(row['zone_id'], row['equipment_id']): int(row['quantity_available']) for row in reference_csv('core/shared_inventory.csv')}
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
            raise ValueError(f'Для {key[0]} не указано наличие {key[1]}')
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
    manifest = {'dataset_version': '2.1.0', 'schema_version': '2.1.0', 'planning_date': planning_date.isoformat(), 'initial_planning_at': planning_at, 'timezone': 'Europe/Moscow', 'source': 'reviewed_ui_import'}
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
        print(json.dumps({'status': 'FAILED', 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
