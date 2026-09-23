from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime
from types import MappingProxyType, SimpleNamespace
from zoneinfo import ZoneInfo

from beeline_planning.domain import (
    Engineer,
    Job,
    JobStatus,
    Priority,
    RequiredTransport,
)
from beeline_planning.eligibility import CandidateIndex
from beeline_planning.exact_lns import find_exact_lns_coverage_move
from beeline_routing.models import TransportMode


class ExactAwareLnsTests(unittest.TestCase):
    def setUp(self) -> None:
        day = datetime(2026, 8, 17, tzinfo=ZoneInfo('Europe/Moscow'))
        self.day = day
        self.engineers = {
            engineer_id: Engineer(
                engineer_id=engineer_id,
                zone_id='Z1',
                shift_start=day.replace(hour=8),
                shift_end=day.replace(hour=18),
                start_office_id='O',
                transport_mode=TransportMode.CAR,
                is_available=True,
                max_jobs=6,
                max_route_minutes=600,
                skills=frozenset({'INSTALL'}),
                equipment=(),
            )
            for engineer_id in ('E1', 'E2', 'E3')
        }
        self.jobs = {
            job_id: Job(
                job_id=job_id,
                zone_id='Z1',
                location_id=job_id,
                window_start=day.replace(hour=10),
                window_end=day.replace(hour=14),
                created_at=day.replace(hour=7),
                service_duration_min=30,
                priority=Priority.NORMAL,
                required_skill='INSTALL',
                required_transport=RequiredTransport.ANY,
                required_equipment=(),
                is_event_job=False,
                status=JobStatus.PENDING,
            )
            for job_id in ('J', 'A', 'B', 'C', 'D', 'LATE')
        }
        self.jobs['LATE'] = replace(
            self.jobs['LATE'],
            window_start=day.replace(hour=16),
            window_end=day.replace(hour=17),
        )
        self.dataset = SimpleNamespace(
            initial_planning_at=day.replace(hour=7),
            engineers=self.engineers,
            jobs=self.jobs,
            equipment_catalog={},
            shared_inventory=(),
        )

    def _candidates(self, mapping: dict[str, tuple[str, ...]]) -> CandidateIndex:
        return CandidateIndex(
            planning_at=self.day.replace(hour=7),
            active_job_ids=tuple(sorted(mapping)),
            eligible_engineers_by_job=MappingProxyType(mapping),
            rejection_codes=MappingProxyType({}),
        )

    def test_rebuilds_multiple_routes_around_unserved_job(self) -> None:
        routes = {'E1': ('A', 'B'), 'E2': ('C', 'D'), 'E3': ()}
        candidates = self._candidates({
            'J': ('E1',),
            'A': ('E1', 'E2'),
            'B': ('E1',),
            'C': ('E1', 'E2'),
            'D': ('E2',),
        })
        final_orders = {
            'E1': ('J', 'B', 'C'),
            'E2': ('D', 'A'),
            'E3': (),
        }

        def exact_route_check(engineer_id: str, order: tuple[str, ...]) -> bool:
            if engineer_id == 'E1':
                return {'J', 'B'} <= set(order) and not {'A', 'D'} & set(order)
            if engineer_id == 'E2':
                return {'A', 'D'} <= set(order) and not {'J', 'B'} & set(order)
            return not order

        report = find_exact_lns_coverage_move(
            self.dataset,
            routes,
            {'J'},
            candidates,
            exact_route_check,
            max_route_checks=100,
            beam_width=256,
            max_destroyed_jobs=4,
            max_engineers=2,
        )

        self.assertIsNotNone(report.move)
        self.assertEqual(report.move.inserted_job_id, 'J')
        self.assertEqual(set(report.move.routes['E1']), set(final_orders['E1']))
        self.assertEqual(set(report.move.routes['E2']), set(final_orders['E2']))
        self.assertEqual(set(report.move.destroyed_job_ids), {'A', 'B', 'C', 'D'})
        self.assertGreater(report.route_checks, 0)

    def test_preserves_jobs_outside_the_time_neighbourhood(self) -> None:
        routes = {'E1': ('A', 'B', 'LATE'), 'E2': ('C',), 'E3': ()}
        candidates = self._candidates({
            'J': ('E1',),
            'A': ('E1', 'E2'),
            'B': ('E1', 'E2'),
            'C': ('E1', 'E2'),
            'LATE': ('E1',),
        })

        report = find_exact_lns_coverage_move(
            self.dataset,
            routes,
            {'J'},
            candidates,
            lambda _engineer_id, _order: True,
            max_route_checks=200,
            beam_width=16,
            max_destroyed_jobs=3,
            max_engineers=2,
            window_padding_minutes=0,
            neighbour_radius=0,
        )

        self.assertIsNotNone(report.move)
        self.assertNotIn('LATE', report.move.destroyed_job_ids)
        self.assertIn('LATE', report.move.routes.get('E1', routes['E1']))

    def test_reports_budget_exhaustion_without_claiming_infeasibility(self) -> None:
        routes = {'E1': ('A', 'LATE'), 'E2': ('B',), 'E3': ()}
        candidates = self._candidates({
            'J': ('E1',),
            'A': ('E1', 'E2'),
            'B': ('E1', 'E2'),
            'LATE': ('E1',),
        })
        report = find_exact_lns_coverage_move(
            self.dataset,
            routes,
            {'J'},
            candidates,
            lambda _engineer_id, _order: False,
            max_route_checks=1,
            beam_width=4,
            max_destroyed_jobs=1,
            max_engineers=2,
        )

        self.assertIsNone(report.move)
        self.assertTrue(report.budget_exhausted)
        self.assertEqual(report.route_checks, 1)


if __name__ == '__main__':
    unittest.main()
