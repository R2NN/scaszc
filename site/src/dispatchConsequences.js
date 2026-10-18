import { minuteOf } from './shiftDomain.js';
import { isEmergencyWorkOrder } from './workTypes.js';

const minute = value => minuteOf(String(value || '').match(/(?:T|^)(\d{1,2}:\d{2})/)?.[1]);
const same = (a, b) => String(a) === String(b);
const plural = (count, forms) => forms[count % 100 >= 11 && count % 100 <= 14 ? 2 : count % 10 === 1 ? 0 : count % 10 >= 2 && count % 10 <= 4 ? 1 : 2];

/** Count operator actions for existing jobs, without treating travel tweaks as job losses. */
export function dispatchConsequences(candidate) {
  const groups = {transferred:[], delayed:[], lost:[], outsideWindow:[], unknownWindow:[], restored:[]};
  const orders = new Map((candidate.orders || []).map(order => [String(order.id), order]));
  for (const change of candidate.changes || []) {
    if (same(change.orderId, candidate.visit.orderId)) continue;
    const order = orders.get(String(change.orderId));
    const start = minute(change.after?.plannedStart), arrival = minute(change.after?.arrival);
    const from = minute(order?.start), until = minute(order?.end);
    const knownWindow = from != null && until != null && start != null && arrival != null;
    const outsideWindow = Boolean(change.after && knownWindow && (start < from || start > until || arrival > until));
    const oldStart = minute(change.before?.plannedStart);
    const row = {...change, address:change.address || order?.address || 'Адрес не указан', coords:order?.coords,
      windowStart:order?.start, windowEnd:order?.end, windowStatus:outsideWindow ? 'outside' : knownWindow ? 'inside' : 'unknown',
      delayMinutes:oldStart != null && start != null ? Math.max(0, start - oldStart) : null};
    if (change.before && !change.after) groups.lost.push(row);
    if (change.before && change.after && !same(change.before.engineerId, change.after.engineerId)) groups.transferred.push(row);
    if (row.delayMinutes > 0) groups.delayed.push(row);
    if (outsideWindow) groups.outsideWindow.push(row);
    else if (change.after && !knownWindow) groups.unknownWindow.push(row);
    if (!change.before && change.after) groups.restored.push(row);
  }
  // Reconstruct the original assignments from the saved diff. This also works
  // for old persisted candidates created before consequence summaries existed.
  const original = new Map((candidate.plan?.routes || []).flatMap(route => (route.assignments || []).map(visit => [String(visit.orderId), {...visit, engineerId:route.engineerId}])));
  for (const change of candidate.changes || []) {
    if (change.before) original.set(String(change.orderId), change.before);
    else original.delete(String(change.orderId));
  }
  original.delete(String(candidate.visit.orderId));
  const at = minute(candidate.scenarioTime);
  const hasFutureWork = [...original.values()].some(visit => same(visit.engineerId, candidate.engineer.id) && (minute(visit.plannedFinish) ?? Infinity) > (at ?? 0));
  const usesReserve = !hasFutureWork && (['idle', 'waiting'].includes(candidate.state?.status) || candidate.kind === 'Выезд из дома' || candidate.kind === 'Свободный инженер');
  const changesExistingWork = Object.values(groups).some(rows => rows.length > 0);
  const summary = groups.lost.length ? `Теряют назначение: ${groups.lost.length}`
    : groups.outsideWindow.length ? `Вне окна клиента: ${groups.outsideWindow.length}`
      : !changesExistingWork && usesReserve ? 'Привлекается резервный инженер; прежние визиты без изменений'
        : `Без потери назначений${groups.transferred.length ? `; передаются: ${groups.transferred.length}` : ''}${groups.delayed.length ? `; начнутся позже: ${groups.delayed.length}` : ''}`;
  return {...groups, usesReserve, summary,
    withinWindow:groups.delayed.filter(row => row.windowStatus === 'inside'),
    reserveCount:(candidate.reserve || []).length,
    assigned:candidate.coverage?.after?.assigned ?? null,
    coverageLabel:dispatchCoverage(candidate)};
}

/** Compare assigned emergencies and total jobs without counting urgent ordinary work as an emergency. */
export function dispatchCoverage(candidate) {
  const orders = new Map((candidate.orders || []).map(order => [String(order.id), order]));
  const assignedIds = new Set((candidate.plan?.routes || []).flatMap(route => (route.assignments || []).map(visit => String(visit.orderId))));
  const emergencies = [...orders.values()].filter(isEmergencyWorkOrder);
  const emergencyAssigned = emergencies.filter(order => assignedIds.has(String(order.id))).length;
  const total = candidate.coverage?.after?.total ?? orders.size;
  const assigned = candidate.coverage?.after?.assigned ?? [...orders.keys()].filter(id => assignedIds.has(id)).length;
  return `Аварии ${emergencyAssigned}/${emergencies.length} · всего ${assigned}/${total}`;
}

/** Explain a recommendation with measured differences against an available alternative. */
export function dispatchRecommendation(candidate, candidates) {
  const own = dispatchConsequences(candidate);
  const others = candidates.filter(other => other.id !== candidate.id).map(other => ({candidate:other, impact:dispatchConsequences(other)}));
  const peer = others.find(other => own.assigned != null && own.assigned === other.impact.assigned && own.reserveCount > other.impact.reserveCount)
    || others.find(other => own.lost.length < other.impact.lost.length)
    || others.find(other => own.outsideWindow.length < other.impact.outsideWindow.length)
    || others.find(other => own.assigned != null && other.impact.assigned != null && own.assigned > other.impact.assigned)
    || others.find(other => minute(candidate.visit.arrival) != null && minute(other.candidate.visit.arrival) != null && minute(candidate.visit.arrival) < minute(other.candidate.visit.arrival));
  if (!peer) return `${own.summary}; прибытие ${candidate.visit.arrival}, в резерве: ${own.reserveCount}.`;
  const reference = `вариант «${peer.candidate.engineer.name}»`;
  let reason;
  if (own.assigned === peer.impact.assigned && own.reserveCount > peer.impact.reserveCount) {
    const extra = own.reserveCount - peer.impact.reserveCount;
    reason = `Покрытие такое же, как в варианте «${peer.candidate.engineer.name}»; в резерве на ${extra} ${plural(extra, ['инженера','инженера','инженеров'])} больше`;
  }
  else if (own.lost.length < peer.impact.lost.length) {
    const kept = peer.impact.lost.length - own.lost.length;
    reason = `Сохраняет на ${kept} ${plural(kept, ['заявку','заявки','заявок'])} больше, чем ${reference}`;
  }
  else if (own.outsideWindow.length < peer.impact.outsideWindow.length) reason = `На ${peer.impact.outsideWindow.length - own.outsideWindow.length} меньше визитов вне окна клиента, чем даёт ${reference}`;
  else if (own.assigned > peer.impact.assigned) reason = `Назначено на ${own.assigned - peer.impact.assigned} больше заявок, чем в варианте «${peer.candidate.engineer.name}»`;
  else reason = `Меньше ожидание аварии, чем предлагает ${reference}`;
  const ownArrival = minute(candidate.visit.arrival), peerArrival = minute(peer.candidate.visit.arrival);
  const delta = ownArrival != null && peerArrival != null ? ownArrival - peerArrival : null;
  return `${reason}; ${delta == null ? `прибытие ${candidate.visit.arrival}` : delta === 0 ? 'прибытие в то же время' : `прибытие на ${Math.abs(delta)} мин ${delta > 0 ? 'позже' : 'раньше'}`}.`;
}

/** Addresses with real coordinates can be inspected on the persistent map. */
export function dispatchImpactPoints(rows) {
  return rows.filter(row => Array.isArray(row.coords) && row.coords.length === 2 && row.coords.every(Number.isFinite))
    .map(row => ({type:'Feature',properties:{orderId:String(row.orderId),address:row.address},geometry:{type:'Point',coordinates:[row.coords[1],row.coords[0]]}}));
}
