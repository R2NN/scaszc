import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../scripts/project-root.mjs';
import { minuteOf, timeOf } from '../src/shiftDomain.js';

const waves=[
  {time:'09:30',end:'11:00',kind:'road',direction:'forward',title:'Плановое перекрытие: одно направление'},
  {time:'14:25',end:'15:10',kind:'metro',direction:'both',title:'Закрыт участок метро'},
  {time:'15:15',end:'16:00',kind:'road',direction:'both',title:'Проезд закрыт: пешеходам проход открыт'},
  {time:'15:45',end:'16:40',kind:'entry',direction:'both',title:'Закрыт вход станции · поезда продолжают движение'},
  {time:'17:00',end:null,kind:'road',direction:'both',title:'Локальное перекрытие: срок уточняется'},
];

async function rawPlan(shift) {
  const root=projectRoot(),sha=shift.plan.contentSha256;
  for(const file of [path.join(root,'runtime/exact-replans',`${sha}.json`),path.join(root,'algorithm/artifacts/complexity/initial-exact.json'),path.join(root,'algorithm/artifacts/current/initial-exact-205-of-205-retimed.json')]) {
    const raw=JSON.parse(await readFile(file,'utf8').catch(()=>'null'));
    if(raw?.content_sha256===sha)return raw;
  }
  throw new Error('Не найден проверенный исходный артефакт для сценария');
}

/** An explicitly isolated, durable five-wave demonstration over real current routes. */
export function createTransportScenario(store,transport,network) {
  store.db.exec('CREATE TABLE IF NOT EXISTS transport_scenarios(shift_id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  const get=id=>{const row=store.db.prepare('SELECT payload FROM transport_scenarios WHERE shift_id=?').get(id);return row?JSON.parse(row.payload):null;};
  const put=state=>store.db.prepare('INSERT INTO transport_scenarios VALUES (?,?) ON CONFLICT(shift_id) DO UPDATE SET payload=excluded.payload').run(state.shiftId,JSON.stringify(state));
  const pending=new Set();
  async function handle(action,input,url) {
    const id=input.shiftId||url.searchParams.get('shiftId');
    if(!['scenario/next','scenario/tick'].includes(action))return run(action,input,url);
    if(pending.has(id))return {state:get(id)};
    pending.add(id);
    try{return await run(action,input,url);}finally{pending.delete(id);}
  }
  async function run(action,input,url) {
    if(action==='scenario/dual') {
      const result=await handle('scenario/start',input,url),state=result.state,shift=result.shift,raw=await rawPlan(shift),events=[];
      state.variant='simultaneous';state.waves=[];state.index=1;
      for(const [index,kind] of ['road','metro'].entries()) {
        const choices=await network({action:'candidates',raw,team:shift.team,date:shift.date,time:'14:25',kind,direction:'both'},{timeout:120_000});
        const choice=choices.sort((a,b)=>Date.parse(a.usedAt)-Date.parse(b.usedAt))[0];
        if(!choice)throw new Error('В оставшемся плане не найден используемый участок для совместного показа');
        transport.segments([choice.segment]);
        const end=Math.max(15*60+10,(minuteOf(choice.usedAt.slice(11,16))||865)+20);
        const event=transport.save({id:`transport-dual-${shift.id}-${kind}`,kind,direction:'both',title:kind==='road'?'Одновременно: перекрыта дорога':'Одновременно: закрыт участок метро',
          startsAt:`${shift.date}T14:25:00+03:00`,endsAt:`${shift.date}T${timeOf(Math.min(1439,end))}:00+03:00`,segmentIds:[choice.segment.id],source:'Изолированный одновременный сценарий',externalId:`dual-${kind}`},shift);
        events.push(event);state.waves.push({time:'14:25',kind,index,eventId:event.id,title:event.title,status:'OPEN',targetEngineer:choice.engineerId,targetOrder:choice.orderId});
      }
      put(state);
      const row=store.db.prepare('SELECT id,payload FROM dispatch_sessions WHERE shift_id=?').get(shift.id),session=JSON.parse(row.payload);
      session.clock={...session.clock,minute:865,playing:false,anchorAt:Date.now(),version:session.clock.version+1};session.lastMinute=865;
      store.db.prepare('UPDATE dispatch_sessions SET payload=? WHERE id=?').run(JSON.stringify(session),row.id);
      return {state,shift:store.get(shift.id),events,clock:session.clock};
    }
    if(action==='scenario/start') {
      const source=store.get(input.baseShiftId);
      if(!source?.plan||source.date!=='2026-08-17')throw new Error('Транспортный показ доступен только для 17.08.2026');
      const base=store.byDate(source.regionId.split(':')[0],source.date)||source;
      const id=randomUUID(),shift=store.ensure({regionId:`moscow:scenario:transport-${id}`,date:base.date,orders:base.orders,team:base.team,plan:base.plan});
      const session={id,baseShiftId:base.id,shiftId:shift.id,profile:'transport',clock:{minute:420,playing:false,speed:60,anchorAt:Date.now(),version:1},lastMinute:420,fired:true};
      store.db.prepare('INSERT INTO dispatch_sessions VALUES (?,?,?,?)').run(id,base.id,shift.id,JSON.stringify(session));
      const state={shiftId:shift.id,baseShiftId:base.id,waves:waves.map((w,i)=>({...w,index:i,status:'PENDING'})),index:-1};put(state);
      return {state,shift,clock:session.clock};
    }
    const shiftId=input.shiftId || url.searchParams.get('shiftId'),state=get(shiftId);
    if(action==='scenario')return state;
    if(!state)throw new Error('Сначала запустите изолированный транспортный показ');
    if(state.variant!=='simultaneous')state.waves.forEach((wave,i)=>{if(!wave.eventId)Object.assign(wave,waves[i]);});
    const shift=store.get(shiftId);
    if(action==='scenario/next'||action==='scenario/tick') {
      const previous=state.waves[state.index];
      if(previous?.eventId) {
        const applied=store.db.prepare("SELECT payload FROM transport_previews WHERE shift_id=? AND json_extract(payload,'$.status')='APPLIED' ORDER BY rowid DESC LIMIT 1").get(shiftId);
        if(!applied||!JSON.parse(applied.payload).events.some(e=>e.id===previous.eventId)) {
          if(action==='scenario/tick')return {state};
          throw new Error('Сначала проверьте и примените решение предыдущего события');
        }
        previous.status='APPLIED';
      }
      const index=state.index+1,wave=state.waves[index];
      if(!wave){put(state);return {state,complete:true};}
      const minute=action==='scenario/next'?minuteOf(wave.time):Number(input.minute);
      if(minute<minuteOf(wave.time))return {state};
      const time=timeOf(Math.floor(minute));
      const choices=await network({action:'candidates',raw:await rawPlan(shift),team:shift.team,date:shift.date,time,kind:wave.kind,direction:wave.direction},{timeout:120_000});
      const priorIds=new Set(transport.list(shift).flatMap(e=>e.segments.map(s=>s.id)));
      const choice=choices.sort((a,b)=>Date.parse(a.usedAt)-Date.parse(b.usedAt)).find(c=>!priorIds.has(c.segment.id));
      if(!choice)throw new Error(`В текущем оставшемся плане не найден используемый участок для «${wave.title}». Текущий план сохранён`);
      transport.segments([choice.segment]);
      const endMinute=wave.end?Math.max(minuteOf(wave.end),(minuteOf(choice.usedAt.slice(11,16))||minute)+20):null;
      const event=transport.save({id:`transport-wave-${state.shiftId}-${index}`,title:wave.title,reason:`Сценарное событие · ${choice.segment.name}`,kind:wave.kind,direction:wave.direction,
        startsAt:`${shift.date}T${wave.time}:00+03:00`,endsAt:endMinute==null?null:`${shift.date}T${timeOf(Math.min(1439,endMinute))}:00+03:00`,segmentIds:[choice.segment.id],
        source:'Изолированный транспортный сценарий',externalId:`wave-${index}`},shift);
      wave.eventId=event.id;wave.status='OPEN';wave.targetEngineer=choice.engineerId;wave.targetOrder=choice.orderId;state.index=index;put(state);
      const row=store.db.prepare('SELECT id,payload FROM dispatch_sessions WHERE shift_id=?').get(shiftId),session=JSON.parse(row.payload);
      session.clock={...session.clock,minute,playing:false,anchorAt:Date.now(),version:session.clock.version+1};session.lastMinute=minute;
      store.db.prepare('UPDATE dispatch_sessions SET payload=? WHERE id=?').run(JSON.stringify(session),row.id);
      return {state,event,clock:session.clock,shift:store.get(shiftId)};
    }
    throw new Error('Неизвестное действие сценария');
  }
  const applied=(shiftId,events)=>{
    const state=get(shiftId);if(!state)return;
    const ids=new Set(events.map(e=>e.id));
    state.waves.forEach(w=>{if(w.eventId&&ids.has(w.eventId))w.status='APPLIED';});put(state);
    return state;
  };
  return {handle,applied};
}
