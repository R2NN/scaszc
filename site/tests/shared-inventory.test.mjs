import assert from 'node:assert/strict';
import test from 'node:test';
import { sharedStockRequirements, stockOverrides } from '../src/sharedInventory.js';

test('planning form requires actual stock for known and new areas', () => {
  const rows = sharedStockRequirements([
    { zoneId: 'EAST', equipment: 'Роутер · Диагностический комплект' },
    { zoneId: 'NEW', equipment: 'Гигабитный ONT · Кабель' },
  ]);
  assert.deepEqual(rows.map(({ key }) => key), [
    'EAST|ROUTER',
    'NEW|CABLE_PACK',
    'NEW|ONT_GIGABIT',
  ]);
  assert.deepEqual(stockOverrides(rows, { 'EAST|ROUTER': '2', 'NEW|CABLE_PACK': '0', 'NEW|ONT_GIGABIT': '3' }), [
    { zoneId: 'EAST', equipmentId: 'ROUTER', quantity: 2 },
    { zoneId: 'NEW', equipmentId: 'CABLE_PACK', quantity: 0 },
    { zoneId: 'NEW', equipmentId: 'ONT_GIGABIT', quantity: 3 },
  ]);
});
