import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedObjectTimeObjects, clearObjectTimeObjects, loadObjectTimeObjects } from '../src/objectTimeData.js';

test('prefetch and an opened time layer share one in-flight request and its result', async () => {
  clearObjectTimeObjects();
  let calls=0, resolve;
  const loader=()=>{calls++;return new Promise(done=>{resolve=done;});};
  const first=loadObjectTimeObjects('/day-a',loader), second=loadObjectTimeObjects('/day-a',loader);
  assert.equal(first,second);
  await Promise.resolve();
  resolve([{id:'A'}]);
  assert.deepEqual(await second,[{id:'A'}]);
  assert.deepEqual(cachedObjectTimeObjects('/day-a'),[{id:'A'}]);
  await loadObjectTimeObjects('/day-a',loader);
  assert.equal(calls,1);
});
test('different day/filter inputs remain isolated and decisions invalidate cached objects', async () => {
  clearObjectTimeObjects();
  await loadObjectTimeObjects('/day-a?kind=local',async()=>[{id:'local'}]);
  await loadObjectTimeObjects('/day-b?kind=connection',async()=>[{id:'connection'}]);
  assert.deepEqual(cachedObjectTimeObjects('/day-a?kind=local'),[{id:'local'}]);
  assert.deepEqual(cachedObjectTimeObjects('/day-b?kind=connection'),[{id:'connection'}]);
  clearObjectTimeObjects();
  assert.equal(cachedObjectTimeObjects('/day-a?kind=local'),null);
});
test('a failed prefetch can be retried and an empty successful result is cached', async () => {
  clearObjectTimeObjects();
  await assert.rejects(loadObjectTimeObjects('/retry',async()=>{throw new Error('offline');}),/offline/);
  assert.deepEqual(await loadObjectTimeObjects('/retry',async()=>[]),[]);
  assert.deepEqual(cachedObjectTimeObjects('/retry'),[]);
});
