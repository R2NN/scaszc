// Shared, deterministic rules for operational events and the day playback.
export const EVENT_TYPES = Object.freeze({
  RECALCULATE: 'RECALCULATE',
  NEW_ORDER: 'NEW_ORDER',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  VISIT_CANCELLED: 'VISIT_CANCELLED',
  ENGINEER_UNAVAILABLE: 'ENGINEER_UNAVAILABLE',
  ENGINEER_REPLACED: 'ENGINEER_REPLACED',
  CAPACITY_ADDED: 'CAPACITY_ADDED',
  MANUAL_ASSIGN: 'MANUAL_ASSIGN',
  SHIFT_BOUNDARY_CHANGED: 'SHIFT_BOUNDARY_CHANGED',
  SHIFT_EXTENDED: 'SHIFT_EXTENDED',
  CLIENT_WINDOW_SHIFT: 'CLIENT_WINDOW_SHIFT',
});

export const minuteOf = value => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
};

export const timeOf = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;

export function normalizeDataAdditionEvent(shift, event) {
  const newOrder = event?.type === EVENT_TYPES.NEW_ORDER && event.order?.id;
  const newCrew = event?.type === EVENT_TYPES.CAPACITY_ADDED && event.engineer?.id;
  if (!newOrder && !newCrew) return event;
  const manualOrder = newOrder && event.order.status === 'Черновик';
  const latest = minuteOf(shift?.versions?.at(-1)?.effectiveAt) ?? 0;
  const shiftStart = newCrew ? minuteOf(event.engineer.shiftStart) ?? 0 : 0;
  const time = timeOf(Math.max(latest, manualOrder ? 420 : shiftStart, minuteOf(event.time) ?? 0));
  const automaticReason = newOrder ? `Заявка добавлена вручную: ${event.order.name || event.order.id}` : `Бригада включена в смену: ${event.engineer.name || event.engineer.id}`;
  const reason = manualOrder ? automaticReason : String(event.reason || '').trim() || automaticReason;
  return { ...event, time, reason };
}

export function eventModel(shift, event) {
  if (!shift?.plan?.routes) throw new Error('Сначала опубликуйте исходный план.');
  if (!Object.values(EVENT_TYPES).includes(event?.type)) throw new Error('Неизвестный тип события.');
  if (minuteOf(event.time) == null) throw new Error('Укажите время события в формате ЧЧ:ММ.');
  if (!String(event.reason || '').trim()) throw new Error('Укажите причину изменения.');
  const orders = shift.orders || [];
  const team = shift.team || [];
  const order = orders.find(item => String(item.id) === String(event.orderId));
  const engineer = team.find(item => String(item.id) === String(event.engineerId));
  const completed = new Set((shift.facts || []).filter(item => item.status === 'completed').map(item => String(item.orderId)));
  let nextOrders = orders;
  let nextTeam = team;
  let planningEvent = { ...event };
  if (event.type === EVENT_TYPES.RECALCULATE) {
    if (event.time < '07:00') throw new Error('Пересчёт до начала смены начинается с 07:00.');
  } else if ([EVENT_TYPES.ORDER_CANCELLED, EVENT_TYPES.VISIT_CANCELLED].includes(event.type)) {
    if (!order) throw new Error('Заявка не найдена.');
    if (completed.has(String(order.id))) throw new Error('Выполненную заявку нельзя отменить.');
    if ((shift.facts || []).some(item => String(item.orderId) === String(order.id) && item.status === 'started')) throw new Error('Начатый визит нельзя отменить без фактической отметки о невыполнении.');
    if (event.type === EVENT_TYPES.ORDER_CANCELLED) nextOrders = orders.filter(item => String(item.id) !== String(order.id));
  } else if (event.type === EVENT_TYPES.NEW_ORDER) {
    if (!event.order?.id || orders.some(item => String(item.id) === String(event.order.id))) throw new Error('Новой заявке нужен уникальный ID.');
    if (!Array.isArray(event.order.coords) || event.order.coords.length !== 2 || !event.order.coords.every(Number.isFinite)) throw new Error('Для новой заявки нужна подтверждённая точка.');
    nextOrders = [...orders, event.order.status === 'Черновик' ? { ...event.order, status: 'Ожидается' } : event.order];
    planningEvent = { ...event, orderId: event.order.id };
  } else if (event.type === EVENT_TYPES.ENGINEER_UNAVAILABLE) {
    if (!engineer) throw new Error('Бригада не найдена.');
    nextTeam = team.map(item => String(item.id) === String(engineer.id) ? { ...item, status: 'Недоступен', unavailableFrom: event.time } : item);
  } else if (event.type === EVENT_TYPES.ENGINEER_REPLACED) {
    if (!engineer || !event.replacement?.id || team.some(item => String(item.id) === String(event.replacement.id))) throw new Error('Укажите недоступную бригаду и новую бригаду с уникальным ID.');
    nextTeam = [...team.map(item => String(item.id) === String(engineer.id) ? { ...item, status: 'Недоступен', unavailableFrom: event.time } : item), { ...event.replacement, status: 'Доступен' }];
    planningEvent = { ...event, type: EVENT_TYPES.ENGINEER_UNAVAILABLE };
  } else if (event.type === EVENT_TYPES.CAPACITY_ADDED) {
    if (event.engineer?.id) {
      if (team.some(item => String(item.id) === String(event.engineer.id))) throw new Error('Новой бригаде нужен уникальный ID.');
      nextTeam = [...team, { ...event.engineer, status: 'Доступен' }];
    } else if (engineer && /недоступ/i.test(engineer.status || '')) {
      nextTeam = team.map(item => String(item.id) === String(engineer.id) ? { ...item, status: 'Доступен', unavailableFrom: null } : item);
    } else throw new Error('Укажите новую или возвращаемую бригаду.');
  } else if (event.type === EVENT_TYPES.MANUAL_ASSIGN) {
    if (!order || !engineer) throw new Error('Укажите заявку и бригаду для назначения.');
    const assigned = shift.plan.routes.flatMap(route => (route.assignments || []).map(item => ({ route, item }))).find(entry => String(entry.item.orderId) === String(order.id));
    if (assigned && (minuteOf(assigned.item.plannedStart) ?? 0) < (minuteOf(event.time) ?? 0)) throw new Error('Начатую или прошедшую заявку нельзя переназначить задним числом.');
    if (assigned && String(assigned.route.engineerId) === String(engineer.id)) throw new Error('Заявка уже назначена этой бригаде.');
  } else if ([EVENT_TYPES.SHIFT_BOUNDARY_CHANGED, EVENT_TYPES.SHIFT_EXTENDED].includes(event.type)) {
    if (!engineer || (event.shiftStart && minuteOf(event.shiftStart) == null) || minuteOf(event.shiftEnd) == null) throw new Error('Укажите бригаду и корректные границы смены.');
    nextTeam = team.map(item => String(item.id) === String(engineer.id) ? { ...item, shiftStart: event.shiftStart || item.shiftStart, shiftEnd: event.shiftEnd } : item);
  } else if (event.type === EVENT_TYPES.CLIENT_WINDOW_SHIFT) {
    if (!order || minuteOf(event.start) == null || (event.end && minuteOf(event.end) == null)) throw new Error('Укажите заявку и новое клиентское окно.');
    if ((minuteOf(event.end || order.end) ?? -1) <= minuteOf(event.start)) throw new Error('Конец клиентского окна должен быть позже начала.');
    nextOrders = orders.map(item => String(item.id) === String(order.id) ? { ...item, start: event.start, end: event.end || item.end } : item);
  }
  return { orders: nextOrders, team: nextTeam, event: planningEvent };
}

const ALLOWED_FACT = {
  started: new Set(['completed', 'not_completed']),
  completed: new Set(),
  not_completed: new Set(),
};

export function nextFact(previous, update, { correction = false } = {}) {
  if (!update?.orderId || !['started', 'completed', 'not_completed'].includes(update.status)) throw new Error('Неверный статус визита.');
  if (minuteOf(update.time) == null) throw new Error('Укажите время фактической отметки.');
  if (update.status === 'not_completed' && !String(update.reason || '').trim()) throw new Error('Укажите причину невыполнения.');
  if (!previous && update.status === 'completed' && !correction) throw new Error('Сначала отметьте начало работы, затем завершение.');
  if (previous && !correction && (minuteOf(update.time) ?? 0) < (minuteOf(previous.time) ?? 0)) throw new Error('Время новой отметки не может быть раньше предыдущей.');
  if (previous && !correction && !ALLOWED_FACT[previous.status]?.has(update.status)) throw new Error('Для изменения уже отмеченного статуса используйте исправление с причиной.');
  if (correction && !String(update.correctionReason || '').trim()) throw new Error('Укажите причину исправления.');
  return { ...update, source: 'dispatcher' };
}

function along(points, fraction) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const lengths = points.slice(1).map((point, index) => Math.hypot((point[0] - points[index][0]) * 111, (point[1] - points[index][1]) * 64));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (!total) return points[0];
  let remaining = Math.max(0, Math.min(1, fraction)) * total;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const ratio = lengths[index] ? remaining / lengths[index] : 0;
      return points[index].map((value, axis) => value + (points[index + 1][axis] - value) * ratio);
    }
    remaining -= lengths[index];
  }
  return points.at(-1);
}

function splitGeometry(points, fraction) {
  const lengths = points.slice(1).map((point, index) => Math.hypot((point[0] - points[index][0]) * 111, (point[1] - points[index][1]) * 64));
  let remaining = Math.max(0, Math.min(1, fraction)) * lengths.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const ratio = lengths[index] ? Math.min(1, remaining / lengths[index]) : 0;
      const cut = points[index].map((value, axis) => value + (points[index + 1][axis] - value) * ratio);
      return [
        [...points.slice(0, index + 1), cut],
        [cut, ...points.slice(index + 1)],
      ];
    }
    remaining -= lengths[index];
  }
  return [points, [points.at(-1)]];
}

export function playbackFrame(shift, atMinute, mode = 'plan') {
  const facts = new Map((shift?.factLog || shift?.facts || []).filter(item => (minuteOf(item.time) ?? 1440) <= atMinute).map(item => [String(item.orderId), item]));
  const orders = new Map((shift?.orders || []).map(item => [String(item.id), item]));
  const team = new Map((shift?.team || []).map(item => [String(item.id), item]));
  const routes = shift?.plan?.routes || [];
  const routeIds = new Set(routes.map(route => String(route.engineerId)));
  const crewRoutes = [...routes, ...[...team.values()].filter(engineer => !routeIds.has(String(engineer.id))).map(engineer => ({ engineerId: engineer.id, shiftStart: engineer.shiftStart, shiftEnd: engineer.shiftEnd, assignments: [] }))];
  const crews = crewRoutes.map(route => {
    const engineer = team.get(String(route.engineerId));
    if (mode === 'fact') {
      const confirmed = (route.assignments || []).map(item => ({ item, fact: facts.get(String(item.orderId)) })).filter(entry => entry.fact).sort((a, b) => (minuteOf(a.fact.time) ?? 0) - (minuteOf(b.fact.time) ?? 0)).at(-1);
      const coords = confirmed ? orders.get(String(confirmed.item.orderId))?.coords : null;
      return { engineerId: route.engineerId, orderId: confirmed?.item.orderId || null, status: confirmed?.fact.status || 'no_fact', coords: Array.isArray(coords) ? coords : null, positionKnown: Array.isArray(coords), source: confirmed ? 'dispatcher_fact' : 'unknown' };
    }
    const start = minuteOf(engineer?.shiftStart || route.shiftStart) ?? 0;
    const end = minuteOf(engineer?.shiftEnd || route.shiftEnd) ?? 1440;
    if (atMinute < start || atMinute >= end) return { engineerId: route.engineerId, status: 'off_shift', coords: null };
    if (engineer?.unavailableFrom && atMinute >= minuteOf(engineer.unavailableFrom)) return { engineerId: route.engineerId, status: 'unavailable', coords: null };
    let coords = engineer?.startCoords || null;
    let status = 'idle';
    let orderId = null;
    for (const assignment of route.assignments || []) {
      const order = orders.get(String(assignment.orderId));
      const departure = minuteOf(assignment.departureAt) ?? start;
      const arrival = minuteOf(assignment.arrivalAt || assignment.arrival) ?? departure;
      const workStart = minuteOf(assignment.plannedStart) ?? arrival;
      const finish = minuteOf(assignment.plannedFinish) ?? workStart;
      if (atMinute < departure) break;
      if (atMinute < arrival) {
        const geometry = assignment.geometry;
        return { engineerId: route.engineerId, orderId: assignment.orderId, status: 'travelling', coords: along(geometry, (atMinute - departure) / Math.max(1, arrival - departure)), positionKnown: Array.isArray(geometry) && geometry.length > 1 };
      }
      coords = order?.coords || coords;
      orderId = assignment.orderId;
      if (atMinute < workStart) { status = 'waiting'; break; }
      if (atMinute < finish) { status = 'working'; break; }
      status = 'idle';
    }
    return { engineerId: route.engineerId, orderId, status, coords, positionKnown: Boolean(coords) };
  });
  const visits = routes.flatMap(route => (route.assignments || []).map(assignment => {
    const fact = facts.get(String(assignment.orderId));
    const departure = minuteOf(assignment.departureAt) ?? minuteOf(assignment.arrivalAt || assignment.arrival) ?? 0;
    const arrival = minuteOf(assignment.arrivalAt || assignment.arrival) ?? departure;
    const start = minuteOf(assignment.plannedStart) ?? 0;
    const finish = minuteOf(assignment.plannedFinish) ?? start;
    const status = mode === 'fact'
      ? fact?.status || 'no_fact'
      : atMinute < departure ? 'planned' : atMinute < arrival ? 'travelling' : atMinute < start ? 'waiting' : atMinute < finish ? 'working' : 'simulated_completed';
    return { orderId: assignment.orderId, engineerId: route.engineerId, status, arrival: assignment.arrivalAt || assignment.arrival, start: assignment.plannedStart, finish: assignment.plannedFinish };
  }));
  const orderStatuses = [...visits];
  const assigned = new Set(visits.map(item => String(item.orderId)));
  for (const order of shift?.orders || []) {
    if (assigned.has(String(order.id))) continue;
    const event = [...(shift?.events || [])].reverse().find(item => String(item.orderId) === String(order.id) && (minuteOf(item.time) ?? 1440) <= atMinute && item.type === EVENT_TYPES.VISIT_CANCELLED);
    orderStatuses.push({ orderId: order.id, engineerId: null, status: event ? 'visit_cancelled' : 'unassigned' });
  }
  return { crews, visits, orderStatuses };
}

// Planned playback is never proof of completion. Only the latest dispatcher
// fact at the selected time may turn a visit green on the operational map.
export function completedFactOrderIds(shift, atMinute) {
  const latest = new Map();
  for (const fact of shift?.factLog || shift?.facts || []) {
    if ((minuteOf(fact.time) ?? 1440) <= atMinute) latest.set(String(fact.orderId), fact.status);
  }
  return [...latest].filter(([, status]) => status === 'completed').map(([orderId]) => orderId);
}

export const visitStatusLabel = (status, mode = 'plan') => ({
  planned: 'Ожидается', travelling: 'Бригада в пути', waiting: 'Ожидает начала', working: 'На объекте',
  simulated_completed: 'По плану завершена', started: 'Начата', completed: 'Выполнена',
  not_completed: 'Не выполнена', no_fact: mode === 'fact' ? 'Нет отметки' : 'Ожидается',
  unassigned: 'В очереди', visit_cancelled: 'Визит отменён', order_cancelled: 'Заявка отменена',
})[status] || 'Статус неизвестен';

export function crewOperationalSummary(shift, frame, engineerId, atMinute, mode = 'plan') {
  const route = shift?.plan?.routes?.find(item => String(item.engineerId) === String(engineerId));
  if (!route) return null;
  const crew = frame?.crews?.find(item => String(item.engineerId) === String(engineerId));
  const assignments = route.assignments || [];
  const current = assignments.find(item => (minuteOf(item.departureAt) ?? minuteOf(item.arrivalAt || item.arrival) ?? 0) <= atMinute && atMinute < (minuteOf(item.plannedFinish) ?? 0));
  const next = assignments.find(item => (minuteOf(item.departureAt) ?? minuteOf(item.plannedStart) ?? 0) > atMinute);
  const currentOrder = shift?.orders?.find(item => String(item.id) === String(current?.orderId));
  const nextOrder = shift?.orders?.find(item => String(item.id) === String(next?.orderId));
  const phaseStart = crew?.status === 'travelling' ? minuteOf(current?.departureAt) : crew?.status === 'working' ? minuteOf(current?.plannedStart) : null;
  const phaseMinutes = mode === 'plan' && phaseStart != null ? Math.max(0, atMinute - phaseStart) : null;
  const upcomingOrder = crew?.status === 'travelling' ? currentOrder : nextOrder;
  const upcoming = crew?.status === 'travelling' ? current : next;
  return { route, crew, current, currentOrder, next, nextOrder, upcoming, upcomingOrder, phaseMinutes };
}

export function playbackRouteSegments(route, atMinute) {
  const travelled = [], remaining = [];
  for (const assignment of route?.assignments || []) {
    const geometry = (assignment.geometry || []).filter(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
    if (geometry.length < 2) continue;
    const departure = minuteOf(assignment.departureAt) ?? minuteOf(assignment.arrivalAt || assignment.arrival) ?? 0;
    const arrival = minuteOf(assignment.arrivalAt || assignment.arrival) ?? departure;
    const fraction = atMinute <= departure ? 0 : atMinute >= arrival ? 1 : (atMinute - departure) / Math.max(1, arrival - departure);
    if (fraction === 0) remaining.push(geometry);
    else if (fraction === 1) travelled.push(geometry);
    else {
      const [completedGeometry, upcomingGeometry] = splitGeometry(geometry, fraction);
      travelled.push(completedGeometry);
      remaining.push(upcomingGeometry);
    }
  }
  return { travelled, remaining };
}

// Playback reads an immutable version; moving the scrubber never recalculates a plan.
const versionAt = (shift, atMinute) => (shift?.versions || []).filter(item => (minuteOf(item.effectiveAt) ?? 0) <= atMinute)
  .sort((a, b) => (minuteOf(a.effectiveAt) ?? 0) - (minuteOf(b.effectiveAt) ?? 0) || a.version - b.version).at(-1) || shift?.versions?.[0];

export function shiftAt(shift, atMinute) {
  if (!shift) return null;
  const version = versionAt(shift, atMinute);
  return version ? { ...shift, orders: version.orders, team: version.team, plan: version.plan } : shift;
}

// The roster of the selected day is not the same thing as the plan version
// active at a playback minute. A newly entered crew or request stays visible
// as idle/unassigned before its first published route takes effect.
const displayPointCache = new WeakMap();
export function shiftDisplayAt(shift, atMinute) {
  if (!shift) return null;
  const version = versionAt(shift, atMinute);
  let cached = displayPointCache.get(shift);
  if (!cached) { cached = new Map(); displayPointCache.set(shift, cached); }
  if (cached.has(version)) return cached.get(version);
  const point = version ? { ...shift, orders: version.orders, team: version.team, plan: version.plan } : shift;
  const includeCurrent = (historical, current) => {
    const ids = new Set((historical || []).map(item => String(item.id)));
    return [...(historical || []), ...(current || []).filter(item => !ids.has(String(item.id)))];
  };
  const display = { ...point, orders: includeCurrent(point.orders, shift.orders), team: includeCurrent(point.team, shift.team) };
  cached.set(version, display);
  return display;
}
