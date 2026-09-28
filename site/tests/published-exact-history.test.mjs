import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const history = JSON.parse(await readFile(new URL('../public/data/analytics-history.json', import.meta.url), 'utf8'));

test('published history contains 181 validated synthetic input days and the canonical day', () => {
  assert.equal(history.period.start, '2026-02-17');
  assert.equal(history.period.end, '2026-08-17');
  assert.equal(history.days.length, 182);
  assert.equal(history.days.at(-1).plan.metrics.assigned, 205);
  assert.equal(history.days.at(-1).dataKind, 'VERIFIED_CANONICAL_DAY');
  for (const day of history.days.slice(0, -1)) {
    assert.equal(day.dataKind, 'SYNTHETIC_INPUT_EXACT_PLAN');
    assert.equal(day.provenance.workload, 'SYNTHETIC_DATE_SPECIFIC_INPUT');
    assert.equal(day.provenance.plan, 'INDEPENDENTLY_VALIDATED_EXACT');
    assert.equal(day.plan.status, 'EXACT_VALID');
    assert.equal(day.plan.validationStatus, 'VALID');
    assert.equal(day.plan.publicationAllowed, true);
    assert.equal(day.actual, null);
    assert.ok(day.plan.baseline);
    assert.match(day.plan.contentSha256, /^[0-9a-f]{64}$/);
    const orderIds = new Set(day.orders.map(order => order.id));
    const engineerIds = new Set(day.team.map(engineer => engineer.id));
    const assigned = day.plan.routes.flatMap(route => route.assignments);
    const assignedIds = new Set(assigned.map(assignment => assignment.orderId));
    const unassignedIds = new Set(day.plan.unassigned.map(item => item.orderId));
    assert.equal(orderIds.size, day.orders.length);
    assert.equal(assignedIds.size, assigned.length);
    assert.equal(unassignedIds.size, day.plan.unassigned.length);
    assert.equal(day.plan.metrics.total, day.orders.length);
    assert.equal(day.plan.metrics.assigned, assigned.length);
    assert.equal(day.plan.metrics.unassigned, unassignedIds.size);
    assert.equal(assigned.length + unassignedIds.size, orderIds.size);
    assert.ok(day.plan.routes.every(route => engineerIds.has(route.engineerId)));
    assert.ok(assigned.every(item => orderIds.has(item.orderId) && engineerIds.has(item.engineerId)));
    assert.ok([...unassignedIds].every(id => orderIds.has(id) && !assignedIds.has(id)));
    if (day.plan.baseline) {
      const baseline = day.plan.baseline;
      assert.equal(baseline.status, 'EXACT_VALID');
      assert.equal(baseline.validationStatus, 'VALID');
      assert.equal(baseline.publicationAllowed, true);
      assert.equal(baseline.metrics.total, orderIds.size);
      const baselineAssigned = baseline.routes.flatMap(route => route.assignments);
      const baselineIds = [
        ...baselineAssigned.map(item => item.orderId),
        ...baseline.unassigned.map(item => item.orderId),
      ];
      assert.equal(baselineIds.length, orderIds.size);
      assert.equal(new Set(baselineIds).size, orderIds.size);
      assert.ok(baseline.routes.every(route => engineerIds.has(route.engineerId)));
      assert.ok(baselineIds.every(id => orderIds.has(id)));
    }
  }
});

test('published historical day dates are consecutive and do not repeat', () => {
  for (let index = 1; index < history.days.length; index += 1) {
    const previous = Date.parse(`${history.days[index - 1].date}T12:00:00Z`);
    const current = Date.parse(`${history.days[index].date}T12:00:00Z`);
    assert.equal(current - previous, 86400000);
  }
});

test('every published emergency has a validated assignment', () => {
  for (const day of history.days) {
    const urgentIds = new Set(day.orders.filter(order => order.priority === 'Авария').map(order => order.id));
    const assignedIds = new Set(day.plan.routes.flatMap(route => route.assignments.map(item => item.orderId)));
    for (const id of urgentIds) {
      assert.ok(assignedIds.has(id), `${day.date}: emergency ${id} is unassigned`);
    }
  }
});
