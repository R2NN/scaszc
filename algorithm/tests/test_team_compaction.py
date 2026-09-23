from __future__ import annotations

import json
import unittest
from datetime import datetime
from pathlib import Path

from beeline_planning import (
    EngineerPlan,
    ProposedPlan,
    build_candidate_index,
    build_screening_route_evaluator,
    find_team_elimination_candidates,
    load_planning_dataset,
    load_screening_matrices,
    merge_exact_compaction_delta,
)


ROOT = Path(__file__).parents[2]
DATASET = ROOT / 'data' / 'dataset'
SCREENING = ROOT / 'data' / 'screening'
PLAN = (
    ROOT
    / 'algorithm'
    / 'artifacts'
    / 'current'
    / 'exact-205-of-205-28-teams-clean-automatic.json'
)


class TeamCompactionTests(unittest.TestCase):
    def test_consecutive_deltas_build_on_latest_accepted_plan(self) -> None:
        planning_at = datetime.fromisoformat('2026-08-17T10:00:00+03:00')
        base = ProposedPlan(
            planning_at,
            tuple(EngineerPlan(engineer_id, ()) for engineer_id in ('E1', 'E2', 'E3')),
            (),
        )
        updated_e2 = EngineerPlan('E2', ())
        first = merge_exact_compaction_delta(base, 'E1', {'E2': updated_e2})
        second = merge_exact_compaction_delta(first, 'E3', {})

        self.assertEqual(second.engineer_plans, (updated_e2,))
        self.assertIs(second.engineer_plans[0], updated_e2)

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
        focus_engineer_id = min(
            (engineer_id for engineer_id, order in routes.items() if order),
            key=lambda engineer_id: (len(routes[engineer_id]), engineer_id),
        )
        report = find_team_elimination_candidates(
            dataset,
            routes,
            candidates,
            build_screening_route_evaluator(dataset, screening, candidates),
            focus_engineer_id=focus_engineer_id,
            beam_width=64,
            max_candidates=10,
            max_states=100_000,
        )
        self.assertFalse(report.budget_exhausted)
        used_engineers = set(routes)
        for candidate in report.candidates:
            self.assertEqual(candidate.eliminated_engineer_id, focus_engineer_id)
            self.assertEqual(
                set(candidate.moved_job_ids),
                set(routes[focus_engineer_id]),
            )
            for engineer_id, order in candidate.changed_routes:
                self.assertIn(engineer_id, used_engineers)
                self.assertNotEqual(engineer_id, candidate.eliminated_engineer_id)
                self.assertGreater(len(order), 0)


if __name__ == '__main__':
    unittest.main()
