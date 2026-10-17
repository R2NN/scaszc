import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiftStore } from '../server/shiftStore.mjs';
import { calculateDuration } from '../server/durationModel.mjs';
import { savedFactDraft, updateFactDraft, visitFactDraft } from '../src/visitFactDraft.js';
import { addressIdentity, changeServiceLocation } from '../src/serviceLocation.js';
import { conditionVisitChoices, filterObjectGroup, standardVolumeLabel, summarizeObjectGroup, visibleVisitLimit, workComposition } from '../src/objectPresentation.js';
import { objectAttention } from '../server/complexityAttention.mjs';
import { isUrgentOrder, effectiveOrderSkill, isInformationalOrder, workPointType } from '../src/workTypes.js';
import { handleComplexity } from '../server/complexityApi.mjs';

const at = '2026-08-17T07:00:00+03:00';
const later = '2026-08-17T08:00:00+03:00';
const order = (objectId, factors = {}, workType = 'Локальная заявка') => ({ id: `next-${objectId}`, objectId, workType, durationFactors: factors });
const visit = (store, id, objectId, factors = {}, extra = {}) => {
  const forecast = store.estimate(order(objectId, factors), '2026-07-01T07:00:00+03:00');
  return store.recordVisit({ id, entities: forecast.entities, kind: forecast.kind, operation: forecast.operation, factorTechnical: forecast.factorTechnical, forecast, reason: 'diagnosis', eligible: true, excluded: false, actualTechnical: forecast.factorTechnical + 20, accessMinutes: 15, endedAt: '2026-07-10T12:00:00+03:00', knownAt: '2026-07-10T12:00:00+03:00', ...extra });
};
const fixture = context => {
  const database = new ShiftStore(':memory:');
  context.after(() => database.close());
  for (const id of ['A', 'B', 'C', 'D']) database.complexity.registerObject({ id, address: `Дом ${id}`, regionId: 'moscow' }, [
    { id: `${id}-node`, kind: 'node', objectId: id }, { id: `${id}-line`, kind: 'line', objectId: id },
  ]);
  return database.complexity;
};

test('unsaved fact fields stay with their order and shift; saved zeroes and unknown stages survive refresh', () => {
  const own = { time: '11:42', deviationReason: 'diagnosis', accessMinutes: 0, documentMinutes: null, comment: 'Собственная отметка' };
  const typed = { ...savedFactDraft(null), accessMinutes: '17', deviationReason: 'access', comment: 'Только 80308' };
  const drafts = updateFactDraft({}, 'shift1/80308', null, typed);
  assert.deepEqual(visitFactDraft(drafts, 'shift1/93276', own), savedFactDraft(own));
  assert.equal(visitFactDraft(drafts, 'shift1/93276', own).accessMinutes, 0);
  assert.equal(visitFactDraft(drafts, 'shift1/93276', own).documentMinutes, '');
  assert.equal(visitFactDraft(drafts, 'shift1/80308', null).comment, 'Только 80308');
  assert.equal(visitFactDraft(drafts, 'shift2/80308', null).comment, '');
  const refreshed = { ...own, comment: 'Уточнено на сервере' };
  assert.equal(visitFactDraft(drafts, 'shift1/93276', refreshed).comment, refreshed.comment);
  assert.equal(visitFactDraft({}, 'shift1/80308', refreshed).comment, refreshed.comment);
});

test('confirmed same-operation evidence transfers across objects, never across a different operation', context => {
  const store = fixture(context);
  for (const [index, id] of ['A', 'B', 'C'].entries()) visit(store, `v${index}`, id);
  store.decide({ visitId: 'v0', action: 'confirm', scope: 'operation', reason: 'Три измеренные одинаковые операции', at });
  for (const id of ['A', 'B', 'C', 'D']) assert.equal(store.estimate(order(id), later).historyMinutes, 8);
  assert.equal(store.estimate(order('D', { diagnosis: 'known' }), later).historyMinutes, 0);
  assert.equal(store.estimate(order('D'), '2026-08-16T07:00:00+03:00').historyMinutes, 0);
});

test('node access survives an unrelated change of work volume, but never affects a visit that skips the node', context => {
  const store = fixture(context);
  for (let index = 0; index < 3; index++) visit(store, `access${index}`, 'A', { requiresNode: true }, { entities: { object: 'A', node: 'A-node' }, reason: 'access' });
  store.decide({ visitId: 'access0', action: 'confirm', scope: 'node', reason: 'Доступ к шкафу по согласованию', at });
  const sameNode = { ...order('A', { requiresNode: true, devices: 3 }, 'Подключение'), serviceEntities: { object: 'A', node: 'A-node' } };
  assert.equal(store.estimate(sameNode, later).access, 6);
  assert.equal(store.estimate({ ...sameNode, durationFactors: { devices: 3 } }, later).access, 0);
  assert.equal(store.estimate(order('B', { requiresNode: true }), later).access, 0);
});

test('larger cable categories never shorten a visit; included standard work is not billed twice', () => {
  for (const workType of ['Подключение', 'Локальная заявка', 'Дозаказ', 'Аварийные работы']) {
    const durations = ['none', 'short', 'standard', 'large'].map(cable => calculateDuration({ workType, durationFactors: { cable } }, { asOf: at }).total);
    assert.deepEqual([...durations].sort((a, b) => a - b), durations, workType);
  }
  assert.equal(calculateDuration({ workType: 'Подключение', durationFactors: { cable: 'standard' } }, { asOf: at }).total, 70);
  assert.equal(calculateDuration({ workType: 'Подключение', durationFactors: { line: 'existing', cable: 'large' } }, { asOf: at }).total, 45);
  const emergency = cable => calculateDuration({ workType: 'Аварийные работы', durationFactors: { damage: 'cable', cable } }, { asOf: at }).total;
  assert.equal(emergency('standard'), emergency('none'));
  assert.ok(emergency('large') > emergency('standard'));
});

test('location edits clear old links and server rejects a mismatched address or map point', context => {
  const store = fixture(context);
  store.registerObject({ id: 'location', address: 'Город Москва, ул. Артюхиной, д. 20А', coords: [55.7, 37.7] });
  const linked = { ...order('location'), address: 'Москва улица Артюхиной дом 20А', coords: [55.7, 37.7], serviceEntities: { object: 'location' } };
  assert.equal(addressIdentity(linked.address), addressIdentity(store.object('location').address));
  assert.doesNotThrow(() => store.estimate(linked, at));
  assert.throws(() => store.prepareOrders([{ ...linked, address: 'Москва, Артюхиной, 18' }], at), /Адрес заявки/);
  assert.throws(() => store.prepareOrders([{ ...linked, coords: [55.9, 37.9] }], at), /Точка заявки/);
  const moved = changeServiceLocation(linked, { address: 'Москва, Артюхиной, 18' });
  assert.equal(moved.objectId, undefined);
  assert.equal(moved.serviceEntities, undefined);
});

test('decision revisions, clarification and exclusion have distinct lasting effects', context => {
  const store = fixture(context);
  for (let index = 0; index < 3; index++) visit(store, `one${index}`, 'A', {}, { entities: { object: 'A', line: 'A-line' } });
  const next = { ...order('A'), serviceEntities: { object: 'A', line: 'A-line' } };
  store.decide({ visitId: 'one0', action: 'confirm', scope: 'line', reason: 'Повторяется на этой линии', at });
  const before = store.estimate(next, at);
  assert.equal(before.historyMinutes, 8);
  store.decide({ visitId: 'one0', action: 'visit', reason: 'Установлен разовый случай', at: later });
  assert.equal(store.estimate(next, later).historyMinutes, 0);
  assert.equal(store.visits(later).find(item => item.id === 'one0').eligible, true);
  assert.equal(store.visits(at).find(item => item.id === 'one0').learningDecision, 'confirmed');
  assert.equal(store.estimate(next, at).historyMinutes, 8);
  store.reviseVisit('one0', { deviationReason: 'unknown', finding: 'Причина ещё проверяется', reason: 'Получены противоречивые сведения', at: later });
  assert.equal(store.visits(later).find(item => item.id === 'one0').reason, 'unknown');
  store.reviseVisit('one0', { deviationReason: 'diagnosis', finding: 'Нестабильный контакт в муфте линии', preparation: 'Взять запасной коннектор', reason: 'Получен акт проверки линии', at: later });
  assert.equal(store.estimate(next, later).historyMinutes, 0);
  assert.throws(() => store.decide({ visitId: 'one0', action: 'confirm', scope: 'line', reason: 'Только одно уточнение', at: later }), /Недостаточно/);
  for (const id of ['one1', 'one2']) store.reviseVisit(id, { deviationReason: 'diagnosis', finding: 'Нестабильный контакт в муфте линии', preparation: 'Взять запасной коннектор', reason: 'Получен акт проверки линии', at: later });
  store.decide({ visitId: 'one0', action: 'confirm', scope: 'line', reason: 'Причина подтверждена актом', at: later });
  assert.equal(store.estimate(next, later).historyMinutes, 8);
  store.decide({ visitId: 'one0', action: 'reject', reason: 'Отклонить перенос причины', at: later });
  assert.equal(store.estimate(next, later).historyMinutes, 0);
  assert.equal(store.visits(later).find(item => item.id === 'one0').excluded, false);
  store.reviseVisit('one1', { excluded: true, reason: 'Ошибочное измерение', at: later });
  assert.equal(store.visits(later).find(item => item.id === 'one1').excluded, true);
  assert.ok(store.history('A').some(item => item.actor && item.before && item.after));
});

test('group medians never mix work types or volumes; missing evidence stays separate', () => {
  const rows = [
    { kind: 'local', delta: 10, estimate: { operation: 'one', histories: [{}] } },
    { kind: 'local', delta: 30, estimate: { operation: 'one', histories: [{}] } },
    { kind: 'local', delta: 90, insufficient: true, estimate: { operation: 'one' } },
    { kind: 'local', delta: 100, estimate: { operation: 'two' } },
    { kind: 'connection', delta: -20, estimate: { operation: 'one' } },
  ];
  const groups = summarizeObjectGroup(rows);
  assert.equal(groups.length, 3);
  const local = groups.find(group => group.kind === 'local' && group.operation === 'one');
  assert.equal(local.medianDelta, 20);
  assert.equal(local.increased, 2);
  assert.equal(local.unknown, 1);
  assert.equal(local.confirmed, 2);
});

test('attention follows repeated impact and decisions, independently of object ID', () => {
  const rows = id => Array.from({ length: 3 }, (_, index) => ({ id: `${id}-${index}`, entities: { object: id }, kind: 'local', operation: 'same', endedAt: '2026-08-10T12:00:00+03:00', reason: 'diagnosis', forecast: { technical: 30 }, actualTechnical: id === 'Z' ? 60 : 42, eligible: true }));
  const weak = objectAttention({ id: 'A', examples: [{}] }, rows('A'), at);
  const strong = objectAttention({ id: 'Z', examples: [{}] }, rows('Z'), at);
  assert.ok(strong.score > weak.score);
  assert.equal(objectAttention({ id: 'Z', examples: [{}] }, rows('Z'), at, () => ({ operation: 'different' })).currentOrders, 0);
  assert.equal(objectAttention({ id: 'Z', examples: [{}] }, rows('Z'), at, () => ({ operation: 'same' })).currentOrders, 1);
  assert.equal(objectAttention({ id: 'Z' }, rows('Z').map(visit => ({ ...visit, learningDecision: 'rejected' })), at), null);
  assert.equal(objectAttention({ id: 'Z' }, rows('Z').map(visit => ({ ...visit, excluded: true })), at), null);
});

test('information needs emergency qualification while urgency follows only explicit priority', () => {
  const info = { workType: 'Глобальная проблема', serviceType: 'Информация', skill: 'EMERGENCY', priority: 'NORMAL' };
  assert.equal(isUrgentOrder(info), false);
  assert.equal(isInformationalOrder(info), true);
  assert.equal(effectiveOrderSkill(info), 'Аварийные работы');
  assert.equal(workPointType(info), 'other');
  assert.equal(isUrgentOrder({ ...info, priority: 'URGENT' }), true);
});

test('late clarification is visible in review while the historical estimate keeps its cutoff', async context => {
  const store = fixture(context);
  visit(store, 'fact', 'A', {}, { reason: 'unknown' });
  const before = store.estimate(order('A'), at);
  store.reviseVisit('fact', { deviationReason: 'diagnosis', finding: 'Контакт проверен актом', reason: 'Поздний акт', at: '2026-08-18T12:00:00+03:00' });
  const historical = await (await handleComplexity(new Request(`http://localhost/api/complexity/objects/A?at=${encodeURIComponent(at)}`), store)).json();
  const review = await (await handleComplexity(new Request(`http://localhost/api/complexity/objects/A?at=${encodeURIComponent(at)}&review=current`), store)).json();
  assert.equal(historical.visits[0].reason, 'unknown');
  assert.equal(review.visits[0].reason, 'diagnosis');
  assert.equal(review.visits[0].learningDecision, 'pending');
  assert.equal(review.estimate.total, before.total);
  assert.deepEqual(historical.estimate, review.estimate);
});

test('a late exclusion changes current analytics without rewriting the historical report', async context => {
  const store = fixture(context);
  visit(store, 'late-error', 'A', {}, { source: 'dispatcher' });
  assert.equal(store.accuracy(at).count, 1);
  store.reviseVisit('late-error', { excluded: true, reason: 'Получен исправленный акт', at: '2026-08-18T12:00:00+03:00' });
  assert.equal(store.accuracy(at).count, 1);
  const current = await (await handleComplexity(new Request(`http://localhost/api/complexity/accuracy?at=${encodeURIComponent(at)}&review=current`), store)).json();
  assert.equal(current.count, 0);
  assert.equal(store.visits().find(item => item.id === 'late-error').eligible, true);
});

test('a shared condition exposes its foreign source visit and can be revised from another object', async context => {
  const store = fixture(context);
  for (const [index, id] of ['A', 'B', 'C'].entries()) visit(store, `shared-${index}`, id);
  const condition = store.decide({ visitId: 'shared-0', action: 'confirm', scope: 'operation', reason: 'Подтверждено на трёх адресах', at });
  const payload = await (await handleComplexity(new Request(`http://localhost/api/complexity/objects/B?at=${encodeURIComponent(at)}&kind=local`), store)).json();
  const shared = payload.conditions.find(item => item.id === condition.id);
  const choices = conditionVisitChoices(payload.visits, shared, 'local');
  const source = choices.find(item => item.id === 'shared-0');
  assert.equal(source.entities.object, 'A');
  assert.ok(source.forecast && Number.isFinite(source.actualTechnical));
  assert.equal(choices.filter(item => item.id === 'shared-1').length, 1);
  const response = await handleComplexity(new Request('http://localhost/api/complexity/decisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitId: source.id, action: 'confirm', scope: shared.scope, replacesConditionId: shared.id, finding: 'Уточнённое описание', preparation: 'Взять прибор', reason: 'Уточнение общей особенности', at: later }) }), store);
  assert.equal(response.status, 200);
  const revised = await response.json();
  assert.equal(revised.scope, 'operation');
  assert.equal(revised.finding, 'Уточнённое описание');
  assert.equal(revised.preparation, 'Взять прибор');
  assert.equal(store.conditions('B').find(item => item.id === condition.id).closedAt, later);
  assert.equal(store.estimate(order('B'), at).historyMinutes, store.estimate(order('B'), later).historyMinutes);
});

test('a linked historical visit is rendered immediately and more pagination continues after it', () => {
  const rows = Array.from({ length: 14 }, (_, index) => ({ id: `visit-${index}` }));
  assert.equal(visibleVisitLimit(rows, 'visit-11', 5), 12);
  assert.equal(visibleVisitLimit(rows, 'visit-11', 17), 17);
  assert.equal(visibleVisitLimit(rows, 'missing', 5), 5);
});

test('group actions filter identical addresses without mixing composition or missing measurements', () => {
  const rows = [{ id: 'A', kind: 'local', delta: 20, estimate: { operation: 'one' } }, { id: 'B', kind: 'local', delta: 35, insufficient: true, estimate: { operation: 'one' } }, { id: 'C', kind: 'connection', delta: 30, estimate: { operation: 'two' } }];
  assert.deepEqual(filterObjectGroup(rows, 'slower').map(item => item.id), ['A', 'C']);
  assert.deepEqual(filterObjectGroup(rows, 'unknown').map(item => item.id), ['B']);
  assert.deepEqual(filterObjectGroup(rows, 'all', 'local/one').map(item => item.id), ['A', 'B']);
  assert.deepEqual(filterObjectGroup(rows, 'slower', 'local/one').map(item => item.id), ['A']);
  for (const kind of ['local', 'emergency', 'information']) assert.doesNotMatch(standardVolumeLabel(kind), /устройство|точка/);
  assert.match(standardVolumeLabel('connection'), /устройство.*точка/);
  assert.match(workComposition({ kind: 'emergency', factors: { damage: 'cable', nodeSearch: true } }), /Восстановление кабеля.*Поиск узла/);
  assert.doesNotMatch(workComposition({ kind: 'local', factors: {} }), /устр\.|точ\./);
  assert.notEqual(workComposition({ kind: 'emergency', factors: { damage: 'cable' } }), workComposition({ kind: 'emergency', factors: { damage: 'equipment' } }));
});

test('mean overrun uses only overrunning visits, independently for each work type', context => {
  const store = fixture(context);
  for (const [index, actualTechnical] of [40, 60, 20, 30].entries()) visit(store, `mean-${index}`, 'A', {}, { actualTechnical, source: 'dispatcher' });
  const accuracy = store.accuracy(at);
  assert.equal(accuracy.count, 4);
  assert.equal(accuracy.underestimated, 2);
  assert.equal(accuracy.underMinutes, 20);
  assert.equal(accuracy.overestimated, 1);
  assert.equal(accuracy.overMinutes, 10);
  assert.equal(accuracy.byKind.find(item => item.kind === 'local').underMinutes, 20);
  assert.equal(accuracy.byKind.find(item => item.kind === 'connection').underMinutes, null);
});
