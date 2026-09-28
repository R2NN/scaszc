const NORMAL = new Set(['', 'normal', 'обычная', 'обычный']);
const URGENT = new Set([
  'urgent', 'high', 'emergency', 'critical',
  'срочная', 'срочный', 'срочно', 'высокий', 'высокая',
  'авария', 'аварийная', 'аварийный',
]);

/** Convert supported source labels to the two priorities used by the planner. */
export function normalizePlanningPriority(value) {
  const label = String(value ?? '').trim().toLocaleLowerCase('ru-RU');
  if (NORMAL.has(label)) return 'NORMAL';
  if (URGENT.has(label)) return 'URGENT';
  return null;
}

/** Keep emergency wording only for an actual emergency source label. */
export function displayPlanningPriority(value) {
  const code = normalizePlanningPriority(value);
  if (!code) throw new Error(`Неизвестный приоритет заявки: ${value}`);
  if (code === 'NORMAL') return 'Обычная';
  const label = String(value).trim().toLocaleLowerCase('ru-RU');
  return ['emergency', 'авария', 'аварийная', 'аварийный'].includes(label)
    ? 'Авария' : 'Срочная';
}

/** Return whether a request has the planner's urgent priority. */
export function isUrgentPriority(value) {
  return normalizePlanningPriority(value) === 'URGENT';
}
