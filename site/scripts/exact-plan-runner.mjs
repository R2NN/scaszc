import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { compactExactReplan } from './exact-replan-runner.mjs';
import { ensureTransitIndex } from './transit-index.mjs';
import { projectRoot } from './project-root.mjs';
import { PLANNING_DEADLINE_MS, remainingMilliseconds, stopProcessTree } from './process-deadline.mjs';

const run = (python, args, input, repositoryRoot, deadlineAt) => new Promise((resolve, reject) => {
  const timeoutMs = remainingMilliseconds(deadlineAt);
  const child = spawn(python, args, {
    cwd: repositoryRoot,
    env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, 'algorithm', 'src'), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopProcessTree(child); }, timeoutMs);
  timer.unref();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-20000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => {
    clearTimeout(timer);
    if (timedOut) {
      reject(new Error('Расчёт остановлен после 15 минут: проверенный план не получен'));
      return;
    }
    const last = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    let result;
    try { result = JSON.parse(last); } catch { /* pipeline may exit before JSON summary */ }
    if (code === 0) resolve(result || {});
    else {
      const error = new Error(result?.error || stderr.trim() || stdout.trim() || `Exact pipeline exited with code ${code}`);
      if (result?.code === 'INVALID_INPUT') {
        error.code = 'INVALID_INPUT';
        error.details = Array.isArray(result.details) ? result.details : [];
      }
      reject(error);
    }
  });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
});

/** Build and independently validate a new plan with the complete exact pipeline. */
export async function runExactPlan(payload, repositoryRoot = process.cwd(), onProgress = () => {}) {
  const deadlineAt = Date.now() + PLANNING_DEADLINE_MS;
  repositoryRoot = projectRoot(repositoryRoot);
  const runRoot = path.join(repositoryRoot, 'runtime', 'ui-runs', randomUUID());
  const dataset = path.join(runRoot, 'dataset');
  const results = path.join(runRoot, 'results');
  await mkdir(runRoot, { recursive: true });
  const python = process.env.BEEGO_PYTHON || 'python';
  onProgress({ phase: 'PREPARING_DATA' });
  await run(python, [path.join(repositoryRoot, 'algorithm', 'tools', 'prepare_ui_dataset.py'), dataset], payload, repositoryRoot, deadlineAt);
  const manifest = JSON.parse(await readFile(path.join(dataset, 'manifest.json'), 'utf8'));
  onProgress({ phase: 'PREPARING_ROUTES' });
  const transitIndex = await ensureTransitIndex(manifest.requires_public_transit ? manifest.planning_date : '2026-08-17', repositoryRoot, { deadlineAt: deadlineAt - 30_000 });
  const pipelineBudgetSeconds = Math.min(840, Math.floor(remainingMilliseconds(deadlineAt) / 1000) - 15);
  if (pipelineBudgetSeconds <= 0) throw new Error('Не осталось времени на точную проверку плана в пределах 15 минут');
  onProgress({ phase: 'EXACT_PIPELINE' });
  const pipeline = await run(python, [
    path.join(repositoryRoot, 'algorithm', 'tools', 'run_new_dataset_pipeline.py'),
    '--dataset', dataset,
    '--scenario', 'core',
    '--run-dir', results,
    '--transit-index', transitIndex,
    '--shared-cache-dir', path.join(repositoryRoot, 'runtime', 'ui-shared-cache'),
    '--stable-plan-cache-dir', path.join(repositoryRoot, 'runtime', 'ui-shared-cache', 'verified-plans'),
    '--max-wall-seconds', String(pipelineBudgetSeconds),
    '--execute',
  ], undefined, repositoryRoot, deadlineAt);
  if (pipeline.status !== 'COMPLETE' || !pipeline.final_plan) throw new Error('Новый точный план не прошёл проверку');
  onProgress({ phase: 'READING_VALIDATED_PLAN' });
  const raw = JSON.parse(await readFile(pipeline.final_plan, 'utf8'));
  return compactExactReplan(raw, { ...payload, team: payload.engineers });
}
