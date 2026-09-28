import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDynamicReplan, diagnoseOrderCandidates } from '../src/dynamicReplanner.js';

const engineers = [
  { id: 'east-1', name: 'Бригада 1', zone: 'Восток', skills: ['INSTALL'], shiftStart: '08:00', shiftEnd: '18:00', transport: 'CAR', startCoords: [55.75, 37.62] },
  { id: 'east-2', name: 'Бригада 3', zone: 'Восток', skills: ['INSTALL'], shiftStart: '08:00', shiftEnd: '18:00', transport: 'CAR', startCoords: [55.76, 37.63] },
  { id: 'south-1', name: 'Бригада 2', zone: 'Югоцентр', skills: ['INSTALL', 'EMERGENCY'], shiftStart: '08:00', shiftEnd: '18:00', transport: 'CAR', startCoords: [55.7, 37.6] },
];

const baseOrders = [
  { id: 'a', zone: 'Восток', skill: 'INSTALL', start: '09:00', end: '11:00', duration: 60, coords: [55.76, 37.63] },
  { id: 'b', zone: 'Восток', skill: 'INSTALL', start: '14:00', end: '17:00', duration: 60, coords: [55.78, 37.65] },
];

const basePlan = {
  routes: [{
    engineerId: 'east-1', engineerName: 'Бригада 1', shiftStart: '08:00', shiftEnd: '18:00', assignments: [
      { orderId: 'a', engineerId: 'east-1', plannedStart: '09:00', plannedFinish: '10:00', travelMinutes: 8, distanceM: 2000 },
      { orderId: 'b', engineerId: 'east-1', plannedStart: '14:00', plannedFinish: '15:00', travelMinutes: 12, distanceM: 3000 },
    ],
  }],
  unassigned: [],
};

test('dynamic replanning inserts a real request into a feasible regional gap', () => {
  const urgent = { id: 'urgent', zone: 'Восток', skill: 'INSTALL', priority: 'Авария', start: '11:00', end: '13:30', duration: 45, coords: [55.77, 37.64] };
  const plan = buildDynamicReplan([...baseOrders, urgent], engineers.filter(engineer => engineer.id !== 'east-2'), basePlan);
  const route = plan.routes.find(item => item.engineerId === 'east-1');
  assert.deepEqual(route.assignments.map(item => item.orderId), ['a', 'urgent', 'b']);
  assert.equal(plan.metrics.assigned, 3);
  assert.equal(plan.validation.status, 'VALID');
  const explanation = plan.assignmentExplanations.find(item => item.orderId === 'urgent');
  assert.equal(explanation.engineerId, 'east-1');
  assert.equal(explanation.requiredSkill, 'INSTALL');
  assert.equal(explanation.transport, 'CAR');
  assert.ok(explanation.travelMinutes > 0);
  assert.ok(explanation.distanceKm > 0);
  assert.equal(explanation.feasibleCandidateCount, 1);
  assert.equal(explanation.plannedStart, route.assignments[1].plannedStart);
});

test('dynamic replanning never moves a request to another region', () => {
  const urgent = { id: 'urgent', zone: 'Восток', skill: 'EMERGENCY', priority: 'Авария', start: '11:00', end: '13:30', duration: 45, coords: [55.77, 37.64] };
  const plan = buildDynamicReplan([...baseOrders, urgent], engineers, basePlan);
  assert.equal(plan.routes.some(route => route.engineerId === 'south-1' && route.assignments.some(item => item.orderId === 'urgent')), false);
  assert.equal(plan.unassigned.find(item => item.orderId === 'urgent')?.reasonCode, 'NO_ELIGIBLE_ENGINEER_IN_REGION');
});

test('dynamic replanning removes a cancelled request from the published route', () => {
  const plan = buildDynamicReplan(baseOrders.filter(order => order.id !== 'a'), engineers, basePlan);
  assert.deepEqual(plan.routes.find(item => item.engineerId === 'east-1').assignments.map(item => item.orderId), ['b']);
  assert.equal(plan.metrics.total, 1);
});

test('engineer incident time freezes started visits and redistributes only future visits', () => {
  const event = { type: 'ENGINEER_UNAVAILABLE', engineerId: 'east-1', time: '12:00' };
  const plan = buildDynamicReplan(baseOrders, engineers, basePlan, event);
  const stoppedRoute = plan.routes.find(item => item.engineerId === 'east-1');
  const reserveRoute = plan.routes.find(item => item.engineerId === 'east-2');
  assert.deepEqual(stoppedRoute.assignments.map(item => item.orderId), ['a']);
  assert.deepEqual(reserveRoute.assignments.map(item => item.orderId), ['b']);
  assert.equal(stoppedRoute.assignments[0].frozen, true);
  assert.equal(plan.event.frozenVisits, 1);
  assert.equal(plan.event.reassignedFutureVisits, 1);
});

test('removal can leave future visits in queue without inventing an unchecked route', () => {
  const event = { type: 'ENGINEER_UNAVAILABLE', engineerId: 'east-1', time: '12:00', deferAffectedAssignments: true };
  const plan = buildDynamicReplan(baseOrders, engineers, basePlan, event);
  assert.deepEqual(plan.routes.find(item => item.engineerId === 'east-1').assignments.map(item => item.orderId), ['a']);
  assert.equal(plan.routes.some(item => item.engineerId === 'east-2' && item.assignments.length), false);
  assert.equal(plan.unassigned.find(item => item.orderId === 'b')?.reasonCode, 'ENGINEER_UNAVAILABLE');
});

test('an unrelated unassigned request is preserved instead of being replanned on every event', () => {
  const waiting = { id: 'waiting', zone: 'Восток', skill: 'INSTALL', start: '13:00', end: '17:00', duration: 30, coords: [55.76, 37.63] };
  const published = { ...basePlan, unassigned: [{ orderId: 'waiting', reasonCode: 'MANUAL_REVIEW', reason: 'Ожидает решения' }] };
  const plan = buildDynamicReplan([...baseOrders, waiting], engineers, published, { type: 'CLIENT_WINDOW_SHIFT', orderId: 'b', time: '12:00' });
  assert.equal(plan.routes.some(route => route.assignments.some(item => item.orderId === 'waiting')), false);
  assert.equal(plan.unassigned.find(item => item.orderId === 'waiting')?.reasonCode, 'MANUAL_REVIEW');
});

test('new work is never inserted before the recorded event time', () => {
  const urgent = { id: 'urgent', zone: 'Восток', skill: 'INSTALL', priority: 'Срочная', start: '09:00', end: '17:00', duration: 45, coords: [55.77, 37.64] };
  const event = { type: 'NEW_ORDER', orderId: 'urgent', time: '13:15' };
  const plan = buildDynamicReplan([...baseOrders, urgent], engineers, basePlan, event);
  const assignment = plan.routes.flatMap(route => route.assignments).find(item => item.orderId === 'urgent');
  assert.ok(assignment);
  assert.ok(assignment.plannedStart >= '13:15');
});

test('candidate diagnostics report every constraint instead of one generic diagnosis', () => {
  const order = { id: 'diagnostic', zone: 'Восток', skill: 'INSTALL', start: '11:00', end: '13:30', duration: 45, coords: [55.77, 37.64] };
  const candidates = diagnoseOrderCandidates(order, [
    { ...engineers[0], transport: 'Пешком' },
    { ...engineers[2], zone: 'Восток', skills: ['EMERGENCY'] },
  ], baseOrders, basePlan);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0].checks.map(check => check.key), ['skill', 'zone', 'window', 'travel', 'busy']);
  assert.equal(candidates[0].checks.find(check => check.key === 'travel').ok, true);
  assert.equal(candidates[1].checks.find(check => check.key === 'skill').ok, false);
  assert.match(candidates[1].label, /навык|оснащение/i);
});

test('a client-approved window shift is recalculated before it can be published', () => {
  const shiftedOrders = baseOrders.map(order => order.id === 'b' ? { ...order, start: '10:30', end: '13:00' } : order);
  const plan = buildDynamicReplan(shiftedOrders, [engineers[0]], basePlan, { type: 'CLIENT_WINDOW_SHIFT', orderId: 'b', time: '10:00' });
  const assignment = plan.routes.flatMap(route => route.assignments).find(item => item.orderId === 'b');
  assert.ok(assignment);
  assert.ok(assignment.plannedStart >= '10:30');
  assert.ok(assignment.plannedStart <= '13:00');
  assert.match(plan.event.summary, /согласованное с клиентом окно/i);
});

test('changed shift boundaries rebuild the affected crew route', () => {
  const shortenedEngineer = { ...engineers[0], shiftEnd: '13:00' };
  const plan = buildDynamicReplan(baseOrders, [shortenedEngineer], basePlan, { type: 'SHIFT_BOUNDARY_CHANGED', engineerId: 'east-1', time: '08:00' });
  assert.deepEqual(plan.routes.flatMap(route => route.assignments).map(item => item.orderId), ['a']);
  assert.equal(plan.unassigned.find(item => item.orderId === 'b')?.reasonCode, 'NO_FEASIBLE_TIME_WINDOW');
  assert.match(plan.event.summary, /границы смены изменены/i);
});

test('changed shift boundaries preserve every assignment that still fits the new shift', () => {
  const narrowedEngineer = { ...engineers[0], shiftStart: '08:30', shiftEnd: '16:00' };
  const plan = buildDynamicReplan(baseOrders, [narrowedEngineer], basePlan, { type: 'SHIFT_BOUNDARY_CHANGED', engineerId: 'east-1', time: '08:00' });
  assert.deepEqual(plan.routes.flatMap(route => route.assignments).map(item => item.orderId), ['a', 'b']);
  assert.equal(plan.metrics.assigned, 2);
  assert.equal(plan.metrics.unassigned, 0);
});

test('returning a released crew actually assigns feasible backlog work', () => {
  const waiting = { id: 'waiting', zone: 'Восток', skill: 'INSTALL', start: '09:00', end: '10:00', duration: 45, coords: [55.76, 37.63] };
  const published = { ...basePlan, unassigned: [{ orderId: waiting.id, reasonCode: 'NO_FEASIBLE_TIME_WINDOW' }] };
  const restoredCrew = { ...engineers[1], status: 'Доступен сегодня' };
  const plan = buildDynamicReplan([...baseOrders, waiting], [engineers[0], restoredCrew], published, { type: 'CAPACITY_ADDED', engineerId: restoredCrew.id, time: '00:00' });
  assert.equal(plan.validation.status, 'VALID');
  assert.equal(plan.metrics.assigned, 3);
  assert.equal(plan.unassigned.length, 0);
  assert.equal(plan.routes.find(route => route.engineerId === restoredCrew.id)?.assignments[0].orderId, waiting.id);
});

test('manual assignment is published only when the selected crew can take the order', () => {
  const waiting = { id: 'manual', zone: 'Восток', skill: 'INSTALL', start: '11:00', end: '13:00', duration: 45, coords: [55.76, 37.63] };
  const published = { ...basePlan, unassigned: [{ orderId: waiting.id }] };
  const event = { type: 'MANUAL_ASSIGN', orderId: waiting.id, engineerId: engineers[1].id };
  const plan = buildDynamicReplan([...baseOrders, waiting], engineers, published, event);
  assert.equal(plan.routes.find(route => route.engineerId === engineers[1].id)?.assignments[0].orderId, waiting.id);
  assert.equal(plan.metrics.assigned, 3);
  assert.throws(() => buildDynamicReplan([...baseOrders, waiting], engineers, published, { ...event, engineerId: engineers[2].id }), /не помещается в маршрут выбранной бригады/);
});

test('dispatcher can move a future assigned order to another eligible brigade', () => {
  const plan = buildDynamicReplan(baseOrders, engineers, basePlan, { type: 'MANUAL_ASSIGN', orderId: 'b', engineerId: 'east-2', time: '10:00' });
  assert.equal(plan.routes.find(route => route.engineerId === 'east-2').assignments.some(item => item.orderId === 'b'), true);
  assert.equal(plan.routes.find(route => route.engineerId === 'east-1').assignments.some(item => item.orderId === 'b'), false);
  assert.equal(plan.metrics.assigned, 2);
});
