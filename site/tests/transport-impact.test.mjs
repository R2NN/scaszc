import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransportImpactClock,transportPreviewMatches } from '../src/transportImpactClock.js';
import { transportEventImpacts,transportSelectedConsequences,transportCrewOrders } from '../src/transportDomain.js';

const road={id:'road',revision:1,kind:'road',direction:'forward',status:'OPEN',startsAt:'2026-08-17T09:30:00+03:00',endsAt:null,segments:[{id:'edge-1'}]};
const shift={id:'s',revision:1,date:'2026-08-17',regionId:'moscow',plan:{routes:[]}};
const clock=()=>{let value={minute:570,playing:true},listener;return {getSnapshot:()=>value,subscribe:fn=>{listener=fn;return()=>{listener=null;}},set:patch=>{value={...value,...patch};listener?.();}};};

test('every new saved problem triggers calculation outside the five-wave scenario',async()=>{
  const c=clock(),previews=[],seen=[];let events=[],calls=0;
  const controller=createTransportImpactClock({retryMs:15,clock:c,getShift:()=>shift,
    request:async(path,body)=>{
      if(path.startsWith('events?'))return {events};
      if(path.startsWith('previews/latest'))return previews.at(-1)||null;
      if(path==='previews'){calls++;const p={id:String(calls),status:'RUNNING',baseRevision:body.expectedRevision,events:[...events]};previews.push(p);return p;}
      assert.fail(path);
    },pause:async()=>c.set({playing:false}),onEvents:events=>seen.push(events),onPreview:()=>{},onWaiting:()=>{},onError:error=>assert.fail(error.message)});
  try{
    await controller.flush();assert.equal(calls,0);
    events=[road];await new Promise(resolve=>setTimeout(resolve,40));await controller.flush();
    assert.equal(calls,1);assert.equal(c.getSnapshot().playing,false);assert.equal(seen.at(-1)[0].id,'road');
    c.set({minute:571});await controller.flush();assert.equal(calls,1,'Clock ticks must not restart a current search');
  }finally{controller.close();}
});

test('a busy planner retries with paused clocks without an immediate request loop',async()=>{
  const c=clock();let attempts=0,pauses=0;const notices=[];
  const controller=createTransportImpactClock({retryMs:20,clock:c,getShift:()=>shift,
    request:async path=>{
      if(path.startsWith('events?'))return {events:[road]};
      if(path.startsWith('previews/latest'))return null;
      if(path==='previews'){attempts++;if(attempts<3){const e=new Error('busy');e.status=429;throw e;}return {id:'p'};}
      assert.fail(path);
    },pause:async()=>{pauses++;c.set({playing:false});},onEvents:()=>{},onPreview:()=>{},onWaiting:value=>notices.push(value),onError:()=>assert.fail()});
  try{
    await controller.flush();assert.ok(attempts<=2);assert.equal(pauses,1);
    await new Promise(resolve=>setTimeout(resolve,65));await controller.flush();assert.equal(attempts,3);assert.deepEqual(notices,[true,false]);
  }finally{controller.close();}
});

for(const status of ['FAILED','CANCELLED'])test(`a current ${status} result waits for an explicit click`,async()=>{
  const controller=createTransportImpactClock({clock:clock(),getShift:()=>shift,
    request:async path=>{
      if(path.startsWith('events?'))return {events:[road]};
      if(path.startsWith('previews/latest'))return {id:'old',status,baseRevision:1,events:[road]};
      assert.fail('Unsolicited retry');
    },pause:()=>assert.fail(),onEvents:()=>{},onPreview:()=>assert.fail(),onWaiting:()=>{},onError:()=>assert.fail()});
  try{await controller.flush();}finally{controller.close();}
});

test('fresh preview matching includes revisions, all restrictions and applied plan revision',()=>{
  const p={baseRevision:1,events:[road],status:'READY'};
  assert.equal(transportPreviewMatches(p,shift,[road]),true);
  assert.equal(transportPreviewMatches(p,shift,[{...road,revision:2}]),false);
  assert.equal(transportPreviewMatches(p,{...shift,revision:2},[road]),false);
  assert.equal(transportPreviewMatches({...p,status:'APPLIED',appliedRevision:2},{...shift,revision:2},[road]),true);
});

test('an event shows its directly affected crew and later jobs, excluding an unrelated metro crew',()=>{
  const s={orders:[{id:'a',sourceId:'A'},{id:'b',sourceId:'B'},{id:'c',sourceId:'C'}],plan:{routes:[{engineerId:'car',assignments:[{orderId:'a'},{orderId:'b'}]},{engineerId:'metro',assignments:[{orderId:'c'}]}]}};
  const consequences={orders:[{orderId:'a',engineerId:'car'},{orderId:'b',engineerId:'car'},{orderId:'c',engineerId:'metro'}],engineers:[{engineerId:'car',deltaMinutes:3},{engineerId:'metro',deltaMinutes:12}]};
  const impacts=transportEventImpacts(s,consequences,{violations:[{orderId:'A',eventId:'road'},{orderId:'C',eventId:'metro'}]},[road,{id:'metro'}]);
  const selected=transportSelectedConsequences(consequences,impacts,'road');
  assert.deepEqual(selected.engineers.map(e=>e.engineerId),['car']);assert.deepEqual(selected.orders.map(o=>o.orderId),['a','b']);assert.equal(selected.addedTravelMinutes,3);
  assert.deepEqual(selected.directOrderIds,['a']);
});

test('an automatic saved-event check waits for the operator’s running form calculation',async()=>{
  let draft=true,starts=0;
  const controller=createTransportImpactClock({retryMs:15,clock:clock(),getShift:()=>shift,
    request:async path=>{
      if(path.startsWith('events?'))return {events:[road]};
      if(path.startsWith('previews/latest'))return draft?{id:'draft',hasDraft:true,status:'RUNNING',baseRevision:1,events:[road,{...road,id:'draft'}]}:null;
      if(path==='previews'){starts++;return {id:'saved',status:'RUNNING'};}
      assert.fail('The operator’s calculation must not be cancelled');
    },pause:async()=>{},onEvents:()=>{},onPreview:()=>{},onWaiting:()=>{},onError:error=>assert.fail(error.message)});
  try{await controller.flush();assert.equal(starts,0);draft=false;await new Promise(resolve=>setTimeout(resolve,35));await controller.flush();assert.equal(starts,1);}finally{controller.close();}
});

test('a transferred job displays each crew’s own route geometry only',()=>{
  const order={orderId:'job',beforeEngineerId:'old',engineerId:'new',geometryBefore:[[1,2],[3,4]],geometryAfter:[[5,6],[7,8]],stepsAfter:[{mode:'car'}]};
  const before=transportCrewOrders([order],'old'),after=transportCrewOrders([order],'new');
  assert.deepEqual(before[0].geometryBefore,order.geometryBefore);assert.deepEqual(before[0].geometryAfter,[]);assert.deepEqual(before[0].stepsAfter,[]);
  assert.deepEqual(after[0].geometryBefore,[]);assert.deepEqual(after[0].geometryAfter,order.geometryAfter);
  assert.deepEqual(transportCrewOrders([order],'unrelated'),[]);
});
