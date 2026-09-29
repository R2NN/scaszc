import test from 'node:test';
import assert from 'node:assert/strict';
import { findAlternativeWindow, preservesStartedVisits } from '../server/exactShiftReplan.mjs';

const route = (orderId, plannedStart, engineerId = 'crew-1') => ({
  engineerId,
  assignments: [{ orderId, plannedStart }],
});

test('a full rebuild may move future work while preserving earlier visits', () => {
  const shift = {
    plan: { routes: [route('past', '09:00'), route('future', '14:00')] },
    facts: [],
  };
  const candidate = {
    routes: [route('past', '09:00'), route('future', '15:00', 'crew-2')],
  };
  assert.equal(preservesStartedVisits(shift, candidate, '12:00'), true);
  assert.equal(preservesStartedVisits(shift, { routes: [route('past', '09:15'), candidate.routes[1]] }, '12:00'), false);
  const oldDeparture = { ...route('past', '09:00'), assignments: [{ orderId: 'past', plannedStart: '09:00', departureAt: '08:45' }] };
  const newDeparture = { ...route('past', '09:00'), assignments: [{ orderId: 'past', plannedStart: '09:00', departureAt: '08:50' }] };
  assert.equal(preservesStartedVisits({ plan: { routes: [oldDeparture] }, facts: [] }, { routes: [newDeparture] }, '12:00'), false);
});

test('a recorded start freezes its assignment even after the event time', () => {
  const shift = {
    plan: { routes: [route('started', '14:00')] },
    facts: [{ orderId: 'started', status: 'started' }],
  };
  assert.equal(preservesStartedVisits(shift, { routes: [route('started', '14:30')] }, '12:00'), false);
});

test('an alternative time is shown only after a second exact window check', async () => {
  const order = { id: 'new', start: '10:00', end: '12:00' };
  const shift = { plan: { routes: [route('past', '09:00')] }, facts: [], date: '2026-08-17' };
  const model = {
    orders: [order],
    team: [{ shiftEnd: '18:00' }],
    event: { type: 'NEW_ORDER', orderId: 'new', time: '08:00' },
  };
  const inputs = [];
  const suggestion = await findAlternativeWindow(shift, model, order, async payload => {
    inputs.push(payload.orders[0]);
    return { routes: [route('past', '09:00'), route('new', '13:30')] };
  });
  assert.deepEqual(inputs.map(item => [item.start, item.end]), [
    ['12:01', '18:00'], ['13:30', '15:30'],
  ]);
  assert.deepEqual(suggestion, {
    start: '13:30', end: '15:30', plannedStart: '13:30',
    engineerId: 'crew-1', engineerName: undefined, checkedBy: 'EXACT_REPLAN',
  });
});

test('a queued order is checked through a real client-window event', async () => {
  const order = { id: 'queued', start: '10:00', end: '12:00' };
  const shift = { plan: { routes: [] }, facts: [], date: '2026-08-17' };
  const model = {
    orders: [order], team: [{ shiftEnd: '18:00' }],
    event: { type: 'RECALCULATE', time: '08:00' },
  };
  const events = [];
  await findAlternativeWindow(shift, model, order, async payload => {
    events.push(payload.event);
    return { routes: [route('queued', '13:30')] };
  });
  assert.deepEqual(events.map(event => [event.type, event.orderId, event.start, event.end]), [
    ['CLIENT_WINDOW_SHIFT', 'queued', '12:01', '18:00'],
    ['CLIENT_WINDOW_SHIFT', 'queued', '13:30', '15:30'],
  ]);
});
