import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { footprintSections, footprintAgreement, sectionOutline } from '../src/buildingGeometry.js';
import { floorPlanAt } from '../src/buildingInterior.js';
import { buildingAssets, generateBuildingModel, validateBuildingModel, buildingScene } from '../src/buildingModel.js';
import { ShiftStore } from '../server/shiftStore.mjs';
import { readBuilding, saveBuilding } from '../server/buildingApi.mjs';

const example = JSON.parse(readFileSync(new URL('../public/examples/building-model-import.json', import.meta.url), 'utf8'));

test('contour decomposition retains an L-shaped courtyard instead of filling its empty bounding box', () => {
  const contour = [[0, 0], [48, 0], [48, 12], [12, 12], [12, 48], [0, 48]];
  const sections = footprintSections(contour, 5);
  assert.ok(sections.some(section => section.rotation === 90));
  assert.equal(footprintAgreement(contour, sections), 100);
  assert.ok(sections.every(section => section.width >= 4 && section.depth >= 4));
});

test('synthetic interiors distinguish low-rise stairs, lifts, technical basement and sparse network boxes', () => {
  const make = floors => generateBuildingModel({ id: `building-${floors}`, floors }, []);
  const low = make(5), medium = make(9), high = make(25);
  assert.equal(low.sections[0].interior.elevators, 0);
  assert.equal(medium.sections[0].interior.elevators, 1);
  assert.equal(high.sections[0].interior.elevators, 2);
  assert.ok(floorPlanAt(high.sections[0], -1).spaces.some(space => space.kind === 'technical'));
  assert.ok(floorPlanAt(high.sections[0], 1).spaces.some(space => space.kind === 'lobby'));
  assert.ok(floorPlanAt(high.sections[0], 2).spaces.some(space => space.kind === 'apartment'));
  assert.ok(buildingAssets(high).length < high.sections.reduce((sum, section) => sum + section.floors * section.risers.length, 0));
  const industrial = generateBuildingModel({ id: 'new-hall', buildingType: 'warehouse' });
  assert.equal(industrial.type, 'industrial'); assert.equal(industrial.sections[0].interior.layout, 'open');
  const regional = generateBuildingModel({ id: 'unknown-regional-building', address: 'МО, г. Кашира, ул. Примерная, 1' });
  assert.ok(regional.sections[0].floors <= 9); assert.match(regional.provenance.floors, /Модельная/);
});

test('survey-format imports preserve polygonal rooms, special floor plans, rotated wings and exact cable coordinates', () => {
  const model = validateBuildingModel(example, example.objectId);
  assert.deepEqual(model.sections[0].floorPlans, example.sections[0].floorPlans);
  assert.deepEqual(model.cables, example.cables);
  const plan = floorPlanAt(model.sections[0], 6);
  assert.equal(plan.spaces[0].polygon.length, 5);
  assert.notDeepEqual(plan, floorPlanAt(model.sections[0], 5));
  assert.equal(model.sections[1].rotation, 90);
  assert.deepEqual(sectionOutline(model.sections[1])[0], [24, 14]);
  assert.ok(buildingScene(model).viewBox.every(Number.isFinite));
  const invalid = structuredClone(model); invalid.cables[0].points[0].sectionId = 'foreign';
  assert.throws(() => validateBuildingModel(invalid, invalid.objectId), /неизвестную секцию/);
  const badPlan = structuredClone(model); badPlan.sections[0].floorPlans.overrides[0].spaces[0].polygon[0][0] = 1000;
  assert.throws(() => validateBuildingModel(badPlan, badPlan.objectId), /внутри секции/);
});

test('stored explicit layouts and equipment offsets survive reload without replacing them with a template', context => {
  const store = new ShiftStore(':memory:'); context.after(() => store.close());
  const object = { id: 'operator-building', address: 'Модельный объект', regionId: 'moscow' };
  const entities = [{ id: 'node', objectId: object.id, kind: 'node' }];
  store.complexity.registerObject(object, entities);
  const model = { ...example, objectId: object.id, placements: [{ entityId: 'node', sectionId: 'main', floor: 6, x: .382, z: .617, riserId: example.sections[0].risers[0].id, source: 'survey-example' }] };
  const normalized = validateBuildingModel(model, object.id, entities);
  saveBuilding(store.complexity, object.id, { model, expectedRevision: 0, reason: 'Импорт плана обследования — тест формата' });
  const saved = readBuilding(store.complexity, object.id).model;
  assert.deepEqual(saved.sections, normalized.sections);
  assert.deepEqual(saved.placements, normalized.placements);
  assert.deepEqual(saved.cables, normalized.cables);
  assert.equal(buildingAssets(saved, entities).find(asset => asset.id === 'node').x, .382);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM duration_snapshots').get().n, 0);
});

test('legacy v1 geometry receives defaults while explicit nonrectangular section outlines remain unchanged', () => {
  const model = validateBuildingModel({ ...example, sections: [{ ...example.sections[0], width: 24, depth: 14, outline: [[0, 0], [24, 0], [24, 8], [12, 8], [12, 14], [0, 14]] }], cables: [] }, example.objectId);
  assert.deepEqual(model.sections[0].outline, [[0, 0], [24, 0], [24, 8], [12, 8], [12, 14], [0, 14]]);
  const legacy = validateBuildingModel({ objectId: 'legacy', schemaVersion: 1, sections: [{ id: 'a', width: 20, depth: 12, floors: 9, x: 0, z: 0, basement: true }] }, 'legacy');
  assert.equal(legacy.schemaVersion, 2);
  assert.ok(legacy.sections[0].floorPlans.typical.spaces.length);
  assert.ok(legacy.sections[0].risers.length);
});
