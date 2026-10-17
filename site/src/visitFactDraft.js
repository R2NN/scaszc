import { workKind } from './durationKind.js';

export const FACT_STAGES = [['accessMinutes', 'Доступ'], ['documentMinutes', 'Оформление'], ['customerMinutes', 'Ожидание клиента']];
const stageKeys = ['deviationReason', ...FACT_STAGES.map(([key]) => key), 'comment'];

/** Report measurement gaps without replacing an unknown stage with zero. */
export function factLearningStatus(fact, snapshot) {
  const missing = [];
  if (!fact?.startedAt) missing.push('начало визита');
  if (fact?.status !== 'completed' || !fact?.time) missing.push('завершение визита');
  for (const [key, label] of FACT_STAGES) if (fact?.[key] == null || fact[key] === '') missing.push(label.toLocaleLowerCase('ru-RU'));
  if (snapshot?.override) missing.push('автоматический прогноз вместо ручного времени');
  return { eligible: !missing.length && !fact?.excluded, missing };
}

/** Give each selectable visit a searchable number, address, work, engineer and saved status. */
export function factOrderOptions(orders, plan, facts = []) {
  const kinds = { connection: 'Подключение', local: 'Ремонт и диагностика', emergency: 'Аварийные работы', equipment: 'Работы с оборудованием', information: 'Информационная заявка' };
  return orders.map(order => {
    const route = plan?.routes?.find(item => item.assignments?.some(visit => String(visit.orderId) === String(order.id)));
    const fact = facts.find(item => String(item.orderId) === String(order.id));
    const status = ({ started: 'Начата', completed: 'Выполнена', not_completed: 'Не выполнена' })[fact?.status] || 'Нет отметки';
    let kind = order.durationSnapshot?.kind;
    if (!kind) { try { kind = workKind(order); } catch { kind = ''; } }
    return { value: String(order.id), label: `№${order.sourceData?.source_job_id || order.sourceId || order.id} · ${order.address || order.name || 'Адрес не указан'}`, hint: `${kinds[kind] || order.workType || order.skill} · ${route?.engineerName || 'Инженер не указан'} · ${status}`, status };
  });
}

/** Populate only this visit's saved measurements, preserving unknown stages. */
export function savedFactDraft(fact) {
  return { ...Object.fromEntries(stageKeys.map(key => [key, fact?.[key] ?? ''])), time: fact?.time || '12:00', reason: fact?.reason || '', correctionReason: '' };
}

/** Resolve a draft by shift and order; a different order never inherits its neighbours' input. */
export function visitFactDraft(drafts, key, fact) {
  return drafts[key]?.value || savedFactDraft(fact);
}

/** Keep unsaved input with its original server revision so refresh conflicts can be shown. */
export function updateFactDraft(drafts, key, fact, value) {
  return { ...drafts, [key]: { value, saved: drafts[key]?.saved || JSON.stringify(savedFactDraft(fact)) } };
}
