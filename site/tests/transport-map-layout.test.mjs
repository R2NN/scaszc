import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTransportPins,transportBoxClear } from '../src/transportMapLayout.js';
import { transportFocusSegments } from '../src/transportDomain.js';

test('coincident entrance, transfer and track restrictions form one counted group without duplicate endpoints',()=>{
  const project=([x,y])=>({x,y}),entry={id:'e',kind:'entry'},transfer={id:'t',kind:'transfer'},track={id:'m',kind:'metro'};
  const groups=groupTransportPins([{coords:[100,100],event:entry},{coords:[101,100],event:transfer},{coords:[100,101],event:track},{coords:[100,100],event:track},{coords:[200,200],event:track}],project);
  assert.equal(groups.length,2);assert.deepEqual(groups[0].events.map(event=>event.kind),['entry','transfer','metro']);assert.deepEqual(groups[0].coords,[100,100]);
});

test('captions cannot cover route corridors or numbered stops',()=>{
  const obstacles=[{x:100,y:100,w:35,h:35},{x:150,y:60,w:12,h:100}];
  assert.equal(transportBoxClear({x:90,y:80,w:50,h:50},obstacles),false);
  assert.equal(transportBoxClear({x:140,y:90,w:50,h:40},obstacles),false);
  assert.equal(transportBoxClear({x:180,y:90,w:50,h:40},obstacles),true);
});

test('a car detour excludes unrelated live metro and distant live road closures',()=>{
  const road=[[55.43,37.75],[55.431,37.751]],metro=[[55.7,37.6],[55.71,37.61]];
  const base={status:'OPEN',startsAt:'2026-08-17T09:00:00+03:00',endsAt:null};
  const events=[{...base,id:'road',kind:'road',segments:[{geometry:road}]},{...base,id:'metro',kind:'metro',segments:[{geometry:metro}]},{...base,id:'other-road',kind:'road',segments:[{geometry:metro}]}];
  const result=transportFocusSegments({orders:[{geometryAfter:road,geometryBefore:road}],events,selected:events[1],date:'2026-08-17',minute:900,transport:'CAR'});
  assert.equal(result.length,2);assert.ok(result.flatMap(segment=>segment.geometry).every(([lat])=>lat<55.5));
  const transit=transportFocusSegments({orders:[{geometryAfter:metro}],events,date:'2026-08-17',minute:900,transport:'PUBLIC_TRANSIT'});
  assert.equal(transit.length,2);
});
