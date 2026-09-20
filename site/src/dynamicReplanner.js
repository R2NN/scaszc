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

const TRANSPORT_SPEED = { CAR: 30, PUBLIC_TRANSIT: 18, BICYCLE: 14, WALK: 4.5 };
const TRANSPORT_LABEL = { CAR: 'автомобиле', PUBLIC_TRANSIT: 'общественном транспорте', TRANSIT: 'общественном транспорте', BICYCLE: 'велосипеде', WALK: 'пешком', WALKING: 'пешком' };

const travelLeg = (from, to, transport) => {
  const straightKm = straightDistanceKm(from, to);
  if (straightKm == null) return null;
  const distanceKm = straightKm * 1.25;
  const speed = TRANSPORT_SPEED[String(transport || '').toUpperCase()] || 18;
  return {
    distanceM: Math.round(distanceKm * 1000),
    minutes: distanceKm < 0.05 ? 0 : Math.max(1, Math.ceil(distanceKm / speed * 60)),
    geometry: [from, to],
  };
};

const canServe = (engineer, order) => zoneOf(engineer) === zoneOf(order)
  && (engineer.skills || []).map(skillCode).includes(skillCode(order.skill || order.workType || order.sourceData?.required_skill));

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
    if (plannedFinish > windowEnd || plannedFinish + outbound.minutes > nextStart || plannedFinish > shiftEnd) continue;
    const replacedDistance = next ? Number(next.distanceM) || 0 : 0;
    const distanceDelta = inbound.distanceM + outbound.distanceM - replacedDistance;
    const score = distanceDelta + Math.max(0, plannedStart - windowStart) * 35;
    if (!best || score < best.score) best = { position, previousFinish, arrival, plannedStart, plannedFinish, inbound, outbound, distanceDelta, score };
  }
  return best;
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
  const eventMinute = minutesFromTime(event.time || '00:00');
  const unavailableRoute = baseRouteByEngineer.get(unavailableEngineerId);
  const frozenUnavailableAssignments = (unavailableRoute?.assignments || []).filter(assignment => minutesFromTime(assignment.plannedStart) < eventMinute);
  const futureUnavailableOrderIds = new Set((unavailableRoute?.assignments || []).filter(assignment => minutesFromTime(assignment.plannedStart) >= eventMinute).map(assignment => String(assignment.orderId)));
  const routes = (engineers || []).map(engineer => {
    const baseRoute = baseRouteByEngineer.get(String(engineer.id));
    const baseAssignments = String(engineer.id) === unavailableEngineerId ? frozenUnavailableAssignments : baseRoute?.assignments || [];
    return {
      engineerId: engineer.id,
      engineerName: engineer.name || baseRoute?.engineerName || engineer.id,
      shiftStart: engineer.shiftStart || baseRoute?.shiftStart || '08:00',
      shiftEnd: engineer.shiftEnd || baseRoute?.shiftEnd || '18:00',
      assignments: baseAssignments.filter(assignment => orderById.has(String(assignment.orderId))).map(assignment => ({ ...assignment, ...(String(engineer.id) === unavailableEngineerId ? { frozen: true } : {}) })),
    };
  });
  const assigned = new Set(routes.flatMap(route => route.assignments.map(assignment => String(assignment.orderId))));
  const backlog = (orders || []).filter(order => !assigned.has(String(order.id))).sort((left, right) => Number(isUrgent(right)) - Number(isUrgent(left)) || minutesFromTime(left.end) - minutesFromTime(right.end));
  const unassigned = [];
  const assignmentExplanations = [];

  for (const order of backlog) {
    let best = null;
    const feasibleCandidates = [];
    for (const route of routes) {
      const engineer = engineerById.get(String(route.engineerId));
      if (!engineer || String(engineer.id) === unavailableEngineerId || !canServe(engineer, order)) continue;
      const candidate = insertionCandidate(route, engineer, order, orderById, eventMinute);
      if (candidate) feasibleCandidates.push({ route, engineer, candidate });
      if (candidate && (!best || candidate.score < best.candidate.score)) best = { route, engineer, candidate };
    }
    if (!best) {
      const eligible = (engineers || []).filter(engineer => canServe(engineer, order));
      unassigned.push({
        orderId: order.id,
        reasonCode: eligible.length ? 'NO_FEASIBLE_TIME_WINDOW' : 'NO_ELIGIBLE_ENGINEER_IN_REGION',
        reason: eligible.length
          ? `В регионе «${zoneOf(order)}» нет свободного интервала, который вмещает дорогу и работу до ${order.end}.`
          : `В регионе «${zoneOf(order)}» нет доступной бригады с навыком «${skillCode(order.skill)}».`,
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
    : event.type === 'ORDER_CANCELLED' ? `Заявка снята из черновика с ${event.time}.` : event.type === 'NEW_ORDER' ? `Новая заявка учтена в расчёте с ${event.time}.` : '';
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
