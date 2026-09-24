import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { generateHistory } from '../scripts/generate-analytics-history.mjs';

const fixture = JSON.parse(await readFile(new URL('../public/test-data/beego-algorithm-initial.json', import.meta.url), 'utf8'));
const artifact = JSON.parse(await readFile(new URL('../public/data/beego-exact-plans.json', import.meta.url), 'utf8'));

test('history spans six months and ends with the verified canonical day', () => {
  const history = generateHistory({ fixture, artifact });
  assert.equal(history.period.end, fixture.jobs[0].window_start.slice(0, 10));
  assert.equal(history.period.start, '2026-02-17');
  assert.equal(history.days.length, 182);
  for (let index = 1; index < history.days.length; index += 1) {
    const previous = Date.parse(`${history.days[index - 1].date}T12:00:00Z`);
    const current = Date.parse(`${history.days[index].date}T12:00:00Z`);
    assert.equal(current - previous, 86400000);
  }
  assert.equal(history.days.at(-1).date, history.period.end);
  const current = history.days.at(-1);
  assert.equal(current.plan.metrics.total, 205);
  assert.equal(current.plan.metrics.assigned, 205);
  assert.equal(current.plan.metrics.unassigned, 0);
  assert.equal(current.plan.metrics.activeEngineers, 28);
  assert.equal(current.dataKind, 'VERIFIED_CANONICAL_DAY');
  assert.equal(current.plan.contentSha256, artifact.plans.initial.contentSha256);
  assert.equal(current.plan.baseline.status, 'EXACT_VALID');
  assert.equal(current.plan.baseline.validationStatus, 'VALID');
  assert.equal(current.plan.baseline.methodology, 'EXACT_FCFS_SAME_ROUTING_AND_VALIDATOR');
  assert.equal(current.plan.baseline.metrics.assigned, 104);
  assert.equal(current.plan.baseline.metrics.unassigned, 101);
  assert.equal(current.plan.baseline.metrics.activeEngineers, 35);
  assert.equal(current.plan.baseline.metrics.distanceKm, 1069.535);
  assert.equal(current.plan.metrics.distanceKm, 1636.204);
  const sourceRoute = artifact.plans.baseline.routes.find(route => route.engineerId === current.plan.baseline.routes[0].engineerId);
  assert.equal(current.plan.baseline.routes[0].workloadMinutes, sourceRoute.workloadMinutes);
});

test('synthetic prior days are easier overall, with natural variation and no forced hard days', () => {
  const days = generateHistory({ fixture, artifact }).days.slice(0, -1);
  const complete = days.filter(day => day.plan.metrics.unassigned === 0);
  const partial = days.filter(day => day.plan.metrics.unassigned > 0);
  assert.ok(complete.length > days.length / 2);
  assert.ok(partial.length > 15);
  assert.ok(days.every(day => day.dataKind === 'SYNTHETIC_HISTORY'
    && !Object.hasOwn(day, 'difficulty')
    && day.plan.status === 'SYNTHETIC_HISTORY'
    && day.plan.validationStatus === null
    && day.plan.metrics.total <= 205));
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
      const baselineIds = [
        ...day.plan.baseline.routes.flatMap(route => route.assignments.map(item => item.orderId)),
        ...day.plan.baseline.unassigned.map(item => item.orderId),
      ];
      assert.equal(baselineIds.length, day.orders.length);
      assert.equal(new Set(baselineIds).size, day.orders.length);
    } else {
      assert.equal(day.actual.visits.length, assigned.length);
      assert.equal(day.plan.baseline, null);
      assert.ok(day.actual.visits.every(visit => assignedIds.has(visit.orderId)));
    }
  }
});

test('current route history keeps delayed departures and the arrival buffer from the plan artifact', () => {
  const history = generateHistory({ fixture, artifact });
  const current = history.days.at(-1);
  const route = current.plan.routes.find(item => item.engineerId === 'EAST-ENG-01');
  const visit = route.assignments.find(item => item.orderId.endsWith('EAST-26645'));
  const exact = artifact.plans.initial.routes.find(item => item.engineerId === 'EAST-ENG-01')
    .assignments.find(item => item.sourceOrderId === 'EAST-26645');
  assert.equal(visit.departureAt, exact.departureAt);
  assert.equal(visit.arrival, exact.arrival);
  assert.equal(visit.plannedStart, '16:00');
  assert.equal(visit.plannedStart, exact.plannedStart);
});

test('generation is deterministic and can be anchored to another date', () => {
  const options = { fixture, artifact, endDate: '2026-10-05', days: 4 };
  const first = generateHistory(options);
  assert.deepEqual(first, generateHistory(options));
  assert.equal(first.period.start, '2026-10-02');
  assert.equal(first.period.end, '2026-10-05');
});
