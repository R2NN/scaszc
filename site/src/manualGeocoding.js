export async function geocodeManualOrder(address, regionId, fetchImpl = fetch, entity = 'Заявка') {
  let response;
  try {
    response = await fetchImpl('/api/geocode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ region: regionId, addresses: [{ id: 'manual-order', address: String(address || '').trim() }] }),
    });
  } catch {
    throw new Error('Не удалось проверить адрес. Проверьте подключение к сервису адресов и повторите попытку.');
  }
  if (!response.ok) throw new Error(`Сервис адресов сейчас недоступен. ${entity} не добавлен${entity === 'Заявка' ? 'а' : ''}; повторите попытку позже.`);
  const payload = await response.json().catch(() => ({}));
  const match = payload.results?.find(item => item.id === 'manual-order');
  const coords = match?.coords;
  if (match?.status !== 'exact' || !['building', 'amenity'].includes(match?.precision) || !Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite)) {
    throw new Error(`Не удалось подтвердить точный дом по этому адресу. Проверьте город, улицу и номер дома. ${entity} не добавлен${entity === 'Заявка' ? 'а' : ''}.`);
  }
  return { coords, formattedAddress: match.formattedAddress || address, geocodeProvider: match.provider || payload.provider || 'unknown' };
}
