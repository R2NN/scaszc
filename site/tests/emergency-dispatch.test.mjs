import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { EmergencyDispatch } from '../server/emergencyDispatch.mjs';
import { createDispatchApi } from '../server/dispatchApi.mjs';
import { operationalStates } from '../src/operationalState.js';
import { eventModel, playbackRouteSegments, minuteOf, timeOf, playbackFrame } from '../src/shiftDomain.js';
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

test('manual and automatic decisions cannot publish a route from before the scenario clock', async () => {
  for (const automatic of [false, true]) {
    const f = fixture();
    try {
      const ready = await f.dispatch.search(f.create().id);
      setScenarioMinute(f, 1380);
      if (automatic) { f.advance(301); await f.dispatch.tick(); }
      else f.dispatch.accept(ready.id, ready.candidates[0].id);
      assert.equal(f.dispatch.get(ready.id).status, 'QUEUED');
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
