from __future__ import annotations

import hashlib
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import MappingProxyType
from zoneinfo import ZoneInfo

from beeline_planning import (
    EngineerPlan,
    MasterArc,
    MasterEngineerRoute,
    MasterModelInput,
    MasterSolution,
    MasterSolveStatus,
    MasterVisit,
    MaterializationStatus,
    PlannedVisit,
    ProposedPlan,
    RejectionCode,
    SolverConfig,
    ValidationStatus,
    ViolationCode,
    build_candidate_index,
    build_master_model_input,
    load_planning_dataset,
    load_screening_matrices,
    materialize_exact_initial_plan,
    probe_exact_initial_plan_routes,
    solve_screening_master,
    validate_initial_plan,
)
from beeline_planning.errors import InvalidPlanningData
from beeline_planning.domain import (
    Engineer,
    Job,
    JobStatus,
    Office,
    PlanningDataset,
    Priority,
    RequiredTransport,
)
from beeline_planning.eligibility import CandidateIndex
from beeline_routing.models import (
    Coordinate,
    DetailedRoute,
    Provenance,
    RouteStatus,
    RouteStep,
    TransportMode,
)
from beeline_routing.errors import RoutingError
from beeline_routing.oracle import ExactRoutingOracle


DATASET = (
    Path(__file__).parents[1]
    / 'work'
    / 'dataset_v21'
    / 'beeline_synthetic_dataset_v2_1'
)


class PlanningLoaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.core = load_planning_dataset(DATASET, 'core')
        cls.stress = load_planning_dataset(DATASET, 'stress')

    def test_loads_complete_scenarios_and_checksum_identity(self) -> None:
        self.assertEqual(len(self.core.engineers), 35)
        self.assertEqual(len(self.core.jobs), 206)
        self.assertEqual(len(self.stress.jobs), 207)
        self.assertEqual(len(self.core.locations), 200)
        self.assertEqual(len(self.core.events), 1)
        self.assertEqual(len(self.stress.events), 4)
        self.assertEqual(len(self.core.commitments), 0)
        self.assertEqual(len(self.stress.commitments), 1)
        self.assertEqual(self.core.dataset_sha256, self.stress.dataset_sha256)
        self.assertEqual(len(self.core.dataset_sha256), 64)

    def test_initial_candidates_exclude_future_event_jobs(self) -> None:
        candidates = build_candidate_index(self.core)
        self.assertEqual(len(candidates.active_job_ids), 205)
        self.assertNotIn('EAST-EVENT-001', candidates.active_job_ids)

    def test_hard_commitment_is_candidate_exclusion_not_penalty(self) -> None:
        candidates = build_candidate_index(self.stress)
        job_id = 'SOUTHEAST-84466'
        self.assertEqual(
            candidates.eligible_engineers_by_job[job_id],
            ('SOUTHEAST-ENG-01',),
        )
        self.assertIn(
            RejectionCode.HARD_COMMITMENT_TO_OTHER_ENGINEER,
            candidates.reasons('SOUTHEAST-ENG-02', job_id),
        )

    def test_car_requirement_excludes_non_car_engineers(self) -> None:
        candidates = build_candidate_index(self.core)
        job_id = 'EAST-50104'
        self.assertIn(
            RejectionCode.TRANSPORT_MISMATCH,
            candidates.reasons('EAST-ENG-01', job_id),
        )

    def test_checksum_mismatch_is_rejected_before_parsing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'manifest.json').write_text('{}', encoding='utf-8')
            digest = hashlib.sha256((root / 'manifest.json').read_bytes()).hexdigest()
            (root / 'CHECKSUMS.sha256').write_text(
                f'{digest[:-1]}0  manifest.json\n', encoding='utf-8'
            )
            with self.assertRaisesRegex(InvalidPlanningData, 'Checksum mismatch'):
                load_planning_dataset(root, 'core')

    def test_screening_snapshot_is_complete_and_direct_pt_is_used(self) -> None:
        matrices = load_screening_matrices(
            Path(__file__).parents[2] / 'data' / 'screening',
            self.stress,
        )
        self.assertEqual(len(matrices.cells), 54_216)
        estimate = matrices.estimate(
            'EAST',
            self.stress.engineers['EAST-ENG-01'].transport_mode,
            self.stress.offices['OFFICE-EAST'].location_id,
            self.stress.jobs['EAST-74198'].location_id,
        )
        self.assertFalse(estimate.is_surrogate)
        self.assertEqual(estimate.source_mode.value, 'PUBLIC_TRANSIT')

    def test_master_graph_has_all_candidates_and_only_safe_arc_pruning(self) -> None:
        matrices = load_screening_matrices(
            Path(__file__).parents[2] / 'data' / 'screening',
            self.stress,
        )
        model = build_master_model_input(self.stress, matrices)
        self.assertEqual(model.assignment_variable_count, 1341)
        self.assertEqual(model.unserved_variable_count, 205)
        self.assertGreater(model.route_arc_variable_count, model.assignment_variable_count)
        self.assertEqual(
            model.hard_assignments,
            (('SOUTHEAST-ENG-01', 'SOUTHEAST-84466'),),
        )
        start_arcs = [arc for arc in model.arcs if arc.origin_node_id.startswith('START:')]
        self.assertEqual(len(start_arcs), model.assignment_variable_count)


class IndependentValidatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.core = load_planning_dataset(DATASET, 'core')
        cls.stress = load_planning_dataset(DATASET, 'stress')

    @staticmethod
    def _all_unserved(dataset) -> ProposedPlan:
        active = dataset.active_jobs_at(dataset.initial_planning_at)
        return ProposedPlan(
            planning_at=dataset.initial_planning_at,
            engineer_plans=(),
            unserved_job_ids=tuple(job.job_id for job in active),
        )

    def test_all_unserved_is_feasible_when_there_is_no_hard_assignment(self) -> None:
        report = validate_initial_plan(self.core, self._all_unserved(self.core))
        self.assertEqual(report.status, ValidationStatus.VALID)
        self.assertEqual(report.metrics.used_engineers, 0)
        self.assertEqual(
            report.metrics.unserved_normal_jobs + report.metrics.unserved_urgent_jobs,
            205,
        )

    def test_hard_assignment_cannot_be_converted_to_unserved_penalty(self) -> None:
        report = validate_initial_plan(self.stress, self._all_unserved(self.stress))
        self.assertEqual(report.status, ValidationStatus.INVALID)
        self.assertIn(
            ViolationCode.HARD_COMMITMENT_VIOLATED,
            {violation.code for violation in report.violations},
        )

    def test_one_real_route_evidence_and_closed_window_boundary_validate(self) -> None:
        candidates = build_candidate_index(self.core)
        selected = None
        for job_id in candidates.active_job_ids:
            job = self.core.jobs[job_id]
            for engineer_id in candidates.eligible_engineers_by_job[job_id]:
                engineer = self.core.engineers[engineer_id]
                service_start = max(job.window_start, engineer.shift_start + timedelta(minutes=1))
                if (
                    service_start <= job.window_end
                    and service_start + timedelta(minutes=job.service_duration_min) <= engineer.shift_end
                ):
                    selected = (job, engineer, service_start)
                    break
            if selected:
                break
        self.assertIsNotNone(selected)
        job, engineer, service_start = selected
        departure = service_start - timedelta(minutes=1)
        origin_id = self.core.offices[engineer.start_office_id].location_id
        route = DetailedRoute(
            origin_id=origin_id,
            destination_id=job.location_id,
            mode=engineer.transport_mode,
            departure_at=departure,
            status=RouteStatus.OK,
            duration_seconds=60,
            duration_minutes=1,
            distance_m=100,
            geometry=((37.0, 55.0), (37.1, 55.1)),
            itinerary=(
                RouteStep(
                    sequence=1,
                    mode=engineer.transport_mode.value,
                    duration_seconds=60,
                    distance_m=100,
                    waiting_seconds=0,
                    geometry=((37.0, 55.0), (37.1, 55.1)),
                    attributes={},
                ),
            ),
            provider_status='OK',
            provenance=Provenance(
                provider='TEST_EXACT',
                endpoint='test://exact',
                request_sha256='a' * 64,
                response_sha256='b' * 64,
                fetched_at='2026-09-15T00:00:00+00:00',
                cache_hit=False,
                provider_metadata={},
            ),
        )
        unserved = tuple(
            active_job.job_id
            for active_job in self.core.active_jobs_at(self.core.initial_planning_at)
            if active_job.job_id != job.job_id
        )
        plan = ProposedPlan(
            planning_at=self.core.initial_planning_at,
            engineer_plans=(
                EngineerPlan(
                    engineer_id=engineer.engineer_id,
                    visits=(
                        PlannedVisit(
                            job_id=job.job_id,
                            departure_at=departure,
                            service_start_at=service_start,
                            travel=route,
                        ),
                    ),
                ),
            ),
            unserved_job_ids=unserved,
        )
        report = validate_initial_plan(self.core, plan)
        self.assertEqual(report.status, ValidationStatus.VALID, report.violations)
        self.assertEqual(report.metrics.total_distance_m, 100)
        self.assertEqual(report.metrics.total_travel_minutes, 1)


class CpSatMasterTests(unittest.TestCase):
    def test_lexicographic_priority_is_proven_on_tiny_instance(self) -> None:
        timezone = ZoneInfo('Europe/Moscow')
        day = datetime(2026, 8, 17, tzinfo=timezone)
        engineer = Engineer(
            engineer_id='E1',
            zone_id='Z',
            shift_start=day.replace(hour=8),
            shift_end=day.replace(hour=9),
            start_office_id='O1',
            transport_mode=TransportMode.WALKING,
            is_available=True,
            max_jobs=1,
            max_route_minutes=60,
            skills=frozenset({'S'}),
            equipment=(),
        )
        jobs = {
            job_id: Job(
                job_id=job_id,
                zone_id='Z',
                location_id=location_id,
                window_start=day.replace(hour=8),
                window_end=day.replace(hour=8, minute=20),
                created_at=day.replace(hour=7),
                service_duration_min=40,
                priority=priority,
                required_skill='S',
                required_transport=RequiredTransport.ANY,
                required_equipment=(),
                is_event_job=False,
                status=JobStatus.PENDING,
            )
            for job_id, location_id, priority in (
                ('J_NORMAL', 'L1', Priority.NORMAL),
                ('J_URGENT', 'L2', Priority.URGENT),
            )
        }
        dataset = PlanningDataset(
            root=Path('.'),
            dataset_version='2.1.0',
            dataset_sha256='d' * 64,
            scenario='TEST',
            timezone_name='Europe/Moscow',
            planning_date='2026-08-17',
            initial_planning_at=day.replace(hour=7),
            locations=MappingProxyType(
                {
                    'L0': Coordinate('L0', 55.0, 37.0),
                    'L1': Coordinate('L1', 55.1, 37.1),
                    'L2': Coordinate('L2', 55.2, 37.2),
                }
            ),
            offices=MappingProxyType({'O1': Office('O1', 'Z', 'L0')}),
            equipment_catalog=MappingProxyType({}),
            engineers=MappingProxyType({'E1': engineer}),
            jobs=MappingProxyType(jobs),
            shared_inventory=(),
            events=(),
            commitments=(),
            constraint_policies=MappingProxyType({}),
        )
        candidates = CandidateIndex(
            planning_at=day.replace(hour=7),
            active_job_ids=('J_NORMAL', 'J_URGENT'),
            eligible_engineers_by_job=MappingProxyType(
                {'J_NORMAL': ('E1',), 'J_URGENT': ('E1',)}
            ),
            rejection_codes=MappingProxyType({}),
        )
        arcs = tuple(
            MasterArc(
                engineer_id='E1',
                origin_node_id=origin,
                origin_location_id=origin_location,
                destination_job_id=destination,
                destination_location_id=jobs[destination].location_id,
                screening_duration_minutes=5,
                screening_distance_m=100,
                screening_source_mode=TransportMode.WALKING,
                screening_is_surrogate=False,
            )
            for origin, origin_location, destination in (
                ('START:E1', 'L0', 'J_NORMAL'),
                ('START:E1', 'L0', 'J_URGENT'),
                ('J_NORMAL', 'L1', 'J_URGENT'),
                ('J_URGENT', 'L2', 'J_NORMAL'),
            )
        )
        master = MasterModelInput(
            planning_at=day.replace(hour=7),
            candidate_index=candidates,
            arcs=arcs,
            hard_assignments=(),
            screening_snapshot_sha256='s' * 64,
        )
        strict_solution = solve_screening_master(
            dataset,
            master,
            SolverConfig(max_seconds_per_tier=2, full_coverage_seconds=2),
        )
        self.assertEqual(
            strict_solution.status,
            MasterSolveStatus.SCREENING_INFEASIBLE,
        )
        self.assertEqual(strict_solution.routes, ())

        solution = solve_screening_master(
            dataset,
            master,
            SolverConfig(
                max_seconds_per_tier=2,
                require_full_coverage=False,
            ),
        )
        self.assertEqual(solution.status, MasterSolveStatus.SCREENING_OPTIMAL)
        self.assertTrue(solution.all_tiers_proven)
        self.assertEqual(solution.unserved_job_ids, ('J_NORMAL',))
        self.assertEqual(
            [visit.job_id for route in solution.routes for visit in route.visits],
            ['J_URGENT'],
        )
        self.assertEqual(
            solution.routes[0].visits[0].service_start_at,
            day.replace(hour=8, minute=5),
        )
        self.assertEqual(
            [(proof.metric, proof.value) for proof in solution.objective_proofs[:4]],
            [
                ('unserved_urgent_jobs', 0),
                ('unserved_normal_jobs', 1),
                ('used_engineers', 1),
                ('urgent_response_minutes', 65),
            ],
        )

        polished = solve_screening_master(
            dataset,
            master,
            SolverConfig(
                max_seconds_per_tier=2,
                require_full_coverage=False,
                fixed_unserved_by_priority=(0, 1),
            ),
            hint_solution=solution,
        )
        self.assertEqual(
            polished.status,
            MasterSolveStatus.SCREENING_FEASIBLE,
        )
        self.assertEqual(polished.unserved_job_ids, ('J_NORMAL',))
        self.assertEqual(
            [(proof.metric, proof.value) for proof in polished.objective_proofs[:3]],
            [
                ('unserved_urgent_jobs', 0),
                ('unserved_normal_jobs', 1),
                ('used_engineers', 1),
            ],
        )
        self.assertFalse(polished.objective_proofs[0].proven_optimal)
        self.assertFalse(polished.objective_proofs[1].proven_optimal)

        impossible_reduction = solve_screening_master(
            dataset,
            master,
            SolverConfig(
                max_seconds_per_tier=2,
                require_full_coverage=False,
                fixed_unserved_by_priority=(0, 1),
                max_used_engineers=0,
            ),
            hint_solution=solution,
        )
        self.assertEqual(
            impossible_reduction.status,
            MasterSolveStatus.SCREENING_INFEASIBLE,
        )
        self.assertEqual(impossible_reduction.routes, ())


class ExactMaterializationTests(unittest.TestCase):
    def test_master_values_are_replaced_by_exact_route_evidence(self) -> None:
        dataset = load_planning_dataset(DATASET, 'core')
        candidates = build_candidate_index(dataset)
        selection = next(
            (dataset.jobs[job_id], dataset.engineers[engineer_id])
            for job_id in candidates.active_job_ids
            for engineer_id in candidates.eligible_engineers_by_job[job_id]
            if max(
                dataset.jobs[job_id].window_start,
                dataset.engineers[engineer_id].shift_start + timedelta(minutes=1),
            )
            + timedelta(minutes=dataset.jobs[job_id].service_duration_min)
            <= dataset.engineers[engineer_id].shift_end
        )
        job, engineer = selection
        service_start = max(job.window_start, engineer.shift_start + timedelta(minutes=1))
        departure = service_start - timedelta(minutes=1)
        origin_id = dataset.offices[engineer.start_office_id].location_id
        unserved = tuple(
            active.job_id
            for active in dataset.active_jobs_at(dataset.initial_planning_at)
            if active.job_id != job.job_id
        )
        solution = MasterSolution(
            status=MasterSolveStatus.SCREENING_FEASIBLE,
            planning_at=dataset.initial_planning_at,
            routes=(
                MasterEngineerRoute(
                    engineer_id=engineer.engineer_id,
                    visits=(
                        MasterVisit(
                            sequence=1,
                            job_id=job.job_id,
                            origin_node_id=f'START:{engineer.engineer_id}',
                            departure_at=departure,
                            service_start_at=service_start,
                            screening_duration_minutes=999,
                            screening_distance_m=999_999,
                            screening_source_mode='WALKING',
                            screening_is_surrogate=True,
                        ),
                    ),
                ),
            ),
            unserved_job_ids=unserved,
            objective_proofs=(),
            dataset_sha256=dataset.dataset_sha256,
            screening_snapshot_sha256='s' * 64,
            solver_version='test',
            search_graph_complete=False,
            searched_arc_count=1,
            operationally_excluded_arcs=(),
        )

        class ExactClient:
            def route(self, *, origin, destination, mode, departure_at, refresh=False):
                return DetailedRoute(
                    origin_id=origin.location_id,
                    destination_id=destination.location_id,
                    mode=mode,
                    departure_at=departure_at,
                    status=RouteStatus.OK,
                    duration_seconds=60,
                    duration_minutes=1,
                    distance_m=123,
                    geometry=((37.0, 55.0), (37.1, 55.1)),
                    itinerary=(
                        RouteStep(
                            sequence=1,
                            mode=mode.value,
                            duration_seconds=60,
                            distance_m=123,
                            waiting_seconds=0,
                            geometry=((37.0, 55.0), (37.1, 55.1)),
                            attributes={},
                        ),
                    ),
                    provider_status='OK',
                    provenance=Provenance(
                        provider='TEST_EXACT',
                        endpoint='test://exact',
                        request_sha256='a' * 64,
                        response_sha256='b' * 64,
                        fetched_at='2026-09-15T00:00:00+00:00',
                        cache_hit=False,
                        provider_metadata={},
                    ),
                )

        result = materialize_exact_initial_plan(
            dataset,
            solution,
            ExactRoutingOracle(ExactClient()),
        )
        self.assertEqual(result.status, MaterializationStatus.EXACT_VALID)
        self.assertIsNotNone(result.validation)
        self.assertEqual(result.validation.metrics.total_distance_m, 123)
        self.assertNotEqual(result.validation.metrics.total_distance_m, 999_999)

    def test_probe_continues_with_other_engineers_after_one_route_fails(self) -> None:
        timezone = ZoneInfo('Europe/Moscow')
        day = datetime(2026, 8, 17, tzinfo=timezone)
        engineers = {
            engineer_id: Engineer(
                engineer_id=engineer_id,
                zone_id='Z',
                shift_start=day.replace(hour=8),
                shift_end=day.replace(hour=18),
                start_office_id=office_id,
                transport_mode=TransportMode.WALKING,
                is_available=True,
                max_jobs=2,
                max_route_minutes=600,
                skills=frozenset({'S'}),
                equipment=(),
            )
            for engineer_id, office_id in (('E1', 'O1'), ('E2', 'O2'))
        }
        jobs = {
            job_id: Job(
                job_id=job_id,
                zone_id='Z',
                location_id=location_id,
                window_start=day.replace(hour=8),
                window_end=day.replace(hour=17),
                created_at=day.replace(hour=7),
                service_duration_min=30,
                priority=Priority.NORMAL,
                required_skill='S',
                required_transport=RequiredTransport.ANY,
                required_equipment=(),
                is_event_job=False,
                status=JobStatus.PENDING,
            )
            for job_id, location_id in (('J1', 'L1'), ('J2', 'L2'))
        }
        dataset = PlanningDataset(
            root=Path('.'),
            dataset_version='test',
            dataset_sha256='d' * 64,
            scenario='TEST',
            timezone_name='Europe/Moscow',
            planning_date='2026-08-17',
            initial_planning_at=day.replace(hour=7),
            locations=MappingProxyType(
                {
                    'S1': Coordinate('S1', 55.0, 37.0),
                    'S2': Coordinate('S2', 55.1, 37.1),
                    'L1': Coordinate('L1', 55.2, 37.2),
                    'L2': Coordinate('L2', 55.3, 37.3),
                }
            ),
            offices=MappingProxyType(
                {
                    'O1': Office('O1', 'Z', 'S1'),
                    'O2': Office('O2', 'Z', 'S2'),
                }
            ),
            equipment_catalog=MappingProxyType({}),
            engineers=MappingProxyType(engineers),
            jobs=MappingProxyType(jobs),
            shared_inventory=(),
            events=(),
            commitments=(),
            constraint_policies=MappingProxyType({}),
        )
        routes = tuple(
            MasterEngineerRoute(
                engineer_id=engineer_id,
                visits=(
                    MasterVisit(
                        sequence=1,
                        job_id=job_id,
                        origin_node_id=f'START:{engineer_id}',
                        departure_at=day.replace(hour=8),
                        service_start_at=day.replace(hour=8, minute=1),
                        screening_duration_minutes=1,
                        screening_distance_m=1,
                        screening_source_mode='WALKING',
                        screening_is_surrogate=False,
                    ),
                ),
            )
            for engineer_id, job_id in (('E1', 'J1'), ('E2', 'J2'))
        )
        solution = MasterSolution(
            status=MasterSolveStatus.SCREENING_FEASIBLE,
            planning_at=dataset.initial_planning_at,
            routes=routes,
            unserved_job_ids=(),
            objective_proofs=(),
            dataset_sha256=dataset.dataset_sha256,
            screening_snapshot_sha256='s' * 64,
            solver_version='test',
            search_graph_complete=False,
            searched_arc_count=2,
            operationally_excluded_arcs=(),
        )

        class OneFailureClient:
            def route(self, *, origin, destination, mode, departure_at, refresh=False):
                if origin.location_id == 'S1':
                    raise RoutingError('provider timeout')
                return DetailedRoute(
                    origin_id=origin.location_id,
                    destination_id=destination.location_id,
                    mode=mode,
                    departure_at=departure_at,
                    status=RouteStatus.OK,
                    duration_seconds=60,
                    duration_minutes=1,
                    distance_m=100,
                    geometry=((37.0, 55.0), (37.1, 55.1)),
                    itinerary=(
                        RouteStep(
                            sequence=1,
                            mode=mode.value,
                            duration_seconds=60,
                            distance_m=100,
                            waiting_seconds=0,
                            geometry=((37.0, 55.0), (37.1, 55.1)),
                            attributes={},
                        ),
                    ),
                    provider_status='OK',
                    provenance=Provenance(
                        provider='TEST_EXACT',
                        endpoint='test://exact',
                        request_sha256='a' * 64,
                        response_sha256='b' * 64,
                        fetched_at='2026-09-15T00:00:00+00:00',
                        cache_hit=False,
                        provider_metadata={},
                    ),
                )

        checkpoints = []
        report = probe_exact_initial_plan_routes(
            dataset,
            solution,
            ExactRoutingOracle(OneFailureClient()),
            on_progress=checkpoints.append,
        )
        self.assertEqual(report.exact_provider_queries, 2)
        self.assertEqual(report.complete_engineer_ids, ('E2',))
        self.assertEqual(len(report.failures), 1)
        self.assertEqual(report.failures[0].engineer_id, 'E1')
        self.assertEqual(report.failures[0].origin_node_id, 'START:E1')
        self.assertEqual(report.failures[0].kind.value, 'UNKNOWN')
        self.assertEqual(len(checkpoints), 2)
        self.assertEqual(len(checkpoints[0].failures), 1)
        self.assertEqual(checkpoints[1], report)
        resumed = probe_exact_initial_plan_routes(
            dataset,
            solution,
            ExactRoutingOracle(OneFailureClient()),
            resume_from=checkpoints[0],
        )
        self.assertEqual(resumed, report)


if __name__ == '__main__':
    unittest.main()
