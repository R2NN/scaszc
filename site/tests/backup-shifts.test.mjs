import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('online backup includes WAL data without changing running previews or schema', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'beego-backup-'));
  const source = join(folder, 'source.sqlite3'), target = join(folder, 'copy.sqlite3');
  const db = new Database(source);
  try {
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE replan_previews(id TEXT,status TEXT); INSERT INTO replan_previews VALUES ('active','RUNNING')");
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/backup-shifts.mjs', import.meta.url)), target], {
      env: { ...process.env, BEEGO_DB_PATH: source }, windowsHide: true,
    });
    assert.equal(db.prepare('SELECT status FROM replan_previews').get().status, 'RUNNING');
    const copy = new Database(target, { readonly: true });
    try {
      assert.equal(copy.prepare('SELECT status FROM replan_previews').get().status, 'RUNNING');
      assert.equal(copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 1);
    } finally { copy.close(); }
  } finally { db.close(); await rm(folder, { recursive: true, force: true }); }
});
