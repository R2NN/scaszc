import test from 'node:test';
import assert from 'node:assert/strict';
import {createDispatchClockSync} from '../src/dispatchClockSync.js';

const fixture=()=>{
  let state={minute:600,playing:false,speed:300,awaitingDecision:false}, writes=0;
  const listeners=new Set(), requests=[];
  const clock={getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},set:patch=>{state={...state,...patch};writes++;for(const fn of listeners)fn();}};
  const sync=createDispatchClockSync({clock,send:snapshot=>new Promise(resolve=>requests.push({snapshot,resolve}))});
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
