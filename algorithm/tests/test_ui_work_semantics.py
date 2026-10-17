"""Work, urgency and qualification agree in initial and event planning."""

from __future__ import annotations

import csv
import json
import sys
import unittest
from pathlib import Path
from dataclasses import replace
from tempfile import TemporaryDirectory

from beeline_planning import build_candidate_index, load_planning_dataset
from beeline_planning.domain import Priority
from beeline_planning.eligibility import RejectionCode
from algorithm.tools.prepare_ui_dataset import order_semantics, prepare

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from replan_ui_event import _event_dataset


class UiWorkSemanticsTests(unittest.TestCase):
    def test_new_emergency_at_checkpoint_preserves_direction_evidence(self):
        from beeline_routing.models import Coordinate
        with TemporaryDirectory() as directory:
            payload = self.prepared()
            root = Path(directory) / 'dataset'
            prepare(payload, root)
            data = load_planning_dataset(root, 'core')
            point = Coordinate('DISPATCH-CURRENT', 55.701234, 37.612345, heading=137)
            data = replace(data, locations={**data.locations, point.location_id: point})
            order = {**payload['orders'][0], 'id': 'current-emergency', 'coords': [point.latitude, point.longitude]}
            changed, _ = _event_dataset(data, {'orders': [order], 'event': {'type': 'NEW_ORDER', 'orderId': order['id'], 'time': '09:00'}})
            self.assertEqual(changed.jobs[order['id']].location_id, point.location_id)
            self.assertEqual(changed.locations[point.location_id].heading, 137)

    def test_reviewed_original_day_preserves_all_205_required_qualifications(self):
        root = Path(__file__).parents[2]
        reviewed = json.loads((root / 'site/public/data/beego-complexity-plan.json').read_text(encoding='utf8'))
        original = load_planning_dataset(root / 'data/object-complexity/dataset', 'core')
        self.assertEqual(len(reviewed['orders']), 205)
        for order in reviewed['orders']:
            with self.subTest(order=order['id']):
                self.assertEqual(order_semantics(order)['requiredSkill'], original.jobs[order['sourceId']].required_skill)

    def payload(self):
        return {
            'planningDate': '2026-08-17',
            'orders': [
                {'id': 'emergency-connection', 'workType': 'Подключение', 'skill': 'INSTALL', 'priority': 'Авария', 'duration': 80},
                {'id': 'urgent-connection', 'workType': 'Подключение', 'skill': 'INSTALL', 'priority': 'Срочная', 'duration': 70},
                {'id': 'information', 'workType': 'Глобальная проблема', 'serviceType': 'Информация', 'skill': 'EMERGENCY', 'priority': 'Обычная', 'duration': 80},
            ],
            'engineers': [
                {'id': 'install-only', 'skills': ['INSTALL']},
                {'id': 'emergency-only', 'skills': ['EMERGENCY']},
            ],
        }

    def prepared(self):
        payload = self.payload()
        for order in payload['orders']:
            order.update(zoneId='EAST', coords=[55.75, 37.61], start='10:00', end='16:00')
        for engineer in payload['engineers']:
            engineer.update(zoneId='EAST', startCoords=[55.75, 37.61], shiftStart='08:00', shiftEnd='18:00', status='Доступен', transport='CAR')
        return payload

    def test_initial_preparation_and_candidate_index_use_emergency_qualification(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / 'dataset'
            prepare(self.prepared(), root)
            with (root / 'core/jobs.csv').open(encoding='utf-8-sig', newline='') as source:
                jobs = {row['job_id']: row for row in csv.DictReader(source, delimiter=';')}
            self.assertEqual((jobs['emergency-connection']['required_skill'], jobs['emergency-connection']['priority'], jobs['emergency-connection']['service_duration_min']), ('EMERGENCY', 'URGENT', '80'))
            self.assertEqual((jobs['urgent-connection']['required_skill'], jobs['urgent-connection']['priority']), ('INSTALL', 'URGENT'))
            self.assertEqual((jobs['information']['required_skill'], jobs['information']['priority']), ('EMERGENCY', 'NORMAL'))
            data = load_planning_dataset(root, 'core')
            index = build_candidate_index(data)
            self.assertEqual(index.eligible_engineers_by_job['emergency-connection'], ('emergency-only',))
            self.assertIn(RejectionCode.SKILL_MISSING, index.rejection_codes[('install-only', 'emergency-connection')])
            self.assertEqual(index.eligible_engineers_by_job['urgent-connection'], ('install-only',))

    def test_new_order_event_uses_the_same_qualification_and_priority(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / 'dataset'
            payload = self.prepared()
            prepare(payload, root)
            data = load_planning_dataset(root, 'core')
            new_order = {**payload['orders'][0], 'id': 'new-emergency'}
            changed, event = _event_dataset(data, {'orders': [new_order], 'event': {'type': 'NEW_ORDER', 'orderId': new_order['id'], 'time': '09:00'}})
            job = changed.jobs['new-emergency']
            self.assertEqual((job.required_skill, job.priority, job.service_duration_min), ('EMERGENCY', Priority.URGENT, 80))
            index = build_candidate_index(changed, event.event_time)
            self.assertEqual(index.eligible_engineers_by_job['new-emergency'], ('emergency-only',))

    def test_source_fields_and_aliases_follow_contract(self):
        cases = [({'sourceData': {'bk_type': 'Подключение', 'required_skill': 'INSTALL', 'priority': 'Авария'}}, 'emergency', 'EMERGENCY', 'URGENT'),
                 ({'workType': 'Подключение', 'priority': 'URGENT'}, 'connection', 'INSTALL', 'URGENT'),
                 ({'workType': 'Подключение', 'priority': 'critical'}, 'emergency', 'EMERGENCY', 'URGENT')]
        for order, kind, skill, priority in cases:
            with self.subTest(order=order):
                actual = order_semantics(order)
                self.assertEqual((actual['kind'], actual['requiredSkill'], actual['priority']), (kind, skill, priority))
