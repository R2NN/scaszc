import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { RatingStore } from '../server/ratingStore.mjs';
import { seedBaseShift } from '../server/seedBaseShift.mjs';
import { createRatingApi } from '../server/ratingApi.mjs';
import { staffingOptions, staffingBreakdown, staffingForecast, loadStaffingForecast, proposeStaffingTeam } from '../server/staffingPlanning.mjs';
import { groupStaffingNeeds } from '../src/staffingInsights.js';
import { loadLocalVariables } from '../server/loadLocalVariables.mjs';

test('staffing keeps quality shortages separate from catalog size and inferred forecast coverage', async () => {
  const db = new ShiftStore(':memory:');
  try {
    await seedBaseShift(db); const ratings = new RatingStore(db.db); await ratings.seed();
    const shift = db.byDate('moscow','2026-08-17'), catalog = ratings.catalog();
    const before = JSON.stringify(shift);
    const used = shift.plan.routes.filter(route=>route.assignments.length).length;
    const staff = staffingBreakdown(shift,catalog,{pool:'staff',qualityFloor:4.2});
    assert.equal(staff.reduce((n,p)=>n+p.needed,0),used);
    assert.equal(staff.reduce((n,p)=>n+p.jobs,0),shift.plan.metrics.assigned);
    assert.equal(staff.reduce((n,p)=>n+p.shortage,0),0);
    const unavailable = staffingBreakdown(shift,catalog,{pool:'staff',qualityFloor:5});
    assert.equal(unavailable.reduce((n,p)=>n+p.shortage,0),used);
    const forecast = await loadStaffingForecast();
    const report = staffingForecast(shift,catalog,forecast);
    assert.equal(report.targetDate,forecast.targetDate);
    assert.equal(report.complete,false); // No observed UPSELL capacity in the retained exact plan.
    assert.ok(Math.abs(report.zones.flatMap(z=>z.uncovered).filter(x=>x.skill==='UPSELL').reduce((n,x)=>n+x.demand,0)-forecast.skills.find(x=>x.name==='UPSELL').middle)<.01);
    assert.equal(report.reserve,report.engineersHigh-report.engineers);
    assert.ok(report.engineersLow<=report.engineers && report.engineers<=report.engineersHigh);
    for (const zone of report.zones) {
      assert.equal(zone.profiles.reduce((n,p)=>n+p.forecastNeeded,0),zone.engineers);
      assert.ok(zone.profiles.every(p=>p.zone===zone.name));
    }
    const changed = staffingForecast(shift,catalog,{...forecast,skills:forecast.skills.map(x=>({...x,low:x.name==='LOCAL'?182:0,middle:x.name==='LOCAL'?197:0,high:x.name==='LOCAL'?212:0}))});
    assert.equal(changed.complete,true);
    assert.notDeepEqual(changed.zones.map(x=>x.profiles.map(p=>p.forecastNeeded)),report.zones.map(x=>x.profiles.map(p=>p.forecastNeeded)));
    assert.equal(JSON.stringify(db.byDate('moscow','2026-08-17')),before);
  } finally { db.close(); }
  assert.throws(()=>staffingOptions({qualityFloor:'NaN'}),/порог/i);
  assert.throws(()=>staffingOptions({qualityFloor:6}),/порог/i);
  assert.throws(()=>staffingOptions({pool:'forged'}),/состав/i);
  for(const qualityCeiling of [3,6,'NaN'])assert.throws(()=>staffingOptions({qualityFloor:4.2,qualityCeiling}),/граница/i);
});

test('staffing API handles no orders and refuses incomplete or hypothetical saved plans', async () => {
  const db = new ShiftStore(':memory:');
  try {
    await seedBaseShift(db); const api = createRatingApi(db);
    const response = await api(new Request('http://localhost/api/ratings/staffing?regionId=moscow&date=2026-08-19&pool=staff&qualityFloor=4.2'));
    assert.equal(response.status,200); const empty = await response.json();
    assert.equal(empty.orders,0); assert.equal(empty.hasPlan,false); assert.ok(empty.forecast);
    const store = new RatingStore(db.db);
    const scenario = store.createScenario({kind:'staffing',regionId:'moscow',date:'2026-08-17',ratingVersion:store.version()});
    const ready = {...scenario,status:'READY',plan:{status:'EXACT_VALID',validation:{status:'VALID'}}};
    store.updateScenario(scenario.id,{...ready,staffing:{complete:false,hypothetical:false}});
    assert.throws(()=>store.saveScenario(scenario.id),/полный план/);
    store.updateScenario(scenario.id,{...ready,staffing:{complete:true,hypothetical:true}});
    assert.throws(()=>store.saveScenario(scenario.id),/реальными исполнителями/);
    store.updateScenario(scenario.id,{...ready,staffing:{complete:true,hypothetical:false}});
    assert.equal(store.saveScenario(scenario.id).saved,true);
  } finally { db.close(); }
});

test('real Python composition enforces quality, preserves manual locks and never loses jobs', () => {
  loadLocalVariables(); const root=path.resolve(import.meta.dirname,'../..');
  const code = `
import sys
from pathlib import Path
sys.path.insert(0, str(Path('algorithm/tools').resolve()))
from plan_staffing import compose
from dataclasses import replace
from beeline_planning import load_planning_dataset, validate_initial_plan
from beeline_planning.export import load_exact_plan_artifact
d=load_planning_dataset(Path('data/dataset'),'core')
p,_=load_exact_plan_artifact(Path('algorithm/artifacts/current/initial-exact-205-of-205-retimed.json'),d.dataset_sha256)
p=replace(p,engineer_plans=tuple(r for r in p.engineer_plans if r.visits))
c=[{'id':key,'templateId':key,'rating':{'score':4.2}} for key in d.engineers]
rd,full,missing,matches=compose(d,p,c,4.2,frozenset())
assert validate_initial_plan(rd,full).is_valid and not missing
assert sum(len(r.visits) for r in full.engineer_plans)==205
rd,empty,missing,matches=compose(d,p,c,4.7,frozenset())
assert validate_initial_plan(rd,empty).is_valid and len(empty.unserved_job_ids)==205
rd,upper,missing,matches=compose(d,p,c,1,frozenset(),4.19)
assert len(upper.unserved_job_ids)==205 and not upper.engineer_plans
rd,boundary,missing,matches=compose(d,p,c,4.2,frozenset(),4.2)
assert not missing and validate_initial_plan(rd,boundary).is_valid
lock=p.engineer_plans[0].engineer_id
rd,kept,missing,matches=compose(d,p,c,4.7,frozenset([lock]))
assert len(kept.engineer_plans)==1 and kept.engineer_plans[0].engineer_id==lock
assert validate_initial_plan(rd,kept).is_valid
assert len(kept.unserved_job_ids)+sum(len(r.visits) for r in kept.engineer_plans)==205
# Adding one matching specialist must recover work without changing others.
template=missing[0]['templateId']
c.append({'id':'WHATIF-QA','templateId':template,'rating':{'score':4.7}})
rd,added,remaining,matches=compose(d,p,c,4.7,frozenset([lock]))
assert len(remaining)==len(missing)-1 and len(added.unserved_job_ids)<len(kept.unserved_job_ids)
assert validate_initial_plan(rd,added).is_valid
print('quality, locks, coverage and +1 verified')
`;
  const result=spawnSync(process.env.BEEGO_PYTHON||'python',['-c',code],{cwd:root,encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONPATH:path.join(root,'algorithm/src'),PYTHONUTF8:'1'},timeout:30000});
  assert.equal(result.status,0,result.stderr || result.stdout);
});

test('legacy rating calculator and operational shift remain isolated from new staffing mode', async () => {
  const db = new ShiftStore(':memory:');
  try {
    await seedBaseShift(db); const before=JSON.stringify(db.byDate('moscow','2026-08-17'));
    let called=0;
    const api=createRatingApi(db,{calculate:async (shift,catalog,scenario)=>{called++;assert.equal(scenario.kind,undefined);return {plan:shift.plan,orders:shift.orders,team:shift.team};}});
    const response=await api(new Request('http://localhost/api/ratings/scenarios',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({regionId:'moscow',date:'2026-08-17',pool:'staff'})}));
    assert.equal(response.status,202); const started=await response.json();
    let ready;
    for(let attempt=0;attempt<20;attempt++) { ready=await (await api(new Request(`http://localhost/api/ratings/scenarios/${started.id}`))).json();if(ready.status==='READY')break;await new Promise(resolve=>setTimeout(resolve,5)); }
    assert.equal(called,1);assert.equal(ready.status,'READY');assert.equal(ready.kind,undefined);
    const saved=await api(new Request(`http://localhost/api/ratings/scenarios/${started.id}/save`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
    assert.equal(saved.status,200);
    assert.equal(JSON.stringify(db.byDate('moscow','2026-08-17')),before);
  } finally {db.close();}
});


test('staffing proposal respects both rating bounds, unique profiles and locked exceptions without building routes', async () => {
  const db=new ShiftStore(':memory:');
  try {
    await seedBaseShift(db);const ratings=new RatingStore(db.db);await ratings.seed();
    const shift=db.byDate('moscow','2026-08-17'),catalog=ratings.catalog(),before=JSON.stringify(shift);
    const all=proposeStaffingTeam(shift,catalog,{pool:'all',qualityFloor:4.2,qualityCeiling:5});
    const used=shift.plan.routes.filter(route=>route.assignments.length).length;
    assert.equal(all.needed,used);assert.equal(all.team.length,used);assert.equal(all.missing.length,0);
    assert.equal(new Set(all.team.map(item=>item.id)).size,used);assert.equal(all.jobs,shift.orders.length);assert.equal(all.plan,undefined);
    const narrow=proposeStaffingTeam(shift,catalog,{pool:'all',qualityFloor:4.56,qualityCeiling:4.61});
    assert.ok(narrow.team.every(item=>item.rating.score>=4.56&&item.rating.score<=4.61));
    assert.equal(narrow.team.length+narrow.missing.length,used);assert.ok(narrow.available<all.available);
    const locked=structuredClone(shift),route=locked.plan.routes.find(item=>item.assignments.length);
    route.assignments[0].manual=true;
    const proposal=proposeStaffingTeam(locked,catalog,{pool:'all',qualityFloor:5,qualityCeiling:5});
    assert.deepEqual(proposal.team.map(item=>item.id),[String(route.engineerId).split(':').at(-1)]);
    assert.deepEqual(proposal.qualityExceptions,proposal.lockedEngineerIds);
    assert.equal(JSON.stringify(db.byDate('moscow','2026-08-17')),before);
  }finally{db.close();}
});

test('staffing requires persisted composition confirmation, rejects stale proposals and ignores forged candidate IDs',async()=>{
  const db=new ShiftStore(':memory:');
  try{
    await seedBaseShift(db);const before=JSON.stringify(db.byDate('moscow','2026-08-17'));let calls=0,approved=[];
    const api=createRatingApi(db,{calculateStaffing:async(shift,catalog,scenario)=>{
      calls++;approved=scenario.approvedEngineerIds;assert.ok(scenario.confirmedAt);
      assert.deepEqual(approved,scenario.proposal.team.map(item=>item.id));
      return {team:scenario.proposal.team,orders:shift.orders,plan:shift.plan,staffing:{complete:true,hypothetical:false}};
    }});
    const post=async(path,input={})=>api(new Request(`http://localhost/api/ratings/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}));
    const propose=async()=>{
      const response=await post('scenarios',{kind:'staffing',regionId:'moscow',date:'2026-08-17',pool:'all',settings:{qualityFloor:4.2,qualityCeiling:5}});
      assert.equal(response.status,201);return response.json();
    };
    const proposal=await propose();assert.equal(proposal.status,'AWAITING_CONFIRMATION');assert.equal(proposal.plan,undefined);assert.equal(calls,0);
    const ratings=new RatingStore(db.db);assert.equal(ratings.scenario(proposal.id).status,'AWAITING_CONFIRMATION');
    assert.equal((await post(`scenarios/${proposal.id}/save`)).status,422);
    ratings.bump();assert.equal((await post(`scenarios/${proposal.id}/confirm`)).status,409);assert.equal(calls,0);
    const fresh=await propose();const confirmation=await post(`scenarios/${fresh.id}/confirm`,{approvedEngineerIds:['FORGED'],settings:{qualityFloor:1}});
    assert.equal(confirmation.status,202);
    for(let attempt=0;attempt<20&&ratings.scenario(fresh.id).status==='RUNNING';attempt++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(calls,1);assert.equal(ratings.scenario(fresh.id).status,'READY');assert.ok(!approved.includes('FORGED'));
    assert.equal((await post(`scenarios/${fresh.id}/confirm`)).status,422);assert.equal(calls,1);
    assert.equal((await post(`scenarios/${fresh.id}/save`)).status,200);
    assert.equal(JSON.stringify(db.byDate('moscow','2026-08-17')),before);
  }finally{db.close();}
});


test('compact territory summary retains skill shortages despite surplus people in other profiles or areas',()=>{
  const summary=groupStaffingNeeds([
    {zone:'Восток',needed:2,available:100,shortage:0,skills:['INSTALL']},
    {zone:'Восток',needed:3,available:1,shortage:2,skills:['EMERGENCY']},
    {zone:'Югоцентр',needed:1,available:80,shortage:0,skills:['EMERGENCY']},
  ]);
  assert.equal(summary.length,2);assert.equal(summary[0].zone,'Восток');
  assert.equal(summary[0].needed,5);assert.equal(summary[0].available,101);assert.equal(summary[0].shortage,2);
  assert.deepEqual(summary[0].gaps,[{skills:['EMERGENCY'],count:2}]);
  assert.equal(summary[1].shortage,0);assert.deepEqual(groupStaffingNeeds(),[]);
});
