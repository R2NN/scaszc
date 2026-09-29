const normalize = value => String(value ?? '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');

const categoryOf = value => {
  const text = normalize(value);
  if (/авар|emerg|incident/.test(text)) return 'emergency';
  if (/дозаказ|upsell|upgrade|дополнительн.*оборуд/.test(text)) return 'upgrade';
  if (/подключ|install|connection/.test(text)) return 'connection';
  if (/локал|local|ремонт|repair|диагност|diagnos|обслуж|service/.test(text)) return 'local';
  return '';
};

/** Read service durations from the supplied workbook, excluding its travel column. */
export function parseWorkNorms(matrix) {
  const headers = matrix[0]?.map(normalize) || [];
  const column = pattern => headers.findIndex(header => pattern.test(header));
  const nameColumn = column(/название работы|вид работ/);
  const technicalColumn = column(/техническ.*работ/);
  const documentsColumn = column(/документ/);
  const travelColumn = column(/дорог/);
  const baseColumn = column(/базов.*норматив/);
  if ([nameColumn, technicalColumn, documentsColumn].some(index => index < 0)) {
    throw new Error('В файле нормативов нужны название работы, технические работы и документы.');
  }
  const norms = {};
  for (const row of matrix.slice(1)) {
    const name = String(row[nameColumn] ?? '').trim();
    if (!name) continue;
    const category = categoryOf(name);
    if (!category || norms[category]) throw new Error(`Неоднозначный вид работ в нормативах: ${name}.`);
    if ([row[technicalColumn], row[documentsColumn]].some(value => value === '' || value == null)) {
      throw new Error(`Не заполнены составляющие норматива для работы «${name}».`);
    }
    const technicalMinutes = Number(row[technicalColumn]);
    const documentMinutes = Number(row[documentsColumn]);
    const serviceMinutes = technicalMinutes + documentMinutes;
    if (![technicalMinutes, documentMinutes].every(Number.isFinite) || serviceMinutes <= 0) {
      throw new Error(`Неверный норматив для работы «${name}».`);
    }
    const travelMinutes = travelColumn < 0 ? null : Number(row[travelColumn]);
    const baseMinutes = baseColumn < 0 ? null : Number(row[baseColumn]);
    if (travelMinutes !== null && baseMinutes !== null && Number.isFinite(travelMinutes)
      && Number.isFinite(baseMinutes) && Math.abs(baseMinutes - travelMinutes - serviceMinutes) > 0.01) {
      throw new Error(`Состав норматива не совпадает с итогом для работы «${name}».`);
    }
    norms[category] = { name, technicalMinutes, documentMinutes, serviceMinutes };
  }
  if (Object.keys(norms).length !== 4) throw new Error('В файле нормативов должны быть четыре вида работ.');
  return norms;
}

/** Find the configured service norm for an imported request. */
export function workNormFor(order, norms) {
  const category = [order.workType, order.serviceType, order.skill, order.name].map(categoryOf).find(Boolean);
  return category ? norms?.[category] || null : null;
}

/** Keep an explicit duration only when the work type has no configured norm. */
export function workDurationFor(order, norms, explicitDuration) {
  const matched = workNormFor(order, norms);
  if (matched) return matched.serviceMinutes;
  const minutes = Number(String(explicitDuration ?? '').replace(',', '.'));
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}
