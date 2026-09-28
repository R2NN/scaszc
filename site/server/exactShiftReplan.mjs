import { runExactPlan } from '../scripts/exact-plan-runner.mjs';
import { runExactReplan } from '../scripts/exact-replan-runner.mjs';
import { minuteOf } from '../src/shiftDomain.js';
import { fillExactIdentityGeometry } from './exactPlanGeometry.mjs';

const assignmentIndex = plan => new Map((plan?.routes || []).flatMap(route =>
  (route.assignments || []).map(visit => [String(visit.orderId), { engineerId: String(route.engineerId), plannedStart: visit.plannedStart }])));

/** Replan with the retained exact solver and preserve visits that precede an operational event. */
export async function exactShiftReplan(shift, model, onProgress = () => {}) {
  const event = { ...model.event };
  const useEventSolver = ['NEW_ORDER', 'ORDER_CANCELLED', 'VISIT_CANCELLED', 'ENGINEER_UNAVAILABLE', 'MANUAL_ASSIGN'].includes(event.type)
    && shift.date === '2026-08-17' && shift.plan?.contentSha256;
  let plan;
  if (useEventSolver) {
    if (event.type === 'VISIT_CANCELLED') event.type = 'ORDER_CANCELLED';
    if (event.type === 'MANUAL_ASSIGN') event.type = 'FORCED_ASSIGNMENT';
    onProgress({ phase: 'EXACT_EVENT', checkedRoads: 0 });
    plan = await runExactReplan({ orders: model.orders, team: model.team, plan: shift.plan, event });
  } else {
    onProgress({ phase: 'EXACT_FULL_DAY', checkedRoads: 0 });
    plan = await runExactPlan({ orders: model.orders, engineers: model.team, regionId: shift.regionId, planningDate: shift.date });
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
