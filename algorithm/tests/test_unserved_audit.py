import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / 'tools'))
from diagnose_unserved_initial import summarize_job


class UnservedAuditTests(unittest.TestCase):
    def test_shift_explanation_uses_the_best_qualified_time_bound(self):
        report = {'eligible_engineer_ids': [], 'service_duration_min': 128,
                  'engineers': [
                      {'rejections': ['SKILL_MISSING'], 'minimum_shift_overrun_minutes': 0},
                      {'rejections': ['SHIFT_WINDOW_NO_OVERLAP'], 'minimum_shift_overrun_minutes': 8,
                       'earliest_finish_without_travel': '2026-08-17T22:08:00+03:00',
                       'shift_end': '2026-08-17T22:00:00+03:00'},
                  ]}
        text = summarize_job(report)
        self.assertIn('22:08', text)
        self.assertIn('128', text)
        self.assertIn('8 мин', text)

    def test_exact_window_conflict_does_not_claim_global_impossibility(self):
        report = {'eligible_engineer_ids': ['E'], 'positions': [
            {'proof_level': 'ZERO_TRAVEL_LOWER_BOUND_FOR_THIS_ORDER', 'violation_minutes': 1},
            {'proof_level': 'EXACT_CURRENT_ORDER', 'constraint': 'client_window',
             'violation_minutes': 4, 'service_start_at': '2026-08-17T14:04:00+03:00',
             'limit_at': '2026-08-17T14:00:00+03:00'},
        ]}
        text = summarize_job(report)
        self.assertIn('14:04', text)
        self.assertIn('4 мин', text)
        self.assertNotIn('невозможно', text)


if __name__ == '__main__':
    unittest.main()
