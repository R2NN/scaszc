import test from 'node:test';
import assert from 'node:assert/strict';
import {createDispatchClockSync,adoptDispatchClock} from '../src/dispatchClockSync.js';

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
