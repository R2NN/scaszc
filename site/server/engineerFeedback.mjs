import { calculateDuration, conditionEvidence, digest, feedbackEvidenceCheck, matchesConditionWork, REASONS } from './durationModel.mjs';

const parse = row => row && JSON.parse(row.payload_json);
const scopes = ['object', 'entrance', 'node', 'line', 'client', 'operation'];
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2 : 0; };
const stamp = () => new Date().toISOString();

/** Keep engineer messages versioned separately from immutable visit measurements. */
export function setupEngineerFeedback(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS engineer_feedback(visit_id TEXT NOT NULL,revision INTEGER NOT NULL,object_id TEXT NOT NULL,submitted_at TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(visit_id,revision));
    CREATE INDEX IF NOT EXISTS engineer_feedback_object ON engineer_feedback(object_id);
    CREATE TABLE IF NOT EXISTS service_client_links(object_id TEXT NOT NULL,line_id TEXT NOT NULL,client_id TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(object_id,line_id));`);
}

/** Resolve a client only through an explicit account-to-service-line registry link. */
export function feedbackClient(registry, entities) {
  if (!entities?.object || !entities?.line) return null;
  registry.feedbackClientQuery ||= registry.db.prepare('SELECT client_id AS id,label FROM service_client_links WHERE object_id=? AND line_id=?');
  return registry.feedbackClientQuery.get(entities.object, entities.line) || null;
}

/** Return every latest message for an object, keeping earlier versions available in the impact report. */
export function engineerFeedback(registry, objectId, at = '9999-12-31T23:59:59Z') {
  return registry.db.prepare('SELECT f.payload_json FROM engineer_feedback f WHERE object_id=? AND julianday(submitted_at)<=julianday(?) AND revision=(SELECT max(n.revision) FROM engineer_feedback n WHERE n.visit_id=f.visit_id AND julianday(n.submitted_at)<=julianday(?)) ORDER BY submitted_at DESC,visit_id').all(objectId, at, at).map(parse);
}

/** Persist a reply or an outstanding request without changing the measured stages or published plans. */
export function saveEngineerFeedback(registry, visitId, input, { seed = false, request = false, seedVisit } = {}) {
  return registry.db.transaction(() => {
    const visit = seed && seedVisit?.id === visitId ? seedVisit : registry.visits().find(item => item.id === visitId);
    if (!visit) throw new Error('Визит не найден.');
    const before = parse(registry.db.prepare('SELECT payload_json FROM engineer_feedback WHERE visit_id=? ORDER BY revision DESC LIMIT 1').get(visitId));
    if (!seed && Number(input.expectedRevision || 0) !== (before?.revision || 0)) throw new Error('Ответ уже изменён. Обновите паспорт перед сохранением.');
    const at = input.at || stamp();
    if (!Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(visit.endedAt || visit.startedAt) || (before && Date.parse(at) < Date.parse(before.submittedAt))) throw new Error('Ответ не может предшествовать визиту или предыдущему ответу.');
    const reason = input.reason || visit.reason || 'unknown';
    const validUntil = input.validUntil || null;
    if (validUntil && (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= Date.parse(at))) throw new Error('Срок временной причины должен быть позже ответа.');
    const proposedScope = input.proposedScope || 'object';
    if (!Object.hasOwn(REASONS, reason) || !scopes.includes(proposedScope)) throw new Error('Выберите причину и область применения ответа.');
    if (proposedScope === 'client' && !feedbackClient(registry, visit.entities)) throw new Error('Клиент не связан с лицевым счётом в реестре. Перенос по адресу запрещён.');
    if (!['once', 'repeat', 'unsure'].includes(input.repeatability || 'unsure')) throw new Error('Укажите повторяемость причины.');
    const comment = String(input.comment || '').trim();
    if (!request && !comment) throw new Error('Запишите пояснение инженера: почему визит занял другое время.');
    const finding = String(input.finding || visit.finding || '').trim().slice(0, 2000);
    const findingKey = reason === visit.reason && visit.findingKey && finding === visit.finding ? visit.findingKey : `feedback:${digest([reason, finding.toLocaleLowerCase('ru-RU')]).slice(0, 18)}`;
    const reply = { visitId, objectId: visit.entities.object, revision: (before?.revision || 0) + 1, status: request ? 'awaiting' : 'received', submittedAt: at, validUntil, engineerId: visit.engineerId, engineerName: visit.engineerName || input.engineerName || 'Исполнитель не указан', recordedBy: input.actor || 'Диспетчер', source: seed ? 'synthetic-feedback-v1' : 'dispatcher', reason, comment: comment.slice(0, 3000), finding, findingKey, preparation: String(input.preparation || '').trim().slice(0, 2000), proposedScope, repeatability: input.repeatability || 'unsure' };
    registry.db.prepare('INSERT INTO engineer_feedback VALUES (?,?,?,?,?)').run(visitId, reply.revision, reply.objectId, at, JSON.stringify(reply));
    registry.audit(reply.objectId, request ? 'ENGINEER_FEEDBACK_REQUESTED' : 'ENGINEER_FEEDBACK_RECEIVED', request ? 'Нужно пояснение отклонения от плана' : 'Получено пояснение инженера', before, reply, input.actor || 'Диспетчер', at);
    return reply;
  })();
}

/** Build a conservative recommendation from comparable causes and a chronological holdout. */
export function feedbackRecommendation(registry, visit, reply, scope, at) {
  const model = registry.model(at);
  const component = reply.reason === 'access' ? 'access' : reply.reason === 'customer' ? 'customer' : 'technical';
  const entities = { ...visit.entities, client: feedbackClient(registry, visit.entities)?.id };
  const probe = { scope, component, entityId: scope === 'operation' ? visit.operation : entities[scope], reason: reply.reason, findingKey: reply.findingKey, kind: visit.kind, operation: visit.operation };
  const closedBoundary = Math.max(0, ...registry.conditions().filter(item => item.reason === probe.reason && item.findingKey === probe.findingKey && matchesConditionWork(item, { ...visit, entities })).flatMap(item => [item.closedAt, item.validUntil]).filter(value => value && Date.parse(value) <= Date.parse(at)).map(Date.parse));
  const replies = registry.db.prepare('SELECT f.payload_json FROM engineer_feedback f WHERE julianday(submitted_at)<=julianday(?) AND revision=(SELECT max(n.revision) FROM engineer_feedback n WHERE n.visit_id=f.visit_id AND julianday(n.submitted_at)<=julianday(?))').all(at, at).map(parse);
  const byId = new Map(replies.map(item => [item.visitId, item]));
  const evidence = registry.visits(at).filter(item => Date.parse(item.endedAt) > closedBoundary).map(item => {
    const response = byId.get(item.id);
    if (!response) return item;
    if (response.status !== 'received' || response.repeatability !== 'repeat' || ['rejected', 'visit'].includes(item.learningDecision)) return { ...item, learningDecision: 'visit' };
    return { ...item, entities: { ...item.entities, client: feedbackClient(registry, item.entities)?.id }, reason: response.reason, findingKey: response.findingKey, learningDecision: 'confirmed' };
  });
  const inliers = conditionEvidence(probe, evidence, at, model).sort((a, b) => a.visit.endedAt.localeCompare(b.visit.endedAt));
  const validation = feedbackEvidenceCheck(conditionEvidence(probe, evidence, at, model, { trim: false }), model, component);
  const { minimum } = validation;
  const { days, engineers } = feedbackEvidenceCheck(inliers, model, component);
  const reasons = [];
  if (reply.status !== 'received') reasons.push('Инженер ещё не прислал пояснение');
  if (reply.validUntil && Date.parse(reply.validUntil) <= Date.parse(at)) reasons.push('Срок действия причины закончился');
  if (closedBoundary && inliers.length < minimum) reasons.push('Прежняя особенность закрыта или истекла: нужны новые измерения после её окончания');
  if (reply.repeatability !== 'repeat') reasons.push(reply.repeatability === 'once' ? 'Инженер отметил разовый случай' : 'Повторяемость причины не подтверждена');
  if (['unknown', 'other'].includes(reply.reason)) reasons.push('Нужна установленная причина, а не только отклонение времени');
  if (!reply.finding?.trim()) reasons.push('Опишите конкретную повторяющуюся особенность');
  if (component === 'customer' && scope !== 'client') reasons.push('Ожидание клиента можно переносить только на его лицевой счёт');
  if (!probe.entityId) reasons.push('Нет подтверждённой связи с выбранной областью');
  if (scope === 'node' && !visit.forecast?.factors?.requiresNode) reasons.push('Визит не требовал посещения узла');
  if (!visit.eligible || visit.excluded || visit.forecast?.override) reasons.push('Нужно полное пригодное измерение без ручной длительности');
  if (inliers.length < minimum) reasons.push(`Нужно ещё ${minimum - inliers.length} сопоставимых измерений; минимум ${model.history.minimum} для оценки и более поздние визиты для проверки`);
  if (days < 2) reasons.push('Нужны подтверждения в разные дни');
  if (engineers < 2) reasons.push('Нужны наблюдения хотя бы двух инженеров');
  if (scope === 'object' && new Set(inliers.map(item => item.visit.entities?.line).filter(Boolean)).size < 2) reasons.push('Данные одной линии нельзя переносить на весь дом: проверьте другие линии или сузьте область');
  if (scope === 'operation' && new Set(inliers.map(item => item.visit.entities?.object)).size < 3) reasons.push('Для переноса на похожие работы нужны подтверждения минимум в трёх домах');
  if (inliers.length && validation.directionShare < .75) reasons.push('Наблюдения противоречат друг другу: направление отклонения нестабильно');
  if (validation.trainCount >= model.history.minimum && !(validation.adjustedError < validation.baselineError)) reasons.push('Поправка не уменьшила ошибку на более поздних визитах');
  if (validation.trainCount >= model.history.minimum && validation.adjustedError > validation.referenceError) reasons.push('Новая поправка хуже уже сохранённого адаптивного прогноза');
  const minutes = Math.round(median(inliers.map(item => item.residual)) * inliers.length / (inliers.length + model.history.shrinkage));
  if (!minutes) reasons.push('Устойчивая поправка в целых минутах не выявлена');
  if (!feedbackEvidenceCheck(inliers, model, component).safe && !reasons.length) reasons.push('Поправка не прошла проверку на устойчивых измерениях');
  return { probe, ready: reasons.length === 0, reasons, count: inliers.length, minimum, days, engineers, minutes, policy: model.history, evidenceIds: inliers.map(item => item.visit.id), evidence: inliers.map(({ visit: item, residual }) => ({ id: item.id, objectId: item.entities.object, address: registry.object(item.entities.object)?.address, endedAt: item.endedAt, engineerName: item.engineerName, orderId: item.orderId, residual })), validation };
}

/** Explain every known affected order and retained calculation, without editing a published schedule. */
export function engineerFeedbackImpact(registry, visitId, { at = stamp(), scope } = {}) {
  const visit = registry.visits(at).find(item => item.id === visitId);
  if (!visit) throw new Error('Визит не найден.');
  const reply = engineerFeedback(registry, visit.entities.object, at).find(item => item.visitId === visitId);
  if (!reply) throw new Error('Пояснение ещё не запрошено.');
  const recommendation = feedbackRecommendation(registry, visit, reply, scope || reply.proposedScope, at);
  const conditions = registry.conditions().filter(item => Date.parse(item.knownAt) <= Date.parse(at) && (item.evidenceIds?.includes(visitId) || (item.reason === reply.reason && item.findingKey === reply.findingKey && matchesConditionWork(item, visit))));
  const relatedIds = new Set(conditions.map(item => item.id));
  const influenced = (item, forecast) => item.evidence ? item.evidence.some(source => source.id === visitId) : relatedIds.has(item.conditionId) && conditions.some(condition => condition.id === item.conditionId && condition.evidenceIds?.includes(visitId)) && Date.parse(forecast.asOf) >= Date.parse(visit.knownAt);
  const forecastAffected = forecast => (forecast?.histories || []).some(item => influenced(item, forecast));
  const history = [];
  const historicalRow = (forecast, details) => {
    if (!forecastAffected(forecast)) return;
    const involved = forecast.histories.filter(item => influenced(item, forecast));
    const before = withoutHistory(forecast, new Set(involved.map(item => item.conditionId)));
    history.push({ ...details, before, after: forecast.total, delta: forecast.total - before, snapshotId: forecast.id, modelVersion: forecast.modelVersion, causes: involved.map(item => ({ conditionId: item.conditionId, minutes: item.minutes, evidence: item.evidence })) });
  };
  for (const item of registry.visits(at)) historicalRow(item.forecast, { key: `visit:${item.id}`, source: 'Визит', objectId: item.entities.object, address: registry.object(item.entities.object)?.address, orderId: item.orderId, at: item.forecast?.asOf, visitId: item.id, kind: item.kind });
  const orders = new Map(registry.objects().flatMap(object => (object.examples || []).map(order => [String(order.id), { order, address: object.address, objectId: object.id }])));
  for (const row of registry.db.prepare('SELECT p.*,s.service_date FROM plan_versions p JOIN shifts s ON s.id=p.shift_id ORDER BY p.created_at').all()) {
    for (const order of JSON.parse(row.orders_json)) {
      historicalRow(order.durationSnapshot, { key: `plan:${row.id}:${order.id}`, source: `План ${row.service_date}, версия ${row.version}`, objectId: order.objectId, address: order.address, orderId: order.sourceId || order.id, at: order.durationSnapshot?.asOf, kind: order.durationSnapshot?.kind });
    }
  }
  for (const row of registry.db.prepare('SELECT s.* FROM shifts s WHERE service_date=(SELECT max(n.service_date) FROM shifts n WHERE n.region_id=s.region_id)').all()) for (const order of JSON.parse(row.orders_json)) orders.set(String(order.id), { order, address: order.address, objectId: order.objectId, serviceDate: row.service_date, planVersion: row.revision });
  const preview = [];
  const proposalVisits = registry.visits(at).map(item => recommendation.evidenceIds.includes(item.id) ? { ...item, reason: reply.reason, findingKey: reply.findingKey, learningDecision: 'confirmed' } : item);
  const model = registry.model(at);
  for (const item of orders.values()) {
    const links = registry.links(item.order);
    if (recommendation.probe.scope !== 'operation' && links[recommendation.probe.scope] !== recommendation.probe.entityId && !conditions.some(condition => condition.scope === 'operation' || links[condition.scope] === condition.entityId)) continue;
    const defaults = registry.object(links.object)?.orderDefaults?.[String(item.order.sourceId || item.order.id)] || {};
    const shape = calculateDuration({ ...item.order, durationFactors: { ...defaults.durationFactors, ...item.order.durationFactors } }, { asOf: at, entities: links, model });
    if (!matchesConditionWork(recommendation.probe, shape) && !conditions.some(condition => matchesConditionWork(condition, shape))) continue;
    const current = registry.estimate(item.order, at);
    const relevant = conditions.filter(condition => matchesConditionWork(condition, current));
    const ids = new Set(relevant.map(condition => condition.id));
    const applied = current.histories.filter(part => ids.has(part.conditionId));
    if (!applied.length && !matchesConditionWork(recommendation.probe, current)) continue;
    const before = withoutHistory(current, ids);
    const proposal = { ...recommendation.probe, id: 'PROPOSED-FEEDBACK', status: 'confirmed', knownAt: at, validFrom: at, feedbackPolicy: { version: 'feedback-evidence-v1' } };
    const after = applied.length ? current.total : recommendation.ready && !current.override ? calculateDuration({ ...item.order, durationFactors: current.factors }, { asOf: at, model: registry.model(at), entities: current.entities, visits: proposalVisits, conditions: [...registry.conditions(current.entities.object), proposal] }).total : before;
    preview.push({ orderId: item.order.sourceId || item.order.id, objectId: current.entities.object, address: item.address, kind: current.kind, savedMinutes: item.order.durationSnapshot?.total ?? item.order.duration, before, after, delta: after - before, state: current.override ? 'manual' : applied.length ? 'applied' : recommendation.ready ? after === before ? 'shadowed' : 'proposed' : 'insufficient', serviceDate: item.serviceDate, planVersion: item.planVersion });
  }
  const revisions = registry.db.prepare('SELECT payload_json FROM engineer_feedback WHERE visit_id=? AND julianday(submitted_at)<=julianday(?) ORDER BY revision DESC').all(visitId, at).map(parse);
  const relatedObjects = [...new Set([visit.entities.object, ...conditions.map(item => item.objectId)])];
  const audit = [...new Map(relatedObjects.flatMap(id => registry.history(id)).map(item => [item.id, item])).values()].filter(item => Date.parse(item.at) <= Date.parse(at) && (item.before?.visit?.id === visitId || item.after?.visit?.id === visitId || item.before?.id === visitId || item.after?.id === visitId || item.after?.visitId === visitId || item.before?.visitId === visitId || relatedIds.has(item.after?.id) || relatedIds.has(item.before?.id) || relatedIds.has(item.after?.condition?.id) || relatedIds.has(item.before?.condition?.id))).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { at, visit, reply, recommendation, conditions, preview, history: history.sort((a, b) => String(b.at).localeCompare(String(a.at))), revisions, audit, client: feedbackClient(registry, visit.entities), scopes: scopes.filter(key => key === 'operation' || (key === 'client' ? feedbackClient(registry, visit.entities) : visit.entities?.[key])) };
}

/** Recheck evidence on the server at decision time and commit the decision atomically. */
export function decideEngineerFeedback(registry, visitId, input) {
  return registry.db.transaction(() => {
    const report = engineerFeedbackImpact(registry, visitId, { at: input.at, scope: input.scope });
    if (report.reply.revision !== Number(input.expectedRevision)) throw new Error('Ответ уже изменён. Обновите паспорт.');
    if (input.action === 'confirm' && !report.recommendation.ready) throw new Error(report.recommendation.reasons.join('. '));
    if (!String(input.reason || '').trim()) throw new Error('Укажите основание решения.');
    const selectedIds = input.action === 'confirm' ? report.recommendation.evidenceIds : [visitId];
    for (const id of selectedIds) {
      const current = registry.visits(input.at).find(item => item.id === id);
      const response = engineerFeedback(registry, current.entities.object).find(item => item.visitId === id);
      if (response) registry.recordVisit({ ...current, reason: response.reason, findingKey: response.findingKey, finding: response.finding, preparation: response.preparation, learningDecision: input.action === 'confirm' ? 'confirmed' : 'pending', knownAt: input.at }, 'Ответ инженера проверен оператором', input.actor);
    }
    const existing = report.conditions.find(item => item.scope === report.recommendation.probe.scope && item.entityId === report.recommendation.probe.entityId && item.findingKey === report.reply.findingKey && !item.closedAt && (!item.validUntil || Date.parse(item.validUntil) > Date.parse(input.at)));
    const result = registry.decide({ ...input, visitId, validUntil: report.reply.validUntil || input.validUntil, replacesConditionId: input.action === 'confirm' ? existing?.id : undefined, scope: report.recommendation.probe.scope, finding: report.reply.finding, preparation: report.reply.preparation }, { feedbackChecked: true });
    if (input.action === 'confirm') {
      const after = { ...result, feedbackPolicy: { version: 'feedback-evidence-v1', visitId, feedbackRevision: report.reply.revision, validation: report.recommendation.validation } };
      registry.db.prepare('UPDATE object_conditions SET payload_json=? WHERE id=?').run(JSON.stringify(after), result.id);
      registry.audit(report.visit.entities.object, 'FEEDBACK_POLICY_CONFIRMED', input.reason, result, after, input.actor, input.at);
      return after;
    }
    return result;
  })();
}

function withoutHistory(forecast, ids) {
  if (forecast.override) return forecast.total;
  const remaining = (forecast.histories || []).filter(item => !ids.has(item.conditionId));
  return Math.max(1, forecast.factorTechnical + remaining.filter(item => item.component === 'technical').reduce((sum, item) => sum + item.minutes, 0)) + forecast.documents + Math.max(0, remaining.filter(item => item.component === 'access').reduce((sum, item) => sum + item.minutes, 0)) + Math.max(0, remaining.filter(item => item.component === 'customer').reduce((sum, item) => sum + item.minutes, 0));
}

