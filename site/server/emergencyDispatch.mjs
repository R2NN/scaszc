import { createHash, randomUUID } from 'node:crypto';
import { runExactReplan } from '../scripts/exact-replan-runner.mjs';
import { acquirePlanningSlot, waitForPlanningSlot } from './planningSlot.mjs';
import { minuteOf, timeOf } from '../src/shiftDomain.js';
import { operationalStates } from '../src/operationalState.js';
import { preservesStartedVisits } from './exactShiftReplan.mjs';
import { syncDispatchPlayback, holdDispatchClock } from './dispatchPlayback.mjs';

const encode = JSON.stringify;
const hash = value => createHash('sha256').update(encode(value)).digest('hex');
const decode = row => row ? JSON.parse(row.payload) : null;
export const DEFAULT_DISPATCH_POLICY = Object.freeze({ enabled: true, waitSeconds: 300, choice: 'COVERAGE_STAFF_ETA_DISTANCE_V1' });
const terminal = item => ['ACCEPTED', 'CANCELLED'].includes(item.status);
const index = plan => new Map(plan.routes.flatMap(route => route.assignments.map(visit => [String(visit.orderId), { ...visit, engineerId: route.engineerId }])));
const lostAssignments = candidate => candidate.lostAssignments ?? candidate.changes.filter(change => change.before && !change.after).length;
// Keep small server-issued receipts so a poll cannot invalidate an already clicked card.
const choiceReceipt = candidate => ({id:candidate.id,engineer:candidate.engineer,kind:candidate.kind,
  lostAssignments:lostAssignments(candidate),coverage:candidate.coverage,plan:{metrics:candidate.plan.metrics}});
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
    this.searchTasks = new Map();
    this.confirmRequests = new Map();
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_incidents(id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id), event_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(shift_id,event_key));
      CREATE TABLE IF NOT EXISTS dispatch_sessions(id TEXT PRIMARY KEY, base_shift_id TEXT NOT NULL, shift_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_preferences(shift_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dispatch_incidents_status ON dispatch_incidents(json_extract(payload,'$.status'));
    `);
    store.db.prepare('INSERT OR IGNORE INTO migrations(version) VALUES (3)').run();
    // Interrupted work is requeued on restart; its durable deadline is retained.
    for (const item of this.active()) if (['SEARCHING', 'CHECKING'].includes(item.status)) this.save({ ...item, status: 'QUEUED', error: 'Расчёт продолжится после перезапуска сервера' });
    for (const row of store.db.prepare('SELECT shift_id FROM dispatch_sessions').all()) {holdDispatchClock(this,row.shift_id,false);syncDispatchPlayback(this,row.shift_id);}
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
      item.offeredChoices = [...new Map([...(current?.offeredChoices || []),...(current?.candidates || []),...item.candidates]
        .map(candidate => [candidate.id,choiceReceipt(candidate)])).values()].slice(-50);
      this.store.db.prepare('UPDATE dispatch_incidents SET payload=? WHERE id=?').run(encode(item), item.id);
      syncDispatchPlayback(this,item.shiftId);
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
    return hash({ revision: shift.revision, plan: shift.plan.contentSha256, transport:shift.transportRestrictions || [], facts: shift.factLog, team: shift.team,
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
      syncDispatchPlayback(this,shiftId);
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

  currentMinute(item, shift = this.store.get(item.shiftId)) {
    const session = decode(this.store.db.prepare('SELECT payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(item.shiftId));
    const clock = session?.clock;
    const clockMinute = clock ? clock.minute + (clock.playing && !clock.confirmingDecision ? Math.max(0, this.now()-clock.anchorAt)/60000*clock.speed : 0) : 0;
    return Math.min(1439, Math.floor(Math.max(minuteOf(item.time) + (item.mode === 'live' ? Math.max(0, (this.now()-item.createdAt)/60000) : 0),
      clockMinute, minuteOf(shift?.versions.at(-1)?.effectiveAt) || 0,
      ...(shift?.facts || []).map(fact => minuteOf(fact.time) || 0))));
  }

  requeue(item) {
    const saved = this.save({ ...item, status: 'QUEUED', candidates: [], recommendedId: null, search: null,
      error: 'Вариант устарел. Выполняется новый расчёт от текущего времени смены.' });
    this.controllers.get(item.id)?.abort();
    return saved;
  }

  prepareSearch(shift, item, time) {
    const minute = minuteOf(time);
    const unknownRelease = new Set(operationalStates(shift, minute).filter(state => state.status === 'working' && state.availableAt == null).map(state => String(state.engineerId)));
    const protectedIds = new Set((shift.facts || []).filter(fact => ['started', 'completed'].includes(fact.status)).map(fact => String(fact.orderId)));
    for (const route of shift.plan.routes) for (const visit of route.assignments) {
      if ((minuteOf(visit.departureAt) ?? Infinity) <= minute || unknownRelease.has(String(route.engineerId))) protectedIds.add(String(visit.orderId));
    }
    return [...shift.orders, item.order].map(order => protectedIds.has(String(order.id)) ? order
      : this.store.complexity.prepareOrders([order], `${shift.date}T${time}:00+03:00`)[0]);
  }
  notification(item, title, message) { item.notifications.push({ id: randomUUID(), type: 'EMERGENCY_INCIDENT', title, message, read: false, createdAt: this.now() }); }

  search(id, options) {
    if (this.searchTasks.has(id)) return this.searchTasks.get(id);
    const task=this.runSearch(id,options).finally(()=>this.searchTasks.delete(id));
    this.searchTasks.set(id,task);
    return task;
  }

  async runSearch(id, {waitForSlot = false} = {}) {
    if (this.busy && !waitForSlot) return this.get(id);
    let item = this.get(id);
    if (!item || terminal(item)) return item;
    const release = waitForSlot ? await waitForPlanningSlot() : acquirePlanningSlot();
    if (!release) return item;
    item = this.get(id);
    if (!item || terminal(item)) {release();return item;}
    this.busy = true;
    const controller = new AbortController();
    this.controllers.set(id,controller);
    try {
      const shift = this.store.get(item.shiftId), minute = this.currentMinute(item, shift), time = timeOf(minute);
      const fingerprint = this.fingerprint(shift);
      item.status = 'SEARCHING'; item.error = null; item.searchStartedAt = this.now(); this.save(item);
      const states = operationalStates(shift, minute, item.mode === 'scenario' ? 'plan' : 'fact');
      if (item.mode === 'live') throw new Error('Для точного live-выезда нужны свежие координаты и история движения. Источник телеметрии не подключён; расчётная позиция не выдаётся за фактическую.');
      const orders = this.prepareSearch(shift, item, time), prepared = orders.at(-1);
      const searchShift = { ...shift, orders: orders.slice(0,-1) }, searchItem = { ...item, order: prepared };
      const committedEngineer = item.confirmation?.state === 'CHECKING'
        ? shift.team.find(engineer => String(engineer.id) === String(item.confirmation.engineer.id)) : null;
      const event = { type: 'NEW_ORDER', time, orderId: prepared.id, order: prepared, reason: 'Аварийный выезд', incidentId: item.id };
      const result = await this.routing({ orders, team: shift.team, plan: shift.plan, planningDate: shift.date, basePlanContentSha256: shift.plan.contentSha256, event, dispatch: true,
        ...(committedEngineer ? {dispatchEngineerId:String(committedEngineer.sourceId || committedEngineer.id).split(':').at(-1)} : {}),
        transportRestrictions:shift.transportRestrictions || [], dispatchCoverageRepair:item.confirmation?.state !== 'CHECKING', facts: shift.facts }, undefined, {signal:controller.signal,onProgress:progress => {
        const fresh=this.get(id);
        if (!fresh || terminal(fresh) || controller.signal.aborted) return;
        const {dispatchCandidates:partial,...summary}=progress;
        fresh.progress={...summary, engineerName:shift.team.find(e => String(e.sourceId || e.id).split(':').at(-1) === summary.engineerId)?.name};
        // Scenario movement makes an offer require fresh confirmation; it must
        // not conceal an independently checked result while other crews search.
        if (partial?.length && this.fingerprint(this.store.get(item.shiftId))===fingerprint) {
          const described = partial.map(candidate=>this.describe(searchShift,searchItem,candidate,states,fingerprint,time));
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
      if (controller.signal.aborted) return fresh;
      if (this.fingerprint(this.store.get(item.shiftId)) !== fingerprint) {
        return this.requeue(fresh);
      }
      // Preserve reads and notices recorded while the search was running.
      item.notifications = fresh.notifications;
      item.progress = fresh.progress;
      const described = (result.dispatchCandidates || []).map(candidate => this.describe(searchShift, searchItem, candidate, states, fingerprint, time));
      const candidates = orderCandidates(described);
      if (!candidates.length) throw new Error('Независимо проверенный вариант не найден');
      item.order = prepared;
      item.candidates = candidates; item.search = result.dispatchSearch ? { ...result.dispatchSearch, rejected:result.dispatchSearch.rejected.map(entry => ({ ...entry, engineerName:shift.team.find(e => String(e.sourceId || e.id).split(':').at(-1) === entry.engineerId)?.name || entry.engineerId, reason:/unverified|ROUTING|маршрут/i.test(entry.reason) ? 'Не удалось подтвердить дорогу. Точный вариант не предлагается.' : /FROZEN|invalid/i.test(entry.reason) ? 'Не найден план, сохраняющий начатые работы и прямой выезд на аварию.' : /STATIC|NO_EXACT|TIME_WINDOW|SEARCH_BUDGET/i.test(entry.reason) ? 'В пределах поиска не найдено назначение с текущими окнами и составом.' : entry.reason })) } : null; item.status = 'WAITING'; item.version += 1;
      item.searchFinishedAt = this.now(); item.recommendedId = described[0].id;
      this.notification(item, 'Решения аварии готовы', `${candidates.length} проверенных вариантов. Рекомендован ${described[0].engineer.name}.`);
      return this.save(item);
    } catch (error) {
      const fresh = this.get(id);
      if (terminal(fresh)) return fresh;
      if (controller.signal.aborted) return this.requeue(fresh);
      fresh.status = 'ERROR'; fresh.error = error.message; fresh.retryAt = this.now()+30000;
      this.notification(fresh, 'Авария требует внимания', error.message);
      return this.save(fresh);
    } finally { release(); this.busy = false; this.controllers.delete(id); }
  }

  /** Commit the selected engineer after a fresh exact check, rather than returning to generic search. */
  confirm(id,candidateId,actor='Диспетчер') {
    if(this.confirmRequests.has(id)) return this.confirmRequests.get(id);
    const shiftId=this.get(id)?.shiftId;
    const prior=[...this.confirmRequests].findLast(([otherId])=>this.get(otherId)?.shiftId===shiftId)?.[1];
    const task=(async()=>{
      try {await prior;} catch { /* A failed earlier request must not block a different incident. */ }
      return this.confirmSelected(id,candidateId,actor);
    })().finally(()=>this.confirmRequests.delete(id));
    this.confirmRequests.set(id,task);
    return task;
  }

  async confirmSelected(id,candidateId,actor) {
    let item=this.get(id);
    if(!item || terminal(item)) return item;
    const selected=item.candidates.find(candidate=>candidate.id===candidateId) || item.offeredChoices?.find(candidate=>candidate.id===candidateId);
    if(!selected) throw new Error('Выберите готовый проверенный вариант');
    holdDispatchClock(this,item.shiftId,true);
    try {
      this.save({...item,confirmation:{state:'CHECKING',engineer:selected.engineer,requestedAt:this.now()}});
      let candidate=selected;
      const stale=item.status!=='WAITING' || !selected.plan.publicationAllowed || selected.fingerprint!==this.fingerprint(this.store.get(item.shiftId)) || selected.scenarioTime!==timeOf(this.currentMinute(item)) || minuteOf(selected.visit.departureAt)<this.currentMinute(item);
      if(stale) {
        this.controllers.get(id)?.abort();
        await this.searchTasks.get(id);
        if(terminal(this.get(id))) return this.get(id);
        const refreshed=await this.search(id,{waitForSlot:true});
        if(terminal(refreshed)) return refreshed;
        candidate=refreshed.candidates.find(option=>String(option.engineer.id)===String(selected.engineer.id));
        if(refreshed.status!=='WAITING' || !candidate) throw new Error(`Не удалось подтвердить маршрут: ${selected.engineer.name}. ${refreshed.error || 'Нет допустимого выезда от текущего положения.'}`);
        if(lostAssignments(candidate)>lostAssignments(selected) || candidate.coverage.after.unassigned>selected.coverage.after.unassigned
          || candidate.plan.metrics?.urgentAssigned<selected.plan.metrics?.urgentAssigned) throw new Error('После обновления последствия ухудшились. Решение не применено; сравните новые варианты.');
        if(candidate.kind !== selected.kind) this.save({...refreshed,confirmation:{...refreshed.confirmation,
          routeUpdate:`Положение инженера обновилось: ${candidate.kind.toLowerCase()}. Прибытие ${candidate.visit.arrival}.`}});
      }
      const accepted=this.accept(id,candidate.id,actor);
      if(accepted.status!=='ACCEPTED') throw new Error('Подтвердить выбранное направление не удалось. Решение не применено.');
      return accepted;
    } catch(error) {
      item=this.get(id);
      if(terminal(item)) return item;
      return this.save({...item,status:'ERROR',candidates:[],recommendedId:null,error:error.message,retryAt:null,
        confirmation:{state:'FAILED',engineer:selected.engineer,error:error.message}});
    } finally {holdDispatchClock(this,item.shiftId,false);}
  }

  describe(shift, incident, candidate, states, fingerprint, time) {
    const plan = candidate.plan;
    if (plan.status !== 'EXACT_VALID' || plan.validation?.status !== 'VALID' || !plan.publicationAllowed || !preservesStartedVisits(shift, plan, time)) throw new Error('Вариант не прошёл защиту начатых работ');
    const engineer = shift.team.find(item => String(item.sourceId || item.id).split(':').at(-1) === candidate.engineerSourceId);
    const route = plan.routes.find(item => item.engineerId === engineer?.id);
    const visit = route?.assignments.find(item => item.orderId === incident.order.id);
    if (!visit) throw new Error('В варианте отсутствует назначение аварии');
    const state = { ...states.find(item => item.engineerId === engineer.id) };
    const movement = route.movements?.findLast(item => item.measured_at === `${shift.date}T${time}:00+03:00`);
    if (movement) state.availableAt = movement.at.slice(11,16);
    if (['unknown', 'unavailable', 'before_shift', 'after_shift'].includes(state.status) || state.availableAt == null) throw new Error('Нет достоверного доступного оперативного состояния');
    const before = index(shift.plan), after = index(plan), orders = [...shift.orders, incident.order];
    const fromHome = engineer.startPoint?.kind === 'home' && state.status === 'idle'
      && !shift.plan.routes.find(r => r.engineerId === engineer.id)?.assignments.some(v => (minuteOf(v.departureAt) ?? Infinity) <= minuteOf(time));
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
    const at = `${shift.date}T${time}:00+03:00`;
    const history = this.store.db.prepare('SELECT id,payload_json FROM duration_visits WHERE julianday(known_at) <= julianday(?) ORDER BY revision').all(at);
    const visits = [...new Map(history.map(row => [row.id,JSON.parse(row.payload_json)])).values()].filter(visit =>
      String(visit.engineerId).split(':').at(-1) === String(engineer.sourceId || engineer.id).split(':').at(-1)
      && visit.kind === 'emergency' && visit.status === 'completed' && !visit.excluded && visit.endedAt && Date.parse(visit.endedAt) < Date.parse(at));
    const ratings = visits.filter(visit => !visit.source?.startsWith('synthetic') && Number.isFinite(visit.rating) && visit.rating >= 1 && visit.rating <= 5).map(visit => visit.rating);
    return { id: `${incident.id}:${plan.contentSha256}`, fingerprint, baseRevision: shift.revision, basePlanContentSha256: shift.plan.contentSha256, scenarioTime: time, checkedAt: this.now(), artifact: candidate.artifact,
      replacesCandidateId: candidate.improvesContentSha256 ? `${incident.id}:${candidate.improvesContentSha256}` : null, coverageRepair:candidate.coverageRepair || null,
      engineer: { id: engineer.id, name: engineer.name, skills: engineer.skills, equipment: engineer.equipment, transport: engineer.transport }, state, visit,
      departureOrigin: movement?.coords || state.coords, responseMinutes: minuteOf(visit.arrival)-minuteOf(time),
      kind: state.status === 'travelling' ? 'Перехват в пути' : state.status === 'working' ? 'После текущей работы' : fromHome ? 'Выезд из дома' : 'Свободный инженер',
      startPoint: engineer.startPoint || null,
      warnings: states.filter(state => state.status === 'working' && state.availableAt == null).map(state =>
        `${shift.team.find(engineer => engineer.id === state.engineerId)?.name || state.engineerId}: работа не завершена, время освобождения неизвестно. Его маршрут сохранён; уточните фактическое окончание.`),
      experience: { count: visits.length, scenarioCount: visits.filter(visit => visit.source?.startsWith('synthetic')).length,
        source: 'duration_visits', rating: ratings.length ? ratings.reduce((sum, value) => sum+value,0)/ratings.length : null, ratingCount: ratings.length },
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
        return this.requeue(item);
      }
      if ((minuteOf(candidate.visit.departureAt) ?? -1) < this.currentMinute(item, shift)) return this.requeue(item);
      const event = { type: 'NEW_ORDER', time: candidate.scenarioTime, order: candidate.orders.find(order => order.id === item.order.id), orderId: item.order.id, reason: actor === 'system' ? 'Авария: автоматическое решение после ожидания' : 'Авария: решение диспетчера', incidentId: id, candidateId, policy: item.policy.choice };
      const previewId = this.store.startPreview(item.shiftId, shift.revision, event);
      this.store.completePreview(previewId, { orders: candidate.orders, team: candidate.team, plan: candidate.plan });
      const saved = this.store.publish(item.shiftId, previewId, shift.revision, actor);
      item.status = 'ACCEPTED'; item.decision = { candidateId, actor, at: this.now(), revision: saved.revision, planId: saved.currentPlanId, contentSha256: candidate.contentSha256 };
      if(item.confirmation) item.confirmation={...item.confirmation,state:'APPLIED'};
      this.notification(item, actor === 'system' ? 'Авария назначена автоматически' : 'Авария назначена', `${candidate.engineer.name} · прибытие ${candidate.visit.arrival}`);
      for (const other of this.active(item.shiftId)) if (other.id !== id) this.requeue(other);
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
    for (const item of this.active()) if (!this.confirmRequests.has(item.id) && item.status === 'WAITING' && item.policy.enabled && item.deadlineAt <= this.now()) { await this.confirm(item.id,item.recommendedId,'system');return; }
    if (this.busy) return;
    for (const item of this.active().sort((left, right) => left.shiftId === right.shiftId
      ? minuteOf(left.time)-minuteOf(right.time) || left.createdAt-right.createdAt : right.createdAt-left.createdAt)) {
      if (terminal(item) || this.confirmRequests.has(item.id)) continue;
      if (item.status === 'QUEUED' || (item.status === 'ERROR' && item.confirmation?.state !== 'FAILED' && item.retryAt <= this.now())) { await this.search(item.id); return; }
      if (item.status === 'WAITING' && item.policy.enabled && item.deadlineAt <= this.now()) { await this.confirm(item.id, item.recommendedId, 'system'); return; }
    }
  }
}
