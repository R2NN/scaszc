import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleExactPlanning } from '../server/exactPlanningApi.mjs';
import { ShiftStore } from '../server/shiftStore.mjs';
import { TransportStore } from '../server/transportApi.mjs';

test('initial planning includes yesterday closures before the next shift exists',async()=>{
  const store=new ShiftStore(':memory:'),transport=new TransportStore(store);
  try{
    transport.segments([{id:'road',kind:'road',edgeId:'1',geometry:[[55.7,37.6],[55.71,37.61]]}]);
    const event=transport.save({title:'Ночной ремонт',kind:'road',direction:'forward',startsAt:'2026-08-17T23:00:00+03:00',endsAt:'2026-08-18T10:00:00+03:00',segmentIds:['road']},{regionId:'moscow',date:'2026-08-17',plan:{}});
    assert.equal(store.byDate('moscow','2026-08-18'),null);
    const saved=JSON.parse(await readFile(new URL('../public/data/beego-complexity-plan.json',import.meta.url),'utf8'));
    let received;
    const result=await handleExactPlanning(new Request('http://localhost/api/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...saved,regionId:'moscow',planningDate:'2026-08-18',sharedInventory:[]})}),{store,planRunner:async input=>{received=input;return structuredClone(saved.plan);}});
    assert.equal(result.status,200);assert.equal(received.recompute,true);assert.deepEqual(received.transportRestrictions,[event]);
  }finally{store.close();}
});

test('explicit improvement bypasses a matching retained schedule; lookup does not run the planner', async () => {
  const saved = JSON.parse(await readFile(new URL('../public/data/beego-complexity-plan.json', import.meta.url), 'utf8'));
  const complexity = { prepareOrders: orders => orders, verifyOrders: () => {}, authorizePlan: () => {} };
  let calls = 0;
  const planRunner = async payload => { calls++; assert.equal(payload.recompute, true); return structuredClone(saved.plan); };
  const request = recompute => new Request('http://localhost/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...saved, sharedInventory: [], recompute }) });
  const lookup = await handleExactPlanning(request(false), { complexity, planRunner });
  assert.equal(lookup.status, 200);
  assert.equal(calls, 0);
  const improved = await handleExactPlanning(request(true), { complexity, planRunner });
  assert.equal(improved.status, 200);
  assert.equal(calls, 1);
});
