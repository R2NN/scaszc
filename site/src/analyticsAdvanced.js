import { summarizeHistoryDay } from './analyticsHistory.js';
import { transportCode } from './transport.js';

const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const rate = (part, whole) => whole > 0 ? Math.round(part / whole * 1000) / 10 : null;
const minute = value => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const dateShift = (key, days) => new Date(new Date(`${key}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
const zoneOf = order => String(order?.zone || order?.zoneName || order?.zoneId || 'Без зоны').trim();
const skillOf = order => String(order?.skill || order?.requiredSkill || order?.sourceData?.required_skill || 'Навык не указан').trim();
const regionOf = order => String(order?.regionName || order?.regionId || 'Регион не указан').trim();
const skillLabel = value => ({ INSTALL: 'подключение', LOCAL: 'локальные работы', EMERGENCY: 'аварийные работы', UPSELL: 'дозаказ' })[value] || String(value || 'не указан').toLocaleLowerCase('ru-RU');
const hoursLabel = minutes => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(Math.max(0, minutes) / 60);
const plural = (value, forms) => forms[value % 10 === 1 && value % 100 !== 11 ? 0 : [2, 3, 4].includes(value % 10) && ![12, 13, 14].includes(value % 100) ? 1 : 2];
const shortDate = date => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const timeBand = value => {
  const start = minute(value);
  if (start == null) return 'Время не задано';
  const hour = Math.floor(start / 120) * 2;
  return `${String(hour).padStart(2, '0')}:00–${String(hour + 2).padStart(2, '0')}:00`;
};

/**
 * Find the largest concrete zone-and-skill slice of the current queue.
 * It is a recommendation for a capacity scenario, not a claim that one crew solves every constraint.
 */
export function recommendCapacityGap(record) {
  const orderById = new Map((record?.orders || []).map(order => [String(order.id), order]));
  const groups = new Map();
  for (const item of record?.plan?.unassigned || []) {
    const order = orderById.get(String(item.orderId));
    if (!order) continue;
    const zone = zoneOf(order);
    const skill = skillOf(order);
    const key = `${zone}\u0000${skill}`;
    const current = groups.get(key) || { zone, skill, count: 0, workMinutes: 0 };
    current.count += 1;
    current.workMinutes += Math.max(0, numeric(order.duration));
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || right.workMinutes - left.workMinutes || left.zone.localeCompare(right.zone, 'ru')).at(0) || null;
}

/**
 * Return the explicit waits already present in route plans.
 * A reserve is time after arrival and before the booked visit starts; it is not treated as a free route slot.
 */
export function findWindowReserves(record, minimumMinutes = 30) {
  const orders = new Map((record?.orders || []).map(order => [String(order.id), order]));
  return (record?.plan?.routes || []).flatMap(route => (route.assignments || []).map((assignment, index) => {
    const arrival = minute(assignment.arrival);
    const plannedStart = minute(assignment.plannedStart);
    const minutes = arrival == null || plannedStart == null ? 0 : plannedStart - arrival;
    const order = orders.get(String(assignment.orderId));
    if (minutes < minimumMinutes || !order) return null;
    return {
      key: `${route.engineerId}:${assignment.orderId}:${index}`,
      engineerId: route.engineerId,
      engineerName: route.engineerName || route.engineerId,
      orderId: assignment.orderId,
      orderName: order.name || `Заявка ${assignment.orderId}`,
      zone: zoneOf(order),
      skill: skillOf(order),
      arrival,
      plannedStart,
      plannedFinish: minute(assignment.plannedFinish),
      minutes,
    };
  }).filter(Boolean)).sort((left, right) => right.minutes - left.minutes || left.arrival - right.arrival);
}

const timeText = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const floorToQuarter = value => Math.floor(value / 15) * 15;
const ceilToQuarter = value => Math.ceil(value / 15) * 15;

/**
 * Suggest practical start and finish times for every active crew without changing its visit order.
 * A small preparation buffer before the first departure and wrap-up buffer after the last visit are retained.
 */
export function buildShiftRecommendations(record, preparationMinutes = 15, wrapUpMinutes = 15) {
  const engineers = new Map((record?.team || []).map(engineer => [String(engineer.id), engineer]));
  return (record?.plan?.routes || []).flatMap(route => {
    const assignments = [...(route.assignments || [])].sort((left, right) => numeric(left.position) - numeric(right.position));
    if (!assignments.length) return [];
    const engineer = engineers.get(String(route.engineerId));
    const shiftStart = minute(route.shiftStart || engineer?.shiftStart);
    const shiftEnd = minute(route.shiftEnd || engineer?.shiftEnd);
    const first = assignments[0];
    const last = assignments.at(-1);
    const firstDeparture = minute(first.departureAt) ?? (minute(first.arrival) == null ? null : minute(first.arrival) - numeric(first.travelMinutes));
    const lastFinish = minute(last.plannedFinish);
    if (shiftStart == null || shiftEnd == null || firstDeparture == null || lastFinish == null) return [];
    // Round outward: a later rounded start must never remove preparation time,
    // and an earlier rounded finish must never remove the post-visit buffer.
    const recommendedStart = Math.min(shiftEnd, Math.max(shiftStart, floorToQuarter(firstDeparture - preparationMinutes)));
    const recommendedEnd = Math.max(recommendedStart, Math.min(shiftEnd, ceilToQuarter(lastFinish + wrapUpMinutes)));
    return [{
      engineerId: route.engineerId,
      engineerName: route.engineerName || engineer?.name || route.engineerId,
      assignments: assignments.length,
      shiftStart,
      shiftEnd,
      recommendedStart,
      recommendedEnd,
      startSaved: Math.max(0, recommendedStart - shiftStart),
      endSaved: Math.max(0, shiftEnd - recommendedEnd),
    }];
  }).sort((left, right) => right.startSaved + right.endSaved - (left.startSaved + left.endSaved) || left.engineerName.localeCompare(right.engineerName, 'ru'));
}

/**
 * Find usable gaps before, between and after planned visits without treating the client buffer as idle time.
 * Candidate work is only a conservative same-zone and same-skill suggestion; publication still requires exact replanning.
 */
export function findOperationalGaps(record, minimumMinutes = 45, transitionMinutes = 20) {
  const orders = new Map((record?.orders || []).map(order => [String(order.id), order]));
  const engineers = new Map((record?.team || []).map(engineer => [String(engineer.id), engineer]));
  const backlog = (record?.plan?.unassigned || []).map(item => orders.get(String(item.orderId))).filter(Boolean);
  const candidatesFor = (gap, engineer, zone) => backlog.map(order => {
    if (zoneOf(order) !== zone || !(engineer?.skills || []).map(String).includes(skillOf(order))) return null;
    const orderStart = minute(order.start);
    const orderEnd = minute(order.end);
    const duration = Math.max(0, numeric(order.duration));
    if (orderStart == null || orderEnd == null || !duration) return null;
    const start = Math.max(gap.start + transitionMinutes, orderStart);
    const finish = start + duration;
    if (finish > Math.min(gap.end - transitionMinutes, orderEnd)) return null;
    return { orderId: order.id, orderName: order.name || `Заявка ${order.id}`, zone: zoneOf(order), skill: skillOf(order), start, finish, duration };
  }).filter(Boolean).sort((left, right) => left.finish - left.start - (right.finish - right.start) || left.start - right.start);
  const gaps = [];
  for (const route of record?.plan?.routes || []) {
    const engineer = engineers.get(String(route.engineerId));
    const assignments = [...(route.assignments || [])].sort((left, right) => numeric(left.position) - numeric(right.position));
    let cursor = minute(route.shiftStart || engineer?.shiftStart);
    for (let index = 0; index < assignments.length; index += 1) {
      const assignment = assignments[index];
      const departure = minute(assignment.departureAt) ?? (minute(assignment.arrival) == null ? null : minute(assignment.arrival) - numeric(assignment.travelMinutes));
      const nextOrder = orders.get(String(assignment.orderId));
      if (cursor != null && departure != null && departure - cursor >= minimumMinutes && nextOrder) {
        const hasTravelMinutes = assignment.travelMinutes != null && Number.isFinite(Number(assignment.travelMinutes));
        const distanceKm = assignment.distanceKm != null && Number.isFinite(Number(assignment.distanceKm))
          ? Math.max(0, Number(assignment.distanceKm))
          : assignment.distanceM != null && Number.isFinite(Number(assignment.distanceM))
            ? Math.max(0, Number(assignment.distanceM) / 1000)
            : null;
        gaps.push({
          key: `${route.engineerId}:${index}:before`,
          type: index === 0 ? 'before_first' : 'between',
          engineerId: route.engineerId,
          engineerName: route.engineerName || engineer?.name || route.engineerId,
          engineerTransport: engineer?.transport || null,
          routeActive: assignments.length > 0,
          zone: zoneOf(nextOrder),
          start: cursor,
          end: departure,
          minutes: departure - cursor,
          nextOrderId: nextOrder.id,
          nextOrderSourceId: nextOrder.sourceId || null,
          nextOrderName: nextOrder.name || `Заявка ${assignment.orderId}`,
          nextOrderAddress: nextOrder.address || null,
          nextClientName: nextOrder.clientName || nextOrder.customerName || (typeof nextOrder.client === 'string' ? nextOrder.client : null) || (typeof nextOrder.customer === 'string' ? nextOrder.customer : null),
          nextClientPhone: nextOrder.clientPhone || nextOrder.customerPhone || nextOrder.phone || null,
          nextWindowStart: minute(nextOrder.start),
          nextWindowEnd: minute(nextOrder.end),
          nextOrderSkill: skillOf(nextOrder) ? skillLabel(skillOf(nextOrder)) : null,
          nextOrderDuration: Number.isFinite(Number(nextOrder.duration)) ? Math.max(0, Number(nextOrder.duration)) : null,
          nextStart: minute(assignment.plannedStart),
          travelMinutes: hasTravelMinutes ? Math.max(0, Number(assignment.travelMinutes)) : null,
          travelDistanceKm: distanceKm,
          candidate: null,
        });
      }
      cursor = minute(assignment.plannedFinish) ?? cursor;
    }
    const shiftEnd = minute(route.shiftEnd || engineer?.shiftEnd);
    const lastAssignment = assignments.at(-1);
    const lastOrder = lastAssignment ? orders.get(String(lastAssignment.orderId)) : null;
    if (cursor != null && shiftEnd != null && shiftEnd - cursor >= minimumMinutes && lastOrder) {
      gaps.push({ key: `${route.engineerId}:after`, type: 'after_last', engineerId: route.engineerId, engineerName: route.engineerName || engineer?.name || route.engineerId, engineerTransport: engineer?.transport || null, routeActive: assignments.length > 0, zone: zoneOf(lastOrder), start: cursor, end: shiftEnd, minutes: shiftEnd - cursor, nextOrderName: null, nextStart: null, candidate: null });
    }
  }
  return gaps.map(gap => {
    const engineer = engineers.get(String(gap.engineerId));
    const candidate = candidatesFor(gap, engineer, gap.zone)[0] || null;
    const earliestArrival = gap.type === 'between' && gap.nextStart != null && gap.travelMinutes != null ? gap.start + gap.travelMinutes : null;
    const proposedStart = earliestArrival == null ? null : Math.ceil(earliestArrival / 5) * 5;
    const earlyBy = proposedStart == null ? 0 : Math.max(0, gap.nextStart - proposedStart);
    const customerCall = earlyBy >= 30
      ? { title: `Предложить ранний визит для «${gap.nextOrderName}»`, proposedStart, proposedDeparture: gap.start, originalDeparture: gap.end, arrivalAt: earliestArrival, travelMinutes: Math.max(0, earliestArrival - gap.start), savedMinutes: gap.minutes, action: 'Согласовать сдвиг окна' }
      : null;
    const proposal = candidate
      ? { kind: 'insert', title: `Проверить вставку «${candidate.orderName}»`, impact: `Можно попытаться закрыть одну заявку из очереди в ${gap.zone}.`, action: 'Открыть очередь' }
      : customerCall
        ? { kind: 'call_customer', title: customerCall.title, impact: `Сейчас бригада ждёт ${customerCall.savedMinutes} мин до выезда в ${timeText(customerCall.originalDeparture)}. Если клиент согласится, она выедет в ${timeText(customerCall.proposedDeparture)}, потратит ${customerCall.travelMinutes} мин на дорогу и начнёт визит в ${timeText(customerCall.proposedStart)}. Ожидание до выезда сократится на ${customerCall.savedMinutes} мин.`, action: customerCall.action }
      : gap.type === 'before_first'
        ? { kind: 'late_start', title: `Начать смену в ${timeText(Math.max(gap.start, gap.end - 15))}`, impact: `Сократит оплачиваемый простой примерно на ${Math.max(0, gap.minutes - 15)} мин и сохранит 15 мин на подготовку к выезду.`, action: 'Подготовить изменение смены' }
        : gap.type === 'after_last'
          ? { kind: 'early_finish', title: `Закончить смену в ${timeText(gap.start)}`, impact: `Сократит неиспользуемое время смены на ${gap.minutes} мин.`, action: 'Подготовить изменение смены' }
          : { kind: 'reserve', title: 'Оставить как резерв для срочной заявки', impact: `Подходящей незакрытой заявки в ${gap.zone} сейчас нет; резерв в ${gap.minutes} мин полезнее не расходовать вслепую.`, action: 'Отметить резерв' };
    return { ...gap, candidate, customerCall, proposal };
  }).sort((left, right) => right.minutes - left.minutes || left.start - right.start);
}

/** Explain unresolved work and distinguish useful idle capacity from a skill mismatch. */
export function analyzeResourceGaps(record) {
  const orders = record?.orders || [];
  const team = record?.team || [];
  const routes = record?.plan?.routes || [];
  const unresolved = record?.plan?.unassigned || [];
  const orderById = new Map(orders.map(order => [String(order.id), order]));
  const activeIds = new Set(routes.filter(route => route.assignments?.length).map(route => String(route.engineerId)));
  const unresolvedOrders = unresolved.map(item => ({ item, order: orderById.get(String(item.orderId)) })).filter(entry => entry.order);
  const neededSkills = new Set(unresolvedOrders.map(({ order }) => skillOf(order)));
  const idle = team.filter(engineer => !activeIds.has(String(engineer.id)));
  const idleWithNeededSkill = idle.filter(engineer => (engineer.skills || []).some(skill => neededSkills.has(String(skill))));
  const idleWithoutNeededSkill = idle.filter(engineer => !idleWithNeededSkill.includes(engineer));
  let idleDiagnosis = 'Все доступные бригады получили маршруты';
  if (idle.length && !unresolved.length) idleDiagnosis = `${idle.length} ${idle.length === 1 ? 'бригада не понадобилась' : 'бригады не понадобились'} при текущем спросе`;
  else if (idle.length && !idleWithNeededSkill.length) idleDiagnosis = `${idle.length} без маршрута; требуемых очередью навыков у них нет`;
  else if (idleWithNeededSkill.length) idleDiagnosis = `${idleWithNeededSkill.length} с нужным навыком — проверьте окно, зону и оснащение`;

  const routesByEngineer = new Map(routes.map(route => [String(route.engineerId), route]));
  const timeText = value => value == null ? '' : `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const groups = new Map();
  const explanations = [];
  for (const { item, order } of unresolvedOrders) {
    const zone = zoneOf(order);
    const skill = skillOf(order);
    const readableSkill = skillLabel(skill);
    const window = order.start && order.end ? `${order.start}–${order.end}` : 'окно не указано';
    const orderEnd = minute(order.end);
    const localTeam = team.filter(engineer => !engineer.zone || engineer.zone === zone);
    const localWithSkill = localTeam.filter(engineer => (engineer.skills || []).map(String).includes(skill));
    const otherRegionWithSkill = team.filter(engineer => engineer.zone && engineer.zone !== zone && (engineer.skills || []).map(String).includes(skill));
    const freeLocal = localTeam.filter(engineer => !activeIds.has(String(engineer.id)));
    const freeWithSkill = freeLocal.filter(engineer => (engineer.skills || []).map(String).includes(skill));
    const routeFinishes = localWithSkill.map(engineer => {
      const finishes = (routesByEngineer.get(String(engineer.id))?.assignments || []).map(assignment => minute(assignment.plannedFinish)).filter(value => value != null);
      return finishes.length ? Math.max(...finishes) : null;
    }).filter(value => value != null);
    const firstFreeAt = routeFinishes.length ? Math.min(...routeFinishes) : null;
    let label;
    let action;
    let reason;
    const genericPlannerReason = item.reasonCode === 'STATIC_ELIGIBLE_BUT_UNSERVED';
    if (genericPlannerReason) {
      label = 'Подходящие бригады есть, но заявка не помещается в их маршруты';
      reason = `В зоне «${zone}» есть бригады с навыком «${readableSkill}», однако готовый план не содержит допустимого назначения. Эта запись не указывает, какое именно условие оказалось решающим.`;
      action = 'Откройте проверку бригад: отдельно сравните навык, зону, окно, дорогу и текущую занятость.';
    } else if (!localWithSkill.length) {
      label = `В «${zone}» нет свободной компетенции «${readableSkill}»`;
      reason = `В этой зоне нет бригады с навыком «${readableSkill}».`;
      action = `Добавьте или вызовите бригаду с навыком «${readableSkill}» в «${zone}», либо согласуйте с клиентом другое окно.`;
      if (otherRegionWithSkill.length) reason += ` В соседних офисах есть ${otherRegionWithSkill.length} подходящих ${otherRegionWithSkill.length === 1 ? 'бригада' : 'бригад'}, но межрегиональные назначения запрещены.`;
    } else if (freeLocal.length && !freeWithSkill.length) {
      const skills = [...new Set(freeLocal.flatMap(engineer => engineer.skills || []).map(skillLabel))].join(', ');
      label = `Свободные бригады не умеют «${readableSkill}»`;
      reason = `В зоне «${zone}» свободны ${freeLocal.length} ${freeLocal.length === 1 ? 'бригада' : 'бригады'}, но у них нет навыка «${readableSkill}»${skills ? ` (доступны: ${skills})` : ''}.`;
      action = `Нужна дополнительная бригада с навыком «${readableSkill}» или новое клиентское окно.`;
    } else if (localWithSkill.length && !freeWithSkill.length) {
      label = `Бригады с навыком «${readableSkill}» заняты в это время`;
      reason = `В «${zone}» есть ${localWithSkill.length} ${localWithSkill.length === 1 ? 'бригада' : 'бригады'} с нужным навыком, но все заняты на других заявках${firstFreeAt != null ? ` как минимум до ${timeText(firstFreeAt)}` : ''}.`;
      reason += orderEnd != null && firstFreeAt != null && firstFreeAt > orderEnd ? ` До закрытия окна в ${order.end} они не успевают.` : ' В текущее окно нельзя безопасно вставить работу без переноса другого визита.';
      action = `Проверьте перенос соседних визитов, добавьте бригаду с навыком «${readableSkill}» или согласуйте другое окно.`;
    } else if (freeWithSkill.length) {
      label = `Свободная бригада не проходит все условия визита`;
      reason = `В «${zone}» есть ${freeWithSkill.length} свободных ${freeWithSkill.length === 1 ? 'бригада' : 'бригад'} с навыком «${readableSkill}», но заявка не помещается в окно ${window} с учётом времени на дорогу, смены или необходимого оснащения.`;
      action = `Проверьте доступность транспорта и оснащения либо согласуйте более широкое окно с клиентом.`;
    } else {
      label = `Заявка не помещается в доступное время`;
      reason = `Для зоны «${zone}» и навыка «${readableSkill}» не нашлось безопасного времени в окне ${window}.`;
      action = 'Проверьте состав смены, окно клиента и возможность добавить ресурс.';
    }
    const duration = numeric(order.duration);
    if (duration) action += ` На работу требуется ${duration} мин.`;
    const orderNumber = String(order.sourceId || order.id || item.orderId).replace(/^.*:/, '');
    const work = String(order.workType || order.serviceType || readableSkill);
    const detail = genericPlannerReason
      ? `Заявка №${orderNumber} пока без назначения. ${reason}`
      : `Заявка №${orderNumber} не распределена (${zone}, окно ${window}, ${work}). Причина: ${reason}`;
    const key = `${zone}|${skill}|${label}`;
    explanations.push({ orderId: item.orderId, reasonCode: item.reasonCode, orderNumber, work, window, label, action, detail, zone, skill });
    const group = groups.get(key) || { key, label, action, count: 0 };
    groups.set(key, { ...group, count: group.count + 1 });
  }
  return {
    causes: [...groups.values()].map(group => ({
      key: group.key,
      label: group.label,
      action: group.action,
      count: group.count,
    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru')),
    explanations,
    idleCount: idle.length,
    idleWithNeededSkill: idleWithNeededSkill.length,
    idleWithoutNeededSkill: idleWithoutNeededSkill.length,
    idleDiagnosis,
  };
}

/** Build an operator-facing load roster including crews with no route. */
export function analyzeTeamCapacity(record) {
  const orders = record?.orders || [];
  const team = record?.team || [];
  const routes = record?.plan?.routes || [];
  const unresolved = record?.plan?.unassigned || [];
  const orderById = new Map(orders.map(order => [String(order.id), order]));
  const unresolvedById = new Map(unresolved.map(item => [String(item.orderId), item]));
  const routeByEngineer = new Map(routes.map(route => [String(route.engineerId), route]));
  const stats = team.map(engineer => {
    const route = routeByEngineer.get(String(engineer.id));
    const assignments = route?.assignments || [];
    const skills = (engineer.skills || []).map(String);
    const zone = String(engineer.zone || '').trim();
    const matches = order => (!zone || zoneOf(order) === zone) && skills.includes(skillOf(order));
    const matchingDemand = orders.filter(matches);
    const matchingBacklog = orders.filter(order => unresolvedById.has(String(order.id)) && matches(order));
    const shiftStart = minute(engineer.shiftStart ?? route?.shiftStart);
    const shiftEnd = minute(engineer.shiftEnd ?? route?.shiftEnd);
    const capacityMinutes = shiftStart != null && shiftEnd != null ? Math.max(0, shiftEnd - shiftStart) : 0;
    const workMinutes = assignments.reduce((sum, assignment) => sum + numeric(orderById.get(String(assignment.orderId))?.duration), 0);
    const travelMinutes = assignments.reduce((sum, assignment) => sum + numeric(assignment.travelMinutes), 0);
    const workloadMinutes = workMinutes + travelMinutes;
    const utilization = capacityMinutes ? Math.round(workloadMinutes / capacityMinutes * 100) : 0;
    const freeMinutes = Math.max(0, capacityMinutes - workloadMinutes);
    const finishes = assignments.map(item => minute(item.plannedFinish)).filter(value => value != null);
    const lastFinishMinute = finishes.length ? Math.max(...finishes) : null;
    const time = value => value == null ? null : `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    let explanation;
    let evidence = 'calculated';
    if (!assignments.length) {
      const zoneBacklog = orders.filter(order => unresolvedById.has(String(order.id)) && (!zone || zoneOf(order) === zone));
      const firstOpen = zoneBacklog[0];
      const requiredTransport = String(firstOpen?.requiredTransport || firstOpen?.transportRequirement || '').trim();
      const estimatedTravel = numeric(firstOpen?.estimatedTravelMinutes || firstOpen?.travelMinutes);
      const firstOpenId = String(firstOpen?.sourceId || firstOpen?.id || '').replace(/^.*:/, '');
      const shiftCanReach = firstOpen && shiftStart != null && minute(firstOpen.start) != null && (!estimatedTravel || shiftStart + estimatedTravel <= minute(firstOpen.start));
      if (firstOpen && !skills.includes(skillOf(firstOpen))) {
        explanation = `Не назначен: заявка #${firstOpenId} требует навык «${skillLabel(skillOf(firstOpen))}», у инженера: ${skills.map(skillLabel).join(', ') || 'навыки не указаны'}.`;
      } else if (firstOpen && requiredTransport && requiredTransport !== String(engineer.transport || '')) {
        explanation = `Не назначен: не подходит транспорт для заявки #${firstOpenId} (${skillLabel(skillOf(firstOpen))}).`;
      } else if (firstOpen && !shiftCanReach) {
        explanation = `Не назначен: не успевает к началу окна заявки #${firstOpenId} на выбранном транспорте.`;
      } else if (!zoneBacklog.length) {
        explanation = 'В оперативном резерве: все плановые заявки зоны закрыты. На линии под срочные аварии.';
      } else if (unresolved.length && !matchingBacklog.length) {
        explanation = `В открытой очереди есть заявки, но для этой бригады не подтверждено допустимое назначение.`;
        evidence = 'missing_reason';
      } else if (!matchingDemand.length) {
        explanation = 'В оперативном резерве: все плановые заявки зоны закрыты. На линии под срочные аварии.';
      } else if (!matchingBacklog.length) {
        explanation = `Подходящих заявок в зоне: ${matchingDemand.length}; все они распределены в другие маршруты. Причина выбора другой бригады не передана планировщиком.`;
        evidence = 'missing_reason';
      } else {
        explanation = `В очереди остаётся ${matchingBacklog.length} подходящих заявок, но ограничение, исключившее эту бригаду, не передано планировщиком.`;
        evidence = 'missing_reason';
      }
    } else if (utilization < 70) {
      const remaining = matchingBacklog.length;
      if (remaining) {
        explanation = `После маршрута остаётся ${hoursLabel(freeMinutes)} ч. В очереди ${remaining} заявок с совпадающими зоной и навыком; перед назначением нужен точный пересчёт маршрута.`;
      } else {
        explanation = `Последняя работа заканчивается в ${time(lastFinishMinute) || 'неизвестное время'}; до конца смены остаётся ${hoursLabel(freeMinutes)} ч. Подходящей открытой очереди нет.`;
      }
    } else {
      explanation = `В маршруте ${assignments.length} ${assignments.length === 1 ? 'заявка' : assignments.length < 5 ? 'заявки' : 'заявок'}; свободно около ${hoursLabel(freeMinutes)} ч смены.`;
    }
    return {
      engineerId: engineer.id,
      engineerName: engineer.name || String(engineer.id),
      zone: zone || 'Без зоны',
      skills: skills.map(skillLabel),
      transport: transportCode(engineer.transport),
      assignments: assignments.length,
      distanceKm: numeric(route?.distanceKm),
      workMinutes,
      travelMinutes,
      idleMinutes: freeMinutes,
      workloadMinutes,
      capacityMinutes,
      utilization,
      freeMinutes,
      lastFinishMinute,
      hasRoute: assignments.length > 0,
      explanation,
      evidence,
    };
  }).sort((a, b) => Number(a.hasRoute) - Number(b.hasRoute) || a.utilization - b.utilization || a.engineerName.localeCompare(b.engineerName, 'ru'));
  const active = stats.filter(item => item.hasRoute);
  const averageLoad = stats.length ? Math.round(stats.reduce((sum, item) => sum + item.utilization, 0) / stats.length) : 0;
  return { stats, averageLoad, lowestActive: active[0] || null, missingReasonCount: stats.filter(item => item.evidence === 'missing_reason').length };
}

const summarizeWeek = (byDate, dates) => {
  const days = dates.map(date => byDate.get(date));
  const demand = days.reduce((sum, day) => sum + day.total, 0);
  const assigned = days.reduce((sum, day) => sum + day.assigned, 0);
  const completed = days.reduce((sum, day) => sum + day.completed, 0);
  const onTime = days.reduce((sum, day) => sum + day.onTime, 0);
  const timingObserved = days.reduce((sum, day) => sum + day.timingObserved, 0);
  return {
    start: dates[0], end: dates.at(-1), days, demand, assigned,
    unassigned: Math.max(0, demand - assigned), coverage: rate(assigned, demand),
    completed, onTime, onTimeRate: rate(onTime, timingObserved),
    cancelled: days.reduce((sum, day) => sum + day.cancelled, 0),
    distance: days.reduce((sum, day) => sum + day.distance, 0),
    waiting: days.reduce((sum, day) => sum + day.waiting, 0),
  };
};

/** Return every complete Monday–Sunday week available in an arbitrary history feed. */
export function listCompleteWeeks(records) {
  const byDate = new Map((records || []).map(record => [record.date, summarizeHistoryDay(record)]));
  return [...byDate.keys()]
    .filter(date => new Date(`${date}T12:00:00Z`).getUTCDay() === 1)
    .map(start => Array.from({ length: 7 }, (_, index) => dateShift(start, index)))
    .filter(dates => dates.every(date => byDate.has(date)))
    .map(dates => summarizeWeek(byDate, dates))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Compare two consecutive complete calendar weeks without treating a partial week as a full one. */
export function compareWeeks(records, selectedDate) {
  const byDate = new Map((records || []).map(record => [record.date, summarizeHistoryDay(record)]));
  if (!selectedDate) return null;
  const weekday = new Date(`${selectedDate}T12:00:00Z`).getUTCDay();
  if (!Number.isFinite(weekday)) return null;
  const currentEnd = dateShift(selectedDate, -weekday);
  const currentDates = Array.from({ length: 7 }, (_, index) => dateShift(currentEnd, index - 6));
  const previousDates = currentDates.map(date => dateShift(date, -7));
  if (![...currentDates, ...previousDates].every(date => byDate.has(date))) return null;
  return { current: summarizeWeek(byDate, currentDates), previous: summarizeWeek(byDate, previousDates) };
}

/**
 * Build a factual explanation for a week-to-week change.
 * Every conclusion is derived from the compared days and their unassigned orders.
 */
export function explainWeekChange(current, comparison) {
  if (!current || !comparison) return null;
  const coverageDelta = Math.round((numeric(current.coverage) - numeric(comparison.coverage)) * 10) / 10;
  const backlogDelta = current.unassigned - comparison.unassigned;
  const demandDelta = current.demand - comparison.demand;
  const currentIssues = current.days.flatMap(day => day.issues?.unassigned || []);
  const groups = new Map();
  for (const issue of currentIssues) {
    const key = `${issue.zone}\u0000${issue.skill}`;
    const group = groups.get(key) || { zone: issue.zone, skill: issue.skill, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  const dominant = [...groups.values()].sort((left, right) => right.count - left.count)[0] || null;
  const peakDays = [...current.days]
    .filter(day => day.unassigned > 0)
    .sort((left, right) => right.unassigned - left.unassigned || right.total - left.total)
    .slice(0, 2);
  const peakBacklog = peakDays.reduce((sum, day) => sum + day.unassigned, 0);
  const peakShare = current.unassigned ? Math.round(peakBacklog / current.unassigned * 100) : 0;
  if (backlogDelta > 0 || coverageDelta < 0) {
    const dates = peakDays.map(day => shortDate(day.date)).join(' и ');
    const peakEvidence = peakDays.length
      ? `${dates} сформировали ${peakBacklog} ${plural(peakBacklog, ['неназначенную заявку', 'неназначенные заявки', 'неназначенных заявок'])} (${peakShare}% очереди недели)`
      : 'рост очереди распределён по дням недели без отдельного пика';
    const constraint = dominant
      ? `Основная группа дефицита — «${skillLabel(dominant.skill)}» в зоне «${dominant.zone}»: ${dominant.count} ${plural(dominant.count, ['заявка', 'заявки', 'заявок'])}.`
      : 'Для определения причины в данных нет неназначенных заявок с зоной и навыком.';
    return {
      tone: 'attention',
      title: coverageDelta < 0 ? `Покрытие снизилось на ${Math.abs(coverageDelta).toLocaleString('ru-RU')} п.п.` : `Очередь выросла на ${backlogDelta} ${plural(backlogDelta, ['заявку', 'заявки', 'заявок'])}`,
      detail: `${peakEvidence}. ${constraint}`,
      evidence: { coverageDelta, backlogDelta, demandDelta, peakDays: peakDays.map(day => day.date), peakShare, dominant },
    };
  }
  if (backlogDelta < 0 || coverageDelta > 0) {
    return {
      tone: 'good',
      title: `Покрытие ${coverageDelta > 0 ? `выросло на ${coverageDelta.toLocaleString('ru-RU')} п.п.` : 'сохранилось'}, очередь сократилась на ${Math.abs(backlogDelta)} ${plural(Math.abs(backlogDelta), ['заявку', 'заявки', 'заявок'])}`,
      detail: `При изменении входящего спроса на ${Math.abs(demandDelta)} ${plural(Math.abs(demandDelta), ['заявку', 'заявки', 'заявок'])} в ${demandDelta >= 0 ? 'большую' : 'меньшую'} сторону в план вошло ${current.assigned} из ${current.demand}.`,
      evidence: { coverageDelta, backlogDelta, demandDelta, peakDays: [], peakShare: 0, dominant },
    };
  }
  return {
    tone: 'neutral',
    title: 'Покрытие и очередь сохранились на уровне недели сравнения',
    detail: `В текущую неделю поступило ${current.demand} заявок, в неделю сравнения — ${comparison.demand}; изменение спроса: ${demandDelta >= 0 ? '+' : ''}${demandDelta}.`,
    evidence: { coverageDelta, backlogDelta, demandDelta, peakDays: [], peakShare: 0, dominant },
  };
}

/**
 * Generate long-term capacity findings directly from orders, team profiles and routes.
 * The function does not emit a staffing recommendation when the required evidence is absent.
 */
export function generatePeriodInsights(records) {
  const source = (records || []).filter(record => record?.date);
  if (!source.length) return [];
  const days = source.map(summarizeHistoryDay);
  const issues = days.flatMap(day => day.issues.unassigned);
  const assigned = days.reduce((sum, day) => sum + day.assigned, 0);
  const demand = days.reduce((sum, day) => sum + day.total, 0);
  if (!issues.length) {
    return [{
      key: 'coverage',
      tone: 'good',
      title: `За ${days.length} ${plural(days.length, ['смену', 'смены', 'смен'])} системного дефицита не выявлено`,
      detail: `Все ${demand} ${plural(demand, ['заявка', 'заявки', 'заявок'])} вошли в планы; рекомендация по найму или обучению не формируется без подтверждённого дефицита.`,
      evidence: { shifts: days.length, demand, assigned, unassigned: 0 },
    }];
  }
  const groups = new Map();
  for (const issue of issues) {
    const key = `${issue.zone}\u0000${issue.skill}`;
    const group = groups.get(key) || { zone: issue.zone, skill: issue.skill, count: 0, dates: new Map(), workMinutes: 0 };
    group.count += 1;
    group.dates.set(issue.date, (group.dates.get(issue.date) || 0) + 1);
    const record = source.find(item => item.date === issue.date);
    const order = record?.orders?.find(item => String(item.id) === String(issue.orderId));
    group.workMinutes += Math.max(0, numeric(order?.duration));
    groups.set(key, group);
  }
  const dominant = [...groups.values()].sort((left, right) => right.count - left.count || right.dates.size - left.dates.size)[0];
  const share = Math.round(dominant.count / issues.length * 100);
  const peak = Math.max(...dominant.dates.values());
  const throughputSamples = source.flatMap(record => {
    const qualified = (record.team || []).filter(engineer => zoneOf(engineer) === dominant.zone && (engineer.skills || []).map(String).includes(String(dominant.skill))).length;
    if (!qualified) return [];
    const orderById = new Map((record.orders || []).map(order => [String(order.id), order]));
    const matchingAssignments = (record.plan?.routes || []).flatMap(route => route.assignments || []).filter(assignment => {
      const order = orderById.get(String(assignment.orderId));
      return order && zoneOf(order) === dominant.zone && skillOf(order) === dominant.skill;
    }).length;
    return matchingAssignments ? [matchingAssignments / qualified] : [];
  });
  const throughput = median(throughputSamples) || Math.max(1, dominant.workMinutes / Math.max(1, dominant.dates.size) / 480);
  const requiredPeople = Math.max(1, Math.ceil(peak / Math.max(throughput, 1)));
  const traineeIds = new Set();
  for (const record of source) {
    const active = new Set((record.plan?.routes || []).filter(route => route.assignments?.length).map(route => String(route.engineerId)));
    for (const engineer of record.team || []) {
      const skills = (engineer.skills || []).map(String);
      if (zoneOf(engineer) === dominant.zone && !skills.includes(String(dominant.skill)) && !active.has(String(engineer.id))) traineeIds.add(String(engineer.id));
    }
  }
  const trainable = Math.min(requiredPeople, traineeIds.size);
  const staffingAction = trainable >= requiredPeople
    ? `Рекомендация HR: обучить ${requiredPeople} ${plural(requiredPeople, ['сотрудника', 'сотрудников', 'сотрудников'])} навыку «${skillLabel(dominant.skill)}».`
    : trainable > 0
      ? `Рекомендация HR: обучить ${trainable} ${plural(trainable, ['сотрудника', 'сотрудников', 'сотрудников'])} из резерва и проверить найм ещё ${requiredPeople - trainable}.`
      : `Рекомендация HR: проверить расширение штата на ${requiredPeople} ${plural(requiredPeople, ['сотрудника', 'сотрудников', 'сотрудников'])} с навыком «${skillLabel(dominant.skill)}».`;
  const peakDay = [...days].sort((left, right) => right.unassigned - left.unassigned || right.total - left.total)[0];
  const medianDemand = median(days.map(day => day.total)) || 0;
  const insights = [{
    key: 'systemic-gap',
    tone: 'attention',
    title: `Системный дефицит за ${days.length} ${plural(days.length, ['смену', 'смены', 'смен'])}: «${skillLabel(dominant.skill)}», зона «${dominant.zone}»`,
    detail: `${dominant.count} из ${issues.length} неназначенных заявок (${share}%) относятся к этой группе; дефицит повторился в ${dominant.dates.size} ${plural(dominant.dates.size, ['смене', 'сменах', 'сменах'])}. ${staffingAction}`,
    evidence: { shifts: days.length, totalUnassigned: issues.length, share, dominant: { zone: dominant.zone, skill: dominant.skill, count: dominant.count, days: dominant.dates.size }, throughput, requiredPeople, trainable },
  }];
  if (peakDay?.unassigned > 0 && peakDay.total > medianDemand) {
    insights.push({
      key: 'peak-day',
      tone: 'neutral',
      title: `Пиковая очередь — ${shortDate(peakDay.date)}`,
      detail: `Поступило ${peakDay.total} заявок при медиане ${Math.round(medianDemand)} за смену; без назначения осталось ${peakDay.unassigned}.`,
      evidence: { date: peakDay.date, demand: peakDay.total, medianDemand, unassigned: peakDay.unassigned },
    });
  }
  return insights;
}

/** Find the strongest evidence-backed territory anomalies inside a selected period. */
export function detectPeriodAreaAnomalies(records, periodStart, periodEnd) {
  const dates = (records || []).map(record => record.date).filter(date => date && (!periodStart || date >= periodStart) && (!periodEnd || date <= periodEnd));
  const strongest = new Map();
  for (const date of dates) {
    for (const item of detectAreaAnomalies(records, date)) {
      const candidate = { ...item, date, relativeGap: item.gap / Math.max(item.previousMax, 1) };
      const key = `${item.zone}\u0000${item.metric}`;
      if (!strongest.has(key) || candidate.relativeGap > strongest.get(key).relativeGap) strongest.set(key, candidate);
    }
  }
  return [...strongest.values()].sort((left, right) => right.relativeGap - left.relativeGap).slice(0, 5);
}

/** Aggregate a period by operational territory or independently named region. */
export function compareAreas(records, dimension = 'zone') {
  const groups = new Map();
  for (const record of records || []) {
    const orders = record.orders || [];
    const byId = new Map(orders.map(order => [String(order.id), order]));
    const assignments = (record.plan?.routes || []).flatMap(route => route.assignments || []);
    const assigned = new Set(assignments.map(item => String(item.orderId)));
    const visits = new Map((record.actual?.visits || []).map(visit => [String(visit.orderId), visit]));
    for (const order of orders) {
      const name = dimension === 'region' ? regionOf(order) : zoneOf(order);
      const group = groups.get(name) || { name, demand: 0, assigned: 0, unassigned: 0, completed: 0, onTime: 0, timingObserved: 0, cancelled: 0, distance: 0, waiting: 0, dates: new Set() };
      group.demand += 1;
      group.assigned += Number(assigned.has(String(order.id)));
      group.unassigned += Number(!assigned.has(String(order.id)));
      const visit = visits.get(String(order.id));
      if (visit?.status === 'completed') {
        group.completed += 1;
        const observed = typeof visit.onTime === 'boolean' ? visit.onTime : minute(visit.start) != null && minute(order.end) != null ? minute(visit.start) <= minute(order.end) : null;
        if (observed != null) group.timingObserved += 1;
        if (observed === true) group.onTime += 1;
      }
      if (visit?.status === 'cancelled') group.cancelled += 1;
      group.dates.add(record.date);
      groups.set(name, group);
    }
    for (const assignment of assignments) {
      const order = byId.get(String(assignment.orderId));
      if (!order) continue;
      const name = dimension === 'region' ? regionOf(order) : zoneOf(order);
      const group = groups.get(name);
      group.distance += numeric(assignment.distanceM) / 1000;
      const arrival = minute(assignment.arrival);
      const start = minute(assignment.plannedStart);
      if (arrival != null && start != null) group.waiting += Math.max(0, start - arrival);
    }
  }
  return [...groups.values()].map(group => ({ ...group, dates: group.dates.size, coverage: rate(group.assigned, group.demand), onTimeRate: rate(group.onTime, group.timingObserved), cancelRate: rate(group.cancelled, group.completed + group.cancelled), distancePerAssigned: group.assigned ? group.distance / group.assigned : null, waitingPerAssigned: group.assigned ? group.waiting / group.assigned : null })).sort((a, b) => b.unassigned - a.unassigned || b.demand - a.demand);
}

/** Forecast tomorrow's demand by weekday and segment from several weeks of history. */
export function forecastSegments(records) {
  const ordered = [...(records || [])].filter(record => record?.date && Array.isArray(record.orders)).sort((a, b) => a.date.localeCompare(b.date));
  if (ordered.length < 21) return null;
  const date = dateShift(ordered.at(-1).date, 1);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const comparable = ordered.filter(record => new Date(`${record.date}T12:00:00Z`).getUTCDay() === weekday).slice(-8);
  if (comparable.length < 3) return null;
  const summarize = selector => {
    const keys = new Set(comparable.flatMap(record => record.orders.map(selector)));
    return [...keys].map(name => {
      const counts = comparable.map(record => record.orders.filter(order => selector(order) === name).length);
      return { name, low: Math.min(...counts), middle: Math.round(median(counts)), high: Math.max(...counts), samples: counts.length };
    }).sort((a, b) => b.middle - a.middle || b.high - a.high);
  };
  const totals = comparable.map(record => record.orders.length);
  return {
    date, samples: comparable.length, comparableDates: comparable.map(record => record.date),
    total: { low: Math.min(...totals), middle: Math.round(median(totals)), high: Math.max(...totals) },
    zones: summarize(zoneOf), skills: summarize(skillOf), timeBands: summarize(order => timeBand(order.start)),
  };
}

/** Join every stop of a planned route with actual arrival, start, finish and status. */
export function routePlanFact(record) {
  const byId = new Map((record?.orders || []).map(order => [String(order.id), order]));
  const observed = new Map((record?.actual?.visits || []).map(visit => [String(visit.orderId), visit]));
  return (record?.plan?.routes || []).map(route => {
    const stops = (route.assignments || []).map(assignment => {
      const order = byId.get(String(assignment.orderId));
      const actual = observed.get(String(assignment.orderId));
      const actualStart = minute(actual?.start);
      const plannedStart = minute(assignment.plannedStart);
      const windowEnd = minute(order?.end);
      const timely = actual?.status === 'completed' ? typeof actual.onTime === 'boolean' ? actual.onTime : actualStart != null && minute(order?.end) != null ? actualStart <= minute(order.end) : null : null;
      return {
        orderId: assignment.orderId, name: order?.name || `Заявка ${assignment.orderId}`,
        zone: zoneOf(order), window: `${order?.start || '—'}–${order?.end || '—'}`, windowStart: order?.start || null, windowEnd: order?.end || null,
        planned: { arrival: assignment.arrival || null, start: assignment.plannedStart || null, finish: assignment.plannedFinish || null },
        actual: actual ? { arrival: actual.arrival || null, start: actual.start || null, finish: actual.finish || null } : null,
        status: !record?.actual ? 'no_fact' : !actual ? 'missing' : actual.status,
        timely, late: timely === false,
        plannedSlack: plannedStart != null && windowEnd != null ? windowEnd - plannedStart : null,
        startDelta: actualStart != null && plannedStart != null ? actualStart - plannedStart : null,
      };
    });
    return {
      engineerId: route.engineerId, engineerName: route.engineerName || route.engineerId,
      distanceKm: numeric(route.distanceKm), stops,
      completed: stops.filter(stop => stop.status === 'completed').length,
      cancelled: stops.filter(stop => stop.status === 'cancelled').length,
      late: stops.filter(stop => stop.late).length,
    };
  }).filter(route => route.stops.length);
}

const durationText = minutes => {
  const safe = Math.max(0, Math.round(numeric(minutes)));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (!hours) return `${rest} мин`;
  if (!rest) return `${hours} ч`;
  return `${hours} ч ${String(rest).padStart(2, '0')} мин`;
};

/** Explain plan reliability from the planned start and the customer's window. */
export function planReliability(stop) {
  const plannedStart = minute(stop?.planned?.start);
  const windowStart = minute(stop?.windowStart);
  const windowEnd = minute(stop?.windowEnd);
  if (plannedStart == null || windowEnd == null) return { tone: 'unknown', slackMinutes: null, slackLabel: 'Нет данных', label: 'Недостаточно данных для оценки' };
  const slackMinutes = windowEnd - plannedStart;
  const slackLabel = slackMinutes >= 0 ? durationText(slackMinutes) : `−${durationText(Math.abs(slackMinutes))}`;
  if (windowStart != null && plannedStart === windowStart) return { tone: 'good', slackMinutes, slackLabel, label: 'Идеальный старт (к началу окна)' };
  if (slackMinutes < 0) return { tone: 'attention', slackMinutes, slackLabel, label: `Критический риск: старт позже закрытия окна на ${durationText(Math.abs(slackMinutes))}` };
  if (slackMinutes <= 15) return { tone: 'attention', slackMinutes, slackLabel, label: `Критический риск: старт за ${durationText(slackMinutes)} до конца окна` };
  if (slackMinutes <= 30) return { tone: 'warning', slackMinutes, slackLabel, label: `Малый запас: ${durationText(slackMinutes)} до конца окна` };
  return { tone: 'good', slackMinutes, slackLabel, label: `Запас ${durationText(slackMinutes)} (Надёжно)` };
}

const transportKey = value => {
  const normalized = String(value || '').toUpperCase().replace(/[^A-ZА-ЯЁ]+/g, '_');
  if (normalized.includes('PUBLIC') || normalized.includes('ТРАНСПОРТ') || normalized.includes('МЕТРО')) return 'transit';
  if (normalized.includes('CAR') || normalized.includes('AUTO') || normalized.includes('АВТО')) return 'car';
  if (normalized.includes('BICYCLE') || normalized.includes('BIKE') || normalized.includes('ВЕЛО')) return 'bicycle';
  if (normalized.includes('WALK') || normalized.includes('ПЕШ')) return 'walking';
  return 'unknown';
};

const routeDistance = route => numeric(route?.distanceKm) || (route?.assignments || []).reduce((sum, assignment) => sum + numeric(assignment.distanceM) / 1000, 0);
const routeWaiting = route => {
  if (route?.waitingMinutes != null && Number.isFinite(Number(route.waitingMinutes))) return Math.max(0, Number(route.waitingMinutes));
  return (route?.assignments || []).reduce((sum, assignment) => {
    const arrival = minute(assignment.arrival);
    const start = minute(assignment.plannedStart);
    return sum + (arrival != null && start != null ? Math.max(0, start - arrival) : 0);
  }, 0);
};

/** Default operational rates used until the dispatcher enters company-specific values. */
export const DEFAULT_ECONOMIC_RATES = {
  perHour: 650,
  carKm: 16,
  transitShift: 320,
  bicycleShift: 120,
  walkingShift: 0,
};

const shiftMinutes = engineer => {
  const start = minute(engineer?.shiftStart);
  const end = minute(engineer?.shiftEnd);
  return start != null && end != null ? Math.max(0, end - start) : 0;
};

const planEconomics = (routes, teamList, rates, orderMap = new Map()) => {
  const team = new Map((teamList || []).map(engineer => [String(engineer.id), engineer]));
  const groups = { car: [], transit: [], bicycle: [], walking: [] };
  const rows = (routes || []).filter(route => route.assignments?.length).map(route => {
    const engineer = team.get(String(route.engineerId));
    const rawTransport = transportKey(engineer?.transport || route.transport);
    const transport = rawTransport === 'unknown' ? 'walking' : rawTransport;
    const visits = route.assignments.length;
    const distanceKm = routeDistance(route);
    const travelMinutes = route.travelMinutes != null
      ? Math.max(0, numeric(route.travelMinutes))
      : route.assignments.reduce((sum, assignment) => sum + Math.max(0, numeric(assignment.travelMinutes)), 0);
    const serviceMinutes = route.assignments.reduce((sum, assignment) => {
      const orderDuration = numeric(orderMap.get(String(assignment.orderId))?.duration);
      const start = minute(assignment.plannedStart);
      const finish = minute(assignment.plannedFinish);
      return sum + (orderDuration || (start != null && finish != null ? Math.max(0, finish - start) : 0));
    }, 0);
    const paidMinutes = route.workloadMinutes != null
      ? Math.max(0, numeric(route.workloadMinutes))
      : shiftMinutes(engineer) || serviceMinutes + travelMinutes;
    const row = { engineerId: route.engineerId, transport, visits, distanceKm, travelMinutes, serviceMinutes, paidMinutes };
    groups[transport].push(row);
    return row;
  });
  const fleet = [
    { key: 'car', label: 'Автомобили' },
    { key: 'transit', label: 'Общественный транспорт' },
    { key: 'bicycle', label: 'Велосипеды' },
    { key: 'walking', label: 'Пешеходы' },
  ].map(item => {
    const group = groups[item.key];
    const visits = group.reduce((sum, route) => sum + route.visits, 0);
    const distanceKm = group.reduce((sum, route) => sum + route.distanceKm, 0);
    const travelMinutes = group.reduce((sum, route) => sum + route.travelMinutes, 0);
    const laborHours = group.reduce((sum, route) => sum + route.paidMinutes, 0) / 60;
    const transportAmount = item.key === 'car'
      ? distanceKm * rates.carKm
      : item.key === 'transit'
        ? group.length * rates.transitShift
        : item.key === 'bicycle'
          ? group.length * rates.bicycleShift
          : group.length * rates.walkingShift;
    const laborAmount = laborHours * rates.perHour;
    const totalAmount = laborAmount + transportAmount;
    return {
      ...item,
      routes: group.length,
      visits,
      distanceKm,
      travelMinutes,
      averageDistancePerVisit: visits ? distanceKm / visits : 0,
      averageTravelMinutes: visits ? travelMinutes / visits : 0,
      laborHours,
      laborAmount,
      transportAmount,
      totalAmount,
      costPerVisit: visits ? totalAmount / visits : 0,
    };
  });
  const laborHours = fleet.reduce((sum, item) => sum + item.laborHours, 0);
  const laborAmount = fleet.reduce((sum, item) => sum + item.laborAmount, 0);
  const transportAmount = fleet.reduce((sum, item) => sum + item.transportAmount, 0);
  return {
    rows,
    fleet,
    visits: fleet.reduce((sum, item) => sum + item.visits, 0),
    laborHours,
    laborAmount,
    transportAmount,
    directCost: laborAmount + transportAmount,
  };
};

/** Find route-level efficiency reserves supported by the current plan. */
export function analyzeShiftEfficiency(record) {
  const displayNumber = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
  const routes = (record?.plan?.routes || []).filter(route => route.assignments?.length);
  const orders = new Map((record?.orders || []).map(order => [String(order.id), order]));
  const team = new Map((record?.team || []).map(engineer => [String(engineer.id), engineer]));
  const routeRows = routes.map(route => {
    const visits = route.assignments.length;
    const serviceMinutes = route.assignments.reduce((sum, assignment) => sum + numeric(orders.get(String(assignment.orderId))?.duration), 0);
    const travelMinutes = route.travelMinutes != null && Number.isFinite(Number(route.travelMinutes)) ? Math.max(0, Number(route.travelMinutes)) : route.assignments.reduce((sum, assignment) => sum + numeric(assignment.travelMinutes), 0);
    const waitingMinutes = routeWaiting(route);
    const distanceKm = routeDistance(route);
    const longWaitingMinutes = route.assignments.reduce((sum, assignment) => {
      const arrival = minute(assignment.arrival);
      const start = minute(assignment.plannedStart);
      const wait = arrival != null && start != null ? Math.max(0, start - arrival) : 0;
      return sum + Math.max(0, wait - 15);
    }, 0);
    const totalMinutes = Math.max(1, serviceMinutes + travelMinutes + waitingMinutes);
    const engineer = team.get(String(route.engineerId));
    return {
      engineerId: route.engineerId,
      engineerName: route.engineerName || engineer?.name || route.engineerId,
      transport: transportKey(engineer?.transport || route.transport),
      zone: String(engineer?.zone || route.zone || ''),
      assignments: route.assignments,
      visits, serviceMinutes, travelMinutes, waitingMinutes, longWaitingMinutes, distanceKm,
      distancePerVisit: visits ? distanceKm / visits : 0,
      productiveShare: serviceMinutes / totalMinutes * 100,
    };
  });
  const enrichedRoutes = routeRows.map(route => {
    const sameTransport = routeRows.filter(item => item.visits > 0 && item.transport === route.transport && item.transport !== 'unknown');
    const sameZone = sameTransport.filter(item => item.zone && item.zone === route.zone);
    const peers = sameZone.length >= 3 ? sameZone : [];
    const distanceBaseline = median(peers.map(item => item.distancePerVisit));
    const excessDistanceKm = distanceBaseline > 0 && route.distancePerVisit > distanceBaseline * 1.3 ? Math.max(0, route.distanceKm - distanceBaseline * route.visits) : 0;
    const excessTravelMinutes = route.distanceKm > 0 ? route.travelMinutes * excessDistanceKm / route.distanceKm : 0;
    const recoverableMinutes = route.longWaitingMinutes + excessTravelMinutes;
    const longestLeg = [...route.assignments].sort((left, right) => numeric(right.distanceM) - numeric(left.distanceM))[0];
    const constrainingOrder = orders.get(String(longestLeg?.orderId));
    const requiredSkill = skillOf(constrainingOrder);
    const windowStart = minute(constrainingOrder?.start);
    const windowEnd = minute(constrainingOrder?.end);
    const qualifiedAlternatives = (record?.team || []).filter(engineer => String(engineer.id) !== String(route.engineerId)
      && zoneOf(engineer) === route.zone
      && (engineer.skills || []).map(String).includes(requiredSkill));
    const freeAlternatives = qualifiedAlternatives.filter(engineer => {
      const candidateRoute = routes.find(item => String(item.engineerId) === String(engineer.id));
      if (!candidateRoute?.assignments?.length || windowStart == null || windowEnd == null) return true;
      return !candidateRoute.assignments.some(assignment => {
        const start = minute(assignment.plannedStart);
        const finish = minute(assignment.plannedFinish);
        return start != null && finish != null && start < windowEnd && finish > windowStart;
      });
    });
    const orderIdentity = String(constrainingOrder?.sourceId || constrainingOrder?.id || '').replace(/^.*:/, '');
    const orderNumber = orderIdentity.match(/(\d+)$/)?.[1] || orderIdentity;
    const window = constrainingOrder?.start && constrainingOrder?.end ? `${constrainingOrder.start}–${constrainingOrder.end}` : 'фиксированное клиентское окно';
    const constraintReason = freeAlternatives.length
      ? `Из ${qualifiedAlternatives.length + 1} бригад зоны с навыком «${skillLabel(requiredSkill)}» этот маршрут сохранил окно ${window} без переноса уже назначенных визитов.`
      : qualifiedAlternatives.length
        ? `Другие ${qualifiedAlternatives.length} ${qualifiedAlternatives.length === 1 ? 'бригада зоны была занята' : 'бригад зоны были заняты'} в окне ${window}; межрегиональный перенос запрещён.`
        : `В зоне нет другой бригады с навыком «${skillLabel(requiredSkill)}»; межрегиональный перенос запрещён.`;
    return {
      ...route,
      distanceBaseline,
      excessDistanceKm,
      excessTravelMinutes,
      recoverableMinutes,
      constrainingOrder: constrainingOrder ? {
        id: constrainingOrder.id,
        number: orderNumber,
        window,
        skill: requiredSkill,
      } : null,
      constraintReason,
    };
  });
  const excessWaitingMinutes = enrichedRoutes.reduce((sum, route) => sum + route.longWaitingMinutes, 0);
  const excessDistanceKm = enrichedRoutes.reduce((sum, route) => sum + route.excessDistanceKm, 0);
  const excessTravelMinutes = enrichedRoutes.reduce((sum, route) => sum + route.excessTravelMinutes, 0);
  const recoverableMinutes = excessWaitingMinutes + excessTravelMinutes;
  const assigned = routes.reduce((sum, route) => sum + route.assignments.length, 0);
  const unassigned = numeric(record?.plan?.metrics?.unassigned ?? record?.plan?.unassigned?.length);
  const typicalVisitMinutes = median((record?.orders || []).map(order => numeric(order.duration)).filter(Boolean)) + (assigned ? enrichedRoutes.reduce((sum, route) => sum + route.travelMinutes, 0) / assigned : 0);
  const potentialExtraVisits = typicalVisitMinutes > 0 ? Math.min(unassigned, Math.floor(recoverableMinutes / typicalVisitMinutes)) : 0;
  const opportunities = [
    excessWaitingMinutes > 0 ? {
      key: 'waiting', title: 'Сократить длинные ожидания клиентских окон',
      minutes: excessWaitingMinutes,
      evidence: `${Math.round(excessWaitingMinutes)} мин ожидания сверх 15 минут на остановку`,
      effect: `${displayNumber(excessWaitingMinutes / 60)} ч ожидания для проверки`,
      action: 'Проверьте, можно ли изменить порядок визитов или согласовать другое окно с клиентом.',
    } : null,
    excessDistanceKm > 0 ? {
      key: 'travel', title: 'Маршруты с повышенным плечом обоснованы ограничениями',
      minutes: excessTravelMinutes,
      evidence: `${displayNumber(excessDistanceKm)} км сверх типичного пробега на визит среди бригад той же зоны и транспорта`,
      effect: `${displayNumber(excessTravelMinutes / 60)} ч необходимого доезда`,
      action: 'Плечо доезда объясняется клиентскими окнами, навыками и региональной изоляцией.',
    } : null,
  ].filter(Boolean).sort((a, b) => b.minutes - a.minutes);
  return {
    routes: [...enrichedRoutes].sort((a, b) => b.recoverableMinutes - a.recoverableMinutes || b.waitingMinutes + b.travelMinutes - a.waitingMinutes - a.travelMinutes),
    elevatedRoutes: enrichedRoutes.filter(route => route.excessDistanceKm > 0).sort((left, right) => right.distancePerVisit - left.distancePerVisit),
    opportunities, recoverableMinutes, excessWaitingMinutes, excessDistanceKm, excessTravelMinutes,
    potentialExtraVisits, unassigned, affectedRoutes: enrichedRoutes.filter(route => route.recoverableMinutes > 0).length,
    productiveShare: rate(enrichedRoutes.reduce((sum, route) => sum + route.serviceMinutes, 0), enrichedRoutes.reduce((sum, route) => sum + route.serviceMinutes + route.travelMinutes + route.waitingMinutes, 0)),
  };
}

/** Calculate shift economics and compare the optimized plan with the FCFS baseline. */
export function calculateEconomics(record, rates = {}, baseline = null) {
  const values = Object.fromEntries(Object.entries(DEFAULT_ECONOMIC_RATES).map(([key, fallback]) => {
    const value = rates?.[key];
    return [key, value !== '' && value != null && Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback];
  }));
  const orders = new Map((record?.orders || []).map(order => [String(order.id), order]));
  const optimized = planEconomics(record?.plan?.routes || [], record?.team || [], values, orders);
  const baselinePlan = baseline?.routes?.length
    ? planEconomics(baseline.routes, record?.team || [], values, orders)
    : optimized;
  const savingPerShift = baselinePlan.directCost - optimized.directCost;
  const directCost = optimized.directCost;
  const costPerAssigned = optimized.visits ? directCost / optimized.visits : 0;
  const laborShare = directCost ? optimized.laborAmount / directCost * 100 : 0;
  const transportShare = directCost ? optimized.transportAmount / directCost * 100 : 0;
  const transportBreakdown = optimized.fleet.map(item => ({
    ...item,
    amount: item.transportAmount,
    detail: item.key === 'car'
      ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(item.distanceKm)} км × ${values.carKm} ₽`
      : item.key === 'transit'
        ? `${item.routes} × ${values.transitShift} ₽ за смену`
        : item.key === 'bicycle'
          ? `${item.routes} × ${values.bicycleShift} ₽ за смену`
          : 'Прямые транспортные расходы отсутствуют',
  }));
  return {
    rates: values,
    directCost,
    costPerAssigned,
    savingPerShift,
    monthlySaving: savingPerShift * 30,
    baselineDirectCost: baselinePlan.directCost,
    laborHours: optimized.laborHours,
    laborAmount: optimized.laborAmount,
    transportAmount: optimized.transportAmount,
    laborShare,
    transportShare,
    fleetMetrics: optimized.fleet,
    transportBreakdown,
    components: [
      { key: 'labor', label: 'ФОТ бригад', quantity: optimized.laborHours, unit: 'ч', tariff: values.perHour, amount: optimized.laborAmount },
      { key: 'transport', label: 'Транспорт', quantity: optimized.rows.length, unit: 'маршрутов', tariff: null, amount: optimized.transportAmount },
    ],
    complete: true,
    factAvailable: Boolean(record?.actual),
  };
}

/** Compare operational KPIs with user-configured goals; missing fact stays unknown. */
export function evaluateGoals(record, targets) {
  const summary = summarizeHistoryDay(record);
  const target = key => targets?.[key] === '' || targets?.[key] == null ? null : numeric(targets[key]);
  const metrics = [
    { key: 'coverage', label: 'Заявки в плане', value: summary.coverage, target: target('coverage'), direction: 'min', unit: '%' },
    { key: 'onTime', label: 'Начаты вовремя', value: summary.onTimeRate, target: target('onTime'), direction: 'min', unit: '%' },
    { key: 'cancelRate', label: 'Отменены', value: summary.cancelRate, target: target('cancelRate'), direction: 'max', unit: '%' },
    { key: 'unassigned', label: 'Без назначения', value: summary.unassigned, target: target('unassigned'), direction: 'max', unit: '' },
  ];
  return metrics.map(item => ({ ...item, status: item.target == null ? 'not_set' : item.value == null ? 'unknown' : item.direction === 'min' ? item.value >= item.target ? 'met' : 'missed' : item.value <= item.target ? 'met' : 'missed' }));
}

/** Flag material territory-level changes against the same weekday in earlier weeks. */
export function detectAreaAnomalies(records, selectedDate) {
  const sorted = [...(records || [])].filter(record => record?.date).sort((a, b) => a.date.localeCompare(b.date));
  const selected = sorted.find(record => record.date === selectedDate);
  if (!selected) return [];
  const weekday = new Date(`${selectedDate}T12:00:00Z`).getUTCDay();
  const prior = sorted.filter(record => record.date < selectedDate && new Date(`${record.date}T12:00:00Z`).getUTCDay() === weekday).slice(-8);
  if (prior.length < 3) return [];
  const current = compareAreas([selected]);
  return current.flatMap(area => {
    const history = prior.map(record => compareAreas([record]).find(item => item.name === area.name));
    const checks = [
      { key: 'demand', metric: 'Спрос', unit: 'заявок', value: area.demand, minimum: 4 },
      { key: 'unassigned', metric: 'Очередь', unit: 'заявок', value: area.unassigned, minimum: 2 },
      { key: 'distancePerAssigned', metric: 'Пробег на заявку', unit: 'км', value: area.distancePerAssigned, minimum: 0.5 },
      { key: 'waitingPerAssigned', metric: 'Ожидание на заявку', unit: 'мин', value: area.waitingPerAssigned, minimum: 3 },
      { key: 'cancelRate', metric: 'Доля отмен', unit: '%', value: area.cancelRate, minimum: 2 },
    ];
    return checks.flatMap(check => {
      const previous = history.map(item => item?.[check.key]).filter(value => value != null);
      if (check.value == null || previous.length < 3) return [];
      const edge = Math.max(...previous);
      const gap = check.value - edge;
      if (gap < check.minimum || gap < Math.max(1, median(previous) * 0.1)) return [];
      return [{ zone: area.name, metric: check.metric, unit: check.unit, value: check.value, previousMax: edge, gap, dates: previous.length }];
    });
  }).sort((a, b) => b.gap / Math.max(b.previousMax, 1) - a.gap / Math.max(a.previousMax, 1)).slice(0, 5);
}

/** Estimate a best-case capacity change; this does not publish or validate a new route. */
export function simulateCapacity(record, history, options) {
  const summary = summarizeHistoryDay(record);
  const mode = options?.mode || 'add';
  const count = Math.max(1, Math.min(5, Math.round(numeric(options?.count) || 1)));
  const zone = options?.zone || '';
  const skill = options?.skill || '';
  const eligible = summary.issues.unassigned.filter(item => (!zone || item.zone === zone) && (!skill || item.skill === skill));
  const days = (history || []).filter(day => day?.date && day.date < record.date).map(summarizeHistoryDay);
  const throughput = median(days.filter(day => day.activeEngineers > 0).map(day => day.assigned / day.activeEngineers)) || (summary.activeEngineers ? summary.assigned / summary.activeEngineers : 0);
  let maximumRecovered = 0;
  let moved = 0;
  let capacityExplanation = '';
  if (mode === 'add') {
    maximumRecovered = Math.min(eligible.length, Math.floor(throughput * count));
    capacityExplanation = `${eligible.length} заявок подходят по выбранным зоне и навыку; историческая выработка — около ${Math.round(throughput * 10) / 10} назначений на бригаду.`;
  } else if (mode === 'extend') {
    const extraMinutes = Math.max(15, Math.min(180, Math.round(numeric(options?.minutes) || 60)));
    const engineerIds = new Set((record.team || []).filter(engineer => !skill || (engineer.skills || []).includes(skill)).map(engineer => String(engineer.id)));
    const routes = (record.plan?.routes || []).filter(route => engineerIds.has(String(route.engineerId)));
    const endTimes = routes.map(route => minute(route.shiftEnd)).filter(value => value != null);
    const latestEnd = endTimes.length ? Math.max(...endTimes) : null;
    const afterShift = eligible.filter(item => latestEnd != null && minute(item.window) != null && minute(item.window) > latestEnd);
    const orderById = new Map((record.orders || []).map(order => [String(order.id), order]));
    const medianDuration = median(afterShift.map(item => numeric(orderById.get(String(item.orderId))?.duration)).filter(value => value > 0)) || 60;
    maximumRecovered = Math.min(afterShift.length, Math.floor(extraMinutes / medianDuration));
    capacityExplanation = `${afterShift.length} заявок имеют окно после конца подходящей смены; добавлено ${extraMinutes} минут. Дорога и перестройка маршрута здесь не рассчитаны.`;
  } else if (mode === 'move') {
    moved = Math.min(count, eligible.length);
    capacityExplanation = `${moved} неназначенных заявок сняты с очереди выбранного дня и добавятся к спросу следующего. Это перенос, а не выполненная работа.`;
  }
  return {
    mode, eligible: eligible.length, maximumRecovered, moved, explanation: capacityExplanation,
    baseline: { total: summary.total, assigned: summary.assigned, unassigned: summary.unassigned, coverage: summary.coverage },
    bestCase: mode === 'move'
      ? { total: summary.total - moved, assigned: summary.assigned, unassigned: summary.unassigned - moved, coverage: rate(summary.assigned, summary.total - moved) }
      : { total: summary.total, assigned: summary.assigned + maximumRecovered, unassigned: Math.max(0, summary.unassigned - maximumRecovered), coverage: rate(summary.assigned + maximumRecovered, summary.total) },
    status: 'ESTIMATE_ONLY',
  };
}

const scenarioOrder = (record, item) => (record?.orders || []).find(order => String(order.id) === String(item.orderId));
const scenarioMatches = (order, zone, skill) => order && (!zone || zoneOf(order) === zone) && (!skill || skillOf(order) === skill);
const roundedMedianMinute = (values, fallback) => {
  const value = median(values.filter(Number.isFinite));
  return value == null ? fallback : Math.round(value / 15) * 15;
};

function allocateScenarioOrders(orders, slots) {
  const queue = [...orders].sort((left, right) => minute(left.end) - minute(right.end) || numeric(right.duration) - numeric(left.duration) || String(left.id).localeCompare(String(right.id)));
  const scheduled = [];
  const skipped = [];
  for (const order of queue) {
    const startWindow = minute(order.start);
    const endWindow = minute(order.end);
    const duration = Math.max(15, numeric(order.duration) || 60);
    if (startWindow == null || endWindow == null) {
      skipped.push({ order, reason: 'У заявки не задано клиентское окно' });
      continue;
    }
    const candidates = slots.map((slot, index) => {
      const start = Math.max(slot.next, startWindow);
      const finish = start + duration;
      return { slot, index, start, finish, feasible: start <= endWindow && finish <= slot.end };
    }).filter(candidate => candidate.feasible).sort((left, right) => left.start - right.start || left.slot.end - right.slot.end);
    if (!candidates.length) {
      skipped.push({ order, reason: 'Не помещается в доступные часы с учётом длительности работы' });
      continue;
    }
    const selected = candidates[0];
    selected.slot.next = selected.finish + 20;
    selected.slot.jobs += 1;
    selected.slot.workMinutes += duration;
    scheduled.push({ order, slot: selected.index + 1, start: selected.start, finish: selected.finish, duration });
  }
  return { scheduled, skipped };
}

/**
 * Build an executable capacity schedule from selected backlog orders.
 * It checks skill, territory, client windows, shift time, service duration and a 20-minute transition buffer.
 * Roads are intentionally not invented here; route publication still belongs to the exact planner.
 */
export function simulateCapacitySchedule(record, options) {
  const summary = summarizeHistoryDay(record);
  const mode = options?.mode || 'add';
  const zone = options?.zone || '';
  const skill = options?.skill || '';
  const count = Math.max(1, Math.min(5, Math.round(numeric(options?.count) || 1)));
  const extraMinutes = Math.max(15, Math.min(180, Math.round(numeric(options?.minutes) || 60)));
  const backlog = (record?.plan?.unassigned || []).map(item => scenarioOrder(record, item)).filter(order => scenarioMatches(order, zone, skill));
  const team = (record?.team || []).filter(engineer => (!zone || !engineer.zone || engineer.zone === zone) && (!skill || (engineer.skills || []).map(String).includes(skill)));
  const needsSkillSelection = mode === 'add' && !skill;
  const slots = [];
  let moved = 0;
  if (mode === 'add' && !needsSkillSelection) {
    const shiftStart = roundedMedianMinute(team.map(engineer => minute(engineer.shiftStart)), 600);
    const shiftEnd = roundedMedianMinute(team.map(engineer => minute(engineer.shiftEnd)), 1320);
    for (let index = 0; index < count; index += 1) slots.push({ start: shiftStart, next: shiftStart, end: shiftEnd, jobs: 0, workMinutes: 0 });
  } else if (mode === 'extend') {
    for (const engineer of team) {
      const baseEnd = minute(engineer.shiftEnd);
      if (baseEnd != null) slots.push({ start: baseEnd, next: baseEnd, end: Math.min(24 * 60, baseEnd + extraMinutes), jobs: 0, workMinutes: 0 });
    }
  } else if (mode === 'move') {
    moved = Math.min(count, backlog.length);
  }
  const allocation = mode === 'move' ? { scheduled: [], skipped: backlog.slice(moved).map(order => ({ order, reason: 'Остаётся в очереди выбранного дня' })) } : needsSkillSelection ? { scheduled: [], skipped: backlog.map(order => ({ order, reason: 'Для новой бригады не выбран навык' })) } : allocateScenarioOrders(backlog, slots);
  const recovered = mode === 'move' ? 0 : allocation.scheduled.length;
  const after = mode === 'move'
    ? { total: summary.total - moved, assigned: summary.assigned, unassigned: summary.unassigned - moved, coverage: rate(summary.assigned, summary.total - moved) }
    : { total: summary.total, assigned: summary.assigned + recovered, unassigned: Math.max(0, summary.unassigned - recovered), coverage: rate(summary.assigned + recovered, summary.total) };
  const shiftLabel = slots.length ? String(Math.floor(Math.min(...slots.map(slot => slot.start)) / 60)).padStart(2, '0') + ':00–' + String(Math.ceil(Math.max(...slots.map(slot => slot.end)) / 60)).padStart(2, '0') + ':00' : 'нет подходящих бригад';
  const details = needsSkillSelection
    ? 'Выберите навык добавляемой бригады: универсальная компетенция в сценарии не предусмотрена.'
    : mode === 'move'
    ? String(moved) + ' заявок будут перенесены на следующую смену и не считаются выполненными.'
    : String(backlog.length) + ' заявок проверены по окнам и длительности; в расписание мощности помещается ' + recovered + '.';
  return {
    status: needsSkillSelection ? 'NEEDS_CREW_SKILL' : 'CAPACITY_SCHEDULED', mode, eligible: backlog.length, recovered, moved, slots: slots.length,
    scheduled: allocation.scheduled, skipped: allocation.skipped, shiftLabel, transitionMinutes: 20,
    details, baseline: { total: summary.total, assigned: summary.assigned, unassigned: summary.unassigned, coverage: summary.coverage },
    after,
    assumptions: needsSkillSelection
      ? 'Без навыка новой бригады нельзя честно определить, какие заявки она сможет взять.'
      : mode === 'move'
      ? 'Перенос меняет очередь этого дня и добавляет работу в следующий день.'
      : 'Учтены навык, территория, окно клиента, длительность работы, часы смены и 20 минут между визитами. Дороги и полный порядок маршрутов проверяет точный планировщик.',
  };
}
