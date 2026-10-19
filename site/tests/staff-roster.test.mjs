import test from 'node:test';
import assert from 'node:assert/strict';
import { staffActiveOn, staffAvailableForShift, staffIdleInShift, staffForDate } from '../src/staffRoster.js';

test('a day-specific home start never leaks into the following planning day', () => {
  const member = { id: 'crew', startCoords: [55.7, 37.7], startAddress: 'Home',
    officeStart: { coords: [55.6, 37.6], address: 'Registered office' },
    startPoint: { kind: 'home', date: '2026-08-17', confirmed: true, coords: [55.7, 37.7] } };
  assert.equal(staffForDate(member, '2026-08-17'), member);
  const next = staffForDate(member, '2026-08-18');
  assert.equal(next.startPoint, undefined);
  assert.deepEqual(next.startCoords, member.officeStart.coords);
  assert.equal(next.startAddress, 'Registered office');
  assert.ok(member.startPoint, 'the original shift snapshot remains intact');
  const withoutOffice = { ...member, officeStart: undefined };
  assert.equal(staffForDate(withoutOffice, '2026-08-18'), withoutOffice, 'missing office still requires confirmation');
});

test('effective-dated roster membership preserves archived gaps and shift snapshots', () => {
  const member = { id: 'crew-1', rosterPeriods: [{ from: '2026-08-17', to: '2026-08-19' }, { from: '2026-08-21', to: null }] };
  assert.equal(staffActiveOn(member, '2026-08-16'), false);
  assert.equal(staffActiveOn(member, '2026-08-17'), true);
  assert.equal(staffActiveOn(member, '2026-08-19'), false);
  assert.equal(staffActiveOn(member, '2026-08-21'), true);
  assert.equal(staffAvailableForShift([member], { team: [{ id: 'crew-1' }] }, '2026-08-21').length, 0);
  assert.equal(staffAvailableForShift([member], { team: [] }, '2026-08-21').length, 1);
});

test('idle engineers already in the shift remain selectable for manual assignment', () => {
  const roster = ['idle', 'busy', 'absent', 'outside'].map(id => ({ id, rosterPeriods: [{ from: '2026-08-17', to: null }] }));
  const shift = {
    team: [{ id: 'idle', status: 'Доступен' }, { id: 'busy', status: 'Доступен' }, { id: 'absent', status: 'Недоступен' }],
    plan: { routes: [{ engineerId: 'idle', assignments: [] }, { engineerId: 'busy', assignments: [{ orderId: 'order-1' }] }] },
  };
  assert.deepEqual(staffIdleInShift(roster, shift, '2026-08-18').map(member => member.id), ['idle']);
  assert.deepEqual(staffAvailableForShift(roster, shift, '2026-08-18').map(member => member.id), ['outside']);
});
