const REASONS = { access: 'Доступ на объект', extra: 'Дополнительные работы', diagnosis: 'Диагностика', customer: 'Ожидание клиента', simpler: 'Упрощение работ', other: 'Уточнение по истории', unknown: 'Поправка по истории' };
const signed = value => `${value < 0 ? '−' : '+'}${Math.abs(value)}`;

/** Explain the immutable forecast without changing norms, rounding or history weights. */
export function durationFormula(snapshot, conditions = []) {
  const rows = (snapshot.components || []).map((item, index) => ({ key: `${item.key}-${index}`, label: item.key === 'base' ? 'Базовый норматив' : item.label, minutes: item.minutes }));
  if (!rows.length) rows.push({ key: 'base', label: 'Базовый норматив', minutes: snapshot.baseTechnical });
  const factorSum = rows.reduce((sum, item) => sum + item.minutes, 0);
  if (snapshot.factorTechnical !== factorSum) rows.push({ key: 'minimum-volume', label: 'Минимальное время работы', minutes: snapshot.factorTechnical - factorSum });
  const histories = snapshot.histories || [];
  for (const history of histories.filter(item => item.component === 'technical' && item.minutes !== 0)) {
    const condition = conditions.find(item => item.id === history.conditionId);
    rows.push({ key: history.conditionId, label: condition?.finding || `${REASONS[history.reason] || 'Поправка'} · по истории`, minutes: history.minutes, detail: `${history.count} визитов`, preparation: condition?.preparation });
  }
  const technicalSum = rows.reduce((sum, item) => sum + item.minutes, 0);
  if (technicalSum !== snapshot.technical) rows.push({ key: 'technical-remainder', label: histories.some(item => item.component === 'technical') ? 'Минимальное время работы после поправки' : 'Поправка по истории', minutes: snapshot.technical - technicalSum });
  if (snapshot.documents) rows.push({ key: 'documents', label: 'Оформление', minutes: snapshot.documents });
  for (const history of histories.filter(item => item.component === 'access' && item.minutes !== 0)) {
    const condition = conditions.find(item => item.id === history.conditionId);
    rows.push({ key: history.conditionId, label: condition?.finding || 'Доступ на объект · по истории', minutes: history.minutes, detail: `${history.count} визитов`, preparation: condition?.preparation });
  }
  const accessSum = histories.filter(item => item.component === 'access').reduce((sum, item) => sum + item.minutes, 0);
  if (snapshot.access !== accessSum) rows.push({ key: 'access-remainder', label: accessSum ? 'Минимальное время доступа' : 'Доступ на объект', minutes: snapshot.access - accessSum });
  if (snapshot.override) rows.push({ key: 'override', label: 'Корректировка диспетчера', minutes: snapshot.total - snapshot.calculatedTotal, detail: snapshot.override.reason });
  return { rows, total: snapshot.total, expression: rows.map((item, index) => index ? `${item.minutes < 0 ? '−' : '+'} ${Math.abs(item.minutes)}` : String(item.minutes)).join(' ') + ` = ${snapshot.total} мин`, signed };
}

/** Summarize recorded forecasts for seven calendar days; this does not establish SLA causality. */
export function durationImpactWeek(visits, at) {
  const endDay = String(at).slice(0, 10);
  const end = Date.parse(`${endDay}T23:59:59.999+03:00`);
  const start = end - 7 * 86400000 + 1;
  const rows = visits.filter(visit => visit.eligible && !visit.excluded && visit.forecast && !visit.forecast.override && Number.isFinite(visit.total) && Date.parse(visit.forecast.asOf) <= Date.parse(visit.startedAt) && Date.parse(visit.endedAt) >= start && Date.parse(visit.endedAt) <= end);
  const extended = rows.filter(visit => visit.forecast.total > visit.forecast.baseTechnical + visit.forecast.documents);
  const daily = Array.from({ length: 7 }, (_, index) => ({ date: new Date(start + index * 86400000 + 3 * 3600000).toISOString().slice(0, 10), comparedVisits: 0, extendedVisits: 0, additionalMinutes: 0 }));
  for (const visit of rows) {
    const item = daily[Math.floor((Date.parse(visit.endedAt) - start) / 86400000)];
    item.comparedVisits += 1;
    const extra = visit.forecast.total - visit.forecast.baseTechnical - visit.forecast.documents;
    if (extra > 0) { item.extendedVisits += 1; item.additionalMinutes += extra; }
  }
  return { startDate: daily[0].date, endDate: endDay, daily, comparedVisits: rows.length, extendedVisits: extended.length, additionalMinutes: extended.reduce((sum, visit) => sum + visit.forecast.total - visit.forecast.baseTechnical - visit.forecast.documents, 0), preventedLate: null, status: 'NO_COMPARABLE_PLANS', synthetic: rows.some(visit => String(visit.source).includes('synthetic')) };
}
