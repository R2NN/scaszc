from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

from beeline_routing.export import payload_sha256, write_json_atomic


ROOT = Path(__file__).parents[1]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _command(*parts: object) -> list[str]:
    return [str(part) for part in parts]


def _discover_exact_incumbent(
    dataset_sha256: str,
    initial_planning_at: str,
) -> Path | None:
    """Select the best checksummed initial exact plan for this dataset, if present."""
    candidates: list[tuple[tuple[int, ...], Path]] = []
    for path in (ROOT / 'artifacts' / 'current').glob('*.json'):
        try:
            payload = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        unsigned = dict(payload)
        expected_hash = unsigned.pop('content_sha256', None)
        if expected_hash != payload_sha256(unsigned):
            continue
        plan = payload.get('plan')
        validation = payload.get('validation')
        if (
            payload.get('status') != 'EXACT_VALID'
            or payload.get('publication_allowed') is not True
            or payload.get('dataset_sha256') != dataset_sha256
            or not isinstance(plan, dict)
            or plan.get('planning_at') != initial_planning_at
            or not isinstance(validation, dict)
            or validation.get('status') != 'VALID'
        ):
            continue
        metrics = validation.get('metrics', {})
        key = (
            int(metrics.get('unserved_urgent_jobs', len(plan.get('unserved_job_ids', ())))),
            int(metrics.get('unserved_normal_jobs', 0)),
            int(metrics.get('used_engineers', len(plan.get('engineer_plans', ())))),
            int(metrics.get('total_distance_m', 0)),
            int(metrics.get('total_travel_minutes', 0)),
        )
        candidates.append((key, path.resolve()))
    return min(candidates, key=lambda item: (item[0], str(item[1])))[1] if candidates else None


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            'Run the complete deterministic planning pipeline for a new dataset '
            'that follows schema 2.1.0.'
        )
    )
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--scenario', choices=('core', 'stress'), default='core')
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--transit-index', type=Path)
    parser.add_argument('--rebuild-transit-index', action='store_true')
    parser.add_argument('--gtfs', type=Path)
    parser.add_argument('--rail', type=Path)
    parser.add_argument('--metro-schema', type=Path)
    parser.add_argument(
        '--valhalla-base-url', default='http://127.0.0.1:8002'
    )
    parser.add_argument(
        '--skip-valhalla-autostart',
        action='store_true',
        help='Do not start the local real-Valhalla bridge before routing stages.',
    )
    parser.add_argument('--metro-wait-seconds', type=int, default=180)
    parser.add_argument('--seconds-per-tier', type=float, default=45)
    parser.add_argument(
        '--polish-seconds-per-tier',
        type=float,
        default=10,
        help=(
            'Time per tier for minimizing teams and later metrics while '
            'preserving the best discovered coverage.'
        ),
    )
    parser.add_argument(
        '--full-graph-polish-seconds',
        type=float,
        default=30,
        help=(
            'Per-zone fallback budget for full-graph team minimization after '
            'the fast sparse polish cannot improve the incumbent. Use 0 to disable.'
        ),
    )
    parser.add_argument('--search-workers', type=int, default=1)
    parser.add_argument('--zone-workers', type=int, default=3)
    parser.add_argument('--route-workers', type=int, default=3)
    parser.add_argument('--adaptive-predecessors', default='8,16,0')
    parser.add_argument(
        '--warm-start',
        type=Path,
        help='Previous screening or exact plan used only as a structural solver hint.',
    )
    parser.add_argument(
        '--shared-cache-dir',
        type=Path,
        help='Reusable matrix and exact-route caches; defaults beside run-dir.',
    )
    parser.add_argument('--max-refinement-iterations', type=int, default=6)
    parser.add_argument('--refinement-query-budget', type=int, default=3000)
    parser.add_argument('--repair-route-checks', type=int, default=5000)
    parser.add_argument('--repair-passes', type=int, default=10)
    parser.add_argument('--skip-team-compaction', action='store_true')
    parser.add_argument('--team-compaction-candidates', type=int, default=12)
    parser.add_argument('--team-compaction-states', type=int, default=100_000)
    parser.add_argument('--skip-exact-improvement', action='store_true')
    parser.add_argument('--skip-chain-repair', action='store_true')
    parser.add_argument(
        '--execute', action='store_true',
        help='Without this flag, print the complete command plan without changing files.',
    )
    args = parser.parse_args()
    dataset = args.dataset.resolve()
    run_dir = args.run_dir.resolve()
    if not (dataset / 'manifest.json').is_file():
        parser.error('Dataset manifest.json is missing')
    manifest = json.loads((dataset / 'manifest.json').read_text(encoding='utf-8'))
    planning_date = str(manifest.get('planning_date', ''))
    if not planning_date:
        parser.error('Dataset manifest has no planning_date')
    from beeline_planning import load_planning_dataset
    loaded_dataset = load_planning_dataset(dataset, args.scenario)
    warm_start = (
        args.warm_start.resolve()
        if args.warm_start is not None
        else _discover_exact_incumbent(
            loaded_dataset.dataset_sha256,
            loaded_dataset.initial_planning_at.isoformat(),
        )
    )
    if args.metro_wait_seconds < 0:
        parser.error('--metro-wait-seconds must be non-negative')
    if (
        args.seconds_per_tier <= 0
        or args.polish_seconds_per_tier < 0
        or args.full_graph_polish_seconds < 0
    ):
        parser.error('Solve time must be positive and polish time non-negative')
    if (
        args.search_workers < 1
        or args.zone_workers < 1
        or args.route_workers < 1
        or args.max_refinement_iterations < 1
        or args.refinement_query_budget < 1
        or args.team_compaction_candidates < 1
        or args.team_compaction_states < 1
    ):
        parser.error('Worker counts and logical query cap must be positive')

    if args.rebuild_transit_index:
        for name in ('gtfs', 'rail', 'metro_schema'):
            value = getattr(args, name)
            if value is None:
                parser.error(f'--{name.replace("_", "-")} is required for index rebuild')
        transit_index = run_dir / 'transit' / f'transit-{planning_date}.sqlite'
    else:
        if args.transit_index is None:
            parser.error('--transit-index is required unless rebuilding it')
        transit_index = args.transit_index.resolve()
        if not transit_index.is_file():
            parser.error(f'Transit index does not exist: {transit_index}')

    validation = run_dir / 'dataset-validation.json'
    screening = run_dir / 'screening'
    master = run_dir / f'{args.scenario}-screening-master.json'
    exact = run_dir / f'{args.scenario}-exact.json'
    improved = run_dir / f'{args.scenario}-exact-improved.json'
    repaired = run_dir / f'{args.scenario}-exact-repaired.json'
    compacted = run_dir / f'{args.scenario}-exact-compacted.json'
    shared_cache_dir = (
        args.shared_cache_dir.resolve()
        if args.shared_cache_dir is not None
        else run_dir.parent / '.beego-cache'
    )
    cache = shared_cache_dir / 'routing-cache.sqlite3'
    screening_cache = shared_cache_dir / 'screening-cache.sqlite3'
    python = sys.executable
    commands: list[tuple[str, list[str]]] = []

    if not args.skip_valhalla_autostart and args.valhalla_base_url.rstrip('/') in {
        'http://127.0.0.1:8002',
        'http://localhost:8002',
    }:
        commands.append(('ensure_local_valhalla', _command(
            python, ROOT / 'tools' / 'ensure_local_valhalla.py',
            '--endpoint', args.valhalla_base_url,
        )))

    commands.append(('validate_dataset', _command(
        python, ROOT / 'tools' / 'validate_planning_dataset_generic.py',
        '--dataset', dataset, '--output', validation,
    )))
    if args.rebuild_transit_index:
        commands.extend((
            ('build_transit_index', _command(
                python, ROOT / 'tools' / 'build_local_transit_index.py',
                '--gtfs', args.gtfs.resolve(), '--rail', args.rail.resolve(),
                '--metro-schema', args.metro_schema.resolve(),
                '--output', transit_index, '--scenario-date', planning_date,
                '--metro-wait-seconds', args.metro_wait_seconds,
            )),
            ('build_surface_walk_transfers', _command(
                python, ROOT / 'tools' / 'build_surface_walk_transfers.py',
                '--database', transit_index,
                '--endpoint', f'{args.valhalla_base_url}/sources_to_targets',
            )),
            ('build_walk_transfers', _command(
                python, ROOT / 'tools' / 'build_walk_transfers.py',
                '--database', transit_index,
                '--endpoint', f'{args.valhalla_base_url}/sources_to_targets',
            )),
        ))
    commands.extend((
        ('routing_preflight', _command(
            python, '-m', 'beeline_routing.cli', 'preflight',
            '--dataset', dataset, '--scenario', args.scenario,
            '--transit-index', transit_index,
        )),
        ('build_surface_matrices', _command(
            python, ROOT / 'tools' / 'build_valhalla_screening_matrices.py',
            '--dataset', dataset, '--output', screening,
            '--endpoint', f'{args.valhalla_base_url}/sources_to_targets',
            '--route-endpoint', f'{args.valhalla_base_url}/route',
            '--cache', screening_cache,
        )),
        ('build_transit_matrices', _command(
            python, ROOT / 'tools' / 'build_local_transit_screening_matrix.py',
            '--dataset', dataset, '--transit-index', transit_index,
            '--walking-screening-root', screening, '--output', screening,
            '--cache', screening_cache,
        )),
        ('solve_screening_master', _command(
            python, ROOT / 'tools' / 'solve_screening_zones.py',
            '--dataset', dataset, '--scenario', args.scenario,
            '--screening-root', screening, '--output', master,
            '--seconds-per-tier', args.seconds_per_tier,
            '--polish-seconds-per-tier', args.polish_seconds_per_tier,
            '--full-graph-polish-seconds', args.full_graph_polish_seconds,
            '--search-workers', args.search_workers,
            '--zone-workers', args.zone_workers,
            '--adaptive-predecessors', args.adaptive_predecessors,
        )),
        ('refine_materialize_validate', _command(
            python, ROOT / 'tools' / 'refine_screening_exact.py',
            '--dataset', dataset, '--scenario', args.scenario,
            '--screening-root', screening,
            '--input-candidate', master, '--cache', cache,
            '--transit-index', transit_index, '--output', exact,
            '--metro-wait-seconds', args.metro_wait_seconds,
            '--max-exact-queries', args.refinement_query_budget,
            '--max-iterations', args.max_refinement_iterations,
            '--seconds-per-tier', args.seconds_per_tier,
            '--search-workers', args.search_workers,
            '--zone-workers', args.zone_workers,
            '--adaptive-predecessors', args.adaptive_predecessors,
            '--route-workers', args.route_workers,
            '--execute',
        )),
    ))
    if warm_start is not None:
        solve_command = commands[-2][1]
        solve_command.extend(('--warm-start', str(warm_start)))
    last_plan = exact
    if not args.skip_exact_improvement:
        commands.append(('exact_direct_insertion_improvement', _command(
            python, ROOT / 'tools' / 'improve_exact_plan.py',
            '--dataset', dataset, '--scenario', args.scenario,
            '--input-plan', last_plan, '--cache', cache,
            '--transit-index', transit_index, '--output', improved,
            '--metro-wait-seconds', args.metro_wait_seconds, '--execute',
        )))
        last_plan = improved
    if not args.skip_chain_repair:
        commands.append(('exact_chain_repair', _command(
            python, ROOT / 'tools' / 'repair_exact_plan.py',
            '--dataset', dataset, '--scenario', args.scenario,
            '--input-plan', last_plan, '--cache', cache,
            '--transit-index', transit_index, '--output', repaired,
            '--screening-root', screening,
            '--max-route-checks', args.repair_route_checks,
            '--max-displacements', 4, '--max-passes', args.repair_passes,
            '--metro-wait-seconds', args.metro_wait_seconds,
            '--trust-input-validation', '--execute',
        )))
        last_plan = repaired
    if not args.skip_team_compaction:
        commands.append(('exact_team_compaction', _command(
            python, ROOT / 'tools' / 'compact_exact_plan.py',
            '--dataset', dataset, '--scenario', args.scenario,
            '--input-plan', last_plan, '--screening-root', screening,
            '--cache', cache, '--transit-index', transit_index,
            '--output', compacted,
            '--max-screening-candidates', args.team_compaction_candidates,
            '--max-candidates-per-engineer', 2,
            '--max-screening-states', args.team_compaction_states,
            '--metro-wait-seconds', args.metro_wait_seconds,
            '--trust-input-validation', '--execute',
        )))
        last_plan = compacted

    plan = {
        'artifact_type': 'NEW_DATASET_PIPELINE_PLAN',
        'dataset': str(dataset),
        'scenario': args.scenario,
        'planning_date': planning_date,
        'run_dir': str(run_dir),
        'transit_index': str(transit_index),
        'shared_cache_dir': str(shared_cache_dir),
        'warm_start': str(warm_start) if warm_start else None,
        'warm_start_auto_discovered': args.warm_start is None and warm_start is not None,
        'rebuild_transit_index': args.rebuild_transit_index,
        'commands': [
            {'stage': stage, 'argv': command} for stage, command in commands
        ],
        'expected_final_plan': str(last_plan),
    }
    if not args.execute:
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0
    if run_dir.exists() and any(run_dir.iterdir()):
        parser.error('Run directory must be new or empty')
    run_dir.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment['PYTHONPATH'] = str(ROOT / 'src')
    environment['VALHALLA_ROUTE_ENDPOINT'] = f'{args.valhalla_base_url}/route'
    completed_stages = []
    started_at = datetime.now(UTC)
    for stage, command in commands:
        print(json.dumps({'event': 'STAGE_START', 'stage': stage}, ensure_ascii=False), flush=True)
        subprocess.run(command, cwd=ROOT, env=environment, check=True)
        completed_stages.append(stage)
        print(json.dumps({'event': 'STAGE_COMPLETE', 'stage': stage}, ensure_ascii=False), flush=True)
    output_files = []
    for path in sorted(run_dir.rglob('*')):
        if path.is_file() and path.name != 'pipeline-run.json':
            output_files.append({
                'path': path.relative_to(run_dir).as_posix(),
                'size_bytes': path.stat().st_size,
                'sha256': _sha256(path),
            })
    final_payload = json.loads(last_plan.read_text(encoding='utf-8'))
    unserved_jobs = tuple(final_payload.get('plan', {}).get('unserved_job_ids', ()))
    coverage_complete = not unserved_jobs
    publication_allowed = final_payload.get('publication_allowed') is True
    run_payload = {
        **plan,
        'status': 'COMPLETE' if publication_allowed else 'FAILED_VALIDATION',
        'started_at': started_at.isoformat(),
        'completed_at': datetime.now(UTC).isoformat(),
        'completed_stages': completed_stages,
        'output_files': output_files,
        'coverage_complete': coverage_complete,
        'unserved_job_ids': list(unserved_jobs),
        'publishable_final_plan': str(last_plan) if publication_allowed else None,
        'candidate_plan': str(last_plan),
    }
    run_payload['content_sha256'] = payload_sha256(run_payload)
    write_json_atomic(run_dir / 'pipeline-run.json', run_payload)
    print(json.dumps({
        'status': run_payload['status'],
        'final_plan': str(last_plan) if publication_allowed else None,
        'candidate_plan': str(last_plan),
        'coverage_complete': coverage_complete,
        'unserved_jobs': len(unserved_jobs),
        'run_manifest': str(run_dir / 'pipeline-run.json'),
    }, ensure_ascii=False), flush=True)
    return 0 if publication_allowed else 2


if __name__ == '__main__':
    raise SystemExit(main())
