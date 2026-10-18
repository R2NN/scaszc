import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOrderDurationSnapshot, clearOrderDurationSnapshots } from '../src/orderDurationData.js';

test('legacy popup reads coalesce by exact order/date without persisting or altering orders', async () => {
  clearOrderDurationSnapshots();
  const order = { id: 'legacy', duration: 30, workType: 'Локальная заявка' }, before = JSON.stringify(order);
  const bodies = [];
  const fetcher = async (url, options) => { bodies.push(JSON.parse(options.body)); return Response.json({ snapshot: { total: 40, calculatedTotal: 40 } }); };
  const at = '2026-08-17T07:00:00+03:00';
  const first = loadOrderDurationSnapshot(order, at, fetcher);
  assert.equal(loadOrderDurationSnapshot(order, at, fetcher), first);
  assert.equal((await first).total, 40);
  assert.equal(bodies.length, 1); assert.equal(bodies[0].persist, false);
  assert.equal(JSON.stringify(order), before);
  await loadOrderDurationSnapshot(order, '2026-08-18T07:00:00+03:00', fetcher);
  clearOrderDurationSnapshots(); await loadOrderDurationSnapshot(order, at, fetcher);
  assert.equal(bodies.length, 3);
  const saved = { total: 20 };
  assert.equal(await loadOrderDurationSnapshot({ ...order, durationSnapshot: saved }, at, () => { throw Error('Published snapshot must not be replaced'); }), saved);
});

test('a failed popup estimate can be retried', async () => {
  clearOrderDurationSnapshots();let attempt = 0;
  const fetcher = async () => ++attempt === 1 ? Response.json({ error: 'Недоступно' }, { status: 503 }) : Response.json({ snapshot: { total: 30 } });
  const order = { id: 'retry' };
  await assert.rejects(loadOrderDurationSnapshot(order, 'date', fetcher), /Недоступно/);
  assert.equal((await loadOrderDurationSnapshot(order, 'date', fetcher)).total, 30);
});
