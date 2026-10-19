import test from 'node:test';
import assert from 'node:assert/strict';
import { transportMetroSelection,metroSectionBetween } from '../src/transportMetroSelection.js';

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

test('two nonadjacent stations select the complete real same-line section with no interchange shortcuts',()=>{
  const network={...catalog,stations:[{id:'a',lineId:1},{id:'b',lineId:1},{id:'c',lineId:1},{id:'x',lineId:2}]};
  assert.deepEqual(metroSectionBetween(network,'metro','a','c'),network.segments.slice(0,2));
  assert.deepEqual(metroSectionBetween(network,'metro','c','a'),[],'Forbidden reverse movement stays unavailable');
  assert.deepEqual(metroSectionBetween(network,'metro','a','x'),[]);
  assert.deepEqual(metroSectionBetween(network,'transfer','a','x'),[network.segments[2]]);
  assert.equal(transportMetroSelection(network,{kind:'metro',segments:[]},'a').get('c'),'available');
});

test('line sections respect the twenty-segment limit and reject same-station pairs',()=>{
  const network={stations:Array.from({length:23},(_,index)=>({id:String(index),lineId:'line'})),segments:Array.from({length:22},(_,index)=>({kind:'metro',fromId:String(index),toId:String(index+1),bidirectional:true}))};
  assert.equal(metroSectionBetween(network,'metro','0','20').length,20);assert.deepEqual(metroSectionBetween(network,'metro','0','21'),[]);assert.deepEqual(metroSectionBetween(network,'metro','0','0'),[]);
});
