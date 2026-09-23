import test from 'node:test';
import assert from 'node:assert/strict';
import { attachExactBaseline, calculateBaseline, filterExactBaseline, hydrateBaselineInputs } from '../src/baselinePlanning.js';

const engineers = [
  { id: 'first', zone: 'Восток', skills: ['Подключение'], transport: 'Автомобиль', shiftStart: '08:00', shiftEnd: '18:00', startCoords: [55.75, 37.62] },
  { id: 'second', zone: 'Восток', skills: ['Подключение'], transport: 'Автомобиль', shiftStart: '08:00', shiftEnd: '18:00', startCoords: [55.76, 37.63] },
  { id: 'south', zone: 'Югоцентр', skills: ['Аварийные работы'], transport: 'Пешком', shiftStart: '08:00', shiftEnd: '18:00', startCoords: [55.7, 37.6] },
];

test('baseline accepts only a published and validated exact artifact', () => {
  const orders = [
    { id: 'one' },
    { id: 'two' },
  ];
  const exact = {
    status: 'EXACT_VALID',
    validationStatus: 'VALID',
    publicationAllowed: true,
    methodology: 'EXACT_FCFS_SAME_ROUTING_AND_VALIDATOR',
    routes: [{ engineerId: 'first', assignments: [
      { orderId: 'one', distanceM: 1200 },
      { orderId: 'two', distanceM: 2300 },
    ] }],
    unassigned: [],
  };
  const baseline = calculateBaseline(orders, engineers, exact);
  assert.equal(baseline.available, true);
  assert.equal(baseline.exact, true);
  assert.deepEqual(baseline.routes[0].assignments.map(item => item.orderId), ['one', 'two']);
  assert.equal(baseline.routes[0].engineerId, 'first');
  assert.equal(baseline.baselineAssignedCount, 2);
  assert.equal(baseline.baselineEngineersUsed, 1);
  assert.equal(baseline.baselineTotalDistanceKm, 3.5);
  assert.equal(baseline.baselineAvgKmPerOrder, 1.75);
});

test('baseline refuses estimates, invalid artifacts and mismatched datasets', () => {
  assert.equal(calculateBaseline([{ id: 'one' }], engineers).available, false);
  const invalid = { status: 'EXACT_VALID', validationStatus: 'INVALID', publicationAllowed: true, routes: [] };
  assert.equal(calculateBaseline([{ id: 'one' }], engineers, invalid).available, false);
  const mismatch = { status: 'EXACT_VALID', validationStatus: 'VALID', publicationAllowed: true, routes: [{ engineerId: 'first', assignments: [{ orderId: 'another', distanceM: 1 }] }] };
  assert.equal(calculateBaseline([{ id: 'one' }], engineers, mismatch).available, false);
});

test('live canonical plan keeps exact baseline after its order ids are remapped', () => {
  const canonical = {
    date: '2026-08-17',
    orders: [{ id: '2026-08-17:J1', sourceId: 'J1' }],
    team: [{ id: 'E1' }],
    plan: {
      contentSha256: 'canonical',
      baseline: {
        status: 'EXACT_VALID', validationStatus: 'VALID', publicationAllowed: true,
        routes: [{ engineerId: 'E1', assignments: [{ orderId: '2026-08-17:J1', engineerId: 'E1', distanceM: 1000 }] }],
        unassigned: [],
        metrics: { total: 1, assigned: 1, unassigned: 0 },
      },
    },
  };
  const live = {
    date: '2026-08-17',
    orders: [{ id: 42, sourceId: 'J1' }],
    team: [{ id: 7, sourceId: 'E1' }],
    plan: { contentSha256: 'canonical' },
  };
  const attached = attachExactBaseline(live, canonical);
  assert.equal(attached.plan.baseline.routes[0].assignments[0].orderId, '42');
  assert.equal(attached.plan.baseline.routes[0].engineerId, '7');
  assert.equal(calculateBaseline(live.orders, live.team, attached.plan.baseline).available, true);
  assert.equal(attachExactBaseline({ ...live, plan: { contentSha256: 'modified' } }, canonical).plan.baseline, undefined);
});

test('territory view preserves only the validated plan entries in that territory', () => {
  const baseline = {
    status: 'EXACT_VALID', validationStatus: 'VALID', publicationAllowed: true,
    routes: [
      { engineerId: 'E1', assignments: [{ orderId: 'J1', distanceM: 1000 }] },
      { engineerId: 'E2', assignments: [{ orderId: 'J2', distanceM: 2000 }] },
    ],
    unassigned: [{ orderId: 'J3' }],
  };
  const filtered = filterExactBaseline(baseline, new Set(['J1']), new Set(['E1']));
  assert.equal(filtered.metrics.total, 1);
  assert.equal(filtered.metrics.distanceKm, 1);
  assert.equal(calculateBaseline([{ id: 'J1' }], [{ id: 'E1' }], filtered).available, true);
});

test('baseline inputs are hydrated automatically for every available day', () => {
  const payload = {
    days: [
      {
        date: '2026-08-16',
        orders: [{ id: '2026-08-16:order-1', sourceId: 'order-1' }],
        team: [{ id: 'engineer-1' }],
      },
      {
        date: '2026-08-17',
        orders: [{ id: '2026-08-17:order-1', sourceId: 'order-1' }],
        team: [{ id: 'engineer-1' }],
      },
    ],
  };
  const source = {
    jobs: [{ job_id: 'order-1', latitude: '55.75', longitude: '37.62' }],
    engineers: [{ engineer_id: 'engineer-1', start_latitude: '55.74', start_longitude: '37.61', start_address: 'Офис' }],
  };

  const hydrated = hydrateBaselineInputs(payload, source);
  for (const day of hydrated.days) {
    assert.deepEqual(day.orders[0].coords, [55.75, 37.62]);
    assert.deepEqual(day.team[0].startCoords, [55.74, 37.61]);
    assert.equal(day.team[0].startAddress, 'Офис');
  }
});
