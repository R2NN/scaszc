import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ShiftStore } from '../server/shiftStore.mjs';
import { baseHistoryDates, ensureBaseHistoricalShift } from '../server/baseHistoryStore.mjs';
import { handleExactPlanning } from '../server/exactPlanningApi.mjs';
import { canonicalDemoInput } from '../src/canonicalDemo.js';

const readJson = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));

test('all 182 dates are backed by the first archive and keep their exact route geometry', async () => {
  const history = await readJson('../public/data/analytics-history.json');
  const dates = await baseHistoryDates();
  assert.equal(dates.length, 182);
  assert.deepEqual(dates, history.days.map(day => day.date));
  const store = new ShiftStore(':memory:');
  try {
    for (const date of [dates[0], dates[90], dates.at(-2), dates.at(-1)]) {
      const shift = await ensureBaseHistoricalShift(store, date);
      assert.equal(shift.plan.status, 'EXACT_VALID');
      assert.equal(shift.plan.validation.status, 'VALID');
      assert.equal(shift.plan.metrics.total, shift.orders.length);
      assert.equal(shift.plan.metrics.assigned + shift.plan.metrics.unassigned, shift.orders.length);
      assert.ok(shift.plan.routes.flatMap(route => route.assignments).every(visit => visit.geometry?.length > 0));
      assert.ok(shift.orders.every(order => order.coords?.length === 2));
    }
  } finally {
    store.close();
  }
});

test('canonical input yields 205 exact assignments and altered input never yields an estimate', async () => {
  const fixture = await readJson('../public/test-data/beego-algorithm-initial.json');
  const artifact = await readJson('../public/data/beego-exact-plans.json');
  const input = canonicalDemoInput(fixture, artifact);
  const request = payload => new Request('http://localhost/api/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const response = await handleExactPlanning(request({ orders: input.orders, engineers: input.engineers, planningDate: input.planningDate }));
  const plan = await response.json();
  assert.equal(response.status, 200);
  assert.equal(plan.status, 'EXACT_VALID');
  assert.equal(plan.metrics.assigned, 205);
  const store = new ShiftStore(':memory:');
  try {
    assert.throws(() => store.ensure({ regionId: 'moscow', date: input.planningDate, orders: input.orders,
      team: input.engineers, plan: { ...plan, status: 'HEURISTIC_VALID', approximateTravel: true } }), /только для независимо проверенного точного плана/);
  } finally {
    store.close();
  }
});

test('background planning job reports its real state and returns the validated plan', async () => {
  const fixture = await readJson('../public/test-data/beego-algorithm-initial.json');
  const artifact = await readJson('../public/data/beego-exact-plans.json');
  const input = canonicalDemoInput(fixture, artifact);
  const started = await handleExactPlanning(new Request('http://localhost/api/plan/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orders: input.orders, engineers: input.engineers, planningDate: input.planningDate }),
  }));
  assert.equal(started.status, 202);
  const task = await started.json();
  assert.equal(task.status, 'RUNNING');
  assert.equal(task.progress.phase, 'VALIDATING_INPUT');
  let result;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await handleExactPlanning(new Request(`http://localhost/api/plan/jobs/${task.id}`));
    result = await response.json();
    if (result.status !== 'RUNNING') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(result.status, 'READY', result.error);
  assert.equal(result.progress.phase, 'READY');
  assert.equal(result.result.status, 'EXACT_VALID');
  assert.equal(result.result.metrics.assigned, 205);
});
