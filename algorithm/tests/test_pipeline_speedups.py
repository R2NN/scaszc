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
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))

from beeline_routing.models import Coordinate
from beeline_routing.screening_cache import ScreeningCache
from beeline_planning import load_planning_dataset
from beeline_routing.export import payload_sha256
from tools.build_valhalla_screening_matrices import missing_matrix_requests
from tools import build_valhalla_screening_matrices as matrix_builder
from tools.run_new_dataset_pipeline import (
    _is_publishable_exact,
    _is_publishable_full_coverage,
    _refinement_fallback_candidate,
)
from tools.solve_screening_zones import _read_warm_orders


class ScreeningSpeedupTests(unittest.TestCase):
    def test_exact_warm_start_is_protected_only_in_its_valid_scenario(self) -> None:
        root = Path(__file__).parents[2]
        dataset_root = root / 'data' / 'dataset'
        exact = (
            root / 'algorithm' / 'artifacts' / 'current'
            / 'exact-205-of-205-28-teams-clean-automatic.json'
        )
        core = load_planning_dataset(dataset_root, 'core')
        stress = load_planning_dataset(dataset_root, 'stress')
        self.assertTrue(_read_warm_orders(exact, core)[1])
        self.assertEqual(_read_warm_orders(exact, stress), ({}, False))

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
