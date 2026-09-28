import { spawn } from 'node:child_process';

export const PLANNING_DEADLINE_MS = 15 * 60 * 1000;

/** Stop a Python process and its child processes after the planning deadline. */
export function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

/** Milliseconds remaining for one subprocess under a shared deadline. */
export function remainingMilliseconds(deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Расчёт остановлен после 15 минут: проверенный план не получен');
  return remaining;
}
