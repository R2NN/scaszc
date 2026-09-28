import { minuteOf, timeOf } from '../src/shiftDomain.js';
import { transportCode } from '../src/transport.js';
import { canServe } from '../src/dynamicReplanner.js';

const COSTING = { CAR: 'auto', BICYCLE: 'bicycle', WALKING: 'pedestrian' };
const GEOAPIFY_MODE = { CAR: 'drive', BICYCLE: 'bicycle', WALKING: 'walk', PUBLIC_TRANSIT: 'transit' };
const cache = new Map();

function decodePolyline6(encoded) {
  const points = [];
  let lat = 0;
  let lon = 0;
  let index = 0;
  while (index < encoded.length) {
    const values = [];
    for (let part = 0; part < 2; part += 1) {
      let shift = 0;
      let result = 0;
      let value;
      do {
        if (index >= encoded.length) throw new Error('Сервис дорог вернул неполную геометрию.');
        value = encoded.charCodeAt(index++) - 63;
        result |= (value & 31) << shift;
        shift += 5;
      } while (value >= 32);
      values.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    lat += values[0];
    lon += values[1];
    points.push([lat / 1e6, lon / 1e6]);
  }
  return points;
}

export async function exactLeg(from, to, transport, { endpoint = process.env.VALHALLA_ROUTE_ENDPOINT || 'http://127.0.0.1:8002/route', geoapifyKey = process.env.GEOAPIFY_API_KEY, fetchImpl = fetch } = {}) {
  if (!Array.isArray(from) || !Array.isArray(to) || from.length !== 2 || to.length !== 2) throw new Error('Для расчёта дороги нужны координаты обеих точек.');
  if (from[0] === to[0] && from[1] === to[1]) return { minutes: 0, distanceM: 0, geometry: [from, to], provider: 'SAME_POINT' };
  const mode = transportCode(transport);
  if (geoapifyKey) {
    const providerMode = GEOAPIFY_MODE[mode];
    if (!providerMode) throw new Error('Тип транспорта не поддерживается дорожным сервисом. Публикация заблокирована.');
    const key = JSON.stringify(['geoapify', from, to, providerMode]);
    if (cache.has(key)) return cache.get(key);
    const url = new URL('https://api.geoapify.com/v1/routing');
    url.searchParams.set('waypoints', `${from.join(',')}|${to.join(',')}`);
    url.searchParams.set('mode', providerMode);
    url.searchParams.set('apiKey', geoapifyKey);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) }).catch(() => { throw new Error('Дорожный сервис недоступен. Черновик не публикуется.'); });
    if (!response.ok) {
      const issue = await response.json().catch(() => ({}));
      const detail = String(issue.message || issue.error || '');
      if (response.status === 400 && /too far from a transit stop|cannot reach destination/i.test(detail) && mode === 'PUBLIC_TRANSIT') {
        throw new Error('Для общественного транспорта дорожный сервис не нашёл доступный путь до точки. Выберите другую бригаду или оставьте заявку без назначения. Неподтверждённый маршрут не публикуется.');
      }
      if (response.status === 400) throw new Error('Дорожный сервис не смог построить путь между точками для этого транспорта (400). Проверьте адреса и выберите другую бригаду. Черновик не публикуется.');
      throw new Error(`Дорожный сервис вернул ${response.status}. Черновик не публикуется.`);
    }
    const payload = await response.json();
    const feature = payload?.features?.[0];
    const lines = feature?.geometry?.coordinates;
    const raw = feature?.geometry?.type === 'MultiLineString' ? lines?.flat() : feature?.geometry?.type === 'LineString' ? lines : null;
    const geometry = raw?.map(point => [Number(point[1]), Number(point[0])]);
    const seconds = Number(feature?.properties?.time), distanceM = Number(feature?.properties?.distance);
    if (!geometry || geometry.length < 2 || !geometry.every(point => point.every(Number.isFinite)) || !Number.isFinite(seconds) || !Number.isFinite(distanceM)) throw new Error('Дорожный сервис не вернул подтверждённый путь. Черновик не публикуется.');
    const leg = { minutes: Math.ceil(seconds / 60), distanceM: Math.ceil(distanceM), geometry, provider: 'GEOAPIFY_ROUTING' };
    if (cache.size > 5000) cache.clear();
    cache.set(key, leg);
    return leg;
  }
  const costing = COSTING[mode];
  if (!costing) throw new Error('Для этого вида транспорта точная маршрутизация на сервере пока недоступна. Публикация заблокирована.');
  const key = JSON.stringify(['valhalla', from, to, costing]);
  if (cache.has(key)) return cache.get(key);
  const response = await fetchImpl(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locations: [{ lat: from[0], lon: from[1] }, { lat: to[0], lon: to[1] }], costing, units: 'kilometers', alternates: 0 }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => { throw new Error('Сервис дорожной маршрутизации недоступен. Черновик сохранён без публикации.'); });
  if (!response.ok) throw new Error(`Сервис дорожной маршрутизации вернул ошибку ${response.status}. Публикация заблокирована.`);
  const payload = await response.json();
  const summary = payload?.trip?.summary;
  const shape = payload?.trip?.legs?.[0]?.shape;
  if (!summary || !shape || !Number.isFinite(Number(summary.time)) || !Number.isFinite(Number(summary.length))) throw new Error('Сервис не вернул проверенный дорожный маршрут. Публикация заблокирована.');
  const geometry = decodePolyline6(shape);
  if (geometry.length < 2) throw new Error('Сервис вернул пустую дорожную геометрию.');
  const leg = { minutes: Math.ceil(Number(summary.time) / 60), distanceM: Math.ceil(Number(summary.length) * 1000), geometry, provider: 'LOCAL_VALHALLA' };
  if (cache.size > 5000) cache.clear();
  cache.set(key, leg);
  return leg;
}

// Rebuild every changed route against real road legs, then independently check
// the window/shift constraints before a dispatcher can publish it.
export async function validateRoadPlan(candidate, basePlan, orders, team, options = {}) {
  const orderById = new Map(orders.map(order => [String(order.id), order]));
  const engineerById = new Map(team.map(engineer => [String(engineer.id), engineer]));
  const baseRoutes = new Map((basePlan?.routes || []).map(route => [String(route.engineerId), route]));
  const routes = [];
  const providerNames = new Set();
  const baseHasEstimates = basePlan?.approximateTravel === true ||
    ['HYBRID_VALID', 'HEURISTIC_VALID', 'VALID_REPLAN'].includes(basePlan?.status) ||
    basePlan?.provider === 'HAVERSINE_OPERATIONAL_ESTIMATE';
  let retainedEstimatedVisits = 0;
  let exactCheckedVisits = 0;
  const eventMinute = minuteOf(candidate.event?.time) ?? 0;
  for (const oldRoute of basePlan?.routes || []) {
    for (const old of oldRoute.assignments || []) {
      if ((minuteOf(old.plannedStart) ?? 1440) >= eventMinute) continue;
      const kept = (candidate.routes || []).find(route => String(route.engineerId) === String(oldRoute.engineerId))?.assignments?.find(item => String(item.orderId) === String(old.orderId));
      if (!kept || kept.plannedStart !== old.plannedStart) throw new Error('Событие затрагивает уже начатый визит. Прошлую часть смены менять нельзя.');
    }
  }
  for (const route of candidate.routes || []) {
    const engineer = engineerById.get(String(route.engineerId));
    if (!engineer) throw new Error('Бригада отсутствует в смене.');
    const base = baseRoutes.get(String(route.engineerId));
    const shiftStart = engineer.shiftStart || route.shiftStart;
    const shiftEnd = engineer.shiftEnd || route.shiftEnd;
    const same = base && candidate.event?.type !== 'ORDER_UPDATED' &&
      base.shiftStart === shiftStart && base.shiftEnd === shiftEnd &&
      JSON.stringify((base.assignments || []).map(item => item.orderId)) === JSON.stringify((route.assignments || []).map(item => item.orderId)) &&
      (base.assignments || []).every((item, index) => {
        const order = orderById.get(String(item.orderId));
        const start = minuteOf(item.plannedStart);
        const finish = minuteOf(item.plannedFinish);
        const isPast = (start ?? 1440) < eventMinute;
        return order && item.plannedStart === route.assignments[index]?.plannedStart &&
          item.plannedFinish === route.assignments[index]?.plannedFinish &&
          (isPast || canServe(engineer, order)) &&
          (isPast || ((minuteOf(order.start) ?? 1440) <= start && start <= (minuteOf(order.end) ?? -1) && finish <= (minuteOf(shiftEnd) ?? -1)));
      });
    if (same) {
      if (baseHasEstimates) retainedEstimatedVisits += base.assignments?.length || 0;
      routes.push(base);
      continue;
    }
    let cursor = minuteOf(engineer.shiftStart || route.shiftStart) ?? 480;
    let coords = engineer.startCoords;
    const assignments = [];
    const geometry = [];
    for (const assignment of route.assignments || []) {
      const order = orderById.get(String(assignment.orderId));
      if (!order || !Array.isArray(order.coords)) throw new Error(`У заявки ${assignment.orderId} нет подтверждённой точки.`);
      if (!canServe(engineer, order) && !(assignment.frozen || (minuteOf(assignment.plannedStart) ?? 1440) < eventMinute)) throw new Error(`Бригада ${engineer.name || engineer.id} не проходит навык, зону, оснащение или доступность для заявки ${order.sourceId || order.id}.`);
      if (assignment.frozen || (minuteOf(assignment.plannedStart) ?? 1440) < eventMinute) {
        if (baseHasEstimates) retainedEstimatedVisits += 1;
        assignments.push(assignment);
        cursor = minuteOf(assignment.plannedFinish) ?? cursor;
        coords = order.coords;
        if (assignment.geometry?.length) geometry.push(...assignment.geometry);
        continue;
      }
      cursor = Math.max(cursor, eventMinute);
      const leg = await exactLeg(coords, order.coords, engineer.transport, options);
      providerNames.add(leg.provider);
      exactCheckedVisits += 1;
      options.onProgress?.({ checkedRoads: exactCheckedVisits });
      const departure = cursor;
      const arrival = departure + leg.minutes;
      const start = Math.max(arrival, minuteOf(order.start) ?? arrival);
      const finish = start + Math.max(1, Number(order.duration) || 60);
      const windowEnd = minuteOf(order.end);
      const shiftEnd = minuteOf(engineer.shiftEnd || route.shiftEnd) ?? 1440;
      if (windowEnd == null || start > windowEnd || finish > shiftEnd) throw new Error(`После расчёта реальной дороги заявка ${order.sourceId || order.id} не помещается в окно или смену. Черновик не публикуется.`);
      assignments.push({ ...assignment, departureAt: timeOf(departure), arrival: timeOf(arrival), arrivalAt: timeOf(arrival), plannedStart: timeOf(start), plannedFinish: timeOf(finish), travelMinutes: leg.minutes, distanceM: leg.distanceM, geometry: leg.geometry, claimLevel: 'EXACT_ROAD_VALIDATED' });
      geometry.push(...(geometry.length ? leg.geometry.slice(1) : leg.geometry));
      cursor = finish;
      coords = order.coords;
    }
    routes.push({ ...route, shiftStart, shiftEnd, assignments, geometry, distanceKm: Math.round(assignments.reduce((sum, item) => sum + Number(item.distanceM || 0), 0) / 100) / 10, travelMinutes: assignments.reduce((sum, item) => sum + Number(item.travelMinutes || 0), 0) });
  }
  const assigned = routes.reduce((sum, route) => sum + route.assignments.length, 0);
  const assignedIds = routes.flatMap(route => route.assignments.map(item => String(item.orderId)));
  if (new Set(assignedIds).size !== assignedIds.length) throw new Error('Одна заявка попала в несколько маршрутов. Публикация запрещена.');
  const unassignedIds = (candidate.unassigned || []).map(item => String(item.orderId));
  if (new Set(unassignedIds).size !== unassignedIds.length || unassignedIds.some(id => assignedIds.includes(id))) throw new Error('Очередь заявок противоречит маршрутам. Публикация запрещена.');
  if (orders.some(order => !assignedIds.includes(String(order.id)) && !unassignedIds.includes(String(order.id)))) throw new Error('В черновике потеряна заявка. Публикация запрещена.');
  return {
    ...candidate, routes,
    provider: retainedEstimatedVisits ? 'MIXED_BASELINE_AND_EXACT_ROAD' : [...providerNames][0] || basePlan?.provider || 'UNCHANGED_EXACT_ROAD',
    algorithm: 'dynamic-insertion+exact-road-validation', approximateTravel: retainedEstimatedVisits > 0,
    publicationAllowed: true,
    validation: {
      status: 'VALID', changedRoadsExact: true, exactCheckedVisits, retainedEstimatedVisits,
      constraints: ['REGION', 'SKILL', 'EQUIPMENT', 'WINDOW', 'SHIFT', 'CHANGED_ROADS_EXACT'],
    },
    metrics: { ...candidate.metrics, assigned, distanceKm: Math.round(routes.reduce((sum, route) => sum + Number(route.distanceKm || 0), 0) * 10) / 10, travelMinutes: routes.reduce((sum, route) => sum + Number(route.travelMinutes || 0), 0) },
  };
}
