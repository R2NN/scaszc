import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ShiftStore } from '../server/shiftStore.mjs';
import { seedComplexity } from '../server/complexitySeed.mjs';
import { canonicalDemoInput } from '../src/canonicalDemo.js';

const root = path.resolve(import.meta.dirname, '../..');
const destination = path.resolve(process.argv[2] || path.join(root, 'runtime/candidate'));
const seed = Number(process.argv[3] || 17082026);
const anchor = process.argv[4] || '2026-08-17';
await mkdir(destination, { recursive: true });
const store = new ShiftStore(path.join(destination, 'generator.sqlite3'));
await seedComplexity(store.complexity, { seed, anchor });
const fixture = JSON.parse(await readFile(path.join(root, 'site/public/test-data/beego-algorithm-initial.json'), 'utf8'));
const allFixture = JSON.parse(await readFile(path.join(root, 'site/public/test-data/beego-algorithm-integration.json'), 'utf8'));
const artifact = JSON.parse(await readFile(path.join(root, 'site/public/data/beego-exact-plans.json'), 'utf8'));
const anchorInput = value => JSON.parse(JSON.stringify(value).replaceAll('2026-08-17', anchor));
const input = anchorInput(canonicalDemoInput(fixture, artifact));
const all = anchorInput(canonicalDemoInput(allFixture, artifact));
input.orders = store.complexity.prepareOrders(input.orders, `${anchor}T07:00:00+03:00`);
const allOrders = store.complexity.prepareOrders(all.orders, `${anchor}T07:00:00+03:00`);
await writeFile(path.join(destination, 'input.json'), JSON.stringify(input));
const dataset = path.join(destination, 'dataset');
await cp(path.join(root, 'data/dataset'), dataset, { recursive: true });
if (anchor !== '2026-08-17') {
  const shiftDates = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await shiftDates(file);
      else if (/\.(csv|json)$/.test(entry.name)) await writeFile(file, (await readFile(file, 'utf8')).replaceAll('2026-08-17', anchor));
    }
  };
  await shiftDates(dataset);
}
const byId = new Map(allOrders.map(order => [order.id, order]));
for (const scenario of ['core', 'stress']) {
  const target = path.join(dataset, scenario, 'jobs.csv');
  const rows = (await readFile(target, 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const columns = rows[0].split(';');
  const index = columns.indexOf('service_duration_min');
  const idIndex = columns.indexOf('job_id');
  for (let row = 1; row < rows.length; row++) {
    const values = rows[row].split(';');
    let order = byId.get(values[idIndex]);
    if (!order) {
      const source = Object.fromEntries(columns.map((column, at) => [column, values[at]]));
      const template = allOrders.find(item => item.sourceData?.location_id === source.location_id);
      order = store.complexity.prepareOrders([{ ...template, id: source.job_id, sourceId: source.job_id, workType: source.bk_type, serviceType: source.hd_type, sourceData: { ...template?.sourceData, ...source }, durationSnapshot: undefined }], `${anchor}T07:00:00+03:00`)[0];
      byId.set(order.id, order);
    }
    if (order) values[index] = String(order.duration);
    rows[row] = values.join(';');
  }
  await writeFile(target, `${rows.join('\n')}\n`);
  const jsonTarget = path.join(dataset, scenario, 'dataset.json');
  const scenarioJson = JSON.parse(await readFile(jsonTarget, 'utf8'));
  scenarioJson.jobs = scenarioJson.jobs.map(job => ({ ...job, service_duration_min: byId.get(job.job_id)?.duration ?? job.service_duration_min }));
  await writeFile(jsonTarget, JSON.stringify(scenarioJson, null, 2));
}
await writeFile(path.join(dataset, 'common/duration_snapshots.json'), JSON.stringify(Object.fromEntries([...byId.values()].map(order => [order.id, order.durationSnapshot]))));
const manifestFile = path.join(dataset, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
await writeFile(manifestFile, JSON.stringify({ ...manifest, duration_contract: 'server-snapshot-v1', duration_model: store.complexity.model().version }, null, 2));
await writeFile(path.join(dataset, 'validation_report.json'), JSON.stringify({ status: 'PREPARED_NOT_FULLY_VALIDATED', scope: 'Generated duration snapshots and matching CSV/JSON. Validate with the authoritative loader; exact plan validation is retained separately.', originalReport: 'data/dataset/validation_report.json', modelVersion: store.complexity.model().version, seed, anchor }, null, 2));
await writeFile(path.join(dataset, 'validate_dataset.py'), `from pathlib import Path
import argparse
import json
import sys

parser = argparse.ArgumentParser(description='Validate authoritative duration snapshots and dataset constraints')
parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
parser.add_argument('--write-reports', action='store_true', help='Accepted for compatibility; this validator does not mutate checksummed input')
args = parser.parse_args()
repository = next(parent for parent in Path(__file__).resolve().parents if (parent / 'algorithm' / 'src').is_dir())
sys.path.insert(0, str(repository / 'algorithm' / 'src'))
from beeline_planning import load_planning_dataset
results = []
for scenario in ('core', 'stress'):
    data = load_planning_dataset(args.root, scenario)
    results.append({'scenario': scenario, 'jobs': len(data.jobs), 'dataset_sha256': data.dataset_sha256, 'status': 'VALID'})
print(json.dumps({'status': 'VALID', 'results': results}))
`);
const files = [];
const walk = async directory => { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.name !== 'CHECKSUMS.sha256') files.push(file); } };
await walk(dataset);
const checksums = [];
for (const file of files.sort()) checksums.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${path.relative(dataset, file).replaceAll('\\', '/')}`);
await writeFile(path.join(dataset, 'CHECKSUMS.sha256'), `${checksums.join('\n')}\n`);
const quality = store.complexity.accuracy(`${anchor}T07:00:00+03:00`);
await writeFile(path.join(destination, 'quality.json'), JSON.stringify({ seed, anchor, ...quality }, null, 2));
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ generator: 'complexity-v1', seed, anchor, sourceMain: '02d4811a93a1e17d6a45364a8a705e0f93fc6053', originalIdsPreserved: true, originalCoordinatesPreserved: true, objects: store.complexity.objects().length, visits: store.complexity.visits().length, stages: 'Independent simulation, hidden operation speeds and persistent conditions; not forecast plus noise', limits: 'Synthetic inventory, entrance/node positions not geocoded. Sample visits do not constitute full measured shifts.' }, null, 2));
store.close();
process.stdout.write(`${JSON.stringify({ destination, dataset, mae: quality.mae, fixedMae: quality.fixedMae })}\n`);
