import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DAYS = 182;
const ROOT = new URL('../', import.meta.url);

const minutes = value => {
  const [hour, minute] = String(value || '00:00').split(':').map(Number);
  return hour * 60 + minute;
};
const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const timeFromIso = value => String(value || '').match(/T(\d{2}:\d{2})/)?.[1] || '';
const dateKey = date => date.toISOString().slice(0, 10);
const dayIndex = value => new Date(`${value}T12:00:00Z`).getUTCDay();

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function normalizeOrder(job, date) {
  return {
    id: `${date}:${job.job_id}`,
    sourceId: job.job_id,
    name: `Заявка ${job.source_job_id || job.job_id}`,
    address: job.address,
    start: timeFromIso(job.window_start),
    end: timeFromIso(job.window_end),
    duration: Number(job.service_duration_min) || 0,
    priority: job.priority === 'URGENT' ? 'Авария' : 'Обычная',
    workType: job.bk_type,
    serviceType: job.hd_type,
    skill: job.required_skill,
    zone: job.zone_name,
    zoneId: job.zone_id,
    district: job.district,
    regionId: job.region_id || job.regionId || 'moscow',
    regionName: job.region_name || job.regionName || 'Москва',
    status: job.status,
  };
}

function normalizeEngineer(engineer) {
  return {
    id: engineer.engineer_id,
    name: engineer.engineer_name,
    skills: String(engineer.skills || '').split('|').map(value => value.trim()).filter(Boolean),
    shiftStart: engineer.shift_start,
    shiftEnd: engineer.shift_end,
    transport: engineer.transport,
    zone: engineer.zone,
    regionId: engineer.region_id || engineer.regionId || 'moscow',
  };
}

function actualVisit(assignment, order, date) {
  const score = hash(`${date}:${assignment.sourceOrderId}:fact`);
  const cancelled = score % 43 === 0;
  const deviation = (score % 23) - 7;
  const arrival = minutes(assignment.arrival) + deviation;
  const start = Math.max(arrival, minutes(assignment.plannedStart) + Math.max(0, deviation));
  const finish = start + Number(order.duration || 0) + ((score >>> 8) % 17) - 5;
  return {
    orderId: order.id,
    engineerId: assignment.engineerId,
    status: cancelled ? 'cancelled' : 'completed',
    arrival: cancelled ? null : clock(arrival),
    start: cancelled ? null : clock(start),
    finish: cancelled ? null : clock(finish),
    delayMinutes: cancelled ? null : Math.max(0, start - minutes(assignment.plannedStart)),
    onTime: cancelled ? null : start <= minutes(order.end),
    reason: cancelled ? 'Клиент отменил визит' : null,
  };
}

function normalizeBaseline(sourceBaseline, orderBySourceId) {
  if (!sourceBaseline || sourceBaseline.status !== 'EXACT_VALID' || sourceBaseline.validationStatus !== 'VALID') return null;
  const sourceAssignments = sourceBaseline.routes.flatMap(route => route.assignments);
  if (sourceBaseline.metrics.total !== orderBySourceId.size
    || sourceAssignments.some(item => !orderBySourceId.has(item.sourceOrderId))) {
    throw new Error('Точный FCFS-бейзлайн не совпадает с текущим набором заявок');
  }
  const routes = sourceBaseline.routes.map(route => ({
    engineerId: route.engineerId,
    engineerName: route.engineerName,
    shiftStart: route.shiftStart,
    shiftEnd: route.shiftEnd,
    workloadMinutes: Number(route.workloadMinutes) || 0,
    distanceKm: route.assignments.reduce((sum, item) => sum + (Number(item.distanceM) || 0), 0) / 1000,
    travelMinutes: Number(route.travelMinutes) || 0,
    waitingMinutes: Number(route.waitingMinutes) || 0,
    assignments: route.assignments.map(item => {
      const order = orderBySourceId.get(item.sourceOrderId);
      return order ? {
        orderId: order.id,
        engineerId: route.engineerId,
        position: item.position,
        departureAt: item.departureAt,
        arrival: item.arrival,
        plannedStart: item.plannedStart,
        plannedFinish: item.plannedFinish,
        travelMinutes: Number(item.travelMinutes) || 0,
        distanceM: Number(item.distanceM) || 0,
      } : null;
    }).filter(Boolean),
  })).filter(route => route.assignments.length);
  const assigned = routes.flatMap(route => route.assignments);
  const assignedIds = new Set(assigned.map(item => item.orderId));
  const unassigned = [...orderBySourceId.values()].filter(order => !assignedIds.has(order.id)).map(order => ({ orderId: order.id }));
  if (assigned.length !== sourceBaseline.metrics.assigned
    || unassigned.length !== sourceBaseline.metrics.unassigned
    || assignedIds.size !== assigned.length) {
    throw new Error('Потеря назначений при публикации точного FCFS-бейзлайна');
  }
  return {
    status: sourceBaseline.status,
    validationStatus: sourceBaseline.validationStatus,
    publicationAllowed: sourceBaseline.publicationAllowed,
    methodology: 'EXACT_FCFS_SAME_ROUTING_AND_VALIDATOR',
    policy: sourceBaseline.baselinePolicy,
    routes,
    unassigned,
    metrics: {
      total: orderBySourceId.size,
      assigned: assigned.length,
      unassigned: unassigned.length,
      activeEngineers: routes.length,
      distanceKm: assigned.reduce((sum, item) => sum + item.distanceM, 0) / 1000,
      travelMinutes: assigned.reduce((sum, item) => sum + item.travelMinutes, 0),
    },
  };
}

function makeDay(date, endDate, jobs, engineers, sourcePlan, sourceBaseline) {
  const isCurrent = date === endDate;
  const weekday = dayIndex(date);
  const engineerUnavailable = !isCurrent && hash(`${date}:availability`) % 5 === 0;
  const dayOfYear = Math.floor((new Date(`${date}T12:00:00Z`).getTime() - new Date(`${date.slice(0, 4)}-01-01T12:00:00Z`).getTime()) / 86400000);
  const seasonal = 0.04 * Math.sin((dayOfYear - 22) / 365 * Math.PI * 2) + 0.025 * Math.cos((dayOfYear + 51) / 365 * Math.PI * 2);
  const weekdayFactor = [0.68, 0.84, 0.88, 0.9, 0.88, 0.82, 0.72][weekday];
  const noise = ((hash(`${date}:demand`) % 17) - 8) / 100;
  const promotion = hash(`${date}:promotion`) % 37 === 0 ? 0.06 : 0;
  const incident = hash(`${date}:incident`) % 71 === 0 ? 0.06 : 0;
  const holiday = /-(01-0[1-8]|02-23|03-08|05-0[19]|06-12|11-04)$/.test(date) ? -0.34 : 0;
  const demandShare = isCurrent ? 1 : Math.max(0.55, Math.min(1, weekdayFactor + seasonal + noise + promotion + incident + holiday));
  const target = Math.min(jobs.length, Math.max(1, Math.round(jobs.length * demandShare)));
  const selectedJobs = isCurrent
    ? jobs
    : [...jobs].sort((a, b) => hash(`${date}:${a.job_id}:demand`) - hash(`${date}:${b.job_id}:demand`)).slice(0, target);
  const orders = selectedJobs.map(job => normalizeOrder(job, date));
  const orderBySourceId = new Map(orders.map(order => [order.sourceId, order]));
  const orderById = new Map(orders.map(order => [order.id, order]));
  const unavailableEngineerIds = new Set();
  if (engineerUnavailable) unavailableEngineerIds.add(engineers[hash(`${date}:engineer`) % engineers.length]?.engineer_id);
  const team = engineers.filter(engineer => !unavailableEngineerIds.has(engineer.engineer_id)).map(normalizeEngineer);
  const actual = [];
  const routes = sourcePlan.routes.map(route => {
    if (unavailableEngineerIds.has(route.engineerId)) return null;
    const assignments = route.assignments.filter(item => orderBySourceId.has(item.sourceOrderId)).map(item => {
      const order = orderBySourceId.get(item.sourceOrderId);
      const assignment = {
        orderId: order.id,
        engineerId: route.engineerId,
        position: item.position,
        departureAt: item.departureAt,
        arrival: item.arrival,
        plannedStart: item.plannedStart,
        plannedFinish: item.plannedFinish,
        travelMinutes: Number(item.travelMinutes) || 0,
        distanceM: Number(item.distanceM) || 0,
      };
      if (!isCurrent) actual.push(actualVisit(item, order, date));
      return assignment;
    });
    if (!assignments.length) return null;
    const last = assignments.at(-1);
    return {
      engineerId: route.engineerId,
      engineerName: route.engineerName,
      shiftStart: route.shiftStart,
      shiftEnd: route.shiftEnd,
      assignments,
      workloadMinutes: Math.max(0, minutes(last.plannedFinish) - minutes(route.shiftStart)),
      distanceKm: assignments.reduce((sum, item) => sum + item.distanceM, 0) / 1000,
      travelMinutes: assignments.reduce((sum, item) => sum + item.travelMinutes, 0),
    };
  }).filter(Boolean);
  const assignedIds = new Set(routes.flatMap(route => route.assignments.map(item => item.orderId)));
  const sourceUnassigned = new Map(sourcePlan.unassigned.map(item => [item.sourceOrderId, item]));
  const unassigned = orders.filter(order => !assignedIds.has(order.id)).map(order => {
    const source = sourceUnassigned.get(order.sourceId);
    return {
      orderId: order.id,
      reasonCode: source?.reasonCode || 'ENGINEER_UNAVAILABLE',
      reason: source?.reason || 'Подходящий исполнитель отсутствует в смене.',
    };
  });
  const assignments = routes.flatMap(route => route.assignments);
  const waitingMinutes = assignments.reduce((sum, item) => sum + Math.max(0, minutes(item.plannedStart) - minutes(item.arrival)), 0);
  return {
    date,
    dataKind: isCurrent ? 'VERIFIED_CANONICAL_DAY' : 'SYNTHETIC_HISTORY',
    orders,
    team,
    plan: {
      status: isCurrent ? sourcePlan.status : 'SYNTHETIC_HISTORY',
      validationStatus: isCurrent ? sourcePlan.validationStatus : null,
      contentSha256: isCurrent ? sourcePlan.contentSha256 : null,
      routes,
      unassigned,
      metrics: {
        total: orders.length,
        assigned: assignments.length,
        unassigned: unassigned.length,
        activeEngineers: routes.length,
        urgentAssigned: assignments.filter(item => orderById.get(item.orderId)?.priority === 'Авария').length,
        distanceKm: assignments.reduce((sum, item) => sum + item.distanceM, 0) / 1000,
        travelMinutes: assignments.reduce((sum, item) => sum + item.travelMinutes, 0),
        waitingMinutes: isCurrent ? Number(sourcePlan.metrics.waitingMinutes) : waitingMinutes,
      },
      baseline: isCurrent ? normalizeBaseline(sourceBaseline, orderBySourceId) : null,
    },
    actual: isCurrent ? null : { visits: actual },
  };
}

/** Build a reproducible planning and execution history from a source dataset. */
export function generateHistory({ fixture, artifact, endDate, days = DEFAULT_DAYS }) {
  const anchorDate = endDate || String(fixture?.jobs?.[0]?.window_start || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || !Number.isInteger(days) || days < 2) {
    throw new Error('Укажите дату YYYY-MM-DD и число дней не меньше двух');
  }
  const jobs = fixture?.jobs || [];
  const engineers = fixture?.engineers || [];
  const sourcePlan = artifact?.plans?.initial;
  const sourceBaseline = artifact?.plans?.baseline;
  if (!jobs.length || !engineers.length || !sourcePlan?.routes?.length || !sourceBaseline?.routes?.length) throw new Error('Для истории нужны заявки, инженеры, исходный план и точный FCFS-бейзлайн');
  const end = new Date(`${anchorDate}T12:00:00Z`);
  if (Number.isNaN(end.getTime()) || dateKey(end) !== anchorDate) throw new Error('Недопустимая дата окончания');
  return {
    schemaVersion: 1,
    period: { start: dateKey(new Date(end.getTime() - (days - 1) * 86400000)), end: anchorDate },
    days: Array.from({ length: days }, (_, index) => {
      const date = dateKey(new Date(end.getTime() - (days - index - 1) * 86400000));
      return makeDay(date, anchorDate, jobs, engineers, sourcePlan, sourceBaseline);
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const endDate = process.argv.find(value => value.startsWith('--end='))?.slice(6);
  const days = Number(process.argv.find(value => value.startsWith('--days='))?.slice(7) || DEFAULT_DAYS);
  const fixture = JSON.parse(await readFile(new URL('public/test-data/beego-algorithm-initial.json', ROOT), 'utf8'));
  const artifact = JSON.parse(await readFile(new URL('public/data/beego-exact-plans.json', ROOT), 'utf8'));
  const history = generateHistory({ fixture, artifact, endDate, days });
  const output = new URL('public/data/analytics-history.json', ROOT);
  await writeFile(output, `${JSON.stringify(history)}\n`);
  process.stdout.write(`История: ${history.period.start}—${history.period.end}, ${history.days.length} дней, ${fileURLToPath(output)}\n`);
}
