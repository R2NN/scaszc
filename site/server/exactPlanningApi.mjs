import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runExactPlan } from '../scripts/exact-plan-runner.mjs';
import { isCanonicalPlanningInput } from '../scripts/is-canonical-planning-input.mjs';
import { projectRoot } from '../scripts/project-root.mjs';
import exactWorker from '../worker/exact-base.js';
import { fillExactIdentityGeometry } from './exactPlanGeometry.mjs';

const siteRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = projectRoot(siteRoot);
const artifactFile = path.join(siteRoot, 'public', 'data', 'beego-exact-plans.json');
let artifactPromise;

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/** Serve only independently validated exact plans from the retained planning base. */
export async function handleExactPlanning(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/plan' || request.method !== 'POST') return null;
  try {
    const payload = await request.json();
    if (!Array.isArray(payload.orders) || !Array.isArray(payload.engineers)) {
      return json({ error: 'Передайте заявки и инженеров для расчёта.' }, 400);
    }
    artifactPromise ||= readFile(artifactFile, 'utf8').then(JSON.parse);
    const artifact = await artifactPromise;
    const planningDate = payload.planningDate || payload.date || payload.orders[0]?.serviceDate || payload.orders[0]?.sourceData?.window_start?.slice(0, 10);
    const input = { ...payload, planningDate };
    let plan;
    if (isCanonicalPlanningInput(input, artifact, siteRoot)) {
      const response = await exactWorker.fetch(new Request('http://localhost/api/plan', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      }), { PLANNING_ARTIFACT_JSON: JSON.stringify(artifact) });
      if (!response.ok) return response;
      plan = await response.json();
    } else {
      plan = await runExactPlan(input, repositoryRoot);
    }
    if (plan.status !== 'EXACT_VALID' || plan.publicationAllowed !== true || plan.validation?.status !== 'VALID' || plan.approximateTravel === true) {
      throw new Error('Точный план не прошёл независимую проверку и не может быть опубликован.');
    }
    return json(fillExactIdentityGeometry(plan, input.orders));
  } catch (error) {
    return json({ error: error?.message || 'Точный расчёт не выполнен', code: error?.code || 'EXACT_PLANNING_FAILED', details: error?.details }, error?.code === 'INVALID_INPUT' ? 422 : 503);
  }
}
