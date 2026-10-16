import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';

test('parallel SSR imports do not open or seed a shared operational SQLite file', async () => {
  const directory = await mkdtemp(fileURLToPath(new URL('../../runtime/qa/ssr-db-', import.meta.url)));
  const file = path.join(directory, 'must-not-be-created.sqlite3');
  const original = process.env.BEEGO_DB_PATH;
  process.env.BEEGO_DB_PATH = file;
  const servers = [];
  try {
    const settled = await Promise.allSettled([0, 1].map(() => createServer({ server: { middlewareMode: true, hmr: false } })));
    for (const result of settled) if (result.status === 'fulfilled') servers.push(result.value);
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    await Promise.all(servers.map(server => server.ssrLoadModule('/src/workTypes.js')));
    assert.equal(existsSync(file), false);
  } finally {
    await Promise.all(servers.map(server => server.close()));
    if (original === undefined) delete process.env.BEEGO_DB_PATH;
    else process.env.BEEGO_DB_PATH = original;
    await rm(directory, { recursive: true, force: true });
  }
});
