import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransportScenarioClock } from '../src/transportScenarioClock.js';
import { transportFocusSegments } from '../src/transportDomain.js';
import { notificationPresentation } from '../src/notificationPresentation.js';

test('a transport problem notification never claims routes are already built',()=>{
  assert.deepEqual(notificationPresentation({type:'TRANSPORT_EVENT',title:'Проблема на маршруте',message:'Новое ограничение показано на карте хода смены'}),
    {kind:'alert',title:'Проблема на маршруте'});
});

test('a pending rewind suppresses late scenario events and cannot adopt an old clock',async()=>{
  let value={minute:865},release,listener,calls=0;
  const controller=createTransportScenarioClock({clock:{getSnapshot:()=>value,subscribe:fn=>{listener=fn;return()=>{};}},getShift:()=>({id:'old',regionId:'moscow:scenario:old'}),
    request:async()=>{calls++;return new Promise(resolve=>{release=resolve;});},adopt:()=>assert.fail(),onEvent:()=>assert.fail(),onError:()=>assert.fail()});
  try{
    value={minute:360,restartDay:'seek'};listener();release({index:-1,waves:[{time:'09:30'}]});await controller.flush();
    listener();await controller.flush();assert.equal(calls,1);
  }finally{controller.close();}
});

test('application-level clock fires while Orders is open, pauses, and does not duplicate a wave',async()=>{
  let value={minute:864,playing:true},listener,tab='orders';
  const shift={id:'s',regionId:'moscow:scenario:ordinary-emergency-day',revision:2};
  const calls=[],events=[],adoptions=[];
  let index=0;
  const clock={getSnapshot:()=>value,subscribe:fn=>{listener=fn;return()=>{listener=null;};}};
  const controller=createTransportScenarioClock({clock,getShift:()=>shift,
    request:async(path,body)=>{
      calls.push({path,body,tab});
      if(path.startsWith('scenario?'))return {index,waves:[{time:'09:30'},{time:'14:25'}]};
      if(path.startsWith('previews/latest'))return {status:'APPLIED'};
      if(path==='scenario/tick'){index=1;return {shift,clock:{minute:865,playing:false},event:{id:'metro'},state:{index,waves:[{time:'09:30',eventId:'road'},{time:'14:25',eventId:'metro'}]}};}
      return {id:'p',status:'RUNNING'};
    },adopt:(id,clockValue)=>{adoptions.push(id);value=clockValue;},onEvent:result=>{events.push(result);tab='transport';},onError:error=>{throw error;}});
  await controller.flush();value={minute:865,playing:true};listener();listener();await controller.flush();
  assert.equal(calls.filter(call=>call.path==='scenario/tick').length,1);
  assert.equal(calls.find(call=>call.path==='scenario/tick').tab,'orders');
  assert.equal(value.playing,false);assert.deepEqual(adoptions,['s']);assert.equal(events.at(-1).preview.id,'p');
  listener();await controller.flush();assert.equal(calls.filter(call=>call.path==='previews').length,1);
  controller.close();assert.equal(listener,null);
});

test('an unresolved previous preview does not hide the next event; leaving shift scope drops late responses',async()=>{
  let listener,shift={id:'s',regionId:'moscow:scenario:transport-demo',revision:1},release;
  const clock={getSnapshot:()=>({minute:865}),subscribe:fn=>{listener=fn;return()=>{};}};
  const calls=[];
  const controller=createTransportScenarioClock({clock,getShift:()=>shift,request:async path=>{
    calls.push(path);if(path.startsWith('scenario?'))return {index:0,waves:[{time:'09:30',eventId:'road'},{time:'14:25'}]};
    if(path==='scenario/tick')return {shift,clock:{minute:865},event:{id:'metro'},state:{index:1,waves:[{eventId:'road'},{eventId:'metro'}]}};
    return {status:'READY',events:[{id:'road'}]};
  },adopt:()=>{},onEvent:()=>{},onError:()=>assert.fail()});
  await controller.flush();assert.ok(calls.includes('scenario/tick'));assert.ok(calls.includes('previews'));controller.close();
  const other=createTransportScenarioClock({clock,getShift:()=>shift,request:async()=>new Promise(resolve=>{release=resolve;}),adopt:()=>assert.fail(),onEvent:()=>assert.fail(),onError:()=>assert.fail()});
  shift={id:'other'};release({index:0,waves:[{time:'09:30'},{time:'14:25'}]});await other.flush();other.close();
});

test('busy planning retries without another clock tick, publishes once and keeps the event visible',async()=>{
  let listener,attempts=0,events=0,starts=0,value={minute:865,playing:true};
  const shift={id:'s',revision:1,regionId:'moscow:scenario:transport-demo'};
  const state={index:0,waves:[{time:'14:25',eventId:'metro',status:'OPEN'}]},notices=[];
  const controller=createTransportScenarioClock({retryMs:15,
    clock:{getSnapshot:()=>value,subscribe:fn=>{listener=fn;return()=>{};}},getShift:()=>shift,
    request:async(path)=>{
      if(path.startsWith('scenario?'))return state;
      if(path.startsWith('previews/latest'))return null;
      if(path==='scenario/tick'){events++;return {state};}
      if(path==='previews'){attempts++;if(attempts===1){const error=new Error('busy');error.status=429;throw error;}starts++;return {id:'p',status:'RUNNING'};}
      assert.fail(path);
    },adopt:()=>assert.fail(),onEvent:value=>notices.push(value),onError:error=>assert.fail(error.message)});
  try{
    await controller.flush();assert.equal(notices[0].waitingForPlanner,true);
    await new Promise(resolve=>setTimeout(resolve,60));await controller.flush();
    assert.equal(attempts,2);assert.equal(starts,1);assert.equal(events,0);
    assert.equal(notices.at(-1).preview.id,'p');
    listener();await controller.flush();assert.equal(starts,1);
  }finally{controller.close();}
});

for(const status of ['RUNNING','READY','FAILED','CANCELLED'])test(`restored ${status} calculation covering the event is not duplicated`,async()=>{
  const shift={id:'s',revision:1,regionId:'moscow:scenario:transport-demo'};
  const controller=createTransportScenarioClock({
    clock:{getSnapshot:()=>({minute:865}),subscribe:()=>()=>{}},getShift:()=>shift,
    request:async(path)=>{
      if(path.startsWith('scenario?'))return {index:0,waves:[{eventId:'e',status:'OPEN'}]};
      if(path.startsWith('previews/latest'))return {status,events:[{id:'e'}]};
      assert.fail('Unexpected retry '+path);
    },adopt:()=>assert.fail(),onEvent:()=>assert.fail(),onError:()=>assert.fail()});
  try{await controller.flush();}finally{controller.close();}
});

test('a newer event cancels only its obsolete shift calculation and retries after release',async()=>{
  const shift={id:'s',revision:1,regionId:'moscow:scenario:transport-demo'},calls=[];
  let oldStatus='RUNNING',attempts=0;
  const controller=createTransportScenarioClock({retryMs:15,
    clock:{getSnapshot:()=>({minute:865}),subscribe:()=>()=>{}},getShift:()=>shift,
    request:async(path)=>{
      calls.push(path);
      if(path.startsWith('scenario?'))return {index:1,waves:[{eventId:'old'},{eventId:'new',status:'OPEN'}]};
      if(path.startsWith('previews/latest'))return {id:'old-preview',status:oldStatus,events:[{id:'old'}]};
      if(path==='previews/old-preview/cancel'){oldStatus='CANCELLED';return {};}
      if(path==='previews'){if(++attempts===1){const e=new Error('release in progress');e.status=429;throw e;}return {id:'new-preview',status:'RUNNING'};}
      assert.fail(path);
    },adopt:()=>assert.fail(),onEvent:()=>{},onError:error=>assert.fail(error.message)});
  try{
    await controller.flush();await new Promise(resolve=>setTimeout(resolve,60));await controller.flush();
    assert.equal(calls.filter(p=>p==='previews/old-preview/cancel').length,1);assert.equal(attempts,2);
  }finally{controller.close();}
});

test('a real preview failure is reported once and waits for explicit retry',async()=>{
  const shift={id:'s',revision:1,regionId:'moscow:scenario:transport-demo'},failures=[];let attempts=0;
  const controller=createTransportScenarioClock({retryMs:15,
    clock:{getSnapshot:()=>({minute:865}),subscribe:()=>()=>{}},getShift:()=>shift,
    request:async(path)=>{
      if(path.startsWith('scenario?'))return {index:0,waves:[{eventId:'e',status:'OPEN'}]};
      if(path.startsWith('previews/latest'))return null;
      attempts++;const e=new Error('Invalid current input');e.status=422;throw e;
    },adopt:()=>assert.fail(),onEvent:()=>assert.fail(),onError:error=>failures.push(error.message)});
  try{
    await controller.flush();await new Promise(resolve=>setTimeout(resolve,60));await controller.flush();
    assert.equal(attempts,1);assert.deepEqual(failures,['Invalid current input']);
  }finally{controller.close();}
});

test('a current calculation started by another operator clears the waiting notice',async()=>{
  const shift={id:'s',revision:1,regionId:'moscow:scenario:transport-demo'},notices=[];
  let existing=null;
  const controller=createTransportScenarioClock({retryMs:15,
    clock:{getSnapshot:()=>({minute:865}),subscribe:()=>()=>{}},getShift:()=>shift,
    request:async(path)=>{
      if(path.startsWith('scenario?'))return {index:0,waves:[{eventId:'e',status:'OPEN'}]};
      if(path.startsWith('previews/latest'))return existing;
      existing={id:'other-operator',status:'RUNNING',events:[{id:'e'}]};
      const e=new Error('busy');e.status=429;throw e;
    },adopt:()=>assert.fail(),onEvent:value=>notices.push(value),onError:()=>assert.fail()});
  try{
    await controller.flush();await new Promise(resolve=>setTimeout(resolve,60));await controller.flush();
    assert.equal(notices[0].waitingForPlanner,true);assert.equal(notices[1].waitingForPlanner,false);
    assert.equal(notices[1].preview.id,'other-operator');assert.equal(notices.length,2);
  }finally{controller.close();}
});

test('a Domodedovo detour is framed without completed or cancelled Moscow restrictions',()=>{
  const local=[[55.43,37.75],[55.431,37.751]],moscow=[[55.75,37.6],[55.76,37.61]];
  const ended={id:'past',status:'OPEN',startsAt:'2026-08-17T09:30:00+03:00',endsAt:'2026-08-17T11:00:00+03:00',segments:[{geometry:moscow}]};
  const active={...ended,id:'local',endsAt:null,segments:[{geometry:local}]};
  const segments=transportFocusSegments({orders:[{geometryAfter:local}],events:[ended,active,{...ended,status:'CANCELLED'}],selected:ended,date:'2026-08-17',minute:900});
  assert.ok(segments.length>0);assert.ok(segments.flatMap(segment=>segment.geometry).every(([lat])=>lat<55.5));
  assert.equal(transportFocusSegments({events:[ended],date:'2026-08-17',minute:660}).length,0);
});
