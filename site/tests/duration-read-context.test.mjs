import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiftStore } from '../server/shiftStore.mjs';
import { seedComplexity } from '../server/complexitySeed.mjs';
import { handleComplexity } from '../server/complexityApi.mjs';

test('batched object forecasts retain exact results, scoped/shared evidence and fresh reads after writes', async t => {
  const store = new ShiftStore(':memory:'); t.after(() => store.close());
  const registry = store.complexity;
  await seedComplexity(registry);
  const at = '2026-08-17T23:59:00+03:00';
  const objects = registry.objects().filter(item => item.regionId === 'moscow');
  const read = registry.durationReadContext(at);
  const originals = objects.flatMap(item => item.examples || []);
  assert.ok(originals.length > 100);
  for (const order of originals) assert.deepEqual(registry.estimate(order, at, false, read), registry.estimate(order, at));
  const before = await (await handleComplexity(new Request(`http://test/api/complexity/objects?kind=all&at=${encodeURIComponent(at)}`), registry)).json();
  const model = registry.model();
  registry.saveModel({ ...model, expectedVersion: model.version, norms: { ...model.norms, connection: [75, 10] }, reason: 'Проверка свежего чтения', actor: 'Тест', effectiveAt: at });
  const after = await (await handleComplexity(new Request(`http://test/api/complexity/objects?kind=all&at=${encodeURIComponent(at)}`), registry)).json();
  const connections = before.filter(item => item.kind === 'connection');
  assert.ok(connections.length);
  assert.notEqual(after.find(item => item.id === connections[0].id).estimate.baseTechnical, connections[0].estimate.baseTechnical);
});
