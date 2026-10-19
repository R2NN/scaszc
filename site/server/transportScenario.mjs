import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../scripts/project-root.mjs';
import { minuteOf, timeOf } from '../src/shiftDomain.js';

const waves=[
  {time:'09:30',end:'11:00',kind:'road',direction:'both',title:'Перекрытие дороги'},
  {time:'14:25',end:'15:10',kind:'metro',direction:'both',title:'Закрыт участок метро'},
];

// Curated only for these sealed demo plans; candidates still come from the
// actual used network edges. Other data retains the ordinary dynamic choice.
const roadShowcasePlans=new Set([
  '44b01c4be2a40deb34e3c4518a7cd9fa5730e335619a2a64a9d19f9a408df3e9',
  'b6d4119bc6043cdce1b241ca02d6dc4996ed2780ea440a695c64616dce61a6e5',
]);

async function rawPlan(shift) {
  const root=projectRoot(),sha=shift.plan.contentSha256;
  for(const file of [path.join(root,'runtime/exact-replans',`${sha}.json`),path.join(root,'algorithm/artifacts/complexity/initial-exact.json'),path.join(root,'algorithm/artifacts/current/initial-exact-205-of-205-retimed.json')]) {
    const raw=JSON.parse(await readFile(file,'utf8').catch(()=>'null'));
    if(raw?.content_sha256===sha)return raw;
  }
  throw new Error('Не найден проверенный исходный артефакт для сценария');
}

/** An isolated, durable road/metro demonstration over real current routes. */
export function createTransportScenario(store,transport,network) {
  store.db.exec('CREATE TABLE IF NOT EXISTS transport_scenarios(shift_id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  const put=state=>store.db.prepare('INSERT INTO transport_scenarios VALUES (?,?) ON CONFLICT(shift_id) DO UPDATE SET payload=excluded.payload').run(state.shiftId,JSON.stringify(state));
  const get=id=>{
    const row=store.db.prepare('SELECT payload FROM transport_scenarios WHERE shift_id=?').get(id);
    if(!row){
      const sessionRow=store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(id);
      const shift=store.get(id);
      if(!sessionRow||shift?.date!=='2026-08-17'||!shift.regionId.startsWith('moscow:scenario:'))return null;
      const session=JSON.parse(sessionRow.payload);
      // The ordinary shift demonstration also includes roads and metro. Do not
      // backdate expired disruptions into an already executing legacy day.
      const minute=Number(session.clock.minute)+(session.clock.playing?(Date.now()-session.clock.anchorAt)/60000*session.clock.speed:0);
      const state={shiftId:id,baseShiftId:session.baseShiftId,presentationVersion:2,variant:'shift',
        waves:waves.map((wave,index)=>({...wave,index,status:wave.end&&minute>=minuteOf(wave.end)?'MISSED':'PENDING'}))};
      state.index=state.waves.findLastIndex(wave=>wave.status==='MISSED');put(state);return state;
    }
    const state=JSON.parse(row.payload);
    if(state.variant!=='simultaneous'&&state.presentationVersion!==2){
      // Retire only the scripted schedule. Saved events and published history
      // remain intact, including any already demonstrated legacy waves.
      state.waves=waves.map((wave,index)=>{
        const existing=state.waves.find(item=>item.time===wave.time&&item.kind===wave.kind);
        return existing?.eventId?{...existing,index}:{...wave,index,status:'PENDING'};
      });
      state.index=state.waves.findLastIndex(wave=>wave.eventId);
      state.presentationVersion=2;put(state);
    }
    if(state.variant!=='simultaneous'&&state.waves.some(wave=>!wave.eventId)){
      const row=store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(id);
      if(row){
        const {clock}=JSON.parse(row.payload);
        const minute=Number(clock.minute)+(clock.playing?(Date.now()-clock.anchorAt)/60000*clock.speed:0);
        let changed=false;
        for(const wave of state.waves){
          if(wave.eventId)continue;
          const status=wave.end&&minute>=minuteOf(wave.end)?'MISSED':'PENDING';
          if(wave.status!==status){wave.status=status;changed=true;}
        }
        if(changed){state.index=state.waves.findLastIndex(wave=>wave.eventId||wave.status==='MISSED');put(state);}
      }
    }
    return state;
  };
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
      const state={shiftId:shift.id,baseShiftId:base.id,presentationVersion:2,waves:waves.map((w,i)=>({...w,index:i,status:'PENDING'})),index:-1};put(state);
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
        if(applied&&JSON.parse(applied.payload).events.some(e=>e.id===previous.eventId))previous.status='APPLIED';
      }
      const index=state.index+1,wave=state.waves[index];
      if(!wave){put(state);return {state,complete:true};}
      const minute=action==='scenario/next'?minuteOf(wave.time):Number(input.minute);
      if(minute<minuteOf(wave.time))return {state};
      const time=timeOf(Math.floor(minute));
      const raw=await rawPlan(shift);
      const showcase=wave.kind==='road'&&roadShowcasePlans.has(raw.content_sha256)&&shift.team.some(person=>person.id==='EAST-ENG-02');
      const candidateRaw=showcase?{...raw,plan:{...raw.plan,engineer_plans:raw.plan.engineer_plans.filter(route=>route.engineer_id==='EAST-ENG-02')}}:raw;
      const priorIds=new Set(transport.list(shift).flatMap(e=>e.segments.map(s=>s.id)));
      let choices=await network({action:'candidates',raw:candidateRaw,team:shift.team,date:shift.date,time,kind:wave.kind,direction:wave.direction},{timeout:120_000});
      if(showcase&&!choices.some(c=>!priorIds.has(c.segment.id)))choices=await network({action:'candidates',raw,team:shift.team,date:shift.date,time,kind:wave.kind,direction:wave.direction},{timeout:120_000});
      const eligible=choices.filter(c=>!priorIds.has(c.segment.id));
      const choice=(showcase&&eligible.find(c=>c.engineerId==='EAST-ENG-02'&&c.orderId==='EAST-50219'))||eligible.sort((a,b)=>wave.kind==='road'
        ?Number(Boolean(b.segment.opposingEdgeId))-Number(Boolean(a.segment.opposingEdgeId))||Number(b.segment.lengthM||0)-Number(a.segment.lengthM||0)||Date.parse(a.usedAt)-Date.parse(b.usedAt)
        :Date.parse(a.usedAt)-Date.parse(b.usedAt))[0];
      if(!choice)throw new Error(`В текущем оставшемся плане не найден используемый участок для «${wave.title}». Текущий план сохранён`);
      transport.segments([choice.segment]);
      const endMinute=wave.end?Math.max(minuteOf(wave.end),(minuteOf(choice.usedAt.slice(11,16))||minute)+20):null;
      const event=transport.save({id:`transport-wave-${state.shiftId}-${index}`,title:wave.kind==='road'?`Перекрытие дороги · ${choice.segment.name}`:wave.title,reason:`Сценарное событие · ${choice.segment.name}`,kind:wave.kind,direction:wave.direction,
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
