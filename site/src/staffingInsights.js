// Count distinct operational profiles, then group them by their own territory.
// Availability in another territory must never conceal a local skill deficit.
export function groupStaffingNeeds(profiles = []) {
  const groups = new Map();
  for (const profile of profiles) {
    const zone = profile.zone || 'Территория не указана';
    if (!groups.has(zone)) groups.set(zone, { zone, needed: 0, available: 0, shortage: 0, gaps: [] });
    const item = groups.get(zone);
    item.needed += Number(profile.needed || 0);
    item.available += Number(profile.available || 0);
    item.shortage += Number(profile.shortage || 0);
    if (profile.shortage > 0) item.gaps.push({ skills: profile.skills || [], count: profile.shortage });
  }
  return [...groups.values()].sort((a,b) => b.shortage-a.shortage || a.zone.localeCompare(b.zone,'ru'));
}
