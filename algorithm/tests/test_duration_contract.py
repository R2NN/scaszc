from __future__ import annotations

import hashlib
import json
import unittest
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from types import MappingProxyType
from zoneinfo import ZoneInfo

from beeline_planning.domain import Engineer, Job, JobStatus, Office, PlanningDataset, Priority, RequiredTransport
from beeline_planning.duration_contract import verify_duration_snapshot
from beeline_planning.eligibility import build_candidate_index
from beeline_planning.errors import InvalidPlanningData
from beeline_planning.master import MasterArc, MasterModelInput
from beeline_planning.plan import EngineerPlan, IdentityTravel, PlannedVisit, ProposedPlan
from beeline_planning.solver import SolverConfig, solve_screening_master
from beeline_planning.validator import ValidationStatus, ViolationCode, validate_initial_plan
from beeline_planning.loader import load_planning_dataset
from beeline_planning.export import load_exact_plan_artifact
from beeline_routing.models import Coordinate, TransportMode


def scenario(minutes: int):
    at = datetime(2026, 8, 17, 7, tzinfo=ZoneInfo('Europe/Moscow'))
    engineer = Engineer('E', 'Z', at.replace(hour=8), at.replace(hour=9), 'O', TransportMode.WALKING, True, 10, 60, frozenset({'LOCAL'}), ())
    jobs = {key: Job(key, 'Z', 'L', at.replace(hour=8), at.replace(hour=8, minute=59), at, minutes, Priority.NORMAL, 'LOCAL', RequiredTransport.ANY, (), False, JobStatus.PENDING, minutes, f'forecast-{key}') for key in ['A', 'B']}
    return PlanningDataset(Path('.'), '2.1.0', 'a' * 64, 'TEST', 'Europe/Moscow', '2026-08-17', at,
                           MappingProxyType({'L': Coordinate('L', 55.75, 37.62)}),
                           MappingProxyType({'O': Office('O', 'Z', 'L')}), MappingProxyType({}),
                           MappingProxyType({'E': engineer}), MappingProxyType(jobs), (), (), (), MappingProxyType({}))


class DurationContractTests(unittest.TestCase):
    def test_retained_august_candidate_matches_all_authoritative_durations(self):
        root = Path(__file__).resolve().parents[2]
        data = load_planning_dataset(root / 'data/object-complexity/dataset', 'core')
        plan, raw = load_exact_plan_artifact(root / 'algorithm/artifacts/complexity/initial-exact.json', data.dataset_sha256)
        report = validate_initial_plan(data, plan)
        self.assertTrue(report.is_valid, report.violations)
        self.assertEqual(sum(len(route.visits) for route in plan.engineer_plans), 193)
        self.assertEqual(len(plan.unserved_job_ids), 12)
        self.assertTrue(all(job.duration_snapshot_id for job in data.jobs.values()))
        self.assertEqual(report.metrics.total_travel_minutes, raw['validation']['metrics']['total_travel_minutes'])
        mirror = json.loads((data.root / 'core/dataset.json').read_text(encoding='utf-8'))
        self.assertEqual({job['job_id']: job['service_duration_min'] for job in mirror['jobs']}, {key: job.service_duration_min for key, job in data.jobs.items()})

    def test_signed_identity_is_checked_and_ui_minutes_cannot_shrink(self):
        content = {'orderId': 'A', 'modelVersion': 'duration-1', 'total': 45, 'units': 'minutes', 'travelIncluded': False}
        identity = hashlib.sha256(json.dumps(content, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        snapshot = {'id': identity, **content}
        self.assertEqual(verify_duration_snapshot(snapshot, 45), (45, identity))
        with self.assertRaises(InvalidPlanningData):
            verify_duration_snapshot(snapshot, 1)
        with self.assertRaises(InvalidPlanningData):
            verify_duration_snapshot({**snapshot, 'total': 1}, 1)

    def test_shorter_duration_frees_an_actual_cp_sat_slot(self):
        assigned = []
        for minutes in [40, 20]:
            data = scenario(minutes)
            index = build_candidate_index(data)
            arcs = tuple(MasterArc('E', origin, 'L', target, 'L', 0, 0, TransportMode.WALKING, False)
                         for origin, target in [('START:E', 'A'), ('START:E', 'B'), ('A', 'B'), ('B', 'A')])
            master = MasterModelInput(data.initial_planning_at, index, arcs, (), 'x' * 64)
            result = solve_screening_master(data, master, SolverConfig(max_seconds_per_tier=1, full_coverage_seconds=1, require_full_coverage=False))
            assigned.append(sum(len(route.visits) for route in result.routes))
        self.assertEqual(assigned, [1, 2])

    def test_independent_validation_rejects_duration_tampering_and_longer_schedule(self):
        data = scenario(20)
        at = data.initial_planning_at.replace(hour=8)
        second = at + timedelta(minutes=20)
        plan = ProposedPlan(data.initial_planning_at, (EngineerPlan('E', (PlannedVisit('A', at, at, IdentityTravel('L', at)), PlannedVisit('B', second, second, IdentityTravel('L', second)))),), ())
        self.assertEqual(validate_initial_plan(data, plan).status, ValidationStatus.VALID)
        increased = replace(data, jobs=MappingProxyType({key: replace(job, service_duration_min=40, authoritative_duration_min=40) for key, job in data.jobs.items()}))
        report = validate_initial_plan(increased, plan)
        self.assertEqual(report.status, ValidationStatus.INVALID)
        self.assertIn(ViolationCode.DEPARTURE_BEFORE_PREVIOUS_COMPLETION, {item.code for item in report.violations})
        tampered = replace(data, jobs=MappingProxyType({key: replace(job, service_duration_min=1) for key, job in data.jobs.items()}))
        report = validate_initial_plan(tampered, plan)
        self.assertIn(ViolationCode.DURATION_SNAPSHOT_MISMATCH, {item.code for item in report.violations})

    def test_customer_window_constrains_start_not_finish(self):
        data = scenario(40)
        data = replace(data, jobs=MappingProxyType({'A': replace(data.jobs['A'], window_end=data.initial_planning_at.replace(hour=8, minute=10))}))
        at = data.initial_planning_at.replace(hour=8, minute=10)
        plan = ProposedPlan(data.initial_planning_at, (EngineerPlan('E', (PlannedVisit('A', at, at, IdentityTravel('L', at)),)),), ())
        self.assertEqual(validate_initial_plan(data, plan).status, ValidationStatus.VALID)
