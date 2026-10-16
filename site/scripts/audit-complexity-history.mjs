import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { seedComplexity } from '../server/complexitySeed.mjs';
import { canonicalDemoInput } from '../src/canonicalDemo.js';

const root = path.resolve(import.meta.dirname, '../..');
const destination = path.resolve(process.argv[2] || path.join(root, 'runtime/qa/review-fixes'));
const fixture = JSON.parse(await readFile(path.join(root, 'site/public/test-data/beego-algorithm-initial.json'), 'utf8'));
const base = JSON.parse(await readFile(path.join(root, 'site/public/data/beego-exact-plans.json'), 'utf8'));
const input = canonicalDemoInput(fixture, base);
const csv = async file => (await readFile(path.join(root, file), 'utf8')).trim().split(/\r?\n/).map(row => row.split(';'));
const skills = new Map((await csv('data/dataset/common/skill_mapping.csv')).slice(1));
const inventory = (await csv('data/dataset/core/shared_inventory.csv')).slice(1);
const shared = new Set(inventory.map(row => row[3]));
const stockLimits = new Map(inventory.map(row => [`${row[1]}/${row[3]}`, Number(row[4])]));
const at = '2026-08-17T07:00:00+03:00';
const reports = [];
for (const seed of [27082026, 17082026, 42]) {
  const store = new ShiftStore(':memory:');
  try {
    await seedComplexity(store.complexity, { seed });
    const visits = store.complexity.visits(at);
    const evidenceAt = new Map();
    const ends = new Map(), stocks = new Map(), operations = new Map(), kinds = new Map();
    for (const visit of [...visits].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))) {
      const engineer = input.engineers.find(item => item.id === visit.engineerId);
      const object = store.complexity.object(visit.entities.object);
      const required = skills.get(visit.workType);
      assert.ok(required && engineer.skills.includes(required), `Qualification: ${visit.id}`);
      assert.equal(engineer.zoneId, object.zoneId);
      assert.ok(!visit.requiredTransport || visit.requiredTransport === 'ANY' || visit.requiredTransport === engineer.transport);
      for (const item of visit.requiredEquipment) if (!shared.has(item)) assert.ok(engineer.equipment.includes(item));
      for (const item of visit.requiredEquipment.filter(item => shared.has(item))) {
        const key = `${visit.endedAt.slice(0, 10)}/${object.zoneId}/${item}`;
        stocks.set(key, (stocks.get(key) || 0) + 1);
        assert.ok(stocks.get(key) <= stockLimits.get(`${object.zoneId}/${item}`), `Stock: ${key}`);
      }
      assert.ok(visit.forecast.asOf < visit.endedAt);
      for (const history of visit.forecast.histories) for (const evidence of history.evidence) {
        if (!evidenceAt.has(visit.forecast.asOf)) evidenceAt.set(visit.forecast.asOf, new Map(store.complexity.visits(visit.forecast.asOf).map(item => [item.id, item])));
        const row = evidenceAt.get(visit.forecast.asOf).get(evidence.id);
        assert.ok(row && row.endedAt <= visit.forecast.asOf && row.knownAt <= visit.forecast.asOf);
      }
      if (visit.startedAt) {
        const start = visit.startedAt.slice(11, 16), finish = visit.endedAt.slice(11, 16);
        assert.ok(start >= engineer.shiftStart && finish <= engineer.shiftEnd);
        const key = `${visit.engineerId}/${visit.startedAt.slice(0, 10)}`;
        assert.ok(!ends.has(key) || ends.get(key) <= visit.startedAt, `Overlap: ${visit.id}`);
        ends.set(key, visit.endedAt);
      }
      const own = operations.get(object.id) || new Set(); own.add(visit.operation); operations.set(object.id, own);
      const ownKinds = kinds.get(object.id) || new Set(); ownKinds.add(visit.kind); kinds.set(object.id, ownKinds);
    }
    const accuracy = store.complexity.accuracy(at);
    assert.ok(accuracy.mae < accuracy.fixedMae);
    const report = { seed, visits: visits.length, badQualifications: 0, overlaps: 0, stockViolations: 0, futureEvidence: 0, objectsWithMultipleOperations: [...operations.values()].filter(set => set.size > 1).length, objectsWithMultipleKinds: [...kinds.values()].filter(set => set.size > 1).length, operationConditions: store.complexity.conditions().filter(item => item.scope === 'operation').length, excluded: visits.filter(item => item.excluded).length, partial: visits.filter(item => !item.eligible).length, corrected: visits.filter(item => item.revision > 1).length, holdout: accuracy.count, mae: accuracy.mae, fixedMae: accuracy.fixedMae, byKind: accuracy.byKind };
    assert.ok(report.objectsWithMultipleKinds > 100);
    assert.ok(report.operationConditions > 0);
    reports.push(report);
  } finally { store.close(); }
}
await mkdir(destination, { recursive: true });
await writeFile(path.join(destination, 'history-audit.json'), JSON.stringify(reports, null, 2));
process.stdout.write(`${JSON.stringify(reports.map(({ byKind, ...report }) => report))}\n`);
