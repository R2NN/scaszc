import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { demoServiceContext, createServiceContextApi } from '../server/serviceContextApi.mjs';
import { loadComplexityArtifact } from '../server/complexityArtifact.mjs';
import { caseForOrder, incidentWorkflow, relatedOrders, serviceEventAt, serviceHistoryRows, serviceStats } from '../src/serviceContextDomain.js';

test('network action times belong to the shift; journal retains separate audit time', async () => {
  const { store, request } = fixture();
  try {
    const original = (await request('POST', { action: 'demo', revision: 0 })).data;
    const incident = original.incidents[0];
    const action = { revision: 1, action: 'verification', kind: 'incident', id: incident.id, status: 'confirmed', note: 'Проверено питание и доступность узла', effectiveAt: serviceEventAt('2026-08-17', '11:40') };
    assert.equal((await request('PATCH', { ...action, effectiveAt: '2026-10-19T11:40:00+03:00' })).status, 422);
    assert.equal((await request('GET')).data.revision, 1);
    const saved = await request('PATCH', action);
    assert.equal(saved.status, 200);
    const record = saved.data.incidents[0], event = record.history.at(-1);
    assert.equal(record.status, 'confirmed');
    assert.equal(record.observedAt, incident.observedAt);
    assert.equal(event.at, action.effectiveAt);
    assert.equal(event.recordedAt, record.updatedAt);
    assert.equal(event.eventTimeKnown, true);
    assert.equal(serviceHistoryRows(record, '2026-08-17')[0].displayAt, action.effectiveAt);
    assert.equal((await request('PATCH', { ...action, revision: 2 })).data.revision, 2);
    const prepared = await request('PATCH', { revision: 2, action: 'prepare', kind: 'incident', id: incident.id, orderId: incident.orderIds[0] });
    assert.equal(prepared.status, 200);
    assert.match(prepared.data.incidents[0].history.at(-1).text, /ещё не опубликованы/);
    assert.equal(serviceHistoryRows(prepared.data.incidents[0], '2026-08-17')[0].displayAt, null);
    assert.equal((await request('PATCH', { revision: 3, action: 'prepare', kind: 'incident', id: incident.id, orderId: incident.orderIds[0] })).data.revision, 3);
    assert.equal((await request('PATCH', { revision: 3, action: 'prepare', kind: 'incident', id: incident.id, orderId: 'other-shift:order' })).status, 422);
    assert.equal((await request('GET')).data.incidents[0].history.length, incident.history.length + 2);
    assert.equal(store.get('test-a').events.length, 0);
  } finally { store.close(); }
});

test('shift event time validation, workflow guidance and legacy journal dates stay honest', () => {
  for (const [day, time] of [['2026-02-30','12:00'], ['2026-08-17','24:00'], ['2026-08-17','']]) assert.throws(() => serviceEventAt(day, time));
  const record = { type: 'power', status: 'review', history: [{ at: '2026-08-17T11:17:00+03:00', text: 'Сигнал' }, { at: '2026-10-19T12:00:00Z', text: 'Старая запись' }] };
  const rows = serviceHistoryRows(record, '2026-08-17');
  assert.equal(rows[0].displayAt, null);
  assert.equal(rows[0].recordedAt, record.history[1].at);
  assert.equal(rows[1].displayAt, record.history[0].at);
  assert.match(incidentWorkflow(record).check, /питание/);
  assert.match(incidentWorkflow(record).next, /не подтверждена/);
  assert.match(incidentWorkflow({ ...record, status: 'resolved' }).next, /оставшиеся обращения/);
});

function fixture(file = ':memory:') {
  const store = new ShiftStore(file);
  if (!store.get('test-a')) {
    for (const [id, date] of [['test-a', '2026-08-17'], ['test-b', '2026-08-18']]) store.db.prepare('INSERT INTO shifts(id,region_id,service_date,orders_json,team_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, 'moscow', date, JSON.stringify([{ id: `${id}:EAST-1`, address: 'Один адрес', coords: [55.7, 37.6] }, { id: `${id}:EAST-2`, address: 'Один адрес', coords: [55.71, 37.61] }]), '[]', date, date);
  }
  const api = createServiceContextApi(store);
  const request = async (method = 'GET', input, shift = 'test-a') => {
    const response = await api(new Request(`http://localhost/api/service-context?shiftId=${shift}`, { method, ...(input ? { body: JSON.stringify(input), headers: { 'content-type': 'application/json' } } : {}) }));
    return { status: response.status, data: await response.json() };
  };
  return { store, request };
}
test('empty contexts and explicit demo never modify operational orders, facts, plans or history', async () => {
  const { store, request } = fixture();
  try {
    const before = store.get('test-a');
    assert.equal((await request()).data.incidents.length, 0);
    const saved = await request('POST', { action: 'demo', revision: 0 });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.incidents[0].provenance, 'demo');
    assert.equal(saved.data.cases.length, 0);
    assert.deepEqual(store.get('test-a'), before);
    assert.equal((await request('GET', null, 'test-b')).data.cases.length, 0);
    assert.equal((await request('POST', { action: 'demo', revision: 1 })).status, 422);
  } finally { store.close(); }
});
test('same address and matching source suffix do not link requests from other shifts', async () => {
  const { store, request } = fixture();
  try {
    const demo = (await request('POST', { action: 'demo', revision: 0 })).data;
    assert.equal(caseForOrder(demo.cases, { id: 'test-b:EAST-1', address: 'Один адрес' }).length, 0);
    assert.equal(relatedOrders(demo.incidents[0], store.get('test-b').orders).length, 0);
    assert.deepEqual(serviceStats(demo.incidents), { active: 1, review: 1, orders: 2 });
  } finally { store.close(); }
});
test('optimistic revision prevents lost edits, task and notes persist with audit history', async () => {
  const { store, request } = fixture();
  try {
    await request('POST', { action: 'demo', revision: 0 });
    const task = { action: 'Получить ключ', owner: 'Ирина', deadline: '2026-08-17T13:00', access: 'waiting', equipment: 'ready', customer: 'unknown' };
    const saved = await request('PATCH', { revision: 1, action: 'task', kind: 'incident', id: 'DEMO-INC-042', task, actor: 'Ирина' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.incidents[0].task, task);
    assert.equal((await request('PATCH', { revision: 1, action: 'note', kind: 'incident', id: 'DEMO-INC-042', note: 'Старая запись' })).status, 409);
    const updated = await request('PATCH', { revision: 2, action: 'status', kind: 'incident', id: 'DEMO-INC-042', status: 'resolved' });
    assert.equal(serviceStats(updated.data.incidents).active, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM service_context_history').get().n, 3);
    assert.equal(store.get('test-a').events.length, 0);
  } finally { store.close(); }
});
test('JSON round trip retains exact coordinates and imported geometry metadata across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beego-service-'));
  const file = join(dir, 'isolated.sqlite3');
  let fixtureData = fixture(file);
  try {
    const demo = (await fixtureData.request('POST', { action: 'demo', revision: 0 })).data;
    const data = { cases: demo.cases, incidents: demo.incidents, components: demo.components };
    data.components[0].coords = [55.723456789, 37.698765432];
    data.components[0].cableGeometry = [[55.7, 37.6], [55.71, 37.61]];
    const saved = await fixtureData.request('PUT', { revision: 1, shiftId: 'test-a', date: '2026-08-17', data });
    assert.equal(saved.status, 200);
    fixtureData.store.close(); fixtureData = fixture(file);
    const reloaded = await fixtureData.request();
    assert.deepEqual(reloaded.data.components, data.components);
    assert.deepEqual(reloaded.data.cases, data.cases);
  } finally { fixtureData.store.close(); rmSync(dir, { recursive: true }); }
});
test('invalid imports are atomic: unknown order, missing account, invalid coordinates and foreign scope rejected', async () => {
  const { store, request } = fixture();
  try {
    const demo = (await request('POST', { action: 'demo', revision: 0 })).data;
    const original = { cases: demo.cases, incidents: demo.incidents, components: demo.components };
    for (const mutate of [data => { data.incidents[0].basis = ''; }, data => { data.incidents[0].status = 'invalid'; }, data => { data.incidents[0].orderIds = ['test-b:EAST-1']; }, data => { data.components[0].coords = [155, 37]; }, data => { data.incidents[0].componentId = 'MISSING'; }]) {
      const data = structuredClone(original); mutate(data);
      assert.equal((await request('PUT', { revision: 1, shiftId: 'test-a', date: '2026-08-17', data })).status, 422);
      assert.equal((await request()).data.revision, 1);
    }
    assert.equal((await request('PUT', { revision: 1, shiftId: 'test-b', date: '2026-08-18', data: original })).status, 422);
    assert.deepEqual((await request()).data.components, original.components);
  } finally { store.close(); }
});
test('operators can register non-node incidents without coordinates or complaints', async () => {
  const { store, request } = fixture();
  try {
    const at = new Date().toISOString();
    const data = { cases: [], components: [{ id: 'POWER', title: 'Щит питания', provenance: 'operator' }], incidents: [{ id: 'INC-POWER', title: 'Отключение питания', componentId: 'POWER', type: 'power', status: 'review', provenance: 'operator', orderIds: [], basis: 'Заявка энергетиков №32', updatedAt: at }] };
    assert.equal((await request('PUT', { revision: 0, shiftId: 'test-a', date: '2026-08-17', data })).status, 200);
    assert.equal((await request()).data.incidents[0].orderIds.length, 0);
    assert.equal(store.get('test-a').revision, 0);
  } finally { store.close(); }
});
test('previous-day cases require identical stable account and symptom, with navigable original references', async () => {
 const {store,request}=fixture();
 try {
  const at='2026-08-17T11:00:00+03:00';
  const previous={id:'CASE-OLD',title:'Пропадает связь',accountRef:'ACCOUNT-42',symptom:'Обрывы',identityConfirmed:true,status:'returned',provenance:'operator',orderIds:['test-a:EAST-1'],basis:'Подтверждено по CRM',updatedAt:at,history:[{at,text:'Выезд выполнен; клиент сообщил о повторе.'}]};
  assert.equal((await request('PUT',{revision:0,shiftId:'test-a',date:'2026-08-17',data:{cases:[previous],incidents:[],components:[]}})).status,200);
  const response=await createServiceContextApi(store)(new Request('http://localhost/api/service-context?shiftId=test-b&accountRef=ACCOUNT-42'));
  assert.equal((await response.json()).matches[0].record.id,'CASE-OLD');
  const next={...previous,id:'CASE-NEW',orderIds:['test-b:EAST-2'],previousCases:[{shiftId:'test-a',caseId:'CASE-OLD'}]};
  const write=data=>request('PUT',{revision:0,shiftId:'test-b',date:'2026-08-18',data:{cases:[data],incidents:[],components:[]}},'test-b');
  assert.equal((await write({...next,accountRef:'OTHER'})).status,422);
  assert.equal((await write({...next,symptom:'Другая проблема'})).status,422);
  const saved=await write(next);
  assert.equal(saved.status,200);
  assert.equal(saved.data.priorCases[0].orders[0].id,'test-a:EAST-1');
  assert.equal((await request('GET',null,'test-b')).data.priorCases[0].date,'2026-08-17');
 } finally {store.close();}
});
test('editing preparation does not refresh original telemetry time or accept malformed history', async () => {
 const {store,request}=fixture();
 try {
  const initial=(await request('POST',{action:'demo',revision:0})).data;
  const saved=await request('PATCH',{revision:1,kind:'incident',id:'DEMO-INC-042',action:'note',note:'Проверили доступ'});
  assert.equal(saved.data.incidents[0].observedAt,initial.incidents[0].observedAt);
  assert.notEqual(saved.data.incidents[0].updatedAt,initial.incidents[0].updatedAt);
  const data={cases:saved.data.cases,components:saved.data.components,incidents:saved.data.incidents};
  data.incidents[0].history[0].actor={unexpected:'object'};
  assert.equal((await request('PUT',{revision:2,shiftId:'test-a',date:'2026-08-17',data})).status,422);
  assert.equal((await request()).data.revision,2);
 } finally {store.close();}
});
test('automatic teaching overlay does not seed a changed or imported dataset', async () => {
 const {store}=fixture();
 try {
  const before=store.get('test-a');
  const api=createServiceContextApi(store,{seedDemo:true});
  const response=await api(new Request('http://localhost/api/service-context?shiftId=test-a'));
  const data=await response.json();assert.equal(data.revision,0);assert.equal(data.incidents.length,0);assert.deepEqual(store.get('test-a'),before);
 } finally {store.close();}
});

test('teaching network upgrades to three distinct nodes without replacing saved records or operational data', async () => {
  const store = new ShiftStore(':memory:');
  try {
    const artifact = await loadComplexityArtifact(), date = '2026-08-17', id = 'canonical-demo';
    store.db.prepare('INSERT INTO shifts(id,region_id,service_date,orders_json,team_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, 'moscow', date, JSON.stringify(artifact.orders), '[]', date, date);
    const shift = store.get(id), before = structuredClone(shift), demo = demoServiceContext(shift);
    assert.equal(demo.components.length, 3); assert.equal(demo.incidents.length, 3);
    assert.equal(new Set(demo.incidents.flatMap(item => item.orderIds)).size, 6);
    for (const component of demo.components) { assert.equal(component.provenance, 'demo'); assert.equal(component.demoVersion, 4); }
    for (let i = 0; i < 3; i++) for (let j = 0; j < i; j++) assert.ok(Math.hypot((demo.components[i].coords[0] - demo.components[j].coords[0]) * 111, (demo.components[i].coords[1] - demo.components[j].coords[1]) * 63) > 3);
    const legacy = { cases: [], components: [{ ...demo.components[0], demoVersion: 2, coords: [55.7299, 37.6999] }, { id: 'OWN', title: 'Сохранённая площадка', provenance: 'operator' }], incidents: [{ ...demo.incidents[0], status: 'resolved', task: { ...demo.incidents[0].task, action: 'Сохранённая подготовка', owner: 'Ирина' }, history: [...demo.incidents[0].history, { at: '2026-08-17T12:00:00+03:00', text: 'Проверили питание' }] }] };
    const api = createServiceContextApi(store, { seedDemo: true });
    store.db.prepare('INSERT INTO service_contexts VALUES (?,?,?)').run(id, 1, JSON.stringify(legacy));
    const read = async () => (await api(new Request(`http://localhost/api/service-context?shiftId=${id}`))).json();
    const updated = await read();
    assert.equal(updated.revision, 2, JSON.stringify(updated)); assert.equal(updated.incidents.length, 3);
    assert.deepEqual(updated.incidents[0], legacy.incidents[0]);
    assert.deepEqual(updated.components[0].coords, legacy.components[0].coords);
    assert.deepEqual(updated.components.find(item => item.id === 'OWN'), legacy.components[1]);
    assert.equal((await read()).revision, 2); assert.deepEqual(store.get(id), before);
    // An earlier untouched teaching overlay is upgraded into the same city view.
    const regional = demoServiceContext(shift, { spreadAcrossRegion: true });
    regional.components.forEach(component => { component.demoVersion = 3; });
    regional.components[0].coords = [55.712345, 37.612345];
    regional.components[2].coords = [55.456789, 37.812345]; // explicit coordinate correction
    regional.incidents[2].history.push({ at: '2026-08-17T12:00:00+03:00', text: 'Сохранённая проверка' });
    store.db.prepare('UPDATE service_contexts SET revision=3,data_json=? WHERE shift_id=?').run(JSON.stringify(regional), id);
    const city = await read();
    assert.deepEqual(city.components[0].coords, regional.components[0].coords);
    assert.deepEqual(city.components[1].coords, demo.components[1].coords);
    assert.deepEqual(city.components[2], regional.components[2]);
    assert.deepEqual(city.incidents[2], regional.incidents[2]);
    assert.deepEqual(store.get(id), before);

  } finally { store.close(); }
});
