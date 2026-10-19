import test from 'node:test';
import assert from 'node:assert/strict';
import {createDispatchClockSync,adoptDispatchClock} from '../src/dispatchClockSync.js';
import {shiftClock} from '../src/shiftClock.js';

const fixture=(scope)=>{
  let state={minute:600,playing:false,speed:300,awaitingDecision:false}, writes=0;
  const listeners=new Set(), requests=[];
  const clock={getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},set:patch=>{state={...state,...patch};writes++;for(const fn of listeners)fn();}};
  const sync=createDispatchClockSync({clock,scope,send:snapshot=>new Promise(resolve=>requests.push({snapshot,resolve}))});
  return{clock,sync,requests,writes:()=>writes};
};
test('polls cannot overwrite in-flight controls or reapply an older emergency speed after restoration',async()=>{
  const f=fixture();
  try{
    f.clock.set({playing:true});
    f.clock.set({playing:false});
    f.sync.apply({version:3,speed:1,playing:true,minute:600,awaitingDecision:true});
    assert.equal(f.clock.getSnapshot().speed,300);
    f.requests[0].resolve({clock:{version:4,speed:1,playing:true,minute:600,awaitingDecision:true}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.requests[1].snapshot.playing,false);
    f.requests[1].resolve({clock:{version:5,speed:1,playing:false,minute:600,awaitingDecision:true}});
    await f.sync.flush();
    assert.equal(f.clock.getSnapshot().speed,1);
    assert.equal(f.clock.getSnapshot().playing,false);
    f.sync.apply({version:6,speed:300,playing:false,minute:600,awaitingDecision:false});
    assert.equal(f.sync.apply({version:5,speed:1,playing:true,minute:600,awaitingDecision:true}),false,'Callers also discard incident snapshots accompanying old clocks');
    assert.equal(f.clock.getSnapshot().speed,300);
    assert.equal(f.clock.getSnapshot().playing,false);
    assert.equal(f.requests.length,2,'Remote updates do not echo back as local commands');
    const writes=f.writes();
    f.sync.apply({version:7,speed:300,playing:false,minute:600,awaitingDecision:false});
    assert.equal(f.writes(),writes,'Unchanged polls do not retrigger playback');
  }finally{f.sync.close();}
});

test('server scenario adoption discards a queued old minute and a late response',async()=>{
  const f=fixture('transport-adoption');
  try{
    f.sync.apply({version:1,minute:865,speed:60,playing:false});
    f.clock.set({minute:866});f.clock.set({minute:867});
    assert.equal(f.requests[0].snapshot.serverClockVersion,1);
    assert.equal(adoptDispatchClock('transport-adoption',{version:3,minute:570,speed:60,playing:false}),true);
    f.requests[0].resolve({clock:{version:2,minute:866,speed:60,playing:false}});await f.sync.flush();
    assert.equal(f.clock.getSnapshot().minute,570);assert.equal(f.requests.length,1);
    f.clock.set({minute:571});assert.equal(f.requests[1].snapshot.serverClockVersion,3);
    f.requests[1].resolve({clock:{version:4,minute:571,speed:60,playing:false}});await f.sync.flush();
    assert.equal(f.clock.getSnapshot().minute,571);
  }finally{f.sync.close();}
});

test('a new session consumes an adopted server minute before it can echo old local state',()=>{
  assert.equal(adoptDispatchClock('new-transport',{version:1,minute:420,speed:60,playing:false}),false);
  const f=fixture('new-transport');
  try{assert.equal(f.clock.getSnapshot().minute,420);assert.equal(f.requests.length,0);}finally{f.sync.close();}
});

test('a restarted session is delivered even though its clock version begins at one',async()=>{
  let state={minute:865,playing:false,speed:300},listener,received;
  const clock={getSnapshot:()=>state,set:patch=>{state={...state,...patch};listener?.();},subscribe:fn=>{listener=fn;return()=>{listener=null;};}};
  const sync=createDispatchClockSync({clock,send:async()=>({restarted:true,shiftId:'new-day',clock:{minute:360,playing:false,speed:300,version:1}}),onValue:value=>{received=value;}});
  try{
    sync.apply({minute:865,playing:false,speed:300,version:100});
    clock.set({minute:360,restartDay:'seek'});await sync.flush();
    assert.equal(received.shiftId,'new-day');assert.equal(received.clock.version,1);
  }finally{sync.close();}
});

test('only an explicit demonstration seek to 06:00 requests a restart',()=>{
  shiftClock.set({minute:865,mode:'plan',playing:false,restartDay:null});
  shiftClock.seek(600,{restartDay:true});assert.equal(shiftClock.getSnapshot().restartDay,null);
  shiftClock.seek(360,{restartDay:true});assert.ok(shiftClock.getSnapshot().restartDay);assert.equal(shiftClock.getSnapshot().restartFromMinute,600);
  shiftClock.seek(500,{restartDay:true});assert.equal(shiftClock.getSnapshot().minute,360,'Scrubbing is locked until the new day is adopted');
  shiftClock.set({minute:865,mode:'fact',restartDay:null});shiftClock.seek(360,{restartDay:true});assert.equal(shiftClock.getSnapshot().restartDay,null);
  shiftClock.set({minute:865,mode:'plan'});shiftClock.seek(360);assert.equal(shiftClock.getSnapshot().restartDay,null);
  shiftClock.seek(360,{restartDay:true});assert.equal(shiftClock.getSnapshot().restartDay,null,'Initial 06:00 is not a repeated reset');
});
