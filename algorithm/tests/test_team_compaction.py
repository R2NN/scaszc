from __future__ import annotations

import json
import unittest
from pathlib import Path

from beeline_planning import (
    build_candidate_index,
    build_screening_route_evaluator,
    find_team_elimination_candidates,
    load_planning_dataset,
    load_screening_matrices,
)


ROOT = Path(__file__).parents[2]
DATASET = ROOT / 'data' / 'dataset'
SCREENING = ROOT / 'data' / 'screening'
PLAN = (
    ROOT
    / 'algorithm'
    / 'artifacts'
    / 'current'
    / 'initial-exact-204-of-205-explained.json'
)


class TeamCompactionTests(unittest.TestCase):
    def test_route_elimination_keeps_jobs_in_existing_teams(self) -> None:
        dataset = load_planning_dataset(DATASET, 'core')
        screening = load_screening_matrices(SCREENING, dataset)
        candidates = build_candidate_index(dataset)
        payload = json.loads(PLAN.read_text(encoding='utf-8'))
        routes = {
            route['engineer_id']: tuple(
                visit['job_id'] for visit in route['visits']
            )
            for route in payload['plan']['engineer_plans']
        }
        report = find_team_elimination_candidates(
            dataset,
            routes,
            candidates,
            build_screening_route_evaluator(dataset, screening, candidates),
            focus_engineer_id='EAST-ENG-06',
            beam_width=64,
            max_candidates=10,
            max_states=100_000,
        )
        self.assertFalse(report.budget_exhausted)
        self.assertTrue(report.candidates)
        candidate = report.candidates[0]
        self.assertEqual(candidate.eliminated_engineer_id, 'EAST-ENG-06')
        self.assertEqual(
            set(candidate.moved_job_ids),
            set(routes['EAST-ENG-06']),
        )
        used_engineers = set(routes)
        for engineer_id, order in candidate.changed_routes:
            self.assertIn(engineer_id, used_engineers)
            self.assertNotEqual(engineer_id, candidate.eliminated_engineer_id)
            self.assertGreater(len(order), 0)


if __name__ == '__main__':
    unittest.main()
