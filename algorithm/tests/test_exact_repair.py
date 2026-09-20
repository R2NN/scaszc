from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from types import MappingProxyType, SimpleNamespace
from zoneinfo import ZoneInfo

from beeline_planning.domain import (
    Engineer, Equipment, EquipmentNeed, Job, JobStatus, Office,
    PlanningDataset, Priority, RequiredTransport,
)
from beeline_planning.eligibility import CandidateIndex, build_candidate_index
from beeline_planning.exact_repair import (
    find_coverage_move,
    master_from_orders,
    zero_travel_order_feasible,
)
from beeline_planning.materialize import (
    MaterializationStatus,
    materialize_exact_initial_plan,
)
from beeline_routing.models import Coordinate, TransportMode


class ExactCoverageRepairTests(unittest.TestCase):
    def setUp(self) -> None:
        day = datetime(2026, 8, 17, tzinfo=ZoneInfo('Europe/Moscow'))
        self.day = day
        self.engineers = {
            engineer_id: Engineer(
                engineer_id=engineer_id,
                zone_id=zone_id,
                shift_start=day.replace(hour=8),
                shift_end=day.replace(hour=18),
                start_office_id='O',
                transport_mode=TransportMode.CAR,
                is_available=True,
                max_jobs=4,
                max_route_minutes=600,
                skills=frozenset({'INSTALL'}),
                equipment=(),
            )
            for engineer_id, zone_id in (
                ('E1', 'Z1'), ('E2', 'Z1'), ('E3', 'Z1'), ('OTHER', 'Z2')
            )
        }
        self.jobs = {
            job_id: Job(
                job_id=job_id,
                zone_id='Z1',
                location_id=job_id,
                window_start=day.replace(hour=8),
                window_end=day.replace(hour=17),
                created_at=day.replace(hour=7),
                service_duration_min=30,
                priority=Priority.NORMAL,
                required_skill='INSTALL',
                required_transport=RequiredTransport.ANY,
                required_equipment=(),
                is_event_job=False,
                status=JobStatus.PENDING,
            )
            for job_id in ('J', 'A', 'B')
        }
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

    def test_relocates_one_job_to_cover_an_unserved_job(self) -> None:
        routes = {'E1': ('A',), 'E2': ()}
        allowed = {('E1', ('J',)), ('E2', ('A',))}
        report = find_coverage_move(
            self.dataset, routes, {'J'},
            self._candidates({'J': ('E1',), 'A': ('E1', 'E2')}),
            lambda engineer_id, order: (engineer_id, order) in allowed,
        )
        self.assertIsNotNone(report.move)
        self.assertEqual(report.move.kind, 'RELOCATE')
        self.assertEqual(report.move.routes, {'E1': ('J',), 'E2': ('A',)})

    def test_exchanges_jobs_when_recipient_route_is_full(self) -> None:
        routes = {'E1': ('A',), 'E2': ('B',)}
        allowed = {
            ('E1', ('J',)), ('E2', ('A',)),
            ('E1', ('J', 'B')), ('E1', ('B', 'J')),
        }
        report = find_coverage_move(
            self.dataset, routes, {'J'},
            self._candidates({
                'J': ('E1',), 'A': ('E1', 'E2'), 'B': ('E1', 'E2'),
            }),
            lambda engineer_id, order: (engineer_id, order) in allowed,
        )
        self.assertIsNotNone(report.move)
        self.assertEqual(report.move.kind, 'SWAP')
        self.assertEqual(set(report.move.routes['E1']), {'J', 'B'})
        self.assertEqual(report.move.routes['E2'], ('A',))

    def test_moves_second_displaced_job_to_third_brigade(self) -> None:
        routes = {'E1': ('A',), 'E2': ('B',), 'E3': ()}
        allowed = {('E1', ('J',)), ('E2', ('A',)), ('E3', ('B',))}
        report = find_coverage_move(
            self.dataset, routes, {'J'},
            self._candidates({
                'J': ('E1',), 'A': ('E1', 'E2'), 'B': ('E2', 'E3'),
            }),
            lambda engineer_id, order: (engineer_id, order) in allowed,
        )
        self.assertIsNotNone(report.move)
        self.assertEqual(report.move.kind, 'EJECTION_CHAIN')
        self.assertEqual(report.move.routes, {
            'E1': ('J',), 'E2': ('A',), 'E3': ('B',),
        })

    def test_moves_three_displaced_jobs_to_reach_an_idle_brigade(self) -> None:
        self.engineers['E4'] = replace(
            self.engineers['E3'],
            engineer_id='E4',
        )
        self.jobs['C'] = replace(
            self.jobs['B'],
            job_id='C',
            location_id='C',
        )
        routes = {'E1': ('A',), 'E2': ('B',), 'E3': ('C',), 'E4': ()}
        allowed = {
            ('E1', ('J',)),
            ('E2', ('A',)),
            ('E3', ('B',)),
            ('E4', ('C',)),
        }
        report = find_coverage_move(
            self.dataset,
            routes,
            {'J'},
            self._candidates({
                'J': ('E1',),
                'A': ('E2',),
                'B': ('E3',),
                'C': ('E4',),
            }),
            lambda engineer_id, order: (engineer_id, order) in allowed,
            max_displacements=3,
            max_route_checks=100,
        )
        self.assertIsNotNone(report.move)
        self.assertEqual(report.move.kind, 'EJECTION_CHAIN')
        self.assertEqual(report.move.routes, {
            'E1': ('J',),
            'E2': ('A',),
            'E3': ('B',),
            'E4': ('C',),
        })

    def test_never_moves_a_job_to_another_zone_even_with_bad_candidates(self) -> None:
        routes = {'E1': ('A',), 'OTHER': ()}
        report = find_coverage_move(
            self.dataset, routes, {'J'},
            self._candidates({'J': ('E1',), 'A': ('E1', 'OTHER')}),
            lambda engineer_id, order: (engineer_id, order) in {
                ('E1', ('J',)), ('OTHER', ('A',)),
            },
        )
        self.assertIsNone(report.move)

    def test_search_limit_is_not_an_infeasibility_proof(self) -> None:
        routes = {'E1': ('A',), 'E2': ()}
        report = find_coverage_move(
            self.dataset, routes, {'J'},
            self._candidates({'J': ('E1',), 'A': ('E1', 'E2')}),
            lambda engineer_id, order: False,
            max_route_checks=1,
        )
        self.assertIsNone(report.move)
        self.assertTrue(report.budget_exhausted)

    def test_depth_limits_still_allow_a_chain_search(self) -> None:
        routes = {'E1': ('A',), 'E2': ('B',), 'E3': ()}
        allowed = {('E1', ('J',)), ('E2', ('A',)), ('E3', ('B',))}
        report = find_coverage_move(
            self.dataset, routes, {'J'},
            self._candidates({
                'J': ('E1',), 'A': ('E1', 'E2'), 'B': ('E2', 'E3'),
            }),
            lambda engineer_id, order: (engineer_id, order) in allowed,
            max_route_checks=20,
            max_checks_by_depth=(1, 1, 10),
        )
        self.assertIsNotNone(report.move)
        self.assertEqual(report.move.kind, 'EJECTION_CHAIN')
        self.assertTrue(report.budget_exhausted)

    def test_future_job_starts_route_when_it_becomes_known(self) -> None:
        self.jobs['J'] = replace(
            self.jobs['J'],
            created_at=self.day.replace(hour=13),
            window_start=self.day.replace(hour=13),
            window_end=self.day.replace(hour=14),
        )
        self.engineers['E1'] = replace(
            self.engineers['E1'], max_route_minutes=60
        )
        self.assertTrue(zero_travel_order_feasible(self.dataset, 'E1', ('J',)))

    def test_shared_stock_shortage_blocks_a_false_improvement(self) -> None:
        self.jobs['J'] = replace(
            self.jobs['J'],
            required_equipment=(EquipmentNeed('PART', 1),),
        )
        self.dataset.equipment_catalog = {
            'PART': Equipment('PART', 'consumable', False, True),
        }
        report = find_coverage_move(
            self.dataset, {'E1': ()}, {'J'},
            self._candidates({'J': ('E1',)}),
            lambda engineer_id, order: True,
        )
        self.assertIsNone(report.move)
        self.assertEqual(report.route_checks, 0)

    def test_chain_is_accepted_by_complete_exact_validator(self) -> None:
        engineers = {
            engineer_id: replace(
                self.engineers[engineer_id],
                skills=frozenset(skills),
                max_jobs=2,
                max_route_minutes=120,
                shift_end=self.day.replace(hour=10),
            )
            for engineer_id, skills in (
                ('E1', {'J', 'A'}),
                ('E2', {'A', 'B'}),
                ('E3', {'B'}),
            )
        }
        jobs = {
            job_id: replace(
                self.jobs[job_id],
                location_id='L0',
                window_end=self.day.replace(hour=8, minute=5),
                required_skill=job_id,
            )
            for job_id in ('J', 'A', 'B')
        }
        dataset = PlanningDataset(
            root=Path('.'),
            dataset_version='test',
            dataset_sha256='d' * 64,
            scenario='TEST',
            timezone_name='Europe/Moscow',
            planning_date='2026-08-17',
            initial_planning_at=self.day.replace(hour=7),
            locations=MappingProxyType({'L0': Coordinate('L0', 55.0, 37.0)}),
            offices=MappingProxyType({'O': Office('O', 'Z1', 'L0')}),
            equipment_catalog=MappingProxyType({}),
            engineers=MappingProxyType(engineers),
            jobs=MappingProxyType(jobs),
            shared_inventory=(),
            events=(),
            commitments=(),
            constraint_policies=MappingProxyType({}),
        )
        routes = {'E1': ('A',), 'E2': ('B',), 'E3': ()}
        candidates = build_candidate_index(dataset)

        def exact_route_valid(engineer_id: str, order: tuple[str, ...]) -> bool:
            proposal = master_from_orders(
                dataset, {engineer_id: order}, set(jobs) - set(order)
            )
            return materialize_exact_initial_plan(
                dataset, proposal, None
            ).status == MaterializationStatus.EXACT_VALID

        report = find_coverage_move(
            dataset, routes, {'J'}, candidates, exact_route_valid,
            max_route_checks=50,
        )
        self.assertIsNotNone(report.move)
        self.assertEqual(report.move.kind, 'EJECTION_CHAIN')
        routes.update(report.move.routes)
        complete = materialize_exact_initial_plan(
            dataset, master_from_orders(dataset, routes, set()), None
        )
        self.assertEqual(complete.status, MaterializationStatus.EXACT_VALID)
        self.assertEqual(complete.validation.violations, ())
        self.assertEqual(
            sum(len(route.visits) for route in complete.plan.engineer_plans), 3
        )


if __name__ == '__main__':
    unittest.main()
