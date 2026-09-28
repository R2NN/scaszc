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
