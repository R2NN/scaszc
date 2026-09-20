import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildExactPlan } from '../worker/index.js';

const root = new URL('../', import.meta.url);
const artifact = JSON.parse(await readFile(new URL('public/data/beego-exact-plans.json', root), 'utf8'));
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
    assigned: 204,
    unassigned: 1,
    contentSha256: '4cfa1ba6dde2c53c0140ec743e2eca0fc2472c609a4835c125231dc3fe5f54b4',
  }),
  event: verify('event', fixture.jobs, {
    assigned: 205,
    unassigned: 1,
    contentSha256: 'ca004c47a11cd8eeef0569ecfcb7613d99eb8aa1d2f263c1cb8575143e30a489',
  }),
};

assert.equal(artifact.canonical.eventOrder.sourceId, 'EAST-EVENT-001');
console.log(JSON.stringify(result, null, 2));
