import { runExactPlan } from '../scripts/exact-plan-runner.mjs';
import { runExactReplan } from '../scripts/exact-replan-runner.mjs';
import { minuteOf } from '../src/shiftDomain.js';
import { fillExactIdentityGeometry } from './exactPlanGeometry.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../scripts/project-root.mjs';

const assignmentIndex = plan => new Map((plan?.routes || []).flatMap(route =>
  (route.assignments || []).map(visit => [String(visit.orderId), { engineerId: String(route.engineerId), plannedStart: visit.plannedStart, departureAt: visit.departureAt, arrival: visit.arrival, plannedFinish: visit.plannedFinish }])));

const sameVisit = (previous, next) => Boolean(next) && previous.engineerId === next.engineerId
  && previous.plannedStart === next.plannedStart
  && ['departureAt', 'arrival', 'plannedFinish'].every(field => previous[field] == null || previous[field] === next[field]);

const assignedVisit = (plan, orderId) => (plan?.routes || []).flatMap(route =>
  (route.assignments || []).map(visit => ({ ...visit, engineerId: route.engineerId, engineerName: route.engineerName })))
  .find(visit => String(visit.orderId) === String(orderId));

/** Keep every visit before the event and every visit with a recorded start or completion. */
export function preservesStartedVisits(shift, candidate, eventTime) {
  const before = assignmentIndex(shift.plan);
  const after = assignmentIndex(candidate);
  const eventMinute = minuteOf(eventTime) ?? 0;
  for (const [orderId, visit] of before) {
    if ((minuteOf(visit.plannedStart) ?? 1440) >= eventMinute) continue;
    const next = after.get(orderId);
    if (!sameVisit(visit, next)) return false;
  }
  for (const fact of shift.facts || []) {
    if (!['started', 'completed'].includes(fact.status)) continue;
    const prior = before.get(String(fact.orderId));
    const next = after.get(String(fact.orderId));
    if (!prior || !sameVisit(prior, next)) return false;
  }
  return true;
}

const laterTime = (time, minutes) => {
  const total = Math.min(1439, (minuteOf(time) ?? 0) + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** Suggest only a window that the exact replanner has checked with the same frozen visits. */
export async function findAlternativeWindow(shift, model, order, routing) {
  const latestShiftEnd = Math.max(...model.team.map(engineer => minuteOf(engineer.shiftEnd) ?? 0), 0);
  const currentEnd = minuteOf(order.end) ?? 0;
  if (latestShiftEnd <= currentEnd) return null;
  const span = Math.max(30, currentEnd - (minuteOf(order.start) ?? currentEnd - 60));
  const timeOf = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const widenedEnd = timeOf(Math.min(1439, latestShiftEnd));
  const replaceOrder = (start, end) => model.orders.map(item => String(item.id) === String(order.id) ? { ...item, start, end } : item);
  const payload = (orders, start, end) => ({
    orders, team: model.team, plan: shift.plan, planningDate: shift.date,
    event: model.event.type === 'NEW_ORDER' ? model.event : {
      type: 'CLIENT_WINDOW_SHIFT', orderId: order.id, time: model.event.time,
      reason: 'Проверка альтернативного клиентского окна', start, end,
    },
  });
  const widenedStart = laterTime(order.end, 1);
  const widened = await routing(payload(replaceOrder(widenedStart, widenedEnd), widenedStart, widenedEnd));
  const possible = assignedVisit(widened, order.id);
  if (!possible || !preservesStartedVisits(shift, widened, model.event.time)) return null;
  const start = possible.plannedStart;
  const end = laterTime(start, span);
  if ((minuteOf(end) ?? 0) <= (minuteOf(start) ?? 0)) return null;
  const checked = await routing(payload(replaceOrder(start, end), start, end));
  const visit = assignedVisit(checked, order.id);
  if (!visit || !preservesStartedVisits(shift, checked, model.event.time)) return null;
  return { start, end, plannedStart: visit.plannedStart, engineerId: visit.engineerId, engineerName: visit.engineerName, checkedBy: 'EXACT_REPLAN' };
}

const historicalInventory = async date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return [];
  const root = projectRoot();
  const historical = path.join(root, 'history', date, 'dataset');
  const base = path.join(root, 'data', 'dataset');
  let csv = '';
  for (const dataset of [historical, base]) {
    const manifest = JSON.parse(await readFile(path.join(dataset, 'manifest.json'), 'utf8').catch(() => 'null'));
    if (manifest?.planning_date !== date) continue;
    csv = await readFile(path.join(dataset, 'core', 'shared_inventory.csv'), 'utf8').catch(() => '');
    if (csv) break;
  }
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  if (!header || !rows.length) return [];
  const fields = header.split(';');
  const column = name => fields.indexOf(name);
  return rows.map(row => {
    const values = row.split(';');
    return { zoneId: values[column('zone_id')], equipmentId: values[column('equipment_id')], quantity: Number(values[column('quantity_available')]) };
  });
};

/** Replan with the retained exact solver and preserve visits that precede an operational event. */
export async function exactShiftReplan(shift, model, onProgress = () => {}) {
  const event = { ...model.event };
  const useEventSolver = ['RECALCULATE', 'NEW_ORDER', 'ORDER_CANCELLED', 'VISIT_CANCELLED', 'ENGINEER_UNAVAILABLE', 'CAPACITY_ADDED', 'MANUAL_ASSIGN', 'CLIENT_WINDOW_SHIFT'].includes(event.type)
    && shift.plan?.contentSha256;
  let plan;
  if (useEventSolver) {
    if (event.type === 'VISIT_CANCELLED') event.type = 'ORDER_CANCELLED';
    if (event.type === 'MANUAL_ASSIGN') event.type = 'FORCED_ASSIGNMENT';
    onProgress({ phase: 'EXACT_EVENT', checkedRoads: 0 });
    plan = await runExactReplan({ orders: model.orders, team: model.team, plan: shift.plan, planningDate: shift.date, event });
  } else {
    onProgress({ phase: 'EXACT_FULL_DAY', checkedRoads: 0 });
    plan = await runExactPlan({ orders: model.orders, engineers: model.team, regionId: shift.regionId, planningDate: shift.date, sharedInventory: await historicalInventory(shift.date) });
  }
  if (plan.status !== 'EXACT_VALID' || plan.publicationAllowed !== true || plan.validation?.status !== 'VALID' || plan.approximateTravel === true) {
    throw new Error('Пересчёт не прошёл независимую точную проверку.');
  }
  if (!preservesStartedVisits(shift, plan, model.event.time)) throw new Error('Точный пересчёт меняет визит до времени события или фактически начатый визит. Публикация запрещена.');
  const targetOrderId = ['NEW_ORDER', 'CLIENT_WINDOW_SHIFT'].includes(model.event.type)
    ? model.event.orderId
    : model.event.type === 'RECALCULATE' ? plan.unassigned?.[0]?.orderId : null;
  if (targetOrderId && !assignedVisit(plan, targetOrderId)) {
    const order = model.orders.find(item => String(item.id) === String(targetOrderId));
    let fullRebuildStatus = 'NO_SAFE_IMPROVEMENT';
    onProgress({ phase: 'EXACT_FULL_DAY', checkedRoads: Number(plan.exactRouteChecks || 0) });
    try {
      const rebuilt = await runExactPlan({ orders: model.orders, engineers: model.team, regionId: shift.regionId, planningDate: shift.date, sharedInventory: await historicalInventory(shift.date) });
      if (assignedVisit(rebuilt, order.id)
        && Number(rebuilt.metrics?.assigned || 0) > Number(plan.metrics?.assigned || 0)
        && preservesStartedVisits(shift, rebuilt, model.event.time)) {
        plan = rebuilt;
        fullRebuildStatus = 'ADOPTED';
      }
    } catch {
      fullRebuildStatus = 'NOT_COMPLETED';
    }
    if (!assignedVisit(plan, order.id)) {
      plan = { ...plan, unassigned: plan.unassigned.map(item => String(item.orderId) === String(order.id) ? { ...item, fullRebuildStatus } : item) };
    }
    if (!assignedVisit(plan, order.id) && plan.unassigned?.some(item => String(item.orderId) === String(order.id) && ['NO_EXACT_FEASIBLE_INSERTION_IN_CURRENT_ROUTES', 'SEARCH_BUDGET_EXHAUSTED'].includes(item.reasonCode))) {
      onProgress({ phase: 'EXACT_ALTERNATIVE_WINDOW', checkedRoads: Number(plan.exactRouteChecks || 0) });
      try {
        const suggestedWindow = await findAlternativeWindow(shift, model, order, runExactReplan);
        if (suggestedWindow) plan = { ...plan, unassigned: plan.unassigned.map(item => String(item.orderId) === String(order.id) ? { ...item, suggestedWindow } : item) };
      } catch { /* No exact alternative is offered when routing cannot verify one. */ }
    }
  }
  return { ...fillExactIdentityGeometry(plan, model.orders), event: model.event };
}
