from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from time import monotonic
from typing import Any

from beeline_planning import (
    EquipmentNeed,
    Engineer,
    Event,
    Job,
    Priority,
    ReplanningState,
    RequiredTransport,
    build_explanation_bundle,
    load_planning_dataset,
    replan_after_event,
)
from beeline_planning.domain import EventType, JobStatus, Office, Commitment, CommitmentType
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import MaterializationResult, MaterializationStatus
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.models import Coordinate, TransportMode
from beeline_routing.oracle import ExactRoutingOracle
from prepare_ui_dataset import equipment as parse_equipment, order_priority, order_skill


def _source_id(value: Any) -> str:
    text = str(value or '').strip()
    return text.split(':')[-1]


def _at(dataset, value: Any) -> datetime:
    text = str(value or '').strip()
    if 'T' in text:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            raise ValueError('Дата и время события должны содержать часовой пояс')
        return parsed
    if len(text) != 5 or text[2] != ':':
        raise ValueError(f'Некорректное время: {text}')
    return datetime.fromisoformat(
        f'{dataset.planning_date}T{text}:00{dataset.initial_planning_at.strftime("%z")[:3]}:'
        f'{dataset.initial_planning_at.strftime("%z")[3:]}'
    )


def _skill(value: Any) -> str:
    text = str(value or '').strip().upper()
    if text in {'EMERGENCY', 'INSTALL', 'LOCAL', 'UPSELL'}:
        return text
    lowered = text.lower()
    if 'авар' in lowered:
        return 'EMERGENCY'
    if 'подключ' in lowered or 'монтаж' in lowered:
        return 'INSTALL'
    if 'дозаказ' in lowered:
        return 'UPSELL'
    if 'локал' in lowered or 'ремонт' in lowered or 'диагност' in lowered:
        return 'LOCAL'
    raise ValueError(f'Неизвестный навык: {value}')


def _transport(value: Any) -> RequiredTransport:
    text = str(value or 'ANY').strip().casefold()
    aliases = {
        'auto': 'CAR', 'автомобиль': 'CAR',
        'foot': 'WALKING', 'пешком': 'WALKING',
        'bike': 'BICYCLE', 'велосипед': 'BICYCLE',
        'общественный транспорт': 'PUBLIC_TRANSIT',
    }
    try:
        return RequiredTransport(aliases.get(text, text.upper() or 'ANY'))
    except ValueError as error:
        raise ValueError(f'Неподдерживаемое требование к транспорту: {value}') from error


def _equipment(order: dict[str, Any], catalog) -> tuple[EquipmentNeed, ...]:
    raw = (
        order.get('requiredEquipment')
        or order.get('sourceData', {}).get('required_equipment')
        or ''
    )
    values = parse_equipment(raw)
    unknown = [item for item in values if item not in catalog]
    if unknown:
        raise ValueError('Неизвестные коды оборудования: ' + ', '.join(unknown))
    return tuple(EquipmentNeed(item, 1) for item in values)


def _zone_id(payload: dict[str, Any], order: dict[str, Any], dataset) -> str:
    direct = str(
        order.get('zoneId')
        or order.get('sourceData', {}).get('zone_id')
        or ''
    ).strip()
    zones = {engineer.zone_id for engineer in dataset.engineers.values()}
    if direct in zones:
        return direct
    label = str(order.get('zone') or order.get('zoneName') or '').strip().casefold()
    for candidate in payload.get('orders', []):
        candidate_label = str(candidate.get('zone') or candidate.get('zoneName') or '').strip().casefold()
        candidate_zone = str(
            candidate.get('zoneId')
            or candidate.get('sourceData', {}).get('zone_id')
            or ''
        ).strip()
        if label and candidate_label == label and candidate_zone in zones:
            return candidate_zone
    if direct:
        raise ValueError(f'Неизвестная территория: {direct}')
    raise ValueError('Для новой заявки не определена территория')


def _add_ui_engineer(dataset, candidate, zone_id, template, locations, offices, engineers, digest):
    engineer_id = _source_id(candidate.get('sourceId') or candidate.get('id'))
    if not engineer_id or engineer_id in engineers:
        raise ValueError('Новой бригаде нужен уникальный ID')
    coords = candidate.get('startCoords')
    if not isinstance(coords, list) or len(coords) != 2:
        raise ValueError('Для новой бригады нужна подтверждённая стартовая точка')
    location_id = f'UI-ENGINEER-LOC-{digest}'
    office_id = f'UI-ENGINEER-OFFICE-{digest}'
    locations[location_id] = Coordinate(location_id, float(coords[0]), float(coords[1]))
    offices[office_id] = Office(office_id, zone_id, location_id)
    equipment_codes = parse_equipment(candidate.get('equipment'))
    unknown = sorted(set(equipment_codes) - set(dataset.equipment_catalog))
    if unknown:
        raise ValueError('Неизвестное оборудование новой бригады: ' + ', '.join(unknown))
    engineers[engineer_id] = Engineer(
        engineer_id=engineer_id,
        zone_id=zone_id,
        shift_start=_at(dataset, candidate.get('shiftStart')),
        shift_end=_at(dataset, candidate.get('shiftEnd')),
        start_office_id=office_id,
        transport_mode=TransportMode(_transport(candidate.get('transport')).value),
        is_available=True,
        max_jobs=template.max_jobs,
        max_route_minutes=template.max_route_minutes,
        skills=frozenset(_skill(value) for value in candidate.get('skills', [])),
        equipment=tuple(EquipmentNeed(code, 1) for code in equipment_codes),
    )
    return engineer_id


def _event_dataset(dataset, payload: dict[str, Any]) -> tuple[Any, Event]:
    event_payload = payload.get('event') or {}
    event_type = str(event_payload.get('type') or '').strip()
    event_time = _at(dataset, event_payload.get('time'))
    regular_jobs = {
        job_id: job for job_id, job in dataset.jobs.items() if not job.is_event_job
    }
    engineers = dict(dataset.engineers)
    offices = dict(dataset.offices)
    locations = dict(dataset.locations)
    commitments = list(dataset.commitments)
    digest = hashlib.sha256(
        json.dumps({'event': event_payload, 'durations': [(item.get('id'), item.get('durationSnapshot')) for item in payload.get('orders', []) if item.get('durationSnapshot')]}, ensure_ascii=False, sort_keys=True).encode('utf-8')
    ).hexdigest()[:16]
    event_id = f'UI-EVT-{digest}'
    from beeline_planning.dispatch import checkpoint_location
    for anchor in event_payload.get('dispatchAnchors', {}).values():
        locations[anchor['location_id']] = checkpoint_location(anchor)

    if event_type == 'RECALCULATE':
        if not regular_jobs:
            raise ValueError('Для пересчёта нужны заявки смены')
        target = next(iter(regular_jobs.values()))
        event = Event(
            1, event_id, event_time, EventType.REPLAN_REQUEST,
            target.job_id, target.zone_id, None, {'source': 'UI'},
        )
    elif event_type == 'NEW_ORDER':
        ui_id = str(event_payload.get('orderId') or '')
        order = next(
            (item for item in payload.get('orders', []) if str(item.get('id')) == ui_id),
            None,
        )
        if order is None:
            raise ValueError('Новая заявка отсутствует в переданной модели')
        source_job_id = _source_id(order.get('sourceId') or order.get('id'))
        if not source_job_id or source_job_id in regular_jobs:
            raise ValueError('ID новой заявки пуст или уже существует')
        coords = order.get('coords')
        if not isinstance(coords, list) or len(coords) != 2:
            raise ValueError('Для новой заявки нужны подтверждённые координаты')
        location_id = f'UI-LOC-{digest}'
        location_id = next((key for key, point in locations.items() if abs(point.latitude-float(coords[0])) < 1e-8 and abs(point.longitude-float(coords[1])) < 1e-8), location_id)
        if location_id not in locations:
            locations[location_id] = Coordinate(location_id, float(coords[0]), float(coords[1]))
        zone_id = _zone_id(payload, order, dataset)
        priority = Priority(order_priority(order))
        job = Job(
            job_id=source_job_id,
            zone_id=zone_id,
            location_id=location_id,
            window_start=_at(dataset, order.get('start')),
            window_end=_at(dataset, order.get('end')),
            created_at=event_time,
            service_duration_min=int(order.get('duration') or 0),
            priority=priority,
            required_skill=order_skill(order),
            required_transport=_transport(
                order.get('requiredTransport')
                or order.get('sourceData', {}).get('required_transport')
            ),
            required_equipment=_equipment(order, dataset.equipment_catalog),
            is_event_job=False,
            status=JobStatus.PENDING,
        )
        if job.service_duration_min < 1 or job.window_end <= job.window_start:
            raise ValueError('Проверьте длительность и клиентское окно новой заявки')
        regular_jobs[source_job_id] = job
        event = Event(
            1, event_id, event_time,
            EventType.NEW_URGENT_JOB if priority == Priority.URGENT else EventType.NEW_JOB,
            source_job_id, zone_id, None, {'source': 'UI'},
        )
    elif event_type == 'ORDER_CANCELLED':
        source_job_id = _source_id(event_payload.get('sourceOrderId') or event_payload.get('orderId'))
        job = regular_jobs.get(source_job_id)
        if job is None:
            raise ValueError(f'Отменяемая заявка не найдена: {source_job_id}')
        event = Event(
            1, event_id, event_time, EventType.CANCEL_JOB,
            source_job_id, job.zone_id, None, {'source': 'UI'},
        )
    elif event_type == 'CLIENT_WINDOW_SHIFT':
        source_job_id = _source_id(event_payload.get('sourceOrderId') or event_payload.get('orderId'))
        job = regular_jobs.get(source_job_id)
        if job is None:
            raise ValueError(f'Заявка для изменения окна не найдена: {source_job_id}')
        start = _at(dataset, event_payload.get('start'))
        end = _at(dataset, event_payload.get('end'))
        if end <= start:
            raise ValueError('Новое клиентское окно должно завершаться после начала')
        regular_jobs[source_job_id] = replace(job, window_start=start, window_end=end)
        event = Event(
            1, event_id, event_time, EventType.WINDOW_SHIFT,
            source_job_id, job.zone_id, None, {'source': 'UI'},
        )
    elif event_type == 'ENGINEER_UNAVAILABLE':
        engineer_id = _source_id(
            event_payload.get('sourceEngineerId') or event_payload.get('engineerId')
        )
        engineer = dataset.engineers.get(engineer_id)
        if engineer is None:
            raise ValueError(f'Инженер не найден: {engineer_id}')
        replacement = event_payload.get('replacement')
        if replacement:
            replacement_zone = str(replacement.get('zoneId') or engineer.zone_id)
            if replacement_zone != engineer.zone_id:
                raise ValueError('Заменяющая бригада должна работать в той же территории')
            _add_ui_engineer(dataset, replacement, replacement_zone, engineer, locations, offices, engineers, digest)
        event = Event(
            1, event_id, event_time, EventType.ENGINEER_UNAVAILABLE,
            engineer_id, engineer.zone_id, engineer.shift_end, {'source': 'UI'},
        )
    elif event_type == 'CAPACITY_ADDED':
        new_engineer = event_payload.get('engineer')
        if new_engineer:
            zone_id = str(new_engineer.get('zoneId') or '').strip()
            if not zone_id:
                zone_label = str(new_engineer.get('zone') or '').casefold()
                source_member = next((member for member in payload.get('team', [])
                    if str(member.get('zone') or '').casefold() == zone_label
                    and _source_id(member.get('sourceId') or member.get('id')) in engineers), None)
                zone_id = engineers[_source_id(source_member.get('sourceId') or source_member.get('id'))].zone_id if source_member else ''
            template = next((member for member in engineers.values() if member.zone_id == zone_id), None)
            if template is None:
                raise ValueError('Для новой бригады не определена территория смены')
            engineer_id = _add_ui_engineer(dataset, new_engineer, zone_id, template, locations, offices, engineers, digest)
        else:
            engineer_id = _source_id(event_payload.get('sourceEngineerId') or event_payload.get('engineerId'))
            if engineer_id not in engineers:
                raise ValueError('Возвращаемая бригада не найдена')
        event = Event(
            1, event_id, event_time, EventType.CAPACITY_ADDED,
            engineer_id, engineers[engineer_id].zone_id, None, {'source': 'UI'},
        )
    elif event_type in {'SHIFT_BOUNDARY_CHANGED', 'SHIFT_EXTENDED'}:
        engineer_id = _source_id(event_payload.get('sourceEngineerId') or event_payload.get('engineerId'))
        engineer = engineers.get(engineer_id)
        if engineer is None or not engineer.is_available:
            raise ValueError('Для изменения смены нужна доступная бригада')
        start = _at(dataset, event_payload.get('shiftStart')) if event_payload.get('shiftStart') else engineer.shift_start
        end = _at(dataset, event_payload.get('shiftEnd'))
        if end <= start:
            raise ValueError('Окончание смены должно быть позже начала')
        engineers[engineer_id] = replace(engineer, shift_start=start, shift_end=end)
        event = Event(
            1, event_id, event_time, EventType.CAPACITY_ADDED,
            engineer_id, engineer.zone_id, None, {'source': 'UI', 'shift_change': True},
        )
    elif event_type == 'FORCED_ASSIGNMENT':
        source_job_id = _source_id(event_payload.get('sourceOrderId') or event_payload.get('orderId'))
        job = regular_jobs.get(source_job_id)
        if job is None:
            raise ValueError(f'Заявка для закрепления не найдена: {source_job_id}')
        engineer_id = _source_id(event_payload.get('sourceEngineerId') or event_payload.get('engineerId'))
        engineer = dataset.engineers.get(engineer_id)
        if engineer is None:
            raise ValueError(f'Инженер для закрепления не найден: {engineer_id}')
        if engineer.zone_id != job.zone_id:
            raise ValueError('Заявка и инженер относятся к разным территориям')
        commitments = [item for item in commitments if item.job_id != source_job_id]
        commitments.append(Commitment(f'UI-PIN-{digest}', source_job_id, engineer_id, CommitmentType.HARD_ASSIGNMENT, event_time, f'UI-RELEASE-{digest}'))
        event = Event(
            1, event_id, event_time, EventType.MANUAL_ASSIGNMENT,
            source_job_id, job.zone_id, None,
            {'source': 'UI', 'engineer_id': engineer_id},
        )
    else:
        raise ValueError(f'Неподдерживаемое событие: {event_type}')

    from beeline_planning.duration_contract import verify_duration_snapshot
    for order in payload.get('orders', []):
        job_id = _source_id(order.get('sourceId') or order.get('id'))
        if order.get('durationSnapshot') and job_id in regular_jobs:
            minutes, snapshot_id = verify_duration_snapshot(order['durationSnapshot'], int(order.get('duration') or 0))
            regular_jobs[job_id] = replace(regular_jobs[job_id], service_duration_min=minutes, authoritative_duration_min=minutes, duration_snapshot_id=snapshot_id)
    event_hash = hashlib.sha256(
        f'{dataset.dataset_sha256}:{event_id}'.encode('utf-8')
    ).hexdigest()
    return replace(
        dataset,
        dataset_sha256=event_hash,
        jobs=regular_jobs,
        engineers=engineers,
        offices=offices,
        locations=locations,
        commitments=tuple(commitments),
        events=(event,),
    ), event


def _changes(before, after) -> dict[str, list[dict[str, str]]]:
    def records(plan):
        return {
            visit.job_id: (route.engineer_id, visit.service_start_at.isoformat())
            for route in plan.engineer_plans for visit in route.visits
        }

    old, new = records(before), records(after)
    return {
        'newly_assigned': [
            {'job_id': job_id, 'engineer_id': new[job_id][0]}
            for job_id in sorted(new.keys() - old.keys())
        ],
        'removed_from_route': [
            {'job_id': job_id, 'former_engineer_id': old[job_id][0]}
            for job_id in sorted(old.keys() - new.keys())
        ],
        'changed_assignment': [
            {'job_id': job_id, 'from': old[job_id][0], 'to': new[job_id][0]}
            for job_id in sorted(old.keys() & new.keys()) if old[job_id][0] != new[job_id][0]
        ],
        'changed_visit_time': [
            {'job_id': job_id, 'from': old[job_id][1], 'to': new[job_id][1]}
            for job_id in sorted(old.keys() & new.keys()) if old[job_id][1] != new[job_id][1]
        ],
    }


def _dispatch_constraints(dataset, plan, event_time, payload):
    """Derive search/replay constraints from captured facts, not plan claims."""
    protected = {str(f['orderId']).split(':')[-1] for f in payload.get('facts', [])
        if f.get('status') in {'started', 'completed'} and _at(dataset, f.get('time')) <= event_time}
    releases, blocked = {}, set(payload.get('event', {}).get('unknownPositions', []))
    for fact in payload.get('facts', []):
        if fact.get('status') != 'started' or _at(dataset, fact.get('time')) > event_time:
            continue
        job_id = str(fact['orderId']).split(':')[-1]
        owner = next((route for route in plan.engineer_plans if any(v.job_id == job_id for v in route.visits)), None)
        if owner is None:
            continue
        visit = next(v for v in owner.visits if v.job_id == job_id)
        release = max(visit.service_start_at, _at(dataset, fact.get('startedAt') or fact['time'])) + timedelta(minutes=dataset.jobs[job_id].service_duration_min)
        if release <= event_time:
            blocked.add(owner.engineer_id)
        else:
            releases[owner.engineer_id] = max(releases.get(owner.engineer_id, release), release)
    return {'protected_job_ids': frozenset(protected), 'locked_engineer_ids': frozenset(blocked), 'available_after_by_engineer': releases}


def dispatch_variants(args, payload, canonical, dataset, state, event, source, history, oracle):
    """Search every statically eligible engineer with one shared routing budget."""
    from beeline_planning.eligibility import build_candidate_index
    index = build_candidate_index(dataset, event.event_time, applied_event_ids=frozenset((*state.applied_event_ids, event.event_id)))
    eligible = index.eligible_engineers_by_job.get(event.target_id, ())
    if payload.get('dispatchEngineerId'):
        eligible = tuple(key for key in eligible if key == payload['dispatchEngineerId'])
        if not eligible:
            raise ValueError('Выбранный инженер не соответствует требованиям аварии')
    checked, artifacts, rejected, repair_reports = 0, [], [], []
    attempted = set()
    current = {}
    def score(a):
        metrics = a['validation']['metrics']
        visit = next(v for r in a['plan']['engineer_plans'] for v in r['visits'] if v['job_id'] == event.target_id)
        return (metrics['unserved_urgent_jobs'], metrics['unserved_normal_jobs'], metrics['used_engineers'], visit['service_start_at'], metrics['total_distance_m'])
    def artifact_for(result, engineer_id, handoff, incumbent=None):
        artifact = materialization_result_dict(MaterializationResult(
            status=MaterializationStatus.EXACT_VALID, plan=result.state.plan,
            validation=result.validation, failure=None, exact_provider_queries=0, identity_legs=0))
        artifact.update({
            'artifact_type': 'EXACT_PLAN_REPLANNING', 'dataset_sha256': dataset.dataset_sha256,
            'source_plan_content_sha256': source['content_sha256'],
            'event_time': event.event_time.isoformat(), 'event_id': event.event_id,
            'exact_route_checks': result.exact_route_checks + (incumbent['exact_route_checks'] if incumbent else 0),
            'budget_exhausted': result.budget_exhausted,
            'search_phase': 'DISPATCH_FORCED_FULL_SHIFT', 'dispatch_engineer_id': engineer_id,
            'dispatch_handoff': handoff, 'coverage_repair': dict(result.coverage_repair),
            'changes': _changes(state.plan, result.state.plan), 'global_optimality_proven': False,
            'routing_configuration': {'provider': 'valhalla-local-transit', 'transit_index': str(args.transit_index)},
            'ui_history': [*history, {'event': payload['event'], 'orders': payload['orders'], 'team': payload['team']}],
            'dispatch_input': payload,
            'transport_restrictions': payload.get('transportRestrictions', []),
        })
        if incumbent:
            artifact['improves_content_sha256'] = incumbent['content_sha256']
        artifact['content_sha256'] = payload_sha256(artifact)
        return artifact
    def save_progress(complete=False):
        if artifacts:
            artifacts.sort(key=score)
            for artifact in artifacts:
                retained = args.output.parent / f'{artifact["content_sha256"]}.json'
                if not retained.exists():
                    write_json_atomic(retained, artifact)
            output = dict(artifacts[0])
            output['dispatch_candidates'] = artifacts
            output['dispatch_search'] = {'eligible': list(eligible), 'rejected': rejected, 'route_checks': checked, 'route_check_budget': args.rebuild_route_checks, 'coverage_repair': repair_reports, 'global_optimality_proven': False, 'complete': complete}
            write_json_atomic(args.output, output)
        write_json_atomic(args.output.with_suffix('.progress.json'), {'phase':'DISPATCH', 'completed':len(attempted), 'total':len(eligible), 'candidates':len(artifacts), 'routeChecks':checked + current.get('attemptRouteChecks', 0), 'candidateArtifacts':[a['content_sha256'] for a in artifacts], **current})
    constraints = _dispatch_constraints(dataset, state.plan, event.event_time, payload)
    blocked = constraints['locked_engineer_ids']
    from beeline_planning.dispatch import rank_interceptions
    def checking_road(key):
        current.update(engineerId=key, stage='INTERCEPT_ROAD_CHECK')
        save_progress()
    available = tuple(key for key in eligible if key not in blocked and dataset.engineers[key].shift_start <= event.event_time < dataset.engineers[key].shift_end)
    intercepts = rank_interceptions(dataset, state.plan, event, available,
        payload['event'].get('dispatchAnchors', {}), oracle, checking_road)
    # The closest legal interception needs a full handoff check before ordinary
    # offers. A 24-query probe cannot even revalidate many existing day routes.
    # Reserve its broader fallback too, so other offers cannot consume its budget.
    quick_checks = min(24, args.max_route_checks)
    nearest = intercepts[:1]
    current.update(priorityInterceptId=nearest[0] if nearest else None)
    attempts = [(key, False, True, args.max_route_checks) for key in nearest]
    attempts += [(key, True, True, 1000) for key in nearest]
    attempts += [(key, False, True, quick_checks) for key in intercepts[1:]]
    attempts += [(key, False, False, quick_checks) for key in eligible]
    attempts += [(key, False, True, args.max_route_checks) for key in intercepts[1:]]
    attempts += [(key, True, True, 1000) for key in intercepts[1:]]
    attempts += [(key, False, False, args.max_route_checks) for key in eligible]
    attempts += [(key, True, False, 1000) for key in eligible if key not in intercepts]
    for engineer_id, rebuild, handoff, trial_budget in attempts:
        if any(item['dispatch_engineer_id'] == engineer_id for item in artifacts):
            continue
        current.update(engineerId=engineer_id, stage='INTERCEPT_HANDOFF' if handoff else 'FULL_DAY_CHECK')
        rejected[:] = [item for item in rejected if item['engineerId'] != engineer_id]
        save_progress()
        engineer = dataset.engineers[engineer_id]
        if not engineer.shift_start <= event.event_time < engineer.shift_end:
            rejected.append({'engineerId': engineer_id, 'reason': 'Инженер ещё не вышел на смену или смена закончилась'})
            attempted.add(engineer_id)
            continue
        if engineer_id in blocked:
            rejected.append({'engineerId': engineer_id, 'reason': 'Начатая фактическая работа не завершена: уточните окончание'})
            attempted.add(engineer_id)
            continue
        remaining = args.rebuild_route_checks - checked
        if remaining <= 0:
            rejected.append({'engineerId': engineer_id, 'reason': 'Общий бюджет поиска исчерпан; невозможность не доказана'})
            continue
        try:
            def checking_progress(count):
                current.update(attemptRouteChecks=count)
                save_progress()
            result = replan_after_event(dataset, state, event, oracle,
                max_route_checks=min(trial_budget, remaining), departure_timing_queries=0,
                forced_engineer_by_job={event.target_id: engineer_id}, source_dataset=canonical,
                dispatch_engineer_id=engineer_id, rebuild_future=rebuild,
                handoff_interrupted_job=handoff, progress_callback=checking_progress,
                transport_anchors=payload.get('transportAnchors'), **constraints)
            current.pop('attemptRouteChecks', None)
            checked += result.exact_route_checks
            if result.state is None or event.target_id in result.state.plan.unserved_job_ids:
                rejected.append({'engineerId': engineer_id, 'reason': result.detail or result.unserved_reasons.get(event.target_id, 'Допустимая вставка не найдена в пределах поиска')})
                continue
            artifacts.append(artifact_for(result, engineer_id, handoff))
            attempted.add(engineer_id)
            save_progress()
        except Exception as error:
            rejected.append({'engineerId': engineer_id, 'reason': str(error)})
        finally:
            current.pop('attemptRouteChecks', None)
            attempted.add(engineer_id)
    # Publish all first responses before spending the remaining shared budget
    # on restoring coverage. An unsuccessful improvement never removes an offer.
    repair_deadline = monotonic() + 30
    for incumbent in sorted(artifacts, key=lambda item: (-len(item['changes']['removed_from_route']), score(item))):
        if payload.get('dispatchCoverageRepair') is False:
            break
        remaining = args.rebuild_route_checks - checked
        if remaining <= 0 or monotonic() >= repair_deadline or not incumbent['plan']['unserved_job_ids']:
            continue
        engineer_id = incumbent['dispatch_engineer_id']
        current.update(engineerId=engineer_id, stage='COVERAGE_REPAIR')
        save_progress()
        incumbent_plan, _ = load_exact_plan_artifact(args.output.parent / f'{incumbent["content_sha256"]}.json', dataset.dataset_sha256)
        def repairing_progress(count):
            current.update(repairRouteChecks=count)
            save_progress()
        try:
            result = replan_after_event(dataset, state, event, oracle,
                max_route_checks=min(1200, remaining), departure_timing_queries=0,
                forced_engineer_by_job={event.target_id: engineer_id}, source_dataset=canonical,
                dispatch_engineer_id=engineer_id, rebuild_future=True,
                handoff_interrupted_job=incumbent['dispatch_handoff'],
                incumbent_plan=incumbent_plan, coverage_repair_seconds=min(10, repair_deadline - monotonic()),
                progress_callback=repairing_progress, transport_anchors=payload.get('transportAnchors'), **constraints)
            checked += result.exact_route_checks
            repair_reports.append({'engineerId': engineer_id, 'checks': result.exact_route_checks,
                                   **result.coverage_repair, 'accepted': False})
            if result.state is None:
                continue
            before = set(incumbent_plan.unserved_job_ids)
            after = set(result.state.plan.unserved_job_ids)
            old_emergency = next(v for r in incumbent_plan.engineer_plans for v in r.visits if v.job_id == event.target_id)
            new_emergency = next(v for r in result.state.plan.engineer_plans for v in r.visits if v.job_id == event.target_id)
            if after < before and new_emergency.service_start_at <= old_emergency.service_start_at and (
                new_emergency.departure_at + timedelta(minutes=new_emergency.travel.duration_minutes)
                <= old_emergency.departure_at + timedelta(minutes=old_emergency.travel.duration_minutes)
            ):
                artifacts[artifacts.index(incumbent)] = artifact_for(result, engineer_id, incumbent['dispatch_handoff'], incumbent)
                repair_reports[-1].update(accepted=True, restoredJobs=sorted(before - after))
                save_progress()
        except Exception as error:
            # The exact incumbent is still a valid selectable result.
            current['repairNote'] = str(error)
            repair_reports.append({'engineerId': engineer_id, 'accepted': False, 'error': str(error)})
            save_progress()
    if not artifacts:
        raise ValueError('Проверенный вариант не найден: ' + json.dumps(rejected, ensure_ascii=False))
    save_progress(True)
    print(json.dumps({'status': 'EXACT_VALID', 'candidates': len(artifacts), 'exactRouteChecks': checked}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description='Exact UI event replanning adapter')
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-route-checks', type=int, default=400)
    parser.add_argument('--rebuild-route-checks', type=int, default=5000)
    parser.add_argument('--departure-timing-queries', type=int, default=24)
    args = parser.parse_args()

    payload = json.load(sys.stdin)
    canonical = load_planning_dataset(args.dataset, 'core')
    source_manifest = json.loads(args.input_plan.read_text(encoding='utf-8'))
    source_dataset_hash = source_manifest.get('dataset_sha256')
    history = source_manifest.get('ui_history', [])
    if source_dataset_hash != canonical.dataset_sha256:
        if source_manifest.get('artifact_type') != 'EXACT_PLAN_REPLANNING' or not history:
            raise ValueError('План относится к другому набору данных')
        applied_events = []
        for item in history:
            canonical, prior_event = _event_dataset(canonical, item)
            applied_events.append(replace(prior_event, apply_order=len(applied_events) + 1))
            canonical = replace(canonical, events=tuple(applied_events))
        if canonical.dataset_sha256 != source_dataset_hash:
            raise ValueError('История изменений не соответствует контрольной сумме плана')
    plan, source = load_exact_plan_artifact(args.input_plan, canonical.dataset_sha256)
    expected_hash = str(payload.get('basePlanContentSha256') or '')
    if expected_hash and expected_hash != source['content_sha256']:
        raise ValueError('Перепланирование разрешено только от актуального точного плана')
    if payload.get('dispatch'):
        from beeline_planning.dispatch import checkpoint
        anchors = {}
        unknown_positions = []
        for route in plan.engineer_plans:
            try:
                anchor = checkpoint(route, _at(canonical, payload['event']['time']), canonical.engineers[route.engineer_id].transport_mode)
            except ValueError:
                unknown_positions.append(route.engineer_id)
                continue
            if anchor:
                anchors[route.engineer_id] = anchor
        payload['event']['dispatchAnchors'] = anchors
        payload['event']['unknownPositions'] = unknown_positions
    transport_anchors = {}
    if payload.get('transportRestrictions'):
        from beeline_planning.dispatch import transport_checkpoint
        from beeline_routing.restrictions import TransportContext, trace_edges, road_violations
        context = TransportContext(payload['transportRestrictions'])
        for route in plan.engineer_plans:
            anchor = transport_checkpoint(route, _at(canonical,payload['event']['time']),canonical.engineers[route.engineer_id].transport_mode,context)
            if anchor and canonical.engineers[route.engineer_id].transport_mode.value == 'CAR':
                travel = next(v.travel for v in route.visits if v.job_id == anchor['source_job_id'])
                edges = trace_edges(os.environ.get('VALHALLA_ROUTE_ENDPOINT','http://127.0.0.1:8002/route'),travel.geometry)
                if not list(road_violations(context,context.road_events('CAR'),edges,travel.departure_at,travel.duration_seconds,_at(canonical,payload['event']['time']))):
                    anchor = None
            if anchor:
                transport_anchors[route.engineer_id] = anchor
        payload['transportAnchors'] = transport_anchors
        payload['event']['dispatchAnchors'] = {**payload['event'].get('dispatchAnchors',{}),**transport_anchors}
    dataset, event = _event_dataset(canonical, payload)
    prior_events = tuple(canonical.events) if history else ()
    event = replace(event, apply_order=len(prior_events) + 1)
    dataset = replace(dataset, events=prior_events + (event,))
    unavailable = {}
    for previous in prior_events:
        if previous.event_type == EventType.ENGINEER_UNAVAILABLE:
            unavailable[previous.target_id] = previous.unavailable_until
        elif previous.event_type == EventType.CAPACITY_ADDED:
            unavailable.pop(previous.target_id, None)
    canceled = frozenset(
        previous.target_id for previous in prior_events
        if previous.event_type == EventType.CANCEL_JOB
    )
    state = ReplanningState(
        plan=plan,
        applied_event_ids=tuple(previous.event_id for previous in prior_events),
        canceled_job_ids=canceled,
        unavailable_until_by_engineer=unavailable,
        last_event_time=prior_events[-1].event_time if prior_events else None,
    )
    if event.payload.get('shift_change') and event.target_id in unavailable:
        raise ValueError('Сначала верните недоступную бригаду в смену, затем измените её график')
    oracle = ExactRoutingOracle(create_route_client(
        RoutingCache(args.cache),
        'valhalla-local-transit',
        timeout_seconds=30,
        max_attempts=2,
        transit_index=args.transit_index,
        metro_wait_seconds=180,
    ))
    if payload.get('dispatch'):
        return dispatch_variants(args, payload, canonical, dataset, state, event, source, history, oracle)
    def progress(count=0, phase='EXACT_EVENT'):
        write_json_atomic(args.output.with_suffix('.progress.json'), {'phase': phase, 'routeChecks': count})
    progress()
    result = replan_after_event(
        dataset,
        state,
        event,
        oracle,
        max_route_checks=args.max_route_checks,
        departure_timing_queries=args.departure_timing_queries,
        forced_engineer_by_job=(
            {event.target_id: str(event.payload['engineer_id'])}
            if event.event_type == EventType.MANUAL_ASSIGNMENT else None
        ),
        source_dataset=canonical,
        progress_callback=progress,
        **(_dispatch_constraints(dataset, plan, event.event_time, payload) if payload.get('transportRestrictions') else {}),
        transport_anchors=transport_anchors,
    )
    search_phase = 'INSERT_IN_CURRENT_PLAN'
    if (
        event.event_type in {EventType.NEW_JOB, EventType.NEW_URGENT_JOB}
        and result.state is not None
        and event.target_id in result.state.plan.unserved_job_ids
    ):
        rebuilt = replan_after_event(
            dataset,
            state,
            event,
            oracle,
            max_route_checks=args.rebuild_route_checks,
            departure_timing_queries=args.departure_timing_queries,
            source_dataset=canonical,
            rebuild_future=True,
            progress_callback=lambda count: progress(count, 'EXACT_FULL_DAY'),
        )
        search_phase = 'REBUILT_FUTURE_PLAN'
        if rebuilt.state is None:
            raise ValueError(rebuilt.detail or 'Полный пересчёт не завершился')
        if rebuilt.budget_exhausted and event.target_id in rebuilt.state.plan.unserved_job_ids:
            raise ValueError('Полный пересчёт исчерпал поисковый бюджет: назначение новой заявки не проверено до конца')
        if event.target_id not in rebuilt.state.plan.unserved_job_ids:
            result = rebuilt
        elif result.budget_exhausted:
            result = rebuilt
    if result.state is None:
        print(json.dumps({
            'status': result.status.value,
            'error': result.detail or 'Точный маршрут не подтверждён',
            'exactRouteChecks': result.exact_route_checks,
        }, ensure_ascii=False))
        return 2
    if event.event_type == EventType.MANUAL_ASSIGNMENT and not any(
        visit.job_id == event.target_id and route.engineer_id == event.payload['engineer_id']
        for route in result.state.plan.engineer_plans for visit in route.visits
    ):
        print(json.dumps({
            'status': 'INFEASIBLE',
            'error': 'Закрепление невозможно при текущих окнах, навыках, оснащении и маршрутах',
            'exactRouteChecks': result.exact_route_checks,
        }, ensure_ascii=False))
        return 2

    artifact = materialization_result_dict(MaterializationResult(
        status=MaterializationStatus.EXACT_VALID,
        plan=result.state.plan,
        validation=result.validation,
        failure=None,
        exact_provider_queries=0,
        identity_legs=0,
    ))
    artifact['exact_provider_queries'] = None
    artifact['identity_legs'] = None
    artifact.update({
        'artifact_type': 'EXACT_PLAN_REPLANNING',
        'event_status': result.status.value,
        'event_id': event.event_id,
        'event_time': event.event_time.isoformat(),
        'source_plan_content_sha256': source['content_sha256'],
        'dataset_sha256': dataset.dataset_sha256,
        'exact_route_checks': result.exact_route_checks,
        'search_phase': search_phase,
        'budget_exhausted': result.budget_exhausted,
        'unserved_reasons': dict(result.unserved_reasons),
        'changes': _changes(plan, result.state.plan),
        'explanations': build_explanation_bundle(
            dataset,
            result.state.plan,
            result.validation,
            explanation_at=event.event_time,
            applied_event_ids=frozenset(result.state.applied_event_ids),
            canceled_job_ids=result.state.canceled_job_ids,
            previous_plan=plan,
            event=event,
            unserved_reasons=result.unserved_reasons,
            candidate_evaluations=result.candidate_evaluations,
            search_budget_exhausted=result.budget_exhausted,
            exact_route_checks=result.exact_route_checks,
            global_optimality_proven=False,
        ),
        'routing_configuration': {
            'provider': 'valhalla-local-transit',
            'transit_index': str(args.transit_index),
        },
        'global_optimality_proven': False,
        'transport_restrictions': payload.get('transportRestrictions', []),
        'ui_history': [*history, {
            'event': payload.get('event'),
            'orders': payload.get('orders', []),
            'team': payload.get('team', []),
        }],
    })
    artifact['content_sha256'] = payload_sha256(artifact)
    write_json_atomic(args.output, artifact)
    print(json.dumps({
        'status': result.status.value,
        'publicationAllowed': artifact['publication_allowed'],
        'contentSha256': artifact['content_sha256'],
        'exactRouteChecks': result.exact_route_checks,
        'output': str(args.output),
    }, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status': 'FAILED', 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
