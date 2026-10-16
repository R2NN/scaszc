import { calculateDuration } from './durationModel.mjs';

/** Rank unresolved, repeated errors by their impact on today's work. */
export function objectAttention(object, visits, at, forecastFor = order => calculateDuration(order, { entities: order.serviceEntities || {} })) {
  const recent = visits.filter(visit => visit.entities?.object === object.id && visit.endedAt && Date.parse(visit.endedAt) <= Date.parse(at) && Date.parse(at) - Date.parse(visit.endedAt) <= 30 * 86400000 && !visit.excluded && visit.eligible && Number.isFinite(visit.actualTechnical) && !['confirmed', 'visit', 'rejected'].includes(visit.learningDecision));
  const groups = new Map();
  for (const visit of recent) {
    const error = visit.reason === 'access' ? visit.accessMinutes - visit.forecast?.access : visit.actualTechnical - visit.forecast?.technical;
    if (!Number.isFinite(error) || Math.abs(error) < 10) continue;
    const key = `${visit.operation}/${visit.findingKey || visit.reason}/${Math.sign(error)}`;
    const group = groups.get(key) || [];
    group.push({ visit, error }); groups.set(key, group);
  }
  const candidates = [...groups.values()].filter(group => group.length >= 2).map(group => {
    group.sort((a, b) => String(b.visit.endedAt).localeCompare(String(a.visit.endedAt)));
    const visit = group[0].visit;
    const minutes = Math.round(group.reduce((sum, item) => sum + Math.abs(item.error), 0) / group.length);
    const currentOrders = (object.examples || []).filter(order => { try { const forecast = forecastFor(order); return visit.reason === 'access' ? forecast.factors?.requiresNode && forecast.entities?.node === visit.entities?.node : forecast.operation === visit.operation; } catch { return false; } }).length;
    return { visitId: visit.id, kind: visit.kind, count: group.length, minutes, currentOrders, score: minutes * group.length * (1 + Math.min(currentOrders, 3)), why: `${group.length} визита за 30 дней: работа ${group[0].error > 0 ? 'дольше' : 'быстрее'} прогноза в среднем на ${minutes} мин`, action: visit.reason === 'unknown' ? 'Уточнить причину' : 'Проверить повторяющуюся причину', finding: visit.finding };
  });
  return candidates.sort((a, b) => b.score - a.score || b.minutes - a.minutes)[0] || null;
}
