export function staffActiveOn(member, date) {
  if (!member || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;
  return (member.rosterPeriods || []).some(period => period.from <= date && (!period.to || date < period.to));
}

export function staffAvailableForShift(roster, shift, date) {
  const inShift = new Set((shift?.team || []).map(member => String(member.id)));
  return (roster || []).filter(member => staffActiveOn(member, date) && !inShift.has(String(member.id)));
}

/** Return active roster members already in the shift who have no assigned visits. */
export function staffIdleInShift(roster, shift, date) {
  const activeIds = new Set((roster || []).filter(member => staffActiveOn(member, date)).map(member => String(member.id)));
  const assignedIds = new Set((shift?.plan?.routes || [])
    .filter(route => route.assignments?.length)
    .map(route => String(route.engineerId)));
  const idleIds = new Set((shift?.team || []).filter(member => activeIds.has(String(member.id))
    && !assignedIds.has(String(member.id))
    && !member.unavailableFrom
    && !/недоступ|снят со смены|unavailable/i.test(member.status || '')).map(member => String(member.id)));
  return (roster || []).filter(member => idleIds.has(String(member.id)));
}
