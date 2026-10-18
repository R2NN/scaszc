import test from 'node:test';
import assert from 'node:assert/strict';

test('automatic playback accumulates sub-minute frames without rerendering every frame', async () => {
  const queued = new Map();
  let nextId = 0;
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { const id = ++nextId; queued.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => queued.delete(id);
  try {
    const { shiftClock } = await import(`../src/shiftClock.js?test=${Date.now()}`);
    let renders = 0;
    const unsubscribe = shiftClock.subscribe(() => { renders += 1; });
    shiftClock.set({ minute: 480, speed: 60, playing: true });
    const step = stamp => { const [id, callback] = queued.entries().next().value; queued.delete(id); callback(stamp); };
    step(1000);
    step(1500);
    assert.equal(shiftClock.label(), '08:00');
    step(2000);
    assert.equal(shiftClock.label(), '08:01');
    assert.equal(renders, 2);
    shiftClock.set({ playing: false });
    unsubscribe();
  } finally {
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test('confirmation holds the scenario without changing play/pause and releases without replaying elapsed wall time',async()=>{
  const queued=new Map();let next=0;
  const originalRequest=globalThis.requestAnimationFrame,originalCancel=globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame=fn=>{queued.set(++next,fn);return next;};
  globalThis.cancelAnimationFrame=id=>queued.delete(id);
  try{
    const {shiftClock}=await import(`../src/shiftClock.js?hold=${Date.now()}`);
    const step=stamp=>{const [id,fn]=queued.entries().next().value;queued.delete(id);fn(stamp);};
    shiftClock.set({minute:601,speed:1,playing:true,confirmingDecision:true});
    step(1000);step(61000);assert.equal(shiftClock.getSnapshot().minute,601);assert.equal(shiftClock.getSnapshot().playing,true);
    shiftClock.set({speed:300,confirmingDecision:false});step(62000);
    assert.equal(shiftClock.getSnapshot().minute,606);
    shiftClock.set({playing:false});
  }finally{globalThis.requestAnimationFrame=originalRequest;globalThis.cancelAnimationFrame=originalCancel;}
});
