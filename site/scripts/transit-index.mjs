import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remainingMilliseconds, stopProcessTree } from './process-deadline.mjs';

const canonicalDate = '2026-08-17';
const builds = new Map();

const exists = async file => access(file).then(() => true, () => false);

const run = (python, script, args, repositoryRoot, deadlineAt = Infinity) => new Promise((resolve, reject) => {
  const timeoutMs = Number.isFinite(deadlineAt) ? remainingMilliseconds(deadlineAt) : undefined;
  const child = spawn(python, [path.join(repositoryRoot, 'algorithm', 'tools', script), ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, 'algorithm', 'src'), PYTHONUTF8: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = timeoutMs === undefined ? null : setTimeout(() => { timedOut = true; stopProcessTree(child); }, timeoutMs);
  timer?.unref();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-4000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.on('error', error => { if (timer) clearTimeout(timer); reject(error); });
  child.on('close', code => {
    if (timer) clearTimeout(timer);
    if (timedOut) reject(new Error('Расчёт остановлен после 15 минут: индекс транспорта не был готов'));
    else if (code === 0) resolve(stdout);
    else reject(new Error(stderr.trim() || stdout.trim() || `${script} завершился с кодом ${code}`));
  });
});

const validIndex = async (database, planningDate, allowLegacyRailMetadata = false) => {
  if (!await exists(database)
    || !await exists(database.replace(/\.sqlite$/, '.manifest.json'))
    || !await exists(database.replace(/\.sqlite$/, '.surface_walk_transfers.json'))
    || !await exists(database.replace(/\.sqlite$/, '.walk_transfers.json'))) return false;
  try {
    const metadata = JSON.parse(await readFile(database.replace(/\.sqlite$/, '.manifest.json'), 'utf8'));
    const surface = JSON.parse(await readFile(database.replace(/\.sqlite$/, '.surface_walk_transfers.json'), 'utf8'));
    const rapid = JSON.parse(await readFile(database.replace(/\.sqlite$/, '.walk_transfers.json'), 'utf8'));
    const canonicalRailAvailable = allowLegacyRailMetadata && planningDate === canonicalDate
      && metadata.rail_trips > 0 && metadata.rail_connections > 0;
    return metadata.scenario_date === planningDate && metadata.active_gtfs_trips > 0
      && (metadata.rail_schedule_available === true || canonicalRailAvailable)
      && surface.failed_measurements === 0 && rapid.failed_stops?.length === 0;
  } catch {
    return false;
  }
};

const railSnapshot = async (directory, planningDate) => {
  const manifestFile = path.join(directory, 'manifest.json');
  if (!await exists(manifestFile) || !await exists(path.join(directory, 'rail_schedule.json'))
    || !await exists(path.join(directory, 'rail_station_map.json'))) return false;
  try {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    return manifest.schedule_scope === 'exact_date' && manifest.source_date === planningDate
      && manifest.coverage_complete === true;
  } catch {
    return false;
  }
};

const weekday = value => new Date(`${value}T00:00:00Z`).getUTCDay();

const weeklyRailReference = async (directories, planningDate) => {
  const candidates = [];
  for (const parent of directories) {
    for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)
        || weekday(entry.name) !== weekday(planningDate)) continue;
      const directory = path.join(parent, entry.name);
      if (await railSnapshot(directory, entry.name)) candidates.push({ directory, date: entry.name });
    }
  }
  candidates.sort((left, right) => right.date.localeCompare(left.date));
  return candidates[0]?.directory;
};

const nextReferenceDate = planningDate => {
  const today = currentMoscowDate();
  if (planningDate >= today && planningDate <= new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 86400_000).toISOString().slice(0, 10)) {
    return planningDate;
  }
  const offset = (weekday(planningDate) - weekday(today) + 7) % 7;
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);
};

const currentMoscowDate = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

const railCredentials = async repositoryRoot => {
  if (process.env.YANDEX_RASP_API_KEY) return null;
  const configured = process.env.BEEGO_RASP_CREDENTIALS;
  if (configured && !await exists(configured)) {
    throw new Error(`Файл BEEGO_RASP_CREDENTIALS не найден: ${configured}`);
  }
  const candidates = [configured, path.join(repositoryRoot, '.dev.vars'),
    path.join(repositoryRoot, 'site', '.dev.vars'), path.join(repositoryRoot, '.env.routing.local'),
    'A:/LCT2-routing/handoff/.env.routing.local'].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate) && /^YANDEX_RASP_API_KEY=\S+/m.test(await readFile(candidate, 'utf8'))) return candidate;
  }
  return undefined;
};

/** Select a complete exact-date or same-weekday railway source. */
export const selectRailSource = async (base, metroSchema, planningDate, repositoryRoot, python, deadlineAt = Infinity) => {
  const bundled = path.join(base, 'dates', planningDate);
  if (await railSnapshot(bundled, planningDate)) return { directory: bundled, weekdayReference: false };
  const cached = path.join(repositoryRoot, 'runtime', 'ui-shared-cache', 'rail', 'dates', planningDate);
  if (await railSnapshot(cached, planningDate)) return { directory: cached, weekdayReference: false };
  const reference = await weeklyRailReference([path.join(base, 'dates'), path.dirname(cached)], planningDate);
  if (reference && process.env.BEEGO_REFRESH_RAIL_DATE !== '1') {
    return { directory: reference, weekdayReference: true };
  }
  if (weekday(planningDate) === weekday('2026-09-21') && process.env.BEEGO_REFRESH_RAIL_DATE !== '1') {
    return { directory: base, weekdayReference: false };
  }
  if (process.env.BEEGO_REFRESH_RAIL_DATE === '1' && planningDate < currentMoscowDate()) {
    throw new Error(`Нельзя запросить точное историческое расписание МЦК/МЦД на ${planningDate}; `
      + 'используйте сохранённый снимок или эталон того же дня недели');
  }
  const credentials = await railCredentials(repositoryRoot);
  if (credentials !== undefined || process.env.YANDEX_RASP_API_KEY) {
    const sourceDate = process.env.BEEGO_REFRESH_RAIL_DATE === '1'
      ? planningDate : nextReferenceDate(planningDate);
    const sourceCache = path.join(path.dirname(cached), sourceDate);
    const args = ['--base-rail', base, '--metro-schema', metroSchema,
      '--output', sourceCache, '--date', sourceDate];
    if (credentials) args.push('--credentials', credentials);
    try {
      await run(python, 'collect_rail_date.py', args, repositoryRoot, deadlineAt);
    } catch (error) {
      throw new Error(`Расписание МЦК/МЦД для ${planningDate} пока не собрано полностью. `
        + `Повторите расчёт после обновления квоты API. ${error.message}`);
    }
    if (!await railSnapshot(sourceCache, sourceDate)) {
      throw new Error(`Расписание МЦК/МЦД на ${sourceDate} не прошло проверку полноты`);
    }
    return { directory: sourceCache, weekdayReference: sourceDate !== planningDate };
  }
  throw new Error(`Для ${planningDate} нет полного расписания МЦК/МЦД. `
    + 'Загрузите снимок нужной даты или дня недели либо настройте YANDEX_RASP_API_KEY.');
};

/** Build and cache a date-specific transit index with explicit railway provenance. */
export async function ensureTransitIndex(planningDate, repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), { deadlineAt = Infinity } = {}) {
  const parsed = new Date(`${planningDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planningDate) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== planningDate) {
    throw new Error(`Некорректная дата расписания: ${planningDate}`);
  }
  const key = `${repositoryRoot}:${planningDate}`;
  if (builds.has(key)) return builds.get(key);
  const task = (async () => {
    const suppliedDirectory = process.env.BEEGO_TRANSIT_INDEX_DIR;
    if (suppliedDirectory) {
      const supplied = path.join(suppliedDirectory, `moscow_${planningDate}.sqlite`);
      if (await validIndex(supplied, planningDate)) return supplied;
    }
    const canonical = path.join(repositoryRoot, 'data', 'transit', `moscow_${canonicalDate}.sqlite`);
    if (planningDate === canonicalDate && await validIndex(canonical, planningDate, true)) return canonical;
    const directory = path.join(repositoryRoot, 'runtime', 'ui-shared-cache', 'transit');
    const database = path.join(directory, `moscow_${planningDate}.sqlite`);
    if (await validIndex(database, planningDate)) {
      const metadata = JSON.parse(await readFile(database.replace(/\.sqlite$/, '.manifest.json'), 'utf8'));
      if (metadata.rail_schedule_scope === 'exact_date') return database;
      const dateRail = path.join(repositoryRoot, 'runtime', 'ui-shared-cache', 'rail', 'dates', planningDate);
      const bundledRail = path.join(repositoryRoot, 'offline-assets', 'transit-sources', 'rail', 'dates', planningDate);
      const hasExactRail = await railSnapshot(dateRail, planningDate)
        || await railSnapshot(bundledRail, planningDate);
      if (metadata.rail_schedule_scope === 'weekday_reference'
        && !hasExactRail && process.env.BEEGO_REFRESH_RAIL_DATE !== '1') return database;
    }
    const configured = [
      ['BEEGO_GTFS_DIR', ['offline-assets/transit-sources/gtfs', 'data/transit/sources/gtfs'], 'A:/LCT2-routing/gtfs-inspect', 'routes.txt'],
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
      const rail = await selectRailSource(sources[1], sources[2], planningDate, repositoryRoot, python, deadlineAt);
      await run(python, 'build_local_transit_index.py', [
        '--gtfs', sources[0], '--rail', rail.directory, '--metro-schema', sources[2],
        '--output', temporaryDatabase, '--scenario-date', planningDate,
        ...(rail.weekdayReference ? ['--rail-weekday-reference'] : []),
      ], repositoryRoot, deadlineAt);
      const builtMetadata = JSON.parse(await readFile(temporaryDatabase.replace(/\.sqlite$/, '.manifest.json'), 'utf8'));
      if (!builtMetadata.rail_schedule_available) {
        throw new Error(`Для ${planningDate} не найдено полное расписание МЦК/МЦД`);
      }
      await run(python, 'ensure_local_valhalla.py', ['--endpoint', 'http://127.0.0.1:8002'], repositoryRoot, deadlineAt);
      await run(python, 'build_surface_walk_transfers.py', ['--database', temporaryDatabase], repositoryRoot, deadlineAt);
      if (await validIndex(canonical, canonicalDate)) {
        try {
          await run(python, 'reuse_rapid_walk_transfers.py', [
            '--source', canonical, '--database', temporaryDatabase,
          ], repositoryRoot, deadlineAt);
        } catch {
          await run(python, 'build_walk_transfers.py', ['--database', temporaryDatabase], repositoryRoot, deadlineAt);
        }
      } else {
        await run(python, 'build_walk_transfers.py', ['--database', temporaryDatabase], repositoryRoot, deadlineAt);
      }
      const surfaceReport = JSON.parse(await readFile(temporaryDatabase.replace(/\.sqlite$/, '.surface_walk_transfers.json'), 'utf8'));
      const walkReport = JSON.parse(await readFile(temporaryDatabase.replace(/\.sqlite$/, '.walk_transfers.json'), 'utf8'));
      if (surfaceReport.failed_measurements || walkReport.failed_stops?.length) {
        throw new Error(`Пешеходные пересадки на ${planningDate} построены не полностью: `
          + `${surfaceReport.failed_measurements} наземных остановок, ${walkReport.failed_stops?.length || 0} станций`);
      }
      if (await validIndex(database, planningDate)) {
        const previous = JSON.parse(await readFile(database.replace(/\.sqlite$/, '.manifest.json'), 'utf8'));
        if (previous.rail_schedule_scope === 'exact_date') return database;
      }
      for (const suffix of ['.manifest.json', '.surface_walk_transfers.json', '.walk_transfers.json', '.sqlite']) {
        const destination = database.replace(/\.sqlite$/, suffix);
        await rm(destination, { force: true });
        await rename(temporaryDatabase.replace(/\.sqlite$/, suffix), destination);
      }
      return database;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  })();
  builds.set(key, task);
  try { return await task; } finally { builds.delete(key); }
}
