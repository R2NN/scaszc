import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ShiftStore } from '../server/shiftStore.mjs';

const destination = resolve(process.argv[2] || `.beego-backups/shifts-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite3`);
mkdirSync(resolve(destination, '..'), { recursive: true });
const store = new ShiftStore();
try {
  await store.backup(destination);
  process.stdout.write(`Резервная копия создана: ${destination}\n`);
} finally { store.close(); }
