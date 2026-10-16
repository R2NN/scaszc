import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleExactPlanning } from '../server/exactPlanningApi.mjs';

test('explicit improvement bypasses a matching retained schedule; lookup does not run the planner', async () => {
  const saved = JSON.parse(await readFile(new URL('../public/data/beego-complexity-plan.json', import.meta.url), 'utf8'));
  const complexity = { prepareOrders: orders => orders, verifyOrders: () => {}, authorizePlan: () => {} };
  let calls = 0;
  const planRunner = async payload => { calls++; assert.equal(payload.recompute, true); return structuredClone(saved.plan); };
  const request = recompute => new Request('http://localhost/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...saved, sharedInventory: [], recompute }) });
  const lookup = await handleExactPlanning(request(false), { complexity, planRunner });
  assert.equal(lookup.status, 200);
  assert.equal(calls, 0);
  const improved = await handleExactPlanning(request(true), { complexity, planRunner });
  assert.equal(improved.status, 200);
  assert.equal(calls, 1);
});
