import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = process.cwd();
const parentRoot = path.resolve(repositoryRoot, '..');
const defaultHandoffRoot = existsSync(path.join(repositoryRoot, 'algorithm'))
  ? repositoryRoot
  : parentRoot;
const handoffRoot = path.resolve(process.env.BEEGO_ALGORITHM_HOME || defaultHandoffRoot);
const datasetRoot = path.join(handoffRoot, 'data', 'dataset');
const planningRoot = path.join(handoffRoot, 'algorithm', 'artifacts', 'current');
const initialPlanPath = path.resolve(
  process.env.BEEGO_INITIAL_PLAN
    || path.join(planningRoot, 'initial-exact-205-of-205-retimed.json'),
);
const eventPlanPath = path.resolve(
  process.env.BEEGO_EVENT_PLAN
    || path.join(planningRoot, 'event-exact-206-of-206-retimed.json'),
);
const baselinePlanPath = path.resolve(
  process.env.BEEGO_BASELINE_PLAN
    || path.join(planningRoot, 'baseline-fcfs-exact.json'),
);
const outputPath = path.join(repositoryRoot, 'public', 'data', 'beego-exact-plans.json');
const integrationDataPath = path.join(repositoryRoot, 'public', 'test-data', 'beego-algorithm-integration.json');

const parseDelimited = (text, delimiter = ';') => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [headers = [], ...records] = rows;
  return records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
};

const readCsv = async (relativePath) => parseDelimited(
  (await readFile(path.join(datasetRoot, relativePath), 'utf8')).replace(/^\uFEFF/, ''),
);

const clock = (value) => {
  if (!value) return '';
  const iso = String(value).match(/T(\d{2}:\d{2})/);
  return iso?.[1] || String(value).slice(0, 5);
};

const addMinutes = (value, amount) => {
  const [hours, minutes] = clock(value).split(':').map(Number);
  const total = Math.max(0, (hours * 60) + minutes + Number(amount || 0));
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const jobs = await readCsv(path.join('core', 'jobs.csv'));
const engineers = await readCsv(path.join('common', 'engineers.csv'));
const engineerSkills = await readCsv(path.join('common', 'engineer_skills.csv'));
const engineerEquipment = await readCsv(path.join('common', 'engineer_equipment.csv'));
const offices = await readCsv(path.join('common', 'offices.csv'));
const locations = await readCsv(path.join('common', 'locations.csv'));

const jobById = new Map(jobs.map((job) => [job.job_id, job]));
const engineerById = new Map(engineers.map((engineer) => [engineer.engineer_id, engineer]));
const locationById = new Map(locations.map((location) => [location.location_id, location]));
const officeById = new Map(offices.map((office) => [office.office_id, office]));
const skillsByEngineer = new Map();
const equipmentByEngineer = new Map();
for (const row of engineerSkills) {
  const values = skillsByEngineer.get(row.engineer_id) || [];
  values.push(row.skill_id);
  skillsByEngineer.set(row.engineer_id, values);
}
for (const row of engineerEquipment) {
  const values = equipmentByEngineer.get(row.engineer_id) || [];
  values.push(row.equipment_id);
  equipmentByEngineer.set(row.engineer_id, values);
}

const compactPlan = async (planPath, scenario) => {
  const sourceText = await readFile(planPath, 'utf8');
  const source = JSON.parse(sourceText);
  if (source.status !== 'EXACT_VALID' || source.publication_allowed !== true || source.validation?.status !== 'VALID') {
    throw new Error(`${planPath} is not a publishable exact plan`);
  }
  const explanations = new Map((source.explanations?.jobs || []).map((item) => [item.job_id, item]));
  const routes = source.plan.engineer_plans.map((route) => {
    const engineer = engineerById.get(route.engineer_id) || {};
    const shiftStart = clock(engineer.shift_start || '08:00');
    const rawAssignments = route.visits.map((visit, index) => {
      const job = jobById.get(visit.job_id) || {};
      const travelMinutes = Number(visit.travel?.duration_minutes || 0);
      const distanceM = Number(visit.travel?.distance_m || 0);
      const plannedStart = clock(visit.service_start_at);
      return {
        sourceOrderId: visit.job_id,
        engineerId: route.engineer_id,
        position: index + 1,
        departureAt: clock(visit.departure_at),
        arrival: addMinutes(visit.departure_at, travelMinutes),
        plannedStart,
        plannedFinish: addMinutes(visit.service_start_at, Number(job.service_duration_min || 0)),
        travelMinutes,
        distanceM,
        manual: false,
        claimLevel: explanations.get(visit.job_id)?.claim_level || 'EXACT_VALIDATED',
        explanation: explanations.get(visit.job_id)?.summary_ru || '',
        geometry: Array.isArray(visit.travel?.geometry) ? visit.travel.geometry : [],
      };
    });
    const assignments = rawAssignments;
    const waitingMinutes = assignments.reduce((sum, assignment) => {
      const arrivalMinutes = Number(assignment.arrival.slice(0, 2)) * 60 + Number(assignment.arrival.slice(3, 5));
      const startAtMinutes = Number(assignment.plannedStart.slice(0, 2)) * 60 + Number(assignment.plannedStart.slice(3, 5));
      return sum + Math.max(0, startAtMinutes - arrivalMinutes);
    }, 0);
    const shiftEnd = clock(engineer.shift_end || '18:00');
    const final = assignments.at(-1);
    const startMinutes = Number(shiftStart.slice(0, 2)) * 60 + Number(shiftStart.slice(3, 5));
    const finishMinutes = final ? Number(final.plannedFinish.slice(0, 2)) * 60 + Number(final.plannedFinish.slice(3, 5)) : startMinutes;
    return {
      engineerId: route.engineer_id,
      engineerName: engineer.engineer_name || route.engineer_id,
      shiftStart,
      shiftEnd,
      assignments,
      workloadMinutes: Math.max(0, finishMinutes - startMinutes),
      distanceKm: Math.round(assignments.reduce((sum, item) => sum + item.distanceM, 0) / 100) / 10,
      travelMinutes: assignments.reduce((sum, item) => sum + item.travelMinutes, 0),
      waitingMinutes,
      delayedDepartures: 0,
    };
  });
  const unassigned = source.plan.unserved_job_ids.map((sourceOrderId) => {
    const explanation = explanations.get(sourceOrderId);
    return {
      sourceOrderId,
      reasonCode: explanation?.decision_kind || 'UNSERVED',
      reason: explanation?.summary_ru || 'Алгоритм не нашёл допустимое назначение',
      claimLevel: explanation?.claim_level || 'BEST_CHECKED',
    };
  });
  const metrics = source.validation.metrics;
  const assigned = Number(metrics.served_urgent_jobs || 0) + Number(metrics.served_normal_jobs || 0);
  const unassignedCount = Number(metrics.unserved_urgent_jobs || 0) + Number(metrics.unserved_normal_jobs || 0);
  return {
    scenario,
    artifactType: source.artifact_type,
    status: source.status,
    publicationAllowed: source.publication_allowed,
    validationStatus: source.validation.status,
    datasetSha256: source.dataset_sha256,
    contentSha256: source.content_sha256,
    sourcePlanContentSha256: source.source_plan_content_sha256 || null,
    planningAt: source.plan.planning_at,
    routes,
    unassigned,
    metrics: {
      total: assigned + unassignedCount,
      assigned,
      unassigned: unassignedCount,
      activeEngineers: Number(metrics.used_engineers || 0),
      urgentAssigned: Number(metrics.served_urgent_jobs || 0),
      distanceKm: Math.round(Number(metrics.total_distance_m || 0) / 100) / 10,
      travelMinutes: Number(metrics.total_travel_minutes || 0),
      waitingMinutes: routes.reduce((sum, route) => sum + route.waitingMinutes, 0),
    },
    event: source.explanations?.event || null,
    baselinePolicy: source.baseline_policy || null,
    routingConfiguration: source.routing_configuration || null,
    sourceFileSha256: sha256(sourceText),
  };
};

const initial = await compactPlan(initialPlanPath, 'initial');
const event = await compactPlan(eventPlanPath, 'event');
const baseline = await compactPlan(baselinePlanPath, 'baseline');
if (event.sourcePlanContentSha256 !== initial.contentSha256) {
  throw new Error('Event plan was not replanned from the published initial plan');
}
const artifact = {
  version: 1,
  algorithm: 'beeline-planning-ortools-exact-v2.1-validated-departure-timing',
  provider: 'LOCAL_GTFS_RASP_VALHALLA',
  canonical: {
    initialJobIds: jobs.filter((job) => job.is_event_job !== 'true').map((job) => job.job_id).sort(),
    eventJobIds: jobs.map((job) => job.job_id).sort(),
    engineerIds: engineers.map((engineer) => engineer.engineer_id).sort(),
    jobModels: Object.fromEntries(jobs.map(job => [job.job_id, {
      zone_id: job.zone_id,
      window_start: job.window_start,
      window_end: job.window_end,
      service_duration_min: job.service_duration_min,
      priority: job.priority,
      required_skill: job.required_skill,
      required_transport: job.required_transport,
      required_equipment: job.required_equipment,
      latitude: job.latitude,
      longitude: job.longitude,
    }])),
    engineerModels: Object.fromEntries(engineers.map(engineer => {
      const office = officeById.get(engineer.start_office_id);
      const location = locationById.get(office?.location_id);
      return [engineer.engineer_id, {
        zone_id: engineer.zone_id,
        shift_start: engineer.shift_start,
        shift_end: engineer.shift_end,
        transport_type: engineer.transport_type,
        start_office_id: engineer.start_office_id,
        skills: [...(skillsByEngineer.get(engineer.engineer_id) || [])].sort(),
        equipment: [...(equipmentByEngineer.get(engineer.engineer_id) || [])].sort(),
        latitude: location?.latitude,
        longitude: location?.longitude,
      }];
    })),
    eventOrder: (() => {
      const job = jobs.find((item) => item.job_id === 'EAST-EVENT-001');
      return job ? {
        sourceId: job.job_id,
        name: `Авария ${job.job_id}`,
        address: job.address,
        start: clock(job.window_start),
        end: clock(job.window_end),
        duration: Number(job.service_duration_min || 60),
        priority: 'Авария',
        workType: job.hd_type || job.bk_type,
        skill: 'Аварийные работы',
        equipment: job.required_equipment,
        transport: job.required_transport,
        district: job.district,
        zone: job.zone_name,
        zoneId: job.zone_id,
        serviceType: job.hd_type,
        isEventJob: true,
        scenario: job.scenario,
        createdAt: job.created_at,
        regionId: 'moscow',
        status: job.status || 'Новая',
        coords: [Number(job.latitude), Number(job.longitude)],
        geocodeStatus: 'ready',
        sourceData: job,
      } : null;
    })(),
  },
  plans: { initial, event, baseline },
};

const integrationEngineers = engineers.map((engineer) => {
  const office = officeById.get(engineer.start_office_id);
  const location = locationById.get(office?.location_id);
  return {
    engineer_id: engineer.engineer_id,
    engineer_name: engineer.engineer_name,
    skills: (skillsByEngineer.get(engineer.engineer_id) || []).join(' | '),
    shift_start: engineer.shift_start,
    shift_end: engineer.shift_end,
    transport: engineer.transport_type,
    equipment: (equipmentByEngineer.get(engineer.engineer_id) || []).join(' | '),
    start_address: location?.normalized_address || location?.source_address || '',
    start_latitude: location?.latitude || '',
    start_longitude: location?.longitude || '',
    zone: engineer.zone_name || engineer.zone_id,
    status: engineer.is_available === 'true' ? 'Доступен сегодня' : 'Недоступен',
  };
});

await mkdir(path.dirname(outputPath), { recursive: true });
await mkdir(path.dirname(integrationDataPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact)}\n`, 'utf8');
await writeFile(integrationDataPath, `${JSON.stringify({ jobs, engineers: integrationEngineers }, null, 2)}\n`, 'utf8');
await writeFile(
  path.join(path.dirname(integrationDataPath), 'beego-algorithm-initial.json'),
  `${JSON.stringify({ jobs: jobs.filter((job) => job.is_event_job !== 'true'), engineers: integrationEngineers }, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify({
  outputPath,
  integrationDataPath,
  sourcePlans: {
    initial: initialPlanPath,
    event: eventPlanPath,
    baseline: baselinePlanPath,
  },
  plans: Object.fromEntries(Object.entries(artifact.plans).map(([key, plan]) => [key, {
    assigned: plan.metrics.assigned,
    unassigned: plan.metrics.unassigned,
    routes: plan.routes.filter(route => route.assignments.length).length,
    contentSha256: plan.contentSha256,
  }])),
}, null, 2));
