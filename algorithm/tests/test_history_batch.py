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
from run_history_batch import plan_metrics, rail_reference, rail_weekday_override_required  # noqa: E402


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

    def test_monday_reference_uses_its_declared_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary) / 'base'
            cache = Path(temporary) / 'dates'
            sunday = cache / '2026-09-27'
            base.mkdir()
            sunday.mkdir(parents=True)
            (base / 'manifest.json').write_text(json.dumps({
                'normal_weekday_reference_date': '2026-09-21',
            }), encoding='utf-8')
            (base / 'rail_schedule.json').write_text('{}', encoding='utf-8')
            (sunday / 'manifest.json').write_text(json.dumps({
                'schedule_scope': 'exact_date', 'source_date': '2026-09-27',
                'coverage_complete': True,
            }), encoding='utf-8')
            (sunday / 'rail_schedule.json').write_text('{}', encoding='utf-8')
            (sunday / 'rail_station_map.json').write_text('{}', encoding='utf-8')
            selected, source_date = rail_reference('2026-08-10', cache, base)
            self.assertEqual(selected, base)
            self.assertEqual(source_date, '2026-09-21')
            self.assertFalse(rail_weekday_override_required(selected))
            selected, _ = rail_reference('2026-08-09', cache, base)
            self.assertEqual(selected, sunday)
            self.assertTrue(rail_weekday_override_required(selected))


if __name__ == '__main__':
    unittest.main()
