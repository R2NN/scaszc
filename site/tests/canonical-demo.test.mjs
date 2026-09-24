import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { canonicalDemoInput } from '../src/canonicalDemo.js';
import worker, { buildExactPlan } from '../worker/index.js';
import { PLANNING_DEADLINE_MS, remainingMilliseconds } from '../scripts/process-deadline.mjs';

const fixture = JSON.parse(await readFile(new URL('../public/test-data/beego-algorithm-initial.json', import.meta.url), 'utf8'));
const artifact = JSON.parse(await readFile(new URL('../public/data/beego-exact-plans.json', import.meta.url), 'utf8'));

test('default site dataset resolves to the independently validated 205/205 plan', () => {
  const input = canonicalDemoInput(fixture, artifact);
  const result = buildExactPlan({ ...input, regionId: 'moscow' }, artifact);
  assert.equal(input.planningDate, '2026-08-17');
  assert.equal(input.orders.length, 205);
  assert.equal(result.status, 'EXACT_VALID');
  assert.equal(result.validation.status, 'VALID');
  assert.equal(result.metrics.assigned, 205);
  assert.equal(result.metrics.unassigned, 0);
  assert.equal(result.contentSha256, artifact.plans.initial.contentSha256);
});

test('planning deadline is shared across preparation and optimization', () => {
  assert.equal(PLANNING_DEADLINE_MS, 900_000);
  assert.throws(() => remainingMilliseconds(Date.now() - 1), /15 минут/);
});

test('remote exact planner reports a clear timeout instead of a fallback plan', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new DOMException('expired', 'TimeoutError'); };
  try {
    const response = await worker.fetch(new Request('http://localhost/api/plan', {
      method: 'POST',
      body: '{}',
    }), { EXACT_PLANNER_URL: 'http://localhost:8787' });
    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /15 минут/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
