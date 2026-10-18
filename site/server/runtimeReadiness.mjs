import { access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectRoot } from '../scripts/project-root.mjs';

const exists = file => access(file).then(() => true, () => false);
const pythonReady = python => new Promise(resolve => {
  const child = spawn(python, ['-c', 'import sys; assert sys.version_info >= (3, 12); import aiohttp, ortools, pandas; print("READY")'], { windowsHide:true, stdio:['ignore','pipe','ignore'] });
  let output = '', done = false;
  const finish = value => { if (!done) {done=true;clearTimeout(timer);resolve(value);} };
  const timer = setTimeout(() => {child.kill();finish(false);}, 10000);
  child.stdout.on('data', chunk => {output += chunk;});
  child.on('error', () => finish(false)); child.on('close', code => finish(code === 0 && output.includes('READY')));
});

/** Distinguish an available UI from a fully configured exact planner. No secrets or writes. */
export async function planningRuntimeStatus({root=projectRoot(),env=process.env} = {}) {
  const indexDirectory = env.BEEGO_TRANSIT_INDEX_DIR || path.join(root,'data/transit');
  const python = env.BEEGO_PYTHON || 'python';
  const endpoint = String(env.VALHALLA_ROUTE_ENDPOINT || 'http://127.0.0.1:8002/route').replace(/\/route\/?$/, '');
  const [interpreter,index,roads] = await Promise.all([
    pythonReady(python),
    Promise.all(['.sqlite','.manifest.json','.surface_walk_transfers.json','.walk_transfers.json'].map(suffix => exists(path.join(indexDirectory,'moscow_2026-08-17'+suffix)))).then(items=>items.every(Boolean)),
    fetch(endpoint+'/status',{signal:AbortSignal.timeout(3000)}).then(async response=>{const status=await response.json();return Boolean(response.ok && typeof status.version === 'string' && status.available_actions?.includes('route'));}).catch(()=>false),
  ]);
  const checks={python:interpreter,canonicalTransitIndex:index,valhalla:roads};
  return {ready:Object.values(checks).every(Boolean),checks,missing:Object.entries(checks).filter(([,value])=>!value).map(([name])=>name),setupCommand:'docker compose -f compose.complete.yaml up --build -d',note:'Открытый сайт не означает готовность точного аварийного расчёта. Ключи AI и геокодирования для аварийного сценария не требуются.'};
}
