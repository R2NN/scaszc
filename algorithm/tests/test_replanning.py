from __future__ import annotations

import unittest
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from beeline_planning import (
    EngineerPlan, IdentityTravel, PlannedVisit, ProposedPlan,
    ReplanningState, ReplanningStatus, RejectionCode, ViolationCode,
    build_candidate_index, load_planning_dataset, replan_after_event, validate_initial_plan,
    validate_replanned_plan,
)
from beeline_planning.domain import (
    Commitment, CommitmentType, Engineer, Equipment, EquipmentNeed, Event, EventType, Job, JobStatus,
    Office, PlanningDataset, Priority, RequiredTransport, SharedInventory,
)
from beeline_planning.export import load_exact_plan_artifact
from beeline_routing.models import (
    Coordinate, DetailedRoute, Provenance, RouteStatus, RouteStep, TransportMode,
)


class _Oracle:
    def __init__(self, *, unknown: bool = False) -> None:
        self.unknown = unknown
        self.calls = []

    def query(self, query):
        self.calls.append(query)
        status = RouteStatus.UNKNOWN if self.unknown else RouteStatus.OK
        return DetailedRoute(
            origin_id=query.origin.location_id,
            destination_id=query.destination.location_id,
            mode=query.mode,
            departure_at=query.departure_at,
            status=status,
            duration_seconds=600 if status == RouteStatus.OK else None,
            duration_minutes=10 if status == RouteStatus.OK else None,
            distance_m=1000 if status == RouteStatus.OK else None,
            geometry=((55.7, 37.6), (55.71, 37.61)) if status == RouteStatus.OK else (),
            itinerary=(RouteStep(1, 'CAR', 600, 1000, 0, ((55.7, 37.6), (55.71, 37.61)), {}),)
            if status == RouteStatus.OK else (),
            provider_status='test',
            provenance=Provenance('test', 'test', 'a', 'b', 'test', True, {}),
        )


class ReplanningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.day = datetime(2026, 8, 17, tzinfo=ZoneInfo('Europe/Moscow'))
        self.t0 = self.at(7)
        self.engineers = {
            engineer_id: Engineer(
                engineer_id=engineer_id,
                zone_id=zone,
                shift_start=self.at(8),
                shift_end=self.at(18),
                start_office_id=office,
                transport_mode=TransportMode.CAR,
                is_available=True,
                max_jobs=3,
                max_route_minutes=600,
                skills=frozenset({'INSTALL'}),
                equipment=(),
            )
            for engineer_id, zone, office in (
                ('E1', 'Z1', 'O1'), ('E2', 'Z1', 'O1'), ('OTHER', 'Z2', 'O2')
            )
        }
        self.jobs = {
            'A': self.job('A', 'Z1', self.t0),
            'B': self.job('B', 'Z1', self.t0),
        }
        self.locations = {
            location_id: Coordinate(location_id, 55.70 + index * .01, 37.60 + index * .01)
            for index, location_id in enumerate(('L1', 'L2', 'L3'))
        }
        self.offices = {
            'O1': Office('O1', 'Z1', 'L1'),
            'O2': Office('O2', 'Z2', 'L3'),
        }
        self.dataset = self.make_dataset(())
        self.source = ProposedPlan(
            self.t0,
            (
                EngineerPlan('E1', (
                    self.visit('A', self.at(9)),
                    self.visit('B', self.at(11)),
                )),
            ),
            (),
        )
        self.assertTrue(validate_initial_plan(self.dataset, self.source).is_valid)

    def at(self, hour: int, minute: int = 0) -> datetime:
        return self.day.replace(hour=hour, minute=minute)

    def job(self, job_id: str, zone: str, created: datetime, *,
            priority: Priority = Priority.NORMAL, location: str = 'L1',
            equipment: tuple[EquipmentNeed, ...] = ()) -> Job:
        return Job(
            job_id=job_id, zone_id=zone, location_id=location,
            window_start=self.at(8), window_end=self.at(17),
            created_at=created, service_duration_min=30,
            priority=priority, required_skill='INSTALL',
            required_transport=RequiredTransport.ANY,
            required_equipment=equipment, is_event_job=created != self.t0,
            status=JobStatus.PENDING,
        )

    def visit(self, job_id: str, departure: datetime, *,
              service_start: datetime | None = None, travel=None) -> PlannedVisit:
        return PlannedVisit(
            job_id, departure, service_start or departure,
            travel or IdentityTravel('L1', departure),
        )

    def make_dataset(self, events: tuple[Event, ...], **kwargs) -> PlanningDataset:
        return PlanningDataset(
            root=Path('.'), dataset_version='test', dataset_sha256='test',
            scenario='test', timezone_name='Europe/Moscow',
            planning_date='2026-08-17', initial_planning_at=self.t0,
            locations=self.locations if hasattr(self, 'locations') else {},
            offices=self.offices if hasattr(self, 'offices') else {},
            equipment_catalog=kwargs.get('equipment_catalog', {}),
            engineers=self.engineers, jobs=self.jobs,
            shared_inventory=kwargs.get('shared_inventory', ()),
            events=events, commitments=kwargs.get('commitments', ()), constraint_policies={},
        )

    def event(self, number: int, kind: EventType, target: str,
              at: datetime, zone: str = 'Z1', until: datetime | None = None) -> Event:
        return Event(number, f'EVT-{number}', at, kind, target, zone, until, {})

    def test_new_urgent_preserves_started_visit_and_places_in_same_zone(self) -> None:
        urgent = self.job('U', 'Z1', self.at(10), priority=Priority.URGENT)
        self.jobs['U'] = urgent
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        plan = result.state.plan
        by_engineer = {route.engineer_id: route for route in plan.engineer_plans}
        self.assertEqual(by_engineer['E1'].visits[0], self.source.engineer_plans[0].visits[0])
        self.assertNotIn('U', [visit.job_id for visit in by_engineer['OTHER'].visits])
        self.assertEqual({visit.job_id for route in plan.engineer_plans for visit in route.visits}, {'A', 'B', 'U'})
        self.assertEqual(result.validation.metrics.unserved_urgent_jobs, 0)
        self.assertIn('U', result.candidate_evaluations)
        self.assertEqual(
            sum(option.selected for option in result.candidate_evaluations['U']), 1
        )

    def test_every_required_mode_is_enforced_by_candidates_and_validator(self) -> None:
        modes = (
            TransportMode.CAR,
            TransportMode.PUBLIC_TRANSIT,
            TransportMode.BICYCLE,
            TransportMode.WALKING,
        )
        for mode in modes:
            with self.subTest(mode=mode):
                mismatch = TransportMode.WALKING if mode == TransportMode.CAR else TransportMode.CAR
                self.engineers['E1'] = replace(self.engineers['E1'], transport_mode=mismatch)
                self.engineers['E2'] = replace(self.engineers['E2'], transport_mode=mode)
                self.jobs['A'] = replace(
                    self.jobs['A'], required_transport=RequiredTransport(mode.value)
                )
                dataset = self.make_dataset(())
                candidates = build_candidate_index(dataset)
                self.assertIn('E2', candidates.eligible_engineers_by_job['A'])
                self.assertIn(
                    RejectionCode.TRANSPORT_MISMATCH, candidates.reasons('E1', 'A')
                )
                report = validate_initial_plan(dataset, self.source)
                self.assertEqual(report.status.value, 'INVALID')
                self.assertIn(
                    ViolationCode.TRANSPORT_MISMATCH,
                    {violation.code for violation in report.violations},
                )
                self.assertTrue(any(mode.value in violation.detail for violation in report.violations))

        self.jobs['A'] = replace(self.jobs['A'], required_transport=RequiredTransport.ANY)
        dataset = self.make_dataset(())
        self.assertIn('E1', build_candidate_index(dataset).eligible_engineers_by_job['A'])
        self.assertTrue(validate_initial_plan(dataset, self.source).is_valid)

    def test_replanning_assigns_bicycle_only_job_to_bicycle_engineer(self) -> None:
        self.engineers['E2'] = replace(
            self.engineers['E2'], transport_mode=TransportMode.BICYCLE
        )
        self.jobs['U'] = replace(
            self.job('U', 'Z1', self.at(10), priority=Priority.URGENT),
            required_transport=RequiredTransport.BICYCLE,
        )
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        dataset = self.make_dataset((event,))
        result = replan_after_event(dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        owner = {
            visit.job_id: route.engineer_id
            for route in result.state.plan.engineer_plans for visit in route.visits
        }
        self.assertEqual(owner['U'], 'E2')

    def test_new_job_in_other_zone_uses_only_that_zones_engineer(self) -> None:
        self.jobs['U2'] = self.job(
            'U2', 'Z2', self.at(10), priority=Priority.URGENT, location='L3'
        )
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U2', self.at(10), zone='Z2')
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        owner = {
            visit.job_id: route.engineer_id
            for route in result.state.plan.engineer_plans for visit in route.visits
        }
        self.assertEqual(owner['U2'], 'OTHER')

    def test_urgent_job_can_displace_one_future_normal_job(self) -> None:
        self.engineers['E1'] = replace(self.engineers['E1'], max_jobs=1)
        self.engineers['E2'] = replace(self.engineers['E2'], is_available=False)
        self.jobs['U'] = self.job('U', 'Z1', self.at(10), priority=Priority.URGENT)
        self.source = ProposedPlan(
            self.t0, (EngineerPlan('E1', (self.visit('A', self.at(11)),)),), ('B',)
        )
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        owner = {
            visit.job_id: route.engineer_id
            for route in result.state.plan.engineer_plans for visit in route.visits
        }
        self.assertEqual(owner, {'U': 'E1'})
        self.assertEqual(set(result.state.plan.unserved_job_ids), {'A', 'B'})

    def test_near_earliest_urgent_choice_avoids_shifting_existing_work(self) -> None:
        self.jobs['C'] = self.job('C', 'Z1', self.t0)
        self.jobs['U'] = self.job('U', 'Z1', self.at(10), priority=Priority.URGENT)
        self.source = ProposedPlan(
            self.t0,
            (
                EngineerPlan('E1', (
                    self.visit('A', self.at(9)),
                    self.visit('B', self.at(10, 10)),
                )),
                EngineerPlan('E2', (self.visit('C', self.at(9, 40)),)),
            ),
            (),
        )
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        owner = {
            visit.job_id: (route.engineer_id, visit.service_start_at)
            for route in result.state.plan.engineer_plans for visit in route.visits
        }
        self.assertEqual(owner['U'], ('E2', self.at(10, 10)))
        self.assertEqual(owner['B'], ('E1', self.at(10, 10)))

    def test_impossible_late_insertion_is_pruned_before_routing(self) -> None:
        self.engineers['E2'] = replace(self.engineers['E2'], is_available=False)
        self.jobs = {
            'B': self.jobs['B'],
            'U': replace(
                self.job('U', 'Z1', self.at(10), priority=Priority.URGENT),
                window_end=self.at(11),
            ),
        }
        self.source = ProposedPlan(
            self.t0, (EngineerPlan('E1', (self.visit('B', self.at(14)),)),), ()
        )
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        self.assertEqual(result.exact_route_checks, 1)

    def test_large_urgent_speed_gain_justifies_ejection_with_restoration(self) -> None:
        self.engineers['E1'] = replace(self.engineers['E1'], max_jobs=1)
        self.engineers['E2'] = replace(self.engineers['E2'], shift_start=self.at(13), max_jobs=1)
        self.jobs['U'] = self.job('U', 'Z1', self.at(10), priority=Priority.URGENT)
        self.source = ProposedPlan(
            self.t0, (EngineerPlan('E1', (self.visit('B', self.at(14)),)),), ('A',)
        )
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        owner = {
            visit.job_id: (route.engineer_id, visit.service_start_at)
            for route in result.state.plan.engineer_plans for visit in route.visits
        }
        self.assertEqual(owner['U'], ('E1', self.at(10)))
        self.assertEqual(owner['B'][0], 'E2')
        self.assertLessEqual(owner['B'][1], self.at(14))

    def test_ejected_job_prefers_an_already_active_restorer(self) -> None:
        self.engineers['E1'] = replace(self.engineers['E1'], max_jobs=1)
        self.engineers['E2'] = replace(self.engineers['E2'], shift_start=self.at(13), max_jobs=1)
        self.engineers['E3'] = replace(
            self.engineers['E2'], engineer_id='E3', shift_start=self.at(8),
            transport_mode=TransportMode.WALKING, max_jobs=2,
        )
        self.jobs['C'] = self.job('C', 'Z1', self.t0)
        self.jobs['U'] = replace(
            self.job('U', 'Z1', self.at(10), priority=Priority.URGENT),
            required_transport=RequiredTransport.CAR,
        )
        self.source = ProposedPlan(
            self.t0,
            (
                EngineerPlan('E1', (self.visit('B', self.at(14)),)),
                EngineerPlan('E3', (self.visit('C', self.at(9)),)),
            ),
            ('A',),
        )
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        owner = {
            visit.job_id: route.engineer_id
            for route in result.state.plan.engineer_plans for visit in route.visits
        }
        self.assertEqual(owner['U'], 'E1')
        self.assertEqual(owner['B'], 'E3')

    def test_small_urgent_speed_gain_does_not_displace_normal_job(self) -> None:
        self.engineers['E1'] = replace(self.engineers['E1'], max_jobs=1)
        self.engineers['E2'] = replace(self.engineers['E2'], shift_start=self.at(10, 20), max_jobs=1)
        self.jobs['U'] = self.job('U', 'Z1', self.at(10), priority=Priority.URGENT)
        self.source = ProposedPlan(
            self.t0, (EngineerPlan('E1', (self.visit('B', self.at(14)),)),), ('A',)
        )
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        owner = {
            visit.job_id: (route.engineer_id, visit.service_start_at)
            for route in result.state.plan.engineer_plans for visit in route.visits
        }
        self.assertEqual(owner['U'], ('E2', self.at(10, 20)))
        self.assertEqual(owner['B'], ('E1', self.at(14)))

    def test_cancel_future_job_releases_it_without_changing_history(self) -> None:
        event = self.event(1, EventType.CANCEL_JOB, 'B', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        self.assertEqual(result.state.canceled_job_ids, frozenset({'B'}))
        self.assertEqual([visit.job_id for route in result.state.plan.engineer_plans for visit in route.visits], ['A'])
        self.assertNotIn('B', result.state.plan.unserved_job_ids)

    def test_unchanged_route_reuses_verified_evidence_without_new_checks(self) -> None:
        self.jobs['C'] = self.job('C', 'Z1', self.t0)
        self.source = ProposedPlan(
            self.t0,
            (
                EngineerPlan('E1', (
                    self.visit('A', self.at(9)),
                    self.visit('B', self.at(11)),
                )),
                EngineerPlan('E2', (self.visit('C', self.at(11)),)),
            ),
            (),
        )
        event = self.event(1, EventType.CANCEL_JOB, 'B', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        self.assertEqual(result.exact_route_checks, 1)

    def test_cancel_started_job_is_rejected(self) -> None:
        event = self.event(1, EventType.CANCEL_JOB, 'A', self.at(9, 10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.REJECTED_ALREADY_STARTED)
        self.assertEqual(result.state.plan, self.source)
        self.assertEqual(result.state.canceled_job_ids, frozenset())

    def test_unavailable_engineer_finishes_in_transit_and_reassigns_future(self) -> None:
        self.jobs['A'] = self.job('A', 'Z1', self.t0, location='L2')
        travel = _Oracle().query(type('Q', (), {
            'origin': self.locations['L1'], 'destination': self.locations['L2'],
            'mode': TransportMode.CAR, 'departure_at': self.at(9, 50),
        })())
        self.source = ProposedPlan(
            self.t0,
            (EngineerPlan('E1', (
                self.visit('A', self.at(9, 50), service_start=self.at(10), travel=travel),
                self.visit('B', self.at(11), service_start=self.at(11, 10), travel=_Oracle().query(type('Q', (), {
                    'origin': self.locations['L2'], 'destination': self.locations['L1'],
                    'mode': TransportMode.CAR, 'departure_at': self.at(11),
                })())),
            )),),
            (),
        )
        self.dataset = self.make_dataset(())
        self.assertTrue(validate_initial_plan(self.dataset, self.source).is_valid)
        event = self.event(1, EventType.ENGINEER_UNAVAILABLE, 'E1', self.at(9, 55), until=self.at(18))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        by_engineer = {route.engineer_id: route for route in result.state.plan.engineer_plans}
        self.assertEqual(by_engineer['E1'].visits, (self.source.engineer_plans[0].visits[0],))
        self.assertEqual([visit.job_id for visit in by_engineer['E2'].visits], ['B'])
        self.assertEqual(by_engineer['OTHER'].visits, ())

    def test_unavailability_releases_hard_assignment_only_after_its_event(self) -> None:
        event = self.event(1, EventType.ENGINEER_UNAVAILABLE, 'E1', self.at(10), until=self.at(18))
        commitment = Commitment(
            commitment_id='C1', job_id='B', engineer_id='E1',
            commitment_type=CommitmentType.HARD_ASSIGNMENT,
            effective_from=self.t0, release_event_id=event.event_id,
        )
        self.dataset = self.make_dataset((event,), commitments=(commitment,))
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        owner = {
            visit.job_id: route.engineer_id
            for route in result.state.plan.engineer_plans for visit in route.visits
        }
        self.assertEqual(owner['A'], 'E1')
        self.assertEqual(owner['B'], 'E2')

    def test_events_are_applied_sequentially_to_the_previous_plan(self) -> None:
        self.jobs['U'] = self.job('U', 'Z1', self.at(10), priority=Priority.URGENT)
        first = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        second = self.event(2, EventType.CANCEL_JOB, 'B', self.at(10, 30))
        self.dataset = self.make_dataset((first, second))
        one = replan_after_event(self.dataset, ReplanningState(self.source), first, _Oracle())
        self.assertEqual(one.status, ReplanningStatus.EXACT_VALID)
        two = replan_after_event(self.dataset, one.state, second, _Oracle())
        self.assertEqual(two.status, ReplanningStatus.EXACT_VALID)
        self.assertEqual(two.state.applied_event_ids, ('EVT-1', 'EVT-2'))
        self.assertNotIn('B', [
            visit.job_id for route in two.state.plan.engineer_plans for visit in route.visits
        ])
        self.assertTrue(two.validation.is_valid)

    def test_shared_stock_shortage_is_reported_without_oversubscription(self) -> None:
        need = (EquipmentNeed('ONT', 1),)
        self.jobs['U'] = self.job('U', 'Z1', self.at(10), priority=Priority.URGENT, equipment=need)
        self.jobs['A'] = replace(self.jobs['A'], required_equipment=need)
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        self.dataset = self.make_dataset(
            (event,),
            equipment_catalog={'ONT': Equipment('ONT', 'DEVICE', False, True)},
            shared_inventory=(SharedInventory('Z1', 'ONT', 1),),
        )
        result = replan_after_event(self.dataset, ReplanningState(self.source), event, _Oracle())
        self.assertEqual(result.status, ReplanningStatus.EXACT_VALID)
        self.assertIn('U', result.state.plan.unserved_job_ids)
        self.assertEqual(result.unserved_reasons['U'], 'SHARED_STOCK_SHORTAGE')

    def test_canceling_future_job_releases_its_stock_for_next_event(self) -> None:
        need = (EquipmentNeed('ONT', 1),)
        self.jobs['B'] = replace(self.jobs['B'], required_equipment=need)
        self.jobs['U'] = self.job('U', 'Z1', self.at(10, 30),
                                  priority=Priority.URGENT, equipment=need)
        first = self.event(1, EventType.CANCEL_JOB, 'B', self.at(10))
        second = self.event(2, EventType.NEW_URGENT_JOB, 'U', self.at(10, 30))
        self.dataset = self.make_dataset(
            (first, second),
            equipment_catalog={'ONT': Equipment('ONT', 'DEVICE', False, True)},
            shared_inventory=(SharedInventory('Z1', 'ONT', 1),),
        )
        one = replan_after_event(self.dataset, ReplanningState(self.source), first, _Oracle())
        two = replan_after_event(self.dataset, one.state, second, _Oracle())
        self.assertEqual(two.status, ReplanningStatus.EXACT_VALID)
        self.assertNotIn('U', two.state.plan.unserved_job_ids)
        self.assertEqual(two.state.canceled_job_ids, frozenset({'B'}))

    def test_new_route_unknown_blocks_publication(self) -> None:
        self.jobs['U'] = self.job('U', 'Z1', self.at(10), priority=Priority.URGENT, location='L2')
        event = self.event(1, EventType.NEW_URGENT_JOB, 'U', self.at(10))
        self.dataset = self.make_dataset((event,))
        result = replan_after_event(
            self.dataset, ReplanningState(self.source), event, _Oracle(unknown=True)
        )
        self.assertEqual(result.status, ReplanningStatus.ROUTING_INCOMPLETE)
        self.assertIsNone(result.state)

    def test_validator_detects_changed_frozen_visit(self) -> None:
        event = self.event(1, EventType.CANCEL_JOB, 'B', self.at(10))
        self.dataset = self.make_dataset((event,))
        bad_plan = ProposedPlan(
            self.t0,
            (EngineerPlan('E1', (self.visit('A', self.at(9, 1)),)),),
            (),
        )
        report = validate_replanned_plan(
            self.dataset, bad_plan, self.source,
            event_time=event.event_time,
            applied_event_ids=frozenset({event.event_id}),
            canceled_job_ids=frozenset({'B'}),
            unavailable_until_by_engineer={},
        )
        self.assertIn(ViolationCode.FROZEN_ACTIVITY_CHANGED, {item.code for item in report.violations})

    def test_published_core_artifact_round_trips_with_route_evidence(self) -> None:
        root = Path(__file__).parents[2]
        dataset = load_planning_dataset(root / 'data/dataset', 'core')
        plan, payload = load_exact_plan_artifact(
            root / 'algorithm/artifacts/current/initial-exact-205-of-205-retimed.json',
            dataset.dataset_sha256,
        )
        self.assertEqual(payload['status'], 'EXACT_VALID')
        self.assertTrue(validate_initial_plan(dataset, plan).is_valid)


if __name__ == '__main__':
    unittest.main()
