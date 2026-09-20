from __future__ import annotations

import json
import unittest
from datetime import timedelta
from pathlib import Path

from beeline_planning import (
    CandidateEvaluation,
    build_explanation_bundle,
    load_planning_dataset,
    validate_initial_plan,
    validate_replanned_plan,
)
from beeline_planning.export import load_exact_plan_artifact


ROOT = Path(__file__).parents[1]
DATASET = ROOT / 'work/dataset_v21/beeline_synthetic_dataset_v2_1'


class ExplanationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dataset = load_planning_dataset(DATASET, 'core')
        cls.initial, cls.initial_payload = load_exact_plan_artifact(
            ROOT / 'work/planning/normatives-exact-improved.json',
            cls.dataset.dataset_sha256,
        )
        cls.initial_validation = validate_initial_plan(cls.dataset, cls.initial)

    def test_initial_bundle_explains_every_active_job_without_overclaiming(self) -> None:
        bundle = build_explanation_bundle(
            self.dataset,
            self.initial,
            self.initial_validation,
            insertion_diagnostics=self.initial_payload['unserved_insertion_diagnostics'],
        )
        self.assertEqual(len(bundle['jobs']), 205)
        self.assertEqual(
            sum(item['status'] == 'ASSIGNED' for item in bundle['jobs']), 200
        )
        self.assertEqual(
            sum(item['status'] == 'UNSERVED' for item in bundle['jobs']), 5
        )
        self.assertFalse(bundle['run_certificate']['global_optimality_proven'])
        self.assertTrue(bundle['run_certificate']['publication_allowed'])
        self.assertFalse(bundle['run_certificate']['coverage_complete'])
        self.assertEqual(bundle['run_certificate']['served_jobs'], 200)
        self.assertEqual(bundle['run_certificate']['unserved_jobs'], 5)
        assigned = next(item for item in bundle['jobs'] if item['status'] == 'ASSIGNED')
        self.assertEqual(set(assigned['constraint_checks'].values()), {'PASS'})
        self.assertEqual(assigned['claim_level'], 'EXACT_VALIDATED')
        self.assertEqual(assigned['optimality'], 'BEST_CHECKED_NOT_GLOBAL_OPTIMUM')

    def test_unserved_insertion_diagnostic_says_global_impossibility_is_not_proven(self) -> None:
        bundle = build_explanation_bundle(
            self.dataset,
            self.initial,
            self.initial_validation,
            insertion_diagnostics=self.initial_payload['unserved_insertion_diagnostics'],
        )
        item = next(
            entry for entry in bundle['jobs']
            if entry['job_id'] == 'SOUTHEAST-62011'
        )
        self.assertEqual(item['decision_kind'], 'NO_EXACT_FEASIBLE_INSERTION_IN_CURRENT_ROUTES')
        self.assertEqual(item['claim_level'], 'LOCAL_IMPOSSIBILITY')
        self.assertEqual(item['optimality'], 'GLOBAL_IMPOSSIBILITY_NOT_PROVEN')
        self.assertIn('не доказательство глобальной невозможности', item['summary_ru'])
        self.assertGreater(item['diagnostics']['candidate_positions'], 0)

    def test_event_bundle_explains_urgent_choice_changes_and_alternatives(self) -> None:
        replanned, _ = load_exact_plan_artifact(
            ROOT / 'work/planning/normatives-event-001-smart-urgent.json',
            self.dataset.dataset_sha256,
        )
        event = self.dataset.events[0]
        validation = validate_replanned_plan(
            self.dataset,
            replanned,
            self.initial,
            event_time=event.event_time,
            applied_event_ids=frozenset({event.event_id}),
            canceled_job_ids=frozenset(),
            unavailable_until_by_engineer={},
        )
        actual = next(
            visit for route in replanned.engineer_plans for visit in route.visits
            if visit.job_id == event.target_id
        )
        alternatives = {
            event.target_id: (
                CandidateEvaluation(
                    engineer_id='EAST-ENG-04', move_kind='DIRECT_INSERT',
                    service_start_at=actual.service_start_at,
                    response_minutes=30, shifted_existing_minutes=0,
                    added_engineers=1, added_distance_m=1000,
                    displaced_job_id=None, displaced_job_restored=False,
                    selected=True,
                ),
                CandidateEvaluation(
                    engineer_id='EAST-ENG-08', move_kind='DIRECT_INSERT',
                    service_start_at=actual.service_start_at + timedelta(minutes=8),
                    response_minutes=38, shifted_existing_minutes=25,
                    added_engineers=0, added_distance_m=2000,
                    displaced_job_id=None, displaced_job_restored=False,
                    selected=False,
                ),
            )
        }
        bundle = build_explanation_bundle(
            self.dataset,
            replanned,
            validation,
            explanation_at=event.event_time,
            applied_event_ids=frozenset({event.event_id}),
            previous_plan=self.initial,
            event=event,
            candidate_evaluations=alternatives,
            exact_route_checks=80,
            urgency_policy={'near_earliest_slack_minutes': 15},
        )
        urgent = next(item for item in bundle['jobs'] if item['job_id'] == event.target_id)
        self.assertEqual(urgent['decision_kind'], 'EARLY_URGENT_WITH_CONTROLLED_DISRUPTION')
        self.assertEqual(urgent['response_minutes'], 30)
        self.assertEqual(len(urgent['checked_alternatives']), 2)
        self.assertEqual(
            sum(item['selected'] for item in urgent['checked_alternatives']), 1
        )
        rationale = urgent['selection_rationale']
        self.assertEqual(rationale['policy'], 'URGENT_EARLY_BAND_THEN_STABILITY')
        self.assertTrue(rationale['selected_inside_early_band'])
        self.assertEqual(rationale['selected_impact']['response_minutes'], 30)
        self.assertEqual(rationale['saved_exact_feasible_alternatives'], 2)
        self.assertEqual(bundle['event']['changed_assignments'], 0)
        self.assertEqual(bundle['event']['shifted_existing_jobs'], 0)
        self.assertGreater(bundle['event']['frozen_started_visits'], 0)

    def test_reason_claim_levels_distinguish_budget_stock_and_routing(self) -> None:
        for reason, claim in (
            ('SEARCH_BUDGET_EXHAUSTED', 'SEARCH_LIMIT_REACHED'),
            ('SHARED_STOCK_SHORTAGE', 'EXACT_FACT'),
            ('ROUTING_UNVERIFIED', 'ROUTING_UNVERIFIED'),
        ):
            reasons = {
                job_id: reason for job_id in self.initial.unserved_job_ids
            }
            bundle = build_explanation_bundle(
                self.dataset,
                self.initial,
                self.initial_validation,
                unserved_reasons=reasons,
                search_budget_exhausted=reason == 'SEARCH_BUDGET_EXHAUSTED',
            )
            unserved = [item for item in bundle['jobs'] if item['status'] == 'UNSERVED']
            self.assertTrue(unserved)
            self.assertTrue(all(item['claim_level'] == claim for item in unserved))
            self.assertTrue(all(item['optimality'] != 'PROVEN_INFEASIBLE' for item in unserved))

    def test_bundle_is_json_serializable(self) -> None:
        bundle = build_explanation_bundle(
            self.dataset, self.initial, self.initial_validation
        )
        encoded = json.dumps(bundle, ensure_ascii=False)
        self.assertIn('generated_from_structured_facts', encoded)


if __name__ == '__main__':
    unittest.main()
