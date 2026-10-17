import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiftStore } from '../server/shiftStore.mjs';
import { handleComplexity } from '../server/complexityApi.mjs';
import { workKind, manualDurationInput } from '../src/durationKind.js';
import { changeServiceEntity, changeServiceLocation, resolveServiceEntities, selectServiceObject } from '../src/serviceLocation.js';
import { factLearningStatus, factOrderOptions, savedFactDraft, updateFactDraft, visitFactDraft } from '../src/visitFactDraft.js';
import { objectTimeExplanation } from '../src/objectPresentation.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const at = '2026-08-17T07:00:00+03:00';
const estimate = async (registry, order, persist) => {
  const response = await handleComplexity(new Request('http://local/api/complexity/estimate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order, persist, asOf: at }) }), registry);
  assert.equal(response.status, 200);
  return response.json();
};

test('manual preview and saved forecast agree for emergency priority, normal priority and volume', async context => {
  const store = new ShiftStore(':memory:'); context.after(() => store.close());
  for (const [priority, expected] of [['Обычная', 70], ['Авария', 80]]) {
    const input = manualDurationInput({ sourceId: '74198', skill: 'Подключение', priority });
    const preview = await estimate(store.complexity, { id: '74198', ...input }, false);
    const saved = await estimate(store.complexity, { id: 'moscow:74198', ...input }, true);
    assert.equal(preview.snapshot.total, expected);
    assert.equal(saved.order.duration, preview.snapshot.total);
    assert.equal(saved.snapshot.kind, preview.snapshot.kind);
    assert.equal(workKind(input), priority === 'Авария' ? 'emergency' : 'connection');
  }
  const input = manualDurationInput({ sourceId: 'another', skill: 'Подключение', priority: 'Обычная', durationFactors: { devices: 3, points: 2 } });
  const preview = await estimate(store.complexity, { id: 'preview', ...input }, false);
  const saved = await estimate(store.complexity, { id: 'persisted', ...input }, true);
  assert.equal(saved.snapshot.total, 98);
  assert.equal(saved.snapshot.total, preview.snapshot.total);
});

test('registry selection replaces territory and old links; unique hierarchy resolves without guessing', () => {
  const selected = selectServiceObject({ zone: 'Восток', objectId: 'old', serviceEntities: { object: 'old', node: 'wrong' } }, { id: 'B', address: 'Булатниковская, 4 к 1', coords: [55.5, 37.6], zone: 'Юго-восток', zoneId: 'SE' });
  assert.equal(selected.zone, 'Юго-восток');
  assert.equal(selected.objectZone, 'Юго-восток');
  assert.equal(selected.locationSource, 'registry');
  assert.deepEqual(selected.serviceEntities, { object: 'B' });
  const entities = [{ id: 'e1', kind: 'entrance' }, { id: 'n1', kind: 'node', entranceId: 'e1' }, { id: 'l1', kind: 'line', nodeId: 'n1' }];
  assert.deepEqual(resolveServiceEntities('B', entities), { object: 'B', entrance: 'e1', node: 'n1', line: 'l1' });
  const ambiguous = [...entities, { id: 'e2', kind: 'entrance' }, { id: 'n2', kind: 'node', entranceId: 'e2' }, { id: 'l2', kind: 'line', nodeId: 'n2' }];
  assert.deepEqual(resolveServiceEntities('B', ambiguous), { object: 'B' });
  assert.deepEqual(changeServiceEntity('B', ambiguous, { entrance: 'e1', node: 'n1', line: 'l1' }, 'entrance', 'e2'), { object: 'B', entrance: 'e2', node: 'n2', line: 'l2' });
  assert.deepEqual(changeServiceEntity('B', ambiguous, { entrance: 'e1', node: 'n1', line: 'l1' }, 'line', 'l2'), { object: 'B', entrance: 'e2', node: 'n2', line: 'l2' });
  const moved = changeServiceLocation(selected, { address: 'Другой дом' });
  assert.equal(moved.objectId, undefined);
  assert.equal(moved.objectZone, undefined);
});

test('unknown measurements and explicit zero remain different in saved visit and readiness', context => {
  const store = new ShiftStore(':memory:'); context.after(() => store.close());
  const [order] = store.complexity.prepareOrders([{ id: 'A', workType: 'Подключение' }], at);
  const shift = { id: 'S', date: '2026-08-17', orders: [order], plan: { routes: [{ engineerId: 'E', assignments: [{ orderId: 'A' }] }] } };
  const started = { orderId: 'A', status: 'started', time: '10:00', accessMinutes: '17', comment: 'Доступ по ключу' };
  assert.throws(() => store.complexity.recordShiftFact(shift, { ...started, accessMinutes: 1500 }, null), /Время этапа/);
  assert.doesNotThrow(() => store.complexity.recordShiftFact(shift, started, null));
  assert.equal(store.complexity.visits()[0].accessMinutes, 17);
  const completed = { ...started, startedAt: '10:00', status: 'completed', time: '11:10' };
  store.complexity.recordShiftFact(shift, completed, started);
  assert.equal(store.complexity.visits()[0].eligible, false);
  assert.equal(store.complexity.visits()[0].actualTechnical, null);
  assert.deepEqual(factLearningStatus(completed).missing, ['оформление', 'ожидание клиента']);
  const measured = { ...completed, documentMinutes: 0, customerMinutes: 0 };
  store.complexity.recordShiftFact(shift, measured, started);
  assert.equal(store.complexity.visits()[0].actualTechnical, 53);
  assert.equal(store.complexity.visits()[0].eligible, true);
  assert.equal(factLearningStatus(measured).eligible, true);
  store.complexity.recordShiftFact(shift, { ...measured, startedAt: null }, null);
  assert.equal(store.complexity.visits()[0].eligible, false);
  assert.equal(factLearningStatus({ ...measured, startedAt: null }).eligible, false);
});

test('fact choices expose searchable visit identity and retain independent drafts', () => {
  const options = factOrderOptions([{ id: 'A', sourceId: 'EAST-74198', sourceData: { source_job_id: '74198' }, address: 'Волгоградский, 128 к 5', workType: 'Подключение' }], { routes: [{ engineerName: 'Бригада Гусаковский', assignments: [{ orderId: 'A' }] }] }, [{ orderId: 'A', status: 'started' }]);
  assert.match(options[0].label, /^№74198/);
  assert.match(`${options[0].label} ${options[0].hint}`, /74198.*Волгоградский.*Подключение.*Гусаковский.*Начата/);
  const draft = { ...savedFactDraft(null), accessMinutes: '17', comment: 'Ключ у охраны' };
  const drafts = updateFactDraft({}, 'S/date/A', null, draft);
  assert.deepEqual(visitFactDraft(drafts, 'S/date/A', { accessMinutes: 0 }), draft);
  assert.equal(visitFactDraft(drafts, 'S/date/B', null).comment, '');
});

test('map explanation separates extra scope, history and access, including reductions and overrides', () => {
  assert.equal(objectTimeExplanation({ baseTechnical: 30, factorTechnical: 56, technical: 66, access: 0 }), 'Объём +26 мин · История +10 мин');
  assert.equal(objectTimeExplanation({ baseTechnical: 60, factorTechnical: 35, technical: 40, access: 6 }), 'Объём −25 мин · История +5 мин · Доступ +6 мин');
  assert.equal(objectTimeExplanation({ baseTechnical: 30, factorTechnical: 30, technical: 30, access: 0 }), '');
  assert.equal(objectTimeExplanation({ override: { minutes: 99 }, total: 99 }), 'Время задано вручную: 99 мин');
});

test('new-order form opens without a selected object and visit status exposes missing measurements', async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { ManualEntryModal } = await vite.ssrLoadModule('/src/ManualEntryModal.jsx');
    const { DurationFields, DurationFactFields } = await vite.ssrLoadModule('/src/ComplexityWorkspace.jsx');
    const html = renderToStaticMarkup(createElement(ManualEntryModal, { type: 'orders', zones: ['Восток'], date: new Date('2026-08-17'), onClose() {}, onSave() {} }));
    assert.match(html, /Адрес или объект/);
    assert.doesNotMatch(html, /Объект для новой заявки/);
    const unsupported = renderToStaticMarkup(createElement(DurationFields, { form: { skill: 'Неподдерживаемая работа' }, onChange() {} }));
    assert.match(unsupported, /поддерживаемый вид работ/);
    const fact = { startedAt: '10:00', status: 'completed', time: '11:00', accessMinutes: 0 };
    const fields = renderToStaticMarkup(createElement(DurationFactFields, { value: savedFactDraft(fact), fact, onChange() {} }));
    assert.match(fields, /Выполнение сохранено/);
    assert.match(fields, /Для обучения не хватает: оформление, ожидание клиента/);
    assert.match(fields, /Не было · 0 мин/);
  } finally { await vite.close(); }
});
