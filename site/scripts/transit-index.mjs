import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const canonicalDate = '2026-08-17';
const builds = new Map();

const exists = async file => access(file).then(() => true, () => false);

const run = (python, script, args, repositoryRoot) => new Promise((resolve, reject) => {
  const child = spawn(python, [path.join(repositoryRoot, 'algorithm', 'tools', script), ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, 'algorithm', 'src'), PYTHONUTF8: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || stdout.trim() || `${script} завершился с кодом ${code}`)));
});

const validIndex = async (database, planningDate) => {
  if (!await exists(database)
    || !await exists(database.replace(/\.sqlite$/, '.manifest.json'))
    || !await exists(database.replace(/\.sqlite$/, '.surface_walk_transfers.json'))
    || !await exists(database.replace(/\.sqlite$/, '.walk_transfers.json'))) return false;
  try {
    const metadata = JSON.parse(await readFile(database.replace(/\.sqlite$/, '.manifest.json'), 'utf8'));
    const surface = JSON.parse(await readFile(database.replace(/\.sqlite$/, '.surface_walk_transfers.json'), 'utf8'));
    const rapid = JSON.parse(await readFile(database.replace(/\.sqlite$/, '.walk_transfers.json'), 'utf8'));
    return metadata.scenario_date === planningDate && metadata.active_gtfs_trips > 0
      && surface.failed_measurements === 0 && rapid.failed_stops?.length === 0;
  } catch {
    return false;
  }
};

/** Build and cache a date-specific transit timetable; never reuse another day's departures. */
export async function ensureTransitIndex(planningDate, repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')) {
  const parsed = new Date(`${planningDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planningDate) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== planningDate) {
    throw new Error(`Некорректная дата расписания: ${planningDate}`);
  }
  const key = `${repositoryRoot}:${planningDate}`;
  if (builds.has(key)) return builds.get(key);
  const task = (async () => {
    const canonical = path.join(repositoryRoot, 'data', 'transit', `moscow_${canonicalDate}.sqlite`);
    if (planningDate === canonicalDate && await validIndex(canonical, planningDate)) return canonical;
    const directory = path.join(repositoryRoot, 'runtime', 'ui-shared-cache', 'transit');
    const database = path.join(directory, `moscow_${planningDate}.sqlite`);
    if (await validIndex(database, planningDate)) return database;
    const configured = [
      ['BEEGO_GTFS_DIR', ['offline-assets/transit-sources/gtfs', 'data/transit/sources/gtfs'], 'A:/LCT2-routing/gtfs-inspect', 'calendar.txt'],
      ['BEEGO_RAIL_DIR', ['offline-assets/transit-sources/rail', 'data/transit/sources/rail'], 'A:/LCT2-routing/handoff/work/transit_normal_weekday_mcc_v2', 'manifest.json'],
      ['BEEGO_METRO_SCHEMA', ['offline-assets/transit-sources/metro/schema.json', 'data/transit/sources/metro-schema.json'], 'A:/LCT2-routing/research/mosmetro-api/schema.json', null],
    ];
    const sources = [];
    for (const [variable, relatives, fallback, requiredFile] of configured) {
      let selected = process.env[variable];
      if (!selected) {
        for (const relative of relatives) {
          const candidate = path.join(repositoryRoot, relative);
          if (await exists(requiredFile ? path.join(candidate, requiredFile) : candidate)) {
            selected = candidate;
            break;
          }
        }
      }
      selected ||= fallback;
      if (!await exists(requiredFile ? path.join(selected, requiredFile) : selected)) {
        throw new Error(`Для расписания на ${planningDate} не найден исходный файл ${selected}. Укажите ${variable}.`);
      }
      sources.push(selected);
    }
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.transit-${planningDate}-${randomUUID()}`);
    const temporaryDatabase = path.join(temporary, `moscow_${planningDate}.sqlite`);
    const python = process.env.BEEGO_PYTHON || 'python';
    await mkdir(temporary);
    try {
      await run(python, 'build_local_transit_index.py', [
        '--gtfs', sources[0], '--rail', sources[1], '--metro-schema', sources[2],
        '--output', temporaryDatabase, '--scenario-date', planningDate,
      ], repositoryRoot);
      await run(python, 'ensure_local_valhalla.py', ['--endpoint', 'http://127.0.0.1:8002'], repositoryRoot);
      await run(python, 'build_surface_walk_transfers.py', ['--database', temporaryDatabase], repositoryRoot);
      if (await validIndex(canonical, canonicalDate)) {
        try {
          await run(python, 'reuse_rapid_walk_transfers.py', [
            '--source', canonical, '--database', temporaryDatabase,
          ], repositoryRoot);
        } catch {
          await run(python, 'build_walk_transfers.py', ['--database', temporaryDatabase], repositoryRoot);
        }
      } else {
        await run(python, 'build_walk_transfers.py', ['--database', temporaryDatabase], repositoryRoot);
      }
      const surfaceReport = JSON.parse(await readFile(temporaryDatabase.replace(/\.sqlite$/, '.surface_walk_transfers.json'), 'utf8'));
      const walkReport = JSON.parse(await readFile(temporaryDatabase.replace(/\.sqlite$/, '.walk_transfers.json'), 'utf8'));
      if (surfaceReport.failed_measurements || walkReport.failed_stops?.length) {
        throw new Error(`Пешеходные пересадки на ${planningDate} построены не полностью: `
          + `${surfaceReport.failed_measurements} наземных остановок, ${walkReport.failed_stops?.length || 0} станций`);
      }
      if (await validIndex(database, planningDate)) return database;
      for (const suffix of ['.manifest.json', '.surface_walk_transfers.json', '.walk_transfers.json', '.sqlite']) {
        await rename(temporaryDatabase.replace(/\.sqlite$/, suffix), database.replace(/\.sqlite$/, suffix));
      }
      return database;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  })();
  builds.set(key, task);
  try { return await task; } finally { builds.delete(key); }
}
