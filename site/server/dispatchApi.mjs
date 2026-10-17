import { randomUUID } from 'node:crypto';
import { EmergencyDispatch } from './emergencyDispatch.mjs';
import { minuteOf } from '../src/shiftDomain.js';
import { operationalStates } from '../src/operationalState.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** Add incident endpoints without replacing the existing shift/notification flow. */
export function createDispatchApi(store, options) {
  const dispatch = new EmergencyDispatch(store, options);
  const timer = setInterval(async () => {
    if (!store.db.open) return;
    try {
      for (const row of store.db.prepare('SELECT shift_id,payload FROM dispatch_sessions').all()) {
        const session = JSON.parse(row.payload);
        if (!session.clock.playing || dispatch.all(row.shift_id).some(item => !['ACCEPTED','CANCELLED'].includes(item.status))) continue;
        const minute = Math.min(1439, session.clock.minute + (Date.now()-session.clock.anchorAt)/60000*session.clock.speed);
        await handle(new Request(`http://localhost/api/dispatch/shifts/${row.shift_id}/clock`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...session.clock,minute})}));
      }
      await dispatch.tick();
    } catch (error) {
      for (const item of dispatch.all().filter(entry => entry.status === 'WAITING' && entry.deadlineAt <= Date.now())) {
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
        const base = store.get(input.baseShiftId);
        if (!base?.plan) throw new Error('Исходная смена не найдена');
        const id = randomUUID();
        const first = base.versions[0];
        const shift = store.ensure({ regionId: `${base.regionId.split(':')[0]}:scenario:${id}`, date: base.date, orders: first.orders, team: first.team, plan: first.plan });
        const session = { id, baseShiftId: input.baseShiftId, shiftId: shift.id, clock: { minute: 660, playing: false, speed: 60, anchorAt: Date.now() }, lastMinute: 660, fired: false };
        store.db.prepare('INSERT INTO dispatch_sessions VALUES (?,?,?,?)').run(id, input.baseShiftId, shift.id, JSON.stringify(session));
        return json({ ...session, shift }, 201);
      }
      const route = /^\/api\/dispatch\/shifts\/([^/]+)\/(incidents|policy|clock|states)$/.exec(url.pathname);
      if (route) {
        const [, shiftId, action] = route;
        const shift = store.get(shiftId);
        if (!shift) throw new Error('Смена не найдена');
        if (action === 'policy') return json(request.method === 'GET' ? dispatch.policy(shiftId) : dispatch.setPolicy(shiftId, input));
        if (action === 'states') return json(operationalStates(shift, Number(url.searchParams.get('minute') || 677), url.searchParams.get('mode') || 'plan'));
        if (action === 'incidents') {
          if (request.method === 'POST') return json(dispatch.create(shiftId, input), 201);
          return json({ incidents: dispatch.all(shiftId), serverNow: Date.now() });
        }
        if (action === 'clock') {
          const row = store.db.prepare('SELECT id,payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shiftId);
          if (!row) return json({ incident: null });
          const session = JSON.parse(row.payload), minute = Number(input.minute);
          if (!Number.isFinite(minute) || minute < 0 || minute > 1439) throw new Error('Некорректное время смены');
          if (!session.fired && session.lastMinute < 677 && minute >= 677) {
            const address = shift.orders.find(order => order.id === 'SOUTHCENTER-32840') || shift.orders.find(order => order.zoneId === 'SOUTHCENTER');
            const order = { id: `TZ3-${session.id}`, sourceId: `TZ3-${session.id}`, name: 'Аварийный вызов', address: address.address, coords: address.coords,
              regionId: 'moscow', zone: address.zone, zoneId: address.zoneId, objectId: address.objectId, serviceEntities: { object: address.objectId },
              start: '11:17', end: '18:00', priority: 'EMERGENCY', skill: 'EMERGENCY', workType: 'Аварийные работы', equipment: 'DIAG_SET', requiredTransport: 'ANY',
              provenance: { source: 'tz3-scenario-v1', coordinateSource: address.sourceData?.geocode_provider, originalLocation: address.id } };
            dispatch.create(shiftId, { order, time: '11:17', eventKey: 'scheduled-11:17' });
            session.fired = true;
          }
          session.lastMinute = Math.max(session.lastMinute, minute);
          const stopped = session.fired && dispatch.all(shiftId).some(item => !['ACCEPTED', 'CANCELLED'].includes(item.status));
          session.clock = { minute: stopped ? 677 : minute, playing: !stopped && Boolean(input.playing), speed: Number(input.speed) || 60, anchorAt: Date.now() };
          store.db.prepare('UPDATE dispatch_sessions SET payload=? WHERE id=?').run(JSON.stringify(session), row.id);
          return json({ ...session, incidents: dispatch.all(shiftId) });
        }
      }
      const incidentRoute = /^\/api\/dispatch\/incidents\/([^/]+)\/(accept|retry|cancel|read)$/.exec(url.pathname);
      if (incidentRoute && request.method === 'POST') {
        const [, id, action] = incidentRoute;
        if (action === 'accept') return json(dispatch.accept(id, input.candidateId, input.actor));
        if (action === 'cancel') return json(dispatch.cancel(id));
        if (action === 'read') return json(dispatch.read(id, input.notificationId));
        const item = dispatch.get(id);
        if (item && !['ACCEPTED', 'CANCELLED'].includes(item.status)) dispatch.save({ ...item, status: 'QUEUED', candidates: [] });
        return json(dispatch.get(id));
      }
      return json({ error: 'Неизвестный адрес аварийного диспетчирования' }, 404);
    } catch (error) { return json({ error: error.message }, 422); }
  }
  return { handle, dispatch, close: () => clearInterval(timer) };
}
