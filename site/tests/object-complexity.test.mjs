import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { calculateDuration, DEFAULT_MODEL, WORK_RULES } from '../server/durationModel.mjs';
import { seedComplexity } from '../server/complexitySeed.mjs';
import { handleComplexity } from '../server/complexityApi.mjs';
import { parseDurationImport } from '../src/durationImport.js';
import { readFile } from 'node:fs/promises';
import { createOperationsApi } from '../server/operationsApi.mjs';
import { handleExactPlanning } from '../server/exactPlanningApi.mjs';

const at = '2026-08-17T07:00:00+03:00';
const order = { id: 'A', workType: 'Подключение', durationFactors: { line: 'existing' } };
const entities = { object: 'house', entrance: 'entrance-1', node: 'node-1', line: 'line-1' };
const fixture = (residual = 20, amount = 6) => {
  const base = calculateDuration({ ...order, durationFactors: { requiresNode: true } }, { asOf: at, entities });
  const visits = Array.from({ length: amount }, (_, index) => ({ id: `V-${index}`, revision: 1, kind: base.kind, operation: base.operation, entities, reason: 'diagnosis', eligible: true, excluded: false, actualTechnical: base.factorTechnical + residual, factorTechnical: base.factorTechnical, endedAt: `2026-07-${String(10 + index).padStart(2, '0')}T12:00:00+03:00`, knownAt: `2026-07-${String(10 + index).padStart(2, '0')}T12:00:00+03:00`, forecast: base }));
  const conditions = [{ id: 'C', scope: 'node', entityId: 'node-1', kind: base.kind, operation: base.operation, reason: 'diagnosis', component: 'technical', status: 'confirmed', knownAt: '2026-07-20T12:00:00+03:00', validFrom: '2026-07-20T12:00:00+03:00' }];
  return { base, visits, conditions, entities, asOf: at };
};

test('all original subtypes retain their technical and paperwork norms, without travel', () => {
  assert.equal(WORK_RULES.length, 21);
  for (const rule of WORK_RULES) {
    const result = calculateDuration({ workType: rule.workType, serviceType: rule.serviceType }, { asOf: at });
    assert.equal(result.baseTechnical, rule.technical);
    assert.equal(result.documents, rule.documents);
    assert.equal(result.total, rule.technical + rule.documents);
  }
  const information = calculateDuration({ workType: 'Глобальная проблема', serviceType: 'Информация', equipment: 'CABLE_SET' });
  assert.equal(information.kind, 'information');
});

test('K varies both ways; devices, sites, paperwork and cable affect the appropriate component', () => {
  const simple = calculateDuration(order);
  const base = calculateDuration({ ...order, durationFactors: {} });
  const complex = calculateDuration({ ...order, durationFactors: { devices: 4, sites: 3, cable: 'large' } });
  assert.ok(simple.coefficient < 1); assert.equal(base.coefficient, 1); assert.ok(complex.coefficient > 1);
  assert.equal(simple.documents, 10); assert.equal(complex.documents, 10);
  assert.ok(complex.total > 100);
  const equipment = calculateDuration({ workType: 'Дозаказ', durationFactors: { firmwareRequired: true, devices: 2 } });
  assert.equal(equipment.technical, 33); assert.equal(equipment.documents, 10);
  assert.ok(calculateDuration({ workType: 'Дозаказ', durationFactors: { cable: 'short' } }).total > 20);
  const large = calculateDuration({ ...order, durationFactors: { devices: 100, sites: 50, points: 100 } });
  assert.ok(large.total > 1000, 'confirmed volume is not silently clipped');
  assert.throws(() => calculateDuration({ ...order, durationFactors: { devices: Infinity } }));
  assert.throws(() => calculateDuration({ ...order, durationFactors: { devices: true } }));
});

test('conservative history works both ways, is idempotent, scoped and excludes future/unknown evidence', () => {
  for (const sign of [-1, 1]) {
    const context = fixture(sign * 20);
    const input = { ...order, durationFactors: { requiresNode: true } };
    const prediction = calculateDuration(input, context);
    assert.equal(Math.sign(prediction.historyMinutes), sign);
    assert.deepEqual(calculateDuration({ ...input, duration: prediction.total }, context), prediction);
    assert.equal(calculateDuration(input, { ...context, visits: [...context.visits, context.visits[0]] }).historyMinutes, prediction.historyMinutes);
    assert.equal(calculateDuration(input, { ...context, visits: context.visits.slice(0, 1) }).historyMinutes, 0);
    assert.equal(calculateDuration(input, { ...context, entities: { ...entities, node: 'node-2' } }).historyMinutes, 0);
    assert.equal(calculateDuration({ ...input, durationFactors: {} }, context).historyMinutes, 0);
    assert.equal(calculateDuration(input, { ...context, visits: context.visits.map(v => ({ ...v, reason: 'unknown' })) }).historyMinutes, 0);
    assert.equal(calculateDuration(input, { ...context, visits: context.visits.map(v => ({ ...v, knownAt: '2026-09-01T12:00:00+03:00' })) }).historyMinutes, 0);
    assert.equal(calculateDuration(input, { ...context, visits: context.visits.map(v => ({ ...v, excluded: true })) }).historyMinutes, 0);
    assert.equal(calculateDuration(input, { ...context, conditions: context.conditions.map(c => ({ ...c, closedAt: '2026-08-16T12:00:00+03:00' })) }).historyMinutes, 0);
    assert.equal(calculateDuration(input, { ...context, conditions: context.conditions.map(c => ({ ...c, validUntil: '2026-08-16T12:00:00+03:00' })) }).historyMinutes, 0);
    const outlier = { ...context.visits[0], id: 'outlier', actualTechnical: 10000 };
    assert.equal(calculateDuration(input, { ...context, visits: [...context.visits, outlier] }).historyMinutes, prediction.historyMinutes);
  }
});

test('measured access is separate from technical K and cannot count twice', () => {
  const context = fixture(0);
  context.visits = context.visits.map(v => ({ ...v, reason: 'access', accessMinutes: 20 }));
  context.conditions = context.conditions.map(c => ({ ...c, reason: 'access', component: 'access' }));
  const result = calculateDuration({ ...order, durationFactors: { requiresNode: true } }, context);
  assert.equal(result.coefficient, 1); assert.ok(result.access > 0);
  assert.equal(result.total, result.technical + result.access + result.documents);
});

test('equivalent timezone offsets cannot disclose future history or model revisions', () => {
  const store = new ShiftStore(':memory:');
  try {
    const context = fixture();
    store.complexity.recordVisit({ ...context.visits[0], knownAt: '2026-08-17T09:00:00+03:00' });
    assert.equal(store.complexity.visits('2026-08-17T05:59:00Z').length, 0);
    assert.equal(store.complexity.visits('2026-08-17T06:00:00Z').length, 1);
    const before = store.complexity.model();
    store.complexity.saveModel({ ...before, expectedVersion: before.version, effectiveAt: '2026-08-17T09:00:00+03:00', reason: 'Проверка часовых поясов' });
    assert.equal(store.complexity.model('2026-08-17T05:59:00Z').version, before.version);
    const future = { ...context, asOf: '2026-07-20T08:59:00Z' };
    assert.equal(calculateDuration({ ...order, durationFactors: { requiresNode: true } }, future).historyMinutes, 0);
  } finally { store.close(); }
});

test('scope correction closes the previous condition and changes only a future matching entity', () => {
  const store = new ShiftStore(':memory:');
  try {
    const context = fixture();
    context.visits.forEach(visit => store.complexity.recordVisit(visit));
    const input = { visitId: context.visits[0].id, action: 'confirm', scope: 'node', reason: 'Повторяемая диагностика узла', at };
    const before = store.complexity.decide(input);
    const after = store.complexity.decide({ ...input, scope: 'line', replacesConditionId: before.id, at: '2026-08-17T08:00:00+03:00', reason: 'Уточнена конкретная линия' });
    const conditions = store.complexity.conditions();
    assert.equal(conditions.find(item => item.id === before.id).closedAt, '2026-08-17T08:00:00+03:00');
    const next = { ...context, conditions, asOf: '2026-08-17T09:00:00+03:00' };
    const forecast = calculateDuration({ ...order, durationFactors: { requiresNode: true } }, next);
    assert.equal(forecast.histories[0].conditionId, after.id);
    assert.equal(calculateDuration({ ...order, durationFactors: { requiresNode: true } }, { ...next, entities: { ...entities, line: 'line-2' } }).historyMinutes, 0);
    store.complexity.closeCondition(after.id, { at: '2026-08-17T10:00:00+03:00', reason: 'Неисправность устранена' });
    assert.equal(calculateDuration({ ...order, durationFactors: { requiresNode: true } }, { ...next, conditions: store.complexity.conditions(), asOf: '2026-08-17T11:00:00+03:00' }).historyMinutes, 0);
    assert.equal(forecast.total, forecast.calculatedTotal);
  } finally { store.close(); }
});

test('immutable snapshots, manual override reasons, and server plan receipts reject tampering', () => {
  const store = new ShiftStore(':memory:');
  try {
    const [prepared] = store.complexity.prepareOrders([{ ...order, duration: 1, durationOverride: { minutes: 82, reason: 'Согласован расширенный объём' } }], at);
    assert.equal(prepared.duration, 82);
    assert.equal(store.complexity.prepareOrders([prepared], at)[0].duration, 82);
    assert.throws(() => store.complexity.prepareOrders([{ ...prepared, duration: 1 }], at, { preserve: true }));
    assert.throws(() => store.complexity.prepareOrders([{ ...order, durationOverride: { minutes: 3 } }], at));
    const plan = { routes: [{ assignments: [{ orderId: order.id, plannedStart: '10:00', plannedFinish: '11:22' }] }], contentSha256: 'server-plan' };
    store.complexity.authorizePlan([prepared], [], plan);
    store.complexity.requirePlanReceipt([prepared], [], plan);
    assert.throws(() => store.complexity.requirePlanReceipt([{ ...prepared, durationSnapshot: undefined }], [], plan));
    assert.throws(() => store.complexity.requirePlanReceipt([prepared], [], { ...plan, routes: [] }));
  } finally { store.close(); }
});

test('SQLite migration, immutable history revisions, restart and model versioning preserve old forecasts', () => {
  const directory = mkdtempSync(join(process.cwd(), '../runtime/qa/migration-'));
  const file = join(directory, 'shifts.sqlite3');
  let store = new ShiftStore(file);
  const original = store.complexity.prepareOrders([order], at)[0];
  const context = fixture();
  store.complexity.recordVisit(context.visits[0], 'Первичный факт');
  store.complexity.recordVisit({ ...context.visits[0], excluded: true, knownAt: '2026-08-16T12:00:00+03:00' }, 'Ошибка этапа');
  assert.equal(store.complexity.visits('2026-08-01T12:00:00+03:00')[0].excluded, false);
  assert.equal(store.complexity.visits(at)[0].excluded, true);
  const before = store.complexity.model();
  const after = store.complexity.saveModel({ ...before, norms: { ...before.norms, connection: [90, 10] }, expectedVersion: before.version, effectiveAt: '2026-08-18T07:00:00+03:00', reason: 'Калибровка по пригодным этапам' });
  assert.notEqual(before.version, after.version);
  assert.equal(store.complexity.estimate(order, at).baseTechnical, 60);
  assert.equal(store.complexity.estimate(order, '2026-08-19T07:00:00+03:00').baseTechnical, 90);
  store.close(); store = new ShiftStore(file);
  assert.deepEqual(store.complexity.snapshot(original.durationSnapshot.id), original.durationSnapshot);
  assert.equal(store.complexity.visits(at)[0].excluded, true);
  store.close(); rmSync(directory, { recursive: true });
});

test('unknown stages never become exact technical measurements; performer remains bound to visit', () => {
  const store = new ShiftStore(':memory:');
  try {
    const [prepared] = store.complexity.prepareOrders([order], at);
    const shift = { id: 'S', date: '2026-08-17', orders: [prepared], plan: { routes: [{ engineerId: 'engineer-1', assignments: [{ orderId: 'A' }] }] } };
    store.complexity.recordShiftFact(shift, { orderId: 'A', status: 'completed', time: '10:45', startedAt: '10:00', deviationReason: 'unknown' }, null);
    assert.equal(store.complexity.visits()[0].eligible, false);
    assert.equal(store.complexity.visits()[0].actualTechnical, null);
    shift.plan.routes[0].engineerId = 'engineer-2';
    store.complexity.recordShiftFact(shift, { orderId: 'A', status: 'completed', time: '10:45', startedAt: '10:00', accessMinutes: 0, documentMinutes: 10, customerMinutes: 0, deviationReason: 'unknown', correctionReason: 'Этапы уточнены' }, null);
    assert.equal(store.complexity.visits()[0].actualTechnical, 35);
    assert.equal(store.complexity.visits()[0].engineerId, 'engineer-1');
  } finally { store.close(); }
});

test('imported factors and overrides validate without a competing client formula', () => {
  assert.deepEqual(parseDurationImport('{"devices":2,"line":"existing"}', 'durationFactors'), { devices: 2, line: 'existing' });
  for (const value of ['[]', '{"devices":0}', '{"foo":4}', '{bad json}']) assert.throws(() => parseDurationImport(value, 'durationFactors'));
  assert.throws(() => parseDurationImport('{"minutes":5}', 'durationOverride'));
  assert.equal(parseDurationImport('', 'durationFactors'), undefined);
});

test('independent holdout quality is reported across multiple reproducible seeds', async () => {
  for (const seed of [17082026, 17082027, 17082028]) {
    const store = new ShiftStore(':memory:');
    try {
      const manifest = await seedComplexity(store.complexity, { seed });
      const accuracy = store.complexity.accuracy(at);
      assert.equal(manifest.objects, 195);
      assert.ok(accuracy.count > 150);
      assert.ok(accuracy.mae < accuracy.fixedMae, JSON.stringify({ seed, ...accuracy }));
      for (const visit of store.complexity.visits()) assert.ok(visit.forecast.asOf < visit.endedAt);
      const ends = new Map();
      for (const visit of store.complexity.visits().filter(visit => visit.startedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
        assert.equal((Date.parse(visit.endedAt) - Date.parse(visit.startedAt)) / 60000, visit.total);
        const key = `${visit.engineerId}/${visit.startedAt.slice(0, 10)}`;
        assert.ok(!ends.has(key) || ends.get(key) <= visit.startedAt);
        ends.set(key, visit.endedAt);
      }
      assert.ok(store.complexity.visits().some(visit => visit.excluded));
      assert.ok(store.complexity.visits().some(visit => visit.revision > 1));
      assert.equal(store.complexity.accuracy(at, '', 'another-region').count, 0);
      const response = await handleComplexity(new Request('http://localhost/api/complexity/objects?kind=local&zone=EAST'), store.complexity);
      const objects = await response.json();
      assert.ok(objects.length); assert.ok(objects.every(object => object.zoneId === 'EAST'));
    } finally { store.close(); }
  }
});

test('fresh production store uses the variable-duration plan and rejects forged publication', async () => {
  const store = new ShiftStore(':memory:');
  const api = createOperationsApi({ store, seedFromBase: true });
  try {
    const shift = await (await api.handle(new Request('http://localhost/api/shifts?regionId=moscow&date=2026-08-17'))).json();
    assert.equal(shift.plan.metrics.assigned, 193);
    for (const visit of shift.plan.routes.flatMap(route => route.assignments)) {
      const order = shift.orders.find(order => order.id === visit.orderId);
      const minute = clock => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
      assert.equal(minute(visit.plannedFinish) - minute(visit.plannedStart), order.durationSnapshot.total);
    }
    const candidate = JSON.parse(await readFile(new URL('../public/data/beego-complexity-plan.json', import.meta.url), 'utf8'));
    const response = await handleExactPlanning(new Request('http://localhost/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(candidate) }), { complexity: store.complexity });
    assert.equal(response.status, 200);
    const plan = await response.json();
    assert.equal(plan.metrics.assigned, 193);
    store.complexity.requirePlanReceipt(plan.durationOrders, candidate.engineers, plan);
    const forged = await api.handle(new Request('http://localhost/api/shifts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ regionId: 'moscow', date: '2026-08-17', orders: plan.durationOrders.map(order => ({ ...order, duration: 1, durationSnapshot: undefined })), team: candidate.engineers, plan }) }));
    assert.equal(forged.status, 422);
    assert.equal(store.byDate('moscow', '2026-08-17').revision, 1);
  } finally { store.close(); }
});
