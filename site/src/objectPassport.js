const requests = new Map();
const passportUrl = (id, at, kind, volume) => `/api/complexity/objects/${encodeURIComponent(id)}?${new URLSearchParams({ at, kind, volume })}`;

/** Return already loaded details without flashing a loading state on reopening. */
export function cachedObjectPassport(id, at, kind = 'local', volume = 'order') {
  return requests.get(passportUrl(id, at, kind, volume))?.data || null;
}

/** Load and reuse object details for the exact date, work type and volume. */
export function loadObjectPassport(id, at, kind = 'local', volume = 'order') {
  const url = passportUrl(id, at, kind, volume);
  if (!requests.has(url)) {
    const entry = { data: null, promise: null };
    entry.promise = (async () => {
      const response = await fetch(url);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Не удалось загрузить объект.');
      entry.data = payload;
      return payload;
    })();
    requests.set(url, entry);
    entry.promise.catch(() => { if (requests.get(url) === entry) requests.delete(url); });
    if (requests.size > 80) requests.delete(requests.keys().next().value);
  }
  return requests.get(url).promise;
}

/** Invalidate cached details after changes to visits, conditions or norms. */
export function clearObjectPassports() {
  requests.clear();
}
