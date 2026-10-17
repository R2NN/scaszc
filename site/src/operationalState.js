import { minuteOf, playbackFrame, timeOf } from './shiftDomain.js';

/** Resolve one time/version contract shared by server dispatch and the UI. */
export function operationalStates(shift, minute, mode = 'plan') {
  const frame = playbackFrame(shift, minute, mode);
  return shift.team.map(engineer => {
    const crew = frame.crews.find(item => String(item.engineerId) === String(engineer.id));
    const route = shift.plan?.routes.find(item => String(item.engineerId) === String(engineer.id));
    const visit = route?.assignments.find(item => String(item.orderId) === String(crew?.orderId));
    const fact = (shift.facts || []).find(item => String(item.engineerId) === String(engineer.id) && item.status === 'started' && (minuteOf(item.time) ?? Infinity) <= minute);
    const start = minuteOf(engineer.shiftStart), end = minuteOf(engineer.shiftEnd);
    let status = crew?.status || 'unknown';
    let availableAt = timeOf(Math.max(minute, start ?? minute));
    if (minute < start) status = 'before_shift';
    else if (minute >= end) status = 'after_shift';
    if (/недоступ/i.test(engineer.status || '') && (!engineer.unavailableFrom || minute >= minuteOf(engineer.unavailableFrom))) status = 'unavailable';
    if (fact) { status = 'working'; availableAt = null; }
    else if (status === 'working') availableAt = visit?.plannedFinish || null;
    const coords = fact ? shift.orders.find(item => String(item.id) === String(fact.orderId))?.coords : mode === 'plan' ? crew?.coords : null;
    if (!coords && !['before_shift', 'after_shift', 'unavailable'].includes(status)) { status = 'unknown'; availableAt = null; }
    return { engineerId: engineer.id, moment: `${shift.date}T${timeOf(minute)}:00+03:00`, timezone: 'Europe/Moscow', revision: shift.revision, status,
      orderId: fact?.orderId || crew?.orderId || null, coords: coords || null, availableAt,
      source: fact ? 'dispatcher_fact' : mode === 'plan' ? 'SCENARIO_ROUTE_LENGTH' : crew?.source || 'unknown',
      measuredAt: fact ? `${shift.date}T${fact.time}:00+03:00` : `${shift.date}T${timeOf(minute)}:00+03:00`,
      reason: fact ? 'Фактическая работа не завершена: уточните окончание' : status === 'unknown' ? 'Положение неизвестно' : null };
  });
}
