import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildHistoryModel, forecastNextShift, summarizeHistoryDay } from '../src/analyticsHistory.js';

const history = JSON.parse(await readFile(new URL('../public/data/analytics-history.json', import.meta.url), 'utf8'));

test('period summary separates planned visits from observed execution', () => {
  const model = buildHistoryModel(history.days, '2026-08-17');
  assert.equal(model.days.length, 182);
  assert.equal(model.selected.actualAvailable, false);
  assert.equal(model.selected.onTimeRate, null);
  assert.equal(model.totals.actualDays, 0);
  assert.equal(model.totals.total, history.days.reduce((sum, day) => sum + day.orders.length, 0));
  assert.equal(model.totals.assigned, history.days.reduce((sum, day) => sum + day.plan.routes.flatMap(route => route.assignments).length, 0));
  assert.equal(model.selected.issues.unassigned.length, model.selected.unassigned);
});

test('decision count is recomputed from assignments and the unresolved list, not copied from metrics', () => {
  const record = structuredClone(history.days.at(-1));
  record.plan.metrics.total = 999;
  record.plan.metrics.assigned = 998;
  record.plan.metrics.unassigned = 1;
  const summary = summarizeHistoryDay(record);
  assert.equal(summary.total, record.orders.length);
  assert.equal(summary.assigned, record.plan.routes.flatMap(route => route.assignments).length);
  assert.equal(summary.unassigned, record.plan.unassigned.length);
  assert.equal(summary.unassigned, record.plan.unassigned.length);
});

test('filtered route aggregates override stale all-region plan metrics', () => {
  const record = structuredClone(history.days.at(-1));
  const keptRoute = record.plan.routes.find(route => route.assignments?.length);
  const keptOrderIds = new Set(keptRoute.assignments.map(item => String(item.orderId)));
  record.orders = record.orders.filter(order => keptOrderIds.has(String(order.id)));
  record.team = record.team.filter(engineer => String(engineer.id) === String(keptRoute.engineerId));
  record.plan.routes = [keptRoute];
  record.plan.unassigned = [];
  record.plan.metrics.distanceKm = 999999;
  record.plan.metrics.activeEngineers = 99;
  const summary = summarizeHistoryDay(record);
  assert.equal(summary.distance, keptRoute.distanceKm);
  assert.equal(summary.activeEngineers, 1);
});

test('visit drill-down reconciles completed, cancelled, late and missing facts', () => {
  const record = structuredClone(history.days[0]);
  const assignments = record.plan.routes.flatMap(route => route.assignments);
  const completed = assignments[0];
  const late = assignments[1];
  const cancelled = assignments[2];
  record.actual = { visits: [
    { orderId: completed.orderId, status: 'completed', arrival: completed.arrival, start: completed.plannedStart, finish: completed.plannedFinish, onTime: true },
    { orderId: late.orderId, status: 'completed', arrival: late.arrival, start: '23:30', finish: '23:50', onTime: false },
    { orderId: cancelled.orderId, status: 'cancelled', reason: 'Клиент отменил визит' },
  ] };
  const day = summarizeHistoryDay(record);
  assert.equal(day.completed + day.cancelled + day.missing, day.assigned);
  assert.equal(day.completed, 2);
  assert.equal(day.cancelled, 1);
  assert.equal(day.late, 1);
  assert.equal(day.late, day.issues.late.length);
  assert.equal(day.cancelled, day.issues.cancelled.length);
  assert.ok(day.issues.late.every(item => item.orderId && item.zone && item.plannedStart && item.actualStart));
  assert.ok(day.issues.unassigned.every(item => item.orderId && item.reason));
});

test('forecast is based on available shifts and remains unavailable with too little history', () => {
  const days = history.days.map(summarizeHistoryDay);
  assert.equal(forecastNextShift(days.slice(0, 4)), null);
  const forecast = forecastNextShift(days);
  assert.equal(forecast.date, '2026-08-18');
  const comparable = days.filter(day => new Date(`${day.date}T12:00:00Z`).getUTCDay() === 2).slice(-8);
  assert.equal(forecast.sameWeekday, true);
  assert.equal(forecast.low, Math.min(...comparable.map(day => day.total)));
  assert.equal(forecast.high, Math.max(...comparable.map(day => day.total)));
  assert.ok(forecast.middle >= forecast.low && forecast.middle <= forecast.high);
  assert.ok(forecast.estimatedTeam > 0);
});

test('insights use dates and fields rather than a fixture hash', () => {
  const cloned = structuredClone(history.days);
  const selected = cloned.at(-1);
  selected.date = '2026-08-18';
  selected.orders.push({ id: 'new-order', name: 'Новая заявка', zone: 'Новая зона', skill: 'NEW' });
  const model = buildHistoryModel(cloned, '2026-08-18');
  assert.equal(model.selected.total, history.days.at(-1).orders.length + 1);
  assert.equal(model.forecast.date, '2026-08-19');
  assert.ok(model.gaps.every(gap => gap.days >= 2));
  assert.ok(model.hotspots.every(zone => zone.observed >= 20 && zone.days >= 3));
});

test('no fact never becomes zero punctuality, including an empty fact collection', () => {
  const planned = structuredClone(history.days.at(-1));
  assert.equal(summarizeHistoryDay(planned).onTimeRate, null);
  planned.actual = { visits: [] };
  const empty = summarizeHistoryDay(planned);
  assert.equal(empty.onTimeRate, null);
  assert.equal(empty.missing, empty.assigned);
});

test('a completed visit without a timestamp does not count as late or punctual', () => {
  const record = {
    date: '2026-01-01',
    orders: [{ id: 'one', name: 'Заявка', zone: 'Центр', start: '09:00', end: '11:00' }],
    team: [{ id: 'engineer' }],
    plan: { routes: [{ engineerId: 'engineer', assignments: [{ orderId: 'one', plannedStart: '10:00' }] }], unassigned: [] },
    actual: { visits: [{ orderId: 'one', status: 'completed' }] },
  };
  const result = summarizeHistoryDay(record);
  assert.equal(result.completed, 1);
  assert.equal(result.timingObserved, 0);
  assert.equal(result.onTimeRate, null);
  assert.equal(result.late, 0);
});
