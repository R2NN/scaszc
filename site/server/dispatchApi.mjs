import { reconcileDispatchPlayback } from './dispatchPlayback.mjs';
import { randomUUID } from 'node:crypto';
import { EmergencyDispatch } from './emergencyDispatch.mjs';
import { minuteOf } from '../src/shiftDomain.js';
import { operationalStates } from '../src/operationalState.js';
import { homeStartScenario } from './homeStartScenario.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** Add incident endpoints without replacing the existing shift/notification flow. */
export function createDispatchApi(store, options) {
  const dispatch = new EmergencyDispatch(store, options);
  const timer = setInterval(async () => {
    if (!store.db.open) return;
    try {
      for (const row of store.db.prepare('SELECT shift_id,payload FROM dispatch_sessions').all()) {
        const session = JSON.parse(row.payload);
        if (!session.clock.playing || session.clock.confirmingDecision) continue;
        const minute = Math.min(1439, session.clock.minute + (Date.now()-session.clock.anchorAt)/60000*session.clock.speed);
        await handle(new Request(`http://localhost/api/dispatch/shifts/${row.shift_id}/clock`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...session.clock,minute,serverTick:true})}));
      }
      await dispatch.tick();
    } catch (error) {
      for (const item of dispatch.active().filter(entry => entry.status === 'WAITING' && entry.deadlineAt <= Date.now())) {
        dispatch.notification(item, 'Автовыбор требует внимания', error.message);
        dispatch.save({...item,status:'ERROR',error:error.message,retryAt:Date.now()+30000});
      }
    }
  }, 1000);
  timer.unref();
  const context = baseId => {
    const row = store.db.prepare('SELECT payload FROM dispatch_sessions WHERE base_shift_id=? ORDER BY rowid DESC LIMIT 1').get(baseId);
    return row ? JSON.parse(row.payload) : null;
  };
  const createSession = input => {
    const base = store.get(input.baseShiftId);
    if (!base?.plan) throw new Error('Исходная смена не найдена');
    const id = randomUUID(), first = homeStartScenario(base);
    const shift = store.ensure({regionId:`${base.regionId.split(':')[0]}:scenario:${id}`,date:base.date,orders:first.orders,team:first.team,plan:first.plan});
    const requestedSpeed=Number(input.speed),speed=[1,30,60,120,300].includes(requestedSpeed)?requestedSpeed:60;
    const session={id,baseShiftId:input.baseShiftId,shiftId:shift.id,clock:{minute:360,playing:false,speed,anchorAt:Date.now(),awaitingDecision:false,confirmingDecision:false,version:1},lastMinute:360,fired:false};
    store.db.prepare('INSERT INTO dispatch_sessions VALUES (?,?,?,?)').run(id,input.baseShiftId,shift.id,JSON.stringify(session));
    return {...session,shift};
  };
  async function handle(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/dispatch/')) return null;
    try {
      const input = request.method === 'GET' ? {} : await request.json();
      const incidentId = /^\/api\/dispatch\/incidents\/([^/]+)$/.exec(url.pathname)?.[1];
      if (incidentId && request.method === 'GET') return json(dispatch.get(incidentId));
      if (url.pathname === '/api/dispatch/context') {
        const session = context(url.searchParams.get('baseShiftId'));
        return json(session ? { ...session, shift: store.get(session.shiftId) } : null);
      }
      if (url.pathname === '/api/dispatch/sessions' && request.method === 'POST') {
        return json(createSession(input),201);
      }
      const route = /^\/api\/dispatch\/shifts\/([^/]+)\/(incidents|policy|clock|states)$/.exec(url.pathname);
      if (route) {
        const [, shiftId, action] = route;
        if (!store.db.prepare('SELECT 1 FROM shifts WHERE id=?').get(shiftId)) throw new Error('Смена не найдена');
        if (action === 'policy') return json(request.method === 'GET' ? dispatch.policy(shiftId) : dispatch.setPolicy(shiftId, input));
        if (action === 'states') return json(operationalStates(store.get(shiftId), Number(url.searchParams.get('minute') || 677), url.searchParams.get('mode') || 'plan'));
        if (action === 'incidents') {
          if (request.method === 'POST') return json(dispatch.create(shiftId, input), 201);
          const sessionRow = store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shiftId);
          const session = sessionRow ? JSON.parse(sessionRow.payload) : null;
          return json({ incidents: dispatch.all(shiftId), serverNow: Date.now(), clock: session?.clock || null });
        }
        if (action === 'clock') {
          const row = store.db.prepare('SELECT id,payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shiftId);
          if (!row) return json({ incident: null });
          const session = JSON.parse(row.payload), serverTick = input.serverTick === true;
          if(session.restartedAs){
            let next=session;const seen=new Set();
            while(next.restartedAs&&!seen.has(next.id)){seen.add(next.id);next=JSON.parse(store.db.prepare('SELECT payload FROM dispatch_sessions WHERE id=?').get(next.restartedAs).payload);}
            return json({...next,shift:store.get(next.shiftId),restarted:true});
          }
          if(!serverTick&&input.restartDay&&input.mode==='plan'&&Number(input.minute)===360&&session.lastMinute>360){
            const speed=session.preIncidentSpeed??input.speed??session.clock.speed;
            for(const incident of dispatch.all(shiftId))if(!['ACCEPTED','CANCELLED'].includes(incident.status))dispatch.cancel(incident.id);
            options?.onRestart?.(shiftId);
            const next=store.db.transaction(()=>{
              const value=createSession({baseShiftId:session.baseShiftId,speed});
              session.restartedAs=value.id;session.clock={...session.clock,playing:false,awaitingDecision:false,confirmingDecision:false,anchorAt:Date.now(),version:(session.clock.version||0)+1};
              store.db.prepare('UPDATE dispatch_sessions SET payload=? WHERE id=?').run(JSON.stringify(session),row.id);
              return value;
            }).immediate();
            return json({...next,restarted:true});
          }
          // A scenario jump can overtake an already queued browser clock write.
          // Return the authoritative revision instead of rewinding its minute.
          if(!serverTick&&Number.isInteger(input.serverClockVersion)&&input.serverClockVersion!==session.clock.version)return json({...session,incidents:dispatch.all(shiftId)});
          const staleOverride = !serverTick && !dispatch.hasPending(shiftId) && (input.awaitingDecision || input.confirmingDecision);
          const minute = session.clock.confirmingDecision ? session.clock.minute : serverTick || staleOverride
            ? Math.min(1439, session.clock.minute + (session.clock.playing ? Math.max(0,Date.now() - session.clock.anchorAt) / 60000 * (Number(session.clock.speed) || 60) : 0))
            : Number(input.minute);
          if (!Number.isFinite(minute) || minute < 0 || minute > 1439) throw new Error('Некорректное время смены');
          if (!session.fired && session.lastMinute < 677 && minute >= 677) {
            const shift = store.get(shiftId);
            const address = shift.orders.find(order => order.id === 'SOUTHCENTER-32840') || shift.orders.find(order => order.zoneId === 'SOUTHCENTER');
            const order = { id: `TZ3-${session.id}`, sourceId: `TZ3-${session.id}`, name: 'Аварийный вызов', address: address.address, coords: address.coords,
              regionId: 'moscow', zone: address.zone, zoneId: address.zoneId, objectId: address.objectId, serviceEntities: { object: address.objectId },
              start: '11:17', end: '18:00', priority: 'EMERGENCY', skill: 'EMERGENCY', workType: 'Аварийные работы', equipment: 'DIAG_SET', requiredTransport: 'ANY',
              provenance: { source: 'tz3-scenario-v1', coordinateSource: address.sourceData?.geocode_provider, originalLocation: address.id } };
            dispatch.create(shiftId, { order, time: '11:17', eventKey: 'scheduled-11:17' });
            session.fired = true;
          }
          session.lastMinute = Math.max(session.lastMinute, minute);
          // A request may have crossed the scheduled incident boundary above.
          // Use this request's clock as the anchor before applying the queue override.
          const playing = serverTick ? Boolean(session.clock.playing) : Boolean(input.playing);
          const requestedSpeed = serverTick || staleOverride ? session.clock.speed : Number(input.speed);
          session.clock = { ...session.clock, minute, playing:playing && minute < 1439,
            speed:session.preIncidentSpeed != null ? session.clock.speed : [1,30,60,120,300].includes(requestedSpeed) ? requestedSpeed : session.clock.speed,
            anchorAt:Date.now(),version:(session.clock.version || 0)+1 };
          reconcileDispatchPlayback(session,dispatch.hasPending(shiftId),Date.now());
          store.db.prepare('UPDATE dispatch_sessions SET payload=? WHERE id=?').run(JSON.stringify(session), row.id);
          return json(serverTick ? session : { ...session, incidents: dispatch.all(shiftId) });
        }
      }
      const incidentRoute = /^\/api\/dispatch\/incidents\/([^/]+)\/(accept|retry|cancel|read)$/.exec(url.pathname);
      if (incidentRoute && request.method === 'POST') {
        const [, id, action] = incidentRoute;
        if (action === 'accept') {
          const result = await dispatch.confirm(id, input.candidateId, input.actor);
          const sessionRow = store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(result.shiftId);
          return json({ ...result, playback: sessionRow ? JSON.parse(sessionRow.payload).clock : null });
        }
        if (action === 'cancel') return json(dispatch.cancel(id));
        if (action === 'read') return json(dispatch.read(id, input.notificationId));
        const item = dispatch.get(id);
        if (item && !['ACCEPTED', 'CANCELLED'].includes(item.status)) dispatch.save({ ...item, status: 'QUEUED', candidates: [], confirmation:null, error:null });
        return json(dispatch.get(id));
      }
      return json({ error: 'Неизвестный адрес аварийного диспетчирования' }, 404);
    } catch (error) { return json({ error: error.message }, 422); }
  }
  return { handle, dispatch, close: () => clearInterval(timer) };
}
