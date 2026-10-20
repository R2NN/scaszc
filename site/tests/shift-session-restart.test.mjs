import test from 'node:test';
import assert from 'node:assert/strict';
import {createShiftSessionRestart} from '../src/shiftSessionRestart.js';

const fixture=()=>{
  let snapshot={minute:480,mode:'plan',speed:300},shift={id:'ordinary',regionId:'moscow',plan:{}};
  const listeners=new Set(),calls=[],values=[],errors=[];
  const clock={getSnapshot:()=>snapshot,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    set:patch=>{snapshot={...snapshot,...patch};for(const listener of listeners)listener();}};
  let finish,fail;
  const restart=createShiftSessionRestart({clock,getShift:()=>shift,
    start:input=>{calls.push(input);return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});},
    onValue:value=>{values.push(value);clock.set({restartDay:null,restartFromMinute:null});},onError:error=>errors.push(error)});
  return {clock,restart,calls,values,errors,finish:value=>finish(value),fail:error=>fail(error),setShift:value=>{shift=value;}};
};
const rewind=clock=>clock.set({minute:360,playing:false,restartDay:'rewind',restartFromMinute:480});

test('rewinding an ordinary shift creates one new session without starting the scenario manually',async()=>{
  const f=fixture();
  try{
    assert.equal(f.calls.length,0);rewind(f.clock);f.clock.set({speed:300});
    assert.deepEqual(f.calls,[{baseShiftId:'ordinary',speed:300}]);
    f.finish({shiftId:'fresh'});await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(f.values,[{shiftId:'fresh'}]);assert.equal(f.clock.getSnapshot().restartDay,null);
  }finally{f.restart.close();}
});

test('passive 06:00, factual mode and an existing scenario do not create duplicate sessions',()=>{
  const f=fixture();
  try{
    f.clock.set({minute:360});assert.equal(f.calls.length,0);
    f.clock.set({mode:'fact'});rewind(f.clock);assert.equal(f.calls.length,0);
    f.setShift({id:'scenario',regionId:'moscow:scenario:one',plan:{}});f.clock.set({mode:'plan'});
    assert.equal(f.calls.length,0);
  }finally{f.restart.close();}
});

test('a late start cannot replace another selected day or leave its controls disabled',async()=>{
  const f=fixture();rewind(f.clock);f.setShift({id:'another-day',regionId:'moscow',plan:{}});f.restart.close();
  f.finish({shiftId:'late'});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.values,[]);assert.equal(f.clock.getSnapshot().restartDay,null);
});

test('failed restart restores the previous time and permits another explicit attempt',async()=>{
  const f=fixture();
  try{
    rewind(f.clock);f.fail(new Error('Offline'));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.clock.getSnapshot().minute,480);assert.equal(f.clock.getSnapshot().restartDay,null);
    assert.equal(f.errors[0].message,'Offline');rewind(f.clock);assert.equal(f.calls.length,2);
    f.finish({shiftId:'retry'});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.values[0].shiftId,'retry');
  }finally{f.restart.close();}
});
