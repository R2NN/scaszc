import test from 'node:test';
import assert from 'node:assert/strict';
import { geocodeManualOrder } from '../src/manualGeocoding.js';

test('manual order resolves a confirmed building address without typed coordinates', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, '/api/geocode');
    const request = JSON.parse(options.body);
    assert.equal(request.region, 'moscow');
    assert.equal(request.addresses[0].address, 'Москва, Авиамоторная улица, дом 10');
    return new Response(JSON.stringify({ results: [{ id: 'manual-order', status: 'exact', precision: 'building', coords: [55.753963, 37.714423], formattedAddress: 'Авиамоторная улица, дом 10', provider: 'geoapify' }] }), { status: 200 });
  };
  const result = await geocodeManualOrder('Москва, Авиамоторная улица, дом 10', 'moscow', fetchImpl);
  assert.deepEqual(result.coords, [55.753963, 37.714423]);
  assert.equal(result.geocodeProvider, 'geoapify');
});

test('manual order never accepts a street centroid or a suggested different house', async () => {
  for (const result of [
    { id: 'manual-order', status: 'review', precision: 'building', coords: [55.75, 37.7] },
    { id: 'manual-order', status: 'exact', precision: 'street', coords: [55.75, 37.7] },
  ]) {
    await assert.rejects(geocodeManualOrder('Москва, Авиамоторная улица, дом 10', 'moscow', async () => new Response(JSON.stringify({ results: [result] }), { status: 200 })), /Не удалось подтвердить точный дом/);
  }
});

test('an engineer start address cannot silently fall back to the city centre', async () => {
  await assert.rejects(
    geocodeManualOrder('Москва, неизвестный адрес', 'moscow', async () => new Response(JSON.stringify({ results: [{ id: 'manual-order', status: 'review', precision: 'street', coords: [55.7558, 37.6173] }] }), { status: 200 }), 'Инженер'),
    /Инженер не добавлен/,
  );
});
