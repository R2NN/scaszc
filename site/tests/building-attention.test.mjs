import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingAttention } from '../src/buildingAttention.js';

const model = { objectId: 'house', sections: [{ id: 'a' }, { id: 'b' }, { id: 'empty' }], placements: [{ entityId: 'node-a', sectionId: 'a' }, { entityId: 'node-b', sectionId: 'b' }] };
const entities = [{ id: 'entrance-a', kind: 'entrance' }, { id: 'node-a', kind: 'node', entranceId: 'entrance-a' }, { id: 'node-b', kind: 'node' }, { id: 'device-a', kind: 'equipment', nodeId: 'node-a' }, { id: 'line-b', kind: 'line', nodeId: 'node-b' }];
const at = '2026-08-17T23:59:59+03:00';
const condition = overrides => ({ id: 'issue', objectId: 'house', scope: 'node', entityId: 'node-a', knownAt: '2026-08-01T10:00:00+03:00', reason: 'diagnosis', ...overrides });

test('building navigator marks every explicitly linked section of a shared problem', () => {
  const result = buildingAttention(model, entities, [condition({ affectedEntityIds: ['line-b'] })], at);
  assert.deepEqual([...result.sectionConditions.keys()].sort(), ['a', 'b']);
  assert.deepEqual([...result.assetConditions.keys()].sort(), ['node-a', 'node-b']);
  assert.deepEqual([...buildingAttention(model, entities, [condition({ entityId: 'device-a' })], at).sectionConditions.keys()], ['a']);
  assert.deepEqual([...buildingAttention(model, entities, [condition({ entityId: 'entrance-a', scope: 'entrance' })], at).sectionConditions.keys()], ['a']);
});

test('whole-object problems include sections with no registered cabinets', () => {
  assert.deepEqual([...buildingAttention(model, entities, [condition({ scope: 'object', entityId: 'house' })], at).sectionConditions.keys()].sort(), ['a', 'b', 'empty']);
});

test('closed, expired, future, positive, generic operation and foreign-object records never become red building faults', () => {
  for (const overrides of [{ closedAt: at }, { validUntil: at }, { knownAt: '2026-08-18T00:00:00+03:00' }, { reason: 'simpler' }, { scope: 'operation' }, { objectId: 'another' }]) {
    assert.equal(buildingAttention(model, entities, [condition(overrides)], at).sectionConditions.size, 0);
  }
});
