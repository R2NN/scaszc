import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runExactReplan } from '../scripts/exact-replan-runner.mjs';

const fixture = JSON.parse(await readFile(new URL('../public/test-data/beego-algorithm-initial.json', import.meta.url), 'utf8'));
const artifact = JSON.parse(await readFile(new URL('../public/data/beego-exact-plans.json', import.meta.url), 'utf8'));
const clock = value => String(value).match(/T(\d{2}:\d{2})/)?.[1] || String(value).slice(0, 5);

test('a new urgent address is routed, replanned and independently validated by the exact backend', { timeout: 180_000 }, async () => {
  const orders = fixture.jobs.map(job => ({
    id: job.job_id,
    sourceId: job.job_id,
    name: job.job_id,
    start: clock(job.window_start),
    end: clock(job.window_end),
    duration: Number(job.service_duration_min),
    skill: job.required_skill,
    zone: job.zone_name,
    zoneId: job.zone_id,
    coords: [Number(job.latitude), Number(job.longitude)],
    sourceData: job,
  }));
  const team = fixture.engineers.map(engineer => ({
    id: engineer.engineer_id,
    sourceId: engineer.engineer_id,
    name: engineer.engineer_name,
    shiftStart: clock(engineer.shift_start),
    shiftEnd: clock(engineer.shift_end),
    skills: String(engineer.skills).split('|'),
    equipment: String(engineer.equipment).split('|'),
    transport: engineer.transport,
    sourceData: engineer,
  }));
  const emergency = {
    ...artifact.canonical.eventOrder,
    id: 'LIVE-EVENT-001',
    sourceId: 'LIVE-EVENT-001',
    coords: [55.712, 37.771],
    sourceData: {
      ...artifact.canonical.eventOrder.sourceData,
      job_id: 'LIVE-EVENT-001',
      location_id: '',
      latitude: '55.712',
      longitude: '37.771',
    },
  };
  const result = await runExactReplan({
    orders: [...orders, emergency],
    team,
    plan: { contentSha256: artifact.plans.initial.contentSha256 },
    event: { type: 'NEW_ORDER', time: '13:30', orderId: emergency.id },
  }, fileURLToPath(new URL('..', import.meta.url)));

  assert.equal(result.status, 'EXACT_VALID');
  assert.equal(result.publicationAllowed, true);
  assert.equal(result.validation.status, 'VALID');
  assert.equal(result.metrics.assigned, 206);
  assert.equal(result.metrics.unassigned, 0);
  assert.equal(result.metrics.activeEngineers, 28);
  assert.ok(result.exactRouteChecks > 0);
});

test('manual assignment is enforced by exact replanning and validated', { timeout: 180_000 }, async () => {
  const assignmentRoute = artifact.plans.initial.routes.find(route => route.assignments.length);
  const jobId = assignmentRoute.assignments[0].sourceOrderId;
  const orders = fixture.jobs.map(job => ({ id: job.job_id, sourceId: job.job_id, start: clock(job.window_start), end: clock(job.window_end), duration: Number(job.service_duration_min), skill: job.required_skill, zoneId: job.zone_id, coords: [Number(job.latitude), Number(job.longitude)], sourceData: job }));
  const team = fixture.engineers.map(engineer => ({ id: engineer.engineer_id, sourceId: engineer.engineer_id, name: engineer.engineer_name, shiftStart: clock(engineer.shift_start), shiftEnd: clock(engineer.shift_end), skills: String(engineer.skills).split('|'), equipment: String(engineer.equipment).split('|'), transport: engineer.transport, sourceData: engineer }));
  const result = await runExactReplan({
    orders,
    team,
    basePlanContentSha256: artifact.plans.initial.contentSha256,
    event: { type: 'FORCED_ASSIGNMENT', time: '07:00', orderId: jobId, engineerId: assignmentRoute.engineerId },
  }, fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(result.validation.status, 'VALID');
  assert.equal(result.routes.find(route => route.engineerId === assignmentRoute.engineerId)?.assignments.some(item => item.orderId === jobId), true);
  if (fixture.jobs.find(job => job.job_id === jobId)?.required_skill === 'LOCAL') {
    await assert.rejects(runExactReplan({
      orders,
      team,
      basePlanContentSha256: artifact.plans.initial.contentSha256,
      event: { type: 'FORCED_ASSIGNMENT', time: '07:00', orderId: jobId, engineerId: 'EAST-ENG-03' },
    }, fileURLToPath(new URL('..', import.meta.url))), /Закрепление невозможно/);
  }
});
