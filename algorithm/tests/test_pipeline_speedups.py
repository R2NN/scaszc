from __future__ import annotations

import asyncio
import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from datetime import UTC, datetime
from datetime import timedelta
from types import MappingProxyType
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))

from beeline_routing.models import Coordinate, TransportMode
from beeline_routing.screening_cache import ScreeningCache
from beeline_planning import load_planning_dataset
from beeline_planning.eligibility import CandidateIndex
from beeline_planning.master import MasterArc, MasterModelInput
from beeline_planning.solver import (
    MasterEngineerRoute,
    MasterSolution,
    MasterSolveStatus,
)
from beeline_routing.export import payload_sha256
from tools.build_valhalla_screening_matrices import missing_matrix_requests
from tools import build_valhalla_screening_matrices as matrix_builder
from tools.run_new_dataset_pipeline import (
    _choose_exact_plan,
    _discover_exact_incumbent,
    _is_publishable_exact,
    _is_publishable_full_coverage,
    _refinement_fallback_candidate,
    _stable_plan_cache_key,
    _reuse_verified_plan,
    _validated_exact_incumbent,
)
from tools.promote_best_history_plans import best_saved_plan
from tools.solve_screening_zones import _read_warm_orders, _with_travel_buffers
from tools import refine_screening_exact as exact_refiner


class ScreeningSpeedupTests(unittest.TestCase):
    def test_only_full_warm_plan_or_explicit_cache_hit_skips_search(self) -> None:
        artifacts = Path(__file__).parents[1] / 'artifacts' / 'current'
        complete = artifacts / 'initial-exact-205-of-205-retimed.json'
        partial = artifacts / 'initial-exact-204-of-205.json'
        self.assertTrue(_reuse_verified_plan(
            complete, complete, cache_hit=False, warm_verified=True,
            recompute=False,
        ))
        self.assertFalse(_reuse_verified_plan(
            partial, partial, cache_hit=False, warm_verified=True,
            recompute=False,
        ))
        self.assertTrue(_reuse_verified_plan(
            partial, partial, cache_hit=True, warm_verified=False,
            recompute=False,
        ))
        self.assertFalse(_reuse_verified_plan(
            complete, complete, cache_hit=True, warm_verified=True,
            recompute=True,
        ))

    def test_stable_plan_cache_tracks_routing_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            index = Path(directory) / 'transit.sqlite'
            index.write_bytes(b'first timetable')
            routing = {
                'VALHALLA_TILE_REVISION': 'tiles-1',
                'VALHALLA_RUNTIME_REVISION': 'local-1',
            }
            first = _stable_plan_cache_key('dataset-1', 'core', index, routing, 180)
            self.assertEqual(
                first, _stable_plan_cache_key('dataset-1', 'core', index, routing, 180),
            )
            self.assertNotEqual(
                first, _stable_plan_cache_key(
                    'dataset-1', 'core', index,
                    {**routing, 'VALHALLA_TILE_REVISION': 'tiles-2'}, 180,
                ),
            )
            index.write_bytes(b'changed timetable')
            self.assertNotEqual(
                first, _stable_plan_cache_key('dataset-1', 'core', index, routing, 180),
            )

    def test_travel_buffers_affect_only_moving_car_and_transit_arcs(self) -> None:
        moment = datetime(2026, 8, 17, 7, tzinfo=UTC)
        arcs = tuple(
            MasterArc('E', 'START:E', 'O', f'J{i}', f'L{i}', duration, 1000,
                      mode, False)
            for i, (duration, mode) in enumerate((
                (20, TransportMode.CAR),
                (0, TransportMode.CAR),
                (30, TransportMode.PUBLIC_TRANSIT),
                (15, TransportMode.WALKING),
            ))
        )
        master = MasterModelInput(moment, None, arcs, (), 'screening')

        buffered = _with_travel_buffers(master, 6, 12)

        self.assertEqual(
            [arc.screening_duration_minutes for arc in buffered.arcs],
            [26, 0, 42, 15],
        )
        self.assertEqual(
            [arc.screening_is_surrogate for arc in buffered.arcs],
            [True, False, True, False],
        )
        self.assertEqual(master.arcs[0].screening_duration_minutes, 20)

    def test_exact_neighbourhood_uses_current_failure_and_is_bounded(self) -> None:
        moment = datetime(2026, 8, 15, 8, tzinfo=UTC)
        dataset = SimpleNamespace(
            jobs={
                job_id: SimpleNamespace(
                    zone_id='Z',
                    window_start=moment + timedelta(minutes=start),
                    window_end=moment + timedelta(minutes=end),
                )
                for job_id, start, end in (
                    ('previous', 0, 30),
                    ('failed', 30, 60),
                    ('near', 60, 90),
                    ('far', 300, 330),
                )
            },
            engineers={'E': SimpleNamespace(zone_id='Z')},
        )
        failure = SimpleNamespace(
            zone_id='Z', origin_node_id='previous', destination_job_id='failed'
        )
        result = exact_refiner._mutable_jobs_for_conflicts(
            dataset, 'Z', {(('E', 'far'),)}, (failure,), max_jobs=3
        )
        self.assertEqual(result, frozenset({'previous', 'failed', 'near'}))

    def test_exact_local_solve_freezes_untouched_routes(self) -> None:
        moment = datetime(2026, 8, 15, 8, tzinfo=UTC)
        dataset = SimpleNamespace(
            jobs={job_id: SimpleNamespace(zone_id='Z') for job_id in 'ACD'},
            engineers={engineer_id: SimpleNamespace(zone_id='Z') for engineer_id in ('E1', 'E2')},
        )
        candidate_index = CandidateIndex(
            planning_at=moment,
            active_job_ids=('A', 'C', 'D'),
            eligible_engineers_by_job=MappingProxyType({
                'A': ('E1', 'E2'), 'C': ('E2',), 'D': ('E2',),
            }),
            rejection_codes=MappingProxyType({}),
        )
        master = MasterModelInput(moment, candidate_index, (), (), 'screening')
        candidate = MasterSolution(
            status=MasterSolveStatus.SCREENING_FEASIBLE,
            planning_at=moment,
            routes=(
                MasterEngineerRoute('E1', (SimpleNamespace(job_id='A'),)),
                MasterEngineerRoute('E2', (
                    SimpleNamespace(job_id='C'), SimpleNamespace(job_id='D')
                )),
            ),
            unserved_job_ids=(),
            objective_proofs=(),
            dataset_sha256='dataset',
            screening_snapshot_sha256='screening',
            solver_version='test',
            search_graph_complete=True,
            searched_arc_count=0,
            operationally_excluded_arcs=(),
        )
        context = exact_refiner._ZoneMasterContext(dataset, master, {})
        with patch.object(
            exact_refiner, 'solve_screening_master', return_value=candidate
        ) as solve:
            exact_refiner._solve_refined_zone(
                dataset, None, candidate, 'Z', set(), {}, (8,), 1, 1,
                mutable_job_ids=frozenset({'A', 'FUTURE'}),
                zone_cache=SimpleNamespace(get=lambda _zone: context),
            )
        configured_master = solve.call_args.args[1]
        config = solve.call_args.args[2]
        self.assertIn(('E2', 'C'), configured_master.hard_assignments)
        self.assertIn(('E2', 'D'), configured_master.hard_assignments)
        self.assertEqual(
            configured_master.candidate_index.eligible_engineers_by_job['A'],
            ('E1',),
        )
        self.assertEqual(
            configured_master.candidate_index.eligible_engineers_by_job['C'],
            ('E2',),
        )
        self.assertIn(('E2', 'START:E2', 'C'), config.required_arcs)
        self.assertIn(('E2', 'C', 'D'), config.required_arcs)
        self.assertNotIn(('E2', 'A'), config.forbidden_assignments)

    def test_exact_warm_start_is_protected_only_in_its_valid_scenario(self) -> None:
        root = Path(__file__).parents[2]
        dataset_root = root / 'data' / 'dataset'
        exact = (
            root / 'algorithm' / 'artifacts' / 'current'
            / 'initial-exact-205-of-205-retimed.json'
        )
        core = load_planning_dataset(dataset_root, 'core')
        stress = load_planning_dataset(dataset_root, 'stress')
        self.assertTrue(_read_warm_orders(exact, core)[1])
        self.assertEqual(_read_warm_orders(exact, stress), ({}, False))
        self.assertTrue(_validated_exact_incumbent(exact, core))
        self.assertFalse(_validated_exact_incumbent(exact, stress))
        selected = _discover_exact_incumbent(
            core.dataset_sha256, core.initial_planning_at.isoformat(),
        )
        self.assertEqual(selected.name, 'initial-exact-205-of-205-retimed.json')

    def test_bulk_cache_reuses_coordinates_when_ids_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = ScreeningCache(Path(directory) / 'screening.sqlite3')
            first = Coordinate('old-a', 55.75, 37.61)
            second = Coordinate('old-b', 55.76, 37.62)
            cache.put_surfaces('tiles-1', 'WALKING', [(first, second, 120, 800)])
            renamed = [
                Coordinate('new-a', 55.75, 37.61),
                Coordinate('new-b', 55.76, 37.62),
            ]
            self.assertEqual(
                cache.get_surfaces('tiles-1', 'WALKING', renamed),
                {(0, 1): (120, 800)},
            )
            self.assertEqual(cache.get_surfaces('tiles-2', 'WALKING', renamed), {})

    def test_delta_matrix_asks_only_for_new_row_and_column(self) -> None:
        cold = missing_matrix_requests(4, 4, set())
        self.assertEqual(cold, [([0, 1, 2, 3], [0, 1, 2, 3])])
        cached = {(origin, destination) for origin in range(3) for destination in range(3)}
        delta = missing_matrix_requests(4, 4, cached)
        requested = {
            (origin, destination)
            for sources, targets in delta
            for origin in sources
            for destination in targets
        }
        self.assertEqual(requested, {
            (origin, destination)
            for origin in range(4)
            for destination in range(4)
            if origin == 3 or destination == 3
        })

    def test_first_valid_plan_requires_exact_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'plan.json'
            payload = {
                'status': 'EXACT_VALID',
                'publication_allowed': True,
                'plan': {'unserved_job_ids': []},
                'validation': {'status': 'VALID'},
            }
            path.write_text(json.dumps(payload), encoding='utf-8')
            self.assertTrue(_is_publishable_full_coverage(path))
            payload['plan']['unserved_job_ids'] = ['job-1']
            path.write_text(json.dumps(payload), encoding='utf-8')
            self.assertFalse(_is_publishable_full_coverage(path))
            self.assertTrue(_is_publishable_exact(path))

    def test_exact_pipeline_keeps_urgent_coverage_across_stages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def plan(name: str, urgent: int, normal: int, engineers: int) -> Path:
                path = root / name
                payload = {
                    'status': 'EXACT_VALID',
                    'publication_allowed': True,
                    'plan': {'unserved_job_ids': ['job'] * (urgent + normal)},
                    'validation': {
                        'status': 'VALID',
                        'metrics': {
                            'unserved_urgent_jobs': urgent,
                            'unserved_normal_jobs': normal,
                            'used_engineers': engineers,
                            'total_distance_m': 1000,
                            'total_travel_minutes': 20,
                        },
                    },
                }
                path.write_text(json.dumps(payload), encoding='utf-8')
                return path

            robust = plan('robust.json', 0, 2, 28)
            fallback = plan('fallback.json', 1, 3, 23)
            retimed = plan('retimed.json', 0, 2, 28)
            self.assertEqual(_choose_exact_plan(robust, fallback), robust)
            self.assertEqual(_choose_exact_plan(robust, retimed, retimed=True), retimed)
            self.assertEqual(_choose_exact_plan(None, robust), robust)

    def test_history_promotion_rejects_tampered_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset_hash = 'd' * 64

            def plan(name: str, urgent: int) -> tuple[Path, dict]:
                path = root / name
                artifact = {
                    'status': 'EXACT_VALID', 'publication_allowed': True,
                    'dataset_sha256': dataset_hash,
                    'validation': {'status': 'VALID', 'metrics': {
                        'unserved_urgent_jobs': urgent,
                        'unserved_normal_jobs': 2,
                        'used_engineers': 3,
                        'total_distance_m': 100,
                        'total_travel_minutes': 10,
                    }},
                }
                artifact['content_sha256'] = payload_sha256(artifact)
                path.write_text(json.dumps(artifact), encoding='utf-8')
                return path, artifact

            current, original = plan('core-exact-retimed.json', 1)
            better, _ = plan('core-robust-exact.json', 0)
            status = {'final_plan': str(current), 'dataset_sha256': dataset_hash,
                      'artifact_sha256': original['content_sha256']}
            self.assertEqual(best_saved_plan(status)[0], better)
            tampered = json.loads(better.read_text(encoding='utf-8'))
            tampered['validation']['metrics']['unserved_urgent_jobs'] = 0
            tampered['validation']['metrics']['unserved_normal_jobs'] = 0
            better.write_text(json.dumps(tampered), encoding='utf-8')
            self.assertIsNone(best_saved_plan(status))

    def test_refinement_fallback_uses_verified_latest_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            master = root / 'master.json'
            checkpoint = root / 'checkpoint.json'
            output = root / 'candidate.json'
            self.assertEqual(
                _refinement_fallback_candidate(checkpoint, master, output, 'd' * 64),
                master,
            )
            candidate = {
                'artifact_type': 'SCREENING_MASTER_SOLUTION',
                'dataset_sha256': 'd' * 64,
            }
            state = {
                'artifact_type': 'EXACT_REFINEMENT_LOOP_CHECKPOINT',
                'dataset_sha256': 'd' * 64,
                'latest_candidate': candidate,
            }
            state['content_sha256'] = payload_sha256(state)
            checkpoint.write_text(json.dumps(state), encoding='utf-8')
            self.assertEqual(
                _refinement_fallback_candidate(checkpoint, master, output, 'd' * 64),
                output,
            )
            saved = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(saved.pop('content_sha256'), payload_sha256(saved))
            state['content_sha256'] = 'invalid'
            checkpoint.write_text(json.dumps(state), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                _refinement_fallback_candidate(checkpoint, master, output, 'd' * 64)

    def test_matrix_builder_uses_cache_on_second_day(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / 'dataset'
            dataset.mkdir()
            (dataset / 'manifest.json').write_text(
                json.dumps({'dataset_version': '2.1.0'}), encoding='utf-8'
            )
            points = [
                Coordinate('a', 55.75, 37.61),
                Coordinate('b', 55.76, 37.62),
            ]
            requests = []

            def fake_matrix(_endpoint, sources, targets, _costing, _timeout):
                requests.append((len(sources), len(targets)))
                return [
                    [{'time': 120, 'distance': 0.8} for _ in targets]
                    for _ in sources
                ]

            args = argparse.Namespace(
                dataset=dataset, output=root / 'output',
                cache=root / 'cache.sqlite3', tile_revision='tiles-1',
                route_endpoint='http://local/route',
                endpoint='http://local/sources_to_targets',
                batch_size=25, matrix_workers=3, fallback_workers=3,
                timeout_seconds=1,
            )
            with patch.object(
                matrix_builder, 'union_locations',
                return_value=({'ZONE': points}, datetime(2026, 8, 17, tzinfo=UTC)),
            ), patch.object(matrix_builder, 'request_matrix', side_effect=fake_matrix):
                self.assertEqual(matrix_builder.build(args), 0)
                self.assertEqual(len(requests), 3)
                requests.clear()
                self.assertEqual(matrix_builder.build(args), 0)
                self.assertEqual(requests, [])

    def test_matrix_builder_splits_timed_out_block(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / 'dataset'
            dataset.mkdir()
            (dataset / 'manifest.json').write_text(
                json.dumps({'dataset_version': '2.1.0'}), encoding='utf-8'
            )
            points = [
                Coordinate(str(index), 55.75 + index / 100, 37.61)
                for index in range(4)
            ]
            request_sizes = []

            def fake_matrix(_endpoint, sources, targets, _costing, _timeout):
                request_sizes.append(len(sources) * len(targets))
                if len(sources) * len(targets) > 8:
                    raise TimeoutError('large block timed out')
                return [
                    [{'time': 120, 'distance': 0.8} for _ in targets]
                    for _ in sources
                ]

            args = argparse.Namespace(
                dataset=dataset, output=root / 'output', cache=None,
                tile_revision=None, route_endpoint='http://local/route',
                endpoint='http://local/sources_to_targets', batch_size=4,
                matrix_workers=1, fallback_workers=1, timeout_seconds=1,
            )
            with patch.object(
                matrix_builder, 'union_locations',
                return_value=({'ZONE': points}, datetime(2026, 8, 17, tzinfo=UTC)),
            ), patch.object(matrix_builder, 'request_matrix', side_effect=fake_matrix), patch.object(
                matrix_builder, 'request_route', side_effect=AssertionError('unexpected route fallback')
            ):
                self.assertEqual(matrix_builder.build(args), 0)
            self.assertEqual(request_sizes.count(16), 3)
            self.assertEqual(request_sizes.count(8), 6)

    def test_matrix_builder_retries_busy_service_without_splitting(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dataset = root / 'dataset'
            dataset.mkdir()
            (dataset / 'manifest.json').write_text(
                json.dumps({'dataset_version': '2.1.0'}), encoding='utf-8'
            )
            points = [Coordinate('a', 55.75, 37.61), Coordinate('b', 55.76, 37.62)]
            attempts = {}

            def fake_matrix(_endpoint, sources, targets, costing, _timeout):
                attempts[costing] = attempts.get(costing, 0) + 1
                self.assertEqual((len(sources), len(targets)), (2, 2))
                if attempts[costing] == 1:
                    raise HTTPError('http://local', 503, 'busy', None, None)
                return [
                    [{'time': 120, 'distance': 0.8} for _ in targets]
                    for _ in sources
                ]

            args = argparse.Namespace(
                dataset=dataset, output=root / 'output', cache=None,
                tile_revision=None, route_endpoint='http://local/route',
                endpoint='http://local/sources_to_targets', batch_size=2,
                matrix_workers=1, fallback_workers=1, timeout_seconds=1,
            )
            with patch.object(
                matrix_builder, 'union_locations',
                return_value=({'ZONE': points}, datetime(2026, 8, 17, tzinfo=UTC)),
            ), patch.object(matrix_builder, 'request_matrix', side_effect=fake_matrix), patch.object(
                matrix_builder.time, 'sleep'
            ), patch.object(
                matrix_builder, 'request_route', side_effect=AssertionError('unexpected route fallback')
            ):
                self.assertEqual(matrix_builder.build(args), 0)
            self.assertEqual(attempts, {'auto': 2, 'bicycle': 2, 'pedestrian': 2})


class ValhallaBridgePoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_requests_enter_independent_workers(self) -> None:
        bridge_path = Path(__file__).parents[2] / 'runtime' / 'valhalla_bridge.py'
        spec = importlib.util.spec_from_file_location('test_valhalla_bridge', bridge_path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        bridge = module.ValhallaBridge(2)
        entered = 0
        both_entered = asyncio.Event()
        release = asyncio.Event()

        class FakeWorker:
            async def query(self, _line: bytes, *, timeout_seconds: float) -> bytes:
                nonlocal entered
                entered += 1
                if entered == 2:
                    both_entered.set()
                await release.wait()
                return b'{"trip": {}}'

        bridge.workers = [FakeWorker(), FakeWorker()]
        for worker in bridge.workers:
            bridge.available.put_nowait(worker)

        async def payload() -> dict[str, object]:
            return {'costing': 'pedestrian'}

        request = SimpleNamespace(json=payload, path='/route')
        calls = [asyncio.create_task(bridge.route(request)) for _ in range(2)]
        try:
            await asyncio.wait_for(both_entered.wait(), timeout=1)
            self.assertEqual(entered, 2)
        finally:
            release.set()
            await asyncio.gather(*calls)


if __name__ == '__main__':
    unittest.main()
