import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { runExactPlan } from '../scripts/exact-plan-runner.mjs';
import { isCanonicalPlanningInput } from '../scripts/is-canonical-planning-input.mjs';
import { projectRoot } from '../scripts/project-root.mjs';
import exactWorker from '../worker/exact-base.js';
import { fillExactIdentityGeometry } from './exactPlanGeometry.mjs';
import { historicalInventory } from './exactShiftReplan.mjs';
import { acquirePlanningSlot, planningBusyResponse, withPlanningSlot } from './planningSlot.mjs';

const siteRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = projectRoot(siteRoot);
const artifactFile = path.join(siteRoot, 'public', 'data', 'beego-exact-plans.json');
let artifactPromise;
const jobs = new Map();

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function calculateExactPlan(payload, onProgress = () => {}) {
  artifactPromise ||= readFile(artifactFile, 'utf8').then(JSON.parse);
  const artifact = await artifactPromise;
  const planningDate = payload.planningDate || payload.date || payload.orders[0]?.serviceDate || payload.orders[0]?.sourceData?.window_start?.slice(0, 10);
  const input = { ...payload, planningDate };
  let plan;
  if (isCanonicalPlanningInput(input, artifact, siteRoot)) {
    onProgress({ phase: 'LOOKUP_VALIDATED_PLAN' });
    const response = await exactWorker.fetch(new Request('http://localhost/api/plan', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }), { PLANNING_ARTIFACT_JSON: JSON.stringify(artifact) });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error(failure.error || 'Не удалось получить проверенный план.');
    }
    plan = await response.json();
  } else {
    const sharedInventory = Array.isArray(input.sharedInventory)
      ? input.sharedInventory
      : await historicalInventory(planningDate, repositoryRoot);
    plan = await runExactPlan({ ...input, sharedInventory }, repositoryRoot, onProgress);
  }
  onProgress({ phase: 'VALIDATING_PLAN' });
  if (plan.status !== 'EXACT_VALID' || plan.publicationAllowed !== true || plan.validation?.status !== 'VALID' || plan.approximateTravel === true) {
    throw new Error('Точный план не прошёл независимую проверку и не может быть опубликован.');
  }
  return fillExactIdentityGeometry(plan, input.orders);
}

/** Serve exact plans and expose real server phases for background calculations. */
export async function handleExactPlanning(request) {
  const url = new URL(request.url);
  const jobId = /^\/api\/plan\/jobs\/([\w-]+)$/.exec(url.pathname)?.[1];
  if (jobId && request.method === 'GET') {
    const job = jobs.get(jobId);
    return job ? json(job) : json({ error: 'Расчёт не найден.' }, 404);
  }
  if (!['/api/plan', '/api/plan/jobs'].includes(url.pathname) || request.method !== 'POST') return null;
  try {
    const payload = await request.json();
    if (!Array.isArray(payload.orders) || !Array.isArray(payload.engineers)) {
      return json({ error: 'Передайте заявки и инженеров для расчёта.' }, 400);
    }
    if (url.pathname === '/api/plan/jobs') {
      const release = acquirePlanningSlot();
      if (!release) return planningBusyResponse();
      const job = { id: randomUUID(), status: 'RUNNING', progress: { phase: 'VALIDATING_INPUT' }, startedAt: new Date().toISOString() };
      jobs.set(job.id, job);
      setTimeout(() => jobs.delete(job.id), 30 * 60_000).unref?.();
      Promise.resolve().then(async () => {
        const result = await calculateExactPlan(payload, progress => { job.progress = progress; });
        job.status = 'READY';
        job.progress = { phase: 'READY' };
        job.result = result;
      }).catch(error => {
        job.status = 'FAILED';
        job.error = error?.message || 'Точный расчёт не выполнен';
      }).finally(release);
      return json({ id: job.id, status: job.status, progress: job.progress, startedAt: job.startedAt }, 202);
    }
    return json(await withPlanningSlot(() => calculateExactPlan(payload)));
  } catch (error) {
    if (error?.code === 'PLANNING_BUSY') return planningBusyResponse();
    return json({ error: error?.message || 'Точный расчёт не выполнен', code: error?.code || 'EXACT_PLANNING_FAILED', details: error?.details }, error?.code === 'INVALID_INPUT' ? 422 : 503);
  }
}
