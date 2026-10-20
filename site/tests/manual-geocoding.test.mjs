import test from 'node:test';
import assert from 'node:assert/strict';
import { geocodeManualOrder } from '../src/manualGeocoding.js';
import worker from '../worker/index.js';

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

test('an autocomplete building can be confirmed without mistaking its postcode for the house', async () => {
  const originalFetch = globalThis.fetch;
  const candidate = {
    city: 'Москва', street: 'Рязанский проспект', housenumber: '79 к1',
    formatted: 'Рязанский проспект 79 к1, Рязанский район, Москва, Россия, 109377',
    lat: 55.717199, lon: 37.796011, result_type: 'building',
    rank: { confidence: 1, match_type: 'full_match' },
  };
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(new URL(url));
    return Response.json({ results: [candidate] });
  };
  try {
    const env = { GEOAPIFY_API_KEY: 'test-key' };
    const response = await worker.fetch(new Request('http://localhost/api/geocode/suggest?q=Рязанский%2079'), env);
    const suggestion = (await response.json()).results[0];
    assert.equal(suggestion.address, 'Москва, Рязанский проспект, дом 79 к1');
    const result = await geocodeManualOrder(suggestion.address, 'moscow',
      async (url, options) => worker.fetch(new Request(`http://localhost${url}`, options), env));
    assert.deepEqual(result.coords, [55.717199, 37.796011]);
    assert.equal(result.geocodeProvider, 'geoapify');
    assert.ok(requests.some(url => url.pathname.endsWith('/search')));
    assert.ok(requests.every(url => !url.searchParams.get('text').includes('109377')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
