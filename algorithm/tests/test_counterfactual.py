from __future__ import annotations

import unittest
from datetime import datetime
from pathlib import Path
from types import MappingProxyType
from zoneinfo import ZoneInfo

from beeline_planning import (
    CounterfactualStatus,
    Engineer,
    Event,
    Job,
    Office,
    PlanningDataset,
    Priority,
    ReplanningState,
    RequiredTransport,
    counterfactual_result_dict,
    evaluate_event_assignment_counterfactual,
    evaluate_initial_assignment_counterfactual,
    materialize_exact_initial_plan,
    replan_after_event,
)
from beeline_planning.domain import EventType, JobStatus
from beeline_planning.exact_repair import master_from_orders
from beeline_routing.models import Coordinate, TransportMode


class CounterfactualTests(unittest.TestCase):
    def setUp(self) -> None:
        day = datetime(2026, 8, 17, tzinfo=ZoneInfo('Europe/Moscow'))
        self.t0 = day.replace(hour=7)
        self.engineers = MappingProxyType({
            engineer_id: Engineer(
                engineer_id=engineer_id,
                zone_id=zone,
                shift_start=day.replace(hour=8),
                shift_end=day.replace(hour=18),
                start_office_id=office,
                transport_mode=TransportMode.CAR,
                is_available=True,
                max_jobs=4,
                max_route_minutes=600,
                skills=frozenset({'INSTALL'}),
                equipment=(),
            )
            for engineer_id, zone, office in (
                ('E1', 'Z1', 'O1'), ('E2', 'Z1', 'O1'), ('OTHER', 'Z2', 'O2')
            )
        })
        self.jobs = {
            job_id: Job(
                job_id=job_id,
                zone_id='Z1',
                location_id='L1',
                window_start=day.replace(hour=8),
                window_end=day.replace(hour=17),
                created_at=self.t0,
                service_duration_min=30,
                priority=Priority.NORMAL,
                required_skill='INSTALL',
                required_transport=RequiredTransport.ANY,
                required_equipment=(),
                is_event_job=False,
                status=JobStatus.PENDING,
            )
            for job_id in ('A', 'B')
        }
        self.dataset = self._dataset(())
        result = materialize_exact_initial_plan(
            self.dataset,
            master_from_orders(
                self.dataset,
                {'E1': ('A', 'B'), 'E2': (), 'OTHER': ()},
                set(),
            ),
            None,
        )
        self.actual_plan = result.plan
        self.assertTrue(result.validation.is_valid)

    def _dataset(self, events: tuple[Event, ...]) -> PlanningDataset:
        return PlanningDataset(
            root=Path('.'),
            dataset_version='test',
            dataset_sha256='d' * 64,
            scenario='test',
            timezone_name='Europe/Moscow',
            planning_date='2026-08-17',
            initial_planning_at=self.t0,
            locations=MappingProxyType({
                'L1': Coordinate('L1', 55.7, 37.6),
                'L2': Coordinate('L2', 55.8, 37.7),
            }),
            offices=MappingProxyType({
                'O1': Office('O1', 'Z1', 'L1'),
                'O2': Office('O2', 'Z2', 'L2'),
            }),
            equipment_catalog=MappingProxyType({}),
            engineers=self.engineers,
            jobs=MappingProxyType(self.jobs),
            shared_inventory=(),
            events=events,
            commitments=(),
            constraint_policies=MappingProxyType({}),
        )

    def test_initial_counterfactual_forces_same_zone_engineer_and_validates(self) -> None:
        result = evaluate_initial_assignment_counterfactual(
            self.dataset, self.actual_plan, 'B', 'E2', None
        )
        self.assertEqual(result.status, CounterfactualStatus.FEASIBLE)
        self.assertTrue(result.validation.is_valid)
        owners = {
            visit.job_id: route.engineer_id
            for route in result.plan.engineer_plans for visit in route.visits
        }
        self.assertEqual(owners['B'], 'E2')
        self.assertEqual(result.metrics_delta['used_engineers'], 1)
        serialized = counterfactual_result_dict(result)
        self.assertTrue(serialized['counterfactual_only'])
        self.assertFalse(serialized['publication_allowed'])

    def test_initial_counterfactual_rejects_another_zone_without_routing(self) -> None:
        result = evaluate_initial_assignment_counterfactual(
            self.dataset, self.actual_plan, 'B', 'OTHER', None
        )
        self.assertEqual(result.status, CounterfactualStatus.STATICALLY_INELIGIBLE)
        self.assertIn('ZONE_MISMATCH', result.static_rejection_codes)
        self.assertEqual(result.route_checks, 0)

    def test_event_counterfactual_replays_event_with_forced_engineer(self) -> None:
        event_time = self.t0.replace(hour=10)
        self.jobs['U'] = Job(
            job_id='U', zone_id='Z1', location_id='L1',
            window_start=event_time, window_end=self.t0.replace(hour=17),
            created_at=event_time, service_duration_min=30,
            priority=Priority.URGENT, required_skill='INSTALL',
            required_transport=RequiredTransport.ANY,
            required_equipment=(), is_event_job=True, status=JobStatus.PENDING,
        )
        event = Event(
            1, 'EVT-1', event_time, EventType.NEW_URGENT_JOB,
            'U', 'Z1', None, {},
        )
        dataset = self._dataset((event,))
        state = ReplanningState(self.actual_plan)
        actual = replan_after_event(dataset, state, event, None)
        actual_owner = next(
            route.engineer_id for route in actual.state.plan.engineer_plans
            if any(visit.job_id == 'U' for visit in route.visits)
        )
        forced = 'E2' if actual_owner == 'E1' else 'E1'
        result = evaluate_event_assignment_counterfactual(
            dataset, state, event, actual.state.plan, 'U', forced, None
        )
        self.assertEqual(result.status, CounterfactualStatus.FEASIBLE)
        self.assertTrue(result.validation.is_valid)
        counterfactual_owner = next(
            route.engineer_id for route in result.plan.engineer_plans
            if any(visit.job_id == 'U' for visit in route.visits)
        )
        self.assertEqual(counterfactual_owner, forced)
        self.assertNotEqual(counterfactual_owner, actual_owner)


if __name__ == '__main__':
    unittest.main()
