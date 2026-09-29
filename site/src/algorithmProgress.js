const STORAGE_KEY = 'beego-algorithm-durations-v1';

export const algorithmPhaseLabel = phase => ({
  VALIDATING_INPUT: 'Проверяем входные данные',
  LOOKUP_VALIDATED_PLAN: 'Проверяем сохранённый точный план',
  PREPARING_DATA: 'Подготавливаем данные для алгоритма',
  PREPARING_ROUTES: 'Подготавливаем дорожные и транспортные данные',
  EXACT_PIPELINE: 'Строим маршруты и проверяем ограничения',
  READING_VALIDATED_PLAN: 'Загружаем проверенный результат',
  VALIDATING_PLAN: 'Проводим итоговую проверку плана',
  SAVING_SHIFT: 'Сохраняем план смены',
  DRAFT: 'Создаём черновик изменений',
  EXACT_EVENT: 'Перестраиваем маршруты после события',
  EXACT_FULL_DAY: 'Проверяем полную перестройку дня',
  EXACT_ALTERNATIVE_WINDOW: 'Ищем проверенное другое окно',
  ROAD_CHECK: 'Проверяем дороги и ограничения',
  READY: 'Расчёт завершён',
})[phase] || 'Точный расчёт выполняется';

const sizeGroup = count => count < 100 ? 'small' : count < 300 ? 'medium' : 'large';

/** Estimate from completed calculations of the same type and order-count group. */
export function estimateAlgorithmSeconds(kind, orderCount) {
  try {
    const samples = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const comparable = samples.filter(item => item.kind === kind && item.size === sizeGroup(orderCount)).map(item => item.seconds).sort((a, b) => a - b);
    return comparable.length ? comparable[Math.floor(comparable.length / 2)] : null;
  } catch { return null; }
}

/** Save a measured duration only after a server calculation actually completes. */
export function recordAlgorithmSeconds(kind, orderCount, seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  try {
    const samples = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const comparable = item => item.kind === kind && item.size === sizeGroup(orderCount);
    const next = [...samples.filter(item => !comparable(item)), ...samples.filter(comparable).slice(-7), { kind, size: sizeGroup(orderCount), seconds }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(-24)));
  } catch { /* Storage can be disabled; the current elapsed time still works. */ }
}
