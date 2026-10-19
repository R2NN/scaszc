import { randomUUID } from 'node:crypto';
import { INCIDENT_STATUSES, emptyServiceContext, validateServiceContext } from '../src/serviceContextDomain.js';
import { loadComplexityArtifact } from './complexityArtifact.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const blankTask = () => ({ action: '', owner: '', deadline: '', access: 'unknown', equipment: 'unknown', customer: 'unknown' });
export function demoServiceContext(shift, { spreadAcrossRegion = false } = {}) {
  const located = shift.orders.filter(order => Array.isArray(order.coords) && order.coords.length === 2 && order.coords.every(Number.isFinite));
  if (located.length < 2) throw new Error('Для примера нужны минимум две заявки с координатами.');
  const distance = (a, b) => Math.hypot((a.coords[0] - b.coords[0]) * 111, (a.coords[1] - b.coords[1]) * 63);
  const groups = [], used = new Set();
  for (let index = 0; index < Math.min(3, Math.floor(located.length / 2)); index++) {
    const remaining = located.filter(order => !used.has(String(order.id)));
    const nearby = !spreadAcrossRegion && index > 0 ? remaining.filter(order => distance(order, groups[0][0]) <= 18) : remaining;
    const available = nearby.length >= 2 ? nearby : remaining;
    // Keep the original example stable; spread further teaching nodes over the day.
    const anchor = index === 0 ? available.find(order => order.id === 'EAST-74198') || available[0]
      : [...available].sort((a, b) => Math.min(...groups.map(group => distance(b, group[0]))) - Math.min(...groups.map(group => distance(a, group[0]))) || String(a.id).localeCompare(String(b.id)))[0];
    const neighbour = available.filter(order => order !== anchor).sort((a, b) => distance(a, anchor) - distance(b, anchor) || String(a.id).localeCompare(String(b.id)))[0];
    groups.push([anchor, neighbour]); used.add(String(anchor.id)); used.add(String(neighbour.id));
  }
  const components = [], incidents = [];
  groups.forEach((orders, index) => {
    const number = String(42 + index).padStart(3, '0'), at = `${shift.date}T11:${String(17 + index * 8).padStart(2, '0')}:00+03:00`;
    components.push({ id: `DEMO-NODE-${number}`, demoVersion: 4, title: `Учебный узел MSK-${number}`, coords: [orders.reduce((sum, item) => sum + item.coords[0], 0) / orders.length + .0012, orders.reduce((sum, item) => sum + item.coords[1], 0) / orders.length - .0012], provenance: 'demo', locationBasis: 'Условная координата учебной схемы; не расположение реального узла.' });
    incidents.push({ id: `DEMO-INC-${number}`, title: 'Нет ответа от общего узла', componentId: `DEMO-NODE-${number}`, type: 'equipment', status: 'review', provenance: 'demo', orderIds: orders.map(order => String(order.id)), basis: 'Демонстрационная зависимость двух заявок от общего узла. Связь не подтверждена данными оператора.', observedAt: at, updatedAt: at, history: [{ at, text: 'Учебный сигнал: узел перестал отвечать. Живой мониторинг не подключён.' }], task: blankTask() });
  });
  return { components, incidents, cases: [] };
}

export function createServiceContextApi(store, { seedDemo = false } = {}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS service_contexts (shift_id TEXT PRIMARY KEY REFERENCES shifts(id), revision INTEGER NOT NULL, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS service_context_history (id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id), revision INTEGER NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, data_json TEXT NOT NULL);`);
  const read = shiftId => {
    const row = store.db.prepare('SELECT * FROM service_contexts WHERE shift_id = ?').get(shiftId);
    return row ? { revision: row.revision, ...JSON.parse(row.data_json) } : { revision: 0, ...emptyServiceContext() };
  };
  const ensureDemo = async shift => {
    const current = read(shift.id);
    const oldDemo = current.incidents.find(item => item.id === 'DEMO-INC-042' && item.provenance === 'demo');
    const oldNode = current.components.find(item => item.id === 'DEMO-NODE-042' && item.provenance === 'demo');
    if (!seedDemo || shift.regionId !== 'moscow' || shift.date !== '2026-08-17' || (current.revision && (!oldDemo || !oldNode || oldNode.demoVersion >= 4))) return;
    const artifact = await loadComplexityArtifact();
    const originals = new Map((artifact?.orders || []).map(order => [String(order.id), order]));
    if (!originals.size || shift.orders.length !== originals.size || shift.orders.some(order => { const source = originals.get(String(order.id)); return !source || source.address !== order.address || JSON.stringify(source.coords) !== JSON.stringify(order.coords); })) return;
    const demo = demoServiceContext(shift);
    const next = oldDemo ? {
      cases: current.cases,
      // Upgrade only our teaching version; retain saved locations, tasks and history.
      components: current.components.map(item => item.id === oldNode.id ? { ...item, demoVersion: 4 } : item),
      incidents: current.incidents.map(item => item.id === oldDemo.id && !(oldNode.demoVersion >= 2) ? { ...item, orderIds: demo.incidents[0].orderIds } : item),
    } : { ...demo, cases: [] };
    const previousDemo = oldNode?.demoVersion === 3 ? demoServiceContext(shift, { spreadAcrossRegion: true }) : null;
    if (oldDemo) for (const incident of demo.incidents.slice(1)) {
      const component = demo.components.find(item => item.id === incident.componentId);
      const saved = next.incidents.find(item => item.id === incident.id), savedComponent = next.components.find(item => item.id === incident.componentId);
      if (!saved && !savedComponent) { next.components.push(component); next.incidents.push(incident); continue; }
      // Only relocate untouched v3 teaching examples from regional outliers into
      // the city view. Imported/custom coordinates and operator work stay exact.
      const prior = previousDemo?.incidents.find(item => item.id === incident.id), priorComponent = previousDemo?.components.find(item => item.id === incident.componentId);
      if (saved?.provenance === 'demo' && savedComponent?.provenance === 'demo' && savedComponent.demoVersion === 3 && saved.status === 'review' && saved.history?.length === 1 && JSON.stringify(saved.task) === JSON.stringify(blankTask()) && JSON.stringify(saved.orderIds) === JSON.stringify(prior?.orderIds) && JSON.stringify(savedComponent.coords) === JSON.stringify(priorComponent?.coords)) {
        savedComponent.coords = component.coords; savedComponent.demoVersion = 4; saved.orderIds = incident.orderIds;
      }
    }
    store.db.transaction(() => {
      if (read(shift.id).revision !== current.revision) return;
      const revision = current.revision + 1, data = JSON.stringify(validateServiceContext(next, shift.orders));
      store.db.prepare('INSERT INTO service_contexts VALUES (?,?,?) ON CONFLICT(shift_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json').run(shift.id, revision, data);
      store.db.prepare('INSERT INTO service_context_history VALUES (?,?,?,?,?,?)').run(randomUUID(), shift.id, revision, 'Учебный сценарий сети', new Date().toISOString(), data);
    })();
  };
  const priorCases = data => (data.cases || []).flatMap(record => (record.previousCases || []).map(ref => {
    const prior = read(ref.shiftId).cases.find(item => item.id === ref.caseId);
    const shift = store.get(ref.shiftId);
    return prior && shift ? { ...ref, date: shift.date, record: prior, orders: shift.orders.filter(order => prior.orderIds.includes(String(order.id))).map(order => ({ id: order.id, sourceId: order.sourceId, address: order.address })) } : null;
  })).filter(Boolean);
  return async request => {
    const url = new URL(request.url);
    if (url.pathname !== '/api/service-context') return null;
    try {
      const shift = store.get(url.searchParams.get('shiftId'));
      if (!shift) return json({ error: 'Смена не найдена.' }, 404);
      if (request.method === 'GET') {
        await ensureDemo(shift);
        const account = url.searchParams.get('accountRef');
        if (account) {
          const matches = store.db.prepare('SELECT c.shift_id,c.data_json,s.service_date FROM service_contexts c JOIN shifts s ON s.id=c.shift_id WHERE s.region_id=? AND s.service_date<?').all(shift.regionId, shift.date).flatMap(row => JSON.parse(row.data_json).cases.filter(record => record.provenance !== 'demo' && record.accountRef === account).map(record => ({ shiftId: row.shift_id, date: row.service_date, record })));
          return json({ matches });
        }
        const data = read(shift.id);
        return json({ shiftId: shift.id, date: shift.date, ...data, priorCases: priorCases(data) });
      }
      if (!['PUT', 'PATCH', 'POST'].includes(request.method)) return json({ error: 'Метод не поддерживается.' }, 405);
      const raw = await request.text();
      if (raw.length > 2_000_000) return json({ error: 'Файл превышает 2 МБ.' }, 413);
      const input = JSON.parse(raw);
      const actor = String(input.actor || 'Диспетчер').trim().slice(0, 100);
      const result = store.db.transaction(() => {
        const current = read(shift.id);
        if (!Number.isInteger(input.revision) || current.revision !== input.revision) throw Object.assign(new Error('Данные уже изменились. Обновите и повторите сохранение.'), { status: 409 });
        let next;
        if (request.method === 'POST' && input.action === 'demo') {
          if (current.incidents.length || current.components.length) throw new Error('Пример доступен только в пустом наборе; текущие записи сохранены.');
          next = { ...demoServiceContext(shift), cases: current.cases };
        } else if (request.method === 'PUT') {
          if (input.shiftId !== shift.id || input.date !== shift.date) throw new Error('Файл относится к другой смене.');
          next = input.data;
        } else if (request.method === 'PATCH') {
          next = { cases: current.cases, incidents: current.incidents, components: current.components };
          const list = input.kind === 'case' ? next.cases : input.kind === 'incident' ? next.incidents : null;
          const record = list?.find(item => item.id === input.id);
          if (!record) throw new Error('Запись не найдена.');
          if (!['task', 'status', 'note', 'verification', 'prepare'].includes(input.action)) throw new Error('Неизвестное действие.');
          if (['verification', 'prepare'].includes(input.action) && input.kind !== 'incident') throw new Error('Это действие относится к сетевому событию.');
          if (input.effectiveAt != null && (typeof input.effectiveAt !== 'string' || !Number.isFinite(Date.parse(input.effectiveAt)) || new Date(input.effectiveAt).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }) !== shift.date)) throw new Error('Время события должно относиться к выбранному дню смены.');
          const now = new Date().toISOString(), last = record.history?.at(-1);
          if (input.action === 'prepare') {
            if (!record.orderIds.includes(String(input.orderId))) throw new Error('Заявка не связана с этим сетевым событием.');
            if (last?.kind === 'prepare' && last.orderId === String(input.orderId)) return { shiftId: shift.id, date: shift.date, ...current, priorCases: priorCases(current) };
          }
          if (input.action === 'verification') {
            if (!INCIDENT_STATUSES[input.status] || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000 || !input.effectiveAt) throw new Error('Для результата проверки нужны статус, описание и время в смене.');
            if (last?.kind === 'verification' && record.status === input.status && last.text === input.note.trim() && last.at === input.effectiveAt) return { shiftId: shift.id, date: shift.date, ...current, priorCases: priorCases(current) };
            record.status = input.status;
          }
          if (input.action === 'task') record.task = input.task;
          if (input.action === 'status') record.status = input.status;
          if (input.action === 'note' && (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000)) throw new Error('Введите комментарий (до 2000 символов).');
          record.updatedAt = now;
          const order = input.action === 'prepare' && shift.orders.find(item => String(item.id) === String(input.orderId));
          const text = ['note', 'verification'].includes(input.action) ? input.note.trim()
            : input.action === 'prepare' ? `Открыта подготовка переноса окна заявки ${order?.sourceId || input.orderId}. Изменения плана ещё не опубликованы.`
              : input.action === 'task' ? `Поручение: ${input.task.action}. Ответственный: ${input.task.owner}${input.task.deadline ? `. Срок: ${input.task.deadline.replace('T', ' ')}` : ''}.`
                : `Статус изменён: ${input.status}`;
          record.history = [...(record.history || []), { at: input.effectiveAt || now, recordedAt: now, eventTimeKnown: Boolean(input.effectiveAt), kind: input.action, actor, text, ...(input.action === 'prepare' ? { orderId: String(input.orderId) } : {}), ...(input.action === 'verification' ? { status: input.status } : {}) }];
        } else throw new Error('Неизвестное действие.');
        next = validateServiceContext(next, shift.orders);
        for (const record of next.cases) {
          if (record.previousCases != null && (!Array.isArray(record.previousCases) || record.previousCases.length > 20)) throw new Error('Можно связать до 20 прошлых обращений.');
          for (const ref of record.previousCases || []) {
            const previous = read(String(ref.shiftId)).cases.find(item => item.id === ref.caseId);
            const previousShift = store.get(String(ref.shiftId));
            if (!previous || !previousShift || previousShift.regionId !== shift.regionId || previousShift.date >= shift.date || previous.provenance === 'demo' || previous.accountRef !== record.accountRef || previous.symptom !== record.symptom) throw new Error('Прошлое обращение должно иметь тот же счёт и симптом и относиться к более ранней смене. Демонстрационные связи не переносятся в реальные.');
          }
        }
        const revision = current.revision + 1;
        const data = JSON.stringify(next);
        store.db.prepare('INSERT INTO service_contexts VALUES (?,?,?) ON CONFLICT(shift_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json').run(shift.id, revision, data);
        store.db.prepare('INSERT INTO service_context_history VALUES (?,?,?,?,?,?)').run(randomUUID(), shift.id, revision, actor, new Date().toISOString(), data);
        return { shiftId: shift.id, date: shift.date, revision, ...next, priorCases: priorCases(next) };
      })();
      return json(result);
    } catch (error) { return json({ error: error.message }, error.status || 422); }
  };
}
