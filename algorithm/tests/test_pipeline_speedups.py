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

sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))

from beeline_routing.models import Coordinate
from beeline_routing.screening_cache import ScreeningCache
from tools.build_valhalla_screening_matrices import missing_matrix_requests
from tools import build_valhalla_screening_matrices as matrix_builder
from tools.run_new_dataset_pipeline import (
    _is_publishable_exact,
    _is_publishable_full_coverage,
)


class ScreeningSpeedupTests(unittest.TestCase):
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
            async def query(self, _line: bytes) -> bytes:
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

        request = SimpleNamespace(json=payload)
        calls = [asyncio.create_task(bridge.route(request)) for _ in range(2)]
        try:
            await asyncio.wait_for(both_entered.wait(), timeout=1)
            self.assertEqual(entered, 2)
        finally:
            release.set()
            await asyncio.gather(*calls)


if __name__ == '__main__':
    unittest.main()
