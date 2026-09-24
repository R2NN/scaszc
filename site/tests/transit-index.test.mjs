import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureTransitIndex } from '../scripts/transit-index.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('existing index is selected only for its own date', async () => {
  const index = await ensureTransitIndex('2026-08-17', repositoryRoot);
  assert.equal(index, path.join(repositoryRoot, 'data', 'transit', 'moscow_2026-08-17.sqlite'));
});

test('invalid dates are rejected before transit source lookup', async () => {
  await assert.rejects(ensureTransitIndex('2026-02-30', repositoryRoot), /Некорректная дата расписания/);
});
