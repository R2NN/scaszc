from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

from beeline_routing.export import payload_sha256, write_json_atomic
from beeline_routing.valhalla import DEFAULT_TRAFFIC_PROFILE


ROOT = Path(__file__).parents[1]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _planner_source_sha256() -> str:
    """Invalidate saved plans whenever planning or routing code changes."""
    digest = hashlib.sha256()
    for root in (ROOT / 'src', ROOT / 'tools'):
        for path in sorted(root.rglob('*.py')):
            digest.update(path.relative_to(ROOT).as_posix().encode('utf-8'))
            digest.update(_sha256(path).encode('ascii'))
    return digest.hexdigest()


def _command(*parts: object) -> list[str]:
    return [str(part) for part in parts]


def _is_publishable_exact(path: Path) -> bool:
    """Return whether a completed exact artifact may be returned to the UI."""
    payload = json.loads(path.read_text(encoding='utf-8'))
    plan = payload.get('plan')
    validation = payload.get('validation')
    return (
        payload.get('status') == 'EXACT_VALID'
        and payload.get('publication_allowed') is True
        and isinstance(plan, dict)
        and isinstance(validation, dict)
        and validation.get('status') == 'VALID'
    )


def _is_publishable_full_coverage(path: Path) -> bool:
    """Skip coverage repair only after an exact full-coverage artifact exists."""
    return (
        _is_publishable_exact(path)
        and not json.loads(path.read_text(encoding='utf-8'))['plan']['unserved_job_ids']
    )


def _exact_quality_key(path: Path) -> tuple[int, int, int, int, int]:
    """Rank independently validated plans by the business objective."""
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not _is_publishable_exact(path):
        raise ValueError(f'Exact plan is not publishable: {path}')
    metrics = payload['validation']['metrics']
    return (
        int(metrics['unserved_urgent_jobs']),
        int(metrics['unserved_normal_jobs']),
        int(metrics['used_engineers']),
        int(metrics['total_distance_m']),
        int(metrics['total_travel_minutes']),
    )


def _choose_exact_plan(current: Path | None, candidate: Path,
                       *, retimed: bool = False) -> Path:
    """Keep better coverage; accept later departures at equal coverage."""
    if not _is_publishable_exact(candidate):
        if current is None:
            raise ValueError(f'No publishable exact plan: {candidate}')
        return current
    if current is None:
        return candidate
    old_key = _exact_quality_key(current)
    new_key = _exact_quality_key(candidate)
    if new_key[:2] < old_key[:2]:
        return candidate
    if new_key[:2] > old_key[:2]:
        return current
    if retimed or new_key < old_key:
        return candidate
    return current


def _refinement_fallback_candidate(
    checkpoint: Path,
    master: Path,
    output: Path,
    dataset_sha256: str,
) -> Path:
    """Resume from a verified checkpoint, or use the original screening plan."""
    if not checkpoint.is_file():
        return master
    payload = json.loads(checkpoint.read_text(encoding='utf-8'))
    unsigned = dict(payload)
    if unsigned.pop('content_sha256', None) != payload_sha256(unsigned):
        raise ValueError('Exact refinement checkpoint checksum mismatch')
    candidate = payload.get('latest_candidate')
    if (
        payload.get('artifact_type') != 'EXACT_REFINEMENT_LOOP_CHECKPOINT'
        or payload.get('dataset_sha256') != dataset_sha256
        or not isinstance(candidate, dict)
        or candidate.get('dataset_sha256') != dataset_sha256
    ):
        return master
    candidate = dict(candidate)
    candidate['content_sha256'] = payload_sha256(candidate)
    write_json_atomic(output, candidate)
    return output


def _configure_valhalla_snapshot(environment: dict[str, str], base_url: str) -> None:
    """Bind every reusable route response to the active road-tile snapshot."""
    with urllib.request.urlopen(f'{base_url.rstrip("/")}/status', timeout=5) as response:
        status = json.loads(response.read())
    tile_revision = status.get('tile_revision') or environment.get('VALHALLA_TILE_REVISION')
    if not tile_revision and isinstance(status.get('tileset_last_modified'), int) and status.get('version'):
        tile_revision = f"valhalla-status:{status['version']}:{status['tileset_last_modified']}"
    if not isinstance(tile_revision, str) or not tile_revision:
        raise RuntimeError(
            'Valhalla must report tile_revision, or VALHALLA_TILE_REVISION '
            'must be set before cached routing is used.'
        )
    runtime_revision = status.get('runtime_revision', 'external-valhalla')
    environment['VALHALLA_TILE_REVISION'] = tile_revision
    environment['VALHALLA_RUNTIME_REVISION'] = (
        f'{runtime_revision}:tiles:{tile_revision}'
    )


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
            int(metrics.get('total_waiting_minutes', 0)),
            int(metrics.get('total_travel_minutes', 0)),
        )
        candidates.append((key, path.resolve()))
    return min(candidates, key=lambda item: (item[0], str(item[1])))[1] if candidates else None


def _validated_exact_incumbent(path: Path | None, dataset) -> bool:
    """Reuse a warm exact plan only after checksum and full validation checks."""
    if path is None:
        return False
    from beeline_planning import validate_initial_plan
    from beeline_planning.export import load_exact_plan_artifact

    try:
        plan, _ = load_exact_plan_artifact(path, dataset.dataset_sha256)
    except (OSError, ValueError, KeyError, TypeError):
        return False
    return validate_initial_plan(dataset, plan).status.value == 'VALID'


def _stable_plan_cache_key(
    dataset_sha256: str, scenario: str, transit_index: Path,
    environment: dict[str, str], metro_wait_seconds: int,
) -> str:
    """Bind a repeatable plan to its inputs and frozen routing sources."""
    traffic_path = Path(
        environment.get('TRAFFIC4CAST_PROFILE') or DEFAULT_TRAFFIC_PROFILE
    )
    return payload_sha256({
        'dataset_sha256': dataset_sha256,
        'scenario': scenario,
        'planner_source_sha256': _planner_source_sha256(),
        'transit_index_sha256': _sha256(transit_index),
        'valhalla_tile_revision': environment['VALHALLA_TILE_REVISION'],
        'valhalla_runtime_revision': environment['VALHALLA_RUNTIME_REVISION'],
        'traffic_profile_sha256': (
            _sha256(traffic_path) if traffic_path.is_file() else None
        ),
        'metro_wait_seconds': metro_wait_seconds,
    })


def _reuse_verified_plan(
    current: Path | None, incumbent: Path, *, cache_hit: bool,
    warm_verified: bool, recompute: bool,
) -> bool:
    """Freeze a cached result, or a complete independently checked warm plan."""
    return (
        not recompute
        and current == incumbent
        and (
            cache_hit
            or (warm_verified and _is_publishable_full_coverage(current))
        )
    )


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
    parser.add_argument(
        '--screening-root',
        type=Path,
        help=(
            'Reuse a complete checksummed screening snapshot. Matrix build '
            'stages are skipped; the normal strict loader still validates '
            'the snapshot against the dataset.'
        ),
    )
    parser.add_argument('--transit-index', type=Path)
    parser.add_argument('--rebuild-transit-index', action='store_true')
    parser.add_argument('--gtfs', type=Path)
    parser.add_argument('--rail', type=Path)
    parser.add_argument('--rail-weekday-reference', action='store_true')
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
    parser.add_argument(
        '--matrix-batch-size', type=int, default=25,
        help='Locations per side of a Valhalla screening matrix request.',
    )
    parser.add_argument('--matrix-workers', type=int, default=6)
    parser.add_argument('--adaptive-predecessors', default='8,16,0')
    parser.add_argument(
        '--cold-start-seed-seconds',
        type=int,
        default=60,
        help='Per-zone VRPTW seed budget used only when no warm plan is available.',
    )
    parser.add_argument(
        '--skip-robust-first-pass', action='store_true',
        help='Start with the nominal screening model instead of a buffered fast pass.',
    )
    parser.add_argument('--robust-car-buffer-minutes', type=int, default=6)
    parser.add_argument('--robust-transit-buffer-minutes', type=int, default=12)
    parser.add_argument('--robust-seconds-per-tier', type=float, default=15)
    parser.add_argument(
        '--robust-screening-wall-seconds', type=float, default=120,
        help='Maximum time spent on the buffered first-pass screening solve.',
    )
    parser.add_argument(
        '--robust-materialization-wall-seconds', type=float, default=180,
        help='Cold exact-routing limit for the buffered first pass.',
    )
    warm_start_group = parser.add_mutually_exclusive_group()
    warm_start_group.add_argument(
        '--warm-start',
        type=Path,
        help='Previous screening hint or validated exact incumbent.',
    )
    warm_start_group.add_argument(
        '--no-warm-start',
        action='store_true',
        help=(
            'Disable explicit and auto-discovered plan hints. Also omit '
            '--stable-plan-cache-dir for a cold benchmark.'
        ),
    )
    parser.add_argument(
        '--shared-cache-dir',
        type=Path,
        help='Reusable matrix and exact-route caches; defaults beside run-dir.',
    )
    parser.add_argument(
        '--stable-plan-cache-dir', type=Path,
        help='Reuse a fully validated result for identical dataset and routing inputs.',
    )
    parser.add_argument(
        '--recompute-stable-plan', action='store_true',
        help='Search again while retaining the saved exact plan as an incumbent.',
    )
    parser.add_argument('--max-refinement-iterations', type=int, default=20)
    parser.add_argument('--refinement-query-budget', type=int, default=3000)
    parser.add_argument(
        '--refinement-wall-seconds', type=float, default=120,
        help=(
            'Time allowed for exact CP-SAT refinement before a validated '
            'partial plan is built and passed to exact insertion and repair.'
        ),
    )
    parser.add_argument(
        '--optimization-wall-seconds', type=float, default=90,
        help='Maximum time for each exact insertion, repair and team compaction stage.',
    )
    parser.add_argument(
        '--departure-timing-wall-seconds', type=float, default=90,
        help='Time limit for bounded exact rerouting of early arrivals.',
    )
    parser.add_argument(
        '--max-wall-seconds', type=float, default=840,
        help='Whole-pipeline time limit; return the last validated plan when it expires.',
    )
    parser.add_argument('--skip-departure-timing', action='store_true')
    parser.add_argument(
        '--skip-route-conflict-refinement',
        action='store_true',
        help=(
            'Disable run-local route-prefix no-goods learned from exact '
            'schedule failures. Enabled by default to preserve full coverage '
            'without dataset-specific rules or assignment bans.'
        ),
    )
    parser.add_argument('--repair-route-checks', type=int, default=5000)
    parser.add_argument('--repair-passes', type=int, default=10)
    parser.add_argument('--lns-route-checks', type=int, default=2500)
    parser.add_argument('--lns-beam-width', type=int, default=48)
    parser.add_argument('--lns-max-destroyed-jobs', type=int, default=12)
    parser.add_argument('--lns-max-engineers', type=int, default=4)
    parser.add_argument('--skip-exact-lns', action='store_true')
    parser.add_argument('--skip-team-compaction', action='store_true')
    parser.add_argument('--team-compaction-candidates', type=int, default=12)
    parser.add_argument('--team-compaction-states', type=int, default=100_000)
    improvement_group = parser.add_mutually_exclusive_group()
    improvement_group.add_argument(
        '--include-exact-improvement',
        dest='skip_exact_improvement',
        action='store_false',
        help='Run the separate direct-insertion pass before chain repair.',
    )
    improvement_group.add_argument(
        '--skip-exact-improvement',
        dest='skip_exact_improvement',
        action='store_true',
        help='Skip the separate direct-insertion pass (the default).',
    )
    parser.set_defaults(skip_exact_improvement=True)
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
    warm_start = None
    if not args.no_warm_start:
        warm_start = (
            args.warm_start.resolve()
            if args.warm_start is not None
            else _discover_exact_incumbent(
                loaded_dataset.dataset_sha256,
                loaded_dataset.initial_planning_at.isoformat(),
            )
        )
    warm_incumbent_verified = _validated_exact_incumbent(warm_start, loaded_dataset)
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
        or args.matrix_batch_size < 1
        or args.matrix_workers < 1
        or args.cold_start_seed_seconds < 0
        or args.robust_car_buffer_minutes < 0
        or args.robust_transit_buffer_minutes < 0
        or args.robust_seconds_per_tier <= 0
        or args.robust_screening_wall_seconds <= 0
        or args.robust_materialization_wall_seconds <= 0
        or args.max_refinement_iterations < 1
        or args.refinement_query_budget < 1
        or args.refinement_wall_seconds <= 0
        or args.optimization_wall_seconds <= 0
        or args.departure_timing_wall_seconds <= 0
        or args.max_wall_seconds <= 0
        or args.lns_route_checks < 1
        or args.lns_beam_width < 1
        or args.lns_max_destroyed_jobs < 1
        or args.lns_max_engineers < 1
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
    screening = (
        args.screening_root.resolve()
        if args.screening_root is not None
        else run_dir / 'screening'
    )
    if args.screening_root is not None and not screening.is_dir():
        parser.error(f'Prebuilt screening root does not exist: {screening}')
    master = run_dir / f'{args.scenario}-screening-master.json'
    robust_master = run_dir / f'{args.scenario}-robust-screening-master.json'
    robust_exact = run_dir / f'{args.scenario}-robust-exact.json'
    exact = run_dir / f'{args.scenario}-exact.json'
    improved = run_dir / f'{args.scenario}-exact-improved.json'
    repaired = run_dir / f'{args.scenario}-exact-repaired.json'
    compacted = run_dir / f'{args.scenario}-exact-compacted.json'
    retimed = run_dir / f'{args.scenario}-exact-retimed.json'
    shared_cache_dir = (
        args.shared_cache_dir.resolve()
        if args.shared_cache_dir is not None
        else run_dir.parent / '.beego-cache'
    )
    cache = shared_cache_dir / 'routing-cache.sqlite3'
    screening_cache = shared_cache_dir / 'screening-cache.sqlite3'
    python = sys.executable
    robust_first_pass = warm_start is None and not args.skip_robust_first_pass
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
                *(['--rail-weekday-reference'] if args.rail_weekday_reference else []),
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
    commands.append(('routing_preflight', _command(
        python, '-m', 'beeline_routing.cli', 'preflight',
        '--dataset', dataset, '--scenario', args.scenario,
        '--transit-index', transit_index,
    )))
    if args.screening_root is None:
        commands.extend((
            ('build_surface_matrices', _command(
            python, ROOT / 'tools' / 'build_valhalla_screening_matrices.py',
            '--dataset', dataset, '--output', screening,
            '--endpoint', f'{args.valhalla_base_url}/sources_to_targets',
            '--route-endpoint', f'{args.valhalla_base_url}/route',
            '--cache', screening_cache,
            '--batch-size', args.matrix_batch_size,
            '--matrix-workers', args.matrix_workers,
            )),
            ('build_transit_matrices', _command(
                python, ROOT / 'tools' / 'build_local_transit_screening_matrix.py',
                '--dataset', dataset, '--transit-index', transit_index,
                '--walking-screening-root', screening, '--output', screening,
                '--cache', screening_cache,
            )),
        ))
    if robust_first_pass:
        commands.extend((
            ('solve_robust_screening_master', _command(
                python, ROOT / 'tools' / 'solve_screening_zones.py',
                '--dataset', dataset, '--scenario', args.scenario,
                '--screening-root', screening, '--output', robust_master,
                '--seconds-per-tier', args.robust_seconds_per_tier,
                '--search-workers', args.search_workers,
                '--zone-workers', args.zone_workers,
                '--adaptive-predecessors', args.adaptive_predecessors,
                '--cold-start-seed-seconds', 20,
                '--cold-start-improve-seconds', 0,
                '--coverage-first-only',
                '--car-travel-buffer-minutes', args.robust_car_buffer_minutes,
                '--transit-travel-buffer-minutes', args.robust_transit_buffer_minutes,
            )),
            ('materialize_robust_exact', _command(
                python, ROOT / 'tools' / 'materialize_exact_plan.py',
                '--dataset', dataset, '--scenario', args.scenario,
                '--master-solution', robust_master,
                '--cache', cache, '--transit-index', transit_index,
                '--output', robust_exact,
                '--provider', 'valhalla-local-transit',
                '--metro-wait-seconds', args.metro_wait_seconds,
                '--route-workers', args.route_workers,
                '--drop-order-infeasible', '--execute',
            )),
        ))
    commands.extend((
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
            '--cold-start-seed-seconds', args.cold_start_seed_seconds,
            '--cold-start-improve-seconds', 0,
            '--coverage-first-only',
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
            '--full-coverage-seconds', 20,
            '--seconds-per-tier', args.seconds_per_tier,
            '--search-workers', args.search_workers,
            '--zone-workers', args.zone_workers,
            '--adaptive-predecessors', args.adaptive_predecessors,
            '--route-workers', args.route_workers,
            '--execute',
        )),
    ))
    if not args.skip_route_conflict_refinement:
        commands[-1][1].append('--route-conflict-cut-on-schedule-failure')
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
        commands.append(('exact_chain_and_lns_repair', _command(
            python, ROOT / 'tools' / 'repair_exact_plan.py',
            '--dataset', dataset, '--scenario', args.scenario,
            '--input-plan', last_plan, '--cache', cache,
            '--transit-index', transit_index, '--output', repaired,
            '--screening-root', screening,
            '--max-route-checks', args.repair_route_checks,
            '--max-displacements', 4, '--max-passes', args.repair_passes,
            '--max-search-seconds-per-pass', 30,
            '--lns-route-checks', args.lns_route_checks,
            '--lns-beam-width', args.lns_beam_width,
            '--lns-max-destroyed-jobs', args.lns_max_destroyed_jobs,
            '--lns-max-engineers', args.lns_max_engineers,
            '--metro-wait-seconds', args.metro_wait_seconds,
            '--trust-input-validation', '--execute',
        )))
        if args.skip_exact_lns:
            commands[-1][1].append('--skip-exact-lns')
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
    if not args.skip_departure_timing:
        commands.append(('exact_departure_timing', _command(
            python, ROOT / 'tools' / 'retime_exact_plan.py',
            '--dataset', dataset, '--scenario', args.scenario,
            '--input-plan', last_plan, '--cache', cache,
            '--transit-index', transit_index, '--output', retimed,
            '--metro-wait-seconds', args.metro_wait_seconds,
            '--max-total-queries', 128,
            '--max-queries-per-leg', 8,
            '--execute',
        )))
        last_plan = retimed

    plan = {
        'artifact_type': 'NEW_DATASET_PIPELINE_PLAN',
        'dataset': str(dataset),
        'scenario': args.scenario,
        'planning_date': planning_date,
        'run_dir': str(run_dir),
        'transit_index': str(transit_index),
        'screening_root': str(screening),
        'screening_snapshot_reused': args.screening_root is not None,
        'shared_cache_dir': str(shared_cache_dir),
        'warm_start': str(warm_start) if warm_start else None,
        'warm_start_disabled': args.no_warm_start,
        'warm_start_auto_discovered': (
            not args.no_warm_start
            and args.warm_start is None
            and warm_start is not None
        ),
        'verified_warm_incumbent': str(warm_start) if warm_incumbent_verified else None,
        'max_wall_seconds': args.max_wall_seconds,
        'robust_first_pass': robust_first_pass,
        'robust_travel_buffers_minutes': {
            'CAR': args.robust_car_buffer_minutes,
            'PUBLIC_TRANSIT': args.robust_transit_buffer_minutes,
        } if robust_first_pass else None,
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
    stage_timings = []
    started_at = datetime.now(UTC)
    incumbent_copy = run_dir / f'{args.scenario}-verified-warm-incumbent.json'
    if warm_incumbent_verified:
        shutil.copy2(warm_start, incumbent_copy)
    current_plan: Path | None = incumbent_copy if warm_incumbent_verified else None
    incumbent_source: Path | None = warm_start if warm_incumbent_verified else None
    stable_cache_path: Path | None = None
    stable_cache_hit = False
    first_valid_plan: Path | None = current_plan
    first_valid_elapsed_seconds: float | None = (
        0.0 if warm_incumbent_verified else None
    )
    degraded_stages: list[str] = []
    pipeline_started = time.perf_counter()
    deadline = pipeline_started + args.max_wall_seconds
    valhalla_snapshot_configured = False
    planning_stages = {
        'materialize_robust_exact': robust_exact,
        'refine_materialize_validate': exact,
        'exact_direct_insertion_improvement': improved,
        'exact_chain_and_lns_repair': repaired,
        'exact_team_compaction': compacted,
        'exact_departure_timing': retimed,
    }
    for stage, command in commands:
        # Leave enough time to checksum outputs and return a validated incumbent.
        remaining = deadline - time.perf_counter() - 10
        if remaining <= 0:
            if current_plan is None or not _is_publishable_exact(current_plan):
                raise TimeoutError('Planning time limit expired before a validated plan was found')
            degraded_stages.append('global_time_limit')
            break
        if (
            stage not in {
                'ensure_local_valhalla', 'validate_dataset', 'routing_preflight',
            }
            and _reuse_verified_plan(
                current_plan, incumbent_copy, cache_hit=stable_cache_hit,
                warm_verified=warm_incumbent_verified,
                recompute=args.recompute_stable_plan,
            )
        ):
            stage_timings.append({
                'stage': stage,
                'duration_seconds': 0,
                'skipped': 'verified_stable_incumbent',
            })
            print(json.dumps({
                'event': 'STAGE_SKIPPED',
                'stage': stage,
                'reason': 'verified_stable_incumbent',
            }, ensure_ascii=False), flush=True)
            continue
        if (
            stage in {'solve_screening_master', 'refine_materialize_validate'}
            and current_plan is not None
            and current_plan == robust_exact
            and _is_publishable_full_coverage(current_plan)
        ):
            stage_timings.append({
                'stage': stage,
                'duration_seconds': 0,
                'skipped': 'robust_exact_full_coverage',
            })
            print(json.dumps({
                'event': 'STAGE_SKIPPED',
                'stage': stage,
                'reason': 'robust_exact_full_coverage',
            }, ensure_ascii=False), flush=True)
            continue
        if stage == 'materialize_robust_exact' and (
            not robust_master.is_file()
            or json.loads(robust_master.read_text(encoding='utf-8'))
            ['summary']['unserved_jobs'] > 0
        ):
            stage_timings.append({
                'stage': stage,
                'duration_seconds': 0,
                'skipped': 'robust_screening_incomplete',
            })
            continue
        if (
            stage == 'exact_team_compaction'
            and current_plan is not None
            and not _is_publishable_full_coverage(current_plan)
        ):
            stage_timings.append({
                'stage': stage,
                'duration_seconds': 0,
                'skipped': 'coverage_incomplete',
            })
            print(json.dumps({
                'event': 'STAGE_SKIPPED',
                'stage': stage,
                'reason': 'coverage_incomplete',
            }, ensure_ascii=False), flush=True)
            continue
        if (
            stage == 'exact_team_compaction'
            and current_plan == robust_exact
            and _is_publishable_full_coverage(current_plan)
        ):
            stage_timings.append({
                'stage': stage,
                'duration_seconds': 0,
                'skipped': 'robust_exact_full_coverage',
            })
            print(json.dumps({
                'event': 'STAGE_SKIPPED',
                'stage': stage,
                'reason': 'robust_exact_full_coverage',
            }, ensure_ascii=False), flush=True)
            continue
        if (
            not valhalla_snapshot_configured
            and stage in {
                'build_surface_matrices', 'materialize_robust_exact',
                'refine_materialize_validate',
            }
        ):
            _configure_valhalla_snapshot(environment, args.valhalla_base_url)
            valhalla_snapshot_configured = True
        if (
            stage in {'exact_direct_insertion_improvement', 'exact_chain_and_lns_repair'}
            and current_plan is not None
            and _is_publishable_full_coverage(current_plan)
        ):
            stage_timings.append({
                'stage': stage,
                'duration_seconds': 0,
                'skipped': 'exact_full_coverage_already_valid',
            })
            print(json.dumps({
                'event': 'STAGE_SKIPPED',
                'stage': stage,
                'reason': 'exact_full_coverage_already_valid',
            }, ensure_ascii=False), flush=True)
            continue
        if current_plan is not None and '--input-plan' in command:
            command = command.copy()
            command[command.index('--input-plan') + 1] = str(current_plan)
        print(json.dumps({'event': 'STAGE_START', 'stage': stage}, ensure_ascii=False), flush=True)
        stage_started_at = datetime.now(UTC)
        stage_started = time.perf_counter()
        fallback_reason = None
        try:
            stage_limit = (
                args.refinement_wall_seconds
                if stage == 'refine_materialize_validate'
                else args.robust_screening_wall_seconds
                if stage == 'solve_robust_screening_master'
                else args.robust_materialization_wall_seconds
                if stage == 'materialize_robust_exact'
                else args.optimization_wall_seconds
                if stage in {
                    'exact_direct_insertion_improvement',
                    'exact_chain_and_lns_repair',
                    'exact_team_compaction',
                }
                else args.departure_timing_wall_seconds
                if stage == 'exact_departure_timing'
                else None
            )
            subprocess.run(
                command, cwd=ROOT, env=environment, check=True,
                timeout=min(remaining, stage_limit) if stage_limit else remaining,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            if stage in {'solve_robust_screening_master', 'materialize_robust_exact'}:
                degraded_stages.append(stage)
                stage_timings.append({
                    'stage': stage,
                    'duration_seconds': round(time.perf_counter() - stage_started, 3),
                    'failed': True,
                    'fallback': 'nominal_screening',
                })
                print(json.dumps({
                    'event': 'ROBUST_FIRST_PASS_FALLBACK',
                    'stage': stage,
                }, ensure_ascii=False), flush=True)
                continue
            if stage == 'refine_materialize_validate':
                fallback_reason = (
                    'time_limit' if isinstance(error, subprocess.TimeoutExpired)
                    else 'refinement_not_publishable'
                )
                fallback_candidate = _refinement_fallback_candidate(
                    exact,
                    master,
                    run_dir / f'{args.scenario}-refinement-fallback-candidate.json',
                    loaded_dataset.dataset_sha256,
                )
                fallback_output = run_dir / f'{args.scenario}-exact-fallback.json'
                fallback_remaining = deadline - time.perf_counter() - 10
                if fallback_remaining <= 0:
                    raise TimeoutError('Planning time limit expired before fallback validation')
                subprocess.run(_command(
                    python, ROOT / 'tools' / 'materialize_exact_plan.py',
                    '--dataset', dataset, '--scenario', args.scenario,
                    '--master-solution', fallback_candidate,
                    '--cache', cache, '--transit-index', transit_index,
                    '--output', fallback_output,
                    '--provider', 'valhalla-local-transit',
                    '--metro-wait-seconds', args.metro_wait_seconds,
                    '--route-workers', args.route_workers,
                    '--drop-order-infeasible', '--execute',
                ), cwd=ROOT, env=environment, check=True,
                    timeout=fallback_remaining)
                if not _is_publishable_exact(fallback_output):
                    raise RuntimeError('Exact refinement fallback failed validation')
                planning_stages[stage] = fallback_output
                degraded_stages.append(stage)
                print(json.dumps({
                    'event': 'REFINEMENT_FALLBACK',
                    'reason': fallback_reason,
                    'candidate': str(fallback_candidate),
                    'validated_plan': str(fallback_output),
                }, ensure_ascii=False), flush=True)
            elif (
                stage not in {
                    'exact_direct_insertion_improvement',
                    'exact_chain_and_lns_repair',
                    'exact_team_compaction',
                    'exact_departure_timing',
                }
                or current_plan is None
                or not _is_publishable_exact(current_plan)
            ):
                raise
            else:
                checkpoint = planning_stages[stage]
                if checkpoint.is_file() and _is_publishable_exact(checkpoint):
                    current_plan = _choose_exact_plan(
                        current_plan, checkpoint,
                        retimed=stage == 'exact_departure_timing',
                    )
                    reason = (
                        'time_limit'
                        if isinstance(error, subprocess.TimeoutExpired)
                        else 'stage_error'
                    )
                    degraded_stages.append(stage)
                    stage_timings.append({
                        'stage': stage,
                        'duration_seconds': round(time.perf_counter() - stage_started, 3),
                        'interrupted': reason,
                        'recovered_plan': str(checkpoint),
                    })
                    print(json.dumps({
                        'event': 'OPTIMIZATION_CHECKPOINT_RECOVERED',
                        'stage': stage,
                        'reason': reason,
                        'plan': str(checkpoint),
                        'unserved_jobs': len(
                            json.loads(checkpoint.read_text(encoding='utf-8'))
                            ['plan']['unserved_job_ids']
                        ),
                    }, ensure_ascii=False), flush=True)
                    continue
                degraded_stages.append(stage)
                stage_timings.append({
                    'stage': stage,
                    'duration_seconds': round(time.perf_counter() - stage_started, 3),
                    'failed': True,
                    'fallback_plan': str(current_plan),
                })
                print(json.dumps({
                    'event': 'OPTIMIZATION_FAILED_FALLBACK',
                    'stage': stage,
                    'fallback_plan': str(current_plan),
                }, ensure_ascii=False), flush=True)
                continue
        if stage == 'ensure_local_valhalla':
            _configure_valhalla_snapshot(environment, args.valhalla_base_url)
            valhalla_snapshot_configured = True
        duration_seconds = time.perf_counter() - stage_started
        completed_stages.append(stage)
        stage_timings.append({
            'stage': stage,
            'started_at': stage_started_at.isoformat(),
            'duration_seconds': round(duration_seconds, 3),
            **({'fallback_reason': fallback_reason} if fallback_reason else {}),
        })
        if stage == 'routing_preflight' and args.stable_plan_cache_dir is not None:
            if not valhalla_snapshot_configured:
                _configure_valhalla_snapshot(environment, args.valhalla_base_url)
                valhalla_snapshot_configured = True
            cache_key = _stable_plan_cache_key(
                loaded_dataset.dataset_sha256, args.scenario, transit_index,
                environment, args.metro_wait_seconds,
            )
            stable_cache_path = args.stable_plan_cache_dir.resolve() / f'{cache_key}.json'
            if (
                stable_cache_path.is_file()
                and _validated_exact_incumbent(stable_cache_path, loaded_dataset)
                and (
                    current_plan is None
                    or _exact_quality_key(stable_cache_path)
                    <= _exact_quality_key(current_plan)
                )
            ):
                shutil.copy2(stable_cache_path, incumbent_copy)
                current_plan = incumbent_copy
                incumbent_source = stable_cache_path
                first_valid_plan = incumbent_copy
                first_valid_elapsed_seconds = round(
                    time.perf_counter() - pipeline_started, 3
                )
                stable_cache_hit = True
                print(json.dumps({
                    'event': 'VERIFIED_PLAN_CACHE_HIT',
                    'source': str(stable_cache_path),
                    'coverage_complete': _is_publishable_full_coverage(incumbent_copy),
                }, ensure_ascii=False), flush=True)
        if stage in planning_stages:
            candidate_plan = planning_stages[stage]
            if candidate_plan.is_file() and _is_publishable_exact(candidate_plan):
                selected_plan = _choose_exact_plan(
                    current_plan, candidate_plan,
                    retimed=stage == 'exact_departure_timing',
                )
                if selected_plan != candidate_plan:
                    print(json.dumps({
                        'event': 'EXACT_CANDIDATE_NOT_SELECTED',
                        'stage': stage,
                        'candidate': str(candidate_plan),
                        'kept': str(selected_plan),
                        'candidate_quality': _exact_quality_key(candidate_plan),
                        'kept_quality': _exact_quality_key(selected_plan),
                    }, ensure_ascii=False), flush=True)
                current_plan = selected_plan
                payload = json.loads(current_plan.read_text(encoding='utf-8'))
                if (
                    first_valid_plan is None
                    and payload.get('status') == 'EXACT_VALID'
                    and payload.get('publication_allowed') is True
                ):
                    first_valid_plan = current_plan
                    first_valid_elapsed_seconds = round(
                        time.perf_counter() - pipeline_started, 3
                    )
                    print(json.dumps({
                        'event': 'FIRST_VALID_PLAN',
                        'path': str(first_valid_plan),
                        'coverage_complete': not payload['plan']['unserved_job_ids'],
                        'elapsed_seconds': first_valid_elapsed_seconds,
                    }, ensure_ascii=False), flush=True)
        print(json.dumps({
            'event': 'STAGE_COMPLETE',
            'stage': stage,
            'duration_seconds': round(duration_seconds, 3),
        }, ensure_ascii=False), flush=True)
    output_files = []
    for path in sorted(run_dir.rglob('*')):
        if path.is_file() and path.name != 'pipeline-run.json':
            output_files.append({
                'path': path.relative_to(run_dir).as_posix(),
                'size_bytes': path.stat().st_size,
                'sha256': _sha256(path),
            })
    if current_plan is None:
        raise RuntimeError('Pipeline finished without a planning artifact')
    final_payload = json.loads(current_plan.read_text(encoding='utf-8'))
    unserved_jobs = tuple(final_payload.get('plan', {}).get('unserved_job_ids', ()))
    coverage_complete = not unserved_jobs
    publication_allowed = final_payload.get('publication_allowed') is True
    if (
        stable_cache_path is not None
        and publication_allowed
        and (current_plan != incumbent_copy or stable_cache_hit)
    ):
        replace_cache = (
            not stable_cache_path.is_file()
            or not _validated_exact_incumbent(stable_cache_path, loaded_dataset)
            or _exact_quality_key(current_plan) < _exact_quality_key(stable_cache_path)
        )
        if replace_cache:
            stable_cache_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = stable_cache_path.with_suffix('.json.tmp')
            shutil.copy2(current_plan, temporary)
            temporary.replace(stable_cache_path)
    run_payload = {
        **plan,
        'status': 'COMPLETE' if publication_allowed else 'FAILED_VALIDATION',
        'started_at': started_at.isoformat(),
        'completed_at': datetime.now(UTC).isoformat(),
        'completed_stages': completed_stages,
        'stage_timings': stage_timings,
        'first_valid_plan': str(first_valid_plan) if first_valid_plan else None,
        'first_valid_elapsed_seconds': first_valid_elapsed_seconds,
        'degraded_stages': degraded_stages,
        'reused_verified_incumbent': (
            str(incumbent_source) if current_plan == incumbent_copy else None
        ),
        'stable_plan_cache_path': str(stable_cache_path) if stable_cache_path else None,
        'stable_plan_cache_hit': stable_cache_hit,
        'output_files': output_files,
        'coverage_complete': coverage_complete,
        'unserved_job_ids': list(unserved_jobs),
        'publishable_final_plan': str(current_plan) if publication_allowed else None,
        'candidate_plan': str(current_plan),
    }
    run_payload['content_sha256'] = payload_sha256(run_payload)
    write_json_atomic(run_dir / 'pipeline-run.json', run_payload)
    print(json.dumps({
        'status': run_payload['status'],
        'final_plan': str(current_plan) if publication_allowed else None,
        'candidate_plan': str(current_plan),
        'coverage_complete': coverage_complete,
        'degraded_stages': degraded_stages,
        'unserved_jobs': len(unserved_jobs),
        'run_manifest': str(run_dir / 'pipeline-run.json'),
    }, ensure_ascii=False), flush=True)
    return 0 if publication_allowed else 2


if __name__ == '__main__':
    raise SystemExit(main())
