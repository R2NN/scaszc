import assert from 'node:assert/strict';
import test from 'node:test';
import { acquirePlanningSlot, withPlanningSlot } from '../server/planningSlot.mjs';

test('one calculation blocks another and frees the slot when complete', async () => {
  let finish;
  const first = withPlanningSlot(() => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(withPlanningSlot(async () => 'second'), { code: 'PLANNING_BUSY' });
  finish('first');
  assert.equal(await first, 'first');
  assert.equal(await withPlanningSlot(async () => 'third'), 'third');
});

test('background calculations release their reservation after a failure', async () => {
  const release = acquirePlanningSlot();
  assert.ok(release);
  await assert.rejects(withPlanningSlot(async () => 'blocked'), { code: 'PLANNING_BUSY' });
  release();
  release();
  await assert.rejects(withPlanningSlot(async () => { throw new Error('failed'); }));
  assert.equal(await withPlanningSlot(async () => 'ready'), 'ready');
});
