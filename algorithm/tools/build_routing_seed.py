from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

from beeline_planning import build_master_model_input, load_planning_dataset, load_screening_matrices
from beeline_planning.export import master_solution_dict
from beeline_planning.routing_seed import build_full_coverage_routing_seed
from beeline_routing.export import payload_sha256, write_json_atomic


def main() -> int:
    parser = argparse.ArgumentParser(description='Build a mandatory-coverage VRPTW seed.')
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--screening-root', type=Path, required=True)
    parser.add_argument('--zone', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=120)
    parser.add_argument('--random-seed', type=int, default=20260918)
    parser.add_argument(
        '--mandatory-coverage',
        action='store_true',
        help='Keep every job mandatory even during construction of the first solution.',
    )
    parser.add_argument(
        '--forbid-job-arc',
        action='append',
        default=[],
        metavar='ORIGIN_JOB,DESTINATION_JOB',
    )
    parser.add_argument(
        '--override-arcs-json',
        action='append',
        default=[],
        type=Path,
        help='Checksummed EXACT_ENGINEER_ARC_OVERRIDES artifact.',
    )
    parser.add_argument(
        '--override-arc-minutes',
        action='append',
        default=[],
        metavar='ENGINEER,ORIGIN_NODE,DESTINATION_JOB,MINUTES',
    )
    args = parser.parse_args()
    source = load_planning_dataset(args.dataset, args.scenario)
    zone = args.zone.strip().upper()
    engineers = {key: value for key, value in source.engineers.items() if value.zone_id == zone}
    jobs = {key: value for key, value in source.jobs.items() if value.zone_id == zone}
    offices = {key: value for key, value in source.offices.items() if value.zone_id == zone}
    dataset = replace(
        source,
        engineers=MappingProxyType(engineers),
        jobs=MappingProxyType(jobs),
        offices=MappingProxyType(offices),
        shared_inventory=tuple(item for item in source.shared_inventory if item.zone_id == zone),
        events=tuple(event for event in source.events if event.zone_id == zone),
        commitments=tuple(item for item in source.commitments if item.job_id in jobs),
    )
    screening = load_screening_matrices(args.screening_root, source)
    master = build_master_model_input(dataset, screening)
    overrides: dict[tuple[str, str, str], int] = {}
    for path in args.override_arcs_json:
        artifact = json.loads(path.read_text(encoding='utf-8'))
        unsigned = dict(artifact)
        expected_hash = unsigned.pop('content_sha256', None)
        if expected_hash != payload_sha256(unsigned):
            parser.error(f'Override artifact checksum mismatch: {path}')
        if artifact.get('artifact_type') != 'EXACT_ENGINEER_ARC_OVERRIDES':
            parser.error(f'Not an exact override artifact: {path}')
        if artifact.get('dataset_sha256') != source.dataset_sha256:
            parser.error(f'Override artifact belongs to another dataset: {path}')
        for item in artifact.get('overrides', []):
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
            overrides[(parts[0], parts[1], parts[2])] = int(parts[3])
        except ValueError:
            parser.error('--override-arc-minutes MINUTES must be an integer')
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
    forbidden_job_arcs: list[tuple[str, str]] = []
    for raw in args.forbid_job_arc:
        parts = tuple(part.strip() for part in raw.split(','))
        if len(parts) != 2 or not all(parts):
            parser.error('--forbid-job-arc requires ORIGIN_JOB,DESTINATION_JOB')
        forbidden_job_arcs.append(parts)
    solution = build_full_coverage_routing_seed(
        dataset,
        master,
        screening,
        max_seconds=args.seconds,
        random_seed=args.random_seed,
        forbidden_job_arcs=tuple(forbidden_job_arcs),
        allow_intermediate_omissions=not args.mandatory_coverage,
    )
    payload = master_solution_dict(solution)
    payload['seed_kind'] = 'MANDATORY_COVERAGE_VRPTW'
    payload['zone_id'] = zone
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(json.dumps({'status': solution.status.value, **payload['summary'], 'output': str(args.output)}, ensure_ascii=False))
    return 0 if solution.routes and not solution.unserved_job_ids else 2


if __name__ == '__main__':
    raise SystemExit(main())
