import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchRouteData, renderDispatchRoutes } from '../src/dispatchComparison.js';
import { MAP_UI } from '../src/mapDesign.js';

const leg = (orderId, departureAt, arrival, geometry) => ({ orderId, departureAt, arrival, geometry });
const plan = assignments => ({ routes: [{ engineerId: 'crew', assignments }] });
const detail = { ids: ['crew'], current: { engineerId: 'crew', time: '11:17', origin: [0, 1], kind: 'Перехват в пути', emergencyOrderId: 'emergency' } };

const mapFixture = () => {
  const sources = new Map(), layers = new Map();
  const map = {
    getSource: id => sources.get(id),
    addSource(id, value) { sources.set(id, { data: value.data, setData(data) { this.data = data; } }); },
    getLayer: id => layers.get(id),
    addLayer(value) { layers.set(value.id, { ...value, paint: { ...value.paint } }); },
    setPaintProperty(id, key, value) { layers.get(id).paint[key] = value; },
    setFilter(id, filter) { layers.get(id).filter = filter; },
    moveLayer() {},
  };
  return { map, sources, layers };
};

test('comparison trims elapsed travel along a bent road without a connector back to its start', () => {
  const before = plan([
    leg('done', '10:00', '10:10', [[0, -1], [0, 0]]),
    leg('next', '11:07', '11:27', [[0, 0], [0, 1], [1, 1]]),
    leg('later', '12:00', '12:10', [[1, 1], [2, 1]]),
  ]);
  const result = dispatchRouteData(before, detail);
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features[0].geometry.coordinates, [[1, 0], [1, 1]]);
  assert.deepEqual(result.features[1].geometry.coordinates, [[1, 1], [1, 2]]);
  assert.equal(result.features[0].properties.orderId, 'next');
});

test('the reroute starts at the same checkpoint and omits the movement already travelled', () => {
  const after = plan([leg('emergency', '11:17', '11:39', [[0, 1], [-1, 1]])]);
  after.routes[0].movements = [{ departure_at: '2026-08-17T11:07:00+03:00', at: '2026-08-17T11:17:00+03:00', geometry: [[0, 0], [0, 1]] }];
  const result = dispatchRouteData(after, detail, true);
  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].geometry.coordinates, [[1, 0], [1, -1]]);
});

test('public transit keeps only the remaining ride to its legal exit before diverting', () => {
  const after = plan([leg('emergency', '11:27', '11:45', [[1, 1], [1, 2]])]);
  after.routes[0].movements = [{ departure_at: '2026-08-17T11:07:00+03:00', at: '2026-08-17T11:27:00+03:00', geometry: [[0, 0], [0, 1], [1, 1]] }];
  const result = dispatchRouteData(after, detail, true);
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features[0].geometry.coordinates, [[1, 0], [1, 1]]);
  assert.deepEqual(result.features[1].geometry.coordinates[0], [1, 1]);
});

test('completed travel, waiting at the destination and other engineers do not add old routes', () => {
  const before = plan([leg('waiting', '11:00', '11:10', [[0, 0], [0, 1]])]);
  before.routes.push({ engineerId: 'other', assignments: [leg('other-job', '12:00', '12:10', [[1, 0], [2, 0]])] });
  assert.deepEqual(dispatchRouteData(before, detail).features, []);
});

test('ISO timestamps and missing arrival fields cannot reintroduce past journeys', () => {
  const before = plan([
    { ...leg('finished', '2026-08-17T10:00:00+03:00', undefined, [[0, -2], [0, -1]]), plannedStart: '10:30' },
    { ...leg('underway', '2026-08-17T11:07:00+03:00', undefined, [[0, 0], [0, 1], [1, 1]]), travelMinutes: 20 },
    leg('unknown', '10:00', undefined, [[-1, -1], [0, 0]]),
  ]);
  const result = dispatchRouteData(before, detail);
  assert.deepEqual(result.features.map(feature => feature.properties.orderId), ['underway']);
  assert.deepEqual(result.features[0].geometry.coordinates[0], [1, 0]);
  assert.equal(dispatchRouteData(before, { ...detail, current: {} }).features.length, 0);
});

test('the whole future day is visible by default and separates the emergency leg from later trips', () => {
  const { map, sources, layers } = mapFixture();
  const before = plan([
    leg('past', '10:00', '10:10', [[0, -1], [0, 0]]),
    leg('own-next', '11:07', '11:27', [[0, 0], [0, 1], [1, 1]]),
    leg('own-later', '12:00', '12:10', [[1, 1], [2, 1]]),
  ]);
  const after = plan([
    leg('past', '10:00', '10:10', [[0, -1], [0, 0]]),
    leg('emergency', '11:17', '11:39', [[0, 1], [0, 2]]),
    leg('after-emergency', '13:00', '13:20', [[0, 2], [-1, 2]]),
  ]);
  renderDispatchRoutes(map, { ...detail, before, after });
  assert.deepEqual(sources.get('dispatch-before').data.features.map(f => f.properties.orderId), ['own-next', 'own-later']);
  assert.deepEqual(sources.get('dispatch-after').data.features.map(f => f.properties.phase), ['response', 'continuation']);
  assert.deepEqual(layers.get('dispatch-after').filter, ['==', ['get', 'phase'], 'response']);
  assert.deepEqual(layers.get('dispatch-after-continuation').filter, ['==', ['get', 'phase'], 'continuation']);
  assert.deepEqual(layers.get('dispatch-after-continuation').paint['line-dasharray'], [2, 2]);
  assert.ok(layers.get('dispatch-after').paint['line-width'] > layers.get('dispatch-after-continuation').paint['line-width']);
  assert.equal(layers.get('dispatch-after-arrows').layout['text-keep-upright'], false);
  assert.ok(sources.get('dispatch-stops').data.features.some(f => f.properties.label === 'Авария · 11:39'));
  assert.ok(sources.get('dispatch-stops').data.features.some(f => f.properties.label === '2 · 13:20'));
  renderDispatchRoutes(map, { ...detail, before, after, scope: 'next' });
  assert.equal(sources.get('dispatch-before').data.features.length, 1);
  assert.equal(sources.get('dispatch-after').data.features.length, 1);
});

test('switching a grey comparison to an intercept repaints existing layers and separates overlapping paths', () => {
  const { map, layers } = mapFixture();
  const before = plan([leg('next', '11:17', '11:27', [[0, 1], [1, 1]])]);
  const data = { ...detail, before, after: before };
  renderDispatchRoutes(map, { ...data, current: { ...detail.current, kind: 'Свободный инженер' } });
  assert.equal(layers.get('dispatch-before').paint['line-color'], '#737b87');
  renderDispatchRoutes(map, data);
  assert.equal(layers.get('dispatch-before').paint['line-color'], MAP_UI.routeSelected);
  assert.equal(layers.get('dispatch-after').paint['line-color'], MAP_UI.urgent);
  assert.deepEqual(layers.get('dispatch-before').paint['line-dasharray'], [1, 0]);
  assert.equal(layers.get('dispatch-before').paint['line-offset'], -3);
  assert.equal(layers.get('dispatch-after').paint['line-offset'], 3);
  renderDispatchRoutes(map, { ...data, current: { ...detail.current, kind: 'Свободный инженер' } });
  assert.equal(layers.get('dispatch-after').paint['line-color'], MAP_UI.routeSelected);
  assert.equal(layers.get('dispatch-after').paint['line-offset'], 0);
});
