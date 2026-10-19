import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { acquirePlanningSlot } from '../server/planningSlot.mjs';
import { EmergencyDispatch } from '../server/emergencyDispatch.mjs';
import { createDispatchApi } from '../server/dispatchApi.mjs';
import { operationalStates } from '../src/operationalState.js';
import { eventModel, playbackRouteSegments, minuteOf, timeOf, playbackFrame } from '../src/shiftDomain.js';
import { notificationPresentation } from '../src/notificationPresentation.js';
import { dispatchPreviewDetail, dispatchRouteData } from '../src/dispatchComparison.js';

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

test('rewinding a demonstration starts a clean durable day once and retains the previous facts and history',async()=>{
  const f=fixture(),cancelled=[],api=createDispatchApi(f.store,{routing:f.dispatch.routing,onRestart:id=>cancelled.push(id)});api.close();
  const base=f.store.ensure({regionId:'replay',date:f.shift.date,orders:[{...order,address:'Адрес повторного показа',zoneId:'SOUTHCENTER',zone:'Югоцентр'}],team:[engineer],plan:initial});
  const post=async(path,body)=>{const r=await api.handle(new Request(`http://localhost/api/dispatch/${path}`,{method:'POST',body:JSON.stringify(body)}));const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;};
  try{
    const first=await post('sessions',{baseShiftId:base.id,speed:300});
    await post(`shifts/${first.shiftId}/clock`,{minute:600,playing:false,speed:300});
    f.store.recordFact(first.shiftId,{orderId:'J1',engineerId:'E1',status:'started',time:'12:00'});
    const previous=f.store.get(first.shiftId),incident=api.dispatch.create(first.shiftId,{order:{...order,id:'U1',start:'10:00'},time:'10:00'});
    const next=await post(`shifts/${first.shiftId}/clock`,{minute:360,playing:false,speed:1,mode:'plan',restartDay:'seek-1',serverClockVersion:0});
    assert.equal(next.restarted,true);assert.notEqual(next.shiftId,first.shiftId);assert.equal(next.baseShiftId,base.id);
    assert.equal(next.clock.minute,360);assert.equal(next.clock.speed,300);assert.equal(next.clock.playing,false);assert.equal(next.fired,false);
    assert.equal(next.shift.revision,1);assert.deepEqual(next.shift.facts,[]);assert.deepEqual(next.shift.orders,first.shift.orders);
    assert.equal(next.shift.plan.contentSha256,first.shift.plan.contentSha256);assert.deepEqual(f.store.get(first.shiftId),previous);
    assert.equal(api.dispatch.get(incident.id).status,'CANCELLED');assert.deepEqual(cancelled,[first.shiftId]);
    const duplicate=await post(`shifts/${first.shiftId}/clock`,{minute:360,mode:'plan',restartDay:'seek-1'});
    assert.equal(duplicate.shiftId,next.shiftId);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM dispatch_sessions').get().n,2);
    const late=await post(`shifts/${first.shiftId}/clock`,{minute:865,playing:true,speed:300});assert.equal(late.shiftId,next.shiftId);
    const again=await post(`shifts/${next.shiftId}/clock`,{minute:677,playing:false,speed:300});
    assert.equal(again.incidents.length,1);assert.notEqual(again.incidents[0].id,incident.id);
    await post(`shifts/${next.shiftId}/clock`,{minute:360,playing:false,speed:300,mode:'fact',restartDay:'fact-scrub'});
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM dispatch_sessions').get().n,2,'Factual viewing cannot restart a scenario');
  }finally{f.store.close();}
});

test('an improved offer retains the original receipt and can be accepted through either selection', async () => {
  const f = fixture();
  try {
    const originalRouting = f.dispatch.routing;
    let originalId;
    const repairModes = [];
    const committedEngineers = [];
    f.dispatch.routing = async (payload, root, options) => {
      repairModes.push(payload.dispatchCoverageRepair);
      committedEngineers.push(payload.dispatchEngineerId);
      const first = await originalRouting(payload);
      options.onProgress({ stage: 'COVERAGE_REPAIR', dispatchCandidates: first.dispatchCandidates });
      originalId = f.dispatch.all(f.shift.id)[0].candidates[0].id;
      const candidate = first.dispatchCandidates[0];
      return { ...first, dispatchCandidates: [{ ...candidate, improvesContentSha256:candidate.plan.contentSha256,
        plan:{ ...candidate.plan, contentSha256:'c'.repeat(64) }, coverageRepair:{ improved_jobs:1 } }] };
    };
    const result = await f.dispatch.search(f.create().id);
    assert.equal(result.status, 'WAITING');
    assert.equal(result.candidates[0].replacesCandidateId, originalId);
    assert.ok(result.offeredChoices.some(choice => choice.id === originalId));
    assert.equal(result.candidates[0].coverageRepair.improved_jobs, 1);
    const accepted = await f.dispatch.confirm(result.id, originalId);
    assert.equal(accepted.status, 'ACCEPTED', accepted.error);
    assert.equal(accepted.candidates.find(c => c.id === accepted.decision.candidateId).engineer.id, 'E1');
    assert.deepEqual(repairModes, [true, false], 'Explicit confirmation does not wait for an optional repair phase');
    assert.deepEqual(committedEngineers, [undefined, 'E1'], 'Fresh confirmation only searches the chosen engineer');
  } finally { f.store.close(); }
});

for (const automatic of [false,true]) for (const playing of [false,true]) test(`${automatic ? 'automatic' : 'manual'} dispatch restores ×300 and preserves ${playing ? 'playing' : 'pause'}`,async()=>{
  const f=fixture();
  let now=Date.now();
  const api=createDispatchApi(f.store,{routing:f.dispatch.routing,now:()=>now});
  const post=async(path,body)=>{
    const response=await api.handle(new Request(`http://localhost/api/dispatch/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
    const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;
  };
  try{
    const session=await post('sessions',{baseShiftId:f.shift.id,speed:300});
    await post(`shifts/${session.shiftId}/clock`,{minute:600,playing,speed:300});
    api.dispatch.setPolicy(session.shiftId,{enabled:true,waitSeconds:10});
    const incident=api.dispatch.create(session.shiftId,{order:{...order,id:'U1',start:'10:00'},time:'10:00'});
    const current=()=>JSON.parse(f.store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=?').get(session.shiftId).payload).clock;
    assert.equal(current().speed,1);assert.equal(current().awaitingDecision,true);
    const ready=await api.dispatch.search(incident.id);assert.equal(ready.status,'WAITING',ready.error);
    if(automatic){now+=10001;await api.dispatch.tick();}
    else await post(`incidents/${incident.id}/accept`,{candidateId:ready.candidates[0].id,actor:'Диспетчер'});
    assert.equal(api.dispatch.get(incident.id).status,'ACCEPTED');
    assert.equal(current().speed,300);assert.equal(current().playing,playing);assert.equal(current().awaitingDecision,false);
    const tick=await post(`shifts/${session.shiftId}/clock`,{serverTick:true});
    assert.equal(tick.clock.speed,300);assert.equal(tick.clock.playing,playing);
    const stale=await post(`shifts/${session.shiftId}/clock`,{minute:599,playing,speed:1,awaitingDecision:true,confirmingDecision:true});
    assert.equal(stale.clock.speed,300,'A delayed pre-acceptance clock request cannot restore ×1');
    assert.ok(stale.clock.minute>=600,'A delayed temporary-clock snapshot cannot rewind the shift');
  }finally{api.close();f.store.close();}
});

test('accepting one of two pending emergencies retains ×1 until the whole queue is resolved',async()=>{
  const f=fixture(),api=createDispatchApi(f.store,{routing:f.dispatch.routing});
  try{
    const response=await api.handle(new Request('http://localhost/api/dispatch/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseShiftId:f.shift.id,speed:300})}));
    const session=await response.json();
    const clock=()=>JSON.parse(f.store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=?').get(session.shiftId).payload).clock;
    const first=api.dispatch.create(session.shiftId,{order:{...order,id:'U1',start:'10:00'},time:'10:00'});
    const second=api.dispatch.create(session.shiftId,{order:{...order,id:'U2',start:'10:00'},time:'10:00'});
    const ready=await api.dispatch.search(first.id);assert.equal(ready.status,'WAITING',ready.error);
    api.dispatch.accept(first.id,ready.candidates[0].id);
    assert.equal(clock().speed,1);assert.equal(clock().awaitingDecision,true);
    api.dispatch.cancel(second.id);
    assert.equal(clock().speed,300);assert.equal(clock().playing,false);assert.equal(clock().awaitingDecision,false);
  }finally{api.close();f.store.close();}
});

test('incident creation is idempotent and reading a notice never solves it',()=>{
  const f=fixture();try{const first=f.create();assert.equal(f.create().id,first.id);f.dispatch.read(first.id,first.notifications[0].id);assert.equal(f.dispatch.get(first.id).status,'QUEUED');assert.equal(f.store.get(f.shift.id).revision,1);}finally{f.store.close();}
});

test('an available engineer still at their confirmed home is offered as a home departure', async () => {
  const f = fixture();
  try {
    const home = {...engineer,startPoint:{kind:'home',address:'Адрес старта',coords:engineer.startCoords,confirmed:true,availableFrom:'08:00',scenario:true}};
    f.store.ensure({regionId:f.shift.regionId,date:f.shift.date,orders:[order],team:[home],plan:initial});
    const item = await f.dispatch.search(f.create().id);
    assert.equal(item.status,'WAITING',item.error);
    assert.equal(item.candidates[0].kind,'Выезд из дома');
    assert.equal(item.candidates[0].startPoint.address,'Адрес старта');
  } finally {f.store.close();}
});

test('clock ticks retain the selected speed without loading full shift archives', async () => {
  const f = fixture();
  const api = createDispatchApi(f.store, {routing:f.dispatch.routing});
  const post = (path, body) => api.handle(new Request(`http://localhost${path}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  try {
    const created = await (await post('/api/dispatch/sessions',{baseShiftId:f.shift.id,speed:300})).json();
    const clock = `/api/dispatch/shifts/${created.shiftId}/clock`;
    const started = await (await post(clock,{minute:500,playing:true,speed:300})).json();
    assert.equal(started.clock.speed, 300);
      const stale=await (await post(clock,{minute:420,playing:false,speed:60,serverClockVersion:created.clock.version})).json();
      assert.equal(stale.clock.minute,500);assert.equal(stale.clock.speed,300);assert.equal(stale.clock.version,started.clock.version);
    let archiveReads = 0;
    const get = f.store.get.bind(f.store);
    f.store.get = (...args) => { archiveReads += 1; return get(...args); };
    const tick = await (await post(clock,{serverTick:true})).json();
    assert.equal(tick.clock.speed, 300);
    assert.equal(tick.clock.playing, true);
    assert.ok(tick.clock.minute >= 500);
    assert.equal(archiveReads, 0);
    assert.equal(tick.incidents, undefined);
  } finally { api.close(); f.store.close(); }
});

test('incidents within one shift are searched in event order', async () => {
  const f = fixture();
  try {
    const old = f.create('old');
    f.advance(1);
    const current = f.create('current');
    await f.dispatch.tick();
    assert.equal(f.dispatch.get(current.id).status, 'QUEUED');
    assert.equal(f.dispatch.get(old.id).status, 'WAITING');
    f.dispatch.cancel(old.id);
    assert.equal(f.dispatch.hasPending(f.shift.id), true);
    assert.deepEqual(f.dispatch.active(f.shift.id).map(item => item.id), [current.id]);
  } finally { f.store.close(); }
});

test('interception cards expose the destination recipient while preserving the quality recommendation', async () => {
  const store = new ShiftStore(':memory:');
  try {
    const receiver = { ...engineer, id: 'E2', name: 'Инженер 2' };
    const original = { ...initial.routes[0], assignments: [{ ...initial.routes[0].assignments[0], departureAt: '09:50', travelMinutes: 130 }] };
    const shift = store.ensure({regionId:'intercept', date:'2026-08-17',orders:[order],team:[engineer,receiver],plan:{...initial,routes:[original]}});
    const routing = async payload => {
      const emergency = {orderId:payload.event.orderId,departureAt:'10:00',arrival:'10:10',plannedStart:'10:10',plannedFinish:'11:30',travelMinutes:10,geometry:[engineer.startCoords,payload.event.order.coords]};
      const best = {...initial,contentSha256:'c'.repeat(64),routes:[original,{engineerId:'E2',assignments:[emergency]}],metrics:{total:2,assigned:2}};
      const intercept = {...initial,contentSha256:'d'.repeat(64),routes:[
        {engineerId:'E1',assignments:[emergency],movements:[{measured_at:'2026-08-17T10:00:00+03:00',at:'2026-08-17T10:00:00+03:00',source_job_id:'J1',coords:[55.701,37.601]}]},
        {engineerId:'E2',assignments:initial.routes[0].assignments},
      ],metrics:{total:2,assigned:2}};
      return {dispatchCandidates:[{engineerSourceId:'E2',plan:best},{engineerSourceId:'E1',plan:intercept}],dispatchSearch:{complete:true,rejected:[]}};
    };
    const dispatch = new EmergencyDispatch(store,{routing});
    const incident = dispatch.create(shift.id,{order:{...order,id:'U',start:'10:00'},time:'10:00'});
    const result = await dispatch.search(incident.id);
    assert.equal(result.status, 'WAITING', result.error);
    assert.equal(result.candidates[0].kind, 'Перехват в пути');
    assert.equal(result.candidates[0].interception.receiverName, receiver.name);
    assert.equal(result.candidates[0].interception.orderId, 'J1');
    assert.equal(result.recommendedId, result.candidates[1].id);
  } finally { store.close(); }
});
test('manual decision wins once; duplicate callbacks return that same decision',async()=>{
  const f=fixture();try{const item=await f.dispatch.search(f.create().id);assert.equal(item.status,'WAITING');const selected=item.candidates[0];const accepted=f.dispatch.accept(item.id,selected.id,'Диспетчер');f.advance(301);await f.dispatch.tick();assert.deepEqual(f.dispatch.accept(item.id,selected.id,'system').decision,accepted.decision);assert.equal(f.store.get(f.shift.id).revision,2);assert.equal(f.store.get(f.shift.id).events.length,1);}finally{f.store.close();}
});

test('reopened published decisions compare against the saved source revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beego-comparison-'));
  const file = join(directory, 'shift.sqlite3');
  const f = fixture(file);
  let reopened;
  try {
    const incident = await f.dispatch.search(f.create().id);
    const candidate = incident.candidates[0];
    f.dispatch.accept(incident.id, candidate.id, 'Диспетчер');
    f.store.close();
    reopened = new ShiftStore(file);
    const saved = new EmergencyDispatch(reopened).get(incident.id).candidates[0];
    const shift = reopened.get(f.shift.id);
    assert.equal(shift.revision, 2);
    assert.equal(saved.basePlanContentSha256, initial.contentSha256);
    const detail = dispatchPreviewDetail(shift, saved);
    assert.equal(detail.before.contentSha256, initial.contentSha256);
    assert.equal(detail.after.contentSha256, shift.plan.contentSha256);
    assert.notDeepEqual(detail.before, detail.after);
    assert.deepEqual(detail.before.routes[0].assignments.map(visit => visit.orderId), ['J1']);
    assert.deepEqual(detail.after.routes[0].assignments.map(visit => visit.orderId), ['U1', 'J1']);
    assert.notDeepEqual(dispatchRouteData(detail.before, detail), dispatchRouteData(detail.after, detail));
    const affected = dispatchPreviewDetail(shift, saved, {engineerId:'E2', scope:'next'});
    assert.equal(affected.before, detail.before);
    assert.equal(affected.scope, 'next');
    assert.deepEqual(affected.ids, ['E2']);
    assert.equal(affected.current.origin, null);
    assert.throws(() => dispatchPreviewDetail({...shift,versions:[]}, saved), /Исходная версия плана/);
    assert.throws(() => dispatchPreviewDetail(shift, {...saved,basePlanContentSha256:'wrong'}), /не совпадает/);
  } finally {
    if (reopened) reopened.close();
    else f.store.close();
    await rm(directory, {recursive:true,force:true});
  }
});

test('a stale worker snapshot cannot resurrect an accepted or cancelled incident',async()=>{
  const f=fixture();
  try {
    const ready=await f.dispatch.search(f.create().id);
    const stale=structuredClone(ready);
    const accepted=f.dispatch.accept(ready.id,ready.candidates[0].id);
    assert.equal(f.dispatch.save({...stale,status:'SEARCHING'}).decision.contentSha256,accepted.decision.contentSha256);
    assert.equal(f.dispatch.cancel(ready.id).status,'ACCEPTED');
    const second=f.create('U2');
    f.dispatch.cancel(second.id);
    assert.equal(f.dispatch.save({...second,status:'QUEUED'}).status,'CANCELLED');
    assert.equal(f.store.get(f.shift.id).revision,2);
  } finally { f.store.close(); }
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

test('actual mode without an observation does not promote playback coordinates to a measured position',()=>{
  const shift={date:'2026-08-17',revision:1,plan:initial,team:[engineer],orders:[order],facts:[]};
  const state=operationalStates(shift,700,'fact')[0];
  assert.equal(state.status,'unknown');
  assert.equal(state.coords,null);
  assert.equal(state.availableAt,null);
  assert.equal(state.source,'unknown');
});
test('day start requires a confirmed dated point and cannot rewrite an executing day',()=>{
  const f=fixture();try{const event={type:'START_CHANGED',time:'07:00',engineerId:'E1',reason:'Старт из дома',startPoint:{kind:'home',confirmed:true,date:'2026-08-17',coords:[55.72,37.64],address:'Дом',source:'confirmed-registry',availableFrom:'08:30'}};assert.deepEqual(eventModel(f.shift,event).team[0].startCoords,event.startPoint.coords);assert.throws(()=>eventModel({...f.shift,facts:[{status:'started'}]},event),/начала дня/);assert.throws(()=>eventModel(f.shift,{...event,startPoint:{...event.startPoint,confirmed:false}}),/Подтвердите/);}finally{f.store.close();}
});
test('notification type is explicit and elapsed road geometry remains visible',()=>{
  assert.equal(notificationPresentation({type:'EMERGENCY_INCIDENT',title:'Новая авария'}).title,'Новая авария');const segments=playbackRouteSegments({assignments:[],movements:[{at:'2026-08-17T11:17:00+03:00',geometry:[[55.7,37.6],[55.71,37.61]]}]},678);assert.equal(segments.travelled.length,1);
});

const setScenarioMinute = (f, minute) => {
  const session = {clock:{minute,playing:false,speed:1,anchorAt:100000}};
  f.store.db.prepare('INSERT OR REPLACE INTO dispatch_sessions VALUES (?,?,?,?)').run('test-clock', f.shift.id, f.shift.id, JSON.stringify(session));
};

for(const playing of [false,true]) test(`confirming a minute-old selection publishes that engineer once and restores ×300, playing=${playing}`,async()=>{
  const f=fixture();
  try{
    const ready=await f.dispatch.search(f.create().id),chosen=ready.candidates[0];
    const session={clock:{minute:601,playing,speed:1,anchorAt:100000},preIncidentSpeed:300};
    f.store.db.prepare('INSERT INTO dispatch_sessions VALUES (?,?,?,?)').run('confirm-clock',f.shift.id,f.shift.id,JSON.stringify(session));
    const clock=()=>JSON.parse(f.store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=?').get(f.shift.id).payload).clock;
    const routing=f.dispatch.routing;
    let refreshes=0;
    f.dispatch.routing=async payload=>{
      refreshes++;assert.equal(payload.event.time,'10:01');assert.equal(clock().confirmingDecision,true);
      f.advance(120);assert.equal(f.dispatch.currentMinute(f.dispatch.get(ready.id)),601,'Scenario time stays anchored throughout the fresh road check');
      const result=await routing(payload);
      const plan=result.dispatchCandidates[0].plan;
      plan.contentSha256='c'.repeat(64);
      const visit=plan.routes[0].assignments[0];
      Object.assign(visit,{departureAt:'10:01',arrival:'10:11',plannedStart:'10:11',plannedFinish:'11:31'});
      return result;
    };
    const first=f.dispatch.confirm(ready.id,chosen.id);
    const duplicate=f.dispatch.confirm(ready.id,chosen.id);
    assert.equal(first,duplicate);
    const applied=await first;
    assert.equal(applied.status,'ACCEPTED',applied.error);
    assert.equal(applied.confirmation.state,'APPLIED');
    const accepted=applied.candidates.find(c=>c.id===applied.decision.candidateId);
    assert.equal(accepted.engineer.id,chosen.engineer.id);
    assert.equal(accepted.visit.departureAt,'10:01');
    assert.equal(f.store.get(f.shift.id).revision,2);
    assert.equal(refreshes,1);assert.equal(clock().speed,300);assert.equal(clock().playing,playing);
    assert.equal(clock().confirmingDecision,false);
    assert.equal(clock().minute,601,'Revalidation wall time must not be replayed at ×300');
    await f.dispatch.tick();assert.equal(f.dispatch.get(ready.id).status,'ACCEPTED');assert.equal(refreshes,1);
  }finally{f.store.close();}
});

test('a stale selection cannot silently substitute a different engineer',async()=>{
  const f=fixture();
  try{
    const ready=await f.dispatch.search(f.create().id);
    setScenarioMinute(f,601);
    f.dispatch.routing=async()=>({dispatchCandidates:[],dispatchSearch:{complete:true,rejected:[]}});
    const result=await f.dispatch.confirm(ready.id,ready.candidates[0].id);
    assert.equal(result.status,'ERROR');assert.equal(result.confirmation.state,'FAILED');
    assert.match(result.error,/Не удалось подтвердить маршрут/);
    f.advance(60);await f.dispatch.tick();
    assert.equal(f.dispatch.get(ready.id).status,'ERROR','A failed confirmation must not launch generic search on its own');
    assert.equal(f.store.get(f.shift.id).revision,1);
  }finally{f.store.close();}
});

test('manual and automatic decisions cannot publish a route from before the scenario clock', async () => {
  for (const automatic of [false, true]) {
    const f = fixture();
    try {
      const ready = await f.dispatch.search(f.create().id);
      setScenarioMinute(f, 1380);
      if (automatic) { f.advance(301); await f.dispatch.tick(); }
      else f.dispatch.accept(ready.id, ready.candidates[0].id);
      assert.equal(f.dispatch.get(ready.id).status, automatic ? 'ERROR' : 'QUEUED');
      assert.equal(f.store.get(f.shift.id).revision, 1);
      assert.equal(f.dispatch.get(ready.id).candidates.length, 0);
    } finally { f.store.close(); }
  }
});

test('a search uses the current clock, not the incident arrival time', async () => {
  const f = fixture();
  try {
    let sent;
    f.dispatch.routing = async payload => { sent = payload; throw new Error('captured'); };
    setScenarioMinute(f, 1380);
    await f.dispatch.search(f.create().id);
    assert.equal(sent.event.time, '23:00');
  } finally { f.store.close(); }
});

test('rejecting a stale partial result interrupts the old search and leaves it queued', async () => {
  const f = fixture();
  try {
    const routing = f.dispatch.routing;
    f.dispatch.routing = async (payload, root, {onProgress, signal}) => {
      const result = await routing(payload);
      onProgress({completed:1,total:2,dispatchCandidates:result.dispatchCandidates});
      await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      throw new Error('interrupted');
    };
    const item = f.create(), running = f.dispatch.search(item.id);
    await new Promise(resolve=>setImmediate(resolve));
    const partial = f.dispatch.get(item.id);
    assert.equal(partial.status,'WAITING');
    setScenarioMinute(f,1380);
    assert.equal(f.dispatch.accept(item.id,partial.candidates[0].id).status,'QUEUED');
    await running;
    assert.equal(f.dispatch.get(item.id).status,'QUEUED');
    assert.equal(f.dispatch.busy,false);
    assert.equal(f.store.get(f.shift.id).revision,1);
  } finally { f.store.close(); }
});

test('clock progression never hides a checked offer; publication still requires current validation', async () => {
  const f = fixture();
  try {
    const routing = f.dispatch.routing;
    f.dispatch.routing = async (payload, root, {onProgress}) => {
      const result = await routing(payload);
      setScenarioMinute(f, 601);
      onProgress({completed:1,total:2,dispatchCandidates:result.dispatchCandidates});
      const partial = f.dispatch.get(f.dispatch.all(f.shift.id)[0].id);
      assert.equal(partial.status, 'WAITING');
      assert.equal(partial.candidates[0].scenarioTime, '10:00');
      assert.equal(f.store.get(f.shift.id).revision, 1);
      return result;
    };
    const ready = await f.dispatch.search(f.create().id);
    assert.equal(ready.status, 'WAITING');
    assert.equal(ready.candidates.length, 1);
    assert.equal(f.dispatch.accept(ready.id, ready.candidates[0].id).status, 'QUEUED');
    assert.equal(f.store.get(f.shift.id).revision, 1);
  } finally { f.store.close(); }
});

test('a later accepted incident rebases older pending incidents on the new publication', async () => {
  const f = fixture();
  try {
    const older = f.create('early');
    const later = f.dispatch.create(f.shift.id,{order:{...order,id:'late',start:'10:05'},time:'10:05'});
    const checkpoints = [];
    f.dispatch.routing = async payload => {
      checkpoints.push(payload.event.time);
      const departure = Math.max(minuteOf(payload.event.time), ...payload.plan.routes.flatMap(route=>route.assignments.map(visit=>minuteOf(visit.plannedFinish))));
      const added = {orderId:payload.event.orderId,departureAt:timeOf(departure),arrival:timeOf(departure+10),plannedStart:timeOf(departure+10),plannedFinish:timeOf(departure+90),geometry:[engineer.startCoords,order.coords]};
      return {dispatchCandidates:[{engineerSourceId:'E1',plan:{...payload.plan,contentSha256:payload.event.orderId.padEnd(64,'a'),routes:[{...payload.plan.routes[0],assignments:[...payload.plan.routes[0].assignments,added]}]}}]};
    };
    const ready = await f.dispatch.search(later.id);
    assert.equal(ready.status,'WAITING',ready.error);
    assert.equal(f.dispatch.accept(later.id,ready.candidates[0].id).status,'ACCEPTED');
    const earlyReady = await f.dispatch.search(older.id);
    assert.equal(earlyReady.status,'WAITING',earlyReady.error);
    assert.deepEqual(checkpoints,['10:05','10:05']);
    assert.equal(f.dispatch.accept(older.id,earlyReady.candidates[0].id).status,'ACCEPTED');
    assert.equal(f.store.get(f.shift.id).revision,3);
  } finally { f.store.close(); }
});

test('search refreshes future duration snapshots after a normative change and preserves departed work', async () => {
  const f = fixture();
  try {
    const created = f.create();
    assert.equal(created.order.duration,80);
    const model = f.store.complexity.model();
    f.store.complexity.saveModel({...model,expectedVersion:model.version,norms:{...model.norms,emergency:[90,0]},effectiveAt:'2026-08-17T09:00:00+03:00',reason:'Проверка изменения норматива'});
    let sent;
    f.dispatch.routing = async payload => { sent = payload; throw new Error('captured'); };
    await f.dispatch.search(created.id);
    assert.equal(sent.orders.find(order=>order.id===created.order.id).duration,90);
    assert.equal(sent.event.order.durationSnapshot.total,90);
    assert.equal(sent.orders.find(order=>order.id==='J1').duration,90);
    setScenarioMinute(f, 750);
    await f.dispatch.search(created.id);
    assert.equal(sent.orders.find(order=>order.id==='J1').duration,80);
    assert.deepEqual(sent.plan, initial);
  } finally { f.store.close(); }
});

test('overdue unfinished work does not abort searches for the rest of the team', async () => {
  const f = fixture();
  try {
    f.store.recordFact(f.shift.id,{orderId:'J1',engineerId:'E1',status:'started',time:'12:00'});
    setScenarioMinute(f, 850);
    let reached = false;
    f.dispatch.routing = async () => { reached = true; throw new Error('captured'); };
    await f.dispatch.search(f.create().id);
    assert.equal(reached,true);
  } finally { f.store.close(); }
});

test('started work has a forecast release until overdue and home availability applies to playback and reserve', () => {
  const home = {...engineer,startPoint:{kind:'home',availableFrom:'15:00'}};
  const shift = {date:'2026-08-17',revision:1,team:[home],orders:[order],plan:initial,facts:[]};
  assert.equal(operationalStates(shift,600)[0].status,'before_shift');
  assert.equal(operationalStates(shift,600)[0].availableAt,'15:00');
  assert.equal(playbackFrame(shift,600).crews[0].status,'off_shift');
  const working = {...shift,team:[engineer],facts:[{orderId:'J1',engineerId:'E1',status:'started',time:'12:00'}]};
  assert.equal(operationalStates(working,730)[0].availableAt,'13:20');
  assert.equal(operationalStates(working,810)[0].availableAt,null);
});

for (const automatic of [false,true]) test(`the selected travelling engineer can finish the reached job before dispatch, automatic=${automatic}`,async()=>{
  const f=fixture();
  try {
    const ready=await f.dispatch.search(f.create().id),chosen=ready.candidates[0];
    // The kind is presentation state at the original checkpoint, not the engineer identity.
    chosen.kind='Перехват в пути';
    f.dispatch.save(ready);
    setScenarioMinute(f,720);
    const routing=f.dispatch.routing;
    f.dispatch.routing=async payload=>{
      const result=await routing(payload),plan=result.dispatchCandidates[0].plan;
      plan.contentSha256='d'.repeat(64);
      const visit=plan.routes[0].assignments.shift();
      Object.assign(visit,{departureAt:'13:20',arrival:'13:30',plannedStart:'13:30',plannedFinish:'14:50'});
      plan.routes[0].assignments.push(visit);
      return result;
    };
    if(automatic) {f.advance(301);await f.dispatch.tick();}
    else await f.dispatch.confirm(ready.id,chosen.id);
    const applied=f.dispatch.get(ready.id);
    assert.equal(applied.status,'ACCEPTED',applied.error);
    const current=applied.candidates.find(c=>c.id===applied.decision.candidateId);
    assert.equal(current.engineer.id,chosen.engineer.id);
    assert.equal(current.kind,'После текущей работы');
    assert.equal(current.visit.departureAt,'13:20');
    assert.match(applied.confirmation.routeUpdate,/после текущей работы/);
    assert.equal(f.store.get(f.shift.id).revision,2);
  }finally{f.store.close();}
});

test('a server-issued selection survives replacement of the cards by a newer search',async()=>{
  const f=fixture();
  try {
    const ready=await f.dispatch.search(f.create().id),chosen=ready.candidates[0];
    setScenarioMinute(f,601);
    const routing=f.dispatch.routing;
    let calls=0;
    f.dispatch.routing=async payload=>{
      const result=await routing(payload),plan=result.dispatchCandidates[0].plan;
      plan.contentSha256=String(++calls).repeat(64);
      Object.assign(plan.routes[0].assignments[0],{departureAt:'10:01',arrival:'10:11',plannedStart:'10:11',plannedFinish:'11:31'});
      return result;
    };
    const replaced=await f.dispatch.search(ready.id);
    assert.notEqual(replaced.candidates[0].id,chosen.id);
    const applied=await f.dispatch.confirm(ready.id,chosen.id);
    assert.equal(applied.status,'ACCEPTED',applied.error);
    assert.equal(applied.candidates.find(c=>c.id===applied.decision.candidateId).engineer.id,chosen.engineer.id);
    assert.equal(f.store.get(f.shift.id).revision,2);
    assert.ok(applied.offeredChoices.length<=50);
  }finally{f.store.close();}
});

test('confirmation waits for a busy planner without clearing or substituting the selected engineer',async()=>{
  const f=fixture();
  let release;
  try {
    const ready=await f.dispatch.search(f.create().id),chosen=ready.candidates[0];
    setScenarioMinute(f,601);
    const routing=f.dispatch.routing;
    f.dispatch.routing=async payload=>{
      const result=await routing(payload),plan=result.dispatchCandidates[0].plan;
      plan.contentSha256='e'.repeat(64);
      Object.assign(plan.routes[0].assignments[0],{departureAt:'10:01',arrival:'10:11',plannedStart:'10:11',plannedFinish:'11:31'});
      return result;
    };
    release=acquirePlanningSlot();assert.ok(release);
    const pending=f.dispatch.confirm(ready.id,chosen.id);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.dispatch.get(ready.id).confirmation.state,'CHECKING');
    assert.equal(f.dispatch.currentMinute(ready),601);
    release();
    const applied=await pending;
    assert.equal(applied.status,'ACCEPTED',applied.error);
    assert.equal(applied.decision.candidateId,applied.candidates.find(c=>c.engineer.id===chosen.engineer.id).id);
  }finally{release?.();f.store.close();}
});

test('three simultaneous decisions in one shift publish in sequence without racing the held clock',async()=>{
  const f=fixture();
  try {
    const incidents=['U1','U2','U3'].map(id=>f.create(id));
    let active=0,maxActive=0;
    f.dispatch.routing=async payload=>{
      active++;maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setImmediate(resolve));
      const departure=Math.max(minuteOf(payload.event.time),...payload.plan.routes.flatMap(r=>r.assignments.map(v=>minuteOf(v.plannedFinish))));
      const visit={orderId:payload.event.orderId,departureAt:timeOf(departure),arrival:timeOf(departure+1),plannedStart:timeOf(departure+1),plannedFinish:timeOf(departure+81),geometry:[engineer.startCoords,order.coords]};
      const plan={...payload.plan,contentSha256:`${payload.event.orderId}-${payload.plan.contentSha256}`.slice(0,64),routes:[{...payload.plan.routes[0],assignments:[...payload.plan.routes[0].assignments,visit]}],metrics:{total:payload.orders.length,assigned:payload.orders.length}};
      active--;
      return {dispatchCandidates:[{engineerSourceId:'E1',plan}],dispatchSearch:{eligible:['E1'],rejected:[]}};
    };
    const choices=[];
    for(const incident of incidents) choices.push((await f.dispatch.search(incident.id)).candidates[0]);
    const applied=await Promise.all(incidents.map((incident,i)=>f.dispatch.confirm(incident.id,choices[i].id)));
    assert.deepEqual(applied.map(item=>item.status),['ACCEPTED','ACCEPTED','ACCEPTED'],JSON.stringify(applied.map(item=>item.error)));
    assert.equal(maxActive,1);
    assert.equal(f.store.get(f.shift.id).revision,4);
  }finally{f.store.close();}
});
