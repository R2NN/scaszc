import assert from 'node:assert/strict';
import test from 'node:test';
import { withPlanningSlot } from '../scripts/planning-slot.mjs';

test('only one exact calculation can run at a time', async () => {
  let release;
  const first = withPlanningSlot(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(withPlanningSlot(async () => 'second'), { code: 'PLANNING_BUSY' });
  release('first');
  assert.equal(await first, 'first');
  assert.equal(await withPlanningSlot(async () => 'third'), 'third');
});

test('a failed calculation releases the slot', async () => {
  await assert.rejects(withPlanningSlot(async () => { throw new Error('failed'); }));
  assert.equal(await withPlanningSlot(async () => 'ready'), 'ready');
});
