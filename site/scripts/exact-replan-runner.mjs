import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureTransitIndex } from './transit-index.mjs';
import { projectRoot } from './project-root.mjs';
import { PLANNING_DEADLINE_MS, remainingMilliseconds, stopProcessTree } from './process-deadline.mjs';

const clock = value => String(value || '').match(/T(\d{2}:\d{2})/)?.[1] || String(value || '').slice(0, 5);

const addMinutes = (value, amount) => {
  const [hours, minutes] = clock(value).split(':').map(Number);
  const total = (Number(hours) * 60) + Number(minutes) + Number(amount || 0);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

const sourceId = item => String(item?.sourceId || item?.sourceData?.job_id || item?.sourceData?.engineer_id || item?.id || '').split(':').at(-1);

const inProject = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
};
const fromProject = (root, file) => path.isAbsolute(file) ? file : path.join(root, file);

const runPython = ({ python, script, args, payload, env, deadlineAt }) => new Promise((resolve, reject) => {
  const timeoutMs = remainingMilliseconds(deadlineAt);
  const child = spawn(python, [script, ...args], {
    cwd: env.BEEGO_REPOSITORY_ROOT,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopProcessTree(child); }, timeoutMs);
  timer.unref();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => {
    clearTimeout(timer);
    if (timedOut) { reject(new Error('Перепланирование остановлено после 15 минут: проверенный план не получен')); return; }
    const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    let result = null;
    try { result = lastLine ? JSON.parse(lastLine) : null; } catch { /* handled below */ }
    if (code === 0 && result?.status === 'EXACT_VALID') resolve(result);
    else reject(new Error(result?.error || stderr.trim() || stdout.trim() || `Exact planner exited with code ${code}`));
  });
  child.stdin.end(JSON.stringify(payload));
});

const ensureExactRouting = ({ python, repositoryRoot, env, deadlineAt }) => new Promise((resolve, reject) => {
  const timeoutMs = remainingMilliseconds(deadlineAt);
  const script = path.join(repositoryRoot, 'algorithm', 'tools', 'ensure_local_valhalla.py');
  const endpoint = String(env.VALHALLA_ROUTE_ENDPOINT || 'http://127.0.0.1:8002/route').replace(/\/route\/?$/, '');
  const child = spawn(python, [script, '--endpoint', endpoint], {
    cwd: repositoryRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopProcessTree(child); }, timeoutMs);
  timer.unref();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => {
    clearTimeout(timer);
    if (timedOut) { reject(new Error('Перепланирование остановлено после 15 минут: дорожный сервис не готов')); return; }
    const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    let result = null;
    try { result = lastLine ? JSON.parse(lastLine) : null; } catch { /* handled below */ }
    if (code === 0 && result?.status === 'READY') resolve(result);
    else reject(new Error(result?.error || stderr.trim() || stdout.trim() || 'Real Valhalla routing is unavailable'));
  });
});

export function compactExactReplan(raw, payload) {
  if (raw.status !== 'EXACT_VALID' || raw.publication_allowed !== true || raw.validation?.status !== 'VALID') {
    throw new Error('Перепланированный план не прошёл независимую точную валидацию');
  }
  const orderBySourceId = new Map((payload.orders || []).map(order => [sourceId(order), order]));
  const engineerBySourceId = new Map((payload.team || []).map(engineer => [sourceId(engineer), engineer]));
  const explanations = new Map((raw.explanations?.jobs || []).map(item => [String(item.job_id), item]));
  const routes = raw.plan.engineer_plans.map(route => {
    const engineer = engineerBySourceId.get(String(route.engineer_id));
    if (!engineer) throw new Error(`В интерфейсе отсутствует инженер ${route.engineer_id}`);
    const assignments = route.visits.map((visit, index) => {
      const order = orderBySourceId.get(String(visit.job_id));
      if (!order) throw new Error(`В интерфейсе отсутствует заявка ${visit.job_id}`);
      const travelMinutes = Number(visit.travel?.duration_minutes || 0);
      const distanceM = Number(visit.travel?.distance_m || 0);
      const explanation = explanations.get(String(visit.job_id));
      return {
        sourceOrderId: visit.job_id,
        orderId: order.id,
        engineerId: engineer.id,
        position: index + 1,
        departureAt: clock(visit.departure_at),
        arrival: addMinutes(visit.departure_at, travelMinutes),
        plannedStart: clock(visit.service_start_at),
        plannedFinish: addMinutes(visit.service_start_at, Number(order.duration || order.sourceData?.service_duration_min || 0)),
        travelMinutes,
        distanceM,
        manual: false,
        claimLevel: explanation?.claim_level || 'EXACT_VALIDATED',
        explanation: explanation?.summary_ru || '',
        geometry: Array.isArray(visit.travel?.geometry) ? visit.travel.geometry : [],
      };
    });
    const waitingMinutes = assignments.reduce((sum, assignment) => {
      const arrival = Number(assignment.arrival.slice(0, 2)) * 60 + Number(assignment.arrival.slice(3, 5));
      const start = Number(assignment.plannedStart.slice(0, 2)) * 60 + Number(assignment.plannedStart.slice(3, 5));
      return sum + Math.max(0, start - arrival);
    }, 0);
    const shiftStart = clock(engineer.shiftStart || engineer.sourceData?.shift_start || '08:00');
    const shiftEnd = clock(engineer.shiftEnd || engineer.sourceData?.shift_end || '18:00');
    const final = assignments.at(-1);
    const startMinutes = Number(shiftStart.slice(0, 2)) * 60 + Number(shiftStart.slice(3, 5));
    const finishMinutes = final ? Number(final.plannedFinish.slice(0, 2)) * 60 + Number(final.plannedFinish.slice(3, 5)) : startMinutes;
    return {
      engineerId: engineer.id,
      engineerName: engineer.name || route.engineer_id,
      shiftStart,
      shiftEnd,
      assignments,
      workloadMinutes: Math.max(0, finishMinutes - startMinutes),
      distanceKm: Math.round(assignments.reduce((sum, item) => sum + item.distanceM, 0) / 100) / 10,
      travelMinutes: assignments.reduce((sum, item) => sum + item.travelMinutes, 0),
      waitingMinutes,
      delayedDepartures: 0,
    };
  });
  const unassigned = raw.plan.unserved_job_ids.map(jobId => {
    const order = orderBySourceId.get(String(jobId));
    const explanation = explanations.get(String(jobId));
    if (!order) throw new Error(`В интерфейсе отсутствует неназначенная заявка ${jobId}`);
    return {
      sourceOrderId: jobId,
      orderId: order.id,
      reasonCode: explanation?.decision_kind || raw.unserved_reasons?.[jobId] || 'UNSERVED',
      reason: explanation?.summary_ru || raw.unserved_reasons?.[jobId] || 'Точный планировщик не нашёл допустимое назначение',
      claimLevel: explanation?.claim_level || 'BEST_CHECKED',
    };
  });
  const metrics = raw.validation.metrics;
  const assignmentExplanations = [...explanations.values()].filter(item => item.status === 'ASSIGNED').map(item => {
    const order = orderBySourceId.get(String(item.job_id));
    const engineer = engineerBySourceId.get(String(item.engineer_id));
    if (!order || !engineer) return null;
    const route = routes.find(candidate => String(candidate.engineerId) === String(engineer.id));
    const assignmentIndex = route?.assignments.findIndex(candidate => String(candidate.orderId) === String(order.id)) ?? -1;
    const assignment = assignmentIndex >= 0 ? route.assignments[assignmentIndex] : null;
    const next = assignmentIndex >= 0 ? route.assignments[assignmentIndex + 1] : null;
    const finish = assignment ? Number(assignment.plannedFinish.slice(0, 2)) * 60 + Number(assignment.plannedFinish.slice(3, 5)) : 0;
    const nextStart = next ? Number(next.plannedStart.slice(0, 2)) * 60 + Number(next.plannedStart.slice(3, 5)) : Number(route.shiftEnd.slice(0, 2)) * 60 + Number(route.shiftEnd.slice(3, 5));
    return {
      orderId: order.id,
      engineerId: engineer.id,
      engineerName: engineer.name || item.engineer_id,
      zone: order.zone || item.zone_id,
      requiredSkill: item.required_skill,
      engineerSkills: engineer.skills || [],
      transport: engineer.transport,
      travelMinutes: item.travel?.duration_minutes,
      distanceKm: Number(item.travel?.distance_m || 0) / 1000,
      plannedStart: clock(item.service_start_at),
      plannedFinish: clock(item.service_end_at),
      windowStart: order.start,
      windowEnd: order.end,
      serviceMinutes: Number(order.duration || order.sourceData?.service_duration_min || 0),
      scheduleBuffer: Math.max(0, nextStart - finish),
      nextVisitStart: next?.plannedStart || null,
      feasibleCandidateCount: Number(item.checked_alternatives?.length || 0) + 1,
      comparedEngineerCount: Number(item.static_eligible_engineers || 0),
      selectionRule: item.selection_rationale || 'EXACT_VALIDATED',
      constraintChecks: item.constraint_checks || {},
    };
  }).filter(Boolean);
  return {
    id: `exact-${raw.content_sha256.slice(0, 12)}`,
    algorithm: 'beeline-planning-ortools-exact-v2.1-full-coverage-28-teams',
    provider: raw.routing_configuration?.provider || 'valhalla-local-transit',
    createdAt: raw.plan.planning_at,
    status: raw.status,
    publicationAllowed: true,
    validation: { status: raw.validation.status, metrics },
    datasetSha256: raw.dataset_sha256,
    contentSha256: raw.content_sha256,
    routes,
    unassigned,
    event: raw.explanations?.event || null,
    changes: raw.changes || null,
    assignmentExplanations,
    exactRouteChecks: raw.exact_route_checks,
    searchPhase: raw.search_phase || null,
    metrics: {
      total: (payload.orders || []).length,
      assigned: routes.reduce((sum, route) => sum + route.assignments.length, 0),
      unassigned: unassigned.length,
      activeEngineers: Number(metrics.used_engineers || 0),
      urgentAssigned: Number(metrics.served_urgent_jobs || 0),
      distanceKm: Math.round(Number(metrics.total_distance_m || 0) / 100) / 10,
      travelMinutes: Number(metrics.total_travel_minutes || 0),
      waitingMinutes: Number(metrics.total_waiting_minutes || 0),
      additionalEngineers: 0,
    },
  };
}

/**
 * Runs the Python exact replanner. Missing routing evidence is an error; no estimate is substituted.
 */
export async function runExactReplan(payload, repositoryRoot = process.cwd(), { deadlineAt = Date.now() + PLANNING_DEADLINE_MS } = {}) {
  repositoryRoot = projectRoot(repositoryRoot);
  const output = path.join(tmpdir(), `beego-exact-replan-${randomUUID()}.json`);
  const python = process.env.BEEGO_PYTHON || 'python';
  const script = path.join(repositoryRoot, 'algorithm', 'tools', 'replan_ui_event.py');
  const env = {
    ...process.env,
    BEEGO_REPOSITORY_ROOT: repositoryRoot,
    PYTHONPATH: path.join(repositoryRoot, 'algorithm', 'src'),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
  const sourceHash = String(payload.basePlanContentSha256 || payload.plan?.contentSha256 || '');
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('У исходного плана нет корректной контрольной суммы');
  const canonicalPlan = path.join(repositoryRoot, 'algorithm', 'artifacts', 'current', 'initial-exact-205-of-205-retimed.json');
  const canonical = JSON.parse(await readFile(canonicalPlan, 'utf8'));
  let dataset = path.join(repositoryRoot, 'data', 'dataset');
  let inputPlan = canonicalPlan;
  let cache = path.join(repositoryRoot, 'runtime', 'full-coverage-route-cache.sqlite3');
  let savedTransitIndex = '';
  if (sourceHash !== canonical.content_sha256) {
    let matched = false;
    const retainedPlan = path.join(repositoryRoot, 'runtime', 'exact-replans', `${sourceHash}.json`);
    const retained = JSON.parse(await readFile(retainedPlan, 'utf8').catch(() => 'null'));
    if (retained?.content_sha256 === sourceHash && retained?.publication_allowed === true) {
      const metadata = JSON.parse(await readFile(`${retainedPlan}.meta.json`, 'utf8').catch(() => 'null'));
      if (!metadata?.dataset || !metadata?.cache) throw new Error('Исходные данные сохранённого плана не найдены');
      dataset = fromProject(repositoryRoot, metadata.dataset);
      cache = fromProject(repositoryRoot, metadata.cache);
      savedTransitIndex = metadata.transitIndex ? fromProject(repositoryRoot, metadata.transitIndex) : '';
      inputPlan = retainedPlan;
      matched = true;
    }
    if (!matched && /^\d{4}-\d{2}-\d{2}$/.test(payload.planningDate || '')) {
      const dayRoot = path.join(repositoryRoot, 'history', payload.planningDate);
      const historicalPlan = path.join(dayRoot, 'final-exact.json');
      const historical = JSON.parse(await readFile(historicalPlan, 'utf8').catch(() => 'null'));
      if (historical?.content_sha256 === sourceHash && historical?.publication_allowed === true) {
        const status = JSON.parse(await readFile(path.join(dayRoot, 'status.json'), 'utf8').catch(() => 'null'));
        dataset = path.join(dayRoot, 'dataset');
        inputPlan = historicalPlan;
        cache = path.join(repositoryRoot, 'runtime', 'ui-shared-cache', 'routing-cache.sqlite3');
        savedTransitIndex = status?.transit_index || '';
        matched = true;
      }
    }
    const runRoot = path.join(repositoryRoot, 'runtime', 'ui-runs');
    for (const entry of matched ? [] : await readdir(runRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const candidateRoot = path.join(runRoot, entry.name);
      const manifest = JSON.parse(await readFile(path.join(candidateRoot, 'results', 'pipeline-run.json'), 'utf8').catch(() => 'null'));
      if (!manifest?.publishable_final_plan) continue;
      const candidate = JSON.parse(await readFile(manifest.publishable_final_plan, 'utf8').catch(() => 'null'));
      if (candidate?.content_sha256 !== sourceHash) continue;
      dataset = path.join(candidateRoot, 'dataset');
      inputPlan = manifest.publishable_final_plan;
      cache = path.join(repositoryRoot, 'runtime', 'ui-shared-cache', 'routing-cache.sqlite3');
      matched = true;
      break;
    }
    if (!matched) throw new Error('Исходный точный план не найден; перестройте план перед назначением');
  }
  const datasetManifest = JSON.parse(await readFile(path.join(dataset, 'manifest.json'), 'utf8'));
  const requiresTransit = typeof datasetManifest.requires_public_transit === 'boolean'
    ? datasetManifest.requires_public_transit
    : (await readFile(path.join(dataset, 'common', 'engineers.csv'), 'utf8')).includes('PUBLIC_TRANSIT');
  const retainedTransitIndex = savedTransitIndex && await access(savedTransitIndex).then(() => savedTransitIndex, () => '');
  const transitIndex = retainedTransitIndex || await ensureTransitIndex(
    requiresTransit ? datasetManifest.planning_date : '2026-08-17', repositoryRoot,
    { deadlineAt },
  );
  const args = [
    '--dataset', dataset,
    '--input-plan', inputPlan,
    '--cache', cache,
    '--transit-index', transitIndex,
    '--output', output,
  ];
  try {
    await ensureExactRouting({ python, repositoryRoot, env, deadlineAt });
    await runPython({ python, script, args, payload, env, deadlineAt });
    const raw = JSON.parse(await readFile(output, 'utf8'));
    const result = compactExactReplan(raw, payload);
    const retainedRoot = path.join(repositoryRoot, 'runtime', 'exact-replans');
    await mkdir(retainedRoot, { recursive: true });
    const retainedPlan = path.join(retainedRoot, `${raw.content_sha256}.json`);
    await copyFile(output, retainedPlan);
    await writeFile(`${retainedPlan}.meta.json`, JSON.stringify({
      dataset: inProject(repositoryRoot, dataset),
      cache: inProject(repositoryRoot, cache),
      transitIndex: inProject(repositoryRoot, transitIndex),
    }));
    return result;
  } finally {
    await unlink(output).catch(() => {});
  }
}
