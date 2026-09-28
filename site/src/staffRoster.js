export function staffActiveOn(member, date) {
  if (!member || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  return (member.rosterPeriods || []).some(period => period.from <= date && (!period.to || date < period.to));
}

export function staffAvailableForShift(roster, shift, date) {
  const inShift = new Set((shift?.team || []).map(member => String(member.id)));
  return (roster || []).filter(member => staffActiveOn(member, date) && !inShift.has(String(member.id)));
}
