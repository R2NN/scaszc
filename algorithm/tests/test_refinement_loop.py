from __future__ import annotations

import unittest
from datetime import timedelta
from pathlib import Path

from beeline_planning import (
    MasterEngineerRoute,
    MasterSolution,
    MasterSolveStatus,
    MasterVisit,
    ExactArcObservation,
    ExactRefinementFailure,
    ExactRefinementReport,
    RefinementFailureKind,
    apply_refinement_report,
    build_candidate_index,
    inspect_exact_candidate,
    load_planning_dataset,
)
from beeline_routing.models import (
    DetailedRoute,
    Provenance,
    RouteStatus,
    RouteStep,
)
from beeline_routing.oracle import ExactRoutingOracle


DATASET = Path(__file__).parents[1] / 'work/dataset_v21/beeline_synthetic_dataset_v2_1'


class _Client:
    def __init__(self, status: RouteStatus, duration_minutes: int = 7) -> None:
        self.status = status
        self.duration_minutes = duration_minutes

    def route(self, *, origin, destination, mode, departure_at, refresh=False):
        if self.status != RouteStatus.OK:
            return DetailedRoute(
                origin.location_id,
                destination.location_id,
                mode,
                departure_at,
                self.status,
                None,
                None,
                None,
                (),
                (),
                self.status.value,
                Provenance('TEST', 'test', 'request', 'response', 'now', False, {}),
            )
        seconds = self.duration_minutes * 60
        geometry = ((37.0, 55.0), (37.1, 55.1))
        return DetailedRoute(
            origin.location_id,
            destination.location_id,
            mode,
            departure_at,
            RouteStatus.OK,
            seconds,
            self.duration_minutes,
            100,
            geometry,
            (RouteStep(1, mode.value, seconds, 100, 0, geometry, {}),),
            'OK',
            Provenance('TEST', 'test', 'request', 'response', 'now', False, {}),
        )


class ExactRefinementInspectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dataset = load_planning_dataset(DATASET, 'core')
        candidates = build_candidate_index(cls.dataset)
        cls.job, cls.engineer = next(
            (cls.dataset.jobs[job_id], cls.dataset.engineers[engineer_id])
            for job_id in candidates.active_job_ids
            for engineer_id in candidates.eligible_engineers_by_job[job_id]
            if max(
                cls.dataset.initial_planning_at,
                cls.dataset.engineers[engineer_id].shift_start,
                cls.dataset.jobs[job_id].created_at,
            ) + timedelta(minutes=7) <= cls.dataset.jobs[job_id].window_end
        )

    def candidate(self) -> MasterSolution:
        job = self.job
        engineer = self.engineer
        visit = MasterVisit(
            sequence=1,
            job_id=job.job_id,
            origin_node_id=f'START:{engineer.engineer_id}',
            departure_at=max(
                self.dataset.initial_planning_at,
                engineer.shift_start,
                job.created_at,
            ),
            service_start_at=job.window_start,
            screening_duration_minutes=2,
            screening_distance_m=50,
            screening_source_mode=engineer.transport_mode.value,
            screening_is_surrogate=False,
        )
        return MasterSolution(
            MasterSolveStatus.SCREENING_FEASIBLE,
            self.dataset.initial_planning_at,
            (MasterEngineerRoute(engineer.engineer_id, (visit,)),),
            tuple(
                item.job_id
                for item in self.dataset.active_jobs_at(self.dataset.initial_planning_at)
                if item.job_id != job.job_id
            ),
            (),
            self.dataset.dataset_sha256,
            's' * 64,
            'test',
            False,
            1,
            (),
        )

    def test_records_exact_duration_larger_than_screening(self) -> None:
        report = inspect_exact_candidate(
            self.dataset,
            self.candidate(),
            ExactRoutingOracle(_Client(RouteStatus.OK, 7)),
        )
        self.assertFalse(report.failures)
        self.assertEqual(len(report.observations), 1)
        self.assertEqual(report.observations[0].screening_duration_minutes, 2)
        self.assertEqual(report.observations[0].exact_duration_minutes, 7)

    def test_unreachable_arc_becomes_actionable_failure(self) -> None:
        report = inspect_exact_candidate(
            self.dataset,
            self.candidate(),
            ExactRoutingOracle(_Client(RouteStatus.UNREACHABLE)),
        )
        self.assertEqual(report.failures[0].kind, RefinementFailureKind.UNREACHABLE)
        self.assertEqual(report.failures[0].destination_job_id, self.job.job_id)

    def test_exact_schedule_violation_has_no_good_kind(self) -> None:
        report = inspect_exact_candidate(
            self.dataset,
            self.candidate(),
            ExactRoutingOracle(_Client(RouteStatus.OK, 24 * 60)),
        )
        self.assertIn(
            report.failures[0].kind,
            {RefinementFailureKind.WINDOW, RefinementFailureKind.SHIFT},
        )


class RefinementActionTests(unittest.TestCase):
    def report(self, kind: RefinementFailureKind, *, observation: bool):
        arc = ('E1', 'J0', 'J1')
        observations = (
            ExactArcObservation('E1', 'EAST', 'J0', 'J1', '2026-08-17T10:00:00+03:00', 4, 9, 100),
        ) if observation else ()
        failure = ExactRefinementFailure(
            kind,
            'E1',
            'EAST',
            'J0',
            'J1',
            '2026-08-17T10:00:00+03:00',
            'test',
        )
        return arc, ExactRefinementReport(observations, (failure,), (), 1, 0)

    def test_duration_is_tightened_before_repeated_schedule_arc_is_cut(self) -> None:
        arc, report = self.report(RefinementFailureKind.WINDOW, observation=True)
        overrides: dict[tuple[str, str, str], int] = {}
        cuts: set[tuple[str, str, str]] = set()
        counts: dict[tuple[str, tuple[str, str, str]], int] = {}
        first = apply_refinement_report(
            report,
            duration_overrides=overrides,
            cuts=cuts,
            failure_counts=counts,
            max_unknown_retries=2,
        )
        self.assertEqual(overrides[arc], 9)
        self.assertFalse(first.new_cuts)
        second = apply_refinement_report(
            report,
            duration_overrides=overrides,
            cuts=cuts,
            failure_counts=counts,
            max_unknown_retries=2,
        )
        self.assertEqual(second.new_cuts, (arc,))
        self.assertIn(arc, cuts)

    def test_unreachable_is_cut_but_unknown_is_only_retried(self) -> None:
        arc, unreachable = self.report(
            RefinementFailureKind.UNREACHABLE,
            observation=False,
        )
        overrides: dict[tuple[str, str, str], int] = {}
        cuts: set[tuple[str, str, str]] = set()
        counts: dict[tuple[str, tuple[str, str, str]], int] = {}
        action = apply_refinement_report(
            unreachable,
            duration_overrides=overrides,
            cuts=cuts,
            failure_counts=counts,
            max_unknown_retries=2,
        )
        self.assertEqual(action.new_cuts, (arc,))

        unknown_arc, unknown = self.report(
            RefinementFailureKind.ROUTING_UNKNOWN,
            observation=False,
        )
        cuts.clear()
        for _ in range(2):
            action = apply_refinement_report(
                unknown,
                duration_overrides=overrides,
                cuts=cuts,
                failure_counts=counts,
                max_unknown_retries=2,
            )
            self.assertFalse(action.blocked_unknown)
        action = apply_refinement_report(
            unknown,
            duration_overrides=overrides,
            cuts=cuts,
            failure_counts=counts,
            max_unknown_retries=2,
        )
        self.assertTrue(action.blocked_unknown)
        self.assertNotIn(unknown_arc, cuts)


if __name__ == '__main__':
    unittest.main()
