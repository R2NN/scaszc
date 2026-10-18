const requests = new Map();

/** Read an estimate for legacy orders without writing snapshots or changing their published plan. */
export function loadOrderDurationSnapshot(order, at, fetcher = fetch) {
  if (order.durationSnapshot) return Promise.resolve(order.durationSnapshot);
  const key = JSON.stringify([at, order]);
  if (!requests.has(key)) {
    const promise = (async () => {
      const response = await fetcher('/api/complexity/estimate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order, asOf: at, persist: false }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось рассчитать время');
      return result.snapshot;
    })();
    requests.set(key, promise);
    promise.catch(() => { if (requests.get(key) === promise) requests.delete(key); });
    if (requests.size > 100) requests.delete(requests.keys().next().value);
  }
  return requests.get(key);
}
export function clearOrderDurationSnapshots() { requests.clear(); }
