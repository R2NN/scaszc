import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ShiftStore } from '../server/shiftStore.mjs';
import { RatingStore } from '../server/ratingStore.mjs';
import { seedBaseShift } from '../server/seedBaseShift.mjs';
import { customerPreferencesForShift, seedCustomerPreferenceExamples } from '../server/customerPreferences.mjs';
import { createRatingApi } from '../server/ratingApi.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('demo customer requests are explicit, idempotent and do not fabricate visits or change the operational plan', async () => {
  const store = new ShiftStore(':memory:');
  try {
    await seedBaseShift(store);
    const ratings = new RatingStore(store.db); await ratings.seed();
    const shift = store.byDate('moscow', '2026-08-17'), before = JSON.stringify(shift);
    const reviews = store.db.prepare('SELECT count(*) AS n FROM rating_reviews').get().n;
    const visits = store.db.prepare('SELECT count(*) AS n FROM rating_visits').get().n;
    seedCustomerPreferenceExamples(ratings, shift);
    const version = ratings.version();
    seedCustomerPreferenceExamples(ratings, shift);
    assert.equal(ratings.version(), version);
    const requests = customerPreferencesForShift(store.db, shift);
    assert.equal(requests.filter(item => item.evidence.some(rule => rule.id.startsWith('DEMO-RELATION-'))).length, 4);
    assert.ok(requests.every(item => item.synthetic));
    assert.ok(requests.filter(item => item.avoidEngineerIds.length).length >= 1);
    assert.equal(customerPreferencesForShift(store.db, { ...shift, date: '2026-07-31' }).length, 0);
    assert.equal(customerPreferencesForShift(store.db, { ...shift, regionId: 'another-region' }).length, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM rating_reviews').get().n, reviews);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM rating_visits').get().n, visits);
    assert.equal(JSON.stringify(store.get(shift.id)), before);
  } finally { store.close(); }
});

test('repeat requests require customer IDs; 1-star exclusions follow exact addresses and review decisions', async () => {
  const store = new ShiftStore(':memory:');
  try {
    await seedBaseShift(store);
    const ratings = new RatingStore(store.db); await ratings.seed();
    const shift = store.byDate('moscow', '2026-08-17'), engineer = ratings.catalog()[0];
    const visit = { id: 'PREF-VISIT', engineerId: engineer.id, status: 'completed', address: 'Москва, Тестовая, 1, кв. 7', clientId: 'ACCOUNT-1', provenance: 'OPERATIONAL_COMPLETED_FACT' };
    store.db.prepare('INSERT INTO rating_visits VALUES (?,?,?)').run(visit.id, engineer.id, JSON.stringify(visit));
    const result = ratings.addReview({ visitId: visit.id, client: 'Анна', clientId: 'ACCOUNT-1', score: 5, comment: 'Хочу снова этого мастера', preferred: true });
    const review = result.reviews.find(item => item.visitId === visit.id);
    const order = { id: 'NEXT', sourceId: 'NEXT', clientId: 'ACCOUNT-1', address: visit.address };
    const next = { ...shift, date: '2026-12-01', orders: [order] };
    assert.equal(customerPreferencesForShift(store.db, next)[0].preferredEngineerIds[0], engineer.id);
    assert.equal(customerPreferencesForShift(store.db, { ...next, orders: [{ ...order, clientId: 'ANOTHER', client: 'Анна' }] }).length, 0);
    assert.equal(customerPreferencesForShift(store.db, { ...next, date: '2026-01-01' }).length, 0);
    store.db.prepare('UPDATE rating_reviews SET payload_json=? WHERE id=?').run(JSON.stringify({ ...review, correction: { score: 2 } }), review.id);
    assert.equal(customerPreferencesForShift(store.db, next).length, 0);
    store.db.prepare('UPDATE rating_reviews SET payload_json=? WHERE id=?').run(JSON.stringify(review), review.id);
    store.db.prepare('UPDATE rating_reviews SET score=1 WHERE id=?').run(review.id);
    const negative = customerPreferencesForShift(store.db, next)[0];
    assert.deepEqual(negative.preferredEngineerIds, []);
    assert.deepEqual(negative.avoidEngineerIds, [engineer.id]);
    assert.equal(customerPreferencesForShift(store.db, { ...next, orders: [{ ...order, address: 'Москва, Тестовая, 1, кв. 8' }] }).length, 0);
    store.db.prepare('UPDATE rating_reviews SET included=0 WHERE id=?').run(review.id);
    assert.equal(customerPreferencesForShift(store.db, next).length, 0);
  } finally { store.close(); }
});

test('exact preference assignment preserves every visit, road proof, coverage and locked performer', () => {
  const code = `
from dataclasses import replace
from pathlib import Path
from beeline_planning import load_planning_dataset, validate_initial_plan
from beeline_planning.export import load_exact_plan_artifact
from customer_preferences import apply_customer_preferences
from plan_by_rating import operational_profile
d=load_planning_dataset(Path('data/object-complexity/dataset'),'core')
p,_=load_exact_plan_artifact(Path('algorithm/artifacts/complexity/initial-exact.json'),d.dataset_sha256)
r=next(r for r in p.engineer_plans if r.visits)
e=d.engineers[r.engineer_id]
clone='FAMILIAR-ENGINEER'
d=replace(d,engineers={**d.engineers,clone:replace(e,engineer_id=clone)})
c=[{'id':key,'rating':{'score':4.8}} for key in d.engineers]
request={'jobId':r.visits[0].job_id,'orderId':'NEXT','preferredEngineerIds':[clone],'avoidEngineerIds':[]}
def run(request,candidates=c,locked=frozenset()):
 out,report=apply_customer_preferences(d,p,candidates,[request],locked,operational_profile,4.2,5)
 assert validate_initial_plan(d,out).is_valid
 assert out.unserved_job_ids==p.unserved_job_ids
 assert sorted((tuple(v.job_id for v in r.visits),r.visits) for r in out.engineer_plans)==sorted((tuple(v.job_id for v in r.visits),r.visits) for r in p.engineer_plans)
 assert len(out.engineer_plans)==len(p.engineer_plans)
 return out,report[0]
out,report=run(request)
assert report['status']=='preferred' and report['engineerId']==clone
_,report=run({**request,'avoidEngineerIds':[clone]})
assert report['engineerId']!=clone
_,report=run(request,[{**x,'rating':{'score':3}} if x['id']==clone else x for x in c])
assert report['status']=='not_applied'
_,report=run(request,locked={r.engineer_id})
assert report['engineerId']==r.engineer_id and report['status']=='not_applied'
same=[x['id'] for x in c if operational_profile(d.engineers[x['id']])==operational_profile(e)]
_,report=run({**request,'preferredEngineerIds':[],'avoidEngineerIds':same})
assert report['status']=='unavoidable'
if p.unserved_job_ids:
 _,report=run({**request,'jobId':p.unserved_job_ids[0]})
 assert report['status']=='unassigned'
print('All exact invariants and preference fallbacks passed.')
`;
  const result = spawnSync(process.env.BEEGO_PYTHON || 'python', ['-c', code], { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PYTHONPATH: path.join(root, 'algorithm/src') + path.delimiter + path.join(root, 'algorithm/tools'), PYTHONUTF8: '1' }, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('changed customer requests invalidate an awaiting composition before any planner can run', async () => {
  const store = new ShiftStore(':memory:');
  try {
    await seedBaseShift(store);
    let calls = 0;
    const api = createRatingApi(store, { calculateStaffing: async () => { calls++; throw new Error('Must not run'); } });
    const post = (path, value) => api(new Request(`http://localhost/api/ratings/${path}`, { method: 'POST', body: JSON.stringify(value) }));
    const result = await post('scenarios', { kind: 'staffing', regionId: 'moscow', date: '2026-08-17', pool: 'all', settings: { qualityFloor: 4.2, qualityCeiling: 5 } });
    assert.equal(result.status, 201);
    const scenario = await result.json();
    const row = store.db.prepare('SELECT id,payload_json FROM rating_customer_requests LIMIT 1').get();
    store.db.prepare('UPDATE rating_customer_requests SET payload_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.payload_json), engineerId: 'UNKNOWN' }), row.id);
    const confirmation = await post(`scenarios/${scenario.id}/confirm`, {});
    assert.equal(confirmation.status, 409);
    assert.match((await confirmation.json()).error, /Пожелания клиентов изменились/);
    assert.equal(calls, 0);
  } finally { store.close(); }
});
