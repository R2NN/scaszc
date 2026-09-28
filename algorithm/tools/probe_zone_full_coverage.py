from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

from beeline_planning import (
    SolverConfig,
    build_master_model_input,
    load_planning_dataset,
    load_screening_matrices,
    solve_screening_master,
)
from beeline_planning.export import load_master_solution, master_solution_dict
from beeline_planning.export import load_exact_plan_artifact
from beeline_planning.exact_repair import master_from_orders
from beeline_routing.export import payload_sha256, write_json_atomic


def main() -> int:
    """Probe strict complete coverage for one independent operational zone."""
    parser = argparse.ArgumentParser(
        description='Search one zone for a plan with zero unassigned jobs.',
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--screening-root', type=Path, required=True)
    parser.add_argument('--zone', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--hint-solution', type=Path)
    parser.add_argument(
        '--hint-exact-plan',
        type=Path,
        help=(
            'Use the route orders from a published exact plan as the CP-SAT '
            'warm start for this zone.'
        ),
    )
    parser.add_argument('--full-coverage-seconds', type=float, default=300)
    parser.add_argument('--seconds-per-tier', type=float, default=15)
    parser.add_argument('--search-workers', type=int, default=1)
    parser.add_argument(
        '--max-predecessors',
        type=int,
        default=0,
        help=(
            'Keep at most this many job predecessors per engineer/destination; '
            '0 keeps the complete graph.'
        ),
    )
    parser.add_argument(
        '--force-assignment',
        action='append',
        default=[],
        metavar='ENGINEER,JOB',
        help=(
            'Require JOB to be assigned to ENGINEER. Repeat the option to '
            'force several assignments.'
        ),
    )
    parser.add_argument(
        '--forbid-assignment',
        action='append',
        default=[],
        metavar='ENGINEER,JOB',
        help=(
            'Disallow JOB from being assigned to ENGINEER while leaving every '
            'other eligible engineer available.'
        ),
    )
    parser.add_argument(
        '--exclude-arc',
        action='append',
        default=[],
        metavar='ENGINEER,ORIGIN_NODE,DESTINATION_JOB',
        help='Exclude an arc rejected by exact materialization.',
    )
    parser.add_argument(
        '--override-arc-minutes',
        action='append',
        default=[],
        metavar='ENGINEER,ORIGIN_NODE,DESTINATION_JOB,MINUTES',
        help='Replace a screening duration with an exact observed duration.',
    )
    parser.add_argument(
        '--override-arcs-json',
        action='append',
        default=[],
        type=Path,
        help='Checksummed EXACT_ENGINEER_ARC_OVERRIDES artifact.',
    )
    parser.add_argument(
        '--zero-travel-lower-bound',
        action='store_true',
        help=(
            'Set every movement to zero. Infeasibility then proves that shifts, '
            'windows and qualifications alone make full coverage impossible.'
        ),
    )
    args = parser.parse_args()
    if args.hint_solution is not None and args.hint_exact_plan is not None:
        parser.error('Use only one of --hint-solution and --hint-exact-plan')
    if args.max_predecessors < 0:
        parser.error('--max-predecessors must be non-negative')

    source = load_planning_dataset(args.dataset, args.scenario)
    zone = args.zone.strip().upper()
    engineers = {
        engineer_id: engineer
        for engineer_id, engineer in source.engineers.items()
        if engineer.zone_id == zone
    }
    jobs = {
        job_id: job
        for job_id, job in source.jobs.items()
        if job.zone_id == zone
    }
    if not engineers or not jobs:
        parser.error(f'Zone {zone} has no engineers or jobs')
    offices = {
        office_id: office
        for office_id, office in source.offices.items()
        if office.zone_id == zone
    }
    dataset = replace(
        source,
        offices=MappingProxyType(offices),
        engineers=MappingProxyType(engineers),
        jobs=MappingProxyType(jobs),
        shared_inventory=tuple(
            item for item in source.shared_inventory if item.zone_id == zone
        ),
        events=tuple(event for event in source.events if event.zone_id == zone),
        commitments=tuple(
            commitment
            for commitment in source.commitments
            if commitment.job_id in jobs and commitment.engineer_id in engineers
        ),
    )
    screening = load_screening_matrices(args.screening_root, source)
    master = build_master_model_input(dataset, screening)
    forced_assignments: list[tuple[str, str]] = []
    for raw in args.force_assignment:
        parts = tuple(part.strip() for part in raw.split(','))
        if len(parts) != 2 or not all(parts):
            parser.error('--force-assignment requires ENGINEER,JOB')
        engineer_id, job_id = parts
        if engineer_id not in dataset.engineers:
            parser.error(f'Forced engineer is outside zone {zone}: {engineer_id}')
        if job_id not in dataset.jobs:
            parser.error(f'Forced job is outside zone {zone}: {job_id}')
        if engineer_id not in master.candidate_index.eligible_engineers_by_job[job_id]:
            parser.error(
                f'Forced assignment is statically ineligible: {engineer_id},{job_id}'
            )
        forced_assignments.append((engineer_id, job_id))
    duplicate_jobs = {
        job_id
        for _, job_id in forced_assignments
        if sum(item_job_id == job_id for _, item_job_id in forced_assignments) > 1
    }
    if duplicate_jobs:
        parser.error(
            f'Each forced job must have exactly one engineer: {sorted(duplicate_jobs)}'
        )
    if forced_assignments:
        master = replace(
            master,
            hard_assignments=tuple(sorted(
                set(master.hard_assignments) | set(forced_assignments)
            )),
        )
    forbidden_assignments: list[tuple[str, str]] = []
    for raw in args.forbid_assignment:
        parts = tuple(part.strip() for part in raw.split(','))
        if len(parts) != 2 or not all(parts):
            parser.error('--forbid-assignment requires ENGINEER,JOB')
        engineer_id, job_id = parts
        if engineer_id not in dataset.engineers or job_id not in dataset.jobs:
            parser.error(
                f'Forbidden assignment is outside zone {zone}: {engineer_id},{job_id}'
            )
        if engineer_id not in master.candidate_index.eligible_engineers_by_job[job_id]:
            parser.error(
                f'Forbidden assignment is not an eligible pair: {engineer_id},{job_id}'
            )
        forbidden_assignments.append((engineer_id, job_id))
    if set(forced_assignments) & set(forbidden_assignments):
        parser.error('The same assignment cannot be both forced and forbidden')
    overrides: dict[tuple[str, str, str], int] = {}
    for path in args.override_arcs_json:
        payload = json.loads(path.read_text(encoding='utf-8'))
        unsigned = dict(payload)
        expected_hash = unsigned.pop('content_sha256', None)
        if expected_hash != payload_sha256(unsigned):
            parser.error(f'Override artifact checksum mismatch: {path}')
        if payload.get('artifact_type') != 'EXACT_ENGINEER_ARC_OVERRIDES':
            parser.error(f'Not an exact override artifact: {path}')
        if payload.get('dataset_sha256') != source.dataset_sha256:
            parser.error(f'Override artifact belongs to another dataset: {path}')
        for item in payload.get('overrides', []):
            overrides[(
                item['engineer_id'],
                item['origin_node_id'],
                item['destination_job_id'],
            )] = int(item['duration_minutes'])
    for raw in args.override_arc_minutes:
        parts = tuple(part.strip() for part in raw.split(','))
        if len(parts) != 4 or not all(parts):
            parser.error(
                '--override-arc-minutes requires '
                'ENGINEER,ORIGIN_NODE,DESTINATION_JOB,MINUTES'
            )
        try:
            minutes = int(parts[3])
        except ValueError:
            parser.error('--override-arc-minutes MINUTES must be an integer')
        if minutes < 0:
            parser.error('--override-arc-minutes MINUTES cannot be negative')
        overrides[(parts[0], parts[1], parts[2])] = minutes
    if overrides:
        found: set[tuple[str, str, str]] = set()
        adjusted = []
        for arc in master.arcs:
            key = (arc.engineer_id, arc.origin_node_id, arc.destination_job_id)
            if key in overrides:
                found.add(key)
                adjusted.append(replace(
                    arc,
                    screening_duration_minutes=overrides[key],
                    screening_is_surrogate=False,
                ))
            else:
                adjusted.append(arc)
        missing = set(overrides) - found
        if missing:
            parser.error(f'Override arcs are absent from the graph: {sorted(missing)}')
        master = replace(master, arcs=tuple(adjusted))
    if args.zero_travel_lower_bound:
        master = replace(
            master,
            arcs=tuple(
                replace(
                    arc,
                    screening_duration_minutes=0,
                    screening_distance_m=0,
                    screening_is_surrogate=False,
                )
                for arc in master.arcs
            ),
        )
    hint_solution = None
    if args.hint_solution is not None:
        loaded_hint = load_master_solution(args.hint_solution)
        if loaded_hint.dataset_sha256 != source.dataset_sha256:
            parser.error('Hint solution belongs to another dataset')
        hint_solution = replace(
            loaded_hint,
            routes=tuple(
                route
                for route in loaded_hint.routes
                if route.engineer_id in dataset.engineers
            ),
            unserved_job_ids=tuple(
                job_id
                for job_id in loaded_hint.unserved_job_ids
                if job_id in dataset.jobs
            ),
            objective_proofs=(),
            operationally_excluded_arcs=(),
        )
    elif args.hint_exact_plan is not None:
        exact_plan, _ = load_exact_plan_artifact(
            args.hint_exact_plan,
            source.dataset_sha256,
        )
        hinted_routes = {
            route.engineer_id: tuple(visit.job_id for visit in route.visits)
            for route in exact_plan.engineer_plans
            if route.engineer_id in dataset.engineers
        }
        hinted_assigned = {
            job_id for order in hinted_routes.values() for job_id in order
        }
        hint_solution = master_from_orders(
            dataset,
            hinted_routes,
            set(dataset.jobs) - hinted_assigned,
        )
    excluded_arcs: list[tuple[str, str, str]] = []
    for raw in args.exclude_arc:
        parts = tuple(part.strip() for part in raw.split(','))
        if len(parts) != 3 or not all(parts):
            parser.error('--exclude-arc requires ENGINEER,ORIGIN_NODE,DESTINATION_JOB')
        excluded_arcs.append(parts)
    solution = solve_screening_master(
        dataset,
        master,
        SolverConfig(
            full_coverage_seconds=args.full_coverage_seconds,
            max_seconds_per_tier=args.seconds_per_tier,
            num_search_workers=args.search_workers,
            max_predecessors_per_destination=(
                args.max_predecessors or None
            ),
            excluded_arcs=tuple(sorted(set(excluded_arcs))),
            forbidden_assignments=tuple(sorted(set(forbidden_assignments))),
        ),
        hint_solution=hint_solution,
    )
    payload = master_solution_dict(solution)
    payload['probe_kind'] = (
        'ZONE_ZERO_TRAVEL_COVERAGE_PROOF'
        if args.zero_travel_lower_bound
        else 'ZONE_FULL_COVERAGE_PROBE'
    )
    payload['zone_id'] = zone
    payload['zero_travel_lower_bound'] = args.zero_travel_lower_bound
    payload['forced_assignments'] = [
        {'engineer_id': engineer_id, 'job_id': job_id}
        for engineer_id, job_id in forced_assignments
    ]
    payload['forbidden_assignments'] = [
        {'engineer_id': engineer_id, 'job_id': job_id}
        for engineer_id, job_id in forbidden_assignments
    ]
    payload['source_dataset_sha256'] = source.dataset_sha256
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({
        'zone_id': zone,
        'status': solution.status.value,
        **payload['summary'],
        'output': str(args.output),
    }, ensure_ascii=False), flush=True)
    return 0 if solution.routes and not solution.unserved_job_ids else 2


if __name__ == '__main__':
    raise SystemExit(main())
