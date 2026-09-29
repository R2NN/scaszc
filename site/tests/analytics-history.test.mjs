import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const history = JSON.parse(await readFile(new URL('../public/data/analytics-history.json', import.meta.url), 'utf8'));

test('history preserves every consecutive date from the source archive', () => {
  assert.equal(history.days.length, 182);
  assert.equal(history.days[0].date, history.period.start);
  assert.equal(history.days.at(-1).date, history.period.end);
  for (let index = 1; index < history.days.length; index += 1) {
    const previous = Date.parse(`${history.days[index - 1].date}T12:00:00Z`);
    const current = Date.parse(`${history.days[index].date}T12:00:00Z`);
    assert.equal(current - previous, 86400000);
  }
});

test('daily exact plans reference their source orders and engineers', () => {
  for (const day of history.days) {
    const orderIds = new Set(day.orders.map(order => order.id));
    const engineerIds = new Set(day.team.map(engineer => engineer.id));
    const assigned = day.plan.routes.flatMap(route => route.assignments);
    const assignedIds = new Set(assigned.map(item => item.orderId));
    assert.equal(orderIds.size, day.orders.length);
    assert.equal(assignedIds.size, assigned.length);
    assert.equal(day.plan.metrics.total, day.orders.length);
    assert.equal(day.plan.metrics.assigned, assigned.length);
    assert.equal(day.plan.metrics.unassigned, day.plan.unassigned.length);
    assert.equal(assigned.length + day.plan.unassigned.length, day.orders.length);
    assert.ok(day.plan.routes.every(route => engineerIds.has(route.engineerId)));
    assert.ok(assigned.every(item => orderIds.has(item.orderId) && engineerIds.has(item.engineerId)));
    assert.ok(day.plan.unassigned.every(item => orderIds.has(item.orderId) && !assignedIds.has(item.orderId)));
  }
});

test('history keeps planned times separate from missing observed visits', () => {
  for (const day of history.days) {
    assert.equal(day.actual, null);
    for (const visit of day.plan.routes.flatMap(route => route.assignments)) {
      assert.ok(visit.departureAt <= visit.arrival);
      assert.ok(visit.arrival <= visit.plannedStart);
      assert.ok(visit.plannedStart < visit.plannedFinish);
    }
  }
});

test('each date retains independent exact-plan provenance', () => {
  const hashes = new Set(history.days.map(day => day.provenance?.datasetSha256));
  assert.equal(hashes.size, history.days.length);
  assert.ok(history.days.every(day => day.plan.status === 'EXACT_VALID'));
  assert.ok(history.days.slice(0, -1).every(day => day.provenance?.plan === 'INDEPENDENTLY_VALIDATED_EXACT'));
});
