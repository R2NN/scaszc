from __future__ import annotations

import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import MappingProxyType
from zoneinfo import ZoneInfo

from beeline_planning import MaterializationStatus, build_exact_fcfs_baseline
from beeline_planning.domain import (
    Engineer,
    Equipment,
    EquipmentNeed,
    Job,
    JobStatus,
    Office,
    PlanningDataset,
    Priority,
    RequiredTransport,
    SharedInventory,
)
from beeline_routing.models import Coordinate, TransportMode


class _UnusedOracle:
    def query(self, request):  # pragma: no cover - a failure makes the test fail directly
        raise AssertionError(f'Identity-only fixture unexpectedly queried routing: {request}')


class ExactFcfsBaselineTests(unittest.TestCase):
    def setUp(self) -> None:
        timezone = ZoneInfo('Europe/Moscow')
        self.start = datetime(2026, 8, 17, 7, tzinfo=timezone)
        office = Office('OFFICE', 'ZONE', 'LOC')
        location = Coordinate('LOC', 55.75, 37.61)
        equipment = {
            'TOOL': Equipment('TOOL', 'tool', True, False),
            'MODEM': Equipment('MODEM', 'device', False, True),
        }
        engineers = {
            'E1': Engineer(
                'E1', 'ZONE', self.start, self.start + timedelta(hours=10),
                'OFFICE', TransportMode.WALKING, True, 1, 600,
                frozenset({'INSTALL'}), (EquipmentNeed('TOOL', 1),),
            ),
            'E2': Engineer(
                'E2', 'ZONE', self.start, self.start + timedelta(hours=10),
                'OFFICE', TransportMode.WALKING, True, 10, 600,
                frozenset({'INSTALL'}), (EquipmentNeed('TOOL', 1),),
            ),
        }
        jobs = {
            job_id: Job(
                job_id, 'ZONE', 'LOC', self.start, self.start + timedelta(hours=8),
                self.start, 30, Priority.NORMAL, 'INSTALL', RequiredTransport.ANY,
                (EquipmentNeed('MODEM', 1),), False, JobStatus.PENDING,
            )
            for job_id in ('J2', 'J1')
        }
        self.dataset = PlanningDataset(
            root=Path('.'), dataset_version='2.1.0', dataset_sha256='x' * 64,
            scenario='core', timezone_name='Europe/Moscow', planning_date='2026-08-17',
            initial_planning_at=self.start,
            locations=MappingProxyType({'LOC': location}),
            offices=MappingProxyType({'OFFICE': office}),
            equipment_catalog=MappingProxyType(equipment),
            engineers=MappingProxyType(engineers), jobs=MappingProxyType(jobs),
            shared_inventory=(SharedInventory('ZONE', 'MODEM', 2),),
            events=(), commitments=(), constraint_policies=MappingProxyType({}),
        )

    def test_keeps_source_order_and_uses_first_feasible_engineer(self) -> None:
        result = build_exact_fcfs_baseline(self.dataset, _UnusedOracle())

        self.assertEqual(result.status, MaterializationStatus.EXACT_VALID)
        self.assertEqual(result.validation.status.value, 'VALID')
        self.assertEqual(
            [(route.engineer_id, [visit.job_id for visit in route.visits])
             for route in result.plan.engineer_plans],
            [('E1', ['J2']), ('E2', ['J1'])],
        )
        self.assertEqual(result.identity_legs, 2)
        self.assertEqual(result.exact_provider_queries, 0)

    def test_shared_inventory_is_reserved_in_fcfs_order(self) -> None:
        constrained = PlanningDataset(
            root=self.dataset.root,
            dataset_version=self.dataset.dataset_version,
            dataset_sha256=self.dataset.dataset_sha256,
            scenario=self.dataset.scenario,
            timezone_name=self.dataset.timezone_name,
            planning_date=self.dataset.planning_date,
            initial_planning_at=self.dataset.initial_planning_at,
            locations=self.dataset.locations,
            offices=self.dataset.offices,
            equipment_catalog=self.dataset.equipment_catalog,
            engineers=self.dataset.engineers,
            jobs=self.dataset.jobs,
            shared_inventory=(SharedInventory('ZONE', 'MODEM', 1),),
            events=(), commitments=(), constraint_policies=self.dataset.constraint_policies,
        )

        result = build_exact_fcfs_baseline(constrained, _UnusedOracle())

        self.assertEqual(result.status, MaterializationStatus.EXACT_VALID)
        self.assertEqual(result.plan.unserved_job_ids, ('J1',))
        self.assertEqual(result.validation.metrics.served_normal_jobs, 1)
        self.assertEqual(result.validation.metrics.unserved_normal_jobs, 1)


if __name__ == '__main__':
    unittest.main()
