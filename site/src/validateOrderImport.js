/** Validate every imported order against the server registry before changing local datasets. */
export async function validateOrderImport(orders, fetcher = fetch) {
  if (!orders.length) return orders;
  const response = await fetcher('/api/complexity/validate-orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orders }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось проверить территории импортируемых заявок.');
  return result.orders;
}
