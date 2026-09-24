import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runExactPlan } from '../scripts/exact-plan-runner.mjs';
import { runExactReplan } from '../scripts/exact-replan-runner.mjs';

const repositoryRoot = process.cwd();
const python = process.env.BEEGO_PYTHON || 'python';
const samplePayload = {
  planningDate: '2026-08-17',
  orders: [{ id: 'moscow:JOB-1', sourceId: 'JOB-1', zoneId: 'EAST', start: '10:00', end: '14:00', duration: 60, skill: 'Подключение', coords: [55.700846, 37.7822191], equipment: 'Диагностический комплект · Монтажный комплект' }],
  engineers: [{ id: 'moscow:ENG-1', sourceId: 'ENG-1', zoneId: 'EAST', shiftStart: '08:00', shiftEnd: '18:00', skills: ['Подключение'], transport: 'Автомобиль', startCoords: [55.7022013, 37.7739593], equipment: 'Диагностический комплект · Монтажный комплект' }],
};

test('new UI rows become a strictly loadable checksummed exact dataset', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beego-ui-dataset-'));
  try {
    const dataset = path.join(directory, 'dataset');
    const prepared = spawnSync(python, [path.join(repositoryRoot, 'algorithm', 'tools', 'prepare_ui_dataset.py'), dataset], { cwd: repositoryRoot, env: { ...process.env, PYTHONUTF8: '1' }, input: JSON.stringify(samplePayload), encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stdout || prepared.stderr);
    const verified = spawnSync(python, ['-c', 'from pathlib import Path; from beeline_planning import load_planning_dataset; import sys; data=load_planning_dataset(Path(sys.argv[1]), "core"); print(len(data.jobs), len(data.engineers))', dataset], { cwd: repositoryRoot, env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, 'algorithm', 'src'), PYTHONUTF8: '1' }, encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stdout || verified.stderr);
    assert.match(verified.stdout, /1 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public transit engineers are accepted on a different planning date', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beego-ui-transit-date-'));
  try {
    const payload = {
      ...samplePayload,
      planningDate: '2026-08-16',
      engineers: [{ ...samplePayload.engineers[0], transport: 'PUBLIC_TRANSIT' }],
    };
    const dataset = path.join(directory, 'dataset');
    const prepared = spawnSync(python, [path.join(repositoryRoot, 'algorithm', 'tools', 'prepare_ui_dataset.py'), dataset], { cwd: repositoryRoot, env: { ...process.env, PYTHONUTF8: '1' }, input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stdout || prepared.stderr);
    const manifest = JSON.parse(await readFile(path.join(dataset, 'manifest.json'), 'utf8'));
    assert.equal(manifest.planning_date, '2026-08-16');
    assert.equal(manifest.requires_public_transit, true);
    assert.match(await readFile(path.join(dataset, 'common', 'engineers.csv'), 'utf8'), /PUBLIC_TRANSIT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('UI import preserves four transport requirements and excludes mismatched engineers', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beego-ui-transport-'));
  try {
    const modes = ['CAR', 'PUBLIC_TRANSIT', 'BICYCLE', 'WALKING'];
    const payload = {
      ...samplePayload,
      orders: modes.map((mode, index) => ({
        ...samplePayload.orders[0], id: `JOB-${index}`, sourceId: `JOB-${index}`, transport: mode,
      })),
      engineers: modes.map((mode, index) => ({
        ...samplePayload.engineers[0], id: `ENG-${index}`, sourceId: `ENG-${index}`, transport: mode,
      })),
    };
    const dataset = path.join(directory, 'dataset');
    const prepared = spawnSync(python, [path.join(repositoryRoot, 'algorithm', 'tools', 'prepare_ui_dataset.py'), dataset], { cwd: repositoryRoot, env: { ...process.env, PYTHONUTF8: '1' }, input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stdout || prepared.stderr);
    const code = 'from pathlib import Path; from beeline_planning import load_planning_dataset, build_candidate_index; import json, sys; data=load_planning_dataset(Path(sys.argv[1]), "core"); candidates=build_candidate_index(data); print(json.dumps({job: list(candidates.eligible_engineers_by_job[job]) for job in sorted(data.jobs)}))';
    const checked = spawnSync(python, ['-c', code, dataset], { cwd: repositoryRoot, env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, 'algorithm', 'src'), PYTHONUTF8: '1' }, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stdout || checked.stderr);
    assert.deepEqual(JSON.parse(checked.stdout), Object.fromEntries(modes.map((mode, index) => [`JOB-${index}`, [`ENG-${index}`]])));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('UI dataset preserves priority aliases for the planner', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beego-ui-priority-'));
  try {
    const aliases = ['NORMAL', 'HIGH', 'URGENT', 'EMERGENCY', 'Срочная', 'Высокий', 'Авария'];
    const payload = {
      ...samplePayload,
      orders: [
        ...aliases.map((priority, index) => ({
          ...samplePayload.orders[0], id: `JOB-${index}`, sourceId: `JOB-${index}`, priority,
        })),
        { ...samplePayload.orders[0], id: 'JOB-source', sourceId: 'JOB-source', sourceData: { priority: 'HIGH' } },
      ],
    };
    const dataset = path.join(directory, 'dataset');
    const prepared = spawnSync(python, [path.join(repositoryRoot, 'algorithm', 'tools', 'prepare_ui_dataset.py'), dataset], { cwd: repositoryRoot, env: { ...process.env, PYTHONUTF8: '1' }, input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stdout || prepared.stderr);
    const csv = await readFile(path.join(dataset, 'core', 'jobs.csv'), 'utf8');
    const lines = csv.trim().split(/\r?\n/);
    const columns = lines[0].split(';');
    const priorityColumn = columns.indexOf('priority');
    assert.notEqual(priorityColumn, -1);
    assert.deepEqual(lines.slice(1).map(line => line.split(';')[priorityColumn]), [
      'NORMAL', 'URGENT', 'URGENT', 'URGENT', 'URGENT', 'URGENT', 'URGENT', 'URGENT',
    ]);
    const invalid = spawnSync(python, [path.join(repositoryRoot, 'algorithm', 'tools', 'prepare_ui_dataset.py'), path.join(directory, 'invalid')], { cwd: repositoryRoot, env: { ...process.env, PYTHONUTF8: '1' }, input: JSON.stringify({ ...samplePayload, orders: [{ ...samplePayload.orders[0], priority: 'UNKNOWN' }] }), encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout, /Неизвестный приоритет заявки/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('new area uses explicitly entered shared stock, including zero', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beego-ui-stock-'));
  try {
    const dataset = path.join(directory, 'dataset');
    const payload = {
      ...samplePayload,
      orders: [{ ...samplePayload.orders[0], zoneId: 'NEW', equipment: 'ROUTER', sourceData: { required_equipment: 'CABLE_PACK', required_skill: 'LOCAL' } }],
      engineers: [{ ...samplePayload.engineers[0], zoneId: 'NEW', sourceData: { transport_type: 'WALKING', equipment: 'CABLE_SET' } }],
      sharedInventory: [{ zoneId: 'NEW', equipmentId: 'ROUTER', quantity: 0 }],
    };
    const prepared = spawnSync(python, [path.join(repositoryRoot, 'algorithm', 'tools', 'prepare_ui_dataset.py'), dataset], { cwd: repositoryRoot, env: { ...process.env, PYTHONUTF8: '1' }, input: JSON.stringify(payload), encoding: 'utf8' });
    assert.equal(prepared.status, 0, prepared.stdout || prepared.stderr);
    assert.match(await readFile(path.join(dataset, 'core', 'shared_inventory.csv'), 'utf8'), /NEW;ROUTER;0;/);
    assert.match(await readFile(path.join(dataset, 'core', 'jobs.csv'), 'utf8'), /;INSTALL;ANY;ROUTER;/);
    assert.match(await readFile(path.join(dataset, 'common', 'engineers.csv'), 'utf8'), /;CAR;true;/);
    const invalid = spawnSync(python, [path.join(repositoryRoot, 'algorithm', 'tools', 'prepare_ui_dataset.py'), path.join(directory, 'invalid')], { cwd: repositoryRoot, env: { ...process.env, PYTHONUTF8: '1' }, input: JSON.stringify({ ...payload, sharedInventory: [{ zoneId: 'NEW', equipmentId: 'ROUTER', quantity: -1 }] }), encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout, /целым неотрицательным числом/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('new dataset reaches independently validated exact plan', { skip: process.env.BEEGO_TEST_FULL_PIPELINE !== '1', timeout: 300000 }, async () => {
  const plan = await runExactPlan(samplePayload, repositoryRoot);
  assert.equal(plan.status, 'EXACT_VALID');
  assert.equal(plan.validation.status, 'VALID');
  assert.equal(plan.metrics.assigned, 1);
  assert.equal(plan.routes.find(route => route.engineerId === 'moscow:ENG-1')?.assignments[0]?.orderId, 'moscow:JOB-1');
  const reassigned = await runExactReplan({
    orders: samplePayload.orders,
    team: samplePayload.engineers,
    basePlanContentSha256: plan.contentSha256,
    event: { type: 'FORCED_ASSIGNMENT', time: '07:00', orderId: 'moscow:JOB-1', engineerId: 'moscow:ENG-1' },
  }, repositoryRoot);
  assert.equal(reassigned.validation.status, 'VALID');
  assert.equal(reassigned.routes.find(route => route.engineerId === 'moscow:ENG-1')?.assignments[0]?.orderId, 'moscow:JOB-1');
});

test('surface-only dataset can use a new date without a transit timetable', { skip: process.env.BEEGO_TEST_FULL_PIPELINE !== '1', timeout: 300000 }, async () => {
  const plan = await runExactPlan({ ...samplePayload, planningDate: '2026-09-22' }, repositoryRoot);
  assert.equal(plan.validation.status, 'VALID');
  assert.equal(plan.metrics.assigned, 1);
});

test('new area inventory reaches the independently validated planner', { skip: process.env.BEEGO_TEST_FULL_PIPELINE !== '1', timeout: 300000 }, async () => {
  const plan = await runExactPlan({
    ...samplePayload,
    orders: [{ ...samplePayload.orders[0], zoneId: 'NEW', equipment: 'ROUTER' }],
    engineers: [{ ...samplePayload.engineers[0], zoneId: 'NEW' }],
    sharedInventory: [{ zoneId: 'NEW', equipmentId: 'ROUTER', quantity: 1 }],
  }, repositoryRoot);
  assert.equal(plan.status, 'EXACT_VALID');
  assert.equal(plan.validation.status, 'VALID');
  assert.equal(plan.metrics.assigned, 1);
});
