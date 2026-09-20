from __future__ import annotations

import csv
import hashlib
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .cache import canonical_json, sha256_text
from .models import DetailedRoute, MatrixCell, RouteStep


def provenance_dict(value: Any) -> dict[str, Any]:
    return {
        'provider': value.provider,
        'endpoint': value.endpoint,
        'request_sha256': value.request_sha256,
        'response_sha256': value.response_sha256,
        'fetched_at': value.fetched_at,
        'cache_hit': value.cache_hit,
        'provider_metadata': value.provider_metadata,
    }


def matrix_cell_dict(cell: MatrixCell) -> dict[str, Any]:
    return {
        'origin_id': cell.origin_id,
        'destination_id': cell.destination_id,
        'mode': cell.mode.value,
        'departure_at': cell.departure_at.isoformat(),
        'status': cell.status.value,
        'duration_seconds': cell.duration_seconds,
        'duration_minutes': cell.duration_minutes,
        'distance_m': cell.distance_m,
        'provider_status': cell.provider_status,
        'provenance': provenance_dict(cell.provenance),
    }


def route_step_dict(step: RouteStep) -> dict[str, Any]:
    payload = asdict(step)
    payload['geometry'] = [list(point) for point in step.geometry]
    return payload


def detailed_route_dict(route: DetailedRoute) -> dict[str, Any]:
    return {
        'origin_id': route.origin_id,
        'destination_id': route.destination_id,
        'mode': route.mode.value,
        'departure_at': route.departure_at.isoformat(),
        'status': route.status.value,
        'duration_seconds': route.duration_seconds,
        'duration_minutes': route.duration_minutes,
        'distance_m': route.distance_m,
        'geometry': [list(point) for point in route.geometry],
        'itinerary': [route_step_dict(step) for step in route.itinerary],
        'provider_status': route.provider_status,
        'provenance': provenance_dict(route.provenance),
    }


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(encoded, encoding='utf-8')
    temporary.replace(path)


def write_matrix_csv(path: Path, cells: list[MatrixCell]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        'origin_id', 'destination_id', 'mode', 'departure_at', 'status',
        'duration_seconds', 'duration_minutes', 'distance_m', 'provider_status',
        'request_sha256', 'response_sha256', 'fetched_at', 'cache_hit',
    ]
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8-sig', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames, delimiter=';', lineterminator='\n')
        writer.writeheader()
        for cell in cells:
            writer.writerow(
                {
                    'origin_id': cell.origin_id,
                    'destination_id': cell.destination_id,
                    'mode': cell.mode.value,
                    'departure_at': cell.departure_at.isoformat(),
                    'status': cell.status.value,
                    'duration_seconds': '' if cell.duration_seconds is None else cell.duration_seconds,
                    'duration_minutes': '' if cell.duration_minutes is None else cell.duration_minutes,
                    'distance_m': '' if cell.distance_m is None else cell.distance_m,
                    'provider_status': cell.provider_status,
                    'request_sha256': cell.provenance.request_sha256,
                    'response_sha256': cell.provenance.response_sha256,
                    'fetched_at': cell.provenance.fetched_at,
                    'cache_hit': str(cell.provenance.cache_hit).lower(),
                }
            )
    temporary.replace(path)


def payload_sha256(payload: Any) -> str:
    return sha256_text(canonical_json(payload))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()
