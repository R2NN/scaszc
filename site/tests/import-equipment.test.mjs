import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { importedEquipmentRequirements, importedEquipmentTokens } from '../src/importEquipment.js';
import { historicalInventory } from '../server/exactShiftReplan.mjs';
import { notificationPresentation } from '../src/notificationPresentation.js';

test('equipment import keeps all source codes and does not invent a replacement', () => {
  assert.equal(importedEquipmentRequirements('DIAG_SET|INSTALL_SET|CABLE_PACK'), 'DIAG_SET|INSTALL_SET|CABLE_PACK');
  assert.deepEqual(importedEquipmentTokens('DIAG_SET; INSTALL_SET; CABLE_PACK'), ['DIAG_SET', 'INSTALL_SET', 'CABLE_PACK']);
  assert.equal(importedEquipmentRequirements('ANY'), '');
  assert.equal(importedEquipmentRequirements('Аварийный комплект'), 'DIAG_SET');
  assert.equal(importedEquipmentRequirements('Неизвестный прибор'), 'Неизвестный прибор');
});

test('an equipment validation error does not become an emergency-plan notification', () => {
  const presented = notificationPresentation({
    title: 'Планирование не выполнено',
    message: 'Неизвестное оборудование: Аварийный комплект',
  });
  assert.deepEqual(presented, { kind: 'alert', title: 'Планирование не выполнено' });
});

test('a retained day supplies its recorded shared stock to a new calculation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'beego-inventory-'));
  try {
    const dataset = path.join(root, 'history', '2026-08-16', 'dataset');
    await mkdir(path.join(dataset, 'core'), { recursive: true });
    await writeFile(path.join(dataset, 'manifest.json'), JSON.stringify({ planning_date: '2026-08-16' }));
    await writeFile(path.join(dataset, 'core', 'shared_inventory.csv'),
      'scenario;zone_id;equipment_id;quantity_available\nCORE;EAST;CABLE_PACK;38\n');
    const inventory = await historicalInventory('2026-08-16', root);
    assert.deepEqual(inventory, [{ zoneId: 'EAST', equipmentId: 'CABLE_PACK', quantity: 38 }]);
    assert.deepEqual(await historicalInventory('2099-01-01', root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reviewed orders and engineers retain every equipment requirement', async () => {
  const vite = await createServer({
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const { buildOrders, buildEngineers } = await vite.ssrLoadModule('/src/ImportWorkspace.jsx');
    const region = { id: 'moscow', name: 'Москва' };
    const order = buildOrders(
      ['job_id', 'required_equipment'],
      [['12345', 'DIAG_SET|INSTALL_SET|CABLE_PACK']],
      { 0: 'id', 1: 'equipment' }, region,
    )[0];
    const engineer = buildEngineers(
      ['engineer_id', 'equipment'],
      [['E-1', 'DIAG_SET|INSTALL_SET|CABLE_PACK']],
      { 0: 'engineerId', 1: 'engineerEquipment' }, region,
    )[0];
    assert.equal(order.equipment, 'DIAG_SET|INSTALL_SET|CABLE_PACK');
    assert.deepEqual(engineer.equipment, ['DIAG_SET', 'INSTALL_SET', 'CABLE_PACK']);

    const fixture = JSON.parse(await readFile(new URL('../public/test-data/beego-algorithm-initial.json', import.meta.url), 'utf8'));
    const importedOrders = buildOrders(
      ['job_id', 'required_equipment'],
      fixture.jobs.map(job => [job.job_id, job.required_equipment]),
      { 0: 'id', 1: 'equipment' }, region,
    );
    const importedEngineers = buildEngineers(
      ['engineer_id', 'equipment'],
      fixture.engineers.map(item => [item.engineer_id, item.equipment]),
      { 0: 'engineerId', 1: 'engineerEquipment' }, region,
    );
    assert.equal(importedOrders.length, 205);
    assert.ok(importedOrders.every((item, index) => item.equipment === fixture.jobs[index].required_equipment));
    assert.ok(importedEngineers.every((item, index) => item.equipment.join('|')
      === fixture.engineers[index].equipment.split('|').map(code => code.trim()).join('|')));
  } finally {
    await vite.close();
  }
});
