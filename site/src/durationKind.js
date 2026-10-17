/** Determine work semantics identically in entry forms and the duration service. */
export function workKind(order) {
  const group = order.workType || order.sourceData?.bk_type || order.skill || '';
  const subtype = order.serviceType || order.sourceData?.hd_type || '';
  if (group === 'Глобальная проблема' && subtype === 'Информация') return 'information';
  if (/Авар|EMERGENCY/i.test(`${group} ${order.skill || ''} ${order.priority || ''}`) || (group === 'Глобальная проблема' && subtype === 'Авария')) return 'emergency';
  const classification = `${group} ${order.skill || ''}`;
  if (/Дозаказ|UPSELL|EQUIPMENT/i.test(classification)) return 'equipment';
  if (/Подключ|INSTALL|Монтаж/i.test(classification)) return 'connection';
  if (/Локаль|LOCAL|REPAIR|SERVICE|Диагност/i.test(classification)) return 'local';
  if (group === 'Глобальная проблема') throw new Error('Для глобальной проблемы укажите подтип: авария или информация.');
  throw new Error('Для расчёта длительности укажите поддерживаемый вид работ.');
}

/** Send the same duration inputs during preview and final order creation. */
export function manualDurationInput(form) {
  return { sourceId: String(form.sourceId || '').trim(), objectId: form.objectId, serviceEntities: form.serviceEntities, workType: form.skill, skill: form.skill, priority: form.skill === 'Аварийные работы' ? 'Авария' : form.priority, durationFactors: form.durationFactors || {}, durationOverride: form.durationOverride };
}
