import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationsApi } from '../server/operationsApi.mjs';
import { ShiftStore } from '../server/shiftStore.mjs';

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
