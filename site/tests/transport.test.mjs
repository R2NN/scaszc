import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { TransportStore,createTransportApi } from '../server/transportApi.mjs';
import { createDispatchApi } from '../server/dispatchApi.mjs';
import { transportStatus, transportConsequences } from '../src/transportDomain.js';
import { ShiftStore } from '../server/shiftStore.mjs';

const shift={id:'shift',regionId:'moscow',date:'2026-08-17',plan:{},orders:[],team:[]};
const segment={id:'road:1',kind:'road',edgeId:'1',opposingEdgeId:'2',geometry:[[55.75,37.62],[55.751,37.62]],fromId:'a',toId:'b',heading:0,midpoint:[55.7505,37.62]};
const input={id:'e',title:'Ремонт дороги',kind:'road',direction:'both',startsAt:'2026-08-17T14:25:00+03:00',endsAt:'2026-08-17T15:00:00+03:00',segmentIds:['road:1']};
const setup=()=>{const db=new Database(':memory:');const store=new TransportStore({db});store.segments([segment]);return store;};

test('late requests cannot start transport searches or add waves to a retired run',async()=>{
  const store=new ShiftStore(':memory:'),dispatch=createDispatchApi(store),transport=createTransportApi(store);dispatch.close();
  const base=store.ensure({regionId:'moscow',date:shift.date,orders:[],team:[],plan:{status:'EXACT_VALID',publicationAllowed:true,contentSha256:'fixture',validation:{status:'VALID'},routes:[],unassigned:[],metrics:{}}});
  const request=(handler,path,body)=>handler.handle(new Request('http://localhost/api/'+path,{method:'POST',body:JSON.stringify(body)}));
  try{
    const first=await (await request(dispatch,'dispatch/sessions',{baseShiftId:base.id,speed:300})).json();
    await request(dispatch,`dispatch/shifts/${first.shiftId}/clock`,{minute:600,playing:false,speed:300});
    await request(dispatch,`dispatch/shifts/${first.shiftId}/clock`,{minute:360,mode:'plan',restartDay:'seek',playing:false,speed:300});
    for(const [path,body] of [['previews',{expectedRevision:1,time:'06:00'}],['scenario/tick',{minute:865}],['events',{event:input}]]){
      const response=await request(transport,'transport/'+path,{shiftId:first.shiftId,...body});assert.equal(response.status,409,await response.text());
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM transport_previews').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM transport_events').get().n,0);
    const read=await transport.handle(new Request('http://localhost/api/transport/events?shiftId='+first.shiftId));assert.equal(read.status,200,'Historical reads remain available');
  }finally{store.close();}
});

test('overnight and unknown-end events reach subsequent shifts with one shared publication context',()=>{
  const store=new ShiftStore(':memory:'),s=new TransportStore(store);
  try{
    s.segments([segment]);
    const event=s.save({...input,endsAt:'2026-08-18T10:00:00+03:00'},shift);
    const next={...shift,date:'2026-08-18'};
    assert.deepEqual(s.list(next).map(e=>e.id),[event.id]);
    assert.equal(s.list({...next,date:'2026-08-19'}).length,0);
    assert.equal(s.list({...next,regionId:'moscow:scenario:test'}).length,0);
    const saved=store.ensure({...next,plan:{status:'EXACT_VALID',contentSha256:'fixture',publicationAllowed:true,validation:{status:'VALID'},routes:[],unassigned:[],metrics:{}}});
    assert.deepEqual(store.get(saved.id).transportRestrictions,s.list(next));
    const changed=s.save({...input,expectedRevision:1,endsAt:null},next);
    assert.equal(changed.date,shift.date);
    assert.equal(s.list({...next,date:'2026-08-19'})[0].id,event.id);
    assert.equal(transportStatus(changed,next.date,360),'Действует');
    const ended=s.save({...input,expectedRevision:2,status:'ENDED',endsAt:'2026-08-18T09:00:00+03:00'},next);
    assert.equal(transportStatus(ended,next.date,600),'Завершено');
    assert.equal(s.db.prepare('SELECT count(*) n FROM transport_history WHERE event_id=?').get(event.id).n,3);
  }finally{store.close();}
});

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

test('a long drawn road can save more than twenty proven connected edges',()=>{
  const s=setup();try{
    const segments=Array.from({length:30},(_,index)=>({...segment,id:`road:draw-${index}`,edgeId:String(index),opposingEdgeId:String(index+1000),geometry:[[55.7,37.6+index*.001],[55.7,37.6+(index+1)*.001]]}));
    s.segments(segments);const event=s.save({...input,segmentIds:segments.map(item=>item.id)},shift);assert.equal(event.segments.length,30);
    assert.throws(()=>s.save({...input,id:'too-many',segmentIds:Array.from({length:501},()=>segment.id)},shift),/допустимой длины/);
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
