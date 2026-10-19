/** Select the same regional event context for routing, previews and publication. */
export function transportEventsForDay(db, regionId, date) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transport_events'").get()) return [];
  const start=Date.parse(`${date}T00:00:00+03:00`),end=start+86_400_000;
  return db.prepare('SELECT payload FROM transport_events WHERE region_id=? AND service_date<=? ORDER BY rowid DESC')
    .all(regionId,date).map(row=>JSON.parse(row.payload))
    .filter(event=>Date.parse(event.startsAt)<end&&(!event.endsAt||Date.parse(event.endsAt)>start||event.date===date));
}
