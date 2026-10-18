import { engineerIdentity } from '../src/engineerPresentation.js';
import { ratingPlanningShift } from './ratingProfiles.mjs';
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../scripts/project-root.mjs';
import { compactExactReplan } from '../scripts/exact-replan-runner.mjs';
import { fillExactIdentityGeometry } from './exactPlanGeometry.mjs';
import { ratingFingerprint } from './ratingStore.mjs';
import { ensureTransitIndex } from '../scripts/transit-index.mjs';
import { stopProcessTree } from '../scripts/process-deadline.mjs';

const sourceId = engineerIdentity;
const hardProfile = item => JSON.stringify([item.zoneId, item.zone, item.shiftStart, item.shiftEnd, item.transport,
  item.startCoords, [...(item.skills || [])].sort(), [...(item.equipment || [])].sort(),
  item.sourceData?.max_jobs || 10, item.sourceData?.max_route_minutes || 720]);

export async function findRatingSource(shift, root) {
  const hash = shift.plan?.contentSha256;
  for (const [file, dataset] of [
    ['algorithm/artifacts/complexity/initial-exact.json','data/object-complexity/dataset'],
    ['algorithm/artifacts/current/initial-exact-205-of-205-retimed.json','data/dataset'],
    [`history/${shift.date}/final-exact.json`,`history/${shift.date}/dataset`],
  ]) {
    const artifact = JSON.parse(await readFile(path.join(root,file),'utf8').catch(() => 'null'));
    if (artifact?.content_sha256 === hash && artifact.publication_allowed === true) return {file:path.join(root,file),dataset:path.join(root,dataset)};
  }
  const retained = path.join(root, 'runtime/exact-replans', `${hash}.json`);
  const metadata = JSON.parse(await readFile(`${retained}.meta.json`, 'utf8').catch(() => 'null'));
  if (metadata) return { file: retained, dataset: path.resolve(root, metadata.dataset) };
  for (const folder of await readdir(path.join(root, 'runtime/ui-runs'), { withFileTypes: true }).catch(() => [])) {
    if (!folder.isDirectory()) continue;
    const directory = path.join(root, 'runtime/ui-runs', folder.name);
    const manifest = JSON.parse(await readFile(path.join(directory, 'results/pipeline-run.json'), 'utf8').catch(() => 'null'));
    if (!manifest?.publishable_final_plan && !manifest?.final_plan) continue;
    const file = manifest.publishable_final_plan || manifest.final_plan;
    const artifact = JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
    if (artifact?.content_sha256 === hash) return { file, dataset: path.join(directory, 'dataset') };
  }
  throw new Error('Не найдены исходные данные точного плана. Постройте основной план выбранного дня и повторите расчёт.');
}

export async function calculateRatingPlan(shift, catalog, scenario, onProgress = () => {}, root = projectRoot()) {
  shift = ratingPlanningShift(shift);
  if (shift.facts?.some(item => ['started', 'completed'].includes(item.status))) throw new Error('Смена уже исполняется. Рейтинг рассчитывается отдельным сценарием до начала работ; фактические визиты не переназначаются.');
  if (!shift.plan || shift.plan.status !== 'EXACT_VALID') throw new Error('Сначала нужен проверенный план заявок выбранного дня.');
  const source = await findRatingSource(shift, root);
  const sourceTeam = new Map(shift.team.map(item => [sourceId(item), item]));
  const candidates = catalog.filter(item => (scenario.pool !== 'staff' || item.kind === 'staff') && sourceTeam.has(item.templateId) && hardProfile(item) === hardProfile(sourceTeam.get(item.templateId)));
  // The current roster always uses the exact, server-owned operational profile.
  for (const engineer of shift.team) {
    const existing = catalog.find(item => sourceId(item) === sourceId(engineer));
    if (!candidates.some(item => sourceId(item) === sourceId(engineer))) candidates.push({ ...engineer, id: sourceId(engineer), sourceId: sourceId(engineer), templateId: sourceId(engineer), kind: 'staff', rating: existing?.rating || { score: 4.2, count: 0 } });
  }
  if (!candidates.length) throw new Error('Нет подходящих доступных инженеров.');
  const directory = path.join(root, 'runtime/rating-runs', scenario.id);
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, 'exact-rating-plan.json');
  const lockedEngineerIds = (shift.plan.routes || []).filter(route => route.assignments.some(item => item.manual)).map(route => sourceId({ id: route.engineerId }));
  onProgress({ phase: 'VALIDATING_ROADS', candidates: candidates.length });
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.BEEGO_PYTHON || 'python', [path.join(root, 'algorithm/tools/plan_by_rating.py'), '--dataset', source.dataset, '--input-plan', source.file, '--output', output], {
      cwd: root, windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, 'algorithm/src'), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); }); child.stdout.resume();
    const timer = setTimeout(() => { stopProcessTree(child); reject(new Error('Проверка плана по рейтингу превысила лимит времени.')); }, 120_000);
    child.stdin.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.split('\n').filter(Boolean).at(-1) || 'Проверка плана не пройдена.')); });
    child.stdin.end(JSON.stringify({ sourceInputs:{orders:shift.orders,team:shift.team}, candidates: candidates.map(item => ({ id: sourceId(item), templateId: item.templateId, rating: item.rating })), ratingVersion: scenario.ratingVersion, lockedEngineerIds }));
  });
  const raw = JSON.parse(await readFile(output, 'utf8'));
  const normalizedTeam = candidates.map(item => ({ ...item, id: sourceId(item), sourceId: sourceId(item) }));
  const plan = fillExactIdentityGeometry(compactExactReplan(raw, { orders: shift.orders, team: normalizedTeam }), shift.orders);
  const byId = new Map(normalizedTeam.map(item => [String(item.id), item]));
  const total = plan.routes.reduce((n, route) => n + route.assignments.length, 0);
  const average = total ? plan.routes.reduce((n, route) => n + (byId.get(String(route.engineerId))?.rating.score || 4.2) * route.assignments.length, 0) / total : 0;
  const sourceAverage = total ? shift.plan.routes.reduce((n, route) => n + (catalog.find(item => sourceId(item) === sourceId({ id: route.engineerId }))?.rating.score || 4.2) * route.assignments.length, 0) / total : 0;
  const selectedIds = new Set(plan.routes.map(item => String(item.engineerId)));
  return { plan: { ...plan, algorithm: 'beego-rating-profile-matching-v1', ratingAverage: average, ratingVersion: scenario.ratingVersion, ratingAssignments: raw.rating_assignments,
    scope: raw.search_scope, explanation: 'Выбор лучших по рейтингу для проверенных маршрутов среди инженеров с одинаковыми стартом, сменой, навыками, транспортом и оснащением. Порядок визитов сохранён.' },
    orders: shift.orders, team: normalizedTeam.filter(item => selectedIds.has(String(item.id))), candidateCount: candidates.length,
    sourceRevision: shift.revision, sourceHash: shift.plan.contentSha256, sourceRating: sourceAverage, inputFingerprint: ratingFingerprint({ orders: shift.orders, team: shift.team, plan: shift.plan.contentSha256 }) };
}

export async function reassignRatingPlan(parent, catalog, scenario, root = projectRoot()) {
  const sourceShift = { plan: { contentSha256: parent.sourceHash } };
  const source = await findRatingSource(sourceShift, root);
  const input = path.join(root, 'runtime/rating-runs', parent.id, 'exact-rating-plan.json');
  const directory = path.join(root, 'runtime/rating-runs', scenario.id);
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, 'exact-rating-plan.json');
  const transit = await ensureTransitIndex(parent.date, root);
  const order = parent.orders.find(item => String(item.id) === String(scenario.orderId));
  const engineer = parent.team.find(item => String(item.id) === String(scenario.engineerId));
  if (!order || !engineer) throw new Error('Заявка или инженер отсутствует в сценарии.');
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.BEEGO_PYTHON || 'python', [path.join(root, 'algorithm/tools/reassign_rating.py'),
      '--dataset', source.dataset, '--input-plan', input, '--output', output,
      '--cache', path.join(root, 'runtime/full-coverage-route-cache.sqlite3'), '--transit-index', transit], {
      cwd: root, windowsHide: true, env: { ...process.env, PYTHONPATH: path.join(root, 'algorithm/src'), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', value => { error = (error + value).slice(-5000); }); child.stdout.resume();
    const timer = setTimeout(() => { stopProcessTree(child); reject(new Error('Точная проверка закрепления превысила лимит времени.')); }, 120_000);
    child.stdin.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error.split('\n').filter(Boolean).at(-1) || 'Закрепление не подтверждено.')); });
    child.stdin.end(JSON.stringify({ orderId: sourceId(order), engineerId: sourceId(engineer), ratingVersion: scenario.ratingVersion }));
  });
  const raw = JSON.parse(await readFile(output, 'utf8'));
  const roster = new Map(catalog.map(item => [sourceId(item), { ...item, id: sourceId(item), sourceId: sourceId(item) }]));
  parent.team.forEach(item => roster.set(String(item.id), item));
  const plan = fillExactIdentityGeometry(compactExactReplan(raw, { orders: parent.orders, team: [...roster.values()] }), parent.orders);
  plan.routes = plan.routes.filter(route => route.assignments.length);
  for (const route of plan.routes) for (const assignment of route.assignments) if (String(assignment.orderId) === String(order.id)) assignment.manual = true;
  const total = plan.routes.reduce((sum, route) => sum + route.assignments.length, 0);
  const score = id => catalog.find(item => String(item.id) === String(id))?.rating.score || 4.2;
  const used = new Set(plan.routes.map(item => String(item.engineerId)));
  return { ...parent, ...scenario, team: [...roster.values()].filter(item => used.has(String(item.id))), saved: false, plan: { ...plan, ratingVersion: scenario.ratingVersion,
    ratingAverage: total ? plan.routes.reduce((sum, route) => sum + score(route.engineerId) * route.assignments.length, 0) / total : 0,
    algorithm: 'beego-rating-exact-manual-v1' }, manualAssignment: { orderId: order.id, engineerId: engineer.id } };
}
