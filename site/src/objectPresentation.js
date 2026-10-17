export const OBJECT_TIME_THRESHOLD = 10;
export const OBJECT_TIME_LEGEND = [
  { key: 'faster', color: '#35a98c', label: 'Быстрее на 10+ мин' },
  { key: 'normal', color: '#e7c438', label: 'Близко к нормативу' },
  { key: 'slower', color: '#df6055', label: 'Дольше на 10+ мин' },
  { key: 'unknown', color: '#92999f', label: 'Мало истории' },
];
/** Find repeated differences of at least ten minutes in either direction. */
export function objectTimeCategory(object) {
  if (object.insufficient || !Number.isFinite(object.delta)) return 'unknown';
  if (object.delta <= -OBJECT_TIME_THRESHOLD) return 'faster';
  if (object.delta >= OBJECT_TIME_THRESHOLD) return 'slower';
  return 'normal';
}

/** Describe only the standard quantities relevant to this work type. */
export function standardVolumeLabel(kind) {
  return ({ connection: '1 устройство, 1 точка, 1 площадка', equipment: '1 устройство, 1 точка, 1 площадка', local: '1 сегмент диагностики, 1 площадка', emergency: '1 площадка аварийных работ', information: 'Информационная проверка' })[kind] || 'Для каждого вида работ';
}

/** Filter a selected group identically for its map and address list. */
export function filterObjectGroup(objects, category = 'all', composition = '') {
  return objects.filter(object => (!composition || `${object.kind}/${object.estimate?.operation || 'unspecified'}` === composition) && (category === 'all' || objectTimeCategory(object) === category));
}

/** Keep foreign confirmation visits available while editing a shared condition. */
export function conditionVisitChoices(visits, condition, kind) {
  const choices = new Map(visits.filter(visit => visit.kind === kind).map(visit => [visit.id, visit]));
  for (const visit of condition?.evidence || []) if (visit.kind === kind) choices.set(visit.id, visit);
  return [...choices.values()].sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
}

/** Include a linked visit immediately without changing chronological order. */
export function visibleVisitLimit(visits, selectedId, limit) {
  const index = visits.findIndex(visit => visit.id === selectedId);
  return Math.max(limit, index + 1);
}

/** Compare deltas only within one work type and one operation/volume group. */
export function summarizeObjectGroup(objects) {
  const groups = new Map();
  for (const object of objects) {
    const key = `${object.kind}/${object.estimate?.operation || 'unspecified'}`;
    const group = groups.get(key) || { kind: object.kind, composition: workComposition(object.estimate), operation: object.estimate?.operation, count: 0, unknown: 0, increased: 0, confirmed: 0, deltas: [] };
    group.count++;
    const category = objectTimeCategory(object);
    if (category === 'unknown') group.unknown++;
    else { group.deltas.push(object.delta); if (category === 'slower') group.increased++; }
    if (object.estimate?.histories?.length) group.confirmed++;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    group.deltas.sort((a, b) => a - b);
    const middle = group.deltas.length / 2;
    const medianDelta = group.deltas.length ? group.deltas.length % 2 ? group.deltas[Math.floor(middle)] : (group.deltas[middle - 1] + group.deltas[middle]) / 2 : null;
    return { ...group, medianDelta };
  }).sort((a, b) => b.increased - a.increased || b.count - a.count);
}

/** Name the actual volume so equal work types with different scope remain distinguishable. */
export function workComposition(estimate = {}) {
  const factors = estimate.factors || {};
  const kind = estimate.kind;
  if (kind === 'information') return 'Проверка обращения и информирование';
  const labels = [];
  if (factors.line) labels.push(({ existing: 'Пригодная линия', new: 'Новая линия', unknown: 'Линия не уточнена' })[factors.line]);
  if (factors.diagnosis) labels.push(({ known: 'Неисправность известна', intermittent: 'Периодический сбой', unknown: 'Диагностика' })[factors.diagnosis]);
  if (kind === 'local' && !factors.diagnosis) labels.push('Диагностика');
  if (kind === 'equipment') labels.push(({ add: 'Добавление устройства', replace: 'Замена устройства', move: 'Перенос устройства' })[factors.action || 'add']);
  if (kind === 'emergency') labels.push(({ unknown: 'Состав уточняется', cable: 'Восстановление кабеля', equipment: 'Замена оборудования', multiple: 'Несколько повреждений' })[factors.damage || 'unknown']);
  const quantities = kind === 'local' ? [['segments', 'сегм.'], ['sites', 'площ.']] : ['emergency', 'information'].includes(kind) ? [['sites', 'площ.']] : [['devices', 'устр.'], ['points', 'точ.'], ['sites', 'площ.']];
  for (const [key, unit] of quantities) if (factors[key] || kind) labels.push(`${factors[key] || 1} ${unit}`);
  if (factors.cable && factors.cable !== 'none') labels.push(`Кабель: ${({ short: 'малый объём', standard: 'стандартный', large: 'значительный' })[factors.cable]}`);
  if (factors.requiresNode) labels.push('Посещение узла');
  if (factors.nodeSearch) labels.push('Поиск узла');
  if (factors.readyConfig) labels.push('Готовая конфигурация');
  return labels.filter(Boolean).join(' · ') || 'Стандартный объём';
}

/** Display measured visit stages without inventing missing paperwork or waiting times. */
export function visitTimeRows(visit) {
  const measured = value => Number.isFinite(value) ? value : null;
  const forecast = visit.forecast || {};
  const rows = [
    { key: 'work', label: 'Выполнение работ', plan: measured(forecast.technical), actual: measured(visit.actualTechnical) },
    { key: 'access', label: 'Получение доступа', plan: measured(forecast.access), actual: measured(visit.accessMinutes) },
  ];
  if (Number.isFinite(visit.documentMinutes) && Number.isFinite(visit.customerMinutes)) {
    rows.push(
      { key: 'documents', label: 'Оформление', plan: measured(forecast.documents), actual: visit.documentMinutes },
      { key: 'customer', label: 'Ожидание клиента', plan: null, actual: visit.customerMinutes },
    );
  } else {
    const known = [visit.total, visit.actualTechnical, visit.accessMinutes].every(Number.isFinite);
    const remaining = known ? visit.total - visit.actualTechnical - visit.accessMinutes : null;
    rows.push({ key: 'other', label: 'Оформление и ожидание', plan: measured(forecast.documents), actual: remaining != null && remaining >= 0 ? remaining : null });
  }
  return rows;
}
