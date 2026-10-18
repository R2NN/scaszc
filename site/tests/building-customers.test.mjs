import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingCustomers, syntheticCustomerLocations, validateCustomerLocations } from '../src/buildingCustomers.js';
import { generateBuildingModel, validateBuildingModel } from '../src/buildingModel.js';
import { ShiftStore } from '../server/shiftStore.mjs';
import { readBuilding, saveBuilding } from '../server/buildingApi.mjs';

const object = { id: 'house', address: 'Учебный дом, 1', floors: 5, source: 'Инфраструктура и история: генератор complexity-v2.', examples: [{ id: 'order-a', workType: 'Локальная заявка', serviceEntities: { object: 'house', node: 'node' } }] };
const entities = [{ id: 'node', kind: 'node', objectId: object.id, location: 'Первый этаж' }];
const model = () => generateBuildingModel(object, entities);
const order = { id: 'order-a', objectId: 'house', sourceId: '123', serviceEntities: { object: 'house', node: 'node' } };

test('synthetic apartments are reproducible and generated only for explicitly synthetic registry examples', () => {
  const first = model(), second = model();
  assert.deepEqual(first.customerLocations, second.customerLocations);
  assert.equal(first.customerLocations.length, 1);
  assert.equal(first.customerLocations[0].source, 'synthetic');
  assert.deepEqual(syntheticCustomerLocations(first, { ...object, source: 'imported operator inventory' }), []);
  const emergency = generateBuildingModel({ ...object, examples: [{ ...object.examples[0], workType: 'Глобальная проблема' }] }, entities);
  assert.deepEqual(emergency.customerLocations, []);
});

test('only current orders of the exact object acquire apartment markers; unknown orders stay unknown', () => {
  const result = buildingCustomers(model(), [order, { id: 'new-order', objectId: 'house' }, { ...order, id: 'foreign', objectId: 'elsewhere', serviceEntities: { object: 'elsewhere' } }]);
  assert.equal(result.length, 2); assert.equal(result[0].known, true); assert.equal(result[1].known, false);
  assert.equal(buildingCustomers(model(), []).length, 0);
});

test('explicit order apartment data overrides synthetic mapping and cannot target a technical room or foreign floor', () => {
  const original = model(), location = { ...original.customerLocations[0], floor: 2, unit: '47Б', source: 'import' };
  const result = buildingCustomers(original, [{ ...order, buildingLocation: location }]);
  assert.equal(result[0].floor, 2); assert.equal(result[0].unit, '47Б'); assert.equal(result[0].source, 'import');
  for (const patch of [{ floor: 100 }, { sectionId: 'alien' }, { spaceId: 'corridor' }, { source: '' }, { unit: '' }, { unit: {} }, { unit: 'a'.repeat(41) }]) {
    assert.throws(() => validateCustomerLocations([{ ...location, ...patch }], original));
  }
  assert.equal(buildingCustomers(original, [{ ...order, buildingLocation: { ...location, spaceId: 'corridor' } }])[0].known, false);
});

test('versioned apartment corrections persist without modifying operational orders or duration inputs', context => {
  const store = new ShiftStore(':memory:'); context.after(() => store.close());
  store.complexity.registerObject(object, entities);
  const before = store.db.prepare('SELECT * FROM service_objects').all();
  const changed = model(); changed.customerLocations[0] = { ...changed.customerLocations[0], unit: '47Б', source: 'operator', floor: 2 };
  const normalized = validateBuildingModel(changed, object.id, entities);
  saveBuilding(store.complexity, object.id, { model: changed, expectedRevision: 0, reason: 'Уточнение квартиры по заявке', actor: 'Оператор' });
  assert.deepEqual(readBuilding(store.complexity, object.id).model.customerLocations, normalized.customerLocations);
  assert.deepEqual(store.db.prepare('SELECT * FROM service_objects').all(), before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM duration_snapshots').get().n, 0);
});
