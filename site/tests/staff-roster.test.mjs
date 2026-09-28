import test from 'node:test';
import assert from 'node:assert/strict';
import { staffActiveOn, staffAvailableForShift } from '../src/staffRoster.js';

test('effective-dated roster membership preserves archived gaps and shift snapshots', () => {
  const member = { id: 'crew-1', rosterPeriods: [{ from: '2026-08-17', to: '2026-08-19' }, { from: '2026-08-21', to: null }] };
  assert.equal(staffActiveOn(member, '2026-08-16'), false);
  assert.equal(staffActiveOn(member, '2026-08-17'), true);
  assert.equal(staffActiveOn(member, '2026-08-19'), false);
  assert.equal(staffActiveOn(member, '2026-08-21'), true);
  assert.equal(staffAvailableForShift([member], { team: [{ id: 'crew-1' }] }, '2026-08-21').length, 0);
  assert.equal(staffAvailableForShift([member], { team: [] }, '2026-08-21').length, 1);
});
