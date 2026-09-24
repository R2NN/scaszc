import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isCanonicalPlanningInput } from '../scripts/is-canonical-planning-input.mjs';
import { buildExactPlan } from '../worker/index.js';

const fixture = JSON.parse(await readFile(new URL('../public/test-data/beego-algorithm-initial.json', import.meta.url), 'utf8'));
const artifact = JSON.parse(await readFile(new URL('../public/data/beego-exact-plans.json', import.meta.url), 'utf8'));
const clock = value => String(value).match(/T(\d{2}:\d{2})/)?.[1];
const payload = {
  orders: fixture.jobs.map(job => ({ id: job.job_id, sourceId: job.job_id, sourceData: job, start: clock(job.window_start), end: clock(job.window_end), duration: Number(job.service_duration_min), skill: job.required_skill, zoneId: job.zone_id, coords: [Number(job.latitude), Number(job.longitude)], equipment: job.required_equipment })),
  engineers: fixture.engineers.map(engineer => ({ id: engineer.engineer_id, sourceId: engineer.engineer_id, sourceData: engineer, shiftStart: engineer.shift_start, shiftEnd: engineer.shift_end, skills: engineer.skills.split('|').map(value => value.trim()), transport: engineer.transport, startCoords: [Number(engineer.start_latitude), Number(engineer.start_longitude)], equipment: engineer.equipment })),
};

test('sealed plan is used only for matching model inputs', () => {
  assert.equal(isCanonicalPlanningInput(payload, artifact), true);
  assert.equal(isCanonicalPlanningInput({ ...payload, orders: [{ ...payload.orders[0], duration: 80 }, ...payload.orders.slice(1)] }, artifact), false);
  assert.equal(isCanonicalPlanningInput({ ...payload, orders: [{ ...payload.orders[0], transport: payload.orders[0].sourceData.required_transport === 'CAR' ? 'BICYCLE' : 'CAR' }, ...payload.orders.slice(1)] }, artifact), false);
  assert.equal(isCanonicalPlanningInput({ ...payload, engineers: [{ ...payload.engineers[0], shiftStart: '09:00' }, ...payload.engineers.slice(1)] }, artifact), false);
  assert.equal(isCanonicalPlanningInput({ ...payload, planningDate: '2026-09-22' }, artifact), false);
  assert.equal(isCanonicalPlanningInput({ ...payload, sharedInventory: [{ zoneId: 'EAST', equipmentId: 'ONT_GIGABIT', quantity: 0 }] }, artifact), false);
  assert.throws(() => buildExactPlan({ ...payload, orders: [{ ...payload.orders[0], duration: 80 }, ...payload.orders.slice(1)] }, artifact), /новый exact-расчёт/);
  assert.throws(() => buildExactPlan({ ...payload, planningDate: '2026-09-22' }, artifact), /новый exact-расчёт/);
});
