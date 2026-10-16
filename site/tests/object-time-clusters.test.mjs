import test from 'node:test';
import assert from 'node:assert/strict';
import { mountObjectTimeClusters, objectClusterSummary } from '../src/objectTimeClusters.js';
import { objectTimeCategory } from '../src/objectPresentation.js';

test('cluster information keeps exact counts without abbreviations or invented missing values', () => {
  const summary = objectClusterSummary({ point_count: 1234, slower: 106, unknown: 7 });
  assert.equal(summary.label.replace(/\s/g, ''), '1234');
  assert.equal(summary.indicator.replace(/\s/g, ''), '↑106');
  assert.deepEqual(summary.rows.map(row => row.value), [1234, 106, 7]);
  assert.equal(objectClusterSummary({ point_count: 2, slower: 0, unknown: 0 }).indicator, '');
  const unavailable = objectClusterSummary({ point_count: 2 });
  assert.deepEqual(unavailable.rows, [{ label: 'Объектов', value: 2 }]);
  assert.equal(unavailable.description, 'Объектов: 2');
  for (const invalid of [null, '', -1, NaN, 1.5]) {
    assert.equal(objectClusterSummary({ point_count: 3, slower: invalid }).indicator, '');
    assert.equal(objectClusterSummary({ point_count: 3, unknown: invalid }).rows.length, 1);
  }
});

test('filtered aggregation keeps insufficient evidence separate from increased duration', () => {
  const objects = [
    { kind: 'local', delta: 35 }, { kind: 'local', delta: 50, insufficient: true },
    { kind: 'local', delta: -10 }, { kind: 'connection', delta: 60 }, { kind: 'local', delta: 9 },
  ];
  const filtered = objects.filter(object => object.kind === 'local');
  const summary = objectClusterSummary({
    point_count: filtered.length,
    slower: filtered.filter(object => objectTimeCategory(object) === 'slower').length,
    unknown: filtered.filter(object => objectTimeCategory(object) === 'unknown').length,
  });
  assert.deepEqual(summary.rows.map(row => row.value), [4, 1, 1]);
});

const clusterFixture = context => {
  class Element {
    children = []; attributes = {}; listeners = {}; style = {};
    clientWidth = 1200; clientHeight = 800; offsetWidth = 70; offsetHeight = 34;
    append(...items) { for (const item of items) item.parentElement = this; this.children.push(...items); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(key, handler) { this.listeners[key] = handler; }
    remove() { this.removed = true; }
    closest() { return null; }
    getBoundingClientRect() { return { left: 0, right: 1200, top: 0, bottom: 800, width: 1200, height: 800 }; }
  }
  const priorDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element(), querySelector: () => null };
  context.after(() => { if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument; });
  const created = [];
  class Marker {
    constructor({ element }) { this.element = element; created.push(this); }
    setLngLat() { return this; }
    addTo() { return this; }
    setOffset() { return this; }
    remove() { this.removed = true; }
  }
  const feature = { properties: { cluster: true, cluster_id: 1, point_count: 12, slower: 3, unknown: 2 }, geometry: { coordinates: [37, 55] } };
  const source = { getClusterLeaves: async () => [{ properties: { id: 'object-A' } }], getClusterExpansionZoom: async () => 12 };
  const container = new Element();
  const handlers = new Map();
  const map = {
    getContainer: () => container, getSource: () => source, isSourceLoaded: () => true,
    querySourceFeatures: () => [feature, feature], project: () => ({ x: 600, y: 400 }),
    on: (event, handler) => handlers.set(event, handler), off: event => handlers.delete(event),
    getCanvas: () => ({ focus() {} }), easeTo: value => { map.camera = value; },
  };
  return { map, Marker, created, container, handlers, feature, source };
};

test('tile duplicates produce one chip; source updates replace stale counts and cleanup removes overlays', async context => {
  const fixture = clusterFixture(context);
  let selection;
  const cleanup = mountObjectTimeClusters(fixture.map, fixture.Marker, ids => { selection = ids; }, () => assert.fail('Unexpected expansion failure'));
  assert.equal(fixture.created.length, 1);
  const first = fixture.created[0].element.children[0];
  assert.match(first.attributes['aria-label'], /Объектов: 12/);
  await first.listeners.click({ stopPropagation() {} });
  assert.deepEqual(selection, ['object-A']);
  assert.equal(fixture.map.camera.zoom, 12);
  fixture.feature.properties.point_count = 7;
  fixture.handlers.get('render')();
  assert.equal(fixture.created.length, 2);
  assert.equal(fixture.created[0].removed, true);
  assert.match(fixture.created[1].element.children[0].attributes['aria-label'], /Объектов: 7/);
  cleanup();
  assert.equal(fixture.handlers.size, 0);
  assert.ok(fixture.created.every(marker => marker.removed));
  assert.ok(fixture.container.children.every(tooltip => tooltip.removed));
});

test('a pending expansion cannot change camera or selection after switching map mode', async context => {
  const fixture = clusterFixture(context);
  let resolveLeaves;
  fixture.source.getClusterLeaves = () => new Promise(resolve => { resolveLeaves = resolve; });
  const cleanup = mountObjectTimeClusters(fixture.map, fixture.Marker, () => assert.fail('Stale selection'), () => assert.fail('Unexpected error'));
  const pending = fixture.created[0].element.children[0].listeners.click({ stopPropagation() {} });
  cleanup();
  resolveLeaves([{ properties: { id: 'old-object' } }]);
  await pending;
  assert.equal(fixture.map.camera, undefined);
});
