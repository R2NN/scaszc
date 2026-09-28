import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { createOperationsApi } from '../server/operationsApi.mjs';
import { createShiftPdf, shiftReportData } from '../server/shiftReport.mjs';
import { exactLeg, validateRoadPlan } from '../server/roadRouting.mjs';
import { buildDynamicReplan } from '../src/dynamicReplanner.js';
import { eventModel, playbackFrame, shiftAt } from '../src/shiftDomain.js';
import { askShiftAi } from '../server/aiStudio.mjs';

const order = { id: 'job-1', sourceId: 'JOB-1', name: 'Подключение', regionId: 'moscow', zone: 'Центр', skill: 'Подключение', equipment: '', coords: [55.75,37.62], start: '09:00', end: '13:00', duration: 60 };
const engineer = { id: 'crew-1', name: 'Бригада 1', regionId: 'moscow', zone: 'Центр', skills: ['Подключение'], equipment: [], transport: 'CAR', shiftStart: '08:00', shiftEnd: '18:00', startCoords: [55.7,37.6] };
const plan = { provider: 'LOCAL_VALHALLA', publicationAllowed: true, validation: { status: 'VALID' }, routes: [{ engineerId: engineer.id, engineerName: engineer.name, shiftStart: '08:00', shiftEnd: '18:00', assignments: [{ orderId: order.id, departureAt: '08:30', arrivalAt: '09:00', plannedStart: '09:00', plannedFinish: '10:00', travelMinutes: 30, distanceM: 15000, geometry: [engineer.startCoords, order.coords] }], distanceKm: 15, travelMinutes: 30 }], unassigned: [], metrics: { total: 1, assigned: 1, unassigned: 0 } };
const request = (path, method = 'GET', body) => new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

test('staff roster addition and archiving do not change published shift history', async () => {
  const store = new ShiftStore(':memory:');
  const api = createOperationsApi({ store });
  try {
    const shift = await (await api.handle(request('/api/shifts', 'POST', { regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan }))).json();
    const newEngineer = { ...engineer, id: 'crew-new', sourceId: 'CREW-NEW', name: 'Новая бригада' };
    const created = await api.handle(request('/api/staff/engineers', 'POST', { engineer: newEngineer, activeFrom: '2026-08-17' }));
    assert.equal(created.status, 201);
    assert.equal((await (await api.handle(request('/api/staff/engineers?regionId=moscow'))).json()).length, 2);
    assert.equal((await api.handle(request('/api/staff/engineers', 'POST', { engineer: newEngineer, activeFrom: '2026-08-17' }))).status, 422);
    const archived = await (await api.handle(request('/api/staff/engineers/crew-new/archive', 'PATCH', { regionId: 'moscow', date: '2026-08-18' }))).json();
    assert.equal(archived.rosterArchived, true);
    assert.deepEqual(archived.rosterPeriods, [{ from: '2026-08-17', to: '2026-08-18' }]);
    const restored = await (await api.handle(request('/api/staff/engineers/crew-new/restore', 'PATCH', { regionId: 'moscow', date: '2026-08-20' }))).json();
    assert.deepEqual(restored.rosterPeriods, [{ from: '2026-08-17', to: '2026-08-18' }, { from: '2026-08-20', to: null }]);
    const unchanged = await (await api.handle(request(`/api/shifts/${shift.id}`))).json();
    assert.equal(unchanged.revision, 1);
    assert.equal(unchanged.team.length, 1);
  } finally { store.close(); }
});

test('adding a staff member to a shift and taking them off duty are separate publications', async () => {
  const store = new ShiftStore(':memory:');
  const api = createOperationsApi({ store, routing: async candidate => ({ ...candidate, provider: 'TEST_EXACT_ROAD', publicationAllowed: true, approximateTravel: false, validation: { status: 'VALID' } }) });
  try {
    const initial = await (await api.handle(request('/api/shifts', 'POST', { regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan }))).json();
    const newcomer = { ...engineer, id: 'crew-new', sourceId: 'CREW-NEW', name: 'Новая бригада' };
    const stored = await (await api.handle(request('/api/staff/engineers', 'POST', { engineer: newcomer, activeFrom: '2026-08-17' }))).json();
    assert.equal(stored.name, newcomer.name);
    assert.equal(store.get(initial.id).team.length, 1);
    const inclusion = await (await api.handle(request(`/api/shifts/${initial.id}/preview`, 'POST', { expectedRevision: 1, event: { type: 'CAPACITY_ADDED', time: '08:00', reason: 'Бригада включена в смену', engineer: stored } }))).json();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await (await api.handle(request(`/api/previews/${inclusion.id}`))).json()).status, 'READY');
    const included = await (await api.handle(request(`/api/shifts/${initial.id}/publish`, 'POST', { previewId: inclusion.id, expectedRevision: 1 }))).json();
    assert.equal(included.team.some(item => item.id === newcomer.id), true);
    assert.equal(included.revision, 2);
    await api.handle(request('/api/staff/engineers/crew-new/archive', 'PATCH', { regionId: 'moscow', date: '2026-08-18' }));
    assert.equal(store.get(initial.id).revision, 2);
    const removal = await (await api.handle(request(`/api/shifts/${initial.id}/preview`, 'POST', { expectedRevision: 2, event: { type: 'ENGINEER_UNAVAILABLE', time: '09:00', reason: 'Бригада снята со смены', engineerId: newcomer.id } }))).json();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await (await api.handle(request(`/api/previews/${removal.id}`))).json()).status, 'READY');
    const removed = await (await api.handle(request(`/api/shifts/${initial.id}/publish`, 'POST', { previewId: removal.id, expectedRevision: 2 }))).json();
    assert.equal(removed.revision, 3);
    assert.equal(removed.team.find(item => item.id === newcomer.id).unavailableFrom, '09:00');
    assert.equal(removed.versions.length, 3);
    const returnTask = await (await api.handle(request(`/api/shifts/${initial.id}/preview`, 'POST', { expectedRevision: 3, event: { type: 'CAPACITY_ADDED', time: '10:00', reason: 'Бригада возвращена в смену', engineerId: newcomer.id } }))).json();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await (await api.handle(request(`/api/previews/${returnTask.id}`))).json()).status, 'READY');
    const returned = await (await api.handle(request(`/api/shifts/${initial.id}/publish`, 'POST', { previewId: returnTask.id, expectedRevision: 3 }))).json();
    assert.equal(returned.team.find(item => item.id === newcomer.id).status, 'Доступен');
    assert.equal(returned.versions.length, 4);
  } finally { store.close(); }
});

test('manual request addition needs no event time or reason after an earlier publication', async () => {
  const store = new ShiftStore(':memory:');
  const api = createOperationsApi({ store, routing: async candidate => ({ ...candidate, provider: 'TEST_EXACT_ROAD', publicationAllowed: true, approximateTravel: false, validation: { status: 'VALID' } }) });
  try {
    const initial = await (await api.handle(request('/api/shifts', 'POST', { regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan }))).json();
    const first = await (await api.handle(request(`/api/shifts/${initial.id}/preview`, 'POST', { expectedRevision: 1, event: { type: 'VISIT_CANCELLED', time: '19:43', reason: 'Клиент отменил визит', orderId: order.id } }))).json();
    await new Promise(resolve => setImmediate(resolve));
    const current = await (await api.handle(request(`/api/shifts/${initial.id}/publish`, 'POST', { previewId: first.id, expectedRevision: 1 }))).json();
    const newOrder = { ...order, id: 'job-new', sourceId: 'JOB-NEW', name: 'Новая заявка', start: '20:00', end: '22:00', status: 'Черновик' };
    const task = await (await api.handle(request(`/api/shifts/${initial.id}/preview`, 'POST', { expectedRevision: current.revision, event: { type: 'NEW_ORDER', order: newOrder, time: '17:00', reason: 'Пробный текст' } }))).json();
    await new Promise(resolve => setImmediate(resolve));
    const preview = await (await api.handle(request(`/api/previews/${task.id}`))).json();
    assert.equal(preview.status, 'READY');
    assert.equal(preview.event.time, '19:43');
    assert.match(preview.event.reason, /Заявка добавлена вручную/);
    assert.equal(preview.result.orders.some(item => item.id === newOrder.id), true);
    assert.equal(preview.result.orders.find(item => item.id === newOrder.id).status, 'Ожидается');
  } finally { store.close(); }
});

test('discarding an unpublished preview survives reload without changing the published shift', async () => {
  const store = new ShiftStore(':memory:');
  const api = createOperationsApi({ store, routing: async candidate => ({ ...candidate, provider: 'TEST_EXACT_ROAD', publicationAllowed: true, approximateTravel: false, validation: { status: 'VALID' } }) });
  try {
    const shift = await (await api.handle(request('/api/shifts', 'POST', { regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan }))).json();
    const extraEngineer = { ...engineer, id: 'crew-new', name: 'Тестовая бригада', sourceId: 'CREW-NEW' };
    const queued = await (await api.handle(request(`/api/shifts/${shift.id}/preview`, 'POST', { expectedRevision: shift.revision, event: { type: 'CAPACITY_ADDED', time: '12:00', reason: 'Тест', engineer: extraEngineer } }))).json();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await (await api.handle(request(`/api/shifts/${shift.id}/preview`))).json()).status, 'READY');
    const discarded = await (await api.handle(request(`/api/shifts/${shift.id}/preview`, 'DELETE', { previewId: queued.id, expectedRevision: shift.revision }))).json();
    assert.equal(discarded.status, 'DISCARDED');
    assert.equal((await api.handle(request(`/api/shifts/${shift.id}/preview`))).status, 404);
    assert.equal((await api.handle(request(`/api/shifts/${shift.id}/publish`, 'POST', { previewId: queued.id, expectedRevision: shift.revision }))).status, 409);
    const unchanged = await (await api.handle(request(`/api/shifts/${shift.id}`))).json();
    assert.equal(unchanged.revision, shift.revision);
    assert.equal(unchanged.team.some(item => item.id === extraEngineer.id), false);
  } finally {
    store.close();
  }
});

test('event preview, exact validation gate, atomic publish, replay and PDF', async () => {
  const store = new ShiftStore(':memory:');
  const api = createOperationsApi({ store, routing: async candidate => ({ ...candidate, provider: 'TEST_EXACT_ROAD', publicationAllowed: true, approximateTravel: false, validation: { status: 'VALID' } }) });
  try {
    let response = await api.handle(request('/api/shifts', 'POST', { regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan }));
    const initial = await response.json();
    assert.equal(initial.revision, 1);
    const event = { type: 'VISIT_CANCELLED', orderId: order.id, time: '08:15', reason: 'Клиент перенёс визит' };
    response = await api.handle(request(`/api/shifts/${initial.id}/preview`, 'POST', { expectedRevision: 1, event }));
    assert.equal(response.status, 202);
    const task = await response.json();
    await new Promise(resolve => setImmediate(resolve));
    response = await api.handle(request(`/api/previews/${task.id}`));
    const preview = await response.json();
    assert.equal(preview.status, 'READY');
    assert.equal(preview.progress.phase, 'READY');
    assert.equal(preview.result.plan.routes.some(route => route.assignments.some(item => item.orderId === order.id)), false);
    assert.equal(preview.result.plan.unassigned[0].reasonCode, 'VISIT_CANCELLED');
    response = await api.handle(request(`/api/shifts/${initial.id}/publish`, 'POST', { previewId: task.id, expectedRevision: 1 }));
    const published = await response.json();
    assert.equal(published.revision, 2);
    assert.throws(() => store.startPreview(initial.id, 2, { type: 'NEW_ORDER', time: '08:10', reason: 'Срочная' }), /раньше последней публикации/);
    assert.throws(() => store.rollback(initial.id, initial.currentPlanId, 2, 'Диспетчер', '08:10'), /раньше последней публикации/);
    assert.equal(shiftAt(published, 490).plan.metrics.assigned, 1);
    assert.equal(shiftAt(published, 496).plan.metrics.assigned, 0);
    response = await api.handle(request(`/api/shifts/${initial.id}/publish`, 'POST', { previewId: task.id, expectedRevision: 1 }));
    assert.equal(response.status, 409);
    response = await api.handle(request(`/api/shifts/${initial.id}/facts`, 'POST', { orderId: order.id, status: 'not_completed', time: '09:10', reason: 'Клиент отменил' }));
    const marked = await response.json();
    assert.equal(marked.facts[0].status, 'not_completed');
    assert.equal(playbackFrame(shiftAt(marked, 495), 495, 'fact').visits.length, 0);
    const data = shiftReportData(marked);
    assert.equal(data.counts.notCompleted, 1);
    assert.equal(data.unassigned.length, 1);
    const pdf = await createShiftPdf(marked);
    if (process.env.BEEGO_PDF_QA_PATH) await writeFile(process.env.BEEGO_PDF_QA_PATH, pdf);
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.ok(pdf.length > 5000);
    response = await api.handle(request(`/api/shifts/${initial.id}/report`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
  } finally { store.close(); }
});

test('events preserve unique orders, blocked facts and replacement team', () => {
  const shift = { orders: [order], team: [engineer], plan, facts: [] };
  const added = eventModel(shift, { type: 'NEW_ORDER', order: { ...order, id: 'job-2' }, time: '08:00', reason: 'Срочная заявка' });
  assert.equal(added.orders.length, 2);
  assert.throws(() => eventModel(shift, { type: 'NEW_ORDER', order, time: '08:00', reason: 'Повтор' }), /уникальный/);
  const replacement = eventModel(shift, { type: 'ENGINEER_REPLACED', engineerId: engineer.id, replacement: { ...engineer, id: 'crew-2' }, time: '08:00', reason: 'Заболел' });
  assert.equal(replacement.team.length, 2);
  assert.equal(replacement.event.type, 'ENGINEER_UNAVAILABLE');
  assert.throws(() => eventModel({ ...shift, facts: [{ orderId: order.id, status: 'started' }] }, { type: 'ORDER_CANCELLED', orderId: order.id, time: '09:30', reason: 'Отказ' }), /Начатый визит/);
});

test('journal can restore any saved plan, not only the immediately previous one', async () => {
  const store = new ShiftStore(':memory:');
  const api = createOperationsApi({ store });
  try {
    const input = { regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer] };
    const first = store.ensure({ ...input, plan: { ...plan, label: 'first' } });
    store.ensure({ ...input, plan: { ...plan, label: 'second' } });
    const third = store.ensure({ ...input, plan: { ...plan, label: 'third' } });
    assert.equal(third.revision, 3);
    const response = await api.handle(request(`/api/shifts/${first.id}/rollback`, 'POST', {
      targetPlanId: first.currentPlanId,
      expectedRevision: third.revision,
      actor: 'Диспетчер',
      time: '00:00',
    }));
    assert.equal(response.status, 200);
    const restored = await response.json();
    assert.equal(restored.revision, 4);
    assert.equal(restored.plan.label, 'first');
    assert.equal(restored.versions.length, 4);
    assert.equal(restored.events.at(-1).type, 'PLAN_ROLLBACK');
    assert.equal(restored.events.at(-1).payload.targetPlanId, first.currentPlanId);
  } finally { store.close(); }
});

test('Geoapify response supplies real geometry and independent validation rejects lost orders', async () => {
  const fetchImpl = async url => {
    assert.match(String(url), /mode=drive/);
    return new Response(JSON.stringify({ features: [{ geometry: { type: 'MultiLineString', coordinates: [[[37.6,55.7],[37.61,55.72],[37.62,55.75]]] }, properties: { time: 1200, distance: 9300 } }] }), { status: 200 });
  };
  const leg = await exactLeg(engineer.startCoords, order.coords, 'CAR', { geoapifyKey: 'test-key', fetchImpl });
  assert.equal(leg.minutes, 20);
  assert.equal(leg.geometry.length, 3);
  const candidate = { event: { time: '08:00' }, routes: [{ engineerId: engineer.id, shiftStart: '08:00', shiftEnd: '18:00', assignments: [{ orderId: order.id }] }], unassigned: [], metrics: { total: 1 } };
  const validated = await validateRoadPlan(candidate, { routes: [] }, [order], [engineer], { geoapifyKey: 'test-key', fetchImpl });
  assert.equal(validated.validation.status, 'VALID');
  assert.equal(validated.routes[0].assignments[0].distanceM, 9300);
  const laterOrder = { ...order, start: '12:00', end: '16:00' };
  const laterCandidate = { ...candidate, event: { time: '12:00' } };
  const later = await validateRoadPlan(laterCandidate, { routes: [] }, [laterOrder], [engineer], { geoapifyKey: 'test-key', fetchImpl });
  assert.equal(later.routes[0].assignments[0].departureAt, '12:00');
  assert.equal(later.routes[0].assignments[0].plannedStart, '12:20');
  await assert.rejects(validateRoadPlan({ ...candidate, routes: [] }, { routes: [] }, [order], [engineer], { geoapifyKey: 'test-key', fetchImpl }), /потеряна заявка/);
  const shorterShift = { ...engineer, shiftEnd: '09:15' };
  await assert.rejects(validateRoadPlan({ ...candidate, event: { type: 'SHIFT_BOUNDARY_CHANGED', time: '08:00' } }, plan, [order], [shorterShift], { geoapifyKey: 'test-key', fetchImpl }), /не помещается в окно или смену/);
});

test('unreachable transit stop reports an actionable routing failure', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: 'Cannot reach destination - too far from a transit stop' }), { status: 400 });
  await assert.rejects(exactLeg([55.75, 37.62], [55.76, 37.63], 'Общественный транспорт', { geoapifyKey: 'test-key', fetchImpl }), /не нашёл доступный путь/);
});

test('operational publication keeps estimated baseline provenance while checking changed roads', async () => {
  const extraOrder = { ...order, id: 'job-2', sourceId: 'JOB-2', coords: [55.76, 37.63] };
  const extraEngineer = { ...engineer, id: 'crew-2', name: 'Бригада 2' };
  const base = { ...plan, status: 'HYBRID_VALID', routes: plan.routes };
  const candidate = {
    event: { type: 'NEW_ORDER', time: '08:00', reason: 'Срочная заявка' },
    routes: [plan.routes[0], { engineerId: extraEngineer.id, shiftStart: '08:00', shiftEnd: '18:00', assignments: [{ orderId: extraOrder.id }] }],
    unassigned: [], metrics: { total: 2 },
  };
  const fetchImpl = async () => new Response(JSON.stringify({ features: [{ geometry: { type: 'LineString', coordinates: [[37.6, 55.7], [37.63, 55.76]] }, properties: { time: 1200, distance: 9300 } }] }), { status: 200 });
  const validated = await validateRoadPlan(candidate, base, [order, extraOrder], [engineer, extraEngineer], { geoapifyKey: 'test-key', fetchImpl });
  assert.equal(validated.approximateTravel, true);
  assert.equal(validated.provider, 'MIXED_BASELINE_AND_EXACT_ROAD');
  assert.equal(validated.validation.retainedEstimatedVisits, 1);
  assert.equal(validated.validation.exactCheckedVisits, 1);
  assert.equal(validated.routes[1].assignments[0].claimLevel, 'EXACT_ROAD_VALIDATED');
  const store = new ShiftStore(':memory:');
  try {
    const shift = store.ensure({ regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan: base });
    const previewId = store.startPreview(shift.id, 1, candidate.event);
    store.completePreview(previewId, { plan: validated, orders: [order, extraOrder], team: [engineer, extraEngineer] });
    assert.equal(store.publish(shift.id, previewId, 1).revision, 2);
  } finally { store.close(); }
});

test('changing the window of an unassigned request does not call the road provider', async () => {
  const waiting = { ...order, id: 'waiting', sourceId: 'WAITING', start: '12:00', end: '14:00' };
  const base = { ...plan, unassigned: [{ orderId: waiting.id, reasonCode: 'NO_FEASIBLE_TIME_WINDOW' }] };
  const changed = { ...waiting, start: '10:00', end: '12:00' };
  const candidate = buildDynamicReplan([order, changed], [engineer], base, { type: 'CLIENT_WINDOW_SHIFT', orderId: waiting.id, time: '20:11' });
  const result = await validateRoadPlan(candidate, base, [order, changed], [engineer], { fetchImpl: () => { throw new Error('Road provider should not be called'); } });
  assert.equal(result.validation.exactCheckedVisits, 0);
  assert.equal(result.unassigned.some(item => item.orderId === waiting.id), true);
  assert.equal(result.routes[0].assignments[0].plannedStart, '09:00');
});

test('an assigned visit keeps its verified route when its new window still contains the planned start', async () => {
  const changed = { ...order, start: '08:30', end: '10:00' };
  const candidate = buildDynamicReplan([changed], [engineer], plan, { type: 'CLIENT_WINDOW_SHIFT', orderId: order.id, time: '08:00' });
  assert.deepEqual(candidate.routes[0].assignments.map(item => item.orderId), [order.id]);
  const checked = await validateRoadPlan(candidate, plan, [changed], [engineer], { fetchImpl: () => { throw new Error('Road provider should not be called'); } });
  assert.equal(checked.validation.exactCheckedVisits, 0);
  assert.equal(checked.routes[0].assignments[0].plannedStart, '09:00');
});

test('an unavailable engineer can be removed while road routing is down, with future jobs queued', async () => {
  const store = new ShiftStore(':memory:');
  const reserve = { ...engineer, id: 'crew-reserve', name: 'Резерв' };
  const future = { ...order, id: 'future', sourceId: 'FUTURE', start: '12:00', end: '17:00', coords: [55.76, 37.63] };
  const base = { ...plan, routes: [{ ...plan.routes[0], assignments: [
    plan.routes[0].assignments[0],
    { ...plan.routes[0].assignments[0], orderId: future.id, plannedStart: '13:00', plannedFinish: '14:00' },
  ] }] };
  const api = createOperationsApi({ store, routing: async (candidate, previous, orders, team, options) => {
    if (candidate.routes.some(route => route.engineerId === reserve.id && route.assignments.length)) throw new Error('Дорожный сервис вернул 400. Черновик не публикуется.');
    return validateRoadPlan(candidate, previous, orders, team, { ...options, fetchImpl: () => { throw new Error('Network must not be needed for deferred assignments'); } });
  } });
  try {
    const shift = store.ensure({ regionId: 'moscow', date: '2026-08-17', orders: [order, future], team: [engineer, reserve], plan: base });
    const queued = await (await api.handle(request(`/api/shifts/${shift.id}/preview`, 'POST', { expectedRevision: 1, event: { type: 'ENGINEER_UNAVAILABLE', engineerId: engineer.id, time: '11:00', reason: 'Больничный' } }))).json();
    await new Promise(resolve => setImmediate(resolve));
    const preview = await (await api.handle(request(`/api/previews/${queued.id}`))).json();
    assert.equal(preview.status, 'READY', preview.error);
    assert.equal(preview.result.plan.validation.deferredAssignments, true);
    assert.equal(preview.result.plan.unassigned.find(item => item.orderId === future.id)?.reasonCode, 'ENGINEER_UNAVAILABLE');
    const published = await (await api.handle(request(`/api/shifts/${shift.id}/publish`, 'POST', { previewId: queued.id, expectedRevision: 1 }))).json();
    assert.equal(published.revision, 2);
    assert.equal(published.team.find(item => item.id === engineer.id).status, 'Недоступен');
  } finally { store.close(); }
});

test('daily report includes idle crews and remains paginated for a full-sized shift', async () => {
  const largeTeam = Array.from({ length: 35 }, (_, index) => ({ ...engineer, id: `crew-${index}`, name: `Бригада ${index + 1}` }));
  const largeOrders = Array.from({ length: 205 }, (_, index) => ({ ...order, id: `job-${index}`, name: `Заявка ${index + 1}` }));
  const largePlan = { ...plan, routes: largeTeam.slice(0, 30).map((member, index) => ({ ...plan.routes[0], engineerId: member.id, engineerName: member.name, assignments: [{ ...plan.routes[0].assignments[0], orderId: largeOrders[index].id }] })), unassigned: largeOrders.slice(30).map(item => ({ orderId: item.id, reason: 'Нет свободного интервала' })) };
  const shift = { id: 'large', date: '2026-08-17', regionId: 'moscow', revision: 1, orders: largeOrders, team: largeTeam, plan: largePlan, versions: [{ version: 1, orders: largeOrders }], events: [], facts: [], factLog: [] };
  const data = shiftReportData(shift);
  assert.equal(data.crews.length, 35);
  assert.equal(data.crews.filter(item => item.status === 'Без маршрута').length, 5);
  assert.equal(data.visits.length, 30);
  assert.equal(data.totalTravelMinutes, 900);
  assert.equal(data.totalWorkMinutes, 1800);
  assert.deepEqual(data.byZone, [['Центр', 30]]);
  const pdf = await createShiftPdf(shift);
  if (process.env.BEEGO_PDF_LARGE_QA_PATH) await writeFile(process.env.BEEGO_PDF_LARGE_QA_PATH, pdf);
  assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length > 1);
});

test('daily report uses precise coverage and judges client windows by visit start', () => {
  const orders = Array.from({ length: 205 }, (_, index) => ({ ...order, id: `job-${index}`, end: '09:30', priority: index === 204 ? 'Авария' : 'Обычная' }));
  const assignments = orders.slice(0, 204).map(item => ({ orderId: item.id, plannedStart: '09:00', plannedFinish: '10:00', travelMinutes: 0 }));
  const shift = { date: '2026-08-17', regionId: 'moscow', revision: 1, orders, team: [engineer], plan: { routes: [{ ...plan.routes[0], assignments }], unassigned: [{ orderId: orders[204].id, reason: 'Нет свободного интервала' }] }, versions: [], events: [], facts: [], factLog: [] };
  const report = shiftReportData(shift);
  assert.equal(report.analysis.assignmentRate, 99.5);
  assert.equal(report.analysis.windowRisks.length, 0);
  assert.equal(report.analysis.urgentOpen.length, 1);
  assert.equal(report.analysis.urgentOpen[0].status, 'В очереди');
});

test('AI receives a bounded shift snapshot and never controls numeric report data', async () => {
  const shift = { id: 'ai', date: '2026-08-17', regionId: 'moscow', revision: 1, orders: [order], team: [engineer], plan, versions: [{ version: 1, orders: [order] }], events: [], facts: [], factLog: [] };
  const result = await askShiftAi(shift, 'Сколько заявок назначено?', { apiKey: 'test-secret', folderId: 'test-folder', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion');
    const body = JSON.parse(options.body);
    assert.match(body.messages[1].text, /"assigned":1/);
    assert.match(body.messages[0].text, /Возможности BeeGo/);
    assert.equal(body.completionOptions.maxTokens, '700');
    return new Response(JSON.stringify({ result: { alternatives: [{ message: { text: 'Назначена 1 заявка.' } }], usage: { totalTokens: '30' } } }), { status: 200 });
  } });
  assert.equal(result.text, 'Назначена 1 заявка.');
  assert.equal(shiftReportData(shift).counts.assigned, 1);
  const contextual = await askShiftAi(shift, 'А кто это?', { apiKey: 'test-secret', folderId: 'test-folder', history: [{ role: 'user', text: 'Кто назначен?' }, { role: 'assistant', text: 'Бригада 1.' }], fetchImpl: async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    assert.deepEqual(messages.slice(-3).map(item => item.role), ['user', 'assistant', 'user']);
    assert.match(messages[1].text, /"assigned":1/);
    return new Response(JSON.stringify({ result: { alternatives: [{ message: { text: 'Бригада 1.' } }] } }), { status: 200 });
  } });
  assert.equal(contextual.text, 'Бригада 1.');
  await assert.rejects(askShiftAi(shift, 'Вопрос', { apiKey: '', folderId: '' }), /не настроен/);
});

test('AI monthly token reservation survives reads and enforces the configured ceiling', () => {
  const store = new ShiftStore(':memory:');
  try {
    assert.equal(store.reserveAiBudget('2026-08', 6000, 12000), true);
    assert.equal(store.reserveAiBudget('2026-08', 6000, 12000), true);
    assert.equal(store.reserveAiBudget('2026-08', 6000, 12000), false);
    store.settleAiBudget('2026-08', 6000, 420);
    assert.deepEqual(store.aiUsage('2026-08'), { used_tokens: 420, reserved_tokens: 6000 });
    store.settleAiBudget('2026-08', 6000, 700);
    assert.equal(store.aiUsage('2026-08').used_tokens, 1120);
    assert.equal(store.reserveAiBudget('2026-08', 6000, 12000), true);
  } finally { store.close(); }
});

test('background preview exposes real road-check progress before publication', async () => {
  let releaseRouting;
  const store = new ShiftStore(':memory:');
  const api = createOperationsApi({ store, routing: async (candidate, _base, _orders, _team, options) => {
    options.onProgress({ checkedRoads: 2 });
    await new Promise(resolve => { releaseRouting = resolve; });
    return { ...candidate, provider: 'TEST_EXACT_ROAD', publicationAllowed: true, approximateTravel: false, validation: { status: 'VALID', exactCheckedVisits: 2 } };
  } });
  try {
    const shift = store.ensure({ regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan });
    const response = await api.handle(request(`/api/shifts/${shift.id}/preview`, 'POST', { expectedRevision: 1, event: { type: 'VISIT_CANCELLED', orderId: order.id, time: '08:15', reason: 'Проверка прогресса' } }));
    const task = await response.json();
    await new Promise(resolve => setImmediate(resolve));
    const running = await (await api.handle(request(`/api/previews/${task.id}`))).json();
    assert.equal(running.status, 'RUNNING');
    assert.deepEqual(running.progress, { phase: 'ROAD_CHECK', checkedRoads: 2 });
    releaseRouting();
    await new Promise(resolve => setImmediate(resolve));
    const ready = await (await api.handle(request(`/api/previews/${task.id}`))).json();
    assert.equal(ready.status, 'READY');
    assert.equal(ready.progress.checkedRoads, 2);
  } finally { store.close(); }
});

for (const [datasetName, prefix] of [['исходной', 'base'], ['импортированной', 'import']]) {
  test(`операционные сценарии ${datasetName} смены сохраняют ревизии и различают отмены`, async () => {
    const baseOrder = { ...order, id: `${prefix}-job`, sourceId: `${prefix.toUpperCase()}-1` };
    const baseEngineer = { ...engineer, id: `${prefix}-crew`, name: `Бригада ${prefix}` };
    const basePlan = { ...plan, routes: [{ ...plan.routes[0], engineerId: baseEngineer.id, engineerName: baseEngineer.name, assignments: [{ ...plan.routes[0].assignments[0], orderId: baseOrder.id }] }] };
    const cases = [
      { type: 'ENGINEER_UNAVAILABLE', engineerId: baseEngineer.id, check: shift => assert.match(shift.team[0].status, /Недоступен/) },
      { type: 'ENGINEER_REPLACED', engineerId: baseEngineer.id, replacement: { ...baseEngineer, id: `${prefix}-replacement` }, check: shift => assert.equal(shift.team.length, 2) },
      { type: 'NEW_ORDER', order: { ...baseOrder, id: `${prefix}-urgent`, sourceId: `${prefix.toUpperCase()}-2`, coords: [55.751, 37.621], start: '11:00', end: '16:00' }, check: shift => assert.equal(shift.orders.length, 2) },
      { type: 'VISIT_CANCELLED', orderId: baseOrder.id, check: shift => assert.equal(shift.plan.unassigned.some(item => item.orderId === baseOrder.id), true) },
      { type: 'ORDER_CANCELLED', orderId: baseOrder.id, check: shift => { assert.equal(shift.orders.length, 0); assert.equal(shift.events[0].type, 'ORDER_CANCELLED'); } },
    ];
    for (const [index, scenario] of cases.entries()) {
      const store = new ShiftStore(':memory:');
      const api = createOperationsApi({ store, routing: async candidate => ({ ...candidate, provider: 'TEST_EXACT_ROAD', publicationAllowed: true, approximateTravel: false, validation: { status: 'VALID' } }) });
      try {
        const shift = store.ensure({ regionId: `moscow-${prefix}-${index}`, date: '2026-08-17', orders: [baseOrder], team: [baseEngineer], plan: basePlan });
        const event = { ...scenario, check: undefined, time: '08:15', reason: 'Приёмочный сценарий' };
        const queued = await (await api.handle(request(`/api/shifts/${shift.id}/preview`, 'POST', { expectedRevision: 1, event }))).json();
        await new Promise(resolve => setImmediate(resolve));
        const ready = await (await api.handle(request(`/api/previews/${queued.id}`))).json();
        assert.equal(ready.status, 'READY', ready.error);
        const published = await (await api.handle(request(`/api/shifts/${shift.id}/publish`, 'POST', { previewId: queued.id, expectedRevision: 1 }))).json();
        assert.equal(published.revision, 2);
        scenario.check(published);
        assert.equal(store.get(shift.id).revision, 2);
        assert.equal(shiftReportData(published).date, shift.date);
      } finally { store.close(); }
    }
  });
}

test('SQLite backup restores the published plan, event log and fact after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beego-shift-restore-'));
  const primary = join(directory, 'primary.sqlite3');
  const backup = join(directory, 'backup.sqlite3');
  const restored = join(directory, 'restored.sqlite3');
  let source;
  let recovery;
  try {
    source = new ShiftStore(primary);
    const initial = source.ensure({ regionId: 'moscow', date: '2026-08-17', orders: [order], team: [engineer], plan });
    const previewId = source.startPreview(initial.id, 1, { type: 'VISIT_CANCELLED', orderId: order.id, time: '08:15', reason: 'Перенос клиента' });
    source.completePreview(previewId, { orders: [order], team: [engineer], plan: { ...plan, routes: [{ ...plan.routes[0], assignments: [] }], unassigned: [{ orderId: order.id, reasonCode: 'VISIT_CANCELLED', reason: 'Перенос клиента' }] } });
    const published = source.publish(initial.id, previewId, 1);
    source.recordFact(initial.id, { orderId: order.id, status: 'not_completed', time: '09:10', reason: 'Клиент отменил' });
    await source.backup(backup);
    source.close(); source = null;
    await copyFile(backup, restored);
    recovery = new ShiftStore(restored);
    const shift = recovery.byDate('moscow', '2026-08-17');
    assert.equal(shift.id, initial.id);
    assert.equal(shift.revision, published.revision);
    assert.equal(shift.events[0].type, 'VISIT_CANCELLED');
    assert.equal(shift.facts[0].status, 'not_completed');
    assert.equal(shift.versions.length, 2);
    assert.equal(shift.plan.unassigned[0].orderId, order.id);
  } finally {
    source?.close();
    recovery?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new order cannot receive a fact before it entered the shift', () => {
  const store = new ShiftStore(':memory:');
  try {
    const empty = { ...plan, routes: [{ ...plan.routes[0], assignments: [] }], metrics: { total: 0, assigned: 0, unassigned: 0 } };
    const shift = store.ensure({ regionId: 'moscow', date: '2026-08-17', orders: [], team: [engineer], plan: empty });
    const previewId = store.startPreview(shift.id, 1, { type: 'NEW_ORDER', time: '12:00', reason: 'Новый заказ', order });
    store.completePreview(previewId, { orders: [order], team: [engineer], plan });
    store.publish(shift.id, previewId, 1);
    assert.throws(() => store.recordFact(shift.id, { orderId: order.id, status: 'started', time: '11:00' }), /раньше появления заявки/);
    assert.equal(store.recordFact(shift.id, { orderId: order.id, status: 'started', time: '12:30' }).facts[0].status, 'started');
  } finally { store.close(); }
});
