import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseSharedStockCsv, sharedStockRequirements, stockOverrides } from '../src/sharedInventory.js';

const csv = await readFile(new URL('../data/dataset/core/shared_inventory.csv', import.meta.url), 'utf8');
const defaults = parseSharedStockCsv(csv);

test('planning form shows verified stock and requires values for a new area', () => {
  const rows = sharedStockRequirements([
    { zoneId: 'EAST', equipment: 'Роутер · Диагностический комплект' },
    { zoneId: 'NEW', equipment: 'Гигабитный ONT · Кабель' },
  ], defaults);
  assert.deepEqual(rows.map(({ key, defaultQuantity, required }) => [key, defaultQuantity, required]), [
    ['EAST|ROUTER', 2, false],
    ['NEW|CABLE_PACK', undefined, true],
    ['NEW|ONT_GIGABIT', undefined, true],
  ]);
  assert.deepEqual(stockOverrides(rows, { 'NEW|CABLE_PACK': '0', 'NEW|ONT_GIGABIT': '3' }), [
    { zoneId: 'NEW', equipmentId: 'CABLE_PACK', quantity: 0 },
    { zoneId: 'NEW', equipmentId: 'ONT_GIGABIT', quantity: 3 },
  ]);
});
