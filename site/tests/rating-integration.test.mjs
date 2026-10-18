import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {engineerIdentity,ratingName} from '../src/engineerPresentation.js';
import {portraitForEngineer} from '../src/engineerPortraits.js';
import {ShiftStore} from '../server/shiftStore.mjs';
import {seedBaseShift} from '../server/seedBaseShift.mjs';
import {createOperationsApi} from '../server/operationsApi.mjs';
import {createDispatchApi} from '../server/dispatchApi.mjs';
import {createRatingApi} from '../server/ratingApi.mjs';
import {RatingStore} from '../server/ratingStore.mjs';
import {calculateRatingPlan} from '../server/ratingPlanning.mjs';

const root=path.resolve(import.meta.dirname,'../..');

test('engineer presentation preserves scoped identities and assigns each portrait once',async()=>{
  const input=JSON.parse(await readFile(new URL('../public/data/beego-complexity-plan.json',import.meta.url),'utf8'));
  const before=JSON.stringify(input.engineers),photos=input.engineers.map(person=>portraitForEngineer(person.id)).filter(Boolean);
  assert.equal(photos.length,32);assert.equal(new Set(photos).size,32);
  assert.ok(!photos.includes(portraitForEngineer('RATING-0001')));
  assert.equal(portraitForEngineer('RATING-0002'),null);
  assert.equal(portraitForEngineer('tula:EAST-ENG-01'),null);
  assert.equal(portraitForEngineer('moscow:EAST-ENG-01'),portraitForEngineer('EAST-ENG-01'));
  assert.equal(engineerIdentity({id:'tula:EAST-ENG-01'}),'tula:EAST-ENG-01');
  assert.equal(ratingName({id:'moscow:EAST-ENG-01',name:'Бригада Комарь'}),'Алексей Волков');
  assert.equal(ratingName({id:'SOUTHCENTER-ENG-04',name:'Ионов Геннадий'}),'Геннадий Ионов');
  for(const photo of photos) assert.ok((await readFile(new URL('../public'+photo.split('?')[0],import.meta.url))).length>0);
  input.engineers.forEach(ratingName);
  assert.equal(JSON.stringify(input.engineers),before);
});

test('rating HTTP integration leaves all working shifts, facts, versions and home sessions unchanged',async()=>{
  const store=new ShiftStore(':memory:');
  let operations;
  try {
    await seedBaseShift(store);
    operations=createOperationsApi({store});
    const dispatch=createDispatchApi(store);dispatch.close();
    const base=store.byDate('moscow','2026-08-17');
    const session=await (await dispatch.handle(new Request('http://localhost/api/dispatch/sessions',{method:'POST',body:JSON.stringify({baseShiftId:base.id,speed:300})}))).json();
    assert.ok(session.shift.team.filter(person=>person.startPoint?.kind==='home').length>=2);
    const tables=['shifts','plan_versions','visit_facts','staff_roster','dispatch_sessions','dispatch_incidents'];
    const snapshot=()=>JSON.stringify(tables.map(table=>[table,store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before=snapshot();
    const catalog=await (await operations.handle(new Request('http://localhost/api/ratings/engineers?regionId=moscow&date=2026-08-17'))).json();
    assert.equal(catalog.engineers.length,1035);
    const cases=await (await operations.handle(new Request('http://localhost/api/ratings/cases'))).json();
    assert.ok(cases.length>=4);
    const proposalResponse=await operations.handle(new Request('http://localhost/api/ratings/scenarios',{method:'POST',body:JSON.stringify({regionId:'moscow',date:base.date,pool:'all',kind:'staffing',settings:{qualityFloor:4.2,qualityCeiling:5}})}));
    assert.equal(proposalResponse.status,201);
    assert.equal((await proposalResponse.json()).status,'AWAITING_CONFIRMATION');
    assert.equal(snapshot(),before);
  }finally{operations?.close?.();store.close();}
});

test('new rating workers reject mismatched homes and durations instead of reusing office road evidence',async()=>{
  const store=new ShiftStore(':memory:');
  try {
    await seedBaseShift(store);
    const base=store.byDate('moscow','2026-08-17');
    const inputs={orders:base.orders,team:base.team};
    const code=`import json,sys
from pathlib import Path
from beeline_planning import load_planning_dataset
from rating_inputs import validate_rating_inputs
d=load_planning_dataset(Path('data/object-complexity/dataset'),'core')
p=json.load(sys.stdin)
validate_rating_inputs(d,p)
`;
    const check=inputs=>spawnSync(process.env.BEEGO_PYTHON||'python',['-c',code],{cwd:root,input:JSON.stringify(inputs),encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONPATH:path.join(root,'algorithm/src')+path.delimiter+path.join(root,'algorithm/tools'),PYTHONUTF8:'1'},timeout:30000});
    const valid=check(inputs);assert.equal(valid.status,0,valid.stderr);
    const home=structuredClone(inputs);home.team[0].startCoords[0]+=.01;
    assert.notEqual(check(home).status,0);
    const duration=structuredClone(inputs);duration.orders[0].duration++;
    assert.notEqual(check(duration).status,0);
    const window=structuredClone(inputs);window.orders[0].end='23:59';
    assert.notEqual(check(window).status,0);
  }finally{store.close();}
});

test('real rating plan accepts verified home-start dataset and keeps the operational session intact',async()=>{
  const store=new ShiftStore(':memory:');
  try {
    await seedBaseShift(store);const api=createDispatchApi(store);api.close();
    const base=store.byDate('moscow','2026-08-17');
    const session=await (await api.handle(new Request('http://localhost/api/dispatch/sessions',{method:'POST',body:JSON.stringify({baseShiftId:base.id,speed:300})}))).json();
    const shift=store.get(session.shiftId),before=JSON.stringify(shift);
    const ratings=new RatingStore(store.db);await ratings.seed();
    const catalog=ratings.catalog().map(person=>{
      const actual=shift.team.find(member=>engineerIdentity(member)===person.id);
      return actual?{...person,...actual,id:person.id,rating:person.rating}:person;
    });
    const result=await calculateRatingPlan(shift,catalog,{id:'home-proof-'+session.id,pool:'all',ratingVersion:ratings.version()});
    assert.equal(result.plan.validation.status,'VALID');assert.equal(result.plan.metrics.assigned,shift.plan.metrics.assigned);
    const homes=shift.team.filter(person=>person.startPoint?.kind==='home');
    for(const home of homes){const retained=result.team.find(person=>engineerIdentity(person)===engineerIdentity(home));if(retained)assert.deepEqual(retained.startCoords,home.startCoords);}
    assert.equal(JSON.stringify(store.get(shift.id)),before);
  }finally{store.close();}
});
