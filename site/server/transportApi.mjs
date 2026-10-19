import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../scripts/project-root.mjs';
import { runExactReplan } from '../scripts/exact-replan-runner.mjs';
import { acquirePlanningSlot, planningBusyResponse } from './planningSlot.mjs';
import { minuteOf } from '../src/shiftDomain.js';
import { transportConsequences,transportEventImpacts } from '../src/transportDomain.js';
import { createTransportScenario } from './transportScenario.mjs';
import { transportEventsForDay } from './transportScope.mjs';
import { algorithmPhaseLabel } from '../src/algorithmProgress.js';
import { PLANNING_DEADLINE_MS, remainingMilliseconds } from '../scripts/process-deadline.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const contextHash = events => hash(events.map(e => [e.id,e.revision,e.kind,e.direction,e.startsAt,e.endsAt,e.status,e.segments.map(s=>s.id)]).sort((a,b)=>a[0].localeCompare(b[0])));

/** Execute a bounded, cancellable network inspection in the installed runtime. */
export function transportNetwork(payload, { signal, timeout = 90_000 } = {}) {
  const root = projectRoot();
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(process.env.BEEGO_PYTHON || 'python', [path.join(root, 'algorithm/tools/transport_network.py')], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    let output = '', errors = '', inputError = null;
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-3000); });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if(signal?.aborted){reject(signal.reason || new Error('Проверка отменена'));return;}
      if(inputError){reject(new Error(`Не удалось передать данные проверке сети: ${inputError.message}`));return;}
      try {
        const result = JSON.parse(output.trim());
        if (code !== 0 || result.error) throw new Error(result.error || errors || 'Проверка сети прервана');
        resolve(result);
      } catch (error) { reject(new Error(error.message.startsWith('Unexpected') ? errors || 'Нет ответа транспортного сервиса' : error.message)); }
    });
    child.stdin.on('error',error=>{inputError=error;abort();});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Additive event storage. User plans, facts and rating data remain in their own tables. */
export class TransportStore {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transport_segments(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transport_events(id TEXT PRIMARY KEY,region_id TEXT NOT NULL,service_date TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transport_history(event_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(event_id,revision));
      CREATE TABLE IF NOT EXISTS transport_previews(id TEXT PRIMARY KEY,shift_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS transport_scope ON transport_events(region_id,service_date);
    `);
    this.db.prepare(`UPDATE transport_previews SET payload=json_set(payload,'$.status','FAILED','$.error','Сервер перезапущен. Повторите расчёт.') WHERE json_extract(payload,'$.status')='RUNNING'`).run();
  }
  segments(items) {
    const insert = this.db.prepare('INSERT OR REPLACE INTO transport_segments VALUES (?,?)');
    this.db.transaction(() => items.forEach(item => insert.run(item.id, JSON.stringify(item))))();
  }
  list(shift) { return transportEventsForDay(this.db,shift.regionId,shift.date); }
  get(id) { const row = this.db.prepare('SELECT payload FROM transport_events WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null; }
  normalize(input, shift) {
    if (!shift?.plan) throw new Error('Выберите смену с проверенным планом');
    const prior = input.id ? this.get(input.id) : null;
    if (prior && (prior.regionId !== shift.regionId || !this.list(shift).some(event=>event.id===prior.id))) throw new Error('Ограничение относится к другой смене');
    if (prior && prior.revision !== input.expectedRevision) throw new Error('Ограничение устарело. Обновите список');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) throw new Error('Укажите название до 160 символов');
    if (!['road','metro','transfer','entry'].includes(input.kind)) throw new Error('Неизвестный вид ограничения');
    if (!['both','forward','reverse'].includes(input.direction)) throw new Error('Укажите направление');
    if (input.kind !== 'road' && input.direction === 'reverse') throw new Error('Для метро выберите связь в нужном направлении');
    const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+03:00$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)+180*60_000).toISOString().slice(0,16)===value.slice(0,16);
    if (!validTime(input.startsAt) || input.startsAt.slice(0,10) !== (prior?.date || shift.date)) throw new Error('Дата начала должна совпадать с выбранной сменой (Москва)');
    if (input.endsAt !== null && (!validTime(input.endsAt) || Date.parse(input.endsAt) < Date.parse(input.startsAt) || input.endsAt===input.startsAt && input.status!=='ENDED')) throw new Error('Окончание должно быть позже начала; для неизвестного срока выберите соответствующую отметку');
    if (!Array.isArray(input.segmentIds) || input.segmentIds.length < 1 || input.segmentIds.length > 20) throw new Error('Выберите от 1 до 20 участков сети');
    const segments = [...new Set(input.segmentIds)].map(id => {
      const row = this.db.prepare('SELECT payload FROM transport_segments WHERE id=?').get(id);
      if (!row) throw new Error('Участок не подтверждён сетью. Выберите его на карте заново');
      const segment = JSON.parse(row.payload);
      if (segment.kind !== input.kind) throw new Error('Смешаны разные виды участков');
      return segment;
    });
    if (input.kind === 'road' && input.direction === 'reverse' && segments.some(s=>!s.opposingEdgeId)) throw new Error('На выбранном проезде нет разрешённого встречного направления');
    if (input.kind === 'road' && segments.length > 1) {
      for (let i=1; i<segments.length; i++) {
        const before = segments.slice(0,i).flatMap(s=>[s.geometry[0],s.geometry.at(-1)]);
        if (!before.some(a=>[segments[i].geometry[0],segments[i].geometry.at(-1)].some(b=>Math.hypot((a[0]-b[0])*111195,(a[1]-b[1])*62500)<4))) throw new Error('Добавьте связный участок дороги: разрозненные проезды сохраняются отдельными событиями');
      }
    }
    return {
      id: prior?.id || input.id || randomUUID(), revision: (prior?.revision || 0)+1,
      regionId: shift.regionId, date: prior?.date || shift.date, title: input.title.trim(), reason: String(input.reason || input.title).slice(0,500),
      kind: input.kind, direction: input.direction, modes: input.kind === 'road' ? ['CAR'] : ['PUBLIC_TRANSIT'],
      startsAt: input.startsAt, endsAt: input.endsAt, segments, status: input.status || prior?.status || 'OPEN',
      source: String(input.source || 'Диспетчер').slice(0,160), externalId: input.externalId || prior?.externalId || null,
      actor: String(input.actor || 'Диспетчер').slice(0,160), createdAt: prior?.createdAt || stamp(), updatedAt: stamp(),
    };
  }
  save(input, shift) {
    return this.db.transaction(() => {
      const prior = input.id && this.get(input.id);
      if(prior&&(prior.regionId!==shift.regionId||!this.list(shift).some(event=>event.id===prior.id)))throw new Error('Ограничение относится к другой смене');
      // Repeating the exact same save is idempotent, but a competing edit is not.
      if (prior && hash({...input,expectedRevision:undefined}) === prior.requestHash) return prior;
      const event = this.normalize(input,shift);
      if (!['OPEN','ENDED','CANCELLED'].includes(event.status)) throw new Error('Неизвестное состояние события');
      if (event.externalId) {
        const duplicate = this.list(shift).find(e=>e.id!==event.id && e.source===event.source && e.externalId===event.externalId);
        if (duplicate) return duplicate;
      }
      event.requestHash = hash({...input,expectedRevision:undefined});
      this.db.prepare('INSERT INTO transport_events VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(event.id,event.regionId,event.date,event.revision,JSON.stringify(event));
      this.db.prepare('INSERT INTO transport_history VALUES (?,?,?,?)').run(event.id,event.revision,JSON.stringify(event),stamp());
      return event;
    })();
  }
  preview(id) { const row=this.db.prepare('SELECT payload FROM transport_previews WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null; }
  putPreview(item) { this.db.prepare('INSERT INTO transport_previews VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(item.id,item.shiftId,JSON.stringify(item)); }
}

/** Transport endpoints share the exact solver and the existing atomic publication path. */
export function createTransportApi(store) {
  const transport = new TransportStore(store), running = new Map();
  const scenario = createTransportScenario(store,transport,transportNetwork);
  const scenarioLocks = new Set();
  let catalogPromise;
  const loadCatalog = async () => {
    catalogPromise ||= (async()=>{try{const catalog=await transportNetwork({action:'catalog'});
      transport.segments([...catalog.segments,...catalog.stations.map(s=>({...s,kind:'entry',name:s.name,fromId:s.id,toId:null,geometry:[s.coords]}))]);
      return catalog;
    }catch(error){catalogPromise=null;throw error;}})();
    return catalogPromise;
  };
  const requireShift = id => { const shift=store.get(id); if(!shift?.plan) throw new Error('Смена не найдена'); return shift; };
  const requireActiveRun = id => {
    const row=store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(id);
    if(row&&JSON.parse(row.payload).restartedAs)throw new Error('Сценарий устарел: показ начат заново. Используйте текущую смену');
  };
  const comparisonShift=async shift=>{
    const root=projectRoot(),sha=shift.plan.contentSha256;
    for(const file of [path.join(root,'runtime/exact-replans',`${sha}.json`),path.join(root,'algorithm/artifacts/complexity/initial-exact.json'),path.join(root,'algorithm/artifacts/current/initial-exact-205-of-205-retimed.json')]){
      const raw=JSON.parse(await readFile(file,'utf8').catch(()=>'null'));if(raw?.content_sha256!==sha)continue;
      const visits=new Map(raw.plan.engineer_plans.flatMap(r=>r.visits.map(v=>[v.job_id,v])));
      return {raw,shift:{...shift,plan:{...shift.plan,routes:shift.plan.routes.map(r=>({...r,assignments:r.assignments.map(v=>{
        const steps=visits.get(v.sourceOrderId || shift.orders.find(o=>o.id===v.orderId)?.sourceId || v.orderId)?.travel?.itinerary;
        return steps?.length?{...v,travelSteps:steps.map(s=>({mode:s.mode,seconds:s.duration_seconds,distanceM:s.distance_m,geometry:s.geometry}))}:v;
      })}))}}};
    }
    throw new Error('Исходный проверенный маршрут для сравнения не найден');
  };
  const presentPreview = item => {
    if(!item||item.status!=='READY')return item;
    const shift=requireShift(item.shiftId),ordinary=store.preview(item.id);
    if(shift.revision!==item.baseRevision||ordinary?.status==='FAILED')return {...item,status:'FAILED',result:null,error:ordinary?.error || 'План изменился после расчёта. Повторите проверку.'};
    const changed=contextHash(transport.list(shift))!==item.contextSha256;
    if(changed&&!item.hasDraft)return {...item,status:'FAILED',result:null,error:'Ограничения изменились. Повторите проверку.'};
    return {...item,requiresSave:changed};
  };
  const minuteNow = shift => {
    const row=store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shift.id);
    if(!row) return null;
    const {clock}=JSON.parse(row.payload);
    return Math.floor(clock.minute+(clock.playing && !clock.confirmingDecision ? Math.max(0,Date.now()-clock.anchorAt)/60000*clock.speed : 0));
  };
  async function handle(request) {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/transport/')) return null;
    try {
      const input=['GET','HEAD'].includes(request.method)?{}:await request.json();
      const action=url.pathname.slice('/api/transport/'.length);
      if(action==='scenario'||action.startsWith('scenario/')) {
        // Reading durable state remains available during network inspection.
        if(action==='scenario')return json(await scenario.handle(action,input,url));
        const key=input.shiftId || input.baseShiftId || url.searchParams.get('shiftId');
        if(input.shiftId)requireActiveRun(input.shiftId);
        if(scenarioLocks.has(key))return json({error:'Подготавливаем транспортное событие. Подождите завершения.'},429);
        scenarioLocks.add(key);
        try{return json(await scenario.handle(action,input,url));}finally{scenarioLocks.delete(key);}
      }
      if(action==='catalog' && request.method==='GET') return json(await loadCatalog());
      if(action==='snap' && request.method==='POST') {
        if(!Array.isArray(input.coords)||input.coords.length!==2||!input.coords.every(Number.isFinite)||input.coords[0]<54||input.coords[0]>57||input.coords[1]<35||input.coords[1]>40) throw new Error('Выберите дорогу в Московском регионе');
        const segment=await transportNetwork({action:'snap',coords:input.coords}); transport.segments([segment]); return json(segment);
      }
      if(action==='events' && request.method==='GET') { const shift=requireShift(url.searchParams.get('shiftId')); return json({events:transport.list(shift)}); }
      if(action==='events' && request.method==='POST') { requireActiveRun(input.shiftId);await loadCatalog();requireActiveRun(input.shiftId);return json(transport.save(input.event,requireShift(input.shiftId)),201); }
      if(action==='previews/latest' && request.method==='GET') {
        const shift=requireShift(url.searchParams.get('shiftId'));
        const row=store.db.prepare('SELECT payload FROM transport_previews WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shift.id);
        return json(presentPreview(row?JSON.parse(row.payload):null));
      }
      if(action==='history' && request.method==='GET') return json(transport.db.prepare('SELECT payload FROM transport_history WHERE event_id=? ORDER BY revision DESC').all(url.searchParams.get('eventId')).map(r=>JSON.parse(r.payload)));
      if(action==='previews' && request.method==='POST') {
        const shift=requireShift(input.shiftId);
        requireActiveRun(shift.id);
        if(input.expectedRevision!==shift.revision) throw new Error('План устарел. Обновите смену');
        if(minuteOf(input.time)==null) throw new Error('Укажите время расчёта');
        const nowMinute=minuteNow(shift);
        if(input.live && nowMinute!==null && nowMinute!==minuteOf(input.time)) throw new Error('Сценарные часы изменились. Повторите расчёт из текущего положения');
        const events=transport.list(shift);
        if(input.draft) {
          await loadCatalog(); const draft=transport.normalize(input.draft,shift);
          const index=events.findIndex(e=>e.id===draft.id); if(index<0) events.push(draft); else events[index]=draft;
        }
        requireActiveRun(shift.id);
        const release=acquirePlanningSlot(); if(!release) return planningBusyResponse();
        const controller=new AbortController(),deadlineAt=Date.now()+PLANNING_DEADLINE_MS;
        let previewId;
        try { previewId=store.startPreview(shift.id,shift.revision,{type:'RECALCULATE',time:input.time,reason:'Транспортные ограничения'}); }
        catch(error){release();throw error;}
        const item={id:previewId,shiftId:shift.id,baseRevision:shift.revision,contextSha256:contextHash(events),hasDraft:Boolean(input.draft),time:input.time,live:Boolean(input.live),status:'RUNNING',phase:'Проверяем оставшиеся маршруты',startedAt:Date.now(),events};
        transport.putPreview(item); running.set(item.id,controller);
        (async()=>{
          try {
            const plan=await runExactReplan({orders:shift.orders,team:shift.team,plan:shift.plan,planningDate:shift.date,
              event:{type:'RECALCULATE',time:input.time,reason:'Транспортные ограничения'},transportRestrictions:events,
              facts:shift.facts},undefined,{signal:controller.signal,deadlineAt,onProgress:progress=>{if(controller.signal.aborted)return;item.progress=progress;item.phase=algorithmPhaseLabel(progress.phase);transport.putPreview(item);}});
            if(controller.signal.aborted) throw new Error('Расчёт отменён');
            plan.transportRestrictions=events;
            item.phase='Независимая проверка закрытых переходов'; transport.putPreview(item);
            const raw=JSON.parse(await readFile(path.join(projectRoot(),'runtime/exact-replans',`${plan.contentSha256}.json`),'utf8'));
            const audit=await transportNetwork({action:'audit',events,team:shift.team,plan,raw,date:shift.date,time:input.time},{signal:controller.signal,timeout:Math.min(180_000,remainingMilliseconds(deadlineAt))});
            item.audit=audit;
            if(audit.status!=='VALID') throw new Error('Путь использует закрытый переход. Прежний план сохранён; уточните участок или выберите другое время');
            if(controller.signal.aborted) throw new Error('Расчёт отменён');
            item.phase='Определяем влияние каждого ограничения';transport.putPreview(item);
            const before=await comparisonShift(shift);
            const originalAudit=await transportNetwork({action:'audit',events,team:shift.team,plan:before.shift.plan,raw:before.raw,date:shift.date,time:input.time,remainingOnly:true},
              {signal:controller.signal,timeout:Math.min(180_000,remainingMilliseconds(deadlineAt))});
            const consequences=transportConsequences(before.shift,plan,input.time);
            item.result={plan,consequences,audit,eventImpacts:transportEventImpacts(before.shift,consequences,originalAudit,events)};
            store.completePreview(item.id,{plan,orders:shift.orders,team:shift.team});
            item.status='READY';item.phase='Проверенный объезд готов';item.finishedAt=Date.now();
          } catch(error){item.status=controller.signal.aborted?'CANCELLED':'FAILED';item.finishedAt=Date.now();item.error=error.message;store.failPreview(item.id,error);}
          finally{transport.putPreview(item);running.delete(item.id);release();}
        })();
        return json(item,202);
      }
      const previewMatch=/^previews\/([^/]+)(?:\/(apply|cancel))?$/.exec(action);
      if(previewMatch) {
        const item=transport.preview(previewMatch[1]);if(!item) throw new Error('Расчёт не найден');
        if(request.method==='GET') return json(presentPreview(item));
        if(previewMatch[2]==='cancel') {
          running.get(item.id)?.abort();
          if(item.status==='READY'){store.discardPreview(item.shiftId,item.id,item.baseRevision);item.status='CANCELLED';item.result=null;transport.putPreview(item);}
          return json({status:'CANCELLED'});
        }
        if(previewMatch[2]==='apply') {
          const shift=requireShift(item.shiftId);
          requireActiveRun(shift.id);
          if(item.status!=='READY') throw new Error('Дождитесь проверенного решения');
          if(contextHash(transport.list(shift))!==item.contextSha256) throw new Error('Ограничения изменились или ещё не сохранены. Повторите расчёт');
          const currentMinute=minuteNow(shift);
          if(item.live && (minuteOf(input.time)!==minuteOf(item.time) || currentMinute!==null && currentMinute!==minuteOf(item.time))) throw new Error('Решение устарело: часы изменились. Повторите расчёт из текущего положения');
          const next=store.publish(shift.id,item.id,item.baseRevision,input.actor);
          item.status='APPLIED';item.appliedRevision=next.revision;transport.putPreview(item);const state=scenario.applied(shift.id,item.events);return json({shift:next,preview:item,state});
        }
      }
      return json({error:'Неизвестный адрес транспорта'},404);
    } catch(error) { return json({error:error.message},/устарел|изменил|ещё не сохранены/.test(error.message)?409:422); }
  }
  return {handle,transport,cancelShift(shiftId){for(const [id,controller] of running)if(transport.preview(id)?.shiftId===shiftId)controller.abort();}};
}
