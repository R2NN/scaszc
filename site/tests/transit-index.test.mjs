import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureTransitIndex, selectRailSource } from '../scripts/transit-index.mjs';
import { projectRoot } from '../scripts/project-root.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('existing index is selected only for its own date', async () => {
  const index = await ensureTransitIndex('2026-08-17', repositoryRoot);
  assert.equal(index, path.join(repositoryRoot, 'data', 'transit', 'moscow_2026-08-17.sqlite'));
});

test('invalid dates are rejected before transit source lookup', async () => {
  await assert.rejects(ensureTransitIndex('2026-02-30', repositoryRoot), /Некорректная дата расписания/);
});

test('local site and repository resolve to the same algorithm root', () => {
  assert.equal(projectRoot(path.join(repositoryRoot, 'site')), repositoryRoot);
  assert.equal(projectRoot(repositoryRoot), repositoryRoot);
});

test('weekday railway reference is reused until an exact-date source exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'beego-rail-source-'));
  const base = path.join(root, 'rail');
  const snapshot = async date => {
    const directory = path.join(base, 'dates', date);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      source_date: date, schedule_scope: 'exact_date', coverage_complete: true,
    }));
    await writeFile(path.join(directory, 'rail_schedule.json'), '{}');
    await writeFile(path.join(directory, 'rail_station_map.json'), '{}');
    return directory;
  };
  try {
    const reference = await snapshot('2026-09-25');
    assert.deepEqual(await selectRailSource(base, '', '2026-10-02', root, 'python'), {
      directory: reference, weekdayReference: true,
    });
    const exact = await snapshot('2026-10-02');
    assert.deepEqual(await selectRailSource(base, '', '2026-10-02', root, 'python'), {
      directory: exact, weekdayReference: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
