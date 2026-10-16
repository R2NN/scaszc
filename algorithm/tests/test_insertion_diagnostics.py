from datetime import datetime, timedelta
from types import SimpleNamespace
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))
from improve_exact_plan import _insertion_master, _zero_travel_window_conflict


class InsertionDiagnosticsTests(unittest.TestCase):
    def test_window_conflict_reports_the_displaced_job_and_exact_minutes(self):
        day = datetime.fromisoformat('2026-08-17T08:00:00+03:00')
        engineer = SimpleNamespace(shift_start=day, shift_end=day + timedelta(hours=10), max_route_minutes=600)
        first = SimpleNamespace(created_at=day, window_start=day, window_end=day + timedelta(hours=2), service_duration_min=90)
        second = SimpleNamespace(created_at=day, window_start=day, window_end=day + timedelta(hours=1), service_duration_min=30)
        dataset = SimpleNamespace(initial_planning_at=day, engineers={'E': engineer}, jobs={'A': first, 'B': second})
        conflict = _zero_travel_window_conflict(dataset, 'E', ['A', 'B'])
        self.assertEqual(conflict['conflicting_job_id'], 'B')
        self.assertEqual(conflict['violation_minutes'], 30)
        self.assertEqual(conflict['constraint'], 'client_window')
        self.assertEqual(conflict['proof_level'], 'ZERO_TRAVEL_LOWER_BOUND_FOR_THIS_ORDER')
        self.assertIsNone(_zero_travel_window_conflict(dataset, 'E', ['B', 'A']))

    def test_insertion_keeps_the_other_team_in_global_resource_validation(self):
        day = datetime.fromisoformat('2026-08-17T08:00:00+03:00')
        engineer = SimpleNamespace(shift_start=day, transport_mode=SimpleNamespace(value='CAR'))
        job = SimpleNamespace(created_at=day, window_start=day)
        dataset = SimpleNamespace(initial_planning_at=day, engineers={'E1': engineer, 'E2': engineer}, jobs={key: job for key in 'ABCD'}, dataset_sha256='test')
        routes = {'E1': ['A'], 'E2': ['B']}
        master = _insertion_master(dataset, routes, 'E1', ['A', 'C'], 'ABCD')
        self.assertEqual({route.engineer_id: tuple(visit.job_id for visit in route.visits) for route in master.routes}, {'E1': ('A', 'C'), 'E2': ('B',)})
        self.assertEqual(master.unserved_job_ids, ('D',))
        self.assertEqual(routes['E1'], ['A'])
