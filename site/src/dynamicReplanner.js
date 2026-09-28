import { transportCode } from './transport.js';

const minutesFromTime = value => {
  const [hours, minutes] = String(value || '00:00').slice(-5).split(':').map(Number);
  return (Number(hours) || 0) * 60 + (Number(minutes) || 0);
};

const timeFromMinutes = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.round(value) % 60).padStart(2, '0')}`;

const zoneOf = item => String(item?.zone || item?.zoneName || item?.zoneId || '').trim();

const skillCode = value => {
  const normalized = String(value || '').toLocaleLowerCase('ru-RU');
  if (/emergency|авар/.test(normalized)) return 'EMERGENCY';
  if (/install|connect|подключ|монтаж/.test(normalized)) return 'INSTALL';
  if (/upsell|дозаказ/.test(normalized)) return 'UPSELL';
  if (/local|локал|ремонт|диагност/.test(normalized)) return 'LOCAL';
  return String(value || '').trim().toUpperCase();
};
const skillLabel = value => ({ EMERGENCY: 'аварийные работы', INSTALL: 'подключение', UPSELL: 'дозаказ', LOCAL: 'локальные работы' })[skillCode(value)] || String(value || 'нужный навык').trim();

const coordinatesOf = item => Array.isArray(item?.coords) && item.coords.length === 2 && item.coords.every(Number.isFinite) ? item.coords : null;

const radians = degrees => degrees * Math.PI / 180;

const straightDistanceKm = (from, to) => {
  if (!from || !to) return null;
  const latitudeDelta = radians(to[0] - from[0]);
  const longitudeDelta = radians(to[1] - from[1]);
  const firstLatitude = radians(from[0]);
  const secondLatitude = radians(to[0]);
  const chord = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord));
};

const TRANSPORT_SPEED = { CAR: 30, PUBLIC_TRANSIT: 18, BICYCLE: 14, WALKING: 4.5 };
const TRANSPORT_LABEL = { CAR: 'автомобиле', PUBLIC_TRANSIT: 'общественном транспорте', TRANSIT: 'общественном транспорте', BICYCLE: 'велосипеде', WALK: 'пешком', WALKING: 'пешком' };

const travelLeg = (from, to, transport) => {
  const straightKm = straightDistanceKm(from, to);
  if (straightKm == null) return null;
  const distanceKm = straightKm * 1.25;
  const speed = TRANSPORT_SPEED[transportCode(transport)];
  if (!speed) return null;
  return {
    distanceM: Math.round(distanceKm * 1000),
    minutes: distanceKm < 0.05 ? 0 : Math.max(1, Math.ceil(distanceKm / speed * 60)),
    geometry: [from, to],
  };
};

const equipmentList = value => (Array.isArray(value) ? value : String(value || '').split(/[;,|]/))
  .map(item => String(item).trim().toLocaleLowerCase('ru-RU'))
  .filter(Boolean);

const staticChecks = (engineer, order) => {
  const requiredSkill = skillCode(order.skill || order.workType || order.sourceData?.required_skill);
  const engineerSkills = (engineer.skills || []).map(skillCode);
  const requiredEquipment = equipmentList(order.equipment);
  const availableEquipment = equipmentList(engineer.equipment);
  return {
    zone: zoneOf(engineer) === zoneOf(order),
    skill: engineerSkills.includes(requiredSkill),
    equipment: requiredEquipment.every(item => availableEquipment.includes(item)),
    available: !/недоступ|снят со смены|отпуск|боле/i.test(engineer.status || ''),
    requiredSkill,
    engineerSkills,
    requiredEquipment,
  };
};

export const canServe = (engineer, order) => {
  const checks = staticChecks(engineer, order);
  return checks.zone && checks.available && checks.skill && checks.equipment;
};

const isUrgent = order => /urgent|emergency|авар|срочн/i.test(`${order?.priority || ''} ${order?.skill || ''}`);

const routeDistance = assignments => assignments.reduce((sum, assignment) => sum + (Number(assignment.distanceM) || 0), 0);

function insertionCandidate(route, engineer, order, orderById, notBefore = 0) {
  const orderCoords = coordinatesOf(order);
  if (!orderCoords) return null;
  const assignments = route.assignments || [];
  const shiftStart = minutesFromTime(engineer.shiftStart || route.shiftStart || '08:00');
  const shiftEnd = minutesFromTime(engineer.shiftEnd || route.shiftEnd || '18:00');
  const windowStart = minutesFromTime(order.start);
  const windowEnd = minutesFromTime(order.end);
  const serviceMinutes = Math.max(1, Number(order.duration) || 60);
  let best = null;
  for (let position = 0; position <= assignments.length; position += 1) {
    const previous = position ? assignments[position - 1] : null;
    const next = assignments[position] || null;
    const previousOrder = previous ? orderById.get(String(previous.orderId)) : null;
    const nextOrder = next ? orderById.get(String(next.orderId)) : null;
    const from = coordinatesOf(previousOrder) || coordinatesOf({ coords: engineer.startCoords });
    const to = coordinatesOf(nextOrder);
    const inbound = travelLeg(from, orderCoords, engineer.transport);
    const outbound = next ? travelLeg(orderCoords, to, engineer.transport) : { distanceM: 0, minutes: 0, geometry: [] };
    if (!inbound || (next && !outbound)) continue;
    const previousFinish = Math.max(previous ? minutesFromTime(previous.plannedFinish) : shiftStart, notBefore);
    const nextStart = next ? minutesFromTime(next.plannedStart) : shiftEnd;
    const arrival = previousFinish + inbound.minutes;
    const plannedStart = Math.max(arrival, windowStart);
    const plannedFinish = plannedStart + serviceMinutes;
    if (plannedStart > windowEnd || plannedFinish + outbound.minutes > nextStart || plannedFinish > shiftEnd) continue;
    const replacedDistance = next ? Number(next.distanceM) || 0 : 0;
    const distanceDelta = inbound.distanceM + outbound.distanceM - replacedDistance;
    const score = distanceDelta + Math.max(0, plannedStart - windowStart) * 35;
    if (!best || score < best.score) best = { position, previousFinish, arrival, plannedStart, plannedFinish, inbound, outbound, distanceDelta, score };
  }
  return best;
}

// Explains an omitted order without pretending that the sealed plan contains an
// exact infeasibility certificate. Travel in this check is an estimate only.
export function diagnoseOrderCandidates(order, engineers = [], orders = [], plan = null) {
  if (!order) return [];
  const orderById = new Map(orders.map(item => [String(item.id), item]));
  const routes = new Map((plan?.routes || []).map(route => [String(route.engineerId), route]));
  return engineers.map(engineer => {
    const name = engineer.name || String(engineer.id);
    const route = routes.get(String(engineer.id)) || { assignments: [], shiftStart: engineer.shiftStart, shiftEnd: engineer.shiftEnd };
    const checks = staticChecks(engineer, order);
    const orderCoords = coordinatesOf(order);
    const startCoords = coordinatesOf({ coords: engineer.startCoords });
    const shiftStart = minutesFromTime(engineer.shiftStart || route.shiftStart || '08:00');
    const shiftEnd = minutesFromTime(engineer.shiftEnd || route.shiftEnd || '18:00');
    const windowStart = minutesFromTime(order.start);
    const windowEnd = minutesFromTime(order.end);
    const serviceMinutes = Math.max(1, Number(order.duration) || 60);
    const windowValid = Boolean(order.start && order.end) && windowEnd >= Math.max(windowStart, shiftStart) && Math.max(windowStart, shiftStart) + serviceMinutes <= shiftEnd;
    const directLeg = orderCoords && startCoords ? travelLeg(startCoords, orderCoords, engineer.transport) : null;
    const candidate = checks.zone && checks.skill && checks.equipment && checks.available && windowValid && orderCoords && startCoords
      ? insertionCandidate(route, engineer, order, orderById)
      : null;
    const checkList = [
      { key: 'skill', label: 'Навык', ok: checks.skill, detail: checks.skill ? `есть «${checks.requiredSkill}»` : `нет «${checks.requiredSkill}»` },
      { key: 'zone', label: 'Зона', ok: checks.zone, detail: checks.zone ? `«${zoneOf(order)}»` : `бригада: «${zoneOf(engineer) || 'не указана'}»` },
      { key: 'window', label: 'Окно', ok: windowValid, detail: windowValid ? `${order.start}–${order.end} пересекается со сменой` : `не помещается в смену ${engineer.shiftStart || route.shiftStart || '08:00'}–${engineer.shiftEnd || route.shiftEnd || '18:00'}` },
      { key: 'travel', label: 'Дорога', ok: Boolean(directLeg), detail: directLeg ? `оценка от базы ${directLeg.minutes} мин · ${Math.round(directLeg.distanceM / 100) / 10} км` : 'нет подтверждённых координат или транспорта' },
      { key: 'busy', label: 'Занятость', ok: Boolean(candidate), detail: candidate ? `есть место около ${timeFromMinutes(candidate.plannedStart)}` : route.assignments?.length ? 'текущий маршрут не вмещает визит' : 'свободная смена не прошла остальные проверки' },
    ];
    if (!checks.equipment) checkList.push({ key: 'equipment', label: 'Оснащение', ok: false, detail: `не хватает: ${checks.requiredEquipment.join(', ')}` });
    if (!checks.available) checkList.push({ key: 'availability', label: 'Доступность', ok: false, detail: engineer.status || 'бригада не на смене' });
    const state = !checks.zone ? 'zone'
      : !checks.available ? 'unavailable'
        : !checks.skill || !checks.equipment ? 'skill'
          : !orderCoords || !startCoords || !directLeg ? 'coordinates'
            : !windowValid ? 'window'
              : candidate ? 'estimated' : 'busy';
    const label = state === 'estimated'
      ? `Предварительно подходит: старт около ${timeFromMinutes(candidate.plannedStart)}`
      : state === 'zone' ? 'Не подходит по зоне'
        : state === 'unavailable' ? 'Бригада недоступна'
          : state === 'skill' ? 'Не пройдены навык или оснащение'
            : state === 'coordinates' ? 'Нельзя оценить дорогу'
              : state === 'window' ? 'Окно не помещается в смену'
                : 'Маршрут занят в допустимое время';
    return { id: engineer.id, name, state, label, checks: checkList, candidate };
  });
}

/**
 * Replans changed orders against the published schedule using dynamic feasible insertion.
 * Regional boundaries, skills, client windows and engineer shifts are hard constraints.
 */
export function buildDynamicReplan(orders, engineers, basePlan, event = {}) {
  if (!basePlan?.routes) throw new Error('Нет опубликованного плана для пересчёта.');
  const orderById = new Map((orders || []).map(order => [String(order.id), order]));
  const engineerById = new Map((engineers || []).map(engineer => [String(engineer.id), engineer]));
  const baseRouteByEngineer = new Map((basePlan.routes || []).map(route => [String(route.engineerId), route]));
  const unavailableEngineerId = event.type === 'ENGINEER_UNAVAILABLE' ? String(event.engineerId || '') : '';
  const rescheduledEngineerId = ['SHIFT_BOUNDARY_CHANGED', 'SHIFT_EXTENDED'].includes(event.type) ? String(event.engineerId || '') : '';
  const requestedRescheduleId = ['CLIENT_WINDOW_SHIFT', 'ORDER_UPDATED', 'VISIT_CANCELLED', 'MANUAL_ASSIGN'].includes(event.type) ? String(event.orderId || '') : '';
  const existingVisit = (basePlan.routes || []).flatMap(route => route.assignments || []).find(item => String(item.orderId) === requestedRescheduleId);
  const changedOrder = orderById.get(requestedRescheduleId);
  const unchangedVisitFitsWindow = event.type === 'CLIENT_WINDOW_SHIFT' && existingVisit && changedOrder &&
    minutesFromTime(changedOrder.start) <= minutesFromTime(existingVisit.plannedStart) &&
    minutesFromTime(existingVisit.plannedStart) <= minutesFromTime(changedOrder.end);
  const rescheduledOrderId = unchangedVisitFitsWindow ? '' : requestedRescheduleId;
  const eventMinute = minutesFromTime(event.time || '00:00');
  const unavailableRoute = baseRouteByEngineer.get(unavailableEngineerId);
  const frozenUnavailableAssignments = (unavailableRoute?.assignments || []).filter(assignment => minutesFromTime(assignment.plannedStart) < eventMinute);
  const futureUnavailableOrderIds = new Set((unavailableRoute?.assignments || []).filter(assignment => minutesFromTime(assignment.plannedStart) >= eventMinute).map(assignment => String(assignment.orderId)));
  const routes = (engineers || []).map(engineer => {
    const baseRoute = baseRouteByEngineer.get(String(engineer.id));
    const sourceAssignments = baseRoute?.assignments || [];
    const changedShiftStart = minutesFromTime(engineer.shiftStart || baseRoute?.shiftStart || '08:00');
    const changedShiftEnd = minutesFromTime(engineer.shiftEnd || baseRoute?.shiftEnd || '18:00');
    const baseAssignments = String(engineer.id) === unavailableEngineerId
      ? frozenUnavailableAssignments
      : String(engineer.id) === rescheduledEngineerId
        ? sourceAssignments.filter(assignment => {
          const departure = minutesFromTime(assignment.departureAt || assignment.arrival || assignment.plannedStart);
          const finish = minutesFromTime(assignment.plannedFinish || assignment.plannedStart);
          return departure >= changedShiftStart && finish <= changedShiftEnd;
        })
        : sourceAssignments.filter(assignment => String(assignment.orderId) !== rescheduledOrderId);
    return {
      engineerId: engineer.id,
      engineerName: engineer.name || baseRoute?.engineerName || engineer.id,
      shiftStart: engineer.shiftStart || baseRoute?.shiftStart || '08:00',
      shiftEnd: engineer.shiftEnd || baseRoute?.shiftEnd || '18:00',
      assignments: baseAssignments.filter(assignment => orderById.has(String(assignment.orderId))).map(assignment => ({ ...assignment, ...(String(engineer.id) === unavailableEngineerId ? { frozen: true } : {}) })),
    };
  });
  const assigned = new Set(routes.flatMap(route => route.assignments.map(assignment => String(assignment.orderId))));
  const previouslyUnassigned = new Map((basePlan.unassigned || []).map(item => [String(item.orderId), item]));
  const reconsiderAll = event.type === 'CAPACITY_ADDED' || event.type === 'INITIAL_PLAN';
  const reconsiderId = String(event.orderId || event.order?.id || '');
  const backlog = (orders || []).filter(order => {
    const id = String(order.id);
    if (assigned.has(id) || (event.type === 'VISIT_CANCELLED' && id === reconsiderId)) return false;
    if (event.deferAffectedAssignments && event.type === 'ENGINEER_UNAVAILABLE' && futureUnavailableOrderIds.has(id)) return false;
    return reconsiderAll || !previouslyUnassigned.has(id) || id === reconsiderId;
  }).sort((left, right) => Number(isUrgent(right)) - Number(isUrgent(left)) || minutesFromTime(left.end) - minutesFromTime(right.end));
  if (event.type === 'MANUAL_ASSIGN') {
    const selectedIndex = backlog.findIndex(order => String(order.id) === String(event.orderId));
    if (selectedIndex < 0) throw new Error('Выбранная заявка отсутствует в очереди пересчёта.');
    const [selected] = backlog.splice(selectedIndex, 1);
    backlog.unshift(selected);
    if (!engineerById.has(String(event.engineerId))) throw new Error('Выбранной бригады больше нет в смене.');
  }
  const unassigned = (orders || []).filter(order => {
    const id = String(order.id);
    return !assigned.has(id) && previouslyUnassigned.has(id) && !backlog.some(item => String(item.id) === id) && !(event.type === 'VISIT_CANCELLED' && id === reconsiderId);
  }).map(order => previouslyUnassigned.get(String(order.id)));
  if (event.deferAffectedAssignments && event.type === 'ENGINEER_UNAVAILABLE') {
    for (const orderId of futureUnavailableOrderIds) {
      if (!unassigned.some(item => String(item.orderId) === orderId)) unassigned.push({ orderId, reasonCode: 'ENGINEER_UNAVAILABLE', reason: 'Бригада снята со смены; заявка ожидает нового назначения.' });
    }
  }
  const assignmentExplanations = [];
  const insertionNotBefore = ['NEW_ORDER', 'ENGINEER_UNAVAILABLE', 'CAPACITY_ADDED', 'VISIT_CANCELLED', 'MANUAL_ASSIGN', 'SHIFT_BOUNDARY_CHANGED', 'SHIFT_EXTENDED', 'CLIENT_WINDOW_SHIFT'].includes(event.type) ? eventMinute : 0;

  for (const order of backlog) {
    let best = null;
    const feasibleCandidates = [];
    for (const route of routes) {
      const engineer = engineerById.get(String(route.engineerId));
      if (!engineer || String(engineer.id) === unavailableEngineerId || !canServe(engineer, order)) continue;
      if (event.type === 'MANUAL_ASSIGN' && String(order.id) === String(event.orderId) && String(engineer.id) !== String(event.engineerId)) continue;
      const candidate = insertionCandidate(route, engineer, order, orderById, insertionNotBefore);
      if (candidate) feasibleCandidates.push({ route, engineer, candidate });
      if (candidate && (!best || candidate.score < best.candidate.score)) best = { route, engineer, candidate };
    }
    if (!best) {
      if (event.type === 'MANUAL_ASSIGN' && String(order.id) === String(event.orderId)) throw new Error('Заявка не помещается в маршрут выбранной бригады с учётом навыка, зоны, дороги, окна и смены. Опубликованный план не изменён.');
      const eligible = (engineers || []).filter(engineer => canServe(engineer, order));
      unassigned.push({
        orderId: order.id,
        reasonCode: eligible.length ? 'NO_FEASIBLE_TIME_WINDOW' : 'NO_ELIGIBLE_ENGINEER_IN_REGION',
        reason: eligible.length
          ? `В регионе «${zoneOf(order)}» нет свободного интервала, который вмещает дорогу и работу до ${order.end}.`
          : `В регионе «${zoneOf(order)}» нет доступной бригады с навыком «${skillLabel(order.skill)}».`,
      });
      continue;
    }
    const { route, engineer, candidate } = best;
    const newAssignment = {
      orderId: order.id,
      engineerId: route.engineerId,
      position: candidate.position + 1,
      departureAt: timeFromMinutes(candidate.previousFinish),
      arrival: timeFromMinutes(candidate.arrival),
      arrivalAt: timeFromMinutes(candidate.arrival),
      plannedStart: timeFromMinutes(candidate.plannedStart),
      plannedFinish: timeFromMinutes(candidate.plannedFinish),
      travelMinutes: candidate.inbound.minutes,
      distanceM: candidate.inbound.distanceM,
      geometry: candidate.inbound.geometry,
      claimLevel: 'VALIDATED_OPERATIONAL_ESTIMATE',
    };
    route.assignments.splice(candidate.position, 0, newAssignment);
    const next = route.assignments[candidate.position + 1];
    if (next) {
      next.departureAt = timeFromMinutes(candidate.plannedFinish);
      next.arrival = timeFromMinutes(candidate.plannedFinish + candidate.outbound.minutes);
      next.arrivalAt = next.arrival;
      next.travelMinutes = candidate.outbound.minutes;
      next.distanceM = candidate.outbound.distanceM;
      next.geometry = candidate.outbound.geometry;
    }
    route.assignments.forEach((assignment, index) => { assignment.position = index + 1; });
    const scheduleBuffer = next
      ? Math.max(0, minutesFromTime(next.plannedStart) - candidate.plannedFinish - candidate.outbound.minutes)
      : Math.max(0, minutesFromTime(engineer.shiftEnd || route.shiftEnd || '18:00') - candidate.plannedFinish);
    assignmentExplanations.push({
      orderId: order.id,
      engineerId: engineer.id,
      engineerName: engineer.name || route.engineerName || engineer.id,
      zone: zoneOf(order),
      requiredSkill: skillCode(order.skill || order.workType || order.sourceData?.required_skill),
      engineerSkills: (engineer.skills || []).map(skillCode),
      transport: String(engineer.transport || '').toUpperCase(),
      transportLabel: TRANSPORT_LABEL[String(engineer.transport || '').toUpperCase()] || 'доступном транспорте',
      travelMinutes: candidate.inbound.minutes,
      distanceKm: Math.round(candidate.inbound.distanceM / 100) / 10,
      plannedStart: timeFromMinutes(candidate.plannedStart),
      plannedFinish: timeFromMinutes(candidate.plannedFinish),
      windowStart: order.start,
      windowEnd: order.end,
      serviceMinutes: Math.max(1, Number(order.duration) || 60),
      scheduleBuffer,
      nextVisitStart: next?.plannedStart || null,
      feasibleCandidateCount: feasibleCandidates.length,
      comparedEngineerCount: (engineers || []).filter(item => String(item.id) !== unavailableEngineerId && zoneOf(item) === zoneOf(order)).length,
      selectionRule: 'MIN_ROUTE_DEVIATION',
    });
  }
  if (event.type === 'VISIT_CANCELLED' && orderById.has(String(event.orderId))) {
    unassigned.push({ orderId: event.orderId, reasonCode: 'VISIT_CANCELLED', reason: 'Визит отменён; заявка остаётся в очереди для нового согласования.' });
  }

  const activeRoutes = routes.filter(route => route.assignments.length).map(route => ({
    ...route,
    workloadMinutes: route.assignments.reduce((sum, assignment) => sum + (Number(assignment.travelMinutes) || 0) + (Number(orderById.get(String(assignment.orderId))?.duration) || 0), 0),
    travelMinutes: route.assignments.reduce((sum, assignment) => sum + (Number(assignment.travelMinutes) || 0), 0),
    distanceKm: Math.round(routeDistance(route.assignments) / 100) / 10,
  }));
  const assignedCount = activeRoutes.reduce((sum, route) => sum + route.assignments.length, 0);
  const activeEngineerCount = activeRoutes.filter(route => String(route.engineerId) !== unavailableEngineerId).length;
  const reassignedFutureCount = [...futureUnavailableOrderIds].filter(orderId => activeRoutes.some(route => String(route.engineerId) !== unavailableEngineerId && route.assignments.some(assignment => String(assignment.orderId) === orderId))).length;
  const eventSummary = event.type === 'ENGINEER_UNAVAILABLE'
    ? `До ${event.time} сохранено ${frozenUnavailableAssignments.length} ${frozenUnavailableAssignments.length === 1 ? 'начатый визит' : 'начатых визита'}; перераспределено ${reassignedFutureCount} из ${futureUnavailableOrderIds.size} будущих.`
    : event.type === 'ORDER_CANCELLED' ? `Заявка снята из черновика с ${event.time}.`
      : event.type === 'NEW_ORDER' ? `Новая заявка учтена в расчёте с ${event.time}.`
        : event.type === 'CLIENT_WINDOW_SHIFT' ? 'Согласованное с клиентом окно учтено в новом маршруте.'
          : event.type === 'SHIFT_BOUNDARY_CHANGED' ? 'Границы смены изменены только после повторной проверки маршрутов.'
            : event.type === 'MANUAL_ASSIGN' ? 'Выбранная заявка вставлена в маршрут указанной бригады после проверки ограничений.' : '';
  return {
    id: `dynamic-replan-${Date.now()}`,
    algorithm: 'dynamic-feasible-insertion-v1',
    provider: 'HAVERSINE_OPERATIONAL_ESTIMATE',
    status: 'VALID_REPLAN',
    publicationAllowed: true,
    validation: { status: 'VALID', constraints: ['REGION', 'SKILL', 'WINDOW', 'SHIFT'] },
    event: { ...event, summary: eventSummary, frozenVisits: frozenUnavailableAssignments.length, futureVisits: futureUnavailableOrderIds.size, reassignedFutureVisits: reassignedFutureCount },
    assignmentExplanations,
    routes: activeRoutes,
    unassigned,
    metrics: {
      total: (orders || []).length,
      assigned: assignedCount,
      unassigned: unassigned.length,
      activeEngineers: activeEngineerCount,
      distanceKm: Math.round(activeRoutes.reduce((sum, route) => sum + route.distanceKm, 0) * 10) / 10,
      travelMinutes: activeRoutes.reduce((sum, route) => sum + route.travelMinutes, 0),
    },
  };
}
