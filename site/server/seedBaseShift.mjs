import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalDemoInput } from '../src/canonicalDemo.js';
import { isCanonicalPlanningInput } from '../scripts/is-canonical-planning-input.mjs';
import exactWorker from '../worker/exact-base.js';
import { fillExactIdentityGeometry } from './exactPlanGeometry.mjs';

const siteRoot = path.resolve(import.meta.dirname, '..');

/** Initialize a fresh operational store from the retained, validated planning base. */
export async function seedBaseShift(store) {
  const existing = store.byDate('moscow', '2026-08-17');
  if (existing) {
    const repaired = fillExactIdentityGeometry(existing.plan, existing.orders);
    if (JSON.stringify(repaired) !== JSON.stringify(existing.plan)) {
      store.db.prepare('UPDATE plan_versions SET plan_json = ? WHERE id = ?').run(JSON.stringify(repaired), existing.currentPlanId);
    }
    return;
  }
  const artifact = JSON.parse(await readFile(path.join(siteRoot, 'public/data/beego-exact-plans.json'), 'utf8'));
  const fixture = JSON.parse(await readFile(path.join(siteRoot, 'public/test-data/beego-algorithm-initial.json'), 'utf8'));
  const input = canonicalDemoInput(fixture, artifact);
  const payload = { orders: input.orders, engineers: input.engineers, regionId: 'moscow', planningDate: input.planningDate };
  if (!isCanonicalPlanningInput(payload, artifact, siteRoot)) throw new Error('Основной набор не совпадает с точным опубликованным планом.');
  const response = await exactWorker.fetch(new Request('http://localhost/api/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }), { PLANNING_ARTIFACT_JSON: JSON.stringify(artifact) });
  const plan = await response.json();
  if (!response.ok || plan.status !== 'EXACT_VALID' || plan.metrics?.assigned !== 205 || plan.metrics?.total !== 205) {
    throw new Error(plan.error || 'Основной точный план не прошёл проверку при загрузке.');
  }
  store.ensure({ regionId: 'moscow', date: input.planningDate, orders: input.orders, team: input.engineers,
    plan: fillExactIdentityGeometry(plan, input.orders) });
}
