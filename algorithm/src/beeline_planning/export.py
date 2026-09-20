from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from beeline_routing.export import detailed_route_dict, payload_sha256
from beeline_routing.models import DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode

from .materialize import MaterializationResult, MaterializationStatus
from .plan import EngineerPlan, IdentityTravel, PlannedVisit, ProposedPlan
from .solver import (
    MasterEngineerRoute,
    MasterSolution,
    MasterSolveStatus,
    MasterVisit,
    ObjectiveProof,
)


def master_solution_dict(solution: MasterSolution) -> dict[str, Any]:
    """Serialize a screening solution without implying exact-route validity."""
    return {
        'artifact_type': 'SCREENING_MASTER_SOLUTION',
        'status': solution.status.value,
        'planning_at': solution.planning_at.isoformat(),
        'dataset_sha256': solution.dataset_sha256,
        'screening_snapshot_sha256': solution.screening_snapshot_sha256,
        'solver': {
            'name': 'OR-Tools CP-SAT',
            'version': solution.solver_version,
            'search_graph_complete': solution.search_graph_complete,
            'searched_arc_count': solution.searched_arc_count,
            'operationally_excluded_arcs': [
                list(key) for key in solution.operationally_excluded_arcs
            ],
        },
        'objective_proofs': [
            {
                'tier': proof.tier,
                'metric': proof.metric,
                'value': proof.value,
                'best_bound': proof.best_bound,
                'proven_optimal': proof.proven_optimal,
                'wall_time_seconds': proof.wall_time_seconds,
            }
            for proof in solution.objective_proofs
        ],
        'summary': {
            'used_engineers': len(solution.routes),
            'served_jobs': sum(len(route.visits) for route in solution.routes),
            'unserved_jobs': len(solution.unserved_job_ids),
        },
        'routes': [
            {
                'engineer_id': route.engineer_id,
                'visits': [
                    {
                        'sequence': visit.sequence,
                        'job_id': visit.job_id,
                        'origin_node_id': visit.origin_node_id,
                        'departure_at': visit.departure_at.isoformat(),
                        'service_start_at': visit.service_start_at.isoformat(),
                        'screening_duration_minutes': visit.screening_duration_minutes,
                        'screening_distance_m': visit.screening_distance_m,
                        'screening_source_mode': visit.screening_source_mode,
                        'screening_is_surrogate': visit.screening_is_surrogate,
                    }
                    for visit in route.visits
                ],
            }
            for route in solution.routes
        ],
        'unserved_job_ids': list(solution.unserved_job_ids),
        'publication_allowed': False,
        'publication_blocker': 'EXACT_ROUTE_MATERIALIZATION_AND_INDEPENDENT_VALIDATION_REQUIRED',
    }


def load_master_solution(path: Path) -> MasterSolution:
    """Load a screening artifact and verify its own content checksum."""
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('Master solution root must be an object')
    expected_hash = payload.pop('content_sha256', None)
    if expected_hash != payload_sha256(payload):
        raise ValueError('Master solution content checksum mismatch')
    if payload.get('artifact_type') != 'SCREENING_MASTER_SOLUTION':
        raise ValueError('Not a screening master solution')
    solver = payload['solver']
    return MasterSolution(
        status=MasterSolveStatus(payload['status']),
        planning_at=datetime.fromisoformat(payload['planning_at']),
        routes=tuple(
            MasterEngineerRoute(
                engineer_id=route['engineer_id'],
                visits=tuple(
                    MasterVisit(
                        sequence=visit['sequence'],
                        job_id=visit['job_id'],
                        origin_node_id=visit['origin_node_id'],
                        departure_at=datetime.fromisoformat(visit['departure_at']),
                        service_start_at=datetime.fromisoformat(visit['service_start_at']),
                        screening_duration_minutes=visit['screening_duration_minutes'],
                        screening_distance_m=visit['screening_distance_m'],
                        screening_source_mode=visit['screening_source_mode'],
                        screening_is_surrogate=visit['screening_is_surrogate'],
                    )
                    for visit in route['visits']
                ),
            )
            for route in payload['routes']
        ),
        unserved_job_ids=tuple(payload['unserved_job_ids']),
        objective_proofs=tuple(
            ObjectiveProof(
                tier=proof['tier'],
                metric=proof['metric'],
                value=proof['value'],
                best_bound=proof['best_bound'],
                proven_optimal=proof['proven_optimal'],
                wall_time_seconds=proof['wall_time_seconds'],
            )
            for proof in payload['objective_proofs']
        ),
        dataset_sha256=payload['dataset_sha256'],
        screening_snapshot_sha256=payload['screening_snapshot_sha256'],
        solver_version=solver['version'],
        search_graph_complete=solver['search_graph_complete'],
        searched_arc_count=solver['searched_arc_count'],
        operationally_excluded_arcs=tuple(
            tuple(key) for key in solver.get('operationally_excluded_arcs', [])
        ),
    )


def materialization_result_dict(result: MaterializationResult) -> dict[str, Any]:
    """Serialize exact evidence, validation findings, and publication decision."""
    payload: dict[str, Any] = {
        'artifact_type': 'EXACT_PLAN_MATERIALIZATION',
        'status': result.status.value,
        'exact_provider_queries': result.exact_provider_queries,
        'identity_legs': result.identity_legs,
        'dropped_job_ids': list(result.dropped_job_ids),
        'failure': (
            {
                'engineer_id': result.failure.engineer_id,
                'job_id': result.failure.job_id,
                'origin_location_id': result.failure.origin_location_id,
                'destination_location_id': result.failure.destination_location_id,
                'departure_at': result.failure.departure_at,
                'reason': result.failure.reason,
            }
            if result.failure
            else None
        ),
        'plan': None,
        'validation': None,
        'publication_allowed': False,
    }
    if result.plan is not None:
        payload['plan'] = {
            'planning_at': result.plan.planning_at.isoformat(),
            'engineer_plans': [
                {
                    'engineer_id': route.engineer_id,
                    'visits': [
                        {
                            'job_id': visit.job_id,
                            'departure_at': visit.departure_at.isoformat(),
                            'service_start_at': visit.service_start_at.isoformat(),
                            'travel': (
                                {
                                    'type': 'IDENTITY',
                                    'location_id': visit.travel.location_id,
                                    'departure_at': visit.travel.departure_at.isoformat(),
                                    'duration_minutes': 0,
                                    'distance_m': 0,
                                }
                                if isinstance(visit.travel, IdentityTravel)
                                else {'type': 'PROVIDER_ROUTE', **detailed_route_dict(visit.travel)}
                            ),
                        }
                        for visit in route.visits
                    ],
                }
                for route in result.plan.engineer_plans
            ],
            'unserved_job_ids': list(result.plan.unserved_job_ids),
        }
    if result.validation is not None:
        metrics = result.validation.metrics
        payload['validation'] = {
            'status': result.validation.status.value,
            'violations': [
                {
                    'code': violation.code.value,
                    'subject_id': violation.subject_id,
                    'detail': violation.detail,
                }
                for violation in result.validation.violations
            ],
            'metrics': {
                'served_urgent_jobs': metrics.served_urgent_jobs,
                'served_normal_jobs': metrics.served_normal_jobs,
                'unserved_urgent_jobs': metrics.unserved_urgent_jobs,
                'unserved_normal_jobs': metrics.unserved_normal_jobs,
                'used_engineers': metrics.used_engineers,
                'distance_m_by_engineer': dict(metrics.distance_m_by_engineer),
                'total_distance_m': metrics.total_distance_m,
                'travel_minutes_by_engineer': dict(metrics.travel_minutes_by_engineer),
                'total_travel_minutes': metrics.total_travel_minutes,
                'waiting_minutes_by_engineer': dict(metrics.waiting_minutes_by_engineer),
                'total_waiting_minutes': metrics.total_waiting_minutes,
                'route_minutes_by_engineer': dict(metrics.route_minutes_by_engineer),
            },
        }
    payload['publication_allowed'] = result.status == MaterializationStatus.EXACT_VALID
    return payload


def load_exact_plan_artifact(path: Path, dataset_sha256: str) -> tuple[ProposedPlan, dict[str, Any]]:
    """Load a checksummed published plan, preserving each exact travel proof."""
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('Exact plan root must be an object')
    expected_hash = payload.get('content_sha256')
    unsigned = {key: value for key, value in payload.items() if key != 'content_sha256'}
    if expected_hash != payload_sha256(unsigned):
        raise ValueError('Exact plan content checksum mismatch')
    if payload.get('dataset_sha256') != dataset_sha256:
        raise ValueError('Exact plan belongs to another dataset checksum')
    if payload.get('status') != 'EXACT_VALID' or payload.get('publication_allowed') is not True:
        raise ValueError('Source plan is not published EXACT_VALID')
    raw_plan = payload['plan']
    routes: list[EngineerPlan] = []
    for raw_route in raw_plan['engineer_plans']:
        visits: list[PlannedVisit] = []
        for raw_visit in raw_route['visits']:
            raw_travel = raw_visit['travel']
            if raw_travel['type'] == 'IDENTITY':
                travel = IdentityTravel(
                    location_id=raw_travel['location_id'],
                    departure_at=datetime.fromisoformat(raw_travel['departure_at']),
                )
            elif raw_travel['type'] == 'PROVIDER_ROUTE':
                raw_provenance = raw_travel['provenance']
                travel = DetailedRoute(
                    origin_id=raw_travel['origin_id'],
                    destination_id=raw_travel['destination_id'],
                    mode=TransportMode(raw_travel['mode']),
                    departure_at=datetime.fromisoformat(raw_travel['departure_at']),
                    status=RouteStatus(raw_travel['status']),
                    duration_seconds=raw_travel['duration_seconds'],
                    duration_minutes=raw_travel['duration_minutes'],
                    distance_m=raw_travel['distance_m'],
                    geometry=tuple(tuple(point) for point in raw_travel['geometry']),
                    itinerary=tuple(
                        RouteStep(
                            sequence=step['sequence'],
                            mode=step['mode'],
                            duration_seconds=step['duration_seconds'],
                            distance_m=step['distance_m'],
                            waiting_seconds=step['waiting_seconds'],
                            geometry=tuple(tuple(point) for point in step['geometry']),
                            attributes=step['attributes'],
                        )
                        for step in raw_travel['itinerary']
                    ),
                    provider_status=raw_travel['provider_status'],
                    provenance=Provenance(
                        provider=raw_provenance['provider'],
                        endpoint=raw_provenance['endpoint'],
                        request_sha256=raw_provenance['request_sha256'],
                        response_sha256=raw_provenance['response_sha256'],
                        fetched_at=raw_provenance['fetched_at'],
                        cache_hit=raw_provenance['cache_hit'],
                        provider_metadata=raw_provenance['provider_metadata'],
                    ),
                )
            else:
                raise ValueError(f'Unknown travel proof type: {raw_travel["type"]}')
            visits.append(PlannedVisit(
                job_id=raw_visit['job_id'],
                departure_at=datetime.fromisoformat(raw_visit['departure_at']),
                service_start_at=datetime.fromisoformat(raw_visit['service_start_at']),
                travel=travel,
            ))
        routes.append(EngineerPlan(raw_route['engineer_id'], tuple(visits)))
    return ProposedPlan(
        planning_at=datetime.fromisoformat(raw_plan['planning_at']),
        engineer_plans=tuple(routes),
        unserved_job_ids=tuple(raw_plan['unserved_job_ids']),
    ), payload
