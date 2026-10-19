import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTransportPins,transportPinBox,transportBoxClear,transportUsesSidePanel,transportRouteStations,clipTransportSegment } from '../src/transportMapLayout.js';
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


test('zoomed-out groups include all icon and counter bounds and merge until no groups overlap',()=>{
  const items=Array.from({length:24},(_,index)=>({coords:[index*22,(index%3)*16],event:{id:`e${index}`,kind:['entry','transfer','metro','road'][index%4]}}));
  const groups=groupTransportPins(items,([x,y])=>({x,y}));
  assert.equal(new Set(groups.flatMap(group=>group.events.map(event=>event.id))).size,24);
  for(const [index,group] of groups.entries())assert.equal(transportBoxClear(transportPinBox(group),groups.slice(index+1).map(transportPinBox)),true);
  assert.ok(groups.length<items.length);
  const first=groups[0];assert.deepEqual(first.coords,items[0].coords);
});

test('short landscape phones use a side panel while portrait phones keep an upper panel',()=>{
  for(const [width,height] of [[844,390],[667,375],[932,430],[1366,768]])assert.equal(transportUsesSidePanel(width,height),true);
  for(const [width,height] of [[390,844],[430,932],[768,1024],[1024,768]])assert.equal(transportUsesSidePanel(width,height),false);
});

test('checked metro labels identify boarding, exit and both ends of the interchange, excluding intermediate stops',()=>{
  const catalog={stations:['A','X','B','C','D'].map((name,index)=>({id:name,name,coords:[55+index*.001,37]}))};
  const step=(mode,from,to,lineId)=>({mode,from,to,lineId,geometry:[catalog.stations.find(station=>station.name===from).coords,catalog.stations.find(station=>station.name===to).coords]});
  const labels=transportRouteStations([{stepsAfter:[step('metro','A','X',1),step('metro','X','B',1),step('walking_transfer','B','C'),step('metro','C','D',2)]}],catalog);
  assert.deepEqual(labels.map(station=>[station.id,station.role]),[['A','boarding'],['D','alighting'],['B','transfer'],['C','transfer']]);
  assert.equal(transportRouteStations([{stepsAfter:[{mode:'auto',geometry:[[55,37],[56,38]]}]}],catalog).length,0);
});


test('metro interchange labels do not invent metro stations from ground walking connections',()=>{
  const labels=transportRouteStations([{stepsAfter:[{mode:'metro',from:'A',to:'B',geometry:[[55,37],[55.01,37]]},{mode:'walking_transfer',from:'B',to:'Bus stop',geometry:[[55.01,37],[55.0101,37.001]]}]}],{stations:[{id:'a',name:'A',coords:[55,37]},{id:'b',name:'B',coords:[55.01,37]}]});
  assert.deepEqual(labels.map(station=>station.name).sort(),['A','B']);
});


test('offscreen route geometry cannot expand caption collision work with zoom',()=>{
  const viewport={left:100,top:100,right:500,bottom:500};
  assert.equal(clipTransportSegment({x:-1e9,y:-1e9},{x:-1e8,y:-1e8},viewport),null);
  const visible=clipTransportSegment({x:-1e9,y:250},{x:1e9,y:250},viewport);
  assert.ok(Math.abs(visible[0].x-100)<1e-6);assert.ok(Math.abs(visible[1].x-500)<1e-6);
});
