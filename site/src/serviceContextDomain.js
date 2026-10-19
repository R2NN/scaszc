export const INCIDENT_TYPES = { equipment: 'Оборудование', line: 'Линия / кабель', power: 'Питание', degradation: 'Качество связи', maintenance: 'Плановые работы', access: 'Общий доступ' };
export const INCIDENT_STATUSES = { review: 'Требует проверки', confirmed: 'Подтверждено', resolved: 'Устранено' };
export const CASE_STATUSES = { unresolved: 'Проблема не устранена', returned: 'Сбой вернулся', no_access: 'Выезд не выполнен', planned: 'Плановый второй этап', resolved: 'Решено' };
export const emptyServiceContext = () => ({ cases: [], incidents: [], components: [] });
export const orderLabel = order => String(order?.sourceId || order?.id || '').split(':').at(-1).replace(/^.*?-/, '');
export function serviceEventAt(day, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '') || !Number.isFinite(Date.parse(`${day}T12:00:00Z`)) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error('Укажите время события в выбранной смене.');
  return `${day}T${time}:00+03:00`;
}
export function incidentWorkflow(record) {
  const checks = {
    equipment: 'Проверьте доступность узла, питание и соединение с вышестоящим оборудованием.',
    line: 'Проверьте участок линии и устройства на его концах; уточните место повреждения.',
    power: 'Уточните питание площадки и состояние резервного источника.',
    degradation: 'Сопоставьте ошибки и качество связи на общем участке с обращениями клиентов.',
    maintenance: 'Сверьте время и охват плановых работ с заявками на этот период.',
    access: 'Подтвердите доступ к общей площадке у ответственного за объект.',
  };
  return {
    check: checks[record.type] || checks.equipment,
    next: record.status === 'resolved' ? 'Связь восстановлена по отметке диспетчера. Проверьте оставшиеся обращения: нужна ли отдельная работа у клиента.'
      : record.status === 'confirmed' ? 'Общая проблема подтверждена. Организуйте восстановление источника; при необходимости подготовьте перенос времени затронутых заявок.'
        : 'Причина пока не подтверждена. Сначала сохраните результат проверки; не считайте совпадение адресов доказательством общего сбоя.',
  };
}
export function serviceHistoryRows(record, day) {
  const names = { signal: 'Сигнал', verification: 'Результат проверки', task: 'Поручение', prepare: 'Подготовка решения', status: 'Статус', note: 'Комментарий' };
  return (record.history || []).map((event, index) => {
    const date = new Date(event.at);
    const eventDay = Number.isFinite(date.getTime()) ? date.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }) : '';
    const knownTime = event.eventTimeKnown !== false && eventDay === day;
    return { ...event, index, label: names[event.kind] || (index === 0 ? 'Исходная запись' : 'Запись диспетчера'), displayAt: knownTime ? event.at : null, recordedAt: event.recordedAt || event.at };
  }).reverse();
}
export function relatedOrders(record, orders) {
  const byId = new Map(orders.map(order => [String(order.id), order]));
  return (record?.orderIds || []).map(id => byId.get(id)).filter(Boolean);
}
export function caseForOrder(cases, order) {
  return order ? cases.filter(item => item.orderIds.includes(String(order.id))) : [];
}
export function serviceStats(incidents) {
  const active = incidents.filter(item => item.status !== 'resolved');
  return { active: active.length, review: active.filter(item => item.status === 'review').length, orders: new Set(active.flatMap(item => item.orderIds)).size };
}
// Links are explicit, scoped order identifiers. Neither addresses nor distance
// can prove that two requests have the same customer or upstream failure.
export function validateServiceContext(input, orders) {
  const fail = message => { throw new Error(message); };
  if (!input || !['cases', 'incidents', 'components'].every(key => Array.isArray(input[key]) && input[key].length <= 500)) fail('Ожидаются массивы cases, incidents, components (до 500 записей).');
  const result = JSON.parse(JSON.stringify(input));
  const orderIds = new Set(orders.map(item => String(item.id)));
  const ids = new Set();
  const text = (value, max = 2000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  for (const item of [...result.components, ...result.incidents, ...result.cases]) {
    if (!text(item.id, 100) || ids.has(item.id)) fail('Идентификаторы записей должны быть уникальными.');
    ids.add(item.id);
    if (!['demo', 'operator', 'import'].includes(item.provenance)) fail('Укажите источник: demo, operator или import.');
    if (!text(item.title, 250)) fail('Укажите название записи.');
    if (item.locationBasis != null && (typeof item.locationBasis !== 'string' || item.locationBasis.length > 2000)) fail('Источник координат должен быть текстом.');
    if (item.coords != null && (!Array.isArray(item.coords) || item.coords.length !== 2 || !item.coords.every(Number.isFinite) || Math.abs(item.coords[0]) > 90 || Math.abs(item.coords[1]) > 180)) fail('Координаты должны иметь формат [широта, долгота].');
    if (item.history != null && (!Array.isArray(item.history) || item.history.length > 300 || item.history.some(event => !event || !text(event.text) || !text(event.at, 80) || !Number.isFinite(Date.parse(event.at)) || (event.actor != null && !text(event.actor, 100))))) fail('История должна содержать дату at, текст text и текстовое имя автора.');
  }
  const componentIds = new Set(result.components.map(item => item.id));
  for (const item of [...result.incidents, ...result.cases]) {
    if (!Array.isArray(item.orderIds) || new Set(item.orderIds).size !== item.orderIds.length || item.orderIds.some(id => typeof id !== 'string' || !orderIds.has(id))) fail('Связанные заявки должны существовать в выбранной смене. Используйте полные id.');
    if (!text(item.basis)) fail('Укажите основание связи с заявками.');
    if (!text(item.updatedAt, 80) || !Number.isFinite(Date.parse(item.updatedAt))) fail('Укажите корректное время updatedAt.');
    if (item.task != null && (typeof item.task !== 'object' || !['action', 'owner', 'deadline', 'access', 'equipment', 'customer'].every(key => typeof item.task[key] === 'string' && item.task[key].length <= 2000) || !['access', 'equipment', 'customer'].every(key => ['unknown', 'waiting', 'ready'].includes(item.task[key])) || (item.task.deadline && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(item.task.deadline)))) fail('Неверный формат подготовки выезда.');
  }
  for (const item of result.incidents) {
    if (item.observedAt != null && (typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt)))) fail('Неверное время сигнала observedAt.');
    item.observedAt ||= item.updatedAt;
    if (!INCIDENT_TYPES[item.type] || !INCIDENT_STATUSES[item.status]) fail('Неизвестный тип или статус события.');
    if (!componentIds.has(item.componentId)) fail('Для события нужен компонент из реестра.');
  }
  for (const item of result.cases) {
    if (!CASE_STATUSES[item.status] || !text(item.accountRef, 100) || !text(item.symptom, 250) || !item.orderIds.length || item.identityConfirmed !== true) fail('Для обращения нужны подтверждённый лицевой счёт, симптом, статус и заявка.');
  }
  return { cases: result.cases, incidents: result.incidents, components: result.components };
}
