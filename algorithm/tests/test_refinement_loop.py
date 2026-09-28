from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from beeline_planning import (
    MasterEngineerRoute,
    MasterArc,
    MasterModelInput,
    MasterSolution,
    MasterSolveStatus,
    MasterVisit,
    ExactArcObservation,
    ExactRefinementFailure,
    ExactRefinementReport,
    RefinementFailureKind,
    apply_refinement_report,
    apply_schedule_failure_assignment_cuts,
    apply_schedule_failure_route_conflicts,
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
from tools import refine_screening_exact as refinement_tool


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

    def test_reuses_only_identical_route_reports(self) -> None:
        calls = []

        def make_oracle():
            calls.append(1)
            return ExactRoutingOracle(_Client(RouteStatus.OK, 7))

        cache = {}
        candidate = self.candidate()
        first = refinement_tool._inspect_parallel(
            self.dataset, candidate, make_oracle, 1,
            route_report_cache=cache,
        )
        stats = {}
        second = refinement_tool._inspect_parallel(
            self.dataset, candidate, make_oracle, 1,
            route_report_cache=cache, stats=stats,
        )
        self.assertEqual(len(calls), 1)
        self.assertEqual(second.observations, first.observations)
        self.assertEqual(second.complete_engineer_ids, first.complete_engineer_ids)
        self.assertEqual(second.exact_provider_queries, 0)
        self.assertEqual(stats, {'reused_routes': 1, 'checked_routes': 0})

        route = candidate.routes[0]
        changed = replace(candidate, routes=(replace(
            route,
            visits=(replace(route.visits[0], screening_duration_minutes=3),),
        ),))
        third = refinement_tool._inspect_parallel(
            self.dataset, changed, make_oracle, 1,
            route_report_cache=cache,
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(third.observations[0].screening_duration_minutes, 3)

    def test_unknown_route_is_rechecked(self) -> None:
        calls = []

        def make_oracle():
            calls.append(1)
            return ExactRoutingOracle(_Client(RouteStatus.UNKNOWN))

        cache = {}
        for _ in range(2):
            report = refinement_tool._inspect_parallel(
                self.dataset, self.candidate(), make_oracle, 1,
                route_report_cache=cache,
            )
            self.assertEqual(report.failures[0].kind, RefinementFailureKind.ROUTING_UNKNOWN)
        self.assertEqual(len(calls), 2)
        self.assertFalse(cache)

    def test_zone_master_cache_patches_only_exact_duration_arcs(self) -> None:
        engineer = self.engineer
        job = self.job
        arc = MasterArc(
            engineer.engineer_id,
            f'START:{engineer.engineer_id}',
            self.dataset.offices[engineer.start_office_id].location_id,
            job.job_id,
            job.location_id,
            2,
            50,
            engineer.transport_mode,
            True,
        )
        master = MasterModelInput(
            self.dataset.initial_planning_at,
            build_candidate_index(self.dataset),
            (arc,),
            (),
            's' * 64,
        )
        with patch.object(
            refinement_tool, 'build_master_model_input', return_value=master,
        ) as builder:
            cache = refinement_tool._ZoneMasterCache(self.dataset, object())
            context = cache.get(job.zone_id)
            self.assertIs(cache.get(job.zone_id), context)
            self.assertIs(context.with_overrides({}), master)
            key = (engineer.engineer_id, arc.origin_node_id, job.job_id)
            adjusted = context.with_overrides({key: 9})
            self.assertEqual(adjusted.arcs[0].screening_duration_minutes, 9)
            self.assertFalse(adjusted.arcs[0].screening_is_surrogate)
            self.assertEqual(master.arcs[0].screening_duration_minutes, 2)
            self.assertIsNot(adjusted, master)
            with self.assertRaisesRegex(ValueError, 'absent from zone graph'):
                context.with_overrides({(engineer.engineer_id, 'missing', job.job_id): 9})
            self.assertEqual(builder.call_count, 1)


class RefinementActionTests(unittest.TestCase):
    def test_schedule_cuts_are_added_incrementally_per_zone(self) -> None:
        first = ExactRefinementFailure(
            RefinementFailureKind.WINDOW, 'E1', 'EAST', 'J0', 'J1',
            '2026-08-17T10:00:00+03:00', 'first',
        )
        second = replace(first, destination_job_id='J2', reason='second')
        other_zone = replace(first, engineer_id='E2', zone_id='SOUTHEAST')
        routing_error = replace(
            second, kind=RefinementFailureKind.ROUTING_UNKNOWN,
        )
        self.assertEqual(
            refinement_tool._bounded_conflict_failures(
                (first, second, other_zone, routing_error)
            ),
            (first, other_zone, routing_error),
        )

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

    def test_schedule_failure_creates_generic_assignment_cut(self) -> None:
        _, report = self.report(RefinementFailureKind.WINDOW, observation=True)
        cuts: set[tuple[str, str]] = set()
        action = apply_schedule_failure_assignment_cuts(
            report,
            assignment_cuts=cuts,
        )
        self.assertEqual(action.new_cuts, (('E1', 'J1'),))
        self.assertEqual(action.changed_zones, frozenset({'EAST'}))
        self.assertIn(('E1', 'J1'), cuts)
        resumed = apply_schedule_failure_assignment_cuts(
            report,
            assignment_cuts=cuts,
        )
        self.assertFalse(resumed.new_cuts)
        self.assertEqual(resumed.changed_zones, frozenset({'EAST'}))

    def test_forced_assignment_is_never_cut(self) -> None:
        _, report = self.report(RefinementFailureKind.SHIFT, observation=False)
        cuts: set[tuple[str, str]] = set()
        action = apply_schedule_failure_assignment_cuts(
            report,
            assignment_cuts=cuts,
            protected_assignments=frozenset({('E1', 'J1')}),
        )
        self.assertFalse(action.new_cuts)
        self.assertEqual(action.protected_failures, report.failures)
        self.assertFalse(cuts)

    def test_schedule_failure_forbids_only_failed_route_prefix(self) -> None:
        _, report = self.report(RefinementFailureKind.WINDOW, observation=True)
        moment = datetime.fromisoformat('2026-08-17T10:00:00+03:00')
        candidate = MasterSolution(
            MasterSolveStatus.SCREENING_FEASIBLE,
            moment,
            (
                MasterEngineerRoute(
                    'E1',
                    (
                        MasterVisit(1, 'J0', 'START:E1', moment, moment, 0, 0, 'WALKING', False),
                        MasterVisit(2, 'J1', 'J0', moment, moment, 0, 0, 'WALKING', False),
                    ),
                ),
            ),
            (),
            (),
            'd' * 64,
            's' * 64,
            'test',
            False,
            0,
            (),
        )
        groups: set[tuple[tuple[str, str, str], ...]] = set()
        assignment_groups: set[tuple[tuple[str, str], ...]] = set()
        action = apply_schedule_failure_route_conflicts(
            report,
            candidate,
            conflict_groups=groups,
            assignment_conflict_groups=assignment_groups,
        )
        expected = (
            ('E1', 'START:E1', 'J0'),
            ('E1', 'J0', 'J1'),
        )
        self.assertEqual(action.new_groups, (expected,))
        self.assertEqual(groups, {expected})
        self.assertFalse(action.new_assignment_groups)

        reverse_failure = ExactRefinementFailure(
            RefinementFailureKind.WINDOW,
            'E1',
            'EAST',
            'J1',
            'J0',
            moment.isoformat(),
            'test',
        )
        reverse_report = ExactRefinementReport(
            (), (reverse_failure,), (), 1, 0
        )
        reverse_candidate = MasterSolution(
            MasterSolveStatus.SCREENING_FEASIBLE,
            moment,
            (
                MasterEngineerRoute(
                    'E1',
                    (
                        MasterVisit(1, 'J1', 'START:E1', moment, moment, 0, 0, 'WALKING', False),
                        MasterVisit(2, 'J0', 'J1', moment, moment, 0, 0, 'WALKING', False),
                    ),
                ),
            ),
            (),
            (),
            'd' * 64,
            's' * 64,
            'test',
            False,
            0,
            (),
        )
        reverse_action = apply_schedule_failure_route_conflicts(
            reverse_report,
            reverse_candidate,
            conflict_groups=groups,
            assignment_conflict_groups=assignment_groups,
        )
        self.assertEqual(
            reverse_action.new_assignment_groups,
            ((('E1', 'J0'), ('E1', 'J1')),),
        )


if __name__ == '__main__':
    unittest.main()
