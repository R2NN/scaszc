import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { generateHistory } from '../scripts/generate-analytics-history.mjs';

const fixture = JSON.parse(await readFile(new URL('../public/test-data/beego-algorithm-initial.json', import.meta.url), 'utf8'));
const artifact = JSON.parse(await readFile(new URL('../public/data/beego-exact-plans.json', import.meta.url), 'utf8'));

test('history ends on the date present in source jobs and has five consecutive weeks', () => {
  const history = generateHistory({ fixture, artifact });
  assert.equal(history.period.end, fixture.jobs[0].window_start.slice(0, 10));
  assert.equal(history.days.length, 180);
  for (let index = 1; index < history.days.length; index += 1) {
    const previous = Date.parse(`${history.days[index - 1].date}T12:00:00Z`);
    const current = Date.parse(`${history.days[index].date}T12:00:00Z`);
    assert.equal(current - previous, 86400000);
  }
  assert.equal(history.days.at(-1).date, history.period.end);
});

test('every daily plan and actual visit references an existing order and engineer', () => {
  const history = generateHistory({ fixture, artifact });
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
    assert.equal(day.plan.metrics.activeEngineers, day.plan.routes.length);
    assert.ok(day.plan.routes.every(route => engineerIds.has(route.engineerId)));
    assert.ok(assigned.every(item => orderIds.has(item.orderId) && engineerIds.has(item.engineerId)));
    assert.ok(day.plan.unassigned.every(item => orderIds.has(item.orderId) && !assignedIds.has(item.orderId)));
    if (day.date === history.period.end) {
      assert.equal(day.actual, null);
    } else {
      assert.equal(day.actual.visits.length, assigned.length);
      assert.ok(day.actual.visits.every(visit => assignedIds.has(visit.orderId)));
    }
  }
});

test('current route history keeps delayed departures and the arrival buffer from the plan artifact', () => {
  const history = generateHistory({ fixture, artifact });
  const current = history.days.at(-1);
  const route = current.plan.routes.find(item => item.engineerId === 'SOUTHCENTER-ENG-02');
  const visit = route.assignments.find(item => item.orderId.endsWith('SOUTHCENTER-93276'));
  assert.equal(visit.departureAt, '15:22');
  assert.equal(visit.arrival, '15:45');
  assert.equal(visit.plannedStart, '16:00');
});

test('generation is deterministic and can be anchored to another date', () => {
  const options = { fixture, artifact, endDate: '2026-10-05', days: 4 };
  const first = generateHistory(options);
  assert.deepEqual(first, generateHistory(options));
  assert.equal(first.period.start, '2026-10-02');
  assert.equal(first.period.end, '2026-10-05');
});
