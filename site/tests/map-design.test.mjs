import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_UI,
  groupGeographicMarkers,
  groupProjectedMarkers,
  routeModeForCount,
  shouldClusterOrders,
  shouldShowRouteNumbers,
  stableRouteColor,
} from '../src/mapDesign.js';

test('route colors are stable and come from the approved palette', () => {
  assert.equal(stableRouteColor('engineer-17'), stableRouteColor('engineer-17'));
  assert.ok(MAP_UI.routePalette.includes(stableRouteColor('engineer-17')));
});

test('brigade colors fall back to focus above eight visible routes', () => {
  assert.equal(routeModeForCount('brigades', 8), 'brigades');
  assert.equal(routeModeForCount('brigades', 9), 'focus');
  assert.equal(routeModeForCount('focus', 3), 'focus');
});

test('city overview clusters only without a focused route', () => {
  assert.equal(shouldClusterOrders(9.5, false), true);
  assert.equal(shouldClusterOrders(9.5, true), false);
  assert.equal(shouldClusterOrders(12, false), false);
  assert.equal(shouldShowRouteNumbers(12, true), true);
  assert.equal(shouldShowRouteNumbers(9, true), false);
});

test('projected marker grouping is deterministic', () => {
  const items = [{x: 10, y: 10}, {x: 30, y: 20}, {x: 140, y: 20}];
  const groups = groupProjectedMarkers(items, item => item, 80);
  assert.deepEqual(groups.map(group => group.length), [2, 1]);
});

test('geographic cluster membership is independent of viewport panning', () => {
  const items = [
    {id: 1, coords: [55.751, 37.617]},
    {id: 2, coords: [55.752, 37.618]},
    {id: 3, coords: [55.69, 37.82]},
  ];
  const groups = groupGeographicMarkers(items, item => item.coords, 9.5, 82);
  assert.deepEqual(groups.map(group => group.map(item => item.id)), [[1, 2], [3]]);
});
