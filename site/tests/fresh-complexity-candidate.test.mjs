import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ShiftStore } from '../server/shiftStore.mjs';
import { createOperationsApi } from '../server/operationsApi.mjs';

const readJson = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));

test('candidate binds the current duration snapshots to newly searched exact evidence', async () => {
  const candidate = await readJson('../public/data/beego-complexity-plan.json');
  const exact = await readJson('../../algorithm/artifacts/complexity/initial-exact.json');
  const snapshots = await readJson('../../data/object-complexity/dataset/common/duration_snapshots.json');
  const checksum = exact.content_sha256;
  assert.match(checksum, /^[a-f0-9]{64}$/);
  assert.equal(candidate.plan.contentSha256, checksum);
  assert.equal(candidate.plan.datasetSha256, exact.dataset_sha256);
  assert.equal(candidate.provenance.datasetSha256, exact.dataset_sha256);
  assert.equal(candidate.provenance.planningRun.savedPlanReuse, false);
  assert.equal(candidate.orders.length, 205);
  assert.equal(candidate.engineers.length, 35);
  assert.equal(exact.validation.metrics.served_urgent_jobs, 15);
  assert.equal(exact.validation.metrics.unserved_urgent_jobs, 0);
  assert.ok(candidate.plan.metrics.assigned >= 203);
  assert.equal(candidate.plan.metrics.assigned + candidate.plan.metrics.unassigned, 205);
  assert.deepEqual(candidate.plan.candidateDiagnostics, exact.unserved_detailed_audit.jobs);
  for (const jobId of exact.plan.unserved_job_ids) {
    assert.equal(candidate.plan.candidateDiagnostics[jobId].engineers.length, 35);
    assert.equal(candidate.plan.unassigned.find(item => item.sourceOrderId === jobId).diagnosticSummary, exact.unserved_detailed_audit.jobs[jobId].summary_ru);
  }
  for (const order of candidate.orders) {
    assert.equal(order.durationSnapshot.modelVersion, 'duration-2');
    assert.equal(order.duration, snapshots[order.id].total);
    assert.equal(order.durationSnapshot.id, snapshots[order.id].id);
  }
});

test('a fresh operational database seeds only the new candidate plan and duration version', async () => {
  const store = new ShiftStore(':memory:');
  const api = createOperationsApi({ store, seedFromBase: true });
  try {
    const response = await api.handle(new Request('http://localhost/api/shifts?regionId=moscow&date=2026-08-17'));
    assert.equal(response.status, 200);
    const shift = await response.json();
    const candidate = await readJson('../public/data/beego-complexity-plan.json');
    assert.equal(shift.plan.contentSha256, candidate.plan.contentSha256);
    assert.deepEqual(shift.plan.metrics, candidate.plan.metrics);
    assert.ok(shift.orders.every(order => order.durationSnapshot.modelVersion === 'duration-2'));
    const versions = store.db.prepare('SELECT plan_json FROM plan_versions').all();
    assert.equal(versions.length, 1);
    assert.equal(JSON.parse(versions[0].plan_json).contentSha256, candidate.plan.contentSha256);
  } finally { store.close(); }
});
