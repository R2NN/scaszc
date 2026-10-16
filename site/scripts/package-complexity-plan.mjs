import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compactExactReplan } from './exact-replan-runner.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const [inputFile, planFile, outputFile] = process.argv.slice(2);
if (!inputFile || !planFile) throw new Error('Usage: node scripts/package-complexity-plan.mjs input.json validated-exact.json [output.json]');
const input = JSON.parse(await readFile(path.resolve(inputFile), 'utf8'));
const raw = JSON.parse(await readFile(path.resolve(planFile), 'utf8'));
const plan = compactExactReplan(raw, { orders: input.orders, team: input.engineers });
const provenance = JSON.parse(await readFile(path.join(root, 'data/object-complexity/manifest.json'), 'utf8'));
await writeFile(path.resolve(outputFile || path.join(root, 'site/public/data/beego-complexity-plan.json')), JSON.stringify({ ...input, plan, provenance }));
process.stdout.write(`${JSON.stringify(plan.metrics)}\n`);
