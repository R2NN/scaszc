"""Check that reused road evidence belongs to the current operational input."""
from __future__ import annotations

from prepare_ui_dataset import equipment, order_priority, order_skill, skill


def source_id(item):
    """Strip only the known Moscow namespace, preserving other regional IDs."""
    return str(item.get('sourceId') or item['id']).removeprefix('moscow:')


def validate_rating_inputs(dataset, inputs):
    """Reject stale starts, durations or constraints before reusing a sealed plan."""
    if not inputs:
        raise ValueError('Не переданы актуальные входные данные рейтинга')
    jobs = {source_id(item): item for item in inputs['orders']}
    team = {source_id(item): item for item in inputs['team']}
    if len(jobs) != len(inputs['orders']) or len(team) != len(inputs['team']):
        raise ValueError('Повторяющийся ID во входных данных рейтинга')
    regular = {key: job for key, job in dataset.jobs.items() if not job.is_event_job}
    if set(jobs) != set(regular):
        raise ValueError('Состав заявок отличается от проверенного источника')
    for key, item in jobs.items():
        job = regular[key]
        location = dataset.locations[job.location_id]
        expected = job.authoritative_duration_min or job.service_duration_min
        if (int(item['duration']) != expected
            or item['start'] != job.window_start.strftime('%H:%M')
            or item['end'] != job.window_end.strftime('%H:%M')
            or item['zoneId'] != job.zone_id
            or order_skill(item) != job.required_skill
            or order_priority(item) != job.priority.value
            or any(abs(float(value) - actual) > 1e-7 for value, actual in zip(item['coords'], [location.latitude, location.longitude], strict=True))):
            raise ValueError(f'Заявка {key} изменилась. Нужен новый проверенный рабочий план')
    for key, item in team.items():
        original = dataset.engineers.get(key)
        if original is None:
            raise ValueError(f'Нет подтверждённого профиля инженера {key}')
        location = dataset.locations[dataset.offices[original.start_office_id].location_id]
        if (item['shiftStart'] != original.shift_start.strftime('%H:%M')
            or item['shiftEnd'] != original.shift_end.strftime('%H:%M')
            or item['zoneId'] != original.zone_id
            or item['transport'] != original.transport_mode.value
            or frozenset(skill(value) for value in item['skills']) != original.skills
            or set(equipment(item['equipment'])) != {need.equipment_id for need in original.equipment}
            or item.get('sourceData', {}).get('max_jobs') is not None and int(item['sourceData']['max_jobs']) != original.max_jobs
            or item.get('sourceData', {}).get('max_route_minutes') is not None and int(item['sourceData']['max_route_minutes']) != original.max_route_minutes
            or any(abs(float(value) - actual) > 1e-7 for value, actual in zip(item['startCoords'], [location.latitude, location.longitude], strict=True))
            or item.get('startPoint', {}).get('availableFrom', item['shiftStart']) > item['shiftStart']):
            raise ValueError(f'Старт или профиль инженера {key} изменился. Нужен новый проверенный рабочий план')
