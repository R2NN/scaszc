const entries = new Map();
const maxAge = 60_000;
export const cachedObjectTimeObjects = url => {
  const entry = entries.get(url);
  return entry?.data && Date.now() - entry.loadedAt < maxAge ? entry.data : null;
};
export function loadObjectTimeObjects(url, loader) {
  const cached = entries.get(url);
  if (cached && (!cached.data || Date.now() - cached.loadedAt < maxAge)) return cached.promise;
  const entry = { data: null, loadedAt: 0, promise: null };
  entry.promise = Promise.resolve().then(() => loader(url)).then(data => { entry.data = data; entry.loadedAt = Date.now(); return data; }).catch(error => { if (entries.get(url) === entry) entries.delete(url); throw error; });
  entries.set(url, entry);
  if (entries.size > 12) entries.delete(entries.keys().next().value);
  return entry.promise;
}
export function clearObjectTimeObjects() { entries.clear(); }
