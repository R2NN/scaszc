import test from 'node:test';
import assert from 'node:assert/strict';
import { importIdentity, summarizeImport } from '../src/importMerge.js';

const selectedDate = new Date(2026, 8, 28);
const order = (sourceId, serviceDate, regionId = 'moscow') => ({
  id: `${regionId}:${sourceId}`,
  sourceId,
  regionId,
  serviceDate,
});

test('district file can be appended to the open day without replacing existing orders', () => {
  const summary = summarizeImport(
    { orders: [order('E-1', '2026-09-28'), order('E-2', '2026-09-28')] },
    { orders: [order('W-1', '2026-09-28'), order('E-1', '2026-09-28')], engineers: [] },
    selectedDate,
  );
  assert.equal(summary.targetDate, '2026-09-28');
  assert.equal(summary.newIds, 1);
  assert.equal(summary.conflicts, 1);
  assert.deepEqual(summary.conflictIds, ['E-1']);
  assert.equal(summary.replaceRemovals, 2);
});

test('the same source ID on a different day is not a collision', () => {
  const summary = summarizeImport(
    { orders: [order('E-1', '2026-09-29')] },
    { orders: [order('E-1', '2026-09-28')], engineers: [] },
    selectedDate,
  );
  assert.equal(summary.differentDate, true);
  assert.equal(summary.newIds, 1);
  assert.equal(summary.conflicts, 0);
  assert.equal(summary.replaceRemovals, 0);
});

test('undated records belong to the open day, not every imported day', () => {
  const existing = { orders: [order('E-1', '')], engineers: [] };
  assert.equal(summarizeImport({ orders: [order('E-1', '2026-09-28')] }, existing, selectedDate).conflicts, 1);
  assert.equal(summarizeImport({ orders: [order('E-1', '2026-09-29')] }, existing, selectedDate).conflicts, 0);
});

test('order and engineer IDs are separate namespaces', () => {
  const summary = summarizeImport(
    { orders: [order('100', '2026-09-28')] },
    { orders: [], engineers: [order('100', '2026-09-28')] },
    selectedDate,
  );
  assert.equal(summary.conflicts, 0);
  assert.notEqual(importIdentity(order('100', '2026-09-28'), 'orders', '2026-09-28'),
    importIdentity(order('100', '2026-09-28'), 'engineers', '2026-09-28'));
});
