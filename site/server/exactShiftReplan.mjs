import { runExactPlan } from '../scripts/exact-plan-runner.mjs';
import { runExactReplan } from '../scripts/exact-replan-runner.mjs';
import { minuteOf } from '../src/shiftDomain.js';
import { fillExactIdentityGeometry } from './exactPlanGeometry.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../scripts/project-root.mjs';

const assignmentIndex = plan => new Map((plan?.routes || []).flatMap(route =>
  (route.assignments || []).map(visit => [String(visit.orderId), { engineerId: String(route.engineerId), plannedStart: visit.plannedStart }])));

const historicalInventory = async date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return [];
  const file = path.join(projectRoot(), 'history', date, 'dataset', 'core', 'shared_inventory.csv');
  const csv = await readFile(file, 'utf8').catch(() => '');
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
  const eventMinute = minuteOf(model.event.time) ?? 0;
  const before = assignmentIndex(shift.plan);
  const after = assignmentIndex(plan);
  for (const [orderId, visit] of before) {
    if ((minuteOf(visit.plannedStart) ?? 1440) >= eventMinute) continue;
    const next = after.get(orderId);
    if (!next || next.engineerId !== visit.engineerId || next.plannedStart !== visit.plannedStart) {
      throw new Error('Точный пересчёт меняет визит до времени события. Публикация запрещена.');
    }
  }
  for (const fact of shift.facts || []) {
    if (!['started', 'completed'].includes(fact.status)) continue;
    const prior = before.get(String(fact.orderId));
    const next = after.get(String(fact.orderId));
    if (!prior || !next || prior.engineerId !== next.engineerId || prior.plannedStart !== next.plannedStart) {
      throw new Error('Точный пересчёт меняет фактически начатый визит. Публикация запрещена.');
    }
  }
  return { ...fillExactIdentityGeometry(plan, model.orders), event: model.event };
}
