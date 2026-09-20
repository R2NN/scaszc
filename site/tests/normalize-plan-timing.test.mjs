import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRouteDepartures } from '../scripts/normalize-plan-timing.mjs';

test('latest-safe departure leaves a 15-minute buffer without changing service times', () => {
  const result = normalizeRouteDepartures([{
    departureAt: '10:00', arrival: '10:23', plannedStart: '16:00', plannedFinish: '16:30', travelMinutes: 23,
  }], '10:00');
  assert.deepEqual(result.assignments[0], {
    departureAt: '15:22', arrival: '15:45', plannedStart: '16:00', plannedFinish: '16:30', travelMinutes: 23,
  });
  assert.equal(result.waitingMinutes, 15);
  assert.equal(result.delayedDepartures, 1);
});

test('latest-safe departure never moves a leg before a preceding visit or past service start', () => {
  const result = normalizeRouteDepartures([
    { departureAt: '10:00', arrival: '10:10', plannedStart: '10:10', plannedFinish: '11:00', travelMinutes: 10 },
    { departureAt: '11:00', arrival: '11:25', plannedStart: '11:30', plannedFinish: '12:00', travelMinutes: 25 },
  ], '10:00');
  assert.equal(result.assignments[1].departureAt, '11:00');
  assert.equal(result.assignments[1].arrival, '11:25');
  assert.equal(result.assignments[1].plannedStart, '11:30');
});
