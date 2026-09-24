import assert from 'node:assert/strict';
import test from 'node:test';
import { displayPlanningPriority, isUrgentPriority, normalizePlanningPriority } from '../src/planningPriority.js';

test('planner and import use the same two priority levels', () => {
  for (const value of ['', 'NORMAL', 'Обычная']) {
    assert.equal(normalizePlanningPriority(value), 'NORMAL');
    assert.equal(isUrgentPriority(value), false);
  }
  for (const value of ['URGENT', 'HIGH', 'EMERGENCY', 'critical', 'Срочная', 'Высокий', 'Авария']) {
    assert.equal(normalizePlanningPriority(value), 'URGENT');
    assert.equal(isUrgentPriority(value), true);
  }
  assert.equal(displayPlanningPriority('HIGH'), 'Срочная');
  assert.equal(displayPlanningPriority('Срочная'), 'Срочная');
  assert.equal(displayPlanningPriority('EMERGENCY'), 'Авария');
  assert.equal(displayPlanningPriority('NORMAL'), 'Обычная');
  assert.equal(normalizePlanningPriority('UNKNOWN'), null);
  assert.throws(() => displayPlanningPriority('UNKNOWN'), /Неизвестный приоритет/);
});
