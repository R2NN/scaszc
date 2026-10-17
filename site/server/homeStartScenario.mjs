import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { compactExactReplan } from '../scripts/exact-replan-runner.mjs';
import { projectRoot } from '../scripts/project-root.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const cache = new Map();
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value;

/** Identify the exact original day; custom imports and changed durations keep their own plan. */
export function homeScenarioSourceKey(day, first) {
  return sha(JSON.stringify(stable({date:day,plan:first.plan.contentSha256,
    orders:first.orders,team:first.team,
  })));
}

/** Load a verified home-start seed only for a fresh, matching scenario session. */
export function homeStartScenario(base, { root = projectRoot() } = {}) {
  const first = base.versions[0];
  const folder = path.join(root,'algorithm','artifacts','tz3','home-starts');
  const manifestPath = path.join(folder,'manifest.json');
  if (!existsSync(manifestPath)) return first;
  const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
  if (manifest.date !== base.date || manifest.sourceKey !== homeScenarioSourceKey(base.date,first)) return first;
  const cacheKey = `${manifest.rawFileSha256}:${manifest.inputFileSha256}`;
  let bundle = cache.get(cacheKey);
  if (!bundle) {
    const rawBytes = gunzipSync(readFileSync(path.join(folder,'initial-exact.json.gz')));
    const inputBytes = gunzipSync(readFileSync(path.join(folder,'input.json.gz')));
    if (sha(rawBytes) !== manifest.rawFileSha256 || sha(inputBytes) !== manifest.inputFileSha256) throw new Error('Контрольная сумма сценария домашнего старта не совпала');
    const raw = JSON.parse(rawBytes), input = JSON.parse(inputBytes);
    if (raw.dataset_sha256 !== manifest.datasetSha256 || raw.content_sha256 !== manifest.contentSha256) throw new Error('План домашнего старта относится к другим данным');
    const plan = compactExactReplan(raw,{...input,team:input.engineers});
    bundle = {rawBytes,orders:input.orders,team:input.engineers,plan};
    cache.set(cacheKey,bundle);
  }
  const retained = path.join(root,'runtime','exact-replans',`${manifest.contentSha256}.json`);
  mkdirSync(path.dirname(retained),{recursive:true});
  if (!existsSync(retained)) writeFileSync(retained,bundle.rawBytes);
  writeFileSync(`${retained}.meta.json`,JSON.stringify({dataset:'algorithm/artifacts/tz3/home-starts/dataset',
    cache:'runtime/ui-shared-cache/routing-cache.sqlite3',transitIndex:'data/transit/moscow_2026-08-17.sqlite'}));
  return {orders:bundle.orders,team:bundle.team,plan:bundle.plan};
}
