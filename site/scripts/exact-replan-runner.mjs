import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
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

const runPython = ({ python, script, args, payload, env, deadlineAt, signal }) => new Promise((resolve, reject) => {
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
  const abort = () => stopProcessTree(child);
  signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => { timedOut = true; stopProcessTree(child); }, timeoutMs);
  timer.unref();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => {
    signal?.removeEventListener('abort', abort);
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

const configureRouting = async input => {
  const endpoint = String(input.env.VALHALLA_ROUTE_ENDPOINT || 'http://127.0.0.1:8002/route').replace(/\/route\/?$/, '');
  if (['http://127.0.0.1:8002', 'http://localhost:8002'].includes(endpoint)) return ensureExactRouting(input);
  const response = await fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Дорожный сервис недоступен. Прежний план сохранён.');
  const status = await response.json();
  const tile = status.tile_revision || (status.version && Number.isInteger(status.tileset_last_modified) ? `valhalla-status:${status.version}:${status.tileset_last_modified}` : null);
  if (!tile) throw new Error('Дорожный сервис не сообщил версию дорожных данных.');
  input.env.VALHALLA_TILE_REVISION = tile;
  input.env.VALHALLA_RUNTIME_REVISION = `${status.runtime_revision || 'external-valhalla'}:tiles:${tile}`;
};

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
        geometry: visit.travel?.type === 'IDENTITY' && Array.isArray(order.coords) ? [order.coords, order.coords] : Array.isArray(visit.travel?.geometry) ? visit.travel.geometry : [],
        ...(payload.transportRestrictions?.length ? {travelSteps:(visit.travel?.itinerary || []).map(step=>({mode:step.mode,geometry:step.geometry,seconds:step.duration_seconds,distanceM:step.distance_m,
          lineId:step.attributes?.line_id,line:step.attributes?.line,from:step.attributes?.from_station || step.attributes?.from_stop,
          to:step.attributes?.to_station || step.attributes?.to_stop,geometryQuality:step.attributes?.geometry_quality}))} : {}),
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
      movements: route.movements || [],
      workloadMinutes: Math.max(0, finishMinutes - startMinutes),
      distanceKm: Math.round((assignments.reduce((sum, item) => sum + item.distanceM, 0) + (route.movements || []).reduce((sum, item) => sum + item.distance_m, 0)) / 100) / 10,
      travelMinutes: assignments.reduce((sum, item) => sum + item.travelMinutes, 0) + (route.movements || []).reduce((sum, item) => sum + item.travel_minutes, 0),
      waitingMinutes: Number(raw.validation?.metrics?.waiting_minutes_by_engineer?.[route.engineer_id] ?? waitingMinutes),
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
      diagnosticSummary: raw.unserved_detailed_audit?.jobs?.[jobId]?.summary_ru || null,
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
    ...(payload.transportRestrictions ? {transportRestrictions:payload.transportRestrictions} : {}),
    algorithm: 'beeline-planning-ortools-exact-v2.1-duration-contract',
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
    candidateDiagnostics: raw.unserved_detailed_audit?.jobs || null,
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
export async function runExactReplan(payload, repositoryRoot = process.cwd(), { deadlineAt = Date.now() + PLANNING_DEADLINE_MS, onProgress = () => {}, signal } = {}) {
  repositoryRoot = projectRoot(repositoryRoot);
  await mkdir(path.join(repositoryRoot, 'runtime', 'exact-replans'), { recursive: true });
  const output = path.join(repositoryRoot, 'runtime', 'exact-replans', `.pending-${randomUUID()}.json`);
  const python = process.env.BEEGO_PYTHON || 'python';
  const script = path.join(repositoryRoot, 'algorithm', 'tools', 'replan_ui_event.py');
  const env = {
    ...process.env,
    BEEGO_REPOSITORY_ROOT: repositoryRoot,
    BEELINE_ROUTING_USAGE_LEDGER: process.env.BEELINE_ROUTING_USAGE_LEDGER || path.join(repositoryRoot, 'runtime', 'routing-usage.sqlite3'),
    PYTHONPATH: path.join(repositoryRoot, 'algorithm', 'src'),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    BEEGO_TRANSPORT_CONTEXT_JSON: JSON.stringify(payload.transportRestrictions || payload.plan?.transportRestrictions || []),
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
    const complexityPlan = path.join(repositoryRoot, 'algorithm', 'artifacts', 'complexity', 'initial-exact.json');
    const complexity = JSON.parse(await readFile(complexityPlan, 'utf8').catch(() => 'null'));
    if (complexity?.content_sha256 === sourceHash && complexity?.publication_allowed === true) {
      dataset = path.join(repositoryRoot, 'data', 'object-complexity', 'dataset');
      inputPlan = complexityPlan;
      cache = path.join(repositoryRoot, 'runtime', 'ui-shared-cache', 'routing-cache.sqlite3');
      matched = true;
    }
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
    '--max-route-checks', String(Math.max(1, Math.min(400, Number(process.env.BEEGO_REPLAN_ROUTE_CHECKS) || 400))),
    '--departure-timing-queries', String(payload.transportRestrictions ? 0 : Math.max(0, Math.min(100, Number(process.env.BEEGO_REPLAN_TIMING_QUERIES ?? 24)))),
  ];
  try {
    await configureRouting({ python, repositoryRoot, env, deadlineAt });
    const progressFile = output.replace(/\.json$/, '.progress.json');
    const compactCandidates = new Map();
    let polling = false;
    let previousProgress = '';
    const poll = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const serialized = await readFile(progressFile, 'utf8').catch(() => '');
        if (!serialized || serialized === previousProgress) return;
        const progress = JSON.parse(serialized);
        const dispatchCandidates = [];
        for (const sha of progress.candidateArtifacts || []) {
          if (compactCandidates.has(sha)) {
            dispatchCandidates.push(compactCandidates.get(sha));
            continue;
          }
          const file = path.join(repositoryRoot,'runtime','exact-replans',`${sha}.json`);
          const candidate = JSON.parse(await readFile(file,'utf8').catch(() => 'null'));
          if (!candidate) continue;
          await writeFile(`${file}.meta.json`,JSON.stringify({dataset:inProject(repositoryRoot,dataset),cache:inProject(repositoryRoot,cache),transitIndex:inProject(repositoryRoot,transitIndex)}));
          const compact = {engineerSourceId:candidate.dispatch_engineer_id,plan:compactExactReplan(candidate,payload),artifact:inProject(repositoryRoot,file),improvesContentSha256:candidate.improves_content_sha256,coverageRepair:candidate.coverage_repair};
          compactCandidates.set(sha, compact);
          dispatchCandidates.push(compact);
        }
        onProgress({...progress,dispatchCandidates});
        previousProgress = serialized;
      } catch { /* Atomic progress can disappear as the worker finishes. */ }
      finally { polling = false; }
    }, 1500);
    poll.unref();
    try {
      await runPython({ python, script, args, payload, env, deadlineAt, signal });
    } catch (error) {
      const partial = JSON.parse(await readFile(output, 'utf8').catch(() => 'null'));
      if (!payload.dispatch || !partial?.dispatch_candidates?.length) throw error;
      partial.dispatch_search = { ...partial.dispatch_search, complete:false, stoppedReason:error.message };
      await writeFile(output, JSON.stringify(partial));
    } finally { clearInterval(poll); await unlink(progressFile).catch(() => {}); }
    const bundle = JSON.parse(await readFile(output, 'utf8'));
    const raw = bundle.dispatch_candidates?.[0] || bundle;
    const result = compactExactReplan(raw, payload);
    const retainedRoot = path.join(repositoryRoot, 'runtime', 'exact-replans');
    await mkdir(retainedRoot, { recursive: true });
    const retainedPlan = path.join(retainedRoot, `${raw.content_sha256}.json`);
    if (!bundle.dispatch_candidates) await copyFile(output, retainedPlan);
    else await access(retainedPlan);
    await writeFile(`${retainedPlan}.meta.json`, JSON.stringify({
      dataset: inProject(repositoryRoot, dataset),
      cache: inProject(repositoryRoot, cache),
      transitIndex: inProject(repositoryRoot, transitIndex),
    }));
    if (bundle.dispatch_candidates) {
      result.dispatchCandidates = [];
      for (const candidate of bundle.dispatch_candidates) {
        const file = path.join(retainedRoot, `${candidate.content_sha256}.json`);
        await access(file);
        await writeFile(`${file}.meta.json`, JSON.stringify({ dataset: inProject(repositoryRoot, dataset), cache: inProject(repositoryRoot, cache), transitIndex: inProject(repositoryRoot, transitIndex) }));
        result.dispatchCandidates.push({ engineerSourceId: candidate.dispatch_engineer_id, plan: compactExactReplan(candidate, payload), artifact: inProject(repositoryRoot, file), improvesContentSha256:candidate.improves_content_sha256, coverageRepair:candidate.coverage_repair });
      }
      result.dispatchSearch = bundle.dispatch_search;
    }
    return result;
  } finally {
    await unlink(output).catch(() => {});
  }
}
