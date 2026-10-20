import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm, access } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { homeStartScenario, homeScenarioSourceKey } from '../server/homeStartScenario.mjs';
import {ShiftStore} from '../server/shiftStore.mjs';
import {createDispatchApi} from '../server/dispatchApi.mjs';
import {seedBaseShift} from '../server/seedBaseShift.mjs';

const folder = path.resolve('../algorithm/artifacts/tz3/home-starts');
const input = JSON.parse(gunzipSync(await readFile(path.join(folder,'input.json.gz'))));
const manifest = JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
const originalTeam = input.engineers.map(e => {
  if (!e.startPoint) return e;
  const {startPoint,officeStart,...original} = e;
  return {...original,startCoords:officeStart.coords,startAddress:officeStart.address};
});
const base = () => ({date:input.planningDate,versions:[{orders:structuredClone(input.orders),team:structuredClone(originalTeam),plan:{contentSha256:manifest.sourcePlanContentSha256}}]});

test('fresh matching sessions get two home origins and a verified extra assignment', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'beego-home-'));
  try {
    await cp(folder,path.join(root,'algorithm/artifacts/tz3/home-starts'),{recursive:true});
    const source = base();
    assert.equal(homeScenarioSourceKey(source.date,source.versions[0]),manifest.sourceKey);
    const seeded = homeStartScenario(source,{root});
    assert.equal(seeded.team.filter(e=>e.startPoint?.kind==='home').length,2);
    assert.equal(seeded.plan.metrics.assigned,204);
    assert.equal(seeded.plan.metrics.total,205);
    assert.equal(seeded.plan.validation.status,'VALID');
    assert.ok(seeded.plan.routes.some(r=>r.assignments.some(v=>v.orderId==='SOUTHEAST-40698')));
    assert.equal(source.versions[0].team.some(e=>e.startPoint),false);
    await access(path.join(root,'runtime/exact-replans',`${seeded.plan.contentSha256}.json.meta.json`));
    const home = seeded.team.find(e=>e.id==='SOUTHCENTER-ENG-04');
    assert.deepEqual(home.startCoords,home.startPoint.coords);
    assert.equal(home.startPoint.scenario,true);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('changed dates, durations and staff constraints retain their original plan', () => {
  for (const change of [s=>{s.date='2026-08-18';},s=>{s.versions[0].orders[0].duration+=1;},s=>{s.versions[0].team[0].shiftEnd='17:00';}]) {
    const source = base(); change(source);
    assert.equal(homeStartScenario(source),source.versions[0]);
  }
});

test('opening the matching shift supplies its home plan without changing the original day',async()=>{
  const store=new ShiftStore(':memory:'),api=createDispatchApi(store);api.close();
  const entry=async id=>{
    const response=await api.handle(new Request('http://localhost/api/dispatch/sessions/entry',
      {method:'POST',body:JSON.stringify({baseShiftId:id,speed:300})}));
    assert.ok(response.ok);return response.json();
  };
  try{
    await seedBaseShift(store);
    const original=store.byDate('moscow',input.planningDate);
    const opened=await entry(original.id);
    assert.notEqual(opened.shiftId,original.id);assert.equal(opened.clock.minute,360);
    assert.equal(opened.shift.team.filter(person=>person.startPoint?.kind==='home').length,2);
    assert.equal(opened.shift.plan.validation.status,'VALID');assert.deepEqual(store.get(original.id),original);
    const rebuilt=store.ensure({regionId:'moscow',date:input.planningDate,orders:original.orders,team:original.team,plan:original.plan});
    assert.equal(rebuilt.revision,2);
    assert.equal((await entry(rebuilt.id)).shift.team.filter(person=>person.startPoint?.kind==='home').length,2,'An unchanged recalculated input still opens with its confirmed homes');
    const preview=store.startPreview(rebuilt.id,rebuilt.revision,{type:'RECALCULATE',time:'06:00',reason:'Пересчёт исходного плана'});
    store.completePreview(preview,{orders:rebuilt.orders,team:rebuilt.team,plan:rebuilt.plan});
    store.publish(rebuilt.id,preview,rebuilt.revision);
    assert.equal((await entry(rebuilt.id)).shift.team.filter(person=>person.startPoint?.kind==='home').length,2,'Recalculating the unchanged day before execution keeps its home scenario available');
    const other=store.ensure({regionId:'custom',date:input.planningDate,orders:original.orders,team:original.team,plan:original.plan});
    assert.equal(await entry(other.id),null);
    const visit=original.plan.routes[0].assignments[0];
    store.recordFact(original.id,{orderId:visit.orderId,engineerId:original.plan.routes[0].engineerId,status:'started',time:visit.plannedStart});
    assert.equal(await entry(original.id),null,'An executing day keeps its facts and plan');
    assert.equal(await entry(opened.shiftId),null,'An existing session is not cloned on every panel render');
  }finally{store.close();}
});
