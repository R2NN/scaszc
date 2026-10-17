import { assertServiceLocation } from '../src/serviceLocation.js';
import { randomUUID } from 'node:crypto';
import { calculateDuration, conditionEvidence, matchesConditionWork, DEFAULT_MODEL, digest, normalizeFactors, REASONS, validateModel } from './durationModel.mjs';

const encode = value => JSON.stringify(value);
const decode = row => row ? JSON.parse(row.payload_json) : null;
const stamp = () => new Date().toISOString();
const minute = value => { const [h, m] = String(value || '').split(':').map(Number); return h * 60 + m; };
const scopeKeys = ['object', 'entrance', 'node', 'line', 'operation'];
const immutable = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) immutable(item); Object.freeze(value); } return value; };

/** Transactional registry, immutable forecasts, versioned facts and scoped decisions. */
export class ComplexityStore {
  constructor(db) {
    this.db = db;
    this.visitRows = new Map();
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS duration_models(id TEXT PRIMARY KEY, effective_at TEXT NOT NULL, payload_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS service_objects(id TEXT PRIMARY KEY, region_id TEXT NOT NULL, payload_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS infrastructure_entities(id TEXT PRIMARY KEY, object_id TEXT NOT NULL REFERENCES service_objects(id), kind TEXT NOT NULL, payload_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS duration_snapshots(id TEXT PRIMARY KEY, order_id TEXT NOT NULL, payload_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS duration_plan_receipts(id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS duration_visits(id TEXT NOT NULL, revision INTEGER NOT NULL, object_id TEXT, ended_at TEXT, known_at TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS object_conditions(id TEXT PRIMARY KEY, object_id TEXT, payload_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS complexity_audit(id TEXT PRIMARY KEY, object_id TEXT, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS duration_visits_scope ON duration_visits(object_id,ended_at,known_at);
        CREATE INDEX IF NOT EXISTS infrastructure_object ON infrastructure_entities(object_id);
        CREATE INDEX IF NOT EXISTS duration_snapshots_order ON duration_snapshots(order_id);
        CREATE INDEX IF NOT EXISTS complexity_audit_object ON complexity_audit(object_id,at);
      `);
      db.prepare('INSERT OR IGNORE INTO duration_models VALUES (?,?,?)').run(DEFAULT_MODEL.version, DEFAULT_MODEL.effectiveAt, encode(DEFAULT_MODEL));
      db.prepare('INSERT OR IGNORE INTO migrations(version) VALUES (2)').run();
    })();
  }

  model(at = '9999-12-31T23:59:59Z') { return decode(this.db.prepare('SELECT payload_json FROM duration_models WHERE julianday(effective_at) <= julianday(?) ORDER BY julianday(effective_at) DESC,rowid DESC LIMIT 1').get(at)) || DEFAULT_MODEL; }
  models() { return this.db.prepare('SELECT payload_json FROM duration_models ORDER BY rowid DESC').all().map(decode); }
  audit(objectId, action, reason, before, after, actor = 'Диспетчер', at = stamp()) {
    if (!String(reason || '').trim()) throw new Error('Укажите причину изменения.');
    this.db.prepare('INSERT INTO complexity_audit VALUES (?,?,?,?,?,?,?)').run(randomUUID(), objectId || null, action, String(actor).slice(0, 120), at, String(reason).slice(0, 2000), encode({ before, after }));
  }
  saveModel(input) {
    return this.db.transaction(() => {
      const before = this.model();
      if (input.expectedVersion !== before.version) throw new Error('Модель уже изменилась. Обновите настройки.');
      const after = validateModel({ norms: input.norms, weights: input.weights, history: input.history, version: `duration-${randomUUID().slice(0, 8)}`, effectiveAt: input.effectiveAt });
      if (!Number.isFinite(Date.parse(after.effectiveAt)) || Date.parse(after.effectiveAt) < Date.parse(before.effectiveAt)) throw new Error('Новая версия не может действовать раньше предыдущей.');
      this.db.prepare('INSERT INTO duration_models VALUES (?,?,?)').run(after.version, after.effectiveAt, encode(after));
      this.audit(null, 'MODEL_CHANGED', input.reason, before, after, input.actor);
      return after;
    })();
  }
  objects() { return this.db.prepare('SELECT payload_json FROM service_objects ORDER BY id').all().map(decode); }
  object(id) { return decode(this.db.prepare('SELECT payload_json FROM service_objects WHERE id=?').get(id)); }
  entities(id) { return this.db.prepare('SELECT payload_json FROM infrastructure_entities WHERE object_id=? ORDER BY id').all(id).map(decode); }
  registerObject(object, entities = []) {
    this.db.prepare('INSERT OR IGNORE INTO service_objects VALUES (?,?,?)').run(object.id, object.regionId || 'moscow', encode(object));
    for (const entity of entities) this.db.prepare('INSERT OR IGNORE INTO infrastructure_entities VALUES (?,?,?,?)').run(entity.id, object.id, entity.kind, encode(entity));
  }
  visits(at = '9999-12-31T23:59:59Z', objectId) {
    const rows = this.db.prepare(`SELECT v.rowid FROM duration_visits v WHERE julianday(v.known_at)<=julianday(?) ${objectId ? 'AND v.object_id=?' : ''} AND v.revision=(SELECT max(n.revision) FROM duration_visits n WHERE n.id=v.id AND julianday(n.known_at)<=julianday(?))`).all(...(objectId ? [at, objectId, at] : [at, at]));
    return rows.map(row => {
      if (!this.visitRows.has(row.rowid)) this.visitRows.set(row.rowid, immutable(decode(this.db.prepare('SELECT payload_json FROM duration_visits WHERE rowid=?').get(row.rowid))));
      return this.visitRows.get(row.rowid);
    });
  }
  conditions(objectId) { return this.db.prepare(`SELECT payload_json FROM object_conditions ${objectId ? 'WHERE object_id=? OR object_id IS NULL' : ''}`).all(...(objectId ? [objectId] : [])).map(decode); }
  links(order, registerUnknown = false) {
    const entities = { ...(order.serviceEntities || {}) };
    if (entities.object && order.objectId && entities.object !== order.objectId) throw new Error('Объект заявки противоречит связанным сущностям.');
    const explicitObject = entities.object || order.objectId;
    const source = order.sourceData || {};
    const sourceObject = source.geocode_object_id || source.location_id;
    const objectId = explicitObject || (sourceObject ? `OBJ-${digest([order.regionId || 'moscow', sourceObject]).slice(0, 18)}` : null);
    if (objectId) {
      if (!this.object(objectId)) {
        if (explicitObject) throw new Error('Объект не найден в реестре.');
        this.registerObject({ id: objectId, address: order.address, coords: order.coords, zone: order.zone, zoneId: order.zoneId, district: order.district, regionId: order.regionId || 'moscow', source: 'Исходное геокодирование; инфраструктура не установлена' });
      }
      assertServiceLocation(order, this.object(objectId));
      entities.object = objectId;
      const defaults = this.object(objectId)?.orderDefaults?.[String(order.sourceId || order.id)];
      if (defaults?.serviceEntities) Object.assign(entities, { ...defaults.serviceEntities, ...entities });
      for (const scope of ['entrance', 'node', 'line']) if (entities[scope] && !this.entities(objectId).some(entity => entity.id === entities[scope] && entity.kind === scope)) throw new Error('Связанная сущность не принадлежит объекту.');
      const infrastructure = this.entities(objectId);
      const node = infrastructure.find(entity => entity.id === entities.node);
      const line = infrastructure.find(entity => entity.id === entities.line);
      if (node?.entranceId && entities.entrance && node.entranceId !== entities.entrance) throw new Error('Выбранный узел относится к другому подъезду.');
      if (line?.nodeId && entities.node && line.nodeId !== entities.node) throw new Error('Выбранная линия относится к другому узлу.');
    } else if (Object.values(entities).some(Boolean)) throw new Error('Укажите объект для связанных сущностей.');
    else if (registerUnknown && order.id && Array.isArray(order.coords) && order.coords.length === 2 && order.coords.every(Number.isFinite)) {
      const id = `OBJ-${randomUUID()}`;
      this.registerObject({ id, address: order.address || 'Подтверждённая точка обслуживания', coords: order.coords, regionId: order.regionId || 'moscow', zone: order.zone, zoneId: order.zoneId, district: order.district, source: 'Зарегистрирована оператором из заявки. Связи с подъездом, узлом и линией пока не установлены.' });
      entities.object = id;
    }
    return entities;
  }
  estimate(order, at, persist = false) {
    const entities = this.links(order, persist);
    const object = this.object(entities.object);
    const defaults = object?.orderDefaults?.[String(order.sourceId || order.id)] || {};
    const enriched = { ...order, durationFactors: { ...defaults.durationFactors, ...order.durationFactors }, factorSources: { ...defaults.factorSources, ...order.factorSources } };
    const conditions = this.conditions(entities.object);
    const evidence = conditions.some(condition => condition.scope === 'operation') ? this.visits(at) : this.visits(at, entities.object);
    const forecast = calculateDuration(enriched, { asOf: at, entities, model: this.model(at), visits: evidence, conditions });
    const id = digest({ orderId: String(order.id), ...forecast });
    const snapshot = { id, orderId: String(order.id), ...forecast };
    if (persist) {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO duration_snapshots VALUES (?,?,?)').run(id, String(order.id), encode(snapshot));
      if (inserted.changes && snapshot.override) this.audit(entities.object, 'DURATION_OVERRIDE', snapshot.override.reason, { calculated: snapshot.calculatedTotal }, { orderId: order.id, snapshotId: id, override: snapshot.override }, 'Диспетчер', at);
    }
    return snapshot;
  }
  prepareOrders(orders, at, { preserve = false } = {}) {
    return this.db.transaction(() => orders.map(order => {
      if (preserve && order.durationSnapshot?.id) {
        const snapshot = this.snapshot(order.durationSnapshot.id);
        if (!snapshot || snapshot.orderId !== String(order.id) || digest(snapshot) !== digest(order.durationSnapshot) || order.duration !== snapshot.total) throw new Error('Снимок длительности изменён или не подтверждён сервером.');
        return order;
      }
      const durationSnapshot = this.estimate(order, at, true);
      return { ...order, duration: durationSnapshot.total, durationFactors: durationSnapshot.factors, durationOverride: durationSnapshot.override, serviceEntities: durationSnapshot.entities, objectId: durationSnapshot.entities.object, durationSnapshot };
    }))();
  }
  snapshot(id) { return decode(this.db.prepare('SELECT payload_json FROM duration_snapshots WHERE id=?').get(id)); }
  authorizePlan(orders, team, plan) {
    this.verifyOrders(orders, plan);
    const { durationOrders, ...schedule } = plan;
    const id = digest({ orders, team, plan: schedule });
    this.db.prepare('INSERT OR IGNORE INTO duration_plan_receipts VALUES (?,?)').run(id, encode({ contentSha256: plan.contentSha256, at: stamp() }));
    return id;
  }
  requirePlanReceipt(orders, team, plan) {
    const { durationOrders, ...schedule } = plan;
    const id = digest({ orders, team, plan: schedule });
    if (!orders.every(order => order.durationSnapshot) || !this.db.prepare('SELECT id FROM duration_plan_receipts WHERE id=?').get(id)) throw new Error('Публикация требует неизменённый результат серверного расчёта. Пересчитайте план.');
    this.verifyOrders(orders, plan);
  }
  verifyOrders(orders, plan) {
    for (const order of orders) {
      if (!order.durationSnapshot) continue;
      const saved = this.snapshot(order.durationSnapshot.id);
      if (!saved || saved.orderId !== String(order.id) || digest(saved) !== digest(order.durationSnapshot) || saved.total !== order.duration) throw new Error('Независимая проверка: подмена длительности заявки.');
      for (const route of plan?.routes || []) for (const visit of route.assignments || []) if (String(visit.orderId) === String(order.id) && minute(visit.plannedFinish) - minute(visit.plannedStart) !== saved.total) throw new Error('Длительность в маршруте не совпадает с авторитетным снимком.');
    }
  }
  recordVisit(visit, reason = 'Запись факта визита', actor = 'Диспетчер') {
    const before = decode(this.db.prepare('SELECT payload_json FROM duration_visits WHERE id=? ORDER BY revision DESC LIMIT 1').get(visit.id));
    const revision = (this.db.prepare('SELECT max(revision) AS revision FROM duration_visits WHERE id=?').get(visit.id).revision || 0) + 1;
    this.db.prepare('INSERT INTO duration_visits VALUES (?,?,?,?,?,?)').run(visit.id, revision, visit.entities?.object || null, visit.endedAt || null, visit.knownAt, encode({ ...visit, revision, actor }));
    this.audit(visit.entities?.object, 'VISIT_RECORDED', reason, before, { ...visit, revision, actor }, actor, visit.knownAt);
    return { ...visit, revision, actor };
  }
  recordShiftFact(shift, fact, prior, actor) {
    const order = shift.orders.find(item => String(item.id) === String(fact.orderId));
    const forecast = order?.durationSnapshot;
    if (!forecast) return;
    const start = fact.startedAt || (fact.status === 'started' ? fact.time : prior?.startedAt || (prior?.status === 'started' ? prior.time : null));
    const end = fact.status === 'completed' ? fact.time : null;
    const total = start && end ? minute(end) - minute(start) : null;
    if (total != null && total <= 0) throw new Error('Завершение визита должно быть позже начала.');
    const reason = fact.deviationReason || 'unknown';
    if (!Object.hasOwn(REASONS, reason)) throw new Error('Выберите структурированную причину отклонения.');
    if (total != null && Math.abs(total - forecast.total) >= Math.max(10, forecast.total * 0.25) && !fact.deviationReason) throw new Error('Уточните существенное отклонение, в том числе «Причина неизвестна».');
    for (const key of ['accessMinutes', 'documentMinutes', 'customerMinutes']) if (fact[key] != null && fact[key] !== '' && (!Number.isInteger(Number(fact[key])) || Number(fact[key]) < 0 || Number(fact[key]) > 1440 || (total != null && Number(fact[key]) > total))) throw new Error('Время этапа должно быть целым и не больше длительности визита.');
    const knownStages = ['accessMinutes', 'documentMinutes', 'customerMinutes'].every(key => fact[key] != null && fact[key] !== '');
    const stageSum = ['accessMinutes', 'documentMinutes', 'customerMinutes'].reduce((sum, key) => sum + Number(fact[key] || 0), 0);
    if (total != null && stageSum >= total) throw new Error('Сумма этапов не оставляет времени технической работе.');
    const route = shift.plan.routes.find(item => item.assignments.some(visit => String(visit.orderId) === String(fact.orderId)));
    const previous = this.visits().find(visit => visit.id === `FACT-${shift.id}-${fact.orderId}`);
    const engineerId = previous?.engineerId || prior?.engineerId || route?.engineerId;
    const engineerName = previous?.engineerName || shift.team?.find(member => String(member.id) === String(engineerId))?.name;
    this.recordVisit({ id: `FACT-${shift.id}-${fact.orderId}`, orderId: fact.orderId, shiftId: shift.id, entities: forecast.entities, kind: forecast.kind, operation: forecast.operation, forecast, factorTechnical: forecast.factorTechnical, startedAt: start ? `${shift.date}T${start}:00+03:00` : null, endedAt: end ? `${shift.date}T${end}:00+03:00` : null, knownAt: stamp(), total, actualTechnical: knownStages && total != null ? total - stageSum : null, accessMinutes: fact.accessMinutes != null && fact.accessMinutes !== '' ? Number(fact.accessMinutes) : null, documentMinutes: fact.documentMinutes != null && fact.documentMinutes !== '' ? Number(fact.documentMinutes) : null, customerMinutes: fact.customerMinutes != null && fact.customerMinutes !== '' ? Number(fact.customerMinutes) : null, eligible: fact.status === 'completed' && knownStages && total != null, excluded: Boolean(fact.excluded), reason, comment: String(fact.comment || '').slice(0, 2000), engineerId, engineerName, source: 'dispatcher', status: fact.status }, fact.correctionReason || 'Отметка факта визита', actor);
  }
  decide(input) {
    return this.db.transaction(() => {
      const at = input.at;
      if (!String(input.reason || '').trim()) throw new Error('Укажите основание решения.');
      if (!Number.isFinite(Date.parse(at))) throw new Error('Укажите время решения.');
      const visit = this.visits(at).find(item => item.id === input.visitId);
      if (!visit || Date.parse(at) < Date.parse(this.visits().find(item => item.id === visit.id).knownAt)) throw new Error('Визит не найден или решение предшествует известному исправлению.');
      if (!['confirm', 'visit', 'reject'].includes(input.action)) throw new Error('Неизвестное решение.');
      let condition = null;
      if (input.action === 'confirm') {
        if (!visit.eligible || visit.excluded) throw new Error('Подтверждение требует пригодного измерения; сначала восстановите исключённый визит.');
        if (['unknown', 'customer', 'other'].includes(visit.reason)) throw new Error('Неустановленная причина и ожидание клиента относятся только к этому визиту.');
        if (!scopeKeys.includes(input.scope) || (input.scope !== 'operation' && !visit.entities?.[input.scope])) throw new Error('Выберите существующую область применения.');
        const component = visit.reason === 'access' ? 'access' : 'technical';
        const probe = { scope: input.scope, component, findingKey: visit.findingKey, kind: visit.kind, operation: visit.operation, entityId: input.scope === 'operation' ? visit.operation : visit.entities?.[input.scope], reason: visit.reason };
        const comparable = conditionEvidence(probe, this.visits(at).map(item => item.id === visit.id || item.learningDecision === 'pending' ? { ...item, learningDecision: 'confirmed' } : item), at, this.model(at)).map(item => item.visit);
        if (comparable.length < this.model(at).history.minimum) throw new Error('Недостаточно сопоставимых пригодных наблюдений для переноса на следующие заявки.');
        if (input.scope === 'node' && !visit.forecast?.factors?.requiresNode) throw new Error('Этот визит не требовал посещения узла.');
        if (input.validUntil && (!Number.isFinite(Date.parse(input.validUntil)) || Date.parse(input.validUntil) <= Date.parse(at))) throw new Error('Срок временного условия должен быть позже решения.');
        if (input.replacesConditionId) {
          const previous = this.conditions(visit.entities.object).find(item => item.id === input.replacesConditionId);
          if (!previous || previous.reason !== visit.reason || !matchesConditionWork(previous, visit)) throw new Error('Условие не связано с выбранным сопоставимым визитом.');
          this.closeCondition(previous.id, { at, reason: input.reason, actor: input.actor });
        }
        condition = { id: randomUUID(), objectId: visit.entities.object, entityId: input.scope === 'operation' ? visit.operation : visit.entities[input.scope], scope: input.scope, kind: visit.kind, operation: visit.operation, reason: visit.reason, findingKey: visit.findingKey, component, knownAt: at, validFrom: at, validUntil: input.validUntil || null, status: 'confirmed', evidenceIds: comparable.map(item => item.id), source: input.reason, finding: input.finding || visit.finding || visit.comment || '', preparation: input.preparation || visit.preparation || '', actor: input.actor || 'Диспетчер' };
        this.db.prepare('INSERT INTO object_conditions VALUES (?,?,?)').run(condition.id, input.scope === 'operation' ? null : visit.entities.object, encode(condition));
        for (const evidence of comparable) if (evidence.id !== visit.id && evidence.learningDecision === 'confirmed') {
          const original = this.visits(at).find(item => item.id === evidence.id);
          if (original?.learningDecision === 'pending') this.recordVisit({ ...original, knownAt: at, learningDecision: 'confirmed', decisionReason: input.reason }, input.reason, input.actor);
        }
      }
      const afterVisit = this.recordVisit({ ...visit, knownAt: at, learningDecision: input.action === 'confirm' ? 'confirmed' : input.action === 'reject' ? 'rejected' : 'visit', decisionReason: input.reason }, input.reason, input.actor);
      this.audit(visit.entities.object, `DECISION_${input.action.toUpperCase()}`, input.reason, { visit }, { visit: afterVisit, condition }, input.actor, at);
      return condition || { action: input.action, visitId: visit.id, visit: afterVisit };
    })();
  }
  reviseVisit(id, input) {
    return this.db.transaction(() => {
      const visit = this.visits().find(item => item.id === id);
      if (!visit || !Number.isFinite(Date.parse(input.at)) || Date.parse(input.at) < Date.parse(visit.knownAt)) throw new Error('Визит не найден или время исправления неверно.');
      if (!String(input.reason || '').trim()) throw new Error('Укажите основание исправления.');
      const change = {};
      if (input.excluded !== undefined) {
        if (typeof input.excluded !== 'boolean') throw new Error('Некорректный признак исключения.');
        change.excluded = input.excluded;
      }
      if (input.deviationReason !== undefined) {
        if (!Object.hasOwn(REASONS, input.deviationReason) || !String(input.finding || '').trim()) throw new Error('Укажите установленную причину и конкретную особенность.');
        const matchingFinding = this.visits(input.at).find(item => item.reason === input.deviationReason && item.finding?.trim().toLocaleLowerCase('ru-RU') === input.finding.trim().toLocaleLowerCase('ru-RU'));
        Object.assign(change, { reason: input.deviationReason, findingKey: input.findingKey || matchingFinding?.findingKey || `finding:${digest([input.deviationReason, input.finding.trim()]).slice(0, 16)}`, finding: String(input.finding).trim().slice(0, 2000), preparation: String(input.preparation || '').trim().slice(0, 2000), learningDecision: 'pending' });
      }
      if (!Object.keys(change).length) throw new Error('Укажите изменение визита.');
      return this.recordVisit({ ...visit, ...change, knownAt: input.at }, input.reason, input.actor);
    })();
  }
  closeCondition(id, input) {
    return this.db.transaction(() => {
      const before = decode(this.db.prepare('SELECT payload_json FROM object_conditions WHERE id=?').get(id));
      if (!before) throw new Error('Особенность не найдена.');
      if (!String(input.reason || '').trim()) throw new Error('Укажите основание устранения особенности.');
      if (!Number.isFinite(Date.parse(input.at)) || Date.parse(input.at) < Date.parse(before.knownAt)) throw new Error('Закрытие не может быть раньше подтверждения.');
      if (before.closedAt) throw new Error('Особенность уже закрыта.');
      const after = { ...before, closedAt: input.at };
      this.db.prepare('UPDATE object_conditions SET payload_json=? WHERE id=?').run(encode(after), id);
      this.audit(before.objectId, 'CONDITION_CLOSED', input.reason, before, after, input.actor, input.at);
      return after;
    })();
  }
  history(objectId) { return this.db.prepare('SELECT * FROM complexity_audit WHERE object_id=? OR object_id IS NULL ORDER BY rowid DESC LIMIT 100').all(objectId).map(row => ({ ...row, ...JSON.parse(row.payload_json), payload_json: undefined })); }
  accuracy(at, zone, regionId = 'moscow', knowledgeAt = at) {
    const objects = new Set(this.objects().filter(item => item.regionId === regionId && (!zone || item.zone === zone || item.zoneId === zone)).map(item => item.id));
    const all = this.visits(knowledgeAt).filter(visit => objects.has(visit.entities?.object) && visit.endedAt && Date.parse(visit.endedAt) <= Date.parse(at));
    const eligible = all.filter(visit => visit.eligible && !visit.excluded && Number.isFinite(visit.actualTechnical) && visit.forecast && !visit.forecast.override);
    const holdout = eligible.filter(visit => visit.partition === 'holdout' || visit.source === 'dispatcher');
    const stats = rows => {
      const longer = rows.filter(visit => visit.actualTechnical > visit.forecast.technical);
      const shorter = rows.filter(visit => visit.actualTechnical < visit.forecast.technical);
      const mean = (items, value) => items.length ? items.reduce((sum, visit) => sum + value(visit), 0) / items.length : null;
      return {
        count: rows.length,
        mae: mean(rows, visit => Math.abs(visit.actualTechnical - visit.forecast.technical)),
        fixedMae: mean(rows, visit => Math.abs(visit.actualTechnical - visit.forecast.baseTechnical)),
        underestimated: longer.length,
        overestimated: shorter.length,
        underMinutes: mean(longer, visit => visit.actualTechnical - visit.forecast.technical),
        overMinutes: mean(shorter, visit => visit.forecast.technical - visit.actualTechnical),
      };
    };
    return { ...stats(holdout), eligible: eligible.length, total: all.length, coverage: all.length ? eligible.length / all.length : null, trainingCount: eligible.length - holdout.length, byKind: Object.keys(DEFAULT_MODEL.norms).map(kind => ({ kind, ...stats(holdout.filter(v => v.kind === kind)) })), temporalSplit: holdout.filter(visit => visit.partition === 'holdout').map(visit => visit.endedAt.slice(0, 10)).sort()[0] || null, measure: 'Технические минуты; одинаковые пригодные факты, прогноз до визита', limitations: 'Синтетическая независимая симуляция, а не доказательство качества на производственных данных.' };
  }
}
