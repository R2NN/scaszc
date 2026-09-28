import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiftStore } from '../server/shiftStore.mjs';
import { completedFactOrderIds, crewOperationalSummary, eventModel, nextFact, normalizeDataAdditionEvent, playbackFrame, playbackRouteSegments, shiftDisplayAt, visitStatusLabel } from '../src/shiftDomain.js';

const order = { id: 'a', coords: [55.75, 37.62], start: '10:00', end: '12:00' };
const engineer = { id: 'e', shiftStart: '08:00', shiftEnd: '18:00', startCoords: [55.7, 37.6] };
const plan = { publicationAllowed: true, validation: { status: 'VALID' }, provider: 'LOCAL_VALHALLA', routes: [{ engineerId: 'e', shiftStart: '08:00', shiftEnd: '18:00', assignments: [{ orderId: 'a', departureAt: '09:00', arrivalAt: '09:30', plannedStart: '10:00', plannedFinish: '11:00', geometry: [[55.7, 37.6], [55.75, 37.62]] }] }], unassigned: [] };

test('an event does not erase a cancelled order from the shift history', () => {
  const shift = { orders: [order], team: [engineer], plan, facts: [] };
  const change = eventModel(shift, { type: 'ORDER_CANCELLED', time: '09:00', orderId: 'a', reason: 'Клиент отказался' });
  assert.equal(change.orders.length, 0);
  assert.equal(shift.orders.length, 1);
  assert.throws(() => eventModel({ ...shift, facts: [{ orderId: 'a', status: 'completed' }] }, { type: 'ORDER_CANCELLED', time: '12:00', orderId: 'a', reason: 'Отмена' }), /Выполненную/);
});

test('fact transitions require confirmation, reasons and correction audit', () => {
  assert.throws(() => nextFact(null, { orderId: 'a', status: 'completed', time: '11:00' }), /Сначала отметьте начало/);
  const started = nextFact(null, { orderId: 'a', status: 'started', time: '10:00' });
  assert.equal(started.source, 'dispatcher');
  assert.throws(() => nextFact(started, { orderId: 'a', status: 'not_completed', time: '10:30' }), /причину/);
  const completed = nextFact(started, { orderId: 'a', status: 'completed', time: '11:00' });
  assert.throws(() => nextFact(completed, { orderId: 'a', status: 'started', time: '11:01' }), /исправление/);
});

test('a fact entered after preview invalidates publication without changing the plan', () => {
  const store = new ShiftStore(':memory:');
  try {
    const shift = store.ensure({ regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan });
    const previewId = store.startPreview(shift.id, shift.revision, { type: 'VISIT_CANCELLED', time: '09:00', reason: 'Перенос', orderId: 'a' });
    store.completePreview(previewId, { plan: { ...plan, routes: [{ ...plan.routes[0], assignments: [] }], unassigned: [{ orderId: 'a' }] }, orders: [order], team: [engineer] });
    store.recordFact(shift.id, { orderId: 'a', status: 'started', time: '10:00' });
    assert.throws(() => store.publish(shift.id, previewId, shift.revision), /новый факт визита/);
    assert.equal(store.get(shift.id).revision, 1);
  } finally { store.close(); }
});

test('playback does not turn simulated completion into a fact', () => {
  const shift = { orders: [order], team: [engineer], plan, facts: [] };
  assert.equal(playbackFrame(shift, 700, 'plan').visits[0].status, 'simulated_completed');
  assert.equal(playbackFrame(shift, 700, 'fact').visits[0].status, 'no_fact');
  assert.deepEqual(completedFactOrderIds(shift, 700), []);
  assert.equal(playbackFrame(shift, 555).crews[0].status, 'travelling');
  assert.equal(playbackFrame(shift, 555).crews[0].positionKnown, true);
});

test('newly added day records stay visible before a later route-plan version takes effect', () => {
  const newcomer = { ...engineer, id: 'new', name: 'Новая бригада', shiftStart: '15:00', shiftEnd: '22:00' };
  const request = { ...order, id: 'new-order' };
  const shift = { orders: [order, request], team: [engineer, newcomer], versions: [
    { version: 1, effectiveAt: '00:00', orders: [order], team: [engineer], plan },
    { version: 2, effectiveAt: '19:43', orders: [order, request], team: [engineer, newcomer], plan },
  ], facts: [] };
  const beforeWork = shiftDisplayAt(shift, 14 * 60);
  assert.strictEqual(beforeWork, shiftDisplayAt(shift, 16 * 60));
  assert.equal(beforeWork.team.length, 2);
  assert.equal(beforeWork.orders.length, 2);
  assert.equal(playbackFrame(beforeWork, 14 * 60).crews.find(crew => crew.engineerId === 'new').status, 'off_shift');
  const duringWork = playbackFrame(shiftDisplayAt(shift, 16 * 60), 16 * 60);
  assert.equal(duringWork.crews.find(crew => crew.engineerId === 'new').status, 'idle');
  assert.equal(duringWork.crews.find(crew => crew.engineerId === 'new').positionKnown, true);
  assert.equal(duringWork.orderStatuses.find(item => item.orderId === 'new-order').status, 'unassigned');
  const normalized = normalizeDataAdditionEvent(shift, { type: 'NEW_ORDER', order: request, time: '17:00' });
  assert.equal(normalized.time, '19:43');
  assert.match(normalized.reason, /добавлена вручную/);
});

test('map completion follows the latest dispatcher fact at the playback time', () => {
  const shift = { factLog: [
    { orderId: 'a', status: 'started', time: '10:00' },
    { orderId: 'a', status: 'completed', time: '11:00' },
    { orderId: 'a', status: 'not_completed', time: '12:00' },
  ] };
  assert.deepEqual(completedFactOrderIds(shift, 650), []);
  assert.deepEqual(completedFactOrderIds(shift, 690), ['a']);
  assert.deepEqual(completedFactOrderIds(shift, 750), []);
});

test('crew coordinates follow the same geographic route at each playback minute', () => {
  const shift = { orders: [order], team: [engineer], plan, facts: [] };
  const departure = playbackFrame(shift, 540).crews[0];
  const midpoint = playbackFrame(shift, 555).crews[0];
  const arrival = playbackFrame(shift, 570).crews[0];
  assert.deepEqual(departure.coords, engineer.startCoords);
  assert.ok(Math.abs(midpoint.coords[0] - 55.725) < 1e-8);
  assert.ok(Math.abs(midpoint.coords[1] - 37.61) < 1e-8);
  assert.deepEqual(arrival.coords, order.coords);
  assert.equal(playbackFrame(shift, 555, 'fact').crews[0].positionKnown, false);
});

test('travelled and remaining playback lines preserve road bends', () => {
  const geometry = [[55.7, 37.6], [55.71, 37.6], [55.71, 37.62], [55.73, 37.62]];
  const route = { assignments: [{ departureAt: '09:00', arrivalAt: '10:00', geometry }] };
  const { travelled, remaining } = playbackRouteSegments(route, 570);
  assert.deepEqual(travelled[0][0], geometry[0]);
  assert.deepEqual(travelled[0][1], geometry[1]);
  assert.deepEqual(remaining[0].at(-1), geometry.at(-1));
  assert.deepEqual(travelled[0].at(-1), remaining[0][0]);
  assert.ok(travelled[0].length > 2, 'the progress line must include intermediate road vertices');
});

test('timeline and map share time-sensitive visit states without inventing facts', () => {
  const shift = { orders: [order, { id: 'waiting', coords: [55.8, 37.7] }], team: [engineer], plan, facts: [] };
  assert.equal(playbackFrame(shift, 530, 'plan').orderStatuses[0].status, 'planned');
  assert.equal(playbackFrame(shift, 550, 'plan').orderStatuses[0].status, 'travelling');
  assert.equal(playbackFrame(shift, 575, 'plan').orderStatuses[0].status, 'waiting');
  assert.equal(playbackFrame(shift, 615, 'plan').orderStatuses[0].status, 'working');
  assert.equal(playbackFrame(shift, 665, 'plan').orderStatuses[0].status, 'simulated_completed');
  assert.equal(playbackFrame(shift, 665, 'fact').orderStatuses[0].status, 'no_fact');
  assert.equal(playbackFrame(shift, 615, 'plan').orderStatuses[1].status, 'unassigned');
  assert.equal(visitStatusLabel('simulated_completed'), 'По плану завершена');
  const summary = crewOperationalSummary(shift, playbackFrame(shift, 615), 'e', 615);
  assert.equal(summary.phaseMinutes, 15);
  assert.equal(summary.currentOrder.id, 'a');
  const segments = playbackRouteSegments(plan.routes[0], 555);
  assert.equal(segments.travelled.length, 1);
  assert.equal(segments.remaining.length, 1);
  assert.deepEqual(segments.travelled[0].at(-1), segments.remaining[0][0]);
});

test('future assigned work can be reassigned, but never after its planned start', () => {
  const second = { ...engineer, id: 'other' };
  const shift = { orders: [order], team: [engineer, second], plan, facts: [] };
  assert.equal(eventModel(shift, { type: 'MANUAL_ASSIGN', time: '09:00', orderId: 'a', engineerId: 'other', reason: 'Оперативная замена' }).event.engineerId, 'other');
  assert.throws(() => eventModel(shift, { type: 'MANUAL_ASSIGN', time: '10:30', orderId: 'a', engineerId: 'other', reason: 'Поздно' }), /задним числом/);
  assert.throws(() => eventModel(shift, { type: 'MANUAL_ASSIGN', time: '09:00', orderId: 'a', engineerId: 'e', reason: 'Без изменений' }), /уже назначена/);
});

test('shift versions, facts and stale-preview rejection survive store reads', () => {
  const store = new ShiftStore(':memory:');
  try {
    const shift = store.ensure({ regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan });
    assert.equal(shift.revision, 1);
    const previewId = store.startPreview(shift.id, shift.revision, { type: 'VISIT_CANCELLED', time: '09:00', reason: 'Перенос', orderId: 'a' });
    const nextPlan = { ...plan, routes: [{ ...plan.routes[0], assignments: [] }], unassigned: [{ orderId: 'a', reasonCode: 'VISIT_CANCELLED' }] };
    store.completePreview(previewId, { plan: nextPlan, orders: [order], team: [engineer] });
    const published = store.publish(shift.id, previewId, 1);
    assert.equal(published.revision, 2);
    assert.equal(published.events[0].type, 'VISIT_CANCELLED');
    assert.equal(published.versions.length, 2);
    assert.throws(() => store.publish(shift.id, previewId, 1), /устарел/);
    const marked = store.recordFact(shift.id, { orderId: 'a', status: 'not_completed', time: '12:00', reason: 'Клиент недоступен' });
    assert.equal(marked.facts[0].status, 'not_completed');
    assert.equal(store.byDate('moscow', '2026-08-17').factLog.length, 1);
  } finally { store.close(); }
});
