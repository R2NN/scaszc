import test from 'node:test';
import assert from 'node:assert/strict';
import { durationFormula, durationImpactWeek } from '../src/durationPresentation.js';
import { objectTimeGeoJSON, syncObjectTimeLayers } from '../src/objectTimeLayers.js';
import { calculateDuration, DEFAULT_MODEL } from '../server/durationModel.mjs';

const at = '2026-08-17T07:00:00+03:00';

test('formula sums the authoritative components, paperwork, access and both history components exactly once', () => {
  const snapshot = { ...calculateDuration({ workType: 'Подключение' }, { asOf: at }), technical: 65, access: 15, historyMinutes: 5, total: 90, calculatedTotal: 90, histories: [{ conditionId: 'client', component: 'technical', minutes: 5, reason: 'customer', count: 6 }, { conditionId: 'attic', component: 'access', minutes: 15, reason: 'access', count: 5 }] };
  const formula = durationFormula(snapshot, [{ id: 'attic', finding: 'Доступ на чердак: код от УК', preparation: 'Получить код до выезда' }]);
  assert.equal(formula.rows.reduce((sum, row) => sum + row.minutes, 0), snapshot.total);
  assert.deepEqual(formula.rows.map(row => row.minutes), [60, 5, 10, 15]);
  assert.equal(formula.rows.at(-1).label, 'Доступ на чердак: код от УК');
  assert.equal(formula.rows.at(-1).preparation, 'Получить код до выезда');
  assert.equal(formula.expression, '60 + 5 + 10 + 15 = 90 мин');
});

test('formula preserves discounts, minimum duration and dispatcher override without changing snapshots', () => {
  const snapshots = [
    calculateDuration({ workType: 'Подключение', durationFactors: { line: 'existing' } }, { asOf: at }),
    calculateDuration({ workType: 'Подключение', durationFactors: { line: 'existing' }, durationOverride: { minutes: 50, reason: 'Согласовано с исполнителем' } }, { asOf: at }),
    calculateDuration({ workType: 'Подключение', durationFactors: { line: 'existing' } }, { asOf: at, model: { ...DEFAULT_MODEL, weights: { ...DEFAULT_MODEL.weights, existingLine: -100 } } }),
  ];
  const original = JSON.stringify(snapshots);
  for (const snapshot of snapshots) assert.equal(durationFormula(snapshot).rows.reduce((sum, row) => sum + row.minutes, 0), snapshot.total);
  assert.match(durationFormula(snapshots[0]).expression, /60 − 25 \+ 10 = 45/);
  assert.equal(durationFormula(snapshots[1]).rows.at(-1).detail, 'Согласовано с исполнителем');
  assert.equal(JSON.stringify(snapshots), original);
});

test('weekly impact respects calendar boundaries and excludes missing, future, revised and override forecasts', () => {
  const forecast = { ...calculateDuration({ workType: 'Подключение' }, { asOf: '2026-08-10T07:00:00+03:00' }), total: 90 };
  const visit = { eligible: true, total: 95, forecast, startedAt: '2026-08-11T08:00:00+03:00', endedAt: '2026-08-11T10:00:00+03:00', source: 'synthetic-test' };
  const rows = [visit, { ...visit, endedAt: '2026-08-18T00:00:00+03:00' }, { ...visit, endedAt: '2026-08-10T23:59:59+03:00' }, { ...visit, total: null }, { ...visit, excluded: true }, { ...visit, forecast: { ...forecast, override: { minutes: 90 } } }, { ...visit, forecast: { ...forecast, asOf: '2026-08-12T07:00:00+03:00' } }];
  const impact = durationImpactWeek(rows, at);
  assert.equal(impact.startDate, '2026-08-11');
  assert.equal(impact.endDate, '2026-08-17');
  assert.equal(impact.comparedVisits, 1);
  assert.equal(impact.extendedVisits, 1);
  assert.equal(impact.additionalMinutes, 20);
  assert.equal(impact.preventedLate, null);
  assert.equal(impact.synthetic, true);
  assert.equal(durationImpactWeek([], at).preventedLate, null);
});

test('map keeps signed deltas separate from confirmed access and never invents coordinates', () => {
  const data = objectTimeGeoJSON([
    { id: 'volume', total: 66, delta: 36, coords: [55.6, 37.6], estimate: { access: 0 } },
    { id: 'access', total: 80, delta: 10, coords: [55.7, 37.7], estimate: { access: 10 } },
    { id: 'fast', total: 45, delta: -25, coords: [55.8, 37.8] },
    { id: 'unknown', total: 70, insufficient: true, coords: [55.9, 37.9] },
    { id: 'no-coords', total: 30, delta: 0 },
  ]);
  assert.equal(data.features.length, 4);
  assert.equal(data.features[0].properties.deltaLabel, ' (+36)');
  assert.equal(data.features[2].properties.deltaLabel, ' (−25)');
  assert.equal(data.features[3].properties.deltaLabel, '');
  assert.equal(data.features[3].properties.color, '#92999f');
  const sources = new Map(), layers = new Map();
  const map = { isStyleLoaded: () => true, getSource: id => sources.get(id), addSource: (id, source) => sources.set(id, { ...source, setData(data) { this.data = data; } }), getLayer: id => layers.get(id), addLayer: layer => layers.set(layer.id, layer), setLayoutProperty: (id, key, value) => { (layers.get(id).layout ||= {})[key] = value; }, setPaintProperty: (id, key, value) => { layers.get(id).paint[key] = value; } };
  syncObjectTimeLayers(map, data, { enabled: true, view: 'access', dark: false });
  assert.deepEqual(sources.get('cx-access').data.features.map(row => row.properties.id), ['access']);
  assert.equal(layers.get('cx-points').layout.visibility, 'none');
  assert.equal(layers.get('cx-access-heat').layout.visibility, 'visible');
  syncObjectTimeLayers(map, data, { enabled: true, view: 'markers', dark: false });
  assert.equal(sources.size, 2);
  assert.equal(layers.size, 5);
  assert.equal(layers.get('cx-points').layout.visibility, 'visible');
  assert.equal(layers.get('cx-access-heat').layout.visibility, 'none');
  layers.clear(); sources.clear();
  syncObjectTimeLayers(map, data, { enabled: true, view: 'access', dark: true });
  assert.equal(layers.get('cx-access-label').paint['text-halo-color'], '#252a31');
  syncObjectTimeLayers(map, data, { enabled: false, view: 'access', dark: true });
  assert.ok([...layers.values()].every(layer => layer.layout.visibility === 'none'));
});
