import test from 'node:test';
import assert from 'node:assert/strict';
import { transportMetroSelection } from '../src/transportMetroSelection.js';

const catalog={segments:[{kind:'metro',fromId:'a',toId:'b',bidirectional:true},{kind:'metro',fromId:'b',toId:'c',bidirectional:false},{kind:'transfer',fromId:'a',toId:'x',bidirectional:true}]};
test('pending station highlights only valid next stations of the selected restriction kind',()=>{
  assert.deepEqual([...transportMetroSelection(catalog,{kind:'metro',segments:[]},'a')],[['b','available'],['a','pending']]);
  assert.equal(transportMetroSelection(catalog,{kind:'metro',segments:[]},'c').has('b'),false);
  assert.equal(transportMetroSelection(catalog,{kind:'transfer',segments:[]},'a').get('x'),'available');
});
test('selected endpoints remain highlighted after selection finishes; the next start has priority',()=>{
  const draft={kind:'metro',segments:[catalog.segments[0]]};
  assert.deepEqual([...transportMetroSelection(catalog,draft,'')],[['a','selected'],['b','selected']]);
  assert.equal(transportMetroSelection(catalog,draft,'b').get('b'),'pending');
  assert.equal(transportMetroSelection(catalog,{kind:'entry',segments:[{fromId:'a'}]},'').get('a'),'selected');
  assert.equal(transportMetroSelection(catalog,{kind:'road',segments:[]},'a').size,0);
});
