from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any

from beeline_planning import (
    EquipmentNeed,
    Event,
    Job,
    Priority,
    ReplanningState,
    RequiredTransport,
    build_explanation_bundle,
    load_planning_dataset,
    replan_after_event,
)
from beeline_planning.domain import EventType, JobStatus
from beeline_planning.export import load_exact_plan_artifact, materialization_result_dict
from beeline_planning.materialize import MaterializationResult, MaterializationStatus
from beeline_routing.cache import RoutingCache
from beeline_routing.cli import create_route_client
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.models import Coordinate
from beeline_routing.oracle import ExactRoutingOracle


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
    values = [item.strip() for item in str(raw).replace(',', '|').split('|') if item.strip()]
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


def _event_dataset(dataset, payload: dict[str, Any]) -> tuple[Any, Event]:
    event_payload = payload.get('event') or {}
    event_type = str(event_payload.get('type') or '').strip()
    event_time = _at(dataset, event_payload.get('time'))
    regular_jobs = {
        job_id: job for job_id, job in dataset.jobs.items() if not job.is_event_job
    }
    locations = dict(dataset.locations)
    digest = hashlib.sha256(
        json.dumps(event_payload, ensure_ascii=False, sort_keys=True).encode('utf-8')
    ).hexdigest()[:16]
    event_id = f'UI-EVT-{digest}'

    if event_type == 'NEW_ORDER':
        ui_id = str(event_payload.get('orderId') or '')
        order = next(
            (item for item in payload.get('orders', []) if str(item.get('id')) == ui_id),
            None,
        )
        if order is None:
            raise ValueError('Новая заявка отсутствует в переданной модели')
        source_job_id = _source_id(order.get('sourceId') or order.get('id'))
        if source_job_id == 'EAST-EVENT-001':
            canonical_event = next(
                item for item in dataset.events if item.target_id == source_job_id
            )
            return dataset, canonical_event
        if not source_job_id or source_job_id in regular_jobs:
            raise ValueError('ID новой заявки пуст или уже существует')
        coords = order.get('coords')
        if not isinstance(coords, list) or len(coords) != 2:
            raise ValueError('Для новой заявки нужны подтверждённые координаты')
        location_id = f'UI-LOC-{digest}'
        locations[location_id] = Coordinate(location_id, float(coords[0]), float(coords[1]))
        zone_id = _zone_id(payload, order, dataset)
        job = Job(
            job_id=source_job_id,
            zone_id=zone_id,
            location_id=location_id,
            window_start=_at(dataset, order.get('start')),
            window_end=_at(dataset, order.get('end')),
            created_at=event_time,
            service_duration_min=int(order.get('duration') or 0),
            priority=Priority.URGENT,
            required_skill=_skill(order.get('skill') or order.get('workType')),
            required_transport=_transport(
                order.get('requiredTransport')
                or order.get('sourceData', {}).get('required_transport')
            ),
            required_equipment=_equipment(order, dataset.equipment_catalog),
            is_event_job=True,
            status=JobStatus.PENDING,
        )
        if job.service_duration_min < 1 or job.window_end <= job.window_start:
            raise ValueError('Проверьте длительность и клиентское окно новой заявки')
        regular_jobs[source_job_id] = job
        event = Event(
            1, event_id, event_time, EventType.NEW_URGENT_JOB,
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
    elif event_type == 'ENGINEER_UNAVAILABLE':
        engineer_id = _source_id(
            event_payload.get('sourceEngineerId') or event_payload.get('engineerId')
        )
        engineer = dataset.engineers.get(engineer_id)
        if engineer is None:
            raise ValueError(f'Инженер не найден: {engineer_id}')
        event = Event(
            1, event_id, event_time, EventType.ENGINEER_UNAVAILABLE,
            engineer_id, engineer.zone_id, engineer.shift_end, {'source': 'UI'},
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
        event = Event(
            1, event_id, event_time, EventType.MANUAL_ASSIGNMENT,
            source_job_id, job.zone_id, None,
            {'source': 'UI', 'engineer_id': engineer_id},
        )
    else:
        raise ValueError(f'Неподдерживаемое событие: {event_type}')

    event_hash = hashlib.sha256(
        f'{dataset.dataset_sha256}:{event_id}'.encode('utf-8')
    ).hexdigest()
    return replace(
        dataset,
        dataset_sha256=event_hash,
        jobs=regular_jobs,
        locations=locations,
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


def main() -> int:
    parser = argparse.ArgumentParser(description='Exact UI event replanning adapter')
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--input-plan', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-route-checks', type=int, default=400)
    args = parser.parse_args()

    payload = json.load(sys.stdin)
    canonical = load_planning_dataset(args.dataset, 'core')
    plan, source = load_exact_plan_artifact(args.input_plan, canonical.dataset_sha256)
    expected_hash = str(payload.get('basePlanContentSha256') or '')
    if expected_hash and expected_hash != source['content_sha256']:
        raise ValueError('Перепланирование разрешено только от актуального точного плана')
    dataset, event = _event_dataset(canonical, payload)
    oracle = ExactRoutingOracle(create_route_client(
        RoutingCache(args.cache),
        'valhalla-local-transit',
        timeout_seconds=30,
        max_attempts=2,
        transit_index=args.transit_index,
        metro_wait_seconds=180,
    ))
    result = replan_after_event(
        dataset,
        ReplanningState(plan=plan),
        event,
        oracle,
        max_route_checks=args.max_route_checks,
        forced_engineer_by_job=(
            {event.target_id: str(event.payload['engineer_id'])}
            if event.event_type == EventType.MANUAL_ASSIGNMENT else None
        ),
    )
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
