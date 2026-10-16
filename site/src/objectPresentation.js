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
  const labels = [];
  if (factors.line) labels.push(({ existing: 'Пригодная линия', new: 'Новая линия', unknown: 'Линия не уточнена' })[factors.line]);
  if (factors.diagnosis) labels.push(({ known: 'Неисправность известна', intermittent: 'Периодический сбой', unknown: 'Диагностика' })[factors.diagnosis]);
  for (const [key, unit] of [['devices', 'устр.'], ['points', 'точ.'], ['segments', 'сегм.'], ['sites', 'площ.']]) if (factors[key]) labels.push(`${factors[key]} ${unit}`);
  if (factors.cable && factors.cable !== 'none') labels.push(`Кабель: ${({ short: 'малый объём', standard: 'стандартный', large: 'значительный' })[factors.cable]}`);
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
