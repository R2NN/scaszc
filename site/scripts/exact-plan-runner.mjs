import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { compactExactReplan } from './exact-replan-runner.mjs';

const run = (python, args, input, repositoryRoot) => new Promise((resolve, reject) => {
  const child = spawn(python, args, {
    cwd: repositoryRoot,
    env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, 'algorithm', 'src'), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-20000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
  child.on('error', reject);
  child.on('close', code => {
    const last = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    let result;
    try { result = JSON.parse(last); } catch { /* pipeline may exit before JSON summary */ }
    if (code === 0) resolve(result || {});
    else reject(new Error(result?.error || stderr.trim() || stdout.trim() || `Exact pipeline exited with code ${code}`));
  });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
});

/** Build and independently validate a new plan with the complete exact pipeline. */
export async function runExactPlan(payload, repositoryRoot = process.cwd()) {
  const runRoot = path.join(repositoryRoot, 'runtime', 'ui-runs', randomUUID());
  const dataset = path.join(runRoot, 'dataset');
  const results = path.join(runRoot, 'results');
  await mkdir(runRoot, { recursive: true });
  const python = process.env.BEEGO_PYTHON || 'python';
  await run(python, [path.join(repositoryRoot, 'algorithm', 'tools', 'prepare_ui_dataset.py'), dataset], payload, repositoryRoot);
  const pipeline = await run(python, [
    path.join(repositoryRoot, 'algorithm', 'tools', 'run_new_dataset_pipeline.py'),
    '--dataset', dataset,
    '--scenario', 'core',
    '--run-dir', results,
    '--transit-index', path.join(repositoryRoot, 'data', 'transit', 'moscow_2026-08-17.sqlite'),
    '--shared-cache-dir', path.join(repositoryRoot, 'runtime', 'ui-shared-cache'),
    '--execute',
  ], undefined, repositoryRoot);
  if (pipeline.status !== 'COMPLETE' || !pipeline.final_plan) throw new Error('Новый точный план не прошёл проверку');
  const raw = JSON.parse(await readFile(pipeline.final_plan, 'utf8'));
  return compactExactReplan(raw, { ...payload, team: payload.engineers });
}
