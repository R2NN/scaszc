import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { calculateBaseline } from '../src/baselinePlanning.js';
import { calculateEconomics, buildShiftRecommendations, findOperationalGaps, analyzeTeamCapacity } from '../src/analyticsAdvanced.js';
import { shiftReportData } from './shiftReport.mjs';

const minute = value => /^\d{1,2}:\d{2}$/.test(String(value || '')) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
const duration = (a, b) => minute(a) == null || minute(b) == null ? 0 : Math.max(0, minute(b) - minute(a));
const label = value => String(value ?? '').trim() || 'Не указан';
const sourceId = order => label(order?.sourceId || String(order?.id || '').split(':').at(-1));
const key = order => String(order?.zone || order?.zoneName || 'Не указано');
let cachedHistory;

export function reportHistoryDays() {
  if (cachedHistory === undefined) {
    try { cachedHistory = JSON.parse(readFileSync(resolve('public/data/analytics-history.json'), 'utf8')).days || []; }
    catch { cachedHistory = []; }
  }
  return cachedHistory;
}

export function buildDispatcherReportModel(shift, { history = reportHistoryDays(), origin = '', generatedAt = new Date().toISOString(), author = 'Диспетчер' } = {}) {
  if (!shift?.plan) throw new Error('Для отчёта нужен сохранённый план смены.');
  const summary = shiftReportData(shift);
  const orders = new Map((shift.orders || []).map(order => [String(order.id), order]));
  const routes = (shift.plan.routes || []).filter(route => route.assignments?.length);
  const assigned = routes.flatMap(route => route.assignments.map((assignment, index) => ({ assignment, order: orders.get(String(assignment.orderId)), route, index })));
  const facts = new Map((shift.facts || []).map(fact => [String(fact.orderId), fact]));
  const finalCount = assigned.filter(item => ['completed', 'not_completed'].includes(facts.get(String(item.assignment.orderId))?.status)).length;
  const mode = finalCount === 0 && !(shift.factLog || []).length ? 'plan' : finalCount === assigned.length ? 'full' : 'partial';
  const lastFact = (shift.factLog || []).at(-1);
  const unresolved = (shift.plan.unassigned || []).map(item => ({ item, order: orders.get(String(item.orderId)) })).filter(entry => entry.order);
  const critical = unresolved[0] || null;
  const zones = [...new Set((shift.orders || []).map(key))].map(name => ({ name, count: assigned.filter(item => key(item.order) === name).length })).sort((a, b) => b.count - a.count);
  const risks = assigned.map(({ assignment, order, route, index }) => {
    const slack = minute(order?.end) == null || minute(assignment.plannedStart) == null ? null : minute(order.end) - minute(assignment.plannedStart);
    const prev = route.assignments[index - 1];
    return { order, assignment, route, slack, previous: prev ? orders.get(String(prev.orderId)) : null,
      level: slack == null ? 'Данных нет' : slack <= 0 ? 'Критично' : slack <= 5 ? 'Высокий' : 'Контроль' };
  }).filter(item => item.slack != null).sort((a, b) => a.slack - b.slack).slice(0, 5);
  const allMinutes = (shift.team || []).reduce((sum, crew) => sum + duration(crew.shiftStart, crew.shiftEnd), 0);
  const workMinutes = assigned.reduce((sum, item) => sum + (duration(item.assignment.plannedStart, item.assignment.plannedFinish) || Number(item.order?.duration) || 0), 0);
  const travelMinutes = assigned.reduce((sum, item) => sum + (Number(item.assignment.travelMinutes) || 0), 0);
  const waitMinutes = Number(shift.plan.metrics?.waitingMinutes) || 0;
  const reserveMinutes = Math.max(0, allMinutes - workMinutes - travelMinutes - waitMinutes);
  const busyMinutes = workMinutes + travelMinutes;
  const capacity = analyzeTeamCapacity(shift);
  const idle = capacity.stats.filter(item => !item.hasRoute);
  const shiftRecommendations = buildShiftRecommendations(shift);
  const reducibleMinutes = shiftRecommendations.reduce((sum, item) => sum + item.startSaved + item.endSaved, 0);
  const gaps = findOperationalGaps(shift);
  const baseline = calculateBaseline(shift.orders, shift.team);
  const economics = calculateEconomics(shift, {}, baseline);
  const prior = (history || []).filter(day => day.date <= shift.date).sort((a, b) => a.date.localeCompare(b.date));
  const before = prior.filter(day => day.date < shift.date);
  const lastSeven = prior.slice(-7).map(day => ({ date: day.date, assigned: day.plan?.metrics?.assigned ?? day.plan?.routes?.flatMap(route => route.assignments || []).length ?? 0, total: day.orders?.length || 0, queue: day.plan?.unassigned?.length || 0 }));
  const coverage = days => {
    const valid = days.filter(day => day.orders?.length && Number.isFinite(Number(day.plan?.metrics?.assigned)));
    return valid.length ? valid.reduce((sum, day) => sum + Number(day.plan.metrics.assigned) / day.orders.length * 100, 0) / valid.length : null;
  };
  const historicalUnassigned = before.flatMap(day => (day.plan?.unassigned || []).map(item => ({ item, order: day.orders?.find(order => String(order.id) === String(item.orderId)) })));
  const recurring = historicalUnassigned.filter(({ order }) => key(order) === 'Юго-восток' && /подключ|install/i.test(String(order?.skill || order?.workType || '')));
  const recurringDays = new Set(before.filter(day => (day.plan?.unassigned || []).some(item => { const order = day.orders?.find(order => String(order.id) === String(item.orderId)); return key(order) === 'Юго-восток' && /подключ|install/i.test(String(order?.skill || order?.workType || '')); })).map(day => day.date));
  const hourCounts = new Map();
  assigned.forEach(({ assignment }) => { const hour = assignment.plannedStart?.slice(0, 2); if (hour) hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1); });
  const peaks = [...hourCounts].sort((a, b) => b[1] - a[1]).slice(0, 2);
  const longRoutes = [...routes].sort((a, b) => (Number(b.distanceKm) || 0) - (Number(a.distanceKm) || 0)).slice(0, 4).map(route => {
    const crew = shift.team.find(item => String(item.id) === String(route.engineerId));
    const stops = route.assignments.map(item => orders.get(String(item.orderId))).filter(Boolean);
    return { route, crew, windows: [...new Set(stops.map(item => `${item.start}-${item.end}`))].slice(0, 2), skills: [...new Set(stops.map(item => item.skill).filter(Boolean))].slice(0, 2), zones: [...new Set(stops.map(key))].slice(0, 2) };
  });
  const url = critical && origin ? `${origin.replace(/\/$/, '')}/?region=${encodeURIComponent(shift.regionId)}&date=${encodeURIComponent(shift.date)}&order=${encodeURIComponent(critical.order.id)}` : '';
  return { shift, summary, mode, lastFact, finalCount, author, generatedAt, critical, url, zones, risks, idle, capacity,
    time: { allMinutes, workMinutes, travelMinutes, waitMinutes, reserveMinutes, busyMinutes },
    shiftRecommendations, reducibleMinutes, gaps, baseline, economics, lastSeven, coverageWeek: coverage(prior.slice(-7)), coverageAll: coverage(prior), historyCount: prior.length,
    historicalUnassigned: historicalUnassigned.length + unresolved.length, recurringCount: recurring.length, recurringDays: recurringDays.size,
    hourCounts: [...hourCounts].sort((a, b) => a[0].localeCompare(b[0])), peaks, longRoutes };
}
