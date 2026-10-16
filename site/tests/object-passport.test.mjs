import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedObjectPassport, clearObjectPassports, loadObjectPassport } from '../src/objectPassport.js';
import { visitTimeRows } from '../src/objectPresentation.js';

test('preloading and opening reuse a request; context changes and invalidation load fresh details', async context => {
  clearObjectPassports();
  const urls = [];
  context.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return Response.json({ object: { id: 'house' }, revision: urls.length });
  });
  const at = '2026-08-17T23:59:00+03:00';
  const preload = loadObjectPassport('house', at, 'connection', 'standard');
  assert.equal(cachedObjectPassport('house', at, 'connection', 'standard'), null);
  assert.equal(loadObjectPassport('house', at, 'connection', 'standard'), preload);
  assert.equal((await preload).revision, 1);
  assert.equal(cachedObjectPassport('house', at, 'connection', 'standard').revision, 1);
  assert.equal((await loadObjectPassport('house', at, 'connection', 'standard')).revision, 1);
  await loadObjectPassport('house', at, 'local', 'standard');
  await loadObjectPassport('house', at, 'connection', 'order');
  await loadObjectPassport('house', '2026-08-18T23:59:00+03:00', 'connection', 'standard');
  assert.equal(urls.length, 4);
  const query = new URL(urls[0], 'http://localhost').searchParams;
  assert.equal(query.get('at'), at);
  assert.equal(query.get('kind'), 'connection');
  assert.equal(query.get('volume'), 'standard');
  clearObjectPassports();
  assert.equal(cachedObjectPassport('house', at, 'connection', 'standard'), null);
  assert.equal((await loadObjectPassport('house', at, 'connection', 'standard')).revision, 5);
  clearObjectPassports();
});

test('failed preloads can be retried and never poison the object cache', async context => {
  clearObjectPassports();
  let attempts = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    attempts += 1;
    if (attempts === 1) return Response.json({ error: 'Временная ошибка' }, { status: 503 });
    return Response.json({ object: { id: 'house' } });
  });
  await assert.rejects(loadObjectPassport('house', '2026-08-17', 'local'), /Временная ошибка/);
  assert.equal((await loadObjectPassport('house', '2026-08-17', 'local')).object.id, 'house');
  assert.equal(attempts, 2);
  clearObjectPassports();
});

test('visit stages distinguish work from the complete visit and retain measured zeroes', () => {
  const rows = visitTimeRows({ actualTechnical: 19, accessMinutes: 4, documentMinutes: 10, customerMinutes: 7, total: 40, forecast: { technical: 20, access: 0, documents: 10, total: 30 } });
  assert.deepEqual(rows.map(row => row.actual), [19, 4, 10, 7]);
  assert.deepEqual(rows.map(row => row.plan), [20, 0, 10, null]);
  assert.equal(rows.reduce((sum, row) => sum + row.actual, 0), 40);
  const workOnly = visitTimeRows({ actualTechnical: 19, accessMinutes: 0, documentMinutes: 0, customerMinutes: 0, total: 19 });
  assert.deepEqual(workOnly.map(row => row.actual), [19, 0, 0, 0]);
});

test('legacy visits show combined non-work time without inventing its individual stages', () => {
  const legacy = visitTimeRows({ actualTechnical: 19, accessMinutes: 4, total: 40 });
  assert.equal(legacy[2].label, 'Оформление и ожидание');
  assert.equal(legacy[2].actual, 17);
  const unknown = visitTimeRows({ actualTechnical: null, accessMinutes: 0, total: 40 });
  assert.equal(unknown[0].actual, null);
  assert.equal(unknown[2].actual, null);
  assert.equal(visitTimeRows({ actualTechnical: 19, accessMinutes: 5, total: 20 })[2].actual, null);
});
