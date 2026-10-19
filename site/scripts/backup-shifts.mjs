import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';

const destination = resolve(process.argv[2] || `.beego-backups/shifts-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite3`);
mkdirSync(resolve(destination, '..'), { recursive: true });
// A backup must never run startup migrations or invalidate an active calculation.
const store = new Database(resolve(process.env.BEEGO_DB_PATH || '.beego-data/shifts.sqlite3'), { readonly: true, fileMustExist: true });
try {
  await store.backup(destination);
  process.stdout.write(`Резервная копия создана: ${destination}\n`);
} finally { store.close(); }
