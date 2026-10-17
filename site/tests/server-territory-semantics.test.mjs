import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { ShiftStore } from '../server/shiftStore.mjs';
import { createOperationsApi } from '../server/operationsApi.mjs';
import { handleExactPlanning } from '../server/exactPlanningApi.mjs';
import { calculateDuration } from '../server/durationModel.mjs';
import { orderSemantics } from '../src/orderSemantics.js';
import { isUrgentOrder, effectiveOrderSkill, workPointType } from '../src/workTypes.js';
import { canServe } from '../src/dynamicReplanner.js';
import { validateOrderImport } from '../src/validateOrderImport.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const at = '2026-08-17T07:00:00+03:00';
const object = { id: 'SE-house', address: 'Город Москва, ул.Булатниковская, д. 4 к 1', coords: [55.58, 37.66], zone: 'Юго-восток', zoneId: 'SOUTHEAST', regionId: 'moscow' };
const order = { id: 'NEW', sourceId: 'NEW', workType: 'Подключение', skill: 'Подключение', priority: 'Обычная', address: object.address, coords: object.coords, zone: 'Восток', regionId: 'moscow', start: '10:00', end: '12:00' };
const request = (path, body) => new Request(`http://local${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fixture = context => { const store = new ShiftStore(':memory:'); store.complexity.registerObject(object); context.after(() => store.close()); return store; };

test('server rejects conflicting territories by object ID, source ID and exact address without writing snapshots', async context => {
  const store = fixture(context), api = createOperationsApi({ store });
  for (const input of [order, { ...order, objectId: object.id }, { ...order, serviceEntities: { object: object.id } }, { ...order, sourceData: { location_id: 'unseen-import-id' } }, { ...order, zone: 'Юго-восток', sourceData: { zone_id: 'EAST' } }, { ...order, zone: 'Юго-восток', zoneId: 'EAST' }]) {
    const response = await api.handle(request('/api/complexity/estimate', { order: input, asOf: at }));
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /Юго-восток.*Восток|Юго-восток.*EAST/);
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM duration_snapshots').get().n, 0);
  assert.equal(store.complexity.objects().length, 1);
  const accepted = store.complexity.prepareOrders([{ ...order, zone: 'юго-ВОСТОК', zoneId: 'SOUTH_EAST' }], at)[0];
  assert.equal(accepted.objectId, object.id);
  assert.equal(accepted.duration, 70);
  const inherited = store.complexity.prepareOrders([{ ...order, zone: '' }], at)[0];
  assert.equal(inherited.zone, 'Юго-восток');
  assert.equal(inherited.zoneId, 'SOUTHEAST');
  assert.throws(() => store.complexity.validateServiceOrder({ ...order, objectId: 'other', serviceEntities: { object: object.id } }), /противоречит/);
  assert.throws(() => store.ensure({ regionId: 'moscow', date: '2026-08-17', orders: [order] }), /территории/);
});

test('initial planning and NEW_ORDER reject a wrong territory before invoking routing or creating a draft', async context => {
  const store = fixture(context);
  let routed = false;
  const response = await handleExactPlanning(request('/api/plan', { planningDate: '2026-08-17', orders: [order], engineers: [] }), { complexity: store.complexity, planRunner: async () => { routed = true; } });
  assert.equal(response.status, 422);
  assert.equal(routed, false);
  const shift = store.ensure({ regionId: 'test', date: '2026-08-17', orders: [], team: [], plan: { status: 'EXACT_VALID', contentSha256: 'fixture', publicationAllowed: true, validation: { status: 'VALID' }, routes: [], unassigned: [] } });
  const api = createOperationsApi({ store, routing: async () => { routed = true; } });
  const event = { type: 'NEW_ORDER', order, time: '07:00', reason: 'Импорт CSV' };
  const preview = await api.handle(request(`/api/shifts/${shift.id}/preview`, { expectedRevision: shift.revision, event }));
  assert.equal(preview.status, 422);
  assert.equal(routed, false);
  assert.equal(store.latestPreview(shift.id), null);
  assert.throws(() => store.startPreview(shift.id, shift.revision, event), /территории/);
});

test('CSV parsing keeps emergency and urgent semantics, and server import validation cannot be bypassed', async context => {
  const store = fixture(context), api = createOperationsApi({ store });
  const vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  context.after(() => vite.close());
  const { parseImportFiles, buildOrders } = await vite.ssrLoadModule('/src/ImportWorkspace.jsx');
  const originalFetch = globalThis.fetch;
  try {
    const norms = await readFile(new URL('../public/data/work-norms.xlsx', import.meta.url));
    globalThis.fetch = async () => new Response(norms);
    const csv = `job_id;bk_type;required_skill;priority;zone_name;address;window_start;window_end;service_duration_min\nCSV-1;Подключение;INSTALL;Авария;Восток;${object.address};2026-08-17T10:00:00+03:00;2026-08-17T12:00:00+03:00;70`;
    const session = await parseImportFiles([new File([csv], 'заявка.csv')]);
    const ds = session.datasets.orders;
    const rows = buildOrders(ds.headers, ds.rows, ds.savedMappings, { id: 'moscow', name: 'Москва' }, null, session.fileName);
    assert.equal(orderSemantics(rows[0]).kind, 'emergency');
    assert.equal(rows[0].duration, 80);
    const fetcher = async (path, init) => api.handle(new Request(`http://local${path}`, init));
    await assert.rejects(validateOrderImport(rows, fetcher), /Строка 1.*Юго-восток.*Восток/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM replan_previews').get().n, 0);
    const valid = { ...rows[0], zone: 'Юго-восток', sourceData: { ...rows[0].sourceData, zone_name: 'Юго-восток' } };
    assert.equal((await validateOrderImport([valid], fetcher))[0].objectId, object.id);
    const urgentRows = buildOrders(ds.headers, ds.rows.map(row => row.map(value => value === 'Авария' ? 'URGENT' : value)), ds.savedMappings, { id: 'moscow', name: 'Москва' }, null, session.fileName);
    assert.equal(urgentRows[0].priority, 'Срочная');
    assert.equal(orderSemantics(urgentRows[0]).requiredSkill, 'INSTALL');
  } finally { globalThis.fetch = originalFetch; }
});

test('JS and Python use the same semantic contract for qualification, duration and priority', () => {
  const cases = [
    { workType: 'Подключение', skill: 'INSTALL', priority: 'Авария' },
    { workType: 'Подключение', skill: 'INSTALL', priority: 'Срочная' },
    { workType: 'Подключение', skill: 'INSTALL', priority: 'URGENT' },
    { workType: 'Подключение', skill: 'INSTALL', priority: 'NORMAL' },
    { workType: 'Глобальная проблема', serviceType: 'Информация', skill: 'EMERGENCY', priority: 'NORMAL' },
    { workType: 'Глобальная проблема', serviceType: 'Информация', skill: 'EMERGENCY', priority: 'URGENT' },
    { workType: 'Аварийные работы', priority: 'Обычная' },
    { workType: 'Дозаказ', skill: 'UPSELL', priority: 'Обычная' },
    { workType: 'Дозаказ', skill: 'INSTALL', priority: 'NORMAL', sourceData: { bk_type: 'Дозаказ', required_skill: 'INSTALL' } },
    { workType: 'Дозаказ', skill: 'INSTALL', priority: 'EMERGENCY', sourceData: { bk_type: 'Дозаказ', required_skill: 'INSTALL' } },
    { sourceData: { bk_type: 'Подключение', required_skill: 'INSTALL', priority: 'Авария' } },
    { workType: 'Подключение', priority: 'critical' },
  ];
  const python = spawnSync(process.env.BEEGO_PYTHON || fileURLToPath(new URL('../../.venv/Scripts/python.exe', import.meta.url)), ['-c', 'import json,sys; from algorithm.tools.prepare_ui_dataset import order_semantics; print(json.dumps([order_semantics(item) for item in json.load(sys.stdin)],ensure_ascii=False))'], { cwd: root, input: JSON.stringify(cases), encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), cases.map(orderSemantics));
  assert.equal(orderSemantics(cases[8]).requiredSkill, 'INSTALL');
  assert.equal(orderSemantics(cases[9]).requiredSkill, 'EMERGENCY');
  assert.equal(calculateDuration(cases[0], { asOf: at }).total, 80);
  assert.equal(effectiveOrderSkill(cases[0]), 'Аварийные работы');
  assert.equal(workPointType(cases[0]), 'emergency');
  assert.equal(calculateDuration(cases[1], { asOf: at }).total, 70);
  assert.equal(isUrgentOrder(cases[1]), true);
  const engineer = { zone: 'Восток', status: 'Доступен', skills: ['INSTALL'], equipment: [] };
  assert.equal(canServe(engineer, { ...cases[0], zone: 'Восток' }), false);
  assert.equal(canServe({ ...engineer, skills: ['EMERGENCY'] }, { ...cases[0], zone: 'Восток' }), true);
  assert.equal(canServe(engineer, { ...cases[1], zone: 'Восток' }), true);
});
