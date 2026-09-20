import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDynamicReplan } from '../src/dynamicReplanner.js';

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

test('new work is never inserted before the recorded event time', () => {
  const urgent = { id: 'urgent', zone: 'Восток', skill: 'INSTALL', priority: 'Срочная', start: '09:00', end: '17:00', duration: 45, coords: [55.77, 37.64] };
  const event = { type: 'NEW_ORDER', orderId: 'urgent', time: '13:15' };
  const plan = buildDynamicReplan([...baseOrders, urgent], engineers, basePlan, event);
  const assignment = plan.routes.flatMap(route => route.assignments).find(item => item.orderId === 'urgent');
  assert.ok(assignment);
  assert.ok(assignment.plannedStart >= '13:15');
});
