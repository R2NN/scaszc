import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutShiftCrewMarkers } from '../src/shiftMarkerLayout.js';

test('co-located crews stay at their actual coordinates, including at the depot', () => {
  const crews = Array.from({ length: 35 }, (_, i) => ({
    id: `crew-${i}`, coords: i < 20 ? [37.62, 55.75] : [37.68, 55.72],
  }));
  const original = structuredClone(crews);
  const offsets = layoutShiftCrewMarkers(crews);
  assert.equal(offsets.size, crews.length);
  for (const crew of crews) assert.deepEqual(offsets.get(crew.id), [0, 0]);
  assert.deepEqual(crews, original);
  assert.deepEqual(layoutShiftCrewMarkers([...crews].reverse()), offsets);
});

test('zooming and panning never add a screen offset to an engineer position', () => {
  const crews = [
    { id: 'at-depot', coords: [37.62, 55.75] },
    { id: 'travelling', coords: [37.621, 55.751] },
    { id: 'on-site', coords: [37.68, 55.72] },
  ];
  for (const zoom of [3, 5, 8, 11, 15, 19]) {
    for (const pan of [[0, 0], [-900, 700]]) {
      const offsets = layoutShiftCrewMarkers(crews);
      for (const crew of crews) {
        const projected = crew.coords.map((value, axis) => value * 2 ** zoom + pan[axis]);
        const rendered = projected.map((value, axis) => value + offsets.get(crew.id)[axis]);
        assert.deepEqual(rendered, projected, `${crew.id} at zoom ${zoom}`);
      }
    }
  }
  assert.deepEqual(layoutShiftCrewMarkers([crews[1]]).get('travelling'), [0, 0]);
  assert.equal(layoutShiftCrewMarkers([]).size, 0);
});
