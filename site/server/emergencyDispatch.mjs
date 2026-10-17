import { createHash, randomUUID } from 'node:crypto';
import { runExactReplan } from '../scripts/exact-replan-runner.mjs';
import { acquirePlanningSlot } from './planningSlot.mjs';
import { minuteOf, timeOf } from '../src/shiftDomain.js';
import { operationalStates } from '../src/operationalState.js';
import { preservesStartedVisits } from './exactShiftReplan.mjs';

const encode = JSON.stringify;
const hash = value => createHash('sha256').update(encode(value)).digest('hex');
const decode = row => row ? JSON.parse(row.payload) : null;
export const DEFAULT_DISPATCH_POLICY = Object.freeze({ enabled: true, waitSeconds: 300, choice: 'COVERAGE_STAFF_ETA_DISTANCE_V1' });
const terminal = item => ['ACCEPTED', 'CANCELLED'].includes(item.status);
const index = plan => new Map(plan.routes.flatMap(route => route.assignments.map(visit => [String(visit.orderId), { ...visit, engineerId: route.engineerId }])));
const orderCandidates = candidates => {
  const intercepts = candidates.filter(item => item.kind === 'Перехват в пути').sort((a, b) => a.responseMinutes - b.responseMinutes);
  return [...intercepts, ...candidates.filter(item => item.kind !== 'Перехват в пути')];
};

/** Durable incident queue. Server wall time controls deadlines, scenario time controls travel. */
export class EmergencyDispatch {
  constructor(store, { routing = runExactReplan, now = Date.now } = {}) {
    this.store = store;
    this.routing = routing;
    this.now = now;
    this.busy = false;
    this.controllers = new Map();
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_incidents(id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id), event_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(shift_id,event_key));
      CREATE TABLE IF NOT EXISTS dispatch_sessions(id TEXT PRIMARY KEY, base_shift_id TEXT NOT NULL, shift_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_preferences(shift_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dispatch_incidents_status ON dispatch_incidents(json_extract(payload,'$.status'));
    `);
    store.db.prepare('INSERT OR IGNORE INTO migrations(version) VALUES (3)').run();
    // Interrupted work is requeued on restart; its durable deadline is retained.
    for (const item of this.active()) if (['SEARCHING', 'CHECKING'].includes(item.status)) this.save({ ...item, status: 'QUEUED', error: 'Расчёт продолжится после перезапуска сервера' });
  }

  all(shiftId) {
    return (shiftId ? this.store.db.prepare('SELECT payload FROM dispatch_incidents WHERE shift_id=? ORDER BY rowid').all(shiftId) : this.store.db.prepare('SELECT payload FROM dispatch_incidents ORDER BY rowid').all()).map(decode);
  }
  active(shiftId) {
    const clause = "json_extract(payload,'$.status') IN ('QUEUED','SEARCHING','CHECKING','WAITING','ERROR')";
    return (shiftId ? this.store.db.prepare(`SELECT payload FROM dispatch_incidents WHERE ${clause} AND shift_id=? ORDER BY rowid`).all(shiftId)
      : this.store.db.prepare(`SELECT payload FROM dispatch_incidents WHERE ${clause} ORDER BY rowid`).all()).map(decode);
  }
  hasPending(shiftId) {
    return Boolean(this.store.db.prepare("SELECT 1 FROM dispatch_incidents WHERE shift_id=? AND json_extract(payload,'$.status') IN ('QUEUED','SEARCHING','CHECKING','WAITING','ERROR') LIMIT 1").get(shiftId));
  }
  get(id) { return decode(this.store.db.prepare('SELECT payload FROM dispatch_incidents WHERE id=?').get(id)); }
  save(item) {
    return this.store.db.transaction(() => {
      const current = this.get(item.id);
      if (current && terminal(current) && current.status !== item.status) return current;
      this.store.db.prepare('UPDATE dispatch_incidents SET payload=? WHERE id=?').run(encode(item), item.id);
      return item;
    }).immediate();
  }
  policy(shiftId) { return { ...DEFAULT_DISPATCH_POLICY, ...decode(this.store.db.prepare('SELECT payload FROM dispatch_preferences WHERE shift_id=?').get(shiftId)) }; }
  setPolicy(shiftId, input) {
    const waitSeconds = Number(input.waitSeconds);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 10 || waitSeconds > 3600 || typeof input.enabled !== 'boolean') throw new Error('Ожидание: от 10 до 3600 секунд; укажите режим автовыбора');
    const policy = { ...DEFAULT_DISPATCH_POLICY, enabled: input.enabled, waitSeconds };
    this.store.db.prepare('INSERT INTO dispatch_preferences VALUES (?,?) ON CONFLICT(shift_id) DO UPDATE SET payload=excluded.payload').run(shiftId, encode(policy));
    return policy;
  }
  fingerprint(shift) {
    return hash({ revision: shift.revision, plan: shift.plan.contentSha256, facts: shift.factLog, team: shift.team,
      model: this.store.db.prepare('SELECT * FROM duration_models').all(), conditions: this.store.db.prepare('SELECT * FROM object_conditions').all(),
      history: this.store.db.prepare('SELECT count(*) AS count, max(known_at) AS latest, max(revision) AS revision FROM duration_visits').get(),
      snapshots: shift.orders.map(item => item.durationSnapshot?.id), pending: this.active(shift.id).map(item => item.id).sort() });
  }

  create(shiftId, { order, time, eventKey = order?.id, mode = 'scenario' }) {
    const prior = this.store.db.prepare('SELECT payload FROM dispatch_incidents WHERE shift_id=? AND event_key=?').get(shiftId, eventKey);
    const item = this.store.db.transaction(() => {
      const prior = decode(this.store.db.prepare('SELECT payload FROM dispatch_incidents WHERE shift_id=? AND event_key=?').get(shiftId, eventKey));
      if (prior) return prior;
      const shift = this.store.get(shiftId);
      if (!shift?.plan || minuteOf(time) == null || !order?.id) throw new Error('Нужны смена, аварийная заявка и время');
      if (!['scenario', 'live'].includes(mode)) throw new Error('Неизвестный режим часов');
      if (time < (shift.versions.at(-1)?.effectiveAt || '00:00')) throw new Error('Событие раньше текущей версии смены');
      if (shift.orders.some(item => item.id === order.id)) throw new Error('Заявка уже существует');
      this.store.complexity.validateServiceOrder(order);
      const prepared = this.store.complexity.prepareOrders([order], `${shift.date}T${time}:00+03:00`)[0];
      if (prepared.durationSnapshot?.kind !== 'emergency') throw new Error('Для аварийного диспетчирования нужен аварийный вид работ');
      const policy = this.policy(shiftId), stamp = this.now();
      const item = { id: randomUUID(), shiftId, eventKey, order: prepared, time, mode, policy, createdAt: stamp, deadlineAt: stamp + policy.waitSeconds * 1000,
        status: 'QUEUED', candidates: [], version: 0, decision: null, error: null, notifications: [{ id: randomUUID(), type: 'EMERGENCY_INCIDENT', title: 'Новая авария', message: `${prepared.address} · ${time}`, read: false, createdAt: stamp }] };
      this.store.db.prepare('INSERT INTO dispatch_incidents VALUES (?,?,?,?)').run(item.id, shiftId, eventKey, encode(item));
      return item;
    })();
    if (!prior && this.store.get(shiftId)?.regionId?.includes(':scenario:')) this.prioritize(shiftId);
    return item;
  }

  /** Stop stale scenario searches so a newly opened demonstration gets the shared planner first. */
  prioritize(shiftId) {
    for (const [id, controller] of this.controllers) {
      const item = this.get(id);
      if (!item || item.shiftId === shiftId || terminal(item)) continue;
      const shift = this.store.get(item.shiftId);
      if (shift?.regionId?.includes(':scenario:')) controller.abort();
    }
  }

  currentMinute(item) { return minuteOf(item.time) + (item.mode === 'live' ? Math.floor((this.now()-item.createdAt)/60000) : 0); }
  notification(item, title, message) { item.notifications.push({ id: randomUUID(), type: 'EMERGENCY_INCIDENT', title, message, read: false, createdAt: this.now() }); }

  async search(id) {
    if (this.busy) return this.get(id);
    const item = this.get(id);
    if (!item || terminal(item)) return item;
    const release = acquirePlanningSlot();
    if (!release) return item;
    this.busy = true;
    const controller = new AbortController();
    this.controllers.set(id,controller);
    try {
      const shift = this.store.get(item.shiftId), minute = this.currentMinute(item), time = timeOf(minute);
      const fingerprint = this.fingerprint(shift);
      item.status = 'SEARCHING'; item.error = null; item.searchStartedAt = this.now(); this.save(item);
      const states = operationalStates(shift, minute, item.mode === 'scenario' ? 'plan' : 'fact');
      for (const fact of shift.facts || []) {
        if (fact.status !== 'started' || (minuteOf(fact.time) ?? Infinity) > minute) continue;
        const visit = shift.plan.routes.flatMap(route=>route.assignments).find(visit=>String(visit.orderId)===String(fact.orderId));
        if (visit && minute >= minuteOf(visit.plannedFinish)) throw new Error(`Заявка ${fact.orderId} фактически ещё выполняется после ${visit.plannedFinish}. Уточните окончание работы перед проверкой всей смены.`);
      }
      if (item.mode === 'live') throw new Error('Для точного live-выезда нужны свежие координаты и история движения. Источник телеметрии не подключён; расчётная позиция не выдаётся за фактическую.');
      const event = { type: 'NEW_ORDER', time, orderId: item.order.id, order: item.order, reason: 'Аварийный выезд', incidentId: item.id };
      const result = await this.routing({ orders: [...shift.orders, item.order], team: shift.team, plan: shift.plan, planningDate: shift.date, basePlanContentSha256: shift.plan.contentSha256, event, dispatch: true, facts: shift.facts }, undefined, {signal:controller.signal,onProgress:progress => {
        const fresh=this.get(id);
        if (!fresh || terminal(fresh)) return;
        const {dispatchCandidates:partial,...summary}=progress;
        fresh.progress={...summary, engineerName:shift.team.find(e => String(e.sourceId || e.id).split(':').at(-1) === summary.engineerId)?.name};
        if (partial?.length && this.fingerprint(this.store.get(item.shiftId))===fingerprint && this.currentMinute(item)===minute) {
          const described = partial.map(candidate=>this.describe(shift,item,candidate,states,fingerprint,time));
          fresh.recommendedId=described[0].id;
          fresh.candidates=orderCandidates(described);
          if(fresh.status==='SEARCHING')this.notification(fresh,'Решения аварии готовы',`${fresh.candidates.length} проверенных вариантов. Поиск продолжается.`);
          fresh.status='WAITING';
          fresh.search={complete:false};
        }
        this.save(fresh);
      }});
      const fresh = this.get(id);
      if (terminal(fresh)) return fresh;
      if (this.fingerprint(this.store.get(item.shiftId)) !== fingerprint || this.currentMinute(item) !== minute) {
        return this.save({ ...fresh, status: 'QUEUED', candidates: [], error: 'Состояние смены изменилось. Варианты пересчитываются.' });
      }
      // Preserve reads and notices recorded while the search was running.
      item.notifications = fresh.notifications;
      item.progress = fresh.progress;
      const described = (result.dispatchCandidates || []).map(candidate => this.describe(shift, item, candidate, states, fingerprint, time));
      const candidates = orderCandidates(described);
      if (!candidates.length) throw new Error('Независимо проверенный вариант не найден');
      item.candidates = candidates; item.search = result.dispatchSearch ? { ...result.dispatchSearch, rejected:result.dispatchSearch.rejected.map(entry => ({ ...entry, engineerName:shift.team.find(e => String(e.sourceId || e.id).split(':').at(-1) === entry.engineerId)?.name || entry.engineerId, reason:/unverified|ROUTING|маршрут/i.test(entry.reason) ? 'Не удалось подтвердить дорогу. Точный вариант не предлагается.' : /FROZEN|invalid/i.test(entry.reason) ? 'Не найден план, сохраняющий начатые работы и прямой выезд на аварию.' : /STATIC|NO_EXACT|TIME_WINDOW|SEARCH_BUDGET/i.test(entry.reason) ? 'В пределах поиска не найдено назначение с текущими окнами и составом.' : entry.reason })) } : null; item.status = 'WAITING'; item.version += 1;
      item.searchFinishedAt = this.now(); item.recommendedId = described[0].id;
      this.notification(item, 'Решения аварии готовы', `${candidates.length} проверенных вариантов. Рекомендован ${described[0].engineer.name}.`);
      return this.save(item);
    } catch (error) {
      const fresh = this.get(id);
      if (terminal(fresh)) return fresh;
      fresh.status = 'ERROR'; fresh.error = error.message; fresh.retryAt = this.now()+30000;
      this.notification(fresh, 'Авария требует внимания', error.message);
      return this.save(fresh);
    } finally { release(); this.busy = false; this.controllers.delete(id); }
  }

  describe(shift, incident, candidate, states, fingerprint, time) {
    const plan = candidate.plan;
    if (plan.status !== 'EXACT_VALID' || plan.validation?.status !== 'VALID' || !plan.publicationAllowed || !preservesStartedVisits(shift, plan, time)) throw new Error('Вариант не прошёл защиту начатых работ');
    const engineer = shift.team.find(item => String(item.sourceId || item.id).split(':').at(-1) === candidate.engineerSourceId);
    const route = plan.routes.find(item => item.engineerId === engineer?.id);
    const visit = route?.assignments.find(item => item.orderId === incident.order.id);
    if (!visit) throw new Error('В варианте отсутствует назначение аварии');
    const state = states.find(item => item.engineerId === engineer.id);
    const movement = route.movements?.findLast(item => item.measured_at === `${shift.date}T${time}:00+03:00`);
    if (movement) state.availableAt = movement.at.slice(11,16);
    if (['unknown', 'unavailable', 'before_shift', 'after_shift'].includes(state.status) || state.availableAt == null) throw new Error('Нет достоверного доступного оперативного состояния');
    const before = index(shift.plan), after = index(plan), orders = [...shift.orders, incident.order];
    const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap(id => {
      const old = before.get(id), next = after.get(id);
      if (old && next && ['engineerId', 'plannedStart', 'plannedFinish', 'departureAt', 'arrival'].every(key => old[key] === next[key])) return [];
      return [{ orderId: id, address: orders.find(item => item.id === id)?.address, before: old || null, after: next || null }];
    });
    const changedEngineerIds = [...new Set(changes.flatMap(item => [item.before?.engineerId, item.after?.engineerId]).filter(Boolean))];
    const handedOff = movement && changes.find(change =>
      String(orders.find(order => String(order.id) === change.orderId)?.sourceId || change.orderId).split(':').at(-1) === movement.source_job_id
      && change.before?.engineerId === engineer.id && change.after?.engineerId !== engineer.id && change.after);
    const interception = handedOff ? { orderId: handedOff.orderId, address: handedOff.address,
      receiverId: handedOff.after.engineerId, receiverName: shift.team.find(e => e.id === handedOff.after.engineerId)?.name,
      plannedStart: handedOff.after.plannedStart } : null;
    const loads = changedEngineerIds.map(id => ({ engineerId: id, name: shift.team.find(item => item.id === id)?.name,
      before: shift.plan.routes.find(item => item.engineerId === id)?.workloadMinutes || 0, after: plan.routes.find(item => item.engineerId === id)?.workloadMinutes || 0 }));
    const reserve = shift.team.filter(e => !plan.routes.find(r => r.engineerId === e.id)?.assignments.some(v => (minuteOf(v.plannedFinish) ?? 0) > minuteOf(time)))
      .map(e => ({ ...states.find(s => s.engineerId === e.id), name: e.name, skills: e.skills, until: e.shiftEnd }))
      .filter(e => e.coords && e.availableAt && ['idle', 'waiting'].includes(e.status) && e.engineerId !== engineer.id);
    const history = this.store.db.prepare('SELECT id,payload_json FROM duration_visits WHERE ended_at < ? AND known_at <= ? ORDER BY revision').all(`${shift.date}T${time}:00+03:00`, `${shift.date}T${time}:00+03:00`);
    const experience = [...new Map(history.map(row => [row.id,JSON.parse(row.payload_json)])).values()].filter(visit => String(visit.engineerId) === String(engineer.sourceId || engineer.id) && visit.kind === 'emergency').length;
    return { id: `${incident.id}:${plan.contentSha256}`, fingerprint, baseRevision: shift.revision, scenarioTime: time, checkedAt: this.now(), artifact: candidate.artifact,
      engineer: { id: engineer.id, name: engineer.name, skills: engineer.skills, equipment: engineer.equipment, transport: engineer.transport }, state, visit,
      departureOrigin: movement?.coords || state.coords, responseMinutes: minuteOf(visit.arrival)-minuteOf(time),
      kind: state.status === 'travelling' ? 'Перехват в пути' : state.status === 'working' ? 'После текущей работы' : 'Свободный инженер',
      experience: { count: experience, source: 'duration_visits', rating: null, ratingCount: 0 },
      interception, changes, changedEngineerIds, loads, reserve, coverage: { before: shift.plan.metrics, after: plan.metrics },
      plan, orders, team: shift.team, validation: plan.validation, contentSha256: plan.contentSha256 };
  }

  accept(id, candidateId, actor = 'Диспетчер') {
    const result = this.store.db.transaction(() => {
      const item = this.get(id);
      if (!item) throw new Error('Авария не найдена');
      if (terminal(item)) return item;
      const candidate = item.candidates.find(entry => entry.id === candidateId);
      if (item.status !== 'WAITING' || !candidate) throw new Error('Выберите готовый проверенный вариант');
      const shift = this.store.get(item.shiftId);
      if (candidate.fingerprint !== this.fingerprint(shift) || candidate.scenarioTime !== timeOf(this.currentMinute(item))) {
        this.save({ ...item, status: 'QUEUED', candidates: [], error: 'Вариант устарел. Выполняется новый расчёт.' });
        return this.get(id);
      }
      const event = { type: 'NEW_ORDER', time: candidate.scenarioTime, order: item.order, orderId: item.order.id, reason: actor === 'system' ? 'Авария: автоматическое решение после ожидания' : 'Авария: решение диспетчера', incidentId: id, candidateId, policy: item.policy.choice };
      const previewId = this.store.startPreview(item.shiftId, shift.revision, event);
      this.store.completePreview(previewId, { orders: candidate.orders, team: candidate.team, plan: candidate.plan });
      const saved = this.store.publish(item.shiftId, previewId, shift.revision, actor);
      item.status = 'ACCEPTED'; item.decision = { candidateId, actor, at: this.now(), revision: saved.revision, planId: saved.currentPlanId, contentSha256: candidate.contentSha256 };
      this.notification(item, actor === 'system' ? 'Авария назначена автоматически' : 'Авария назначена', `${candidate.engineer.name} · прибытие ${candidate.visit.arrival}`);
      return this.save(item);
    })();
    if (result && terminal(result)) this.controllers.get(id)?.abort();
    return result;
  }

  cancel(id) {
    const result = this.store.db.transaction(() => {
      const item = this.get(id);
      if (!item || terminal(item)) return item;
      this.notification(item, 'Авария отменена', item.order.address);
      return this.save({ ...item, status: 'CANCELLED', candidates: [] });
    }).immediate();
    if (result && terminal(result)) this.controllers.get(id)?.abort();
    return result;
  }
  read(id, notificationId) {
    return this.store.db.transaction(() => {
      const item = this.get(id), notice = item?.notifications.find(n => n.id === notificationId);
      if (notice) { notice.read = true; return this.save(item); }
      return item;
    }).immediate();
  }
  async tick() {
    if (!this.store.db.open) return;
    for (const item of this.active()) if (item.status === 'WAITING' && item.policy.enabled && item.deadlineAt <= this.now()) { this.accept(item.id,item.recommendedId,'system');return; }
    if (this.busy) return;
    for (const item of this.active().sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))) {
      if (terminal(item)) continue;
      if (item.status === 'QUEUED' || (item.status === 'ERROR' && item.retryAt <= this.now())) { await this.search(item.id); return; }
      if (item.status === 'WAITING' && item.policy.enabled && item.deadlineAt <= this.now()) { this.accept(item.id, item.recommendedId, 'system'); return; }
    }
  }
}
