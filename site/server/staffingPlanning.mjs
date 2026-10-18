import { engineerIdentity } from '../src/engineerPresentation.js';
import { ratingPlanningShift } from './ratingProfiles.mjs';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../scripts/project-root.mjs';
import { compactExactReplan } from '../scripts/exact-replan-runner.mjs';
import { fillExactIdentityGeometry } from './exactPlanGeometry.mjs';
import { findRatingSource } from './ratingPlanning.mjs';
import { ensureTransitIndex } from '../scripts/transit-index.mjs';
import { stopProcessTree } from '../scripts/process-deadline.mjs';
import { ratingFingerprint } from './ratingStore.mjs';

const id = engineerIdentity;
const profile = item => JSON.stringify([item.zoneId, item.shiftStart, item.shiftEnd, item.transport, item.startCoords,
  [...(item.skills || [])].sort(), [...(item.equipment || [])].sort(), item.sourceData?.max_jobs || 10, item.sourceData?.max_route_minutes || 720]);

export function staffingOptions(input = {}) {
  const qualityFloor = input.qualityFloor == null ? 4.2 : Number(input.qualityFloor);
  if (!Number.isFinite(qualityFloor) || qualityFloor < 1 || qualityFloor > 5) throw new Error('Порог рейтинга должен быть от 1 до 5.');
  const qualityCeiling = input.qualityCeiling == null ? 5 : Number(input.qualityCeiling);
  if (!Number.isFinite(qualityCeiling) || qualityCeiling < qualityFloor || qualityCeiling > 5) throw new Error('Верхняя граница рейтинга должна быть не ниже нижней и не выше 5.');
  if (input.pool != null && !['all', 'staff'].includes(input.pool)) throw new Error('Выберите доступный состав.');
  if (input.addTemplateId != null && (typeof input.addTemplateId !== 'string' || input.addTemplateId.length > 100)) throw new Error('Выберите профиль дополнительного специалиста.');
  return { qualityFloor, qualityCeiling, pool: input.pool || 'staff', addTemplateId: input.addTemplateId || null };
}

export function staffingBreakdown(shift, catalog, options = {}, missing = null) {
  shift = ratingPlanningShift(shift);
  const settings = staffingOptions(options);
  const roster = new Map(shift.team.map(item => [id(item), item]));
  const candidates = catalog.filter(item => (settings.pool === 'all' || item.kind === 'staff') && item.available !== false && item.rating.score >= settings.qualityFloor && item.rating.score <= settings.qualityCeiling);
  const groups = new Map();
  for (const route of shift.plan?.routes || []) {
    if (!route.assignments.length) continue;
    const engineer = roster.get(id({ id: route.engineerId }));
    if (!engineer) continue;
    const key = profile(engineer);
    if (!groups.has(key)) groups.set(key, { key, templateId: id(engineer), zone: engineer.zone, zoneId: engineer.zoneId,
      skills: engineer.skills, transport: engineer.transport, equipment: engineer.equipment, startAddress: engineer.startAddress,
      startCoords: engineer.startCoords, shiftStart: engineer.shiftStart, shiftEnd: engineer.shiftEnd, needed: 0, jobs: 0,
      available: candidates.filter(item => profile(item) === key).length });
    const group = groups.get(key); group.needed++; group.jobs += route.assignments.length;
  }
  const added = roster.get(settings.addTemplateId);
  if (added && groups.has(profile(added))) groups.get(profile(added)).available++;
  return [...groups.values()].map(group => ({ ...group, shortage: missing ? missing.filter(item => {
    const engineer = roster.get(item.templateId); return engineer && profile(engineer) === group.key;
  }).length : Math.max(0, group.needed - group.available) }));
}

export function staffingForecast(shift, catalog, forecast, options = {}) {
  if (!forecast || !shift?.plan?.routes?.length) return null;
  const profiles = staffingBreakdown(shift, catalog, options);
  const sourceMix = new Map();
  for (const order of shift.orders) {
    const zone = order.zone, skill = order.skill;
    if (!sourceMix.has(zone)) sourceMix.set(zone, {});
    sourceMix.get(zone)[skill] = (sourceMix.get(zone)[skill] || 0) + 1;
  }
  // Forecast only contains marginal totals. Fit an estimated joint zone/skill
  // mix to those margins, anchored in the observed jobs; never present this
  // inferred distribution as address-level model output.
  const joint = band => {
    const cells = forecast.zones.map(zone => forecast.skills.map(skill => Math.max(.001, sourceMix.get(zone.name)?.[skill.name] || 0)));
    const skillTotal = forecast.skills.reduce((n, item) => n + item[band], 0);
    const zoneTotal = forecast.zones.reduce((n, item) => n + item[band], 0);
    for (let pass = 0; pass < 60; pass++) {
      for (let z = 0; z < cells.length; z++) {
        const sum = cells[z].reduce((n, value) => n + value, 0);
        cells[z] = cells[z].map(value => sum ? value * forecast.zones[z][band] / sum : 0);
      }
      for (let s = 0; s < forecast.skills.length; s++) {
        const sum = cells.reduce((n, row) => n + row[s], 0), target = skillTotal ? forecast.skills[s][band] * zoneTotal / skillTotal : 0;
        for (let z = 0; z < cells.length; z++) cells[z][s] = sum ? cells[z][s] * target / sum : 0;
      }
    }
    return cells;
  };
  const mixes = Object.fromEntries(['low','middle','high'].map(band => [band, joint(band)]));
  const zones = forecast.zones.map((zone, z) => {
    const local = profiles.filter(item => item.zone === zone.name);
    const jobs = local.reduce((sum, item) => sum + item.jobs, 0);
    const crews = local.reduce((sum, item) => sum + item.needed, 0);
    const estimate = band => {
      if (!jobs || !crews) return { count: null, allocations: [] };
      const residual = Object.fromEntries(forecast.skills.map((skill, s) => [skill.name, mixes[band][z][s]]));
      const allocations = local.map(item => ({ ...item, forecastNeeded: 0 }));
      let count = 0;
      for (; count < 10000 && Object.values(residual).some(value => value > .0001); count++) {
        let best = null;
        for (const row of allocations) {
          const capacity = row.jobs / row.needed;
          const covered = Math.min(capacity, (row.skills || []).reduce((sum, skill) => sum + (residual[skill] || 0), 0));
          const existing = row.forecastNeeded < row.available;
          if (covered > .0001 && (!best || existing && !best.existing || existing === best.existing && (covered > best.covered + .0001 || Math.abs(covered-best.covered)<.0001 && row.templateId < best.row.templateId))) best = { row, covered, capacity, existing };
        }
        if (!best) return { count, allocations, uncovered: residual };
        best.row.forecastNeeded++;
        let remaining = best.capacity;
        // Prioritize urgent demand and then scarce single-skill coverage.
        for (const skill of [...best.row.skills].sort((a, b) => (b === 'EMERGENCY') - (a === 'EMERGENCY') || (residual[b] || 0) - (residual[a] || 0))) {
          const consumed = Math.min(remaining, residual[skill] || 0);
          residual[skill] = Math.max(0, (residual[skill] || 0) - consumed); remaining -= consumed;
        }
      }
      return { count, allocations };
    };
    const mid = estimate('middle'), low = estimate('low'), upper = estimate('high');
    const middle = mid.count, high = upper.count == null || middle == null ? null : Math.max(middle, upper.count);
    return { ...zone, engineersLow: low.count == null || middle == null ? null : Math.min(low.count,middle), engineers: middle, engineersHigh: high,
      reserve: middle == null || high == null ? null : high - middle, available: local.reduce((sum, item) => sum + item.available, 0),
      uncovered: Object.entries(mid.uncovered || {}).filter(([, demand]) => demand > .0001).map(([skill, demand]) => ({ skill, demand })),
      estimatedSkills: forecast.skills.map((skill, s) => ({ skill:skill.name, demand:mixes.middle[z][s] })),
      profiles: mid.allocations.map(item => ({ ...item, shortage: Math.max(0, item.forecastNeeded - item.available) })) };
  });
  const sum = key => zones.some(item => item[key] == null) ? null : zones.reduce((n, item) => n + item[key], 0);
  return { targetDate: forecast.targetDate, model: forecast.model, training: forecast.training, demand: forecast.total,
    zones, engineers: sum('engineers'), engineersLow: sum('engineersLow'), engineersHigh: sum('engineersHigh'), reserve: sum('reserve'),
    calibrationDate: shift.date, calibrationJobs: profiles.reduce((n, p) => n + p.jobs, 0),
    complete: !zones.some(zone => zone.uncovered?.length || zone.engineers == null),
    method: 'Потребность оценена по прогнозу районов и навыков. Их совместное распределение восстановлено по структуре заявок проверенного дня; это оценка, а не прогноз конкретных адресов. Подбираем профили по навыкам и наблюдаемой производительности, начиная со срочных работ. Резерв — разница между верхним и средним сценарием.',
    limitations: 'Это оценка для подготовки состава. До появления адресов и окон она не подтверждает маршруты, SLA или доступность специалиста на срочный вызов. Новые адреса и изменение сложности потребуют нового расчёта.' };
}

// This proposal uses the checked day's profile demand. It does not build roads
// or promise a smaller crew; the exact solver runs only after confirmation.
export function proposeStaffingTeam(shift, catalog, input = {}) {
  shift = ratingPlanningShift(shift);
  const settings = staffingOptions(input);
  if (shift.facts?.some(item => ['started', 'completed'].includes(item.status))) throw new Error('Смена уже исполняется. Состав рассчитывается до начала работ.');
  if (shift.plan?.status !== 'EXACT_VALID') throw new Error('Сначала постройте проверенный план выбранного дня.');
  const originals = new Map(shift.team.map(item => [id(item), item]));
  const candidates = catalog.filter(item => (settings.pool === 'all' || item.kind === 'staff') && item.available !== false
    && item.rating.score >= settings.qualityFloor && item.rating.score <= settings.qualityCeiling
    && originals.has(item.templateId) && profile(item) === profile(originals.get(item.templateId)))
    .map(item => ({ ...item, id: id(item), sourceId: id(item) }));
  if (settings.addTemplateId) {
    const template = originals.get(settings.addTemplateId);
    if (!template) throw new Error('Профиль дополнительного инженера отсутствует в выбранном дне.');
    candidates.push({ ...template, id: `WHATIF-${settings.addTemplateId}`, sourceId: `WHATIF-${settings.addTemplateId}`,
      templateId: settings.addTemplateId, name: 'Дополнительный специалист', hypothetical: true, rating: { score: settings.qualityFloor, count: 0 } });
  }
  candidates.sort((a, b) => b.rating.score - a.rating.score || a.id.localeCompare(b.id));
  const routes = shift.plan.routes.filter(route => route.assignments.length);
  const lockedEngineerIds = routes.filter(route => route.assignments.some(a => a.manual)).map(route => id({ id: route.engineerId }));
  const used = new Set(lockedEngineerIds), team = [], missing = [];
  for (const key of lockedEngineerIds) {
    const original = originals.get(key), rated = catalog.find(item => id(item) === key);
    if (!original) throw new Error('Не найден инженер ручного закрепления.');
    team.push({ ...original, ...rated, id: key, sourceId: key, templateId: key, locked: true });
  }
  for (const route of routes.filter(route => !lockedEngineerIds.includes(id({ id: route.engineerId }))).sort((a, b) => b.assignments.length - a.assignments.length)) {
    const template = originals.get(id({ id: route.engineerId }));
    const target = candidates.find(item => !used.has(item.id) && profile(item) === profile(template));
    if (target) { used.add(target.id); team.push(target); }
    else missing.push({ templateId: id(template), zone: template.zone, skills: template.skills, jobs: route.assignments.length });
  }
  return { team, needed: routes.length, available: candidates.length, missing, lockedEngineerIds,
    qualityExceptions: team.filter(item => item.locked && (item.rating.score < settings.qualityFloor || item.rating.score > settings.qualityCeiling)).map(item => item.id),
    jobs: shift.orders.length, breakdown: staffingBreakdown(shift, catalog, settings) };
}

export async function calculateStaffingPlan(shift, catalog, scenario, onProgress = () => {}, root = projectRoot()) {
  shift = ratingPlanningShift(shift);
  const startedAt = Date.now(), deadlineAt = startedAt + 150_000;
  onProgress({phase:'PREPARING_INPUTS'});
  if (shift.facts?.some(item => ['started', 'completed'].includes(item.status))) throw new Error('Смена уже исполняется. Состав рассчитывается до начала работ; фактические визиты защищены.');
  if (shift.plan?.status !== 'EXACT_VALID') throw new Error('Сначала постройте проверенный план выбранного дня.');
  const options = staffingOptions(scenario.settings);
  const source = await findRatingSource(shift, root);
  const originals = new Map(shift.team.map(item => [id(item), item]));
  let candidates = catalog.filter(item => (options.pool === 'all' || item.kind === 'staff') && originals.has(item.templateId)
    && profile(item) === profile(originals.get(item.templateId))).map(item => ({ ...item, id: id(item), sourceId: id(item) }));
  // Locked performers must remain represented; quality exceptions are explicit.
  const lockedEngineerIds = (shift.plan.routes || []).filter(route => route.assignments.some(a => a.manual)).map(route => id({ id: route.engineerId }));
  for (const engineer of shift.team) if (!candidates.some(item => item.id === id(engineer))) {
    const rated = catalog.find(item => id(item) === id(engineer));
    candidates.push({ ...engineer, id: id(engineer), sourceId: id(engineer), templateId: id(engineer), rating: rated?.rating || { score: 4.2, count: 0 } });
  }
  if (options.addTemplateId) {
    const template = originals.get(options.addTemplateId);
    if (!template) throw new Error('Профиль дополнительного инженера отсутствует в выбранном дне.');
    candidates.push({ ...template, id: `WHATIF-${options.addTemplateId}`, sourceId: `WHATIF-${options.addTemplateId}`, templateId: options.addTemplateId,
      name: 'Дополнительный специалист', kind: 'hypothetical', rating: { score: options.qualityFloor, count: 0 }, hypothetical: true });
  }
  if (!scenario.confirmedAt || !Array.isArray(scenario.approvedEngineerIds)) throw new Error('Сначала подтвердите предложенный состав.');
  candidates = candidates.filter(item => scenario.approvedEngineerIds.includes(item.id));
  if (lockedEngineerIds.some(key => !candidates.some(item => item.id === key))) throw new Error('Ручные закрепления изменились. Подберите состав заново.');
  const directory = path.join(root, 'runtime/rating-runs', scenario.id);
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, 'exact-rating-plan.json');
  onProgress({ phase: 'LOADING_TRANSIT' });
  const transit = await ensureTransitIndex(shift.date, root, { deadlineAt });
  onProgress({phase:'COMPACTING_TEAM'});
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.BEEGO_PYTHON || 'python', [path.join(root, 'algorithm/tools/plan_staffing.py'), '--dataset', source.dataset,
      '--input-plan', source.file, '--output', output, '--cache', path.join(root, 'runtime/full-coverage-route-cache.sqlite3'), '--transit-index', transit],
    { cwd: root, windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, 'algorithm/src'), PYTHONUTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let error = '', buffer = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-5000); });
    child.stdout.on('data', chunk => { buffer += chunk.toString(); const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){try{const value=JSON.parse(line);if(value.type==='progress'){const {type,...progress}=value;onProgress(progress);}}catch{/* Python diagnostics are not progress messages. */}} });
    const timer = setTimeout(() => { stopProcessTree(child); reject(new Error('Расчёт состава превысил лимит времени. Повторите попытку.')); }, Math.max(1, deadlineAt - Date.now()));
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.stdin.on('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error.trim().split('\n').at(-1) || 'Проверка состава не пройдена.')); });
    child.stdin.end(JSON.stringify({ sourceInputs:{orders:shift.orders,team:shift.team}, candidates: candidates.map(item => ({ id: item.id, templateId: item.templateId, rating: item.rating })),
      qualityFloor: options.qualityFloor, qualityCeiling: options.qualityCeiling, lockedEngineerIds, ratingVersion: scenario.ratingVersion }));
  });
  const raw = JSON.parse(await readFile(output, 'utf8'));
  onProgress({phase:'VALIDATING_PLAN'});
  const plan = fillExactIdentityGeometry(compactExactReplan(raw, { orders: shift.orders, team: candidates }), shift.orders);
  plan.routes = plan.routes.filter(route => route.assignments.length);
  const selected = new Set(plan.routes.map(route => String(route.engineerId)));
  const team = candidates.filter(item => selected.has(item.id));
  const assigned = plan.routes.reduce((n, route) => n + route.assignments.length, 0);
  plan.ratingAverage = assigned ? plan.routes.reduce((n, route) => n + (team.find(item => item.id === route.engineerId)?.rating.score || 0) * route.assignments.length, 0) / assigned : 0;
  plan.ratingVersion = scenario.ratingVersion;
  const reduced = { ...shift, plan: { ...shift.plan, routes: (raw.rating_assignments || []).map(match => ({ engineerId: match.sourceEngineerId,
    assignments: Array.from({ length: match.visits }, () => ({})) })).concat(raw.staffing.missing.map(item => ({ engineerId: item.templateId, assignments: item.jobIds.map(() => ({})) })),
      ...(raw.staffing.lockedEngineerIds || []).map(key => shift.plan.routes.find(route => id({ id: route.engineerId }) === key)).filter(Boolean)) } };
  const breakdown = staffingBreakdown(reduced, catalog, options, raw.staffing.missing);
  const complete = !raw.staffing.missing.length && !(plan.unassigned?.length) && plan.metrics.assigned === shift.orders.length;
  return { plan, team, orders: shift.orders, candidateCount: candidates.length, settings: options,
    timing:{startedAt:new Date(startedAt).toISOString(),finishedAt:new Date().toISOString(),elapsedMs:Date.now()-startedAt},
    staffing: { ...raw.staffing, breakdown, assigned, complete, hypothetical: Boolean(options.addTemplateId),
      selected: team.length, available: catalog.filter(item => (options.pool === 'all' || item.kind === 'staff') && item.rating.score >= options.qualityFloor && item.rating.score <= options.qualityCeiling).length,
      sourceDistanceKm: shift.plan.metrics.distanceKm, globalMinimumProven: false },
    sourceRevision: shift.revision, sourceHash: shift.plan.contentSha256,
    inputFingerprint: ratingFingerprint({ orders: shift.orders, team: shift.team, plan: shift.plan.contentSha256 }) };
}

export async function loadStaffingForecast() {
  return JSON.parse(await readFile(new URL('../public/data/ml-demand-forecast.json', import.meta.url), 'utf8'));
}
