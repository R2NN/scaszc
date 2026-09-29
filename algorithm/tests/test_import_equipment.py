"""Regression checks for reviewed UI equipment entering the exact planner."""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from algorithm.tools.prepare_ui_dataset import equipment, prepare


class ImportEquipmentTests(unittest.TestCase):
    def test_catalog_codes_survive_import(self):
        self.assertEqual(
            equipment('DIAG_SET|INSTALL_SET|CABLE_PACK'),
            ['DIAG_SET', 'INSTALL_SET', 'CABLE_PACK'],
        )

    def test_legacy_emergency_label_maps_to_original_diagnostic_set(self):
        self.assertEqual(equipment('Аварийный комплект'), ['DIAG_SET'])

    def test_unknown_equipment_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Неизвестное оборудование'):
            equipment('Неизвестный прибор')

    def test_reviewed_day_builds_a_real_equipment_matrix(self):
        payload = {
            'planningDate': '2026-08-16',
            'orders': [{
                'id': 'moscow:JOB-1', 'sourceId': 'JOB-1', 'zoneId': 'EAST',
                'coords': [55.75, 37.61], 'start': '10:00', 'end': '12:00',
                'duration': 60, 'skill': 'INSTALL', 'priority': 'NORMAL',
                'equipment': 'Аварийный комплект',
            }],
            'engineers': [{
                'id': 'moscow:ENG-1', 'sourceId': 'ENG-1', 'zoneId': 'EAST',
                'startCoords': [55.75, 37.61], 'shiftStart': '08:00',
                'shiftEnd': '18:00', 'skills': ['INSTALL'], 'status': 'Доступен',
                'transport': 'CAR', 'equipment': ['DIAG_SET'],
            }],
        }
        with TemporaryDirectory() as directory:
            target = Path(directory) / 'dataset'
            result = prepare(payload, target)
            self.assertEqual(result['status'], 'PREPARED')
            self.assertIn('DIAG_SET', (target / 'common' / 'work_equipment_matrix.csv').read_text(encoding='utf-8-sig'))
            self.assertIn('DIAG_SET', (target / 'common' / 'engineer_equipment.csv').read_text(encoding='utf-8-sig'))
