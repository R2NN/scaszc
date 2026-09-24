from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from types import MappingProxyType
from zoneinfo import ZoneInfo

from beeline_planning.departure_timing import (
    retime_initial_departures, retime_replanned_departures,
)
from beeline_planning.domain import (
    Engineer, Job, JobStatus, Office, PlanningDataset, Priority, RequiredTransport,
)
from beeline_planning.plan import EngineerPlan, PlannedVisit, ProposedPlan
from beeline_planning.validator import ValidationStatus, validate_initial_plan
from beeline_routing.errors import RoutingIncomplete
from beeline_routing.models import (
    Coordinate, DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode,
)


def _fixture():
    day = datetime(2026, 8, 17, tzinfo=ZoneInfo('Europe/Moscow'))
    start = day.replace(hour=16)
    departure = day.replace(hour=10)
    engineer = Engineer(
        'E1', 'Z', day.replace(hour=8), day.replace(hour=19), 'O1',
        TransportMode.CAR, True, 1, 600, frozenset({'S'}), (),
    )
    job = Job(
        'J1', 'Z', 'L1', start, start, day.replace(hour=7), 30,
        Priority.NORMAL, 'S', RequiredTransport.ANY, (), False, JobStatus.PENDING,
    )
    dataset = PlanningDataset(
        Path('.'), 'test', 'a' * 64, 'core', 'Europe/Moscow',
        day.date().isoformat(), day.replace(hour=7),
        MappingProxyType({
            'L0': Coordinate('L0', 55.0, 37.0),
            'L1': Coordinate('L1', 55.1, 37.1),
        }),
        MappingProxyType({'O1': Office('O1', 'Z', 'L0')}),
        MappingProxyType({}), MappingProxyType({'E1': engineer}),
        MappingProxyType({'J1': job}), (), (), (), MappingProxyType({}),
    )
    travel = DetailedRoute(
        'L0', 'L1', TransportMode.CAR, departure, RouteStatus.OK,
        20 * 60, 20, 2000,
        ((55.0, 37.0), (55.1, 37.1)),
        (RouteStep(1, 'CAR', 20 * 60, 2000, 0,
                   ((55.0, 37.0), (55.1, 37.1)), {}),),
        'OK', Provenance('TEST', 'test://route', 'a' * 64, 'b' * 64,
                         day.isoformat(), False, {}),
    )
    plan = ProposedPlan(
        dataset.initial_planning_at,
        (EngineerPlan('E1', (PlannedVisit('J1', departure, start, travel),)),),
        (),
    )
    assert validate_initial_plan(dataset, plan).status == ValidationStatus.VALID
    return dataset, plan


class _Oracle:
    def __init__(self, source, durations, *, fails=False):
        self.source = source
        self.durations = durations
        self.fails = fails
        self.departures = []

    def query(self, request):
        self.departures.append(request.departure_at)
        if self.fails:
            raise RoutingIncomplete('route unavailable')
        duration = self.durations.get(request.departure_at.strftime('%H:%M'), 20)
        return replace(
            self.source,
            departure_at=request.departure_at,
            duration_seconds=duration * 60,
            duration_minutes=duration,
        )


class DepartureTimingTests(unittest.TestCase):
    def test_six_hour_early_arrival_is_retimed_with_new_route_evidence(self):
        dataset, plan = _fixture()
        oracle = _Oracle(plan.engineer_plans[0].visits[0].travel, {})
        result = retime_initial_departures(dataset, plan, oracle)
        visit = result.plan.engineer_plans[0].visits[0]
        self.assertEqual(visit.departure_at.strftime('%H:%M'), '15:25')
        self.assertEqual(visit.service_start_at.strftime('%H:%M'), '16:00')
        self.assertEqual(visit.travel.departure_at, visit.departure_at)
        self.assertEqual(result.client_wait_after_minutes, 15)
        self.assertEqual(result.changed_legs, 1)
        self.assertEqual(validate_initial_plan(dataset, result.plan).status, ValidationStatus.VALID)

    def test_slower_later_traffic_triggers_an_earlier_safe_query(self):
        dataset, plan = _fixture()
        oracle = _Oracle(plan.engineer_plans[0].visits[0].travel,
                         {'15:25': 40, '15:04': 30})
        result = retime_initial_departures(dataset, plan, oracle)
        visit = result.plan.engineer_plans[0].visits[0]
        self.assertIn('15:04', [at.strftime('%H:%M') for at in oracle.departures])
        self.assertEqual(visit.departure_at.strftime('%H:%M'), '15:15')
        self.assertEqual(result.exact_queries, 3)
        self.assertEqual(validate_initial_plan(dataset, result.plan).status, ValidationStatus.VALID)

    def test_routing_failure_keeps_the_original_valid_leg(self):
        dataset, plan = _fixture()
        oracle = _Oracle(plan.engineer_plans[0].visits[0].travel, {}, fails=True)
        result = retime_initial_departures(dataset, plan, oracle)
        self.assertEqual(result.plan, plan)
        self.assertEqual(result.changed_legs, 0)
        self.assertEqual(result.exact_queries, 1)

    def test_event_preserves_a_trip_that_started_before_the_event(self):
        dataset, plan = _fixture()
        oracle = _Oracle(plan.engineer_plans[0].visits[0].travel, {})
        result = retime_replanned_departures(
            dataset, plan, plan, oracle,
            event_time=dataset.initial_planning_at + timedelta(hours=6, minutes=30),
            applied_event_ids=frozenset(),
            canceled_job_ids=frozenset(),
            unavailable_until_by_engineer={},
        )
        self.assertEqual(result.plan, plan)
        self.assertEqual(oracle.departures, [])

    def test_event_can_retime_only_a_future_trip(self):
        dataset, plan = _fixture()
        future_departure = dataset.initial_planning_at + timedelta(hours=7)
        old_visit = plan.engineer_plans[0].visits[0]
        future_visit = replace(
            old_visit,
            departure_at=future_departure,
            travel=replace(old_visit.travel, departure_at=future_departure),
        )
        future_plan = replace(plan, engineer_plans=(
            EngineerPlan('E1', (future_visit,)),
        ))
        oracle = _Oracle(future_visit.travel, {})
        result = retime_replanned_departures(
            dataset, future_plan, future_plan, oracle,
            event_time=dataset.initial_planning_at + timedelta(hours=6, minutes=30),
            applied_event_ids=frozenset(),
            canceled_job_ids=frozenset(),
            unavailable_until_by_engineer={},
        )
        self.assertEqual(result.changed_legs, 1)
        self.assertEqual(
            result.plan.engineer_plans[0].visits[0].departure_at.strftime('%H:%M'),
            '15:25',
        )


if __name__ == '__main__':
    unittest.main()
