const saved = new WeakMap();

/** Retain the incident focus until the persistent map is ready to receive it. */
export function publishDispatchMapEvent(events, type, detail) {
  if (type === 'clear') saved.delete(events);
  if (type === 'incident-focus') saved.set(events,{type,detail});
  events.dispatchEvent(new CustomEvent(type === 'incident-focus' ? 'beego:incident-focus' : `beego:dispatch-${type}`,{detail}));
}

/** A late map subscription must not lose an already announced emergency. */
export function savedDispatchFocus(events) {return saved.get(events)?.detail;}

/** Focus each newly received pending emergency once; polling never moves it repeatedly. */
export function createIncidentAnnouncer(events) {
  const seen = new Set();
  return incidents => {
    for (const incident of incidents) {
      if (seen.has(incident.id) || ['ACCEPTED','CANCELLED'].includes(incident.status) || !Array.isArray(incident.order?.coords)) continue;
      seen.add(incident.id);
      publishDispatchMapEvent(events,'incident-focus',{coords:incident.order.coords});
    }
  };
}
