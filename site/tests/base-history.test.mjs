import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationsApi } from '../server/operationsApi.mjs';
import { ShiftStore } from '../server/shiftStore.mjs';
import { baseHistoryDates, ensureBaseHistoricalShift } from '../server/baseHistoryStore.mjs';

test('shift history remains available when optional historical source files are absent', async () => {
  const store = new ShiftStore(':memory:');
  try {
    const api = createOperationsApi({ store, seedFromBase: true });
    const status = await api.handle(new Request('http://localhost/api/base-data/status'));
    assert.equal(status.status, 200);
    const summary = await status.json();
    assert.equal(summary.days, 182);
    assert.equal(summary.firstDate, '2026-02-17');
    assert.ok(summary.operationalDays >= 1 && summary.operationalDays <= summary.days);
    const response = await api.handle(new Request('http://localhost/api/shifts/history?regionId=moscow&throughDate=2026-08-17'));
    assert.equal(response.status, 200);
    const shifts = await response.json();
    assert.ok(shifts.some(shift => shift.date === '2026-08-17'));
  } finally {
    store.close();
  }
});

test('retained historical shifts reopen with orders and road geometry without replacing the active day', async context => {
  const dates = (await baseHistoryDates()).filter(date => date !== '2026-08-17');
  if (!dates.length) return context.skip('Optional operational archive is not installed.');
  const store = new ShiftStore(':memory:');
  try {
    const api = createOperationsApi({ store, seedFromBase: true });
    await api.handle(new Request('http://localhost/api/base-data/status'));
    const activeBefore = JSON.stringify(store.byDate('moscow', '2026-08-17'));
    for (const date of new Set([dates[0], dates[Math.floor(dates.length / 2)], dates.at(-1)])) {
      const response = await api.handle(new Request(`http://localhost/api/shifts?regionId=moscow&date=${date}`));
      assert.equal(response.status, 200);
      const shift = await response.json();
      assert.equal(shift.date, date);
      assert.equal(shift.plan.status, 'EXACT_VALID');
      assert.equal(shift.plan.validation.status, 'VALID');
      assert.equal(shift.plan.metrics.total, shift.orders.length);
      assert.ok(shift.orders.every(order => order.serviceDate === date && order.coords.every(Number.isFinite)));
      const visits = shift.plan.routes.flatMap(route => route.assignments);
      assert.equal(visits.length, shift.plan.metrics.assigned);
      assert.ok(visits.every(visit => visit.geometry.length >= 2));
      assert.equal(shift.facts.length, 0);
      const reopened = await ensureBaseHistoricalShift(store, date);
      assert.equal(reopened.id, shift.id);
      assert.equal(reopened.revision, shift.revision);
      assert.equal(reopened.versions.length, shift.versions.length);
    }
    assert.equal(JSON.stringify(store.byDate('moscow', '2026-08-17')), activeBefore);
  } finally {
    store.close();
  }
});
