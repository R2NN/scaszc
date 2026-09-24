from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / 'algorithm' / 'tools'))
sys.path.insert(0, str(ROOT / 'algorithm' / 'src'))

from beeline_planning import load_planning_dataset  # noqa: E402
from prepare_history_day import prepare  # noqa: E402
from run_history_batch import plan_metrics  # noqa: E402


class HistoryBatchTests(unittest.TestCase):
    def test_weekend_workload_is_retimed_and_strictly_loadable(self) -> None:
        source = ROOT / 'algorithm' / 'work' / 'dataset_v21' / 'beeline_synthetic_dataset_v2_1'
        history = ROOT / 'site' / 'public' / 'data' / 'analytics-history.json'
        with tempfile.TemporaryDirectory() as temporary:
            dataset = Path(temporary) / 'day' / 'dataset'
            provenance = prepare(source, history, '2026-08-16', dataset)
            loaded = load_planning_dataset(dataset, 'core')
            self.assertEqual(provenance['routing_date'], '2026-08-16')
            self.assertEqual(loaded.planning_date, '2026-08-16')
            self.assertEqual(len(loaded.jobs), 147)
            self.assertFalse((dataset / 'validation_report.json').exists())
            self.assertFalse((dataset / 'audit.csv').exists())
            context = json.loads((dataset / 'common' / 'planning_context.json').read_text(encoding='utf-8'))
            self.assertEqual(context['day_type'], 'WEEKEND')

    def test_published_plan_metrics_reject_wrong_job_count(self) -> None:
        plan = ROOT / 'algorithm' / 'artifacts' / 'current' / 'initial-exact-205-of-205-retimed.json'
        self.assertEqual(plan_metrics(plan, 205)['assigned'], 205)
        with self.assertRaises(ValueError):
            plan_metrics(plan, 204)


if __name__ == '__main__':
    unittest.main()
