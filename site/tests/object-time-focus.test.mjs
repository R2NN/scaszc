import assert from 'node:assert/strict';
import test from 'node:test';
import { focusObjectTimeMap } from '../src/objectTimeFocus.js';

function fixture(context, { panelRight = 620, passportLeft = 1080, zoom = 10, maxZoom = 20 } = {}) {
  const previous = globalThis.document;
  globalThis.document = { querySelector: selector => ({ getBoundingClientRect: () => selector === '.sidebar' ? { right: 200 } : { left: passportLeft } }) };
  context.after(() => { globalThis.document = previous; });
  const moves = [];
  const map = {
    getContainer: () => ({ clientWidth: 1600, clientHeight: 1000, getBoundingClientRect: () => ({ top: 0, left: 0, right: 1440, width: 1440, height: 900 }), closest: () => ({ querySelector: () => ({ getBoundingClientRect: () => ({ right: panelRight }) }) }) }),
    getZoom: () => zoom,
    getMaxZoom: () => maxZoom,
    flyTo: options => moves.push(options),
  };
  return { map, moves };
}

test('address focus uses real coordinates, building zoom and the corridor between both drawers at CSS zoom', context => {
  const { map, moves } = fixture(context);
  assert.equal(focusObjectTimeMap(map, [55.7, 37.6]), true);
  const move = moves[0];
  assert.deepEqual(move.center, [37.6, 55.7]);
  assert.equal(move.zoom, 14.5);
  assert.equal(move.duration, 1000);
  assert.ok(Math.abs(move.offset[0] - (850 - 720) / 0.9) < 1e-9);
  assert.equal(move.retainPadding, false);
  assert.deepEqual(move.padding, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.equal(move.bearing, undefined);
  assert.equal(move.pitch, undefined);
});

test('overlapping drawers close only the list and leave room for the house beside the passport', context => {
  const { map, moves } = fixture(context, { passportLeft: 430 });
  let closed = 0;
  focusObjectTimeMap(map, [55.6, 37.7], { onClosePanel: () => closed++ });
  assert.equal(closed, 1);
  assert.equal(moves[0].offset[0], (315 - 720) / 0.9);
});

test('invalid coordinates never move the camera and an overly close zoom is reduced to neighbourhood scale within map limits', context => {
  const { map, moves } = fixture(context, { zoom: 18, maxZoom: 19 });
  for (const coords of [undefined, [], [55], [null, 37], [NaN, 37], [91, 37], [55, 181]]) assert.equal(focusObjectTimeMap(map, coords), false);
  assert.equal(moves.length, 0);
  focusObjectTimeMap(map, [55, 37]);
  assert.equal(moves[0].zoom, 15);
  map.getMaxZoom = () => 16;
  focusObjectTimeMap(map, [55, 37]);
  assert.equal(moves[1].zoom, 15);
});

test('opening an order passport keeps its point between the route list and passport without zooming away from the route', context => {
  const { map, moves } = fixture(context, { zoom: 12.5 });
  const originalContainer = map.getContainer();
  const routePanel = { getBoundingClientRect: () => ({ right: 620 }) };
  map.getContainer = () => ({ ...originalContainer, closest: () => ({ querySelector: selector => selector.startsWith('.route-list-panel') ? routePanel : null }) });
  focusObjectTimeMap(map, [55.7, 37.6], { minZoom: map.getZoom() });
  assert.equal(moves[0].zoom, 12.5);
  assert.ok(Math.abs(moves[0].offset[0] - (850 - 720) / 0.9) < 1e-9);
});

test('a phone passport focuses the house above its bottom sheet with CSS-scaled offsets', context => {
  const { map, moves } = fixture(context);
  globalThis.document = { querySelector: selector => ({ getBoundingClientRect: () => selector === '.sidebar' ? { right: 58 } : { left: 58, top: 405 } }) };
  map.getContainer = () => ({ clientWidth: 433.33, clientHeight: 937.78, getBoundingClientRect: () => ({ left: 0, top: 0, right: 390, width: 390, height: 844 }), closest: () => ({ querySelector: () => ({ getBoundingClientRect: () => ({ right: 390 }) }) }) });
  let closed = false;
  focusObjectTimeMap(map, [55, 37], { onClosePanel: () => { closed = true; } });
  assert.equal(closed, true);
  const x = 195 + moves[0].offset[0] * 390 / 433.33;
  const y = 422 + moves[0].offset[1] * 844 / 937.78;
  assert.ok(x > 58 && x < 326);
  assert.ok(y > 128 && y < 375);
});
