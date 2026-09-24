import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildExactPlan } from '../worker/index.js';

const root = new URL('../', import.meta.url);
const artifact = JSON.parse(await readFile(new URL('public/data/beego-exact-plans.json', root), 'utf8'));
assert.equal(artifact.schedulePostprocessing, undefined);
assert.equal(artifact.plans.event.sourcePlanContentSha256, artifact.plans.initial.contentSha256);
const fixture = JSON.parse(await readFile(new URL('public/test-data/beego-algorithm-integration.json', root), 'utf8'));
const engineers = fixture.engineers.map((engineer) => ({
  id: engineer.engineer_id,
  name: engineer.engineer_name,
  regionId: 'moscow',
}));

const verify = (scenario, jobs, expected) => {
  const orders = jobs.map((job, index) => ({ id: index + 1, sourceId: job.job_id, regionId: 'moscow' }));
  const plan = buildExactPlan({ regionId: 'moscow', orders, engineers }, artifact);
  assert.equal(plan.status, 'EXACT_VALID');
  assert.equal(plan.publicationAllowed, true);
  assert.equal(plan.validation.status, 'VALID');
  assert.equal(plan.contentSha256, expected.contentSha256);
  assert.equal(plan.metrics.assigned, expected.assigned);
  assert.equal(plan.metrics.unassigned, expected.unassigned);

  const assignments = plan.routes.flatMap((route) => route.assignments);
  const allIds = [...assignments.map((item) => item.orderId), ...plan.unassigned.map((item) => item.orderId)];
  assert.equal(new Set(allIds).size, orders.length, `${scenario}: duplicate or missing order`);
  assert.equal(allIds.length, orders.length, `${scenario}: order coverage mismatch`);
  assert.ok(
    assignments.every((item) => (
      item.geometry.length > 1
      || (item.travelMinutes === 0 && item.distanceM === 0)
    )),
    `${scenario}: route leg without geometry or a valid identity transition`,
  );
  assert.ok(assignments.every((item) => /^\d{2}:\d{2}$/.test(item.plannedStart) && /^\d{2}:\d{2}$/.test(item.plannedFinish)), `${scenario}: invalid local time`);
  return {
    status: plan.status,
    assigned: plan.metrics.assigned,
    unassigned: plan.metrics.unassigned,
    activeRoutes: plan.routes.filter((route) => route.assignments.length).length,
    routeLegsWithGeometry: assignments.filter((item) => item.geometry.length > 1).length,
    identityTransitions: assignments.filter((item) => (
      item.geometry.length === 0 && item.travelMinutes === 0 && item.distanceM === 0
    )).length,
    contentSha256: plan.contentSha256,
  };
};

const initialJobs = fixture.jobs.filter((job) => job.is_event_job !== 'true');
const result = {
  initial: verify('initial', initialJobs, {
    assigned: 205,
    unassigned: 0,
    contentSha256: '2089fec94974a5858ac4f7bbbb1fe6598fe9cf1b4cba5161f79f277f4a0f3dd4',
  }),
  event: verify('event', fixture.jobs, {
    assigned: 206,
    unassigned: 0,
    contentSha256: '60d4f8a98aa69ceeacf7ee86b0d46ae89d58e739876bff03923c52ab99c9a882',
  }),
};

const baseline = artifact.plans.baseline;
assert.equal(baseline.status, 'EXACT_VALID');
assert.equal(baseline.validationStatus, 'VALID');
assert.equal(baseline.publicationAllowed, true);
assert.equal(baseline.datasetSha256, artifact.plans.initial.datasetSha256);
assert.equal(baseline.planningAt, artifact.plans.initial.planningAt);
const baselineAssignments = baseline.routes.flatMap(route => route.assignments);
const baselineIds = [
  ...baselineAssignments.map(item => item.sourceOrderId),
  ...baseline.unassigned.map(item => item.sourceOrderId),
];
assert.equal(baselineIds.length, initialJobs.length);
assert.equal(new Set(baselineIds).size, initialJobs.length);
assert.deepEqual(new Set(baselineIds), new Set(initialJobs.map(job => job.job_id)));
assert.ok(baselineAssignments.every(item => item.geometry.length > 1
  || (item.travelMinutes === 0 && item.distanceM === 0)));
assert.equal(baselineAssignments.length, baseline.metrics.assigned);
assert.equal(baseline.unassigned.length, baseline.metrics.unassigned);
assert.equal(baseline.routes.filter(route => route.assignments.length).length, baseline.metrics.activeEngineers);
result.baseline = {
  status: baseline.status,
  assigned: baseline.metrics.assigned,
  unassigned: baseline.metrics.unassigned,
  activeRoutes: baseline.metrics.activeEngineers,
  distanceKm: baseline.metrics.distanceKm,
  contentSha256: baseline.contentSha256,
};

assert.equal(artifact.canonical.eventOrder.sourceId, 'EAST-EVENT-001');
console.log(JSON.stringify(result, null, 2));
