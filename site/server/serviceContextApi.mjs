import { randomUUID } from 'node:crypto';
import { emptyServiceContext, validateServiceContext } from '../src/serviceContextDomain.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const blankTask = () => ({ action: '', owner: '', deadline: '', access: 'unknown', equipment: 'unknown', customer: 'unknown' });
export function demoServiceContext(shift) {
  const orders = shift.orders.filter(order => Array.isArray(order.coords) && order.coords.length === 2 && order.coords.every(Number.isFinite)).slice(0, 3);
  if (orders.length < 2) throw new Error('Для примера нужны минимум две заявки с координатами.');
  const at = `${shift.date}T11:17:00+03:00`;
  return {
    components: [{ id: 'DEMO-NODE-042', title: 'Учебный узел MSK-042', coords: [orders.reduce((sum, item) => sum + item.coords[0], 0) / orders.length + .003, orders.reduce((sum, item) => sum + item.coords[1], 0) / orders.length - .003], provenance: 'demo', locationBasis: 'Условная координата учебной схемы; не расположение реального узла.' }],
    incidents: [{ id: 'DEMO-INC-042', title: 'Нет ответа от общего узла', componentId: 'DEMO-NODE-042', type: 'equipment', status: 'review', provenance: 'demo', orderIds: orders.slice(0, 2).map(order => String(order.id)), basis: 'Демонстрационная зависимость двух заявок от общего узла. Связь не подтверждена данными оператора.', observedAt: at, updatedAt: at, history: [{ at, text: 'Учебный сигнал: узел перестал отвечать. Живой мониторинг не подключён.' }], task: blankTask() }],
    cases: [{ id: 'DEMO-CASE-001', title: 'Связь снова пропадает', accountRef: 'DEMO-ACCOUNT-4821', identityConfirmed: true, symptom: 'Периодические обрывы связи', status: 'returned', provenance: 'demo', orderIds: [String(orders[0].id)], basis: 'Учебная история одного лицевого счёта и одного симптома. Это не история клиента из исходной заявки.', updatedAt: at, history: [{ at: `${shift.date}T09:00:00+03:00`, text: 'Пример: предыдущий выезд не состоялся — не было доступа к узлу.' }, { at, text: 'Пример: после настройки клиент снова сообщил об обрывах.' }], task: { ...blankTask(), action: 'Подтвердить доступ к узлу и проверить питание', owner: 'Диспетчер' } }],
  };
}

export function createServiceContextApi(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS service_contexts (shift_id TEXT PRIMARY KEY REFERENCES shifts(id), revision INTEGER NOT NULL, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS service_context_history (id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id), revision INTEGER NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, data_json TEXT NOT NULL);`);
  const read = shiftId => {
    const row = store.db.prepare('SELECT * FROM service_contexts WHERE shift_id = ?').get(shiftId);
    return row ? { revision: row.revision, ...JSON.parse(row.data_json) } : { revision: 0, ...emptyServiceContext() };
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
          if (current.cases.length || current.incidents.length || current.components.length) throw new Error('Пример доступен только в пустом наборе; текущие записи сохранены.');
          next = demoServiceContext(shift);
        } else if (request.method === 'PUT') {
          if (input.shiftId !== shift.id || input.date !== shift.date) throw new Error('Файл относится к другой смене.');
          next = input.data;
        } else if (request.method === 'PATCH') {
          next = { cases: current.cases, incidents: current.incidents, components: current.components };
          const list = input.kind === 'case' ? next.cases : input.kind === 'incident' ? next.incidents : null;
          const record = list?.find(item => item.id === input.id);
          if (!record) throw new Error('Запись не найдена.');
          if (!['task', 'status', 'note'].includes(input.action)) throw new Error('Неизвестное действие.');
          if (input.action === 'task') record.task = input.task;
          if (input.action === 'status') record.status = input.status;
          if (input.action === 'note' && (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 2000)) throw new Error('Введите комментарий (до 2000 символов).');
          record.updatedAt = new Date().toISOString();
          record.history = [...(record.history || []), { at: record.updatedAt, actor, text: input.action === 'note' ? input.note.trim() : input.action === 'task' ? 'Обновлена подготовка выезда.' : `Статус изменён: ${input.status}` }];
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
