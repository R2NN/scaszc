import test from 'node:test';
import assert from 'node:assert/strict';
import { objectTimeCategory } from '../src/objectPresentation.js';
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

test('repeated time differences use symmetric ten-minute boundaries and preserve insufficient history', () => {
  for (const [delta, expected] of [[-11, 'faster'], [-10, 'faster'], [-9, 'normal'], [0, 'normal'], [9, 'normal'], [10, 'slower'], [11, 'slower']]) {
    assert.equal(objectTimeCategory({ delta, insufficient: false }), expected);
  }
  assert.equal(objectTimeCategory({ delta: 100, insufficient: true }), 'unknown');
  assert.equal(objectTimeCategory({ delta: null }), 'unknown');
});
