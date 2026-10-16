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
