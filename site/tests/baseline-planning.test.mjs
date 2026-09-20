import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBaseline, hydrateBaselineInputs } from '../src/baselinePlanning.js';

const engineers = [
  { id: 'first', zone: 'Восток', skills: ['Подключение'], transport: 'Автомобиль', shiftStart: '08:00', shiftEnd: '18:00', startCoords: [55.75, 37.62] },
  { id: 'second', zone: 'Восток', skills: ['Подключение'], transport: 'Автомобиль', shiftStart: '08:00', shiftEnd: '18:00', startCoords: [55.76, 37.63] },
  { id: 'south', zone: 'Югоцентр', skills: ['Аварийные работы'], transport: 'Пешком', shiftStart: '08:00', shiftEnd: '18:00', startCoords: [55.7, 37.6] },
];

test('baseline keeps file order and selects the first feasible engineer', () => {
  const orders = [
    { id: 'one', zone: 'Восток', skill: 'Подключение', start: '09:00', end: '12:00', duration: 60, coords: [55.76, 37.63] },
    { id: 'two', zone: 'Восток', skill: 'Подключение', start: '10:00', end: '15:00', duration: 60, coords: [55.77, 37.64] },
  ];
  const baseline = calculateBaseline(orders, engineers);
  assert.deepEqual(baseline.routes[0].assignments.map(item => item.orderId), ['one', 'two']);
  assert.equal(baseline.routes[0].engineerId, 'first');
  assert.equal(baseline.baselineAssignedCount, 2);
  assert.equal(baseline.baselineEngineersUsed, 1);
  assert.ok(baseline.baselineTotalDistanceKm > 0);
  assert.equal(baseline.baselineAvgKmPerOrder, baseline.baselineTotalDistanceKm / 2);
});

test('baseline enforces territory, skill and transport constraints', () => {
  const orders = [
    { id: 'wrong-zone', zone: 'Юго-восток', skill: 'Подключение', start: '09:00', end: '12:00', duration: 30, coords: [55.7, 37.7] },
    { id: 'wrong-skill', zone: 'Восток', skill: 'Аварийные работы', start: '09:00', end: '12:00', duration: 30, coords: [55.76, 37.63] },
    { id: 'wrong-transport', zone: 'Восток', skill: 'Подключение', transport: 'Велосипед', start: '09:00', end: '12:00', duration: 30, coords: [55.76, 37.63] },
    { id: 'valid', zone: 'Югоцентр', skill: 'Аварийные работы', transport: 'Пешком', start: '09:00', end: '12:00', duration: 30, coords: [55.7, 37.61] },
  ];
  const baseline = calculateBaseline(orders, engineers);
  assert.equal(baseline.baselineAssignedCount, 1);
  assert.deepEqual(baseline.routes[0].assignments.map(item => item.orderId), ['valid']);
  assert.deepEqual(baseline.unassigned.map(item => item.orderId), ['wrong-zone', 'wrong-skill', 'wrong-transport']);
});

test('baseline does not reorder visits to rescue a later window', () => {
  const orders = [
    { id: 'late-window', zone: 'Восток', skill: 'Подключение', start: '14:00', end: '17:00', duration: 120, coords: [55.76, 37.63] },
    { id: 'early-window', zone: 'Восток', skill: 'Подключение', start: '09:00', end: '10:00', duration: 30, coords: [55.77, 37.64] },
  ];
  const baseline = calculateBaseline(orders, [engineers[0]]);
  assert.deepEqual(baseline.routes[0].assignments.map(item => item.orderId), ['late-window']);
  assert.deepEqual(baseline.unassigned.map(item => item.orderId), ['early-window']);
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
