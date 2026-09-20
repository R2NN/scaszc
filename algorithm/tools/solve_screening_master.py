from __future__ import annotations

import argparse
import json
from pathlib import Path

from beeline_planning import (
    ObjectivePolicy,
    SolverConfig,
    build_master_model_input,
    load_planning_dataset,
    load_screening_matrices,
    solve_screening_master,
)
from beeline_planning.export import load_master_solution, master_solution_dict
from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.models import TransportMode


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Build an explicitly non-authoritative CP-SAT screening solution.'
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), required=True)
    parser.add_argument('--screening-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument(
        '--hint-solution',
        type=Path,
        help='Audited screening solution used only as a CP-SAT warm start.',
    )
    parser.add_argument('--seconds-per-tier', type=float, default=30.0)
    parser.add_argument(
        '--objective-policy',
        choices=('service-quality', 'compact-team'),
        default='compact-team',
        help=(
            'After maximum coverage, either reduce response/travel/waiting first '
            'or reproduce the legacy minimum-team policy.'
        ),
    )
    parser.add_argument(
        '--full-coverage-seconds',
        type=float,
        default=300.0,
        help='Dedicated feasibility-search limit for a plan with zero omissions.',
    )
    parser.add_argument(
        '--allow-partial-after-proven-infeasible',
        action='store_true',
        help=(
            'After complete-graph infeasibility is proven, continue with the '
            'maximum-coverage partial plan. Disabled by default.'
        ),
    )
    parser.add_argument(
        '--search-workers',
        type=int,
        default=1,
        help='CP-SAT worker threads. Use 1 for deterministic canonical runs.',
    )
    parser.add_argument(
        '--max-predecessors',
        type=int,
        default=0,
        help='Search-neighborhood size; 0 keeps the complete master graph.',
    )
    parser.add_argument(
        '--unavailable-routing-mode',
        action='append',
        default=[],
        choices=[mode.value for mode in TransportMode],
        help='Exclude engineers whose routing mode has no trustworthy route source.',
    )
    parser.add_argument(
        '--exclude-arc',
        action='append',
        default=[],
        metavar='ENGINEER,ORIGIN_NODE,DESTINATION_JOB',
        help='Operationally avoid an arc that cannot currently be validated.',
    )
    parser.add_argument(
        '--inherit-exclusions-from',
        action='append',
        default=[],
        type=Path,
        metavar='MASTER_SOLUTION_JSON',
        help='Reuse verified operational exclusions from an earlier master solution.',
    )
    parser.add_argument(
        '--exclude-failures-from-probe',
        action='append',
        default=[],
        type=Path,
        metavar='PROBE_JSON',
        help='Import exact engineer/origin/job cuts from a verified probe artifact.',
    )
    parser.add_argument(
        '--retain-probe-arc',
        action='append',
        default=[],
        metavar='ENGINEER,ORIGIN_NODE,DESTINATION_JOB',
        help='Do not import a resolved failure arc from a probe artifact.',
    )
    args = parser.parse_args()
    dataset = load_planning_dataset(args.dataset, args.scenario)
    screening = load_screening_matrices(args.screening_root, dataset)
    master = build_master_model_input(
        dataset,
        screening,
        unavailable_routing_modes=frozenset(TransportMode(value) for value in args.unavailable_routing_mode),
    )
    excluded_arcs: list[tuple[str, str, str]] = []
    retained_probe_arcs: set[tuple[str, str, str]] = set()
    for raw in args.retain_probe_arc:
        parts = tuple(part.strip() for part in raw.split(','))
        if len(parts) != 3 or not all(parts):
            parser.error(
                '--retain-probe-arc requires ENGINEER,ORIGIN_NODE,DESTINATION_JOB'
            )
        retained_probe_arcs.add(parts)
    for path in args.inherit_exclusions_from:
        inherited = load_master_solution(path)
        if inherited.dataset_sha256 != dataset.dataset_sha256:
            parser.error(f'Inherited solution belongs to another dataset: {path}')
        excluded_arcs.extend(inherited.operationally_excluded_arcs)
    for path in args.exclude_failures_from_probe:
        probe = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(probe, dict):
            parser.error(f'Probe root must be an object: {path}')
        expected_hash = probe.get('content_sha256')
        unsigned_probe = dict(probe)
        unsigned_probe.pop('content_sha256', None)
        if expected_hash != payload_sha256(unsigned_probe):
            parser.error(f'Probe content checksum mismatch: {path}')
        if probe.get('artifact_type') != 'EXACT_ROUTE_REFINEMENT_PROBE':
            parser.error(f'Not an exact-route probe artifact: {path}')
        if probe.get('probe_complete') is False:
            parser.error(f'Cannot import cuts from an incomplete probe: {path}')
        total_routes = probe.get('total_engineer_routes')
        processed_routes = probe.get('processed_engineer_routes')
        if total_routes is not None and processed_routes != total_routes:
            parser.error(f'Probe route count is incomplete: {path}')
        if probe.get('dataset_sha256') != dataset.dataset_sha256:
            parser.error(f'Probe belongs to another dataset: {path}')
        for failure in probe.get('failures', []):
            if failure.get('kind') not in {'UNKNOWN', 'UNREACHABLE'}:
                parser.error(f'Unsupported probe failure kind in {path}')
            key = (
                failure['engineer_id'],
                failure['origin_node_id'],
                failure['job_id'],
            )
            if key not in retained_probe_arcs:
                excluded_arcs.append(key)
    for raw in args.exclude_arc:
        parts = tuple(part.strip() for part in raw.split(','))
        if len(parts) != 3 or not all(parts):
            parser.error('--exclude-arc requires ENGINEER,ORIGIN_NODE,DESTINATION_JOB')
        excluded_arcs.append(parts)
    hint_solution = (
        load_master_solution(args.hint_solution)
        if args.hint_solution is not None
        else None
    )
    solution = solve_screening_master(
        dataset,
        master,
        SolverConfig(
            max_seconds_per_tier=args.seconds_per_tier,
            num_search_workers=args.search_workers,
            max_predecessors_per_destination=(
                None if args.max_predecessors == 0 else args.max_predecessors
            ),
            excluded_arcs=tuple(sorted(set(excluded_arcs))),
            objective_policy=(
                ObjectivePolicy.SERVICE_QUALITY
                if args.objective_policy == 'service-quality'
                else ObjectivePolicy.COMPACT_TEAM
            ),
            full_coverage_seconds=args.full_coverage_seconds,
            allow_partial_after_proven_infeasible=(
                args.allow_partial_after_proven_infeasible
            ),
        ),
        hint_solution=hint_solution,
    )
    payload = master_solution_dict(solution)
    payload['content_sha256'] = payload_sha256(payload)
    write_json_atomic(args.output, payload)
    print(
        json.dumps(
            {
                'status': solution.status.value,
                'output': str(args.output),
                **payload['summary'],
                'proven_tiers': sum(
                    proof.proven_optimal for proof in solution.objective_proofs
                ),
            },
            ensure_ascii=False,
        )
    )
    return 0 if solution.routes else 2


if __name__ == '__main__':
    raise SystemExit(main())
