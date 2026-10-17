import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiftStore } from '../server/shiftStore.mjs';
import { decideEngineerFeedback, engineerFeedback, engineerFeedbackImpact, saveEngineerFeedback } from '../server/engineerFeedback.mjs';
import { seedEngineerFeedback } from '../server/engineerFeedbackSeed.mjs';
import { ENGINEER_COMMENT_VERSION, engineerVisitComment } from '../server/engineerFeedbackLanguage.mjs';
import { durationFormula } from '../src/durationPresentation.js';
import { handleComplexity } from '../server/complexityApi.mjs';

const at = '2026-08-10T12:00:00+03:00';
const setup = context => {
  const store = new ShiftStore(':memory:');
  context.after(() => store.close());
  const registry = store.complexity;
  for (const id of ['A', 'B', 'C']) {
    const entities = { object: id, line: `${id}-line` };
    registry.registerObject({ id, address: `Дом ${id}`, regionId: 'moscow', examples: [{ id: `order-${id}`, address: `Дом ${id}`, workType: id === 'B' ? 'Подключение' : 'Локальная заявка', objectId: id, serviceEntities: entities }] }, [{ id: `${id}-line`, kind: 'line', objectId: id }]);
    registry.db.prepare('INSERT INTO service_client_links VALUES (?,?,?,?)').run(id, `${id}-line`, id === 'C' ? 'another-client' : 'same-client', `Счёт ${id === 'C' ? '2' : '1'}`);
  }
  return registry;
};
function add(registry, index, { objectId = 'A', residual = 20, customer = 0, reason = 'diagnosis', repeatability = 'repeat', engineer = index % 2, eligible = true, override = false, source = 'dispatcher' } = {}) {
  const order = registry.object(objectId).examples[0];
  const forecast = registry.estimate({ ...order, ...(override ? { durationOverride: { minutes: 55, reason: 'Ручная оценка' } } : {}) }, '2026-07-30T07:00:00+03:00');
  const date = `2026-08-${String(index + 1).padStart(2, '0')}`;
  const visit = registry.recordVisit({ id: `visit-${index}`, orderId: `archive-${index}`, entities: forecast.entities, kind: forecast.kind, operation: forecast.operation, factorTechnical: forecast.factorTechnical, forecast, startedAt: `${date}T09:00:00+03:00`, endedAt: `${date}T11:00:00+03:00`, knownAt: `${date}T11:00:00+03:00`, total: forecast.factorTechnical + forecast.documents + residual + customer, actualTechnical: eligible ? forecast.factorTechnical + residual : null, accessMinutes: 0, documentMinutes: forecast.documents, customerMinutes: customer, eligible, reason, engineerId: `engineer-${engineer}`, engineerName: `Инженер ${engineer}`, source, finding: reason === 'customer' ? 'Нужно дождаться представителя по договору' : 'Повторная проверка контакта линии' });
  const reply = saveEngineerFeedback(registry, visit.id, { at: `${date}T11:10:00+03:00`, comment: `Измерение по наряду ${index}: причина проверена на месте`, finding: visit.finding, reason, repeatability, proposedScope: reason === 'customer' ? 'client' : 'line' });
  return { visit, reply };
}
const decision = (id, action = 'confirm', scope = 'line') => ({ expectedRevision: 1, action, scope, at, reason: 'Проверены наряды и измерения разных инженеров', actor: 'Оператор' });

test('recommendation uses a chronological holdout, matches actual next calculation and preserves past forecasts', context => {
  const registry = setup(context);
  for (let i = 0; i < 4; i++) add(registry, i);
  const oldForecasts = registry.visits().map(item => JSON.stringify(item.forecast));
  const report = engineerFeedbackImpact(registry, 'visit-3', { at });
  assert.equal(report.recommendation.ready, true);
  assert.equal(report.recommendation.minutes, 9);
  assert.equal(report.recommendation.validation.trainCount, 3);
  assert.equal(report.recommendation.validation.testCount, 1);
  assert.equal(report.preview.length, 1);
  assert.equal(report.preview[0].after, 39);
  assert.throws(() => registry.decide({ ...decision('visit-3'), visitId: 'visit-3' }), /Обратная связь/);
  const condition = decideEngineerFeedback(registry, 'visit-3', decision('visit-3'));
  assert.equal(condition.feedbackPolicy.version, 'feedback-evidence-v1');
  assert.ok(engineerFeedbackImpact(registry, 'visit-3', { at }).audit.some(item => item.action === 'DECISION_CONFIRM'));
  assert.equal(registry.estimate(registry.object('A').examples[0], at).total, report.preview[0].after);
  assert.deepEqual(registry.visits().map(item => JSON.stringify(item.forecast)), oldForecasts);
  assert.equal(registry.estimate(registry.object('B').examples[0], at).total, 70);
  const saved = registry.estimate(registry.object('A').examples[0], at);
  registry.recordVisit({ ...registry.visits()[0], id: 'later', forecast: saved, endedAt: '2026-08-11T11:00:00+03:00', knownAt: '2026-08-11T11:00:00+03:00' });
  const history = engineerFeedbackImpact(registry, 'visit-3', { at: '2026-08-12T12:00:00+03:00' }).history;
  assert.ok(history.some(item => item.before === 30 && item.after === 39 && item.delta === 9));
});

test('customer waiting transfers only through the explicit account and stays separate from technical work', context => {
  const registry = setup(context);
  for (let i = 0; i < 4; i++) add(registry, i, { objectId: i % 2 ? 'B' : 'A', reason: 'customer', residual: 0, customer: 12 });
  const report = engineerFeedbackImpact(registry, 'visit-3', { at, scope: 'client' });
  assert.equal(report.recommendation.ready, true);
  assert.equal(report.preview.length, 2);
  assert.deepEqual(report.preview.map(item => item.delta), [5, 5]);
  decideEngineerFeedback(registry, 'visit-3', decision('visit-3', 'confirm', 'client'));
  const snapshot = registry.estimate(registry.object('A').examples[0], at);
  assert.equal(snapshot.technical, 30);
  assert.equal(snapshot.customer, 5);
  assert.equal(snapshot.total, 35);
  assert.equal(registry.estimate(registry.object('B').examples[0], at).total, 75);
  assert.equal(registry.estimate(registry.object('C').examples[0], at).total, 30);
  assert.equal(durationFormula(snapshot).rows.reduce((sum, item) => sum + item.minutes, 0), snapshot.total);
  assert.throws(() => registry.estimate({ ...registry.object('A').examples[0], clientId: 'another-client' }, at), /Лицевой счёт/);
});

test('consistent faster work reduces the next estimate without changing the base normative', context => {
  const registry = setup(context);
  for (let i = 0; i < 4; i++) add(registry, i, { residual: -10, reason: 'simpler' });
  const report = engineerFeedbackImpact(registry, 'visit-3', { at });
  assert.equal(report.recommendation.ready, true);
  assert.equal(report.recommendation.minutes, -4);
  assert.equal(report.preview[0].after, 26);
  decideEngineerFeedback(registry, 'visit-3', decision('visit-3'));
  const next = registry.estimate(registry.object('A').examples[0], at);
  assert.equal(next.baseTechnical, 30);
  assert.equal(next.total, 26);
});

test('one-off, unknown, incomplete and manual measurements never become a transferable rule', context => {
  const registry = setup(context);
  add(registry, 0, { repeatability: 'once' });
  add(registry, 1, { reason: 'unknown' });
  add(registry, 2, { eligible: false });
  add(registry, 3, { override: true });
  const report = engineerFeedbackImpact(registry, 'visit-0', { at });
  assert.equal(report.recommendation.count, 0);
  assert.equal(report.recommendation.ready, false);
  assert.throws(() => decideEngineerFeedback(registry, 'visit-0', decision('visit-0')), /разовый случай/);
  assert.equal(registry.estimate(registry.object('A').examples[0], at).total, 30);
});

test('contradictory later results, one engineer and unsupported building-wide transfer are blocked', context => {
  const registry = setup(context);
  for (let i = 0; i < 4; i++) add(registry, i, { residual: i === 3 ? -20 : 20 });
  const report = engineerFeedbackImpact(registry, 'visit-3', { at });
  assert.equal(report.recommendation.ready, false);
  assert.ok(report.recommendation.reasons.some(reason => reason.includes('не уменьшила ошибку')));
  assert.ok(engineerFeedbackImpact(registry, 'visit-0', { at, scope: 'object' }).recommendation.reasons.some(reason => reason.includes('одной линии')));
  assert.ok(engineerFeedbackImpact(registry, 'visit-0', { at, scope: 'operation' }).recommendation.reasons.some(reason => reason.includes('трёх домах')));
});

test('confirmed feedback stops affecting new estimates after fresh measurements contradict it', context => {
  const registry = setup(context);
  for (let i = 0; i < 4; i++) add(registry, i);
  decideEngineerFeedback(registry, 'visit-3', decision('visit-3'));
  assert.equal(registry.estimate(registry.object('A').examples[0], at).total, 39);
  const known = registry.visits()[0];
  for (let i = 0; i < 3; i++) registry.recordVisit({ ...known, id: `drift-${i}`, actualTechnical: 10, endedAt: `2026-08-${12 + i}T11:00:00+03:00`, knownAt: `2026-08-${12 + i}T11:00:00+03:00`, engineerId: `drift-engineer-${i}` });
  assert.equal(registry.estimate(registry.object('A').examples[0], '2026-08-16T12:00:00+03:00').total, 30);
});

test('reply revisions reject stale writes, retain prior versions and remain queryable at their original time', context => {
  const registry = setup(context);
  const { visit } = add(registry, 0);
  saveEngineerFeedback(registry, visit.id, { expectedRevision: 1, at, comment: 'Дополнение после повторного звонка', finding: visit.finding, reason: 'diagnosis', proposedScope: 'line', repeatability: 'once' });
  assert.throws(() => saveEngineerFeedback(registry, visit.id, { expectedRevision: 1, at, comment: 'Устаревшая форма' }), /уже изменён/);
  assert.equal(engineerFeedback(registry, 'A', '2026-08-02T12:00:00+03:00')[0].revision, 1);
  const report = engineerFeedbackImpact(registry, visit.id, { at });
  assert.equal(report.revisions.length, 2);
  assert.equal(report.reply.revision, 2);
  assert.equal(report.recommendation.ready, false);
});

test('synthetic enrichment is idempotent and changes neither original facts nor forecast snapshots', context => {
  const registry = setup(context);
  for (let i = 0; i < 4; i++) add(registry, i, { residual: i % 2 ? -5 : 20, source: 'synthetic-independent-stage-simulator-v2' });
  registry.db.prepare('DELETE FROM engineer_feedback').run();
  const before = registry.db.prepare('SELECT payload_json FROM duration_visits ORDER BY id,revision').all();
  const snapshots = registry.db.prepare('SELECT * FROM duration_snapshots').all();
  assert.equal(seedEngineerFeedback(registry).added, 4);
  assert.equal(seedEngineerFeedback(registry).added, 0);
  assert.deepEqual(registry.db.prepare('SELECT payload_json FROM duration_visits ORDER BY id,revision').all(), before);
  assert.deepEqual(registry.db.prepare('SELECT * FROM duration_snapshots').all(), snapshots);
  assert.equal(new Set(engineerFeedback(registry, 'A').map(item => item.comment)).size, 4);
});

test('engineer prose follows visit context and keeps machine timing and transfer decisions out of the message', () => {
  const base = { id: 'HIST-V2-27082026-5-1', engineerId: 'e', total: 71, forecast: { total: 78 }, kind: 'connection', reason: 'unknown', factors: { line: 'new', devices: 2 }, customerMinutes: 0 };
  assert.match(engineerVisitComment(base), /кабел|лини|проклад/i);
  assert.match(engineerVisitComment({ ...base, kind: 'emergency', factors: { readyConfig: true } }), /конфигурац|настройк/i);
  assert.match(engineerVisitComment({ ...base, factors: { line: 'existing' } }), /готов|существующ|новая линия/i);
  assert.match(engineerVisitComment({ ...base, total: 100, customerMinutes: 15 }), /клиент/i);
  assert.match(engineerVisitComment({ ...base, total: 220 }), /не записал|не вспомню|не указал/i);
  const previousMessage = engineerVisitComment(base);
  assert.notEqual(engineerVisitComment(base, [previousMessage]), previousMessage);
  const messages = new Set();
  for (const kind of ['connection', 'local', 'equipment', 'emergency', 'information']) for (const reason of ['unknown', 'access', 'diagnosis', 'simpler', 'customer']) for (let index = 0; index < 30; index++) {
    const visit = { ...base, id: `${kind}-${reason}-${index}`, kind, reason, total: index % 2 ? 71 : 90 };
    const message = engineerVisitComment(visit);
    assert.equal(message, engineerVisitComment(visit));
    assert.ok(message.length > 25 && message.length < 230);
    assert.doesNotMatch(message, /ARCHIVE|наряд|\d+\s*мин|фактическ|норматив|повторных наблюдений|будущих заказ|этап|перенос|подтверждаю/i);
    messages.add(message);
  }
  assert.ok(messages.size >= 65, `Only ${messages.size} distinct accounts`);
});

test('fixture copy refresh is idempotent and preserves human replies, decisions and measured data', context => {
  const registry = setup(context);
  for (let i = 0; i < 3; i++) add(registry, i, { source: 'synthetic-independent-stage-simulator-v2' });
  registry.db.prepare('DELETE FROM engineer_feedback').run();
  seedEngineerFeedback(registry);
  const fixture = engineerFeedback(registry, 'A').find(item => item.visitId === 'visit-0');
  const legacy = { ...fixture, comment: 'Фактическую длительность записал. Работа 40 мин, оформление 10 мин.' };
  delete legacy.commentVersion;
  registry.db.prepare('UPDATE engineer_feedback SET payload_json=? WHERE visit_id=?').run(JSON.stringify(legacy), 'visit-0');
  saveEngineerFeedback(registry, 'visit-1', { expectedRevision: 1, at, comment: 'Контакт снова пропал, пришлось перепроверить.', reason: 'diagnosis' });
  const human = engineerFeedback(registry, 'A').find(item => item.visitId === 'visit-1');
  const guard = { ...engineerFeedback(registry, 'A').find(item => item.visitId === 'visit-2'), comment: 'Уточнил по телефону: ждал клиента.', recordedBy: 'Оператор' };
  delete guard.commentVersion;
  registry.db.prepare('UPDATE engineer_feedback SET payload_json=? WHERE visit_id=?').run(JSON.stringify(guard), 'visit-2');
  const before = registry.db.prepare('SELECT * FROM duration_visits ORDER BY id,revision').all();
  const snapshots = registry.db.prepare('SELECT * FROM duration_snapshots ORDER BY id').all();
  const conditions = registry.conditions();
  assert.equal(seedEngineerFeedback(registry).updated, 1);
  const rows = engineerFeedback(registry, 'A');
  const refreshed = rows.find(item => item.visitId === 'visit-0');
  assert.equal(refreshed.commentVersion, ENGINEER_COMMENT_VERSION);
  assert.notEqual(refreshed.comment, legacy.comment);
  const { comment: oldComment, ...oldMetadata } = legacy;
  const { comment: newComment, commentVersion, ...newMetadata } = refreshed;
  assert.deepEqual(newMetadata, oldMetadata);
  assert.deepEqual(rows.find(item => item.visitId === 'visit-1'), human);
  assert.deepEqual(rows.find(item => item.visitId === 'visit-2'), guard);
  assert.equal(seedEngineerFeedback(registry).updated, 0);
  assert.deepEqual(registry.db.prepare('SELECT * FROM duration_visits ORDER BY id,revision').all(), before);
  assert.deepEqual(registry.db.prepare('SELECT * FROM duration_snapshots ORDER BY id').all(), snapshots);
  assert.deepEqual(registry.conditions(), conditions);
});

test('HTTP confirmation enforces the same evidence checks as the store', async context => {
  const registry = setup(context);
  add(registry, 0);
  const response = await handleComplexity(new Request('http://local/api/complexity/visits/visit-0/feedback/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(decision('visit-0')) }), registry);
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /Нужно ещё/);
});

test('a completed deviation requests an explanation while retaining all measured stages', context => {
  const registry = setup(context);
  const order = registry.object('A').examples[0];
  const forecast = registry.estimate(order, at);
  const shift = { id: 'shift', date: '2026-08-10', orders: [{ ...order, durationSnapshot: forecast }], team: [{ id: 'e', name: 'Инженер' }], plan: { routes: [{ engineerId: 'e', assignments: [{ orderId: order.id }] }] } };
  registry.recordShiftFact(shift, { orderId: order.id, status: 'completed', startedAt: '10:00', time: '10:50', accessMinutes: 0, documentMinutes: 0, customerMinutes: 0, deviationReason: 'diagnosis' }, {}, 'Оператор');
  const reply = engineerFeedback(registry, 'A')[0];
  assert.equal(reply.status, 'awaiting');
  assert.equal(registry.visits()[0].actualTechnical, 50);
  saveEngineerFeedback(registry, reply.visitId, { expectedRevision: 1, comment: 'Потребовалась повторная проверка контакта', finding: 'Нестабильный контакт', reason: 'diagnosis', proposedScope: 'line', repeatability: 'repeat' });
  assert.equal(engineerFeedback(registry, 'A')[0].status, 'received');
  assert.equal(engineerFeedback(registry, 'A')[0].revision, 2);
  assert.equal(registry.visits()[0].actualTechnical, 50);
});

test('a new correction must not be worse than forecasts that already include history', context => {
  const registry = setup(context);
  for (let i = 0; i < 4; i++) add(registry, i);
  const latest = registry.visits().find(item => item.id === 'visit-3');
  registry.recordVisit({ ...latest, forecast: { ...latest.forecast, technical: 49, total: 49 }, knownAt: '2026-08-05T12:00:00+03:00' });
  const report = engineerFeedbackImpact(registry, 'visit-3', { at });
  assert.equal(report.recommendation.ready, false);
  assert.ok(report.recommendation.reasons.some(reason => reason.includes('хуже уже сохранённого')));
});

test('a single engineer and an expired cause cannot authorize transfer', context => {
  const registry = setup(context);
  for (let i = 0; i < 4; i++) add(registry, i, { engineer: 1 });
  let report = engineerFeedbackImpact(registry, 'visit-3', { at });
  assert.ok(report.recommendation.reasons.some(reason => reason.includes('двух инженеров')));
  const reply = engineerFeedback(registry, 'A').find(item => item.visitId === 'visit-3');
  saveEngineerFeedback(registry, 'visit-3', { ...reply, expectedRevision: 1, at: '2026-08-05T12:00:00+03:00', validUntil: '2026-08-06T12:00:00+03:00' });
  report = engineerFeedbackImpact(registry, 'visit-3', { at });
  assert.ok(report.recommendation.reasons.some(reason => reason.includes('Срок действия')));
});

test('closed conditions cannot be revived from measurements made before their closure', context => {
  const registry = setup(context);
  for (let i = 0; i < 4; i++) add(registry, i);
  const condition = decideEngineerFeedback(registry, 'visit-3', decision('visit-3'));
  registry.closeCondition(condition.id, { at: '2026-08-11T12:00:00+03:00', reason: 'Причина устранена и проверена', actor: 'Оператор' });
  const report = engineerFeedbackImpact(registry, 'visit-3', { at: '2026-08-12T12:00:00+03:00' });
  assert.equal(report.recommendation.count, 0);
  assert.equal(report.recommendation.ready, false);
  assert.ok(report.recommendation.reasons.some(reason => reason.includes('Прежняя особенность закрыта')));
  assert.equal(registry.estimate(registry.object('A').examples[0], '2026-08-12T12:00:00+03:00').total, 30);
});
