import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { TransportStore } from '../server/transportApi.mjs';
import { transportStatus, transportConsequences } from '../src/transportDomain.js';

const shift={id:'shift',regionId:'moscow',date:'2026-08-17',plan:{},orders:[],team:[]};
const segment={id:'road:1',kind:'road',edgeId:'1',opposingEdgeId:'2',geometry:[[55.75,37.62],[55.751,37.62]],fromId:'a',toId:'b',heading:0,midpoint:[55.7505,37.62]};
const input={id:'e',title:'Ремонт дороги',kind:'road',direction:'both',startsAt:'2026-08-17T14:25:00+03:00',endsAt:'2026-08-17T15:00:00+03:00',segmentIds:['road:1']};
const setup=()=>{const db=new Database(':memory:');const store=new TransportStore({db});store.segments([segment]);return store;};

test('transport events retain history, optimistic revision and idempotent retries',()=>{
  const s=setup();try{
    const first=s.save(input,shift);assert.equal(first.revision,1);assert.equal(s.save(input,shift).revision,1);
    assert.throws(()=>s.save(input,{...shift,regionId:'other'}),/другой смене/);
    const changed=s.save({...input,expectedRevision:1,title:'Продлённый ремонт',endsAt:null},shift);assert.equal(changed.revision,2);assert.equal(changed.endsAt,null);
    assert.throws(()=>s.save({...input,expectedRevision:1,title:'Чужое изменение'},shift),/устарело/);
    assert.equal(s.db.prepare('SELECT count(*) n FROM transport_history').get().n,2);
    assert.equal(s.list({...shift,regionId:'moscow:scenario:other'}).length,0);
  }finally{s.db.close();}
});

test('movement totals separate model waiting from travel instead of charging it as movement',()=>{
  const visit={orderId:'a',departureAt:'14:00',arrival:'14:20',plannedStart:'15:00',plannedFinish:'15:20',travelMinutes:20,distanceM:1000,geometry:[[55.7,37.6],[55.8,37.7]],travelSteps:[{mode:'metro_wait_model',seconds:600,distanceM:0},{mode:'metro',seconds:600,distanceM:1000}]};
  const route={engineerId:'x',assignments:[visit]},s={orders:[{id:'a',end:'16:00'}],team:[{id:'x',shiftEnd:'18:00'}],plan:{routes:[route]}};
  const next={...visit,arrival:'14:30',travelMinutes:30,travelSteps:[{mode:'metro_wait_model',seconds:900,distanceM:0},{mode:'metro',seconds:900,distanceM:1200}]};
  const result=transportConsequences(s,{routes:[{...route,assignments:[next]}]},'14:00');
  assert.equal(result.addedTravelMinutes,5);assert.equal(result.engineers[0].beforeWaitingMinutes,10);assert.equal(result.engineers[0].afterWaitingMinutes,15);
});

test('safe platform waiting stays separate and the remaining checked continuation appears before the new trip',()=>{
  const visit={orderId:'a',departureAt:'14:00',arrival:'14:20',plannedStart:'15:00',plannedFinish:'15:20',travelMinutes:20,distanceM:1000,geometry:[[55.7,37.6],[55.8,37.7]],travelSteps:[{mode:'metro_wait_model',seconds:300,distanceM:0},{mode:'metro',seconds:900,distanceM:1000}]};
  const route={engineerId:'x',assignments:[visit]},s={date:'2026-08-17',orders:[{id:'a',end:'16:00'}],team:[{id:'x',shiftEnd:'18:00'}],plan:{routes:[route]}};
  const movement={source_job_id:'a',departure_at:'2026-08-17T14:00:00+03:00',at:'2026-08-17T14:10:00+03:00',travel_minutes:10,distance_m:500,geometry:[[55.7,37.6],[55.75,37.65]],escape_waits:[{start:'2026-08-17T14:05:30+03:00',end:'2026-08-17T14:08:30+03:00'}]};
  const result=transportConsequences(s,{routes:[{...route,movements:[movement],assignments:[{...visit,departureAt:'14:10',arrival:'14:30'}]}]},'14:05');
  assert.equal(result.engineers[0].afterWaitingMinutes,8);assert.equal(result.addedTravelMinutes,2);
  assert.ok(result.orders[0].geometryAfter.length>visit.geometry.length);assert.equal(result.orders[0].stepsAfter[1].mode,'waiting');
});
test('server rejects unsnapped segments, cross-day dates, bad intervals and disconnected roads',()=>{
  const s=setup();try{
    assert.throws(()=>s.save({...input,segmentIds:['invented']},shift),/не подтверждён/);
    assert.throws(()=>s.save({...input,startsAt:'2026-08-18T14:25:00+03:00'},shift),/Дата начала/);
    assert.throws(()=>s.save({...input,endsAt:input.startsAt},shift),/позже начала/);
    s.segments([{...segment,id:'road:3',geometry:[[55.8,37.7],[55.801,37.7]]}]);
    assert.throws(()=>s.save({...input,segmentIds:['road:1','road:3']},shift),/связный участок/);
    assert.throws(()=>s.save({...input,kind:'metro'},shift),/Смешаны/);
    assert.throws(()=>s.save({...input,startsAt:'2026-08-17T24:05:00+03:00'},shift),/Дата начала/);
  }finally{s.db.close();}
});
test('Moscow intervals are half-open, an unknown end stays active, ending is explicit',()=>{
  const e={...input,status:'OPEN'};
  assert.equal(transportStatus(e,shift.date,864),'Запланировано');
  assert.equal(transportStatus(e,shift.date,865),'Действует');
  assert.equal(transportStatus(e,shift.date,900),'Завершено');
  assert.equal(transportStatus({...e,endsAt:null},shift.date,1439),'Действует');
  assert.equal(transportStatus({...e,status:'ENDED'},shift.date,870),'Завершено');
});
test('consequences count remaining travel once and distinguish wait, late arrival and loss',()=>{
  const a={orderId:'a',departureAt:'14:00',arrival:'14:30',plannedStart:'15:00',plannedFinish:'15:20',travelMinutes:30,distanceM:6000,geometry:[[55.7,37.6],[55.8,37.7]]};
  const b={orderId:'b',departureAt:'15:20',arrival:'15:30',plannedStart:'16:00',plannedFinish:'16:20',travelMinutes:10,distanceM:2000,geometry:[[55.8,37.7],[55.9,37.8]]};
  const route={engineerId:'x',assignments:[a,b]};
  const s={orders:[{id:'a',start:'15:00',end:'15:10'},{id:'b',start:'16:00',end:'16:10'}],team:[{id:'x',name:'Инженер',shiftEnd:'18:00',transport:'CAR'}],facts:[],plan:{routes:[route]}};
  const result=transportConsequences(s,{routes:[{...route,assignments:[{...a,arrival:'14:40',travelMinutes:40,distanceM:8000},{...b,arrival:'15:40',travelMinutes:20,distanceM:4000}]}]},'14:15');
  assert.equal(result.late,0);assert.equal(result.orders[0].delta,10);assert.equal(result.addedTravelMinutes,20);
  const unknown=transportConsequences({...s,orders:s.orders.map(o=>({...o,end:undefined}))},{routes:[{...route,assignments:[{...a,arrival:'14:40'} ,b]}]},'14:15');
  assert.equal(unknown.orders[0].lateMinutes,null);assert.equal(unknown.unknownWindows,1);
  const lost=transportConsequences(s,{routes:[{...route,assignments:[a]}]},'14:15');assert.equal(lost.lost,1);
  assert.equal(transportConsequences({...s,facts:[{orderId:'a',status:'started'}]},{routes:[route]},'14:15').orders.length,0);
});
