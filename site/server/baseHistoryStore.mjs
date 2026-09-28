import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { seedBaseShift } from './seedBaseShift.mjs';

const siteRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.dirname(siteRoot);
let historyPromise;
let fixturePromise;

const loadHistory = () => historyPromise ||= readFile(path.join(siteRoot, 'public/data/analytics-history.json'), 'utf8').then(JSON.parse);
const loadFixture = () => fixturePromise ||= readFile(path.join(siteRoot, 'public/test-data/beego-algorithm-initial.json'), 'utf8').then(JSON.parse);

const parseRows = source => {
  const [heading, ...lines] = source.trim().split(/\r?\n/);
  const columns = heading.split(';');
  return lines.map((line, index) => {
    const values = line.split(';');
    if (values.length !== columns.length) throw new Error(`Некорректная строка ${index + 2} исходного набора.`);
    return Object.fromEntries(columns.map((column, position) => [column, values[position]]));
  });
};

/** List every date supplied by the retained planning base. */
export async function baseHistoryDates() {
  return (await loadHistory()).days.map(day => day.date);
}

/** Load a validated historical day from the first archive into the operational store. */
export async function ensureBaseHistoricalShift(store, date) {
  const existing = store.byDate('moscow', date);
  if (existing) return existing;
  if (date === '2026-08-17') {
    await seedBaseShift(store);
    return store.byDate('moscow', date);
  }
  const history = await loadHistory();
  const day = history.days.find(item => item.date === date);
  if (!day) return null;
  if (day.dataKind !== 'SYNTHETIC_INPUT_EXACT_PLAN' || day.provenance?.plan !== 'INDEPENDENTLY_VALIDATED_EXACT') {
    throw new Error(`День ${date} не содержит независимо проверенного точного плана.`);
  }
  const dayRoot = path.join(repositoryRoot, 'history', date);
  const [raw, sourceRows, fixture] = await Promise.all([
    readFile(path.join(dayRoot, 'final-exact.json'), 'utf8').then(JSON.parse),
    readFile(path.join(dayRoot, 'dataset/core/jobs.csv'), 'utf8').then(parseRows),
    loadFixture(),
  ]);
  if (raw.status !== 'EXACT_VALID' || raw.publication_allowed !== true || raw.validation?.status !== 'VALID' ||
      raw.content_sha256 !== day.plan.contentSha256 || day.plan.validationStatus !== 'VALID' || day.plan.publicationAllowed !== true) {
    throw new Error(`Исторический план ${date} не совпал с проверенным исходным артефактом.`);
  }
  const rows = new Map(sourceRows.map(row => [row.job_id, row]));
  const engineers = new Map(fixture.engineers.map(item => [item.engineer_id, item]));
  const orders = day.orders.map(item => {
    const sourceData = rows.get(item.sourceId);
    if (!sourceData) throw new Error(`Заявка ${item.sourceId} отсутствует в исходном наборе ${date}.`);
    return {
      ...item, serviceDate: date, coords: [Number(sourceData.latitude), Number(sourceData.longitude)],
      equipment: sourceData.required_equipment, transport: sourceData.required_transport,
      geocodeStatus: 'ready', sourceData,
    };
  });
  const team = day.team.map(item => {
    const sourceData = engineers.get(item.id);
    if (!sourceData) throw new Error(`Бригада ${item.id} отсутствует в исходной базе.`);
    return {
      ...item, sourceId: item.id, serviceDate: date,
      startCoords: [Number(sourceData.start_latitude), Number(sourceData.start_longitude)],
      startAddress: sourceData.start_address, equipment: String(sourceData.equipment || '').split('|').filter(Boolean),
      zoneId: sourceData.zone_id, status: 'Доступен', sourceData: {
        ...sourceData, shift_start: item.shiftStart, shift_end: item.shiftEnd, transport_type: item.transport,
      },
    };
  });
  const rawRoutes = new Map(raw.plan.engineer_plans.map(route => [route.engineer_id, new Map(route.visits.map(visit => [visit.job_id, visit]))]));
  const pointByOrderId = new Map(orders.map(order => [order.id, order.coords]));
  let geometryCount = 0;
  const routes = day.plan.routes.map(route => ({
    ...route,
    assignments: route.assignments.map(assignment => {
      const sourceId = String(assignment.orderId).split(':').at(-1);
      const visit = rawRoutes.get(route.engineerId)?.get(sourceId);
      if (!visit) throw new Error(`Нет проверенного переезда ${date}: ${sourceId}.`);
      const geometry = Array.isArray(visit.travel?.geometry) ? visit.travel.geometry
        : visit.travel?.type === 'IDENTITY' && Number(visit.travel?.distance_m || 0) === 0
          ? [pointByOrderId.get(assignment.orderId), pointByOrderId.get(assignment.orderId)]
          : null;
      if (!geometry) throw new Error(`Нет проверенной геометрии ${date}: ${sourceId}.`);
      geometryCount += 1;
      return { ...assignment, geometry };
    }),
  }));
  if (geometryCount !== day.plan.metrics.assigned || orders.length !== day.plan.metrics.total) {
    throw new Error(`Количество проверенных маршрутов ${date} не совпало с исходным планом.`);
  }
  const plan = {
    ...day.plan, routes, provider: 'LOCAL_GTFS_RASP_VALHALLA', algorithm: 'beeline-planning-ortools-exact-v2.1',
    validation: { status: 'VALID', metrics: raw.validation.metrics }, datasetSha256: day.provenance.datasetSha256,
    approximateTravel: false, provenance: { ...day.provenance, dataKind: day.dataKind },
  };
  return store.ensure({ regionId: 'moscow', date, orders, team, plan });
}
