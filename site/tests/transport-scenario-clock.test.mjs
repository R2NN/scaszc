import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransportScenarioClock } from '../src/transportScenarioClock.js';
import { transportFocusSegments } from '../src/transportDomain.js';

test('application-level clock fires while Orders is open, pauses, and does not duplicate a wave',async()=>{
  let value={minute:864,playing:true},listener,tab='orders';
  const shift={id:'s',regionId:'moscow:scenario:transport-demo',revision:2};
  const calls=[],events=[],adoptions=[];
  let index=0;
  const clock={getSnapshot:()=>value,subscribe:fn=>{listener=fn;return()=>{listener=null;};}};
  const controller=createTransportScenarioClock({clock,getShift:()=>shift,
    request:async(path,body)=>{
      calls.push({path,body,tab});
      if(path.startsWith('scenario?'))return {index,waves:[{time:'09:30'},{time:'14:25'}]};
      if(path.startsWith('previews/latest'))return {status:'APPLIED'};
      if(path==='scenario/tick'){index=1;return {shift,clock:{minute:865,playing:false},event:{id:'metro'},state:{index}};}
      return {id:'p',status:'RUNNING'};
    },adopt:(id,clockValue)=>{adoptions.push(id);value=clockValue;},onEvent:result=>{events.push(result);tab='transport';},onError:error=>{throw error;}});
  await controller.flush();value={minute:865,playing:true};listener();listener();await controller.flush();
  assert.equal(calls.filter(call=>call.path==='scenario/tick').length,1);
  assert.equal(calls.find(call=>call.path==='scenario/tick').tab,'orders');
  assert.equal(value.playing,false);assert.deepEqual(adoptions,['s']);assert.equal(events.at(-1).preview.id,'p');
  listener();await controller.flush();assert.equal(calls.filter(call=>call.path==='previews').length,1);
  controller.close();assert.equal(listener,null);
});

test('an unresolved preview and leaving the shift scope cannot publish a hidden event',async()=>{
  let listener,shift={id:'s',regionId:'moscow:scenario:transport-demo',revision:1},release;
  const clock={getSnapshot:()=>({minute:865}),subscribe:fn=>{listener=fn;return()=>{};}};
  const calls=[];
  const controller=createTransportScenarioClock({clock,getShift:()=>shift,request:async path=>{
    calls.push(path);if(path.startsWith('scenario?'))return {index:0,waves:[{time:'09:30'},{time:'14:25'}]};return {status:'READY'};
  },adopt:()=>assert.fail(),onEvent:()=>assert.fail(),onError:()=>assert.fail()});
  await controller.flush();assert.equal(calls.length,2);controller.close();
  const other=createTransportScenarioClock({clock,getShift:()=>shift,request:async()=>new Promise(resolve=>{release=resolve;}),adopt:()=>assert.fail(),onEvent:()=>assert.fail(),onError:()=>assert.fail()});
  shift={id:'other'};release({index:0,waves:[{time:'09:30'},{time:'14:25'}]});await other.flush();other.close();
});

test('a Domodedovo detour is framed without completed or cancelled Moscow restrictions',()=>{
  const local=[[55.43,37.75],[55.431,37.751]],moscow=[[55.75,37.6],[55.76,37.61]];
  const ended={id:'past',status:'OPEN',startsAt:'2026-08-17T09:30:00+03:00',endsAt:'2026-08-17T11:00:00+03:00',segments:[{geometry:moscow}]};
  const active={...ended,id:'local',endsAt:null,segments:[{geometry:local}]};
  const segments=transportFocusSegments({orders:[{geometryAfter:local}],events:[ended,active,{...ended,status:'CANCELLED'}],selected:ended,date:'2026-08-17',minute:900});
  assert.ok(segments.length>0);assert.ok(segments.flatMap(segment=>segment.geometry).every(([lat])=>lat<55.5));
  assert.equal(transportFocusSegments({events:[ended],date:'2026-08-17',minute:660}).length,0);
});
