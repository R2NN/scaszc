import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { transportDecisionPlayback,reconcileDispatchPlayback } from '../server/dispatchPlayback.mjs';
import { transportPlaybackClock } from '../src/transportPlaybackClock.js';

const setup=()=>{
  const db=new Database(':memory:');db.exec('CREATE TABLE dispatch_sessions(id TEXT,shift_id TEXT,payload TEXT)');
  const session={id:'session',shiftId:'shift',clock:{minute:570,playing:true,speed:300,anchorAt:1000,version:3}};
  const write=value=>db.prepare('INSERT OR REPLACE INTO dispatch_sessions(rowid,id,shift_id,payload) VALUES(1,?,?,?)').run('session','shift',JSON.stringify(value));
  write(session);return {db,write,read:()=>JSON.parse(db.prepare('SELECT payload FROM dispatch_sessions').get().payload)};
};

test('transport review advances at ×1, survives repeats and restores ×300 after apply',()=>{
  const s=setup();try{
    const clock=transportDecisionPlayback(s,'shift',{now:1000});assert.equal(clock.speed,1);assert.equal(clock.playing,true);assert.equal(clock.awaitingTransport,true);
    const later=transportDecisionPlayback(s,'shift',{now:31000});assert.equal(later.minute,570.5);assert.equal(s.read().preTransportSpeed,300);
    const session=s.read();reconcileDispatchPlayback(session,false,31000);s.write(session);assert.equal(session.clock.speed,1,'An empty emergency queue cannot restore transport acceleration');
    const next=transportDecisionPlayback(s,'shift',{finish:true,now:61000});assert.equal(next.minute,571);assert.equal(next.speed,300);assert.equal(next.playing,true);assert.equal(next.awaitingTransport,false);assert.equal(s.read().preTransportSpeed,null);
  }finally{s.db.close();}
});

for(const first of ['transport','emergency'])test(`overlapping decisions retain the original acceleration (${first} resolves first)`,()=>{
  const s=setup();try{
    transportDecisionPlayback(s,'shift',{now:1000});let session=s.read();reconcileDispatchPlayback(session,true,1000);s.write(session);
    if(first==='transport'){
      assert.equal(transportDecisionPlayback(s,'shift',{finish:true,now:1000}).speed,1);
      session=s.read();reconcileDispatchPlayback(session,false,1000);s.write(session);
    }else{
      session=s.read();reconcileDispatchPlayback(session,false,1000);s.write(session);assert.equal(session.clock.speed,1);
      transportDecisionPlayback(s,'shift',{finish:true,now:1000});
    }
    assert.equal(s.read().clock.speed,300);assert.equal(s.read().clock.playing,true);
  }finally{s.db.close();}
});

test('a paused show starts real time on a new problem and a retired run cannot be restarted',()=>{
  const s=setup();try{
    let value=s.read();value.clock.playing=false;s.write(value);
    assert.equal(transportDecisionPlayback(s,'shift',{now:1000}).playing,true);
    value=s.read();value.restartedAs='new';s.write(value);
    assert.throws(()=>transportDecisionPlayback(s,'shift',{finish:true}),/устарел/);
  }finally{s.db.close();}
});

test('ordinary playback remembers acceleration through repeated checks and resumes after apply',()=>{
  let state={minute:570,playing:false,speed:120};const clock={getSnapshot:()=>state,set:patch=>{state={...state,...patch};}};
  transportPlaybackClock(clock,'ordinary');transportPlaybackClock(clock,'ordinary');assert.equal(state.speed,1);assert.equal(state.playing,true);
  transportPlaybackClock(clock,'ordinary',null,{finish:true});assert.equal(state.speed,120);assert.equal(state.playing,true);assert.equal(state.awaitingTransport,false);
});

for(const emergency of [false,true])test(`manual speed survives transport retries, rewind and resolution (emergency=${emergency})`,()=>{
  const s=setup();try{
    transportDecisionPlayback(s,'shift',{now:1000});
    let session=s.read();reconcileDispatchPlayback(session,emergency,1000);
    session.clock={...session.clock,minute:540,playing:false,speed:120,reviewSpeed:120};s.write(session);
    reconcileDispatchPlayback(session,emergency,31000);s.write(session);
    assert.equal(session.clock.speed,120);assert.equal(session.clock.minute,540);assert.equal(session.clock.playing,false);
    const retry=transportDecisionPlayback(s,'shift',{now:31000});assert.equal(retry.speed,120);
    assert.equal(transportDecisionPlayback(s,'shift',{finish:true,now:31000}).speed,120);
    session=s.read();reconcileDispatchPlayback(session,false,31000);assert.equal(session.clock.speed,120);assert.equal(session.clock.reviewSpeed,null);
  }finally{s.db.close();}
});

test('ordinary review and publication respect the manually selected speed',()=>{
  let state={minute:570,playing:false,speed:300};const clock={getSnapshot:()=>state,set:patch=>{state={...state,...patch};}};
  transportPlaybackClock(clock,'ordinary');state={...state,minute:540,speed:60,reviewSpeed:60};
  transportPlaybackClock(clock,'ordinary');assert.equal(state.speed,60);
  transportPlaybackClock(clock,'ordinary',null,{finish:true});assert.equal(state.speed,60);assert.equal(state.reviewSpeed,null);
  transportPlaybackClock(clock,'ordinary');assert.equal(state.speed,1,'The next independent problem defaults to real time');
});
