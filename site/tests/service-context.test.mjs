import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { createServiceContextApi } from '../server/serviceContextApi.mjs';
import { caseForOrder, relatedOrders, serviceStats } from '../src/serviceContextDomain.js';

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
    assert.equal(saved.data.cases[0].provenance, 'demo');
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
    const saved = await request('PATCH', { revision: 1, action: 'task', kind: 'case', id: 'DEMO-CASE-001', task, actor: 'Ирина' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.cases[0].task, task);
    assert.equal((await request('PATCH', { revision: 1, action: 'note', kind: 'case', id: 'DEMO-CASE-001', note: 'Старая запись' })).status, 409);
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
    for (const mutate of [data => { data.cases[0].accountRef = ''; }, data => { data.cases[0].identityConfirmed = false; }, data => { data.incidents[0].orderIds = ['test-b:EAST-1']; }, data => { data.components[0].coords = [155, 37]; }, data => { data.incidents[0].componentId = 'MISSING'; }]) {
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
