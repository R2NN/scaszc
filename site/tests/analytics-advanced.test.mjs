import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { analyzeResourceGaps, analyzeShiftEfficiency, analyzeTeamCapacity, buildShiftRecommendations, calculateEconomics, compareAreas, compareWeeks, detectAreaAnomalies, detectPeriodAreaAnomalies, evaluateGoals, explainWeekChange, findOperationalGaps, findWindowReserves, forecastSegments, generatePeriodInsights, listCompleteWeeks, planReliability, recommendCapacityGap, routePlanFact, simulateCapacity, simulateCapacitySchedule } from '../src/analyticsAdvanced.js';
import { calculateBaseline } from '../src/baselinePlanning.js';

const days = JSON.parse(await readFile(new URL('../public/data/analytics-history.json', import.meta.url), 'utf8')).days;
const selected = days.at(-1);

test('weekly comparison uses two full, non-overlapping calendar weeks', () => {
  const result = compareWeeks(days, selected.date);
  assert.equal(result.current.start, '2026-08-10');
  assert.equal(result.current.end, '2026-08-16');
  assert.equal(result.previous.start, '2026-08-03');
  assert.equal(result.current.days.length, 7);
  assert.equal(result.current.assigned + result.current.unassigned, result.current.demand);
  assert.equal(compareWeeks(days.slice(-10), selected.date), null);
  const weeks = listCompleteWeeks(days);
  assert.ok(weeks.length >= 4);
  assert.ok(weeks.every(week => week.days.length === 7 && week.assigned + week.unassigned === week.demand));
});

test('area summaries reconcile with demand and support a separate region dimension', () => {
  const zones = compareAreas(days);
  assert.equal(zones.reduce((sum, zone) => sum + zone.demand, 0), days.reduce((sum, day) => sum + day.orders.length, 0));
  assert.equal(zones.reduce((sum, zone) => sum + zone.assigned, 0), days.reduce((sum, day) => sum + day.plan.metrics.assigned, 0));
  const regions = compareAreas(days, 'region');
  assert.equal(regions.length, 1);
  assert.equal(regions[0].name, 'Москва');
});

test('segmented forecast uses previous occurrences of the target weekday', () => {
  const result = forecastSegments(days);
  assert.equal(result.date, '2026-08-18');
  assert.equal(result.samples, 8);
  assert.ok(result.comparableDates.every(date => new Date(`${date}T12:00:00Z`).getUTCDay() === 2));
  assert.ok(result.zones.length > 0 && result.skills.length > 0 && result.timeBands.length > 0);
  assert.equal(forecastSegments(days.slice(-14)), null);
});

test('route plan and fact preserve observed arrival/start/finish and do not invent current-day fact', () => {
  const historical = routePlanFact(days.at(-2));
  assert.equal(historical.flatMap(route => route.stops).length, days.at(-2).plan.metrics.assigned);
  assert.ok(historical.flatMap(route => route.stops).some(stop => stop.actual?.arrival && stop.actual?.start && stop.actual?.finish));
  assert.ok(routePlanFact(selected).every(route => route.stops.every(stop => stop.status === 'no_fact' && stop.actual === null)));
});

test('plan reliability is generated from the real planned start and client window', () => {
  const stop = (start, windowStart, windowEnd) => ({ planned: { start }, windowStart, windowEnd });
  assert.deepEqual(planReliability(stop('10:56', '10:00', '12:00')), { tone: 'good', slackMinutes: 64, slackLabel: '1 ч 04 мин', label: 'Запас 1 ч 04 мин (Надёжно)' });
  assert.deepEqual(planReliability(stop('11:56', '10:00', '12:00')), { tone: 'attention', slackMinutes: 4, slackLabel: '4 мин', label: 'Критический риск: старт за 4 мин до конца окна' });
  assert.deepEqual(planReliability(stop('18:00', '18:00', '20:00')), { tone: 'good', slackMinutes: 120, slackLabel: '2 ч', label: 'Идеальный старт (к началу окна)' });
  assert.equal(planReliability(stop('12:05', '10:00', '12:00')).tone, 'attention');
});

test('economics uses complete default tariffs while goals preserve missing fact', () => {
  const result = calculateEconomics(selected);
  assert.equal(result.factAvailable, false);
  assert.equal(result.complete, true);
  assert.ok(result.directCost > 0);
  assert.ok(result.costPerAssigned > 0);
  assert.equal(result.fleetMetrics.length, 4);
  assert.ok(result.fleetMetrics.every(item => Number.isFinite(item.costPerVisit)));
  const goals = evaluateGoals(selected, { coverage: 100, onTime: 95, cancelRate: 3, unassigned: 0 });
  assert.equal(goals.find(goal => goal.key === 'coverage').status, 'met');
  assert.equal(goals.find(goal => goal.key === 'onTime').status, 'unknown');
});

test('transport economics uses mode-specific tariffs and reconciles with direct cost', () => {
  const rates = { perHour: 900, carKm: 16, transitShift: 320, bicycleShift: 80, walkingShift: 0 };
  const result = calculateEconomics(selected, rates);
  const byMode = Object.fromEntries(result.transportBreakdown.map(item => [item.key, item]));
  assert.equal(result.transportBreakdown.reduce((sum, item) => sum + item.routes, 0), selected.plan.routes.filter(route => route.assignments.length).length);
  const carKm = selected.plan.routes.filter(route => selected.team.find(member => member.id === route.engineerId)?.transport === 'CAR' && route.assignments.length).reduce((sum, route) => sum + route.distanceKm, 0);
  assert.equal(byMode.car.amount, carKm * rates.carKm);
  assert.equal(byMode.transit.amount, byMode.transit.routes * rates.transitShift);
  assert.equal(byMode.bicycle.amount, byMode.bicycle.routes * rates.bicycleShift);
  assert.equal(byMode.walking.amount, 0);
  assert.equal(result.directCost, result.components.find(item => item.key === 'transport').amount + result.components.find(item => item.key === 'labor').amount);
  const noTariffs = calculateEconomics(selected, {});
  assert.ok(noTariffs.directCost > 0);
  const unknownTransport = structuredClone(selected);
  const activeId = unknownTransport.plan.routes.find(route => route.assignments.length).engineerId;
  unknownTransport.team.find(member => member.id === activeId).transport = 'UNSPECIFIED';
  assert.ok(calculateEconomics(unknownTransport, rates).directCost > 0);
  const sameAsBaseline = calculateEconomics(selected, rates, { available: true, routes: selected.plan.routes });
  assert.equal(sameAsBaseline.savingPerShift, 0);
  assert.equal(calculateEconomics(selected, rates).savingPerShift, null);
});

test('published FCFS uses the same paid-route policy in the shift cost comparison', () => {
  const baseline = calculateBaseline(selected.orders, selected.team, selected.plan.baseline);
  const result = calculateEconomics(selected, {}, baseline);
  assert.equal(result.baselineAvailable, true);
  assert.equal(result.baselineAssignedCount, 104);
  assert.equal(result.baselineEngineersUsed, 35);
  assert.ok(result.baselineDirectCost > result.directCost);
  assert.ok(result.baselineCostPerAssigned > result.costPerAssigned);
});

test('efficiency evidence is computed from routes and prioritised by reviewable minutes', () => {
  const result = analyzeShiftEfficiency(selected);
  assert.equal(result.routes.length, selected.plan.routes.filter(route => route.assignments.length).length);
  assert.equal(result.recoverableMinutes, result.excessWaitingMinutes + result.excessTravelMinutes);
  assert.ok(result.opportunities.every((item, index) => index === 0 || result.opportunities[index - 1].minutes >= item.minutes));
  assert.ok(result.routes.every((item, index) => index === 0 || result.routes[index - 1].recoverableMinutes >= item.recoverableMinutes));
  assert.ok(result.potentialExtraVisits <= selected.plan.metrics.unassigned);
});

test('scenario outputs are labelled estimates and never exceed eligible backlog', () => {
  const zone = selected.orders.find(order => selected.plan.unassigned.some(item => item.orderId === order.id))?.zone;
  const added = simulateCapacity(selected, days, { mode: 'add', zone, count: 2 });
  assert.equal(added.status, 'ESTIMATE_ONLY');
  assert.ok(added.maximumRecovered <= added.eligible);
  assert.equal(added.bestCase.assigned, added.baseline.assigned + added.maximumRecovered);
  const moved = simulateCapacity(selected, days, { mode: 'move', zone, count: 2 });
  assert.equal(moved.bestCase.assigned, moved.baseline.assigned);
  assert.equal(moved.bestCase.total, moved.baseline.total - moved.moved);
});

test('capacity scenario schedules only work that fits selected skill, client windows and shift time', () => {
  const record = {
    orders: [
      { id: 'first', zone: 'A', skill: 'INSTALL', start: '09:00', end: '10:00', duration: 30 },
      { id: 'second', zone: 'A', skill: 'INSTALL', start: '09:00', end: '10:00', duration: 30 },
      { id: 'other-skill', zone: 'A', skill: 'LOCAL', start: '09:00', end: '10:00', duration: 30 },
    ],
    team: [{ id: 'crew', zone: 'A', skills: ['INSTALL'], shiftStart: '08:00', shiftEnd: '12:00' }],
    plan: { routes: [], unassigned: [{ orderId: 'first' }, { orderId: 'second' }, { orderId: 'other-skill' }] },
  };
  const added = simulateCapacitySchedule(record, { mode: 'add', zone: 'A', skill: 'INSTALL', count: 1 });
  assert.equal(added.status, 'CAPACITY_SCHEDULED');
  assert.equal(added.eligible, 2);
  assert.equal(added.recovered, 2);
  assert.equal(added.after.assigned, 2);
  assert.ok(added.scheduled.every(item => item.start <= 600 && item.finish <= 720));
  const moved = simulateCapacitySchedule(record, { mode: 'move', zone: 'A', skill: 'INSTALL', count: 1 });
  assert.equal(moved.moved, 1);
  assert.equal(moved.after.total, 2);
});

test('capacity recommendation names the largest concrete territory and skill gap', () => {
  const record = {
    orders: [
      { id: 'one', zone: 'Север', skill: 'INSTALL', duration: 30 },
      { id: 'two', zone: 'Север', skill: 'INSTALL', duration: 45 },
      { id: 'three', zone: 'Юг', skill: 'LOCAL', duration: 90 },
    ],
    plan: { unassigned: [{ orderId: 'one' }, { orderId: 'two' }, { orderId: 'three' }] },
  };
  assert.deepEqual(recommendCapacityGap(record), { zone: 'Север', skill: 'INSTALL', count: 2, workMinutes: 75 });
});

test('window reserves are derived from a planned arrival and start, not made up from shift slack', () => {
  const record = {
    orders: [{ id: 'later', name: 'Поздний визит', zone: 'Запад', skill: 'INSTALL' }],
    plan: { routes: [{ engineerId: 'crew-1', engineerName: 'Бригада 1', assignments: [{ orderId: 'later', arrival: '13:10', plannedStart: '14:00', plannedFinish: '14:40' }] }] },
  };
  assert.deepEqual(findWindowReserves(record), [{
    key: 'crew-1:later:0', engineerId: 'crew-1', engineerName: 'Бригада 1', orderId: 'later', orderName: 'Поздний визит', zone: 'Запад', skill: 'INSTALL', arrival: 790, plannedStart: 840, plannedFinish: 880, minutes: 50,
  }]);
});

test('operational gaps offer a matching queued job before suggesting a shift change', () => {
  const record = {
    orders: [
      { id: 'first', name: 'Первый визит', zone: 'Север', skill: 'INSTALL', start: '09:00', end: '10:00', duration: 30 },
      { id: 'next', name: 'Следующий визит', zone: 'Север', skill: 'INSTALL', start: '12:20', end: '13:00', duration: 30 },
      { id: 'queued', name: 'Заявка из очереди', zone: 'Север', skill: 'INSTALL', start: '10:30', end: '11:45', duration: 30 },
    ],
    team: [{ id: 'crew', name: 'Бригада', zone: 'Север', skills: ['INSTALL'], shiftStart: '08:00', shiftEnd: '18:00' }],
    plan: { routes: [{ engineerId: 'crew', engineerName: 'Бригада', shiftStart: '08:00', shiftEnd: '18:00', assignments: [
      { orderId: 'first', position: 1, departureAt: '08:30', arrival: '08:40', plannedStart: '09:00', plannedFinish: '10:00', travelMinutes: 10 },
      { orderId: 'next', position: 2, departureAt: '12:00', arrival: '12:10', plannedStart: '12:20', plannedFinish: '12:50', travelMinutes: 10 },
    ] }], unassigned: [{ orderId: 'queued' }] },
  };
  const gap = findOperationalGaps(record).find(item => item.type === 'between');
  assert.equal(gap.minutes, 120);
  assert.equal(gap.candidate.orderId, 'queued');
  assert.equal(gap.candidate.start, 630);
  assert.equal(gap.proposal.kind, 'insert');
});

test('crew recommendations keep preparation and wrap-up while removing unused shift time', () => {
  const record = {
    team: [{ id: 'crew', name: 'Бригада', shiftStart: '08:00', shiftEnd: '18:00' }],
    plan: { routes: [{ engineerId: 'crew', engineerName: 'Бригада', shiftStart: '08:00', shiftEnd: '18:00', assignments: [
      { position: 1, departureAt: '10:00', plannedFinish: '15:30' },
    ] }] },
  };
  assert.deepEqual(buildShiftRecommendations(record), [{
    engineerId: 'crew', engineerName: 'Бригада', assignments: 1, shiftStart: 480, shiftEnd: 1080,
    recommendedStart: 585, recommendedEnd: 945, startSaved: 105, endSaved: 135,
  }]);
});

test('a long gap before the next visit suggests calling the client for an earlier start', () => {
  const record = {
    orders: [
      { id: 'first', name: 'Первый визит', zone: 'Север', skill: 'INSTALL' },
      { id: 'next', name: 'Следующий визит', zone: 'Север', skill: 'INSTALL' },
    ],
    team: [{ id: 'crew', name: 'Бригада', skills: ['INSTALL'], shiftStart: '08:00', shiftEnd: '18:00' }],
    plan: { routes: [{ engineerId: 'crew', engineerName: 'Бригада', shiftStart: '08:00', shiftEnd: '18:00', assignments: [
      { orderId: 'first', position: 1, departureAt: '08:30', plannedFinish: '10:00', travelMinutes: 10 },
      { orderId: 'next', position: 2, departureAt: '12:45', plannedStart: '13:00', plannedFinish: '13:30', travelMinutes: 15 },
    ] }], unassigned: [] },
  };
  const gap = findOperationalGaps(record).find(item => item.type === 'between');
  assert.equal(gap.customerCall.proposedStart, 615);
  assert.equal(gap.customerCall.proposedDeparture, 600);
  assert.equal(gap.customerCall.originalDeparture, 765);
  assert.equal(gap.customerCall.savedMinutes, 165);
  assert.equal(gap.proposal.kind, 'call_customer');
});

test('early-visit proposal keeps departure, arrival and saved idle internally consistent', () => {
  const record = {
    orders: [
      { id: 'first', name: 'Первый визит', zone: 'Югоцентр', skill: 'LOCAL' },
      { id: 'next', sourceId: 'SOUTHCENTER-30243', name: 'Следующий визит', zone: 'Югоцентр', skill: 'LOCAL', address: 'Город Москва, ул.Нижегородская, д. 14', clientName: 'Анна', phone: '+7 900 000-00-00', start: '20:00', end: '22:00', duration: 40 },
    ],
    team: [{ id: 'crew', name: 'Сакур Тимофей', skills: ['LOCAL'], shiftStart: '10:00', shiftEnd: '22:00' }],
    plan: { routes: [{ engineerId: 'crew', engineerName: 'Сакур Тимофей', shiftStart: '10:00', shiftEnd: '22:00', assignments: [
      { orderId: 'first', position: 1, departureAt: '17:50', plannedFinish: '18:30', travelMinutes: 10 },
      { orderId: 'next', position: 2, departureAt: '19:32', plannedStart: '20:00', plannedFinish: '20:40', travelMinutes: 13, distanceM: 3200 },
    ] }], unassigned: [] },
  };
  const gap = findOperationalGaps(record).find(item => item.type === 'between');
  assert.equal(gap.minutes, 62);
  assert.equal(gap.customerCall.proposedDeparture, 1110);
  assert.equal(gap.customerCall.arrivalAt, 1123);
  assert.equal(gap.customerCall.proposedStart, 1125);
  assert.equal(gap.customerCall.savedMinutes, 62);
  assert.equal(gap.nextOrderSourceId, 'SOUTHCENTER-30243');
  assert.equal(gap.nextOrderAddress, 'Город Москва, ул.Нижегородская, д. 14');
  assert.equal(gap.nextClientName, 'Анна');
  assert.equal(gap.nextClientPhone, '+7 900 000-00-00');
  assert.equal(gap.travelDistanceKm, 3.2);
  assert.equal(gap.nextOrderDuration, 40);
  assert.match(gap.proposal.impact, /начать в 18:45.*выедет в 18:30/);
});

test('area anomalies compare the selected territory with matching weekdays', () => {
  const result = detectAreaAnomalies(days, '2026-03-14');
  assert.ok(result.some(item => item.zone === 'Юго-восток' && item.metric === 'Очередь'));
  assert.ok(result.every(item => item.dates >= 3 && item.value > item.previousMax));
  assert.deepEqual(detectAreaAnomalies(days.slice(-14), selected.date), []);
});

test('period narratives are generated from the actual queue, skills and territories', () => {
  const insights = generatePeriodInsights(days);
  const systemic = insights.find(item => item.key === 'systemic-gap');
  assert.ok(systemic);
  const issues = days.flatMap(day => day.plan.unassigned || []);
  assert.equal(systemic.evidence.totalUnassigned, issues.length);
  assert.ok(systemic.title.includes(systemic.evidence.dominant.zone));
  assert.ok(systemic.detail.includes(String(systemic.evidence.dominant.count)));

  const altered = structuredClone(days.slice(-7));
  altered.forEach(day => { day.plan.unassigned = []; });
  const noGap = generatePeriodInsights(altered);
  assert.equal(noGap.length, 1);
  assert.equal(noGap[0].key, 'coverage');
  assert.equal(noGap[0].evidence.unassigned, 0);
});

test('week explanation points to real peak days and the dominant current constraint', () => {
  const comparison = compareWeeks(days, '2026-08-17');
  const changed = structuredClone(comparison.current);
  changed.days.at(-1).issues.unassigned.push({ date: changed.days.at(-1).date, zone: 'Тестовая зона', skill: 'LOCAL' });
  changed.days.at(-1).unassigned += 1;
  changed.unassigned = comparison.previous.unassigned + 5;
  changed.coverage = comparison.previous.coverage - 1;
  const explanation = explainWeekChange(changed, comparison.previous);
  assert.equal(explanation.tone, 'attention');
  assert.ok(explanation.evidence.peakDays.length > 0);
  assert.ok(explanation.detail.includes(explanation.evidence.dominant.zone));
});

test('period anomaly search keeps the strongest data-backed event per territory metric', () => {
  const anomalies = detectPeriodAreaAnomalies(days, days[0].date, days.at(-1).date);
  assert.ok(anomalies.length > 0);
  assert.ok(anomalies.every(item => item.date >= days[0].date && item.date <= days.at(-1).date));
  assert.equal(new Set(anomalies.map(item => `${item.zone}:${item.metric}`)).size, anomalies.length);
});

test('resource explanation uses the real window, zone, skill and idle-team capability', () => {
  const unresolvedDay = days.findLast(day => day.plan.unassigned.length);
  const result = analyzeResourceGaps(unresolvedDay);
  assert.equal(result.idleCount, unresolvedDay.team.length - unresolvedDay.plan.routes.length);
  assert.ok(result.idleWithNeededSkill >= 0);
  const unresolvedOrder = unresolvedDay.orders.find(order => unresolvedDay.plan.unassigned.some(item => item.orderId === order.id));
  assert.ok(result.causes.length > 0);
  assert.ok(result.causes.some(cause => cause.action.includes(String(unresolvedOrder.duration))));
  assert.equal(result.causes.reduce((sum, cause) => sum + cause.count, 0), unresolvedDay.plan.unassigned.length);
});

test('team capacity includes idle crews and explains only facts supported by the plan inputs', () => {
  const result = analyzeTeamCapacity(selected);
  const idle = result.stats.filter(item => !item.hasRoute);
  const active = result.stats.filter(item => item.hasRoute);
  assert.equal(result.stats.length, selected.team.length);
  assert.equal(idle.length, selected.team.length - selected.plan.routes.length);
  assert.ok(idle.every(item => item.utilization === 0));
  assert.ok(idle.every(item => item.explanation.includes('Возможность аварийного выезда требует проверки')));
  assert.equal(result.lowestActive.engineerId, active.sort((a, b) => a.utilization - b.utilization)[0].engineerId);
  assert.equal(result.averageLoad, Math.round(result.stats.reduce((sum, item) => sum + item.utilization, 0) / result.stats.length));
  assert.equal(result.missingReasonCount, 0);
});

test('team capacity does not invent a tie-break reason absent from planner output', () => {
  const record = {
    orders: [{ id: 'one', zone: 'A', skill: 'INSTALL', start: '10:00', end: '12:00', duration: 60 }],
    team: [{ id: 'free', name: 'Свободная бригада', zone: 'A', skills: ['INSTALL'], shiftStart: '09:00', shiftEnd: '18:00' }],
    plan: { routes: [], unassigned: [{ orderId: 'one', reasonCode: 'ENGINEER_UNAVAILABLE' }] },
  };
  const result = analyzeTeamCapacity(record);
  assert.equal(result.missingReasonCount, 1);
  assert.match(result.stats[0].explanation, /не передано планировщиком/);
});

test('team capacity treats ANY as unrestricted and reports an exact mode mismatch', () => {
  const record = {
    orders: [{ id: 'one', zone: 'A', skill: 'INSTALL', transport: 'ANY', start: '10:00', end: '12:00', duration: 60 }],
    team: [{ id: 'free', zone: 'A', skills: ['INSTALL'], transport: 'CAR', shiftStart: '09:00', shiftEnd: '18:00' }],
    plan: { routes: [], unassigned: [{ orderId: 'one' }] },
  };
  assert.doesNotMatch(analyzeTeamCapacity(record).stats[0].explanation, /не подходит транспорт/);
  record.orders[0].transport = 'BICYCLE';
  assert.match(analyzeTeamCapacity(record).stats[0].explanation, /не подходит транспорт/);
  record.team[0].transport = 'BICYCLE';
  assert.doesNotMatch(analyzeTeamCapacity(record).stats[0].explanation, /не подходит транспорт/);
});
