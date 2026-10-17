import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ShiftStore } from '../server/shiftStore.mjs';
import { seedEngineerFeedback } from '../server/engineerFeedbackSeed.mjs';

const [databaseArg, backupArg, reportArg] = process.argv.slice(2);
if (!databaseArg || !backupArg || !reportArg) throw new Error('Usage: node scripts/refresh-feedback-language.mjs <database> <new-backup> <report.json>');
const database = resolve(databaseArg), backup = resolve(backupArg), report = resolve(reportArg);
if (!existsSync(database) || existsSync(backup) || database === backup) throw new Error('Use an existing database and a new, separate backup path.');
await mkdir(dirname(backup), { recursive: true });
await mkdir(dirname(report), { recursive: true });
const store = new ShiftStore(database);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'engineer_feedback' ORDER BY name").all().map(row => row.name);
const fingerprints = () => Object.fromEntries(tables.map(table => {
  const rows = store.db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all();
  return [table, { rows: rows.length, sha256: hash(rows) }];
}));
const replyMetadata = () => store.db.prepare('SELECT * FROM engineer_feedback ORDER BY visit_id,revision').all().map(row => {
  const { comment, commentVersion, ...payload } = JSON.parse(row.payload_json);
  return { ...row, payload_json: payload };
});
try {
  await store.db.backup(backup);
  const before = fingerprints();
  const metadataBefore = hash(replyMetadata());
  const result = seedEngineerFeedback(store.complexity);
  const after = fingerprints();
  const metadataAfter = hash(replyMetadata());
  const unchanged = JSON.stringify(before) === JSON.stringify(after) && metadataBefore === metadataAfter;
  const verification = { database, backup, at: new Date().toISOString(), ...result, unchanged, before, after, replyMetadata: { before: metadataBefore, after: metadataAfter } };
  await writeFile(report, `${JSON.stringify(verification, null, 2)}\n`);
  if (!unchanged) throw new Error(`Data preservation check failed; see ${report}. Backup: ${backup}`);
  console.log(JSON.stringify({ ...result, unchanged, backup, report }));
} finally {
  store.close();
}
