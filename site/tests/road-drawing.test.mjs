import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleRoadStroke } from '../src/roadDrawing.js';

test('long brush strokes retain both endpoints within the network point limit',()=>{
  const points=Array.from({length:300},(_,index)=>[55.7,37.6+index*.0001]);
  const sampled=sampleRoadStroke(points);assert.equal(sampled.length,150);assert.deepEqual(sampled[0],points[0]);assert.deepEqual(sampled.at(-1),points.at(-1));
});

test('pointer jitter cannot lose the final stroke boundary',()=>{
  const points=[[55.7,37.6],[55.700001,37.600001],[55.700002,37.600002]];
  assert.deepEqual(sampleRoadStroke(points),[points[0],points.at(-1)]);assert.deepEqual(sampleRoadStroke([]),[]);
});
