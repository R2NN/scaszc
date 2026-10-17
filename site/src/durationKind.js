import { orderSemantics } from './orderSemantics.js';

/** Determine work semantics identically in entry forms and the duration service. */
export function workKind(order) {
  const semantics = orderSemantics(order);
  if (semantics.kind) return semantics.kind;
  throw new Error('Для расчёта длительности укажите поддерживаемый вид работ.');
}

/** Send the same duration inputs during preview and final order creation. */
export function manualDurationInput(form) {
  return { sourceId: String(form.sourceId || '').trim(), address: form.address, coords: form.coords, zone: form.zone, zoneId: form.zoneId, district: form.district, objectId: form.objectId, serviceEntities: form.serviceEntities, workType: form.skill, skill: form.skill, priority: form.skill === 'Аварийные работы' ? 'Авария' : form.priority, durationFactors: form.durationFactors || {}, durationOverride: form.durationOverride };
}
