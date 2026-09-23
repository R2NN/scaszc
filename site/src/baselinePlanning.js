/**
 * Дополняет координатами заявки и стартовые точки инженеров во всех днях истории.
 */
export function hydrateBaselineInputs(payload, source) {
  if (!payload?.days || !Array.isArray(source?.jobs) || !Array.isArray(source?.engineers)) return payload;
  const jobs = new Map(source.jobs.map(job => [String(job.job_id || job.source_job_id), job]));
  const engineers = new Map(source.engineers.map(engineer => [String(engineer.engineer_id), engineer]));

  return {
    ...payload,
    days: payload.days.map(day => ({
      ...day,
      orders: (day.orders || []).map(order => {
        const job = jobs.get(String(order.sourceId)) || jobs.get(String(order.id).replace(/^.*:/, ''));
        const latitude = Number(job?.latitude);
        const longitude = Number(job?.longitude);
        return Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { ...order, coords: [latitude, longitude], geocodeStatus: 'provided' }
          : order;
      }),
      team: (day.team || []).map(engineer => {
        const sourceEngineer = engineers.get(String(engineer.id));
        const latitude = Number(sourceEngineer?.start_latitude);
        const longitude = Number(sourceEngineer?.start_longitude);
        return Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { ...engineer, startCoords: [latitude, longitude], startAddress: sourceEngineer.start_address || '' }
          : engineer;
      }),
    })),
  };
}

const unavailableBaseline = reason => ({
  available: false,
  exact: false,
  reason,
  methodology: 'EXACT_ARTIFACT_REQUIRED',
  baselineAssignedCount: null,
  baselineEngineersUsed: null,
  baselineTotalDistanceKm: null,
  baselineAvgKmPerOrder: null,
  baselineUnassignedCount: null,
  routes: [],
  unassigned: [],
});

/**
 * Возвращает только опубликованный EXACT_VALID FCFS-бейзлайн.
 * Браузер не подменяет дорожную матрицу прямой и фиксированной скоростью.
 */
export function calculateBaseline(orders = [], engineers = [], exactBaseline = null) {
  if (exactBaseline?.status !== 'EXACT_VALID' || exactBaseline?.validationStatus !== 'VALID' || exactBaseline?.publicationAllowed !== true || !Array.isArray(exactBaseline.routes)) {
    return unavailableBaseline('Точный FCFS-артефакт для этой даты не опубликован');
  }
  const orderIds = new Set(orders.map(order => String(order.id)));
  const engineerIds = new Set(engineers.map(engineer => String(engineer.id)));
  const assignments = exactBaseline.routes.flatMap(route => route.assignments || []);
  const unassigned = exactBaseline.unassigned || [];
  const coveredIds = [...assignments.map(item => String(item.orderId)), ...unassigned.map(item => String(item.orderId))];
  if (exactBaseline.routes.some(route => !engineerIds.has(String(route.engineerId)))
    || coveredIds.some(id => !orderIds.has(id))
    || coveredIds.length !== orderIds.size
    || new Set(coveredIds).size !== orderIds.size
    || (exactBaseline.metrics && (exactBaseline.metrics.assigned !== assignments.length
      || exactBaseline.metrics.unassigned !== unassigned.length
      || exactBaseline.metrics.total !== orders.length))) {
    return unavailableBaseline('Точный FCFS-артефакт не совпадает с выбранным набором данных');
  }
  const totalDistanceKm = assignments.reduce((sum, item) => sum + (Number(item.distanceM) || 0), 0) / 1000;
  return {
    available: true,
    exact: true,
    methodology: exactBaseline.methodology || 'EXACT_FCFS_SAME_ROUTING_AND_VALIDATOR',
    validationStatus: exactBaseline.validationStatus,
    policy: exactBaseline.policy || null,
    baselineAssignedCount: assignments.length,
    baselineEngineersUsed: exactBaseline.routes.filter(route => route.assignments?.length).length,
    baselineTotalDistanceKm: totalDistanceKm,
    baselineAvgKmPerOrder: assignments.length ? totalDistanceKm / assignments.length : 0,
    baselineUnassignedCount: unassigned.length,
    routes: exactBaseline.routes,
    unassigned,
  };
}

/** Project a globally validated FCFS plan onto a selected territory. */
export function filterExactBaseline(baseline, orderIds, engineerIds) {
  if (!baseline) return null;
  const routes = baseline.routes.filter(route => engineerIds.has(String(route.engineerId))).map(route => ({
    ...route,
    assignments: route.assignments.filter(item => orderIds.has(String(item.orderId))),
  })).filter(route => route.assignments.length);
  const unassigned = baseline.unassigned.filter(item => orderIds.has(String(item.orderId)));
  const assignments = routes.flatMap(route => route.assignments);
  return {
    ...baseline,
    methodology: 'EXACT_FCFS_TERRITORY_VIEW_OF_VALIDATED_PLAN',
    routes,
    unassigned,
    metrics: {
      total: orderIds.size,
      assigned: assignments.length,
      unassigned: unassigned.length,
      activeEngineers: routes.length,
      distanceKm: assignments.reduce((sum, item) => sum + (Number(item.distanceM) || 0), 0) / 1000,
      travelMinutes: assignments.reduce((sum, item) => sum + (Number(item.travelMinutes) || 0), 0),
    },
  };
}

/** Match a live copy of the canonical plan to its published exact FCFS artifact. */
export function attachExactBaseline(liveRecord, canonicalRecord) {
  const livePlan = liveRecord?.plan;
  const canonicalPlan = canonicalRecord?.plan;
  const baseline = canonicalPlan?.baseline;
  if (!baseline || !livePlan?.contentSha256
    || livePlan.contentSha256 !== canonicalPlan.contentSha256
    || liveRecord.date !== canonicalRecord.date) return liveRecord;

  const canonicalOrders = new Map(canonicalRecord.orders.map(order => [String(order.id), String(order.sourceId)]));
  const liveOrders = new Map((liveRecord.orders || []).map(order => [String(order.sourceId || order.sourceData?.job_id || order.id), String(order.id)]));
  const liveEngineers = new Map((liveRecord.team || []).map(engineer => [String(engineer.sourceId || engineer.sourceData?.engineer_id || engineer.id), String(engineer.id)]));
  if (liveOrders.size !== canonicalOrders.size || liveEngineers.size !== canonicalRecord.team.length
    || [...canonicalOrders.values()].some(sourceId => !liveOrders.has(sourceId))
    || canonicalRecord.team.some(engineer => !liveEngineers.has(String(engineer.id)))) return liveRecord;

  const mapOrderId = orderId => liveOrders.get(canonicalOrders.get(String(orderId)));
  const routes = baseline.routes.map(route => ({
    ...route,
    engineerId: liveEngineers.get(String(route.engineerId)),
    assignments: route.assignments.map(item => ({
      ...item,
      orderId: mapOrderId(item.orderId),
      engineerId: liveEngineers.get(String(item.engineerId)),
    })),
  }));
  const unassigned = baseline.unassigned.map(item => ({ ...item, orderId: mapOrderId(item.orderId) }));
  return {
    ...liveRecord,
    plan: { ...livePlan, baseline: { ...baseline, routes, unassigned } },
  };
}
