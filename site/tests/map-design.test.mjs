import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_UI,
  routeModeForCount,
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

test('route numbers appear only for a focused route at useful zoom', () => {
  assert.equal(shouldShowRouteNumbers(12, true), true);
  assert.equal(shouldShowRouteNumbers(9, true), false);
  assert.equal(shouldShowRouteNumbers(12, false), false);
});
