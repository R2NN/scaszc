import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ShiftStore } from '../server/shiftStore.mjs';
import { generateBuildingModel, validateBuildingModel, buildingAssets, linkedBuildingOrders, buildingScene } from '../src/buildingModel.js';
import { handleBuilding, readBuilding, saveBuilding } from '../server/buildingApi.mjs';

const object = { id: 'new-building', address: 'Новый корпус, 1', regionId: 'moscow', sourceId: 'not-in-catalog' };
const entities = [{ id: 'entrance', kind: 'entrance', objectId: object.id }, { id: 'node', kind: 'node', entranceId: 'entrance', objectId: object.id, location: 'Технический шкаф в подвале' }, { id: 'device', kind: 'equipment', nodeId: 'node', label: 'Коммутатор' }, { id: 'line', kind: 'line', nodeId: 'node' }];
const generated = () => generateBuildingModel(object, entities);
const fixture = context => {
  const store = new ShiftStore(':memory:'); context.after(() => store.close()); store.complexity.registerObject(object, entities); return store.complexity;
};

test('new buildings render deterministically and observed OSM heights and contours are retained', () => {
  assert.deepEqual(generated(), generated());
  const geometry = [{ lat: 55, lon: 37 }, { lat: 55, lon: 37.001 }, { lat: 55.0002, lon: 37.001 }, { lat: 55.0002, lon: 37 }, { lat: 55, lon: 37 }];
  const osm = { id: 1, type: 'way', tags: { 'building:levels': '24', building: 'apartments' }, geometry };
  const model = generateBuildingModel(object, entities, osm, [{ id: 2, lat: 55, lon: 37, tags: { entrance: 'yes', ref: '6' } }]);
  assert.equal(model.sections.length, 6); assert.ok(model.sections.every(section => section.floors === 24));
  assert.equal(model.footprint.length, 5); assert.match(model.provenance.floors, /OpenStreetMap/);
  assert.equal(model.placements[0].floor, -1); assert.equal(model.source.url, 'https://www.openstreetmap.org/way/1');
  assert.deepEqual(entities[1].location, 'Технический шкаф в подвале');
});

test('real OSM snapshot contains diverse actual floor counts, not a fixed house template', () => {
  const catalog = JSON.parse(readFileSync(new URL('../server/data/building-osm.json', import.meta.url), 'utf8'));
  const ways = catalog.elements.filter(item => item.type === 'way');
  const heights = new Set(ways.filter(item => item.tags?.['building:levels']).map(item => Number(item.tags['building:levels'])));
  assert.equal(ways.length, 177); assert.ok(heights.size >= 15); assert.ok(heights.has(25)); assert.ok(heights.has(4));
  assert.equal(catalog.license, 'ODbL-1.0');
});

test('unequal sections, wings, one-storey warehouses and skyscrapers produce finite fitting bounds', () => {
  for (const floors of [1, 2, 5, 17, 25, 80, 180]) {
    const model = validateBuildingModel({ ...generated(), sections: [{ id: 'a', label: 'Крыло А', floors, width: 18, depth: 12, x: 0, z: 0, roof: 'flat', basement: true }, { id: 'b', label: 'Крыло Б', floors: 2, width: 24, depth: 9, x: 18, z: 12, roof: 'gable', basement: false }], placements: [] }, object.id, entities);
    const scene = buildingScene(model); assert.ok(scene.viewBox.every(Number.isFinite)); assert.ok(scene.viewBox[2] > 0 && scene.viewBox[3] > 0);
    assert.equal(buildingScene(model, 'b').sections.length, 1);
    const assets = buildingAssets(model, entities); assert.equal(assets.length, floors + 2);
  }
});

test('invalid imports reject impossible floors, duplicate sections and foreign equipment', () => {
  const model = generated();
  assert.throws(() => validateBuildingModel({ ...model, objectId: 'another' }, object.id, entities), /другому/);
  assert.throws(() => validateBuildingModel({ ...model, sections: [{ ...model.sections[0], floors: 2.5 }] }, object.id, entities), /целым/);
  assert.throws(() => validateBuildingModel({ ...model, sections: [model.sections[0], model.sections[0]] }, object.id, entities), /разные/);
  assert.throws(() => validateBuildingModel({ ...model, placements: [{ entityId: 'alien', sectionId: model.sections[0].id, floor: 1 }] }, object.id, entities), /неизвестное/);
  assert.throws(() => validateBuildingModel({ ...model, placements: [{ entityId: 'node', sectionId: model.sections[0].id, floor: 0 }] }, object.id, entities), /существующий/);
  assert.throws(() => validateBuildingModel({ ...model, placements: [{ entityId: 'entrance', sectionId: model.sections[0].id, floor: 1 }] }, object.id, entities), /неизвестное/);
  assert.throws(() => validateBuildingModel({ ...model, placements: {} }, object.id, entities), /списком/);
  assert.throws(() => validateBuildingModel({ ...model, sections: [null] }, object.id, entities), /секции/);
});

test('order links require explicit equipment association; schematic boxes never acquire real clients', () => {
  const model = generated(); const assets = buildingAssets(model, entities); const node = assets.find(item => item.id === 'node');
  const orders = [{ id: 'yes', objectId: object.id, serviceEntities: { object: object.id, line: 'line' } }, { id: 'same-address', objectId: object.id, address: object.address }, { id: 'foreign', objectId: 'other', serviceEntities: { object: 'other', node: 'node' } }];
  assert.deepEqual(linkedBuildingOrders(node, orders, object.id, entities).map(item => item.id), ['yes']);
  assert.deepEqual(linkedBuildingOrders(assets.find(item => item.schematic), orders, object.id, entities), []);
});

test('schema saves are isolated, versioned, and stale writes cannot overwrite operator changes', async context => {
  const registry = fixture(context); const before = registry.db.prepare('SELECT * FROM service_objects').all();
  const original = readBuilding(registry, object.id); assert.equal(original.revision, 0);
  const changed = structuredClone(original.model); changed.sections[0].floors = 27;
  const saved = saveBuilding(registry, object.id, { model: changed, expectedRevision: 0, reason: 'Подтверждено обследованием', actor: 'Оператор' });
  assert.equal(saved.revision, 1); assert.equal(saved.model.sections[0].floors, 27); assert.equal(saved.history.length, 2);
  assert.deepEqual(registry.db.prepare('SELECT * FROM service_objects').all(), before);
  assert.equal(registry.db.prepare('SELECT count(*) AS n FROM duration_snapshots').get().n, 0);
  assert.throws(() => saveBuilding(registry, object.id, { model: changed, expectedRevision: 0, reason: 'Старое окно' }), /уже изменилась/);
  assert.throws(() => saveBuilding(registry, object.id, { model: changed, expectedRevision: 1, reason: '' }), /основание/);
  const response = await handleBuilding(new Request(`http://local/api/buildings/${object.id}`), registry); assert.equal(response.status, 200); assert.equal((await response.json()).revision, 1);
  assert.equal((await handleBuilding(new Request('http://local/api/buildings/missing'), registry)).status, 404);
  assert.equal(await handleBuilding(new Request('http://local/api/other'), registry), null);
});
