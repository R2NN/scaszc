const asNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const ratio = (value, total) => total > 0 ? Math.round(value / total * 1000) / 10 : null;
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
const zoneOf = order => String(order?.zone || order?.zoneName || order?.zoneId || 'Без зоны').trim();
const skillOf = order => String(order?.skill || order?.requiredSkill || order?.sourceData?.required_skill || 'Навык не указан').trim();
const nextDay = date => new Date(new Date(`${date}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);

/** Recompute one day's results from orders, assignments and observed visits. */
export function summarizeHistoryDay(record) {
  const hasOrders = Array.isArray(record?.orders);
  const hasRoutes = Array.isArray(record?.plan?.routes);
  const hasUnassigned = Array.isArray(record?.plan?.unassigned);
  const orders = Array.isArray(record?.orders) ? record.orders : [];
  const routes = Array.isArray(record?.plan?.routes) ? record.plan.routes : [];
  const assignments = routes.flatMap(route => (route.assignments || []).map(item => ({ ...item, engineerName: route.engineerName || route.engineerId })));
  const orderById = new Map(orders.map(order => [String(order.id), order]));
  const assignedIds = new Set(assignments.map(item => String(item.orderId)));
  const unassigned = (record?.plan?.unassigned || []).map(item => {
    const order = orderById.get(String(item.orderId));
    return { kind: 'unassigned', date: record.date, orderId: item.orderId, name: order?.name || `Заявка ${item.orderId}`, zone: zoneOf(order), skill: skillOf(order), window: order?.end || '', reason: item.reason || item.reasonCode || 'Не назначена' };
  });
  const actualAvailable = Boolean(record?.actual && Array.isArray(record.actual.visits));
  const observed = actualAvailable ? record.actual.visits : [];
  const visitByOrder = new Map(observed.map(visit => [String(visit.orderId), visit]));
  const lateVisits = [];
  const cancelledVisits = [];
  const missingVisits = [];
  const zoneExecution = new Map();
  let completed = 0;
  let onTime = 0;
  let timingObserved = 0;
  let delayTotal = 0;
  for (const assignment of assignments) {
    const order = orderById.get(String(assignment.orderId));
    const visit = visitByOrder.get(String(assignment.orderId));
    if (!actualAvailable) continue;
    const base = { date: record.date, orderId: assignment.orderId, name: order?.name || `Заявка ${assignment.orderId}`, zone: zoneOf(order), skill: skillOf(order), engineerId: assignment.engineerId, engineerName: assignment.engineerName, window: order?.end || '', plannedStart: assignment.plannedStart || '', actualStart: visit?.start || '', reason: visit?.reason || '' };
    if (!visit) {
      missingVisits.push({ ...base, kind: 'missing' });
      continue;
    }
    const zone = zoneExecution.get(base.zone) || { zone: base.zone, observed: 0, incidents: 0, dates: new Set() };
    if (visit.status === 'cancelled') {
      cancelledVisits.push({ ...base, kind: 'cancelled' });
      zone.observed += 1;
      zone.incidents += 1;
    } else if (visit.status === 'completed') {
      completed += 1;
      const windowEnd = minute(order?.end);
      const actualStart = minute(visit.start);
      const timely = typeof visit.onTime === 'boolean' ? visit.onTime : windowEnd != null && actualStart != null ? actualStart <= windowEnd : null;
      if (timely != null) timingObserved += 1;
      if (timely === true) onTime += 1;
      if (timely === false) lateVisits.push({ ...base, kind: 'late' });
      delayTotal += Math.max(0, asNumber(visit.delayMinutes ?? (actualStart != null && minute(assignment.plannedStart) != null ? actualStart - minute(assignment.plannedStart) : 0)));
      if (timely != null) zone.observed += 1;
      if (timely === false) zone.incidents += 1;
    } else {
      missingVisits.push({ ...base, kind: 'missing' });
      continue;
    }
    zone.dates.add(record.date);
    zoneExecution.set(base.zone, zone);
  }
  const total = hasOrders ? orders.length : asNumber(record?.plan?.metrics?.total);
  const assigned = hasRoutes ? assignments.length : asNumber(record?.plan?.metrics?.assigned);
  const distance = hasRoutes
    ? routes.reduce((sum, route) => sum + asNumber(route.distanceKm ?? (route.assignments || []).reduce((routeSum, assignment) => routeSum + asNumber(assignment.distanceM) / 1000, 0)), 0)
    : asNumber(record?.plan?.metrics?.distanceKm);
  const waiting = hasRoutes
    ? routes.reduce((sum, route) => sum + asNumber(route.waitingMinutes ?? (route.assignments || []).reduce((routeSum, assignment) => {
      const arrival = minute(assignment.arrival);
      const plannedStart = minute(assignment.plannedStart);
      return routeSum + (arrival != null && plannedStart != null ? Math.max(0, plannedStart - arrival) : 0);
    }, 0)), 0)
    : asNumber(record?.plan?.metrics?.waitingMinutes);
  return {
    date: record?.date, record, total, assigned, unassigned: hasUnassigned ? unassigned.length : Math.max(0, total - assigned),
    coverage: ratio(assigned, total), teamSize: record?.team?.length || 0,
    activeEngineers: hasRoutes ? routes.filter(route => route.assignments?.length).length : asNumber(record?.plan?.metrics?.activeEngineers),
    distance, distancePerVisit: assigned ? distance / assigned : null,
    waiting, waitingPerVisit: assigned ? waiting / assigned : null,
    actualAvailable, completed, onTime, timingObserved, late: lateVisits.length, cancelled: cancelledVisits.length,
    missing: missingVisits.length, onTimeRate: actualAvailable ? ratio(onTime, timingObserved) : null,
    cancelRate: actualAvailable ? ratio(cancelledVisits.length, completed + cancelledVisits.length) : null,
    averageDelay: completed ? Math.round(delayTotal / completed) : null,
    issues: { unassigned, late: lateVisits, cancelled: cancelledVisits, missing: missingVisits },
    zoneExecution: [...zoneExecution.values()].map(zone => ({ ...zone, dates: zone.dates.size })),
    assignedByZone: assignments.reduce((result, assignment) => {
      const zone = zoneOf(orderById.get(String(assignment.orderId)));
      result.set(zone, (result.get(zone) || 0) + 1);
      return result;
    }, new Map()),
  };
}

/** Calculate an empirical demand range and a rough capacity guide without training an ML model. */
export function forecastNextShift(days) {
  const available = days.filter(day => day.total > 0);
  if (available.length < 5) return null;
  const targetDate = nextDay(available.at(-1).date);
  const targetWeekday = new Date(`${targetDate}T12:00:00Z`).getUTCDay();
  const sameWeekday = available.filter(day => new Date(`${day.date}T12:00:00Z`).getUTCDay() === targetWeekday).slice(-8);
  const usable = sameWeekday.length >= 3 ? sameWeekday : available.slice(-14);
  const demand = usable.map(day => day.total);
  const productiveRates = usable.filter(day => day.teamSize > 0 && day.assigned > 0).map(day => day.assigned / day.teamSize);
  const throughput = median(productiveRates);
  const upper = Math.max(...demand);
  const currentTeam = available.at(-1).teamSize;
  const estimatedTeam = throughput ? Math.ceil(upper / throughput) : null;
  return {
    date: targetDate, count: usable.length, sameWeekday: sameWeekday.length >= 3,
    low: Math.min(...demand), middle: Math.round(median(demand)), high: upper,
    throughput: throughput == null ? null : Math.round(throughput * 10) / 10,
    currentTeam, estimatedTeam,
  };
}

function recurringGaps(days) {
  const groups = new Map();
  for (const day of days) {
    for (const issue of day.issues.unassigned) {
      const key = `${issue.zone}\u0000${issue.skill}`;
      const group = groups.get(key) || { zone: issue.zone, skill: issue.skill, count: 0, dates: new Set(), orders: [] };
      group.count += 1;
      group.dates.add(day.date);
      group.orders.push(issue);
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(group => ({ ...group, days: group.dates.size })).filter(group => group.days >= 2).sort((a, b) => b.days - a.days || b.count - a.count).slice(0, 3);
}

function executionHotspots(days, selected) {
  const zones = new Map();
  for (const day of days) {
    for (const zone of day.zoneExecution) {
      const group = zones.get(zone.zone) || { zone: zone.zone, observed: 0, incidents: 0, days: 0 };
      group.observed += zone.observed;
      group.incidents += zone.incidents;
      group.days += 1;
      zones.set(zone.zone, group);
    }
  }
  return [...zones.values()].filter(zone => zone.observed >= 20 && zone.days >= 3 && zone.incidents > 0).map(zone => ({ ...zone, rate: ratio(zone.incidents, zone.observed), selectedVisits: selected?.assignedByZone.get(zone.zone) || 0 })).sort((a, b) => b.rate - a.rate || b.incidents - a.incidents).slice(0, 3);
}

function detectDeviations(selected, prior) {
  if (!selected || prior.length < 5) return [];
  const candidates = [
    { key: 'total', label: 'Поступило заявок', value: selected.total, unit: 'заявок', minimum: 5 },
    { key: 'coverage', label: 'Покрытие плана', value: selected.coverage, unit: '%', minimum: 2 },
    { key: 'distancePerVisit', label: 'Пробег на заявку', value: selected.distancePerVisit, unit: 'км', minimum: 0.5 },
    { key: 'waitingPerVisit', label: 'Ожидание на заявку', value: selected.waitingPerVisit, unit: 'мин', minimum: 3 },
    ...(selected.actualAvailable ? [
      { key: 'cancelRate', label: 'Доля отмен', value: selected.cancelRate, unit: '%', minimum: 2 },
      { key: 'onTimeRate', label: 'Начаты вовремя', value: selected.onTimeRate, unit: '%', minimum: 2 },
    ] : []),
  ];
  return candidates.flatMap(candidate => {
    if (candidate.value == null) return [];
    const values = prior.map(day => day[candidate.key]).filter(value => value != null);
    if (values.length < 5) return [];
    const lower = Math.min(...values);
    const upper = Math.max(...values);
    const outside = candidate.value < lower ? candidate.value - lower : candidate.value > upper ? candidate.value - upper : 0;
    if (Math.abs(outside) < candidate.minimum) return [];
    return [{ ...candidate, direction: outside > 0 ? 'above' : 'below', previousEdge: outside > 0 ? upper : lower, gap: Math.abs(outside), sample: values.length }];
  }).sort((a, b) => b.gap / Math.max(b.previousEdge, 1) - a.gap / Math.max(a.previousEdge, 1)).slice(0, 3);
}

/** Build period comparisons, recurring gaps and visit drill-down for an arbitrary history feed. */
export function buildHistoryModel(records, selectedDate) {
  const days = (Array.isArray(records) ? records : []).filter(record => record?.date).map(summarizeHistoryDay).sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return { days, selected: null, forecast: null, gaps: [], hotspots: [], deviations: [] };
  const selected = days.find(day => day.date === selectedDate) || days.at(-1);
  const selectedIndex = days.indexOf(selected);
  const prior = days.slice(0, selectedIndex);
  const observed = days.filter(day => day.actualAvailable);
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const assigned = days.reduce((sum, day) => sum + day.assigned, 0);
  const completed = observed.reduce((sum, day) => sum + day.completed, 0);
  const onTime = observed.reduce((sum, day) => sum + day.onTime, 0);
  const timingObserved = observed.reduce((sum, day) => sum + day.timingObserved, 0);
  return {
    days, selected, previous: days[selectedIndex - 1] || null, prior,
    totals: { total, assigned, completed, onTime, timingObserved, coverage: ratio(assigned, total), onTimeRate: ratio(onTime, timingObserved), actualDays: observed.length },
    forecast: forecastNextShift(days),
    gaps: recurringGaps(days.slice(0, selectedIndex + 1)),
    hotspots: executionHotspots(prior, selected),
    deviations: detectDeviations(selected, prior),
  };
}
