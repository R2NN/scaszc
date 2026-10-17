import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { EmergencyDispatch } from '../server/emergencyDispatch.mjs';
import { operationalStates } from '../src/operationalState.js';
import { eventModel, playbackRouteSegments } from '../src/shiftDomain.js';
import { notificationPresentation } from '../src/notificationPresentation.js';

const engineer = { id:'E1',name:'Инженер 1',skills:['EMERGENCY'],equipment:['DIAG_SET'],transport:'CAR',zoneId:'EAST',zone:'Восток',startCoords:[55.7,37.6],shiftStart:'08:00',shiftEnd:'18:00',status:'Доступен' };
const order = { id:'J1',name:'Заявка',address:'Адрес 1',zoneId:'EAST',zone:'Восток',coords:[55.71,37.61],skill:'EMERGENCY',priority:'EMERGENCY',workType:'Аварийные работы',equipment:'DIAG_SET',start:'12:00',end:'17:00',duration:80 };
const initial = {status:'EXACT_VALID',publicationAllowed:true,contentSha256:'a'.repeat(64),validation:{status:'VALID'},routes:[{engineerId:'E1',assignments:[{orderId:'J1',departureAt:'11:30',arrival:'12:00',plannedStart:'12:00',plannedFinish:'13:20',geometry:[engineer.startCoords,order.coords]}]}],unassigned:[],metrics:{total:1,assigned:1}};
const fixture = (file=':memory:') => {
  const store=new ShiftStore(file);
  const shift=store.ensure({regionId:'test',date:'2026-08-17',orders:[order],team:[engineer],plan:initial});
  let clock=100000;
  const routing=async payload => {
    const added=payload.orders.at(-1);
    return {dispatchCandidates:[{engineerSourceId:'E1',artifact:'test-fixture',plan:{...initial,contentSha256:'b'.repeat(64),routes:[{...initial.routes[0],assignments:[{orderId:added.id,departureAt:'10:00',arrival:'10:10',plannedStart:'10:10',plannedFinish:'11:30',travelMinutes:10,geometry:[engineer.startCoords,added.coords]},...initial.routes[0].assignments]}],metrics:{total:2,assigned:2}}}],dispatchSearch:{eligible:['E1'],rejected:[]}};
  };
  const dispatch=new EmergencyDispatch(store,{routing,now:()=>clock});
  const create=(id='U1')=>dispatch.create(shift.id,{order:{...order,id,start:'10:00'},time:'10:00',eventKey:id});
  return {store,shift,dispatch,create,advance:seconds=>{clock+=seconds*1000;}};
};

test('incident creation is idempotent and reading a notice never solves it',()=>{
  const f=fixture();try{const first=f.create();assert.equal(f.create().id,first.id);f.dispatch.read(first.id,first.notifications[0].id);assert.equal(f.dispatch.get(first.id).status,'QUEUED');assert.equal(f.store.get(f.shift.id).revision,1);}finally{f.store.close();}
});
test('manual decision wins once; duplicate callbacks return that same decision',async()=>{
  const f=fixture();try{const item=await f.dispatch.search(f.create().id);assert.equal(item.status,'WAITING');const selected=item.candidates[0];const accepted=f.dispatch.accept(item.id,selected.id,'Диспетчер');f.advance(301);await f.dispatch.tick();assert.deepEqual(f.dispatch.accept(item.id,selected.id,'system').decision,accepted.decision);assert.equal(f.store.get(f.shift.id).revision,2);assert.equal(f.store.get(f.shift.id).events.length,1);}finally{f.store.close();}
});
test('server deadline accepts with actor=system without an open browser',async()=>{
  const f=fixture();try{const item=await f.dispatch.search(f.create().id);f.advance(299);await f.dispatch.tick();assert.equal(f.dispatch.get(item.id).status,'WAITING');f.advance(1);await f.dispatch.tick();assert.equal(f.dispatch.get(item.id).decision.actor,'system');assert.equal(f.store.get(f.shift.id).revision,2);}finally{f.store.close();}
});
test('deadline can accept a checked partial result while remaining alternatives are still searching',async()=>{
  const f=fixture();try{
    const routing=f.dispatch.routing;
    f.dispatch.routing=async(payload,root,{onProgress,signal})=>{
      const result=await routing(payload);
      onProgress({completed:1,total:3,candidates:1,routeChecks:4,dispatchCandidates:result.dispatchCandidates});
      await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      return result;
    };
    const item=f.create(),running=f.dispatch.search(item.id);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.dispatch.get(item.id).status,'WAITING');
    f.advance(300);await f.dispatch.tick();await running;
    assert.equal(f.dispatch.get(item.id).decision.actor,'system');
    assert.equal(f.store.get(f.shift.id).revision,2);
  }finally{f.store.close();}
});
test('new facts and new incidents invalidate a formerly ready candidate',async()=>{
  const f=fixture();try{const item=await f.dispatch.search(f.create().id);f.create('U2');const result=f.dispatch.accept(item.id,item.candidates[0].id);assert.equal(result.status,'QUEUED');assert.equal(f.store.get(f.shift.id).revision,1);const newer=await f.dispatch.search(item.id);f.store.recordFact(f.shift.id,{orderId:'J1',status:'started',time:'12:00'});assert.equal(f.dispatch.accept(item.id,newer.candidates[0].id).status,'QUEUED');}finally{f.store.close();}
});
test('cancellation prevents expiry and an in-flight search from publishing',async()=>{
  const f=fixture();try{const item=f.create();f.dispatch.cancel(item.id);f.advance(400);await f.dispatch.tick();assert.equal(f.dispatch.get(item.id).status,'CANCELLED');assert.equal(f.store.get(f.shift.id).revision,1);}finally{f.store.close();}
});

test('reading a notification during search remains durable when the result arrives',async()=>{
  const f=fixture();
  try {
    const routing=f.dispatch.routing;
    let finish;
    const pending=new Promise(resolve=>{finish=resolve;});
    f.dispatch.routing=async payload=>{await pending;return await routing(payload);};
    const item=f.create(),running=f.dispatch.search(item.id);
    f.dispatch.read(item.id,item.notifications[0].id);
    finish();
    await running;
    assert.equal(f.dispatch.get(item.id).notifications[0].read,true);
    assert.equal(f.dispatch.get(item.id).status,'WAITING');
  } finally { f.store.close(); }
});
test('durable timer and selected plans survive restart and competing connections',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'beego-dispatch-'));let f;
  try{f=fixture(join(dir,'shift.sqlite3'));const item=await f.dispatch.search(f.create().id);f.store.close();const store=new ShiftStore(join(dir,'shift.sqlite3'));const other=new ShiftStore(join(dir,'shift.sqlite3'));try{const d=new EmergencyDispatch(store,{now:()=>500000});const d2=new EmergencyDispatch(other,{now:()=>500000});await d.tick();const result=d2.accept(item.id,item.candidates[0].id);assert.equal(result.decision.actor,'system');assert.equal(store.get(f.shift.id).versions.length,2);}finally{store.close();other.close();}}finally{await rm(dir,{recursive:true,force:true});}
});
test('failed routing keeps old plan, exposes expiry and resumes queued work after restart',async()=>{
  const f=fixture();try{f.dispatch.routing=async()=>{throw new Error('Дорожный сервис недоступен');};const item=await f.dispatch.search(f.create().id);assert.equal(item.status,'ERROR');assert.equal(f.store.get(f.shift.id).plan.contentSha256,initial.contentSha256);f.advance(400);assert.ok(f.dispatch.get(item.id).deadlineAt < 500000);assert.equal(f.store.get(f.shift.id).revision,1);}finally{f.store.close();}
});
test('actual unfinished service remains working past planned finish with no invented release',()=>{
  const shift={date:'2026-08-17',revision:1,plan:initial,team:[engineer],orders:[order],facts:[{engineerId:'E1',orderId:'J1',status:'started',time:'12:00'}]};const state=operationalStates(shift,850)[0];assert.equal(state.status,'working');assert.equal(state.availableAt,null);assert.equal(state.source,'dispatcher_fact');
});
test('day start requires a confirmed dated point and cannot rewrite an executing day',()=>{
  const f=fixture();try{const event={type:'START_CHANGED',time:'07:00',engineerId:'E1',reason:'Старт из дома',startPoint:{kind:'home',confirmed:true,date:'2026-08-17',coords:[55.72,37.64],address:'Дом',source:'confirmed-registry',availableFrom:'08:30'}};assert.deepEqual(eventModel(f.shift,event).team[0].startCoords,event.startPoint.coords);assert.throws(()=>eventModel({...f.shift,facts:[{status:'started'}]},event),/начала дня/);assert.throws(()=>eventModel(f.shift,{...event,startPoint:{...event.startPoint,confirmed:false}}),/Подтвердите/);}finally{f.store.close();}
});
test('notification type is explicit and elapsed road geometry remains visible',()=>{
  assert.equal(notificationPresentation({type:'EMERGENCY_INCIDENT',title:'Новая авария'}).title,'Новая авария');const segments=playbackRouteSegments({assignments:[],movements:[{at:'2026-08-17T11:17:00+03:00',geometry:[[55.7,37.6],[55.71,37.61]]}]},678);assert.equal(segments.travelled.length,1);
});
