import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRatingApi } from '../server/ratingApi.mjs';
import { ShiftStore } from '../server/shiftStore.mjs';
import { RatingStore, ratingSummary } from '../server/ratingStore.mjs';
import { seedBaseShift } from '../server/seedBaseShift.mjs';
import { calculateRatingPlan } from '../server/ratingPlanning.mjs';
import { loadLocalVariables } from '../server/loadLocalVariables.mjs';

test('Bayesian rating accounts for review count and exclusions', () => {
  assert.equal(ratingSummary([]).score, 4.2);
  assert.ok(ratingSummary(Array.from({length: 100}, () => ({score:5}))).score > ratingSummary([{score:5}]).score);
  const result = ratingSummary([{score:5},{score:1,included:false}]);
  assert.equal(result.count, 1); assert.equal(result.excluded, 1); assert.equal(result.average, 5);
});

test('history, feedback, decisions, concurrency and isolated scenarios persist', async () => {
  const shifts = new ShiftStore(':memory:'); const store = new RatingStore(shifts.db);
  try {
    await store.seed(); await store.seed();
    const catalog = store.catalog();
    assert.equal(catalog.length, 1035); assert.equal(catalog.filter(item => item.kind === 'staff').length, 35);
    store.syncRoster([{id:'NEW-STAFF',sourceId:'NEW-STAFF',regionId:'moscow',name:'Новый специалист'}]);
    assert.equal(store.engineer('NEW-STAFF').rating.score,4.2);
    assert.equal(store.engineer('NEW-STAFF').rating.count,0);
    assert.equal(shifts.db.prepare('SELECT COUNT(*) n FROM visit_facts').get().n, 0);
    const current = store.case('RC-1'); assert.equal(current.review.score, 1);
    const before = store.engineer(current.engineer.id).rating;
    assert.throws(() => store.decide(current.id, { expectedRevision: 0 }), /измен/);
    assert.throws(() => store.decide(current.id, { expectedRevision: 1, reason: 'short' }), /причину/);
    const message = store.sendMessage(current.id, { role: 'engineer', text: 'Уточнение по результатам визита.' });
    assert.equal(message.messages.at(-1).author, current.engineer.name);
    assert.throws(() => store.sendMessage(current.id, { text: '', attachments: [{url:'https://invalid.example/a.png'}] }), /прикрепить/);
    const resolved = store.decide(current.id, { expectedRevision: 1, outcome: 'NOT_ENGINEER_FAULT', reason: 'Проверили: жалоба относится к ожиданию назначения.', response: 'Оценка исключена из расчёта.', actor: 'QA' });
    assert.equal(resolved.status, 'RESOLVED'); assert.equal(resolved.review.score, 1); assert.equal(resolved.review.included, false);
    assert.ok(store.engineer(current.engineer.id).rating.score > before.score);
    assert.equal(resolved.decisions[0].actor, 'QA'); assert.equal(store.case(current.id).messages.at(-1).text, 'Оценка исключена из расчёта.');
    assert.throws(() => store.sendMessage(current.id,{text:'message'}), /завершено/);
    store.reopen(current.id); assert.equal(store.case(current.id).status, 'IN_PROGRESS');
    const engineer = store.engineer(catalog[0].id), visit = engineer.pendingVisits[0];
    const updated = store.addReview({ visitId: visit.id, engineerId: 'FORGED', client: 'Клиент QA', score: 4, comment: 'Работа выполнена аккуратно.' });
    assert.equal(updated.id, engineer.id); assert.equal(updated.rating.count, engineer.rating.count + 1);
    assert.throws(() => store.addReview({visitId: visit.id}), /уже получен/);
    assert.throws(() => store.addReview({visitId: 'MISSING'}), /завершённого/);
    const review = updated.reviews.find(item => item.visitId === visit.id);
    const appeal = store.createCase({reviewId: review.id, text: 'Прошу проверить обстоятельства этого визита.'});
    assert.equal(appeal.review.id, review.id); assert.equal(appeal.messages[0].role, 'engineer');
    assert.equal(store.createCase({reviewId: review.id, text: 'Duplicate appeal'}).id, appeal.id);
    const scenario = store.createScenario({regionId:'moscow',date:'2026-08-17',ratingVersion:store.version()});
    assert.throws(() => store.saveScenario(scenario.id), /проверенный/);
    store.updateScenario(scenario.id,{...scenario,status:'READY',plan:{status:'EXACT_VALID',validation:{status:'VALID'}}});
    assert.equal(store.saveScenario(scenario.id).saved,true);
    store.bump(); assert.throws(() => store.saveScenario(scenario.id), /изменились/);
    assert.equal(shifts.db.prepare('SELECT COUNT(*) n FROM shifts').get().n,0);
  } finally { shifts.close(); }
});

test('completed operational feedback is attributed to the published performer', async () => {
  const shifts = new ShiftStore(':memory:'), store = new RatingStore(shifts.db);
  try {
    const order = { id:'JOB',name:'Подключение',regionId:'moscow',address:'Москва',coords:[55.7,37.6] };
    const engineer = {id:'ACTUAL',name:'Исполнитель',regionId:'moscow'};
    const plan = {status:'EXACT_VALID',publicationAllowed:true,validation:{status:'VALID'},contentSha256:'qa-hash',routes:[{engineerId:engineer.id,assignments:[{orderId:order.id}]}],unassigned:[]};
    const shift = shifts.ensure({regionId:'moscow',date:'2026-08-17',orders:[order],team:[engineer],plan});
    shifts.recordFact(shift.id,{orderId:'JOB',status:'started',time:'09:05'});
    store.syncCompletedVisits(); assert.equal(shifts.db.prepare('SELECT COUNT(*) n FROM rating_visits').get().n,0);
    shifts.recordFact(shift.id,{orderId:'JOB',status:'completed',time:'10:00'});
    store.syncCompletedVisits(); store.syncCompletedVisits();
    const visit = store.engineer('ACTUAL').pendingVisits[0];
    assert.equal(visit.provenance,'OPERATIONAL_COMPLETED_FACT'); assert.ok(visit.planVersionId);
    const result = store.addReview({visitId:visit.id,engineerId:'WRONG',client:'Анна',score:5,comment:'Спасибо за подключение.'});
    assert.equal(result.id,'ACTUAL'); assert.equal(result.rating.count,1);
  } finally { shifts.close(); }
});

test('decision API persists rating impact and history through reopening the database', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'beego-rating-decision-'));
  const file = path.join(directory, 'ratings.sqlite3');
  let shifts = new ShiftStore(file), api = createRatingApi(shifts);
  const request = (target, input) => api(new Request(`http://localhost/api/ratings/${target}`, input ? { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(input) } : {}));
  try {
    const before = await (await request('cases/RC-35')).json();
    const initialVersion = (await (await request('engineers')).json()).version;
    const payload = { expectedRevision:before.revision, outcome:'NOT_ENGINEER_FAULT', reason:'Проверка подтвердила внешнюю причину жалобы.', response:'Оценка исключена из расчёта рейтинга.', actor:'Диспетчер проверки', followUpRequired:true };
    const invalid = await request('cases/RC-35/decision', {...payload,reason:'мало'});
    assert.equal(invalid.status,422);
    assert.equal((await (await request('cases/RC-35')).json()).revision,before.revision);
    const response = await request('cases/RC-35/decision',payload);
    assert.equal(response.status,200);
    const saved = await response.json(), decision = saved.decisions.at(-1);
    assert.equal(saved.status,'RESOLVED'); assert.equal(saved.review.included,false);
    assert.equal(saved.review.score,before.review.score);
    assert.deepEqual(decision.ratingBefore,before.engineer.rating);
    assert.deepEqual(decision.ratingAfter,saved.engineer.rating);
    assert.equal(decision.ratingAfter.count,decision.ratingBefore.count-1);
    assert.ok(decision.ratingAfter.score>decision.ratingBefore.score);
    assert.equal(decision.followUpRequired,true);
    assert.equal((await request('cases/RC-35/decision',payload)).status,409);
    shifts.close(); shifts = new ShiftStore(file); api = createRatingApi(shifts);
    const retained = await (await request('cases/RC-35')).json();
    assert.deepEqual(retained.decisions,saved.decisions);
    assert.equal(retained.review.included,false);
    assert.equal(retained.messages.at(-1).text,payload.response);
    assert.equal((await (await request('engineers')).json()).version,initialVersion+1);
    const reopened = await (await request('cases/RC-35/reopen',{})).json();
    const restored = await (await request('cases/RC-35/decision',{...payload,expectedRevision:reopened.revision,outcome:'VALID',response:'Повторная проверка: отзыв учитывается.'})).json();
    assert.equal(restored.review.included,true); assert.equal(restored.decisions.length,2);
    assert.deepEqual(restored.engineer.rating,before.engineer.rating);
    const correctionCase = await (await request('cases/RC-35/reopen',{})).json();
    const correction = {...payload,expectedRevision:correctionCase.revision,outcome:'CORRECTED',correctedScore:5,clientConfirmed:true,clientConfirmation:{method:'written',details:'Клиент подтвердил пять звёзд в обращении QA-123.'}};
    assert.equal((await request('cases/RC-35/decision',{...correction,clientConfirmed:false})).status,422);
    assert.equal((await (await request('cases/RC-35')).json()).revision,correctionCase.revision);
    const correctedResponse = await request('cases/RC-35/decision',correction);
    assert.equal(correctedResponse.status,200);
    const corrected = await correctedResponse.json();
    assert.equal(corrected.review.score,5); assert.equal(corrected.review.originalScore,before.review.score);
    assert.equal(shifts.db.prepare('SELECT score FROM rating_reviews WHERE id=?').get(before.review.id).score,before.review.score);
    assert.equal(corrected.engineer.rating.count,before.engineer.rating.count);
    assert.ok(corrected.engineer.rating.score>before.engineer.rating.score);
    assert.equal(corrected.decisions.at(-1).correctedScore,5);
    assert.equal(corrected.decisions.at(-1).clientConfirmation.details,correction.clientConfirmation.details);
    const catalog = await (await request('engineers')).json();
    assert.deepEqual(catalog.engineers.find(item=>item.id===corrected.engineer.id).rating,corrected.engineer.rating);
    shifts.close(); shifts = new ShiftStore(file); api = createRatingApi(shifts);
    const retainedCorrection = await (await request('cases/RC-35')).json();
    assert.equal(retainedCorrection.review.score,5); assert.equal(retainedCorrection.review.originalScore,before.review.score);
    assert.deepEqual(retainedCorrection.decisions,corrected.decisions);
    const reopenedCorrection = await (await request('cases/RC-35/reopen',{})).json();
    const excludedCorrection = await (await request('cases/RC-35/decision',{...payload,expectedRevision:reopenedCorrection.revision,outcome:'CLIENT_ERROR'})).json();
    assert.equal(excludedCorrection.review.included,false); assert.equal(excludedCorrection.review.score,5);
    assert.equal(excludedCorrection.decisions.at(-1).originalScore,before.review.score);
    assert.equal(excludedCorrection.decisions.at(-1).previousScore,5);
  } finally {
    shifts.close();
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('beego-rating-decision-'));
    await rm(directory,{recursive:true,force:true});
  }
});

test('real rating optimizer covers 205 jobs without mutating source plan or road evidence', async () => {
  loadLocalVariables();
  const shifts = new ShiftStore(':memory:'), store = new RatingStore(shifts.db);
  try {
    await store.seed();
    await seedBaseShift(shifts);
    const shift = shifts.byDate('moscow','2026-08-17');
    const before = JSON.stringify(shifts.get(shift.id));
    const scenario = store.createScenario({regionId:'moscow',date:shift.date,pool:'all',ratingVersion:store.version()});
    const result = await calculateRatingPlan(shift,store.catalog(),scenario);
    assert.equal(result.plan.status,'EXACT_VALID'); assert.equal(result.plan.validation.status,'VALID');
    assert.equal(result.plan.metrics.assigned,205); assert.equal(result.candidateCount,1035);
    assert.ok(result.plan.ratingAverage > result.sourceRating);
    assert.ok(result.team.some(item => item.kind === 'reserve'));
    assert.equal(JSON.stringify(shifts.get(shift.id)),before);
    assert.equal(new Set(result.plan.routes.flatMap(route=>route.assignments.map(item=>item.orderId))).size,205);
    assert.ok(result.plan.routes.every(route=>route.assignments.every(item=>item.geometry?.length>=2)));
    assert.equal(result.plan.metrics.distanceKm,shift.plan.metrics.distanceKm);
  } finally { shifts.close(); }
});
