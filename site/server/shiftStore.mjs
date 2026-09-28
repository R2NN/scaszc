import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nextFact, minuteOf } from '../src/shiftDomain.js';

const encode = value => JSON.stringify(value ?? null);
const decode = value => value == null ? null : JSON.parse(value);
const now = () => new Date().toISOString();
const requireExactPlan = plan => {
  if (!plan || plan.status !== 'EXACT_VALID' || plan.publicationAllowed !== true ||
      plan.validation?.status !== 'VALID' || plan.approximateTravel === true ||
      !plan.contentSha256 || !Array.isArray(plan.routes) || !Array.isArray(plan.unassigned)) {
    throw new Error('Публикация разрешена только для независимо проверенного точного плана.');
  }
};

export class ShiftStore {
  constructor(file = process.env.BEEGO_DB_PATH || resolve('.beego-data', 'shifts.sqlite3')) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY, region_id TEXT NOT NULL, service_date TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, orders_json TEXT NOT NULL,
        team_json TEXT NOT NULL, current_plan_id TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE(region_id, service_date)
      );
      CREATE TABLE IF NOT EXISTS staff_roster (
        id TEXT PRIMARY KEY, region_id TEXT NOT NULL, source_id TEXT NOT NULL,
        payload_json TEXT NOT NULL, periods_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(region_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS plan_versions (
        id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id),
        version INTEGER NOT NULL, plan_json TEXT NOT NULL, orders_json TEXT NOT NULL,
        team_json TEXT NOT NULL, effective_at TEXT NOT NULL, source_event_id TEXT,
        created_at TEXT NOT NULL, UNIQUE(shift_id, version)
      );
      CREATE TABLE IF NOT EXISTS shift_events (
        id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id),
        revision INTEGER NOT NULL, type TEXT NOT NULL, event_time TEXT NOT NULL,
        reason TEXT NOT NULL, actor TEXT NOT NULL, payload_json TEXT NOT NULL,
        before_plan_id TEXT, after_plan_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS visit_facts (
        id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id),
        order_id TEXT NOT NULL, status TEXT NOT NULL, fact_time TEXT NOT NULL,
        payload_json TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS replan_previews (
        id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id),
        base_revision INTEGER NOT NULL, status TEXT NOT NULL,
        event_json TEXT NOT NULL, result_json TEXT, error TEXT, created_at TEXT NOT NULL,
        progress_json TEXT,
        fact_count_at_start INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ai_usage (
        month TEXT PRIMARY KEY, used_tokens INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS report_artifacts (
        id TEXT PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id),
        region_id TEXT NOT NULL, service_date TEXT NOT NULL, revision INTEGER NOT NULL,
        mode TEXT NOT NULL, generated_at TEXT NOT NULL, author TEXT NOT NULL,
        pdf BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shift_events_order ON shift_events(shift_id, revision);
      CREATE INDEX IF NOT EXISTS visit_facts_order ON visit_facts(shift_id, order_id, created_at);
      CREATE INDEX IF NOT EXISTS report_artifacts_date ON report_artifacts(region_id, service_date DESC, generated_at DESC);
    `);
    if (!this.db.pragma('table_info(replan_previews)').some(column => column.name === 'fact_count_at_start')) {
      this.db.exec('ALTER TABLE replan_previews ADD COLUMN fact_count_at_start INTEGER NOT NULL DEFAULT 0');
    }
    if (!this.db.pragma('table_info(replan_previews)').some(column => column.name === 'progress_json')) {
      this.db.exec('ALTER TABLE replan_previews ADD COLUMN progress_json TEXT');
    }
    this.db.prepare('INSERT OR IGNORE INTO migrations(version) VALUES (1)').run();
    this.seedRosterFromShifts();
    this.db.prepare("UPDATE replan_previews SET status = 'FAILED', error = 'Сервер перезапущен во время расчёта. Создайте новый черновик.' WHERE status = 'RUNNING'").run();
  }

  close() { this.db.close(); }

  seedRosterFromShifts() {
    const insert = this.db.prepare('INSERT OR IGNORE INTO staff_roster(id,region_id,source_id,payload_json,periods_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
    for (const row of this.db.prepare('SELECT region_id,service_date,team_json FROM shifts ORDER BY service_date').all()) {
      for (const engineer of decode(row.team_json) || []) {
        if (!engineer?.id || !engineer?.name) continue;
        const stamp = now();
        insert.run(String(engineer.id), row.region_id, String(engineer.sourceId || engineer.id), encode({ ...engineer, regionId: row.region_id, serviceDate: undefined, status: 'Доступен' }), encode([{ from: row.service_date, to: null }]), stamp, stamp);
      }
    }
  }

  roster(regionId) {
    if (!regionId) return [];
    return this.db.prepare('SELECT * FROM staff_roster WHERE region_id = ? ORDER BY created_at,id').all(regionId)
      .map(row => ({ ...decode(row.payload_json), id: row.id, regionId: row.region_id, sourceId: row.source_id, rosterPeriods: decode(row.periods_json), rosterArchived: Boolean(decode(row.periods_json).at(-1)?.to) }));
  }

  addStaff(engineer, activeFrom) {
    if (!engineer?.id || !engineer?.name?.trim() || !engineer?.regionId || !/^\d{4}-\d{2}-\d{2}$/.test(activeFrom || '')) throw new Error('Укажите ID, имя, регион и дату приёма.');
    const stamp = now();
    try {
      this.db.prepare('INSERT INTO staff_roster(id,region_id,source_id,payload_json,periods_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(String(engineer.id), engineer.regionId, String(engineer.sourceId || engineer.id), encode({ ...engineer, serviceDate: undefined, status: 'Доступен' }), encode([{ from: activeFrom, to: null }]), stamp, stamp);
    } catch (error) {
      if (/UNIQUE constraint/.test(error.message)) throw new Error('Инженер с таким ID уже есть в составе.');
      throw error;
    }
    return this.roster(engineer.regionId).find(item => item.id === String(engineer.id));
  }

  changeStaffAvailability(id, regionId, date, action) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Укажите дату изменения состава.');
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM staff_roster WHERE id = ? AND region_id = ?').get(id, regionId);
      if (!row) throw new Error('Инженер не найден в составе.');
      const periods = decode(row.periods_json);
      const last = periods.at(-1);
      if (action === 'archive') {
        if (last.to) throw new Error('Инженер уже находится в архиве.');
        if (date < last.from) throw new Error('Дата архивации раньше даты приёма.');
        last.to = date;
      } else if (action === 'restore') {
        if (!last.to) throw new Error('Инженер уже находится в составе.');
        if (date < last.to) throw new Error('Дата возвращения раньше даты архивации.');
        if (date === last.to) last.to = null;
        else periods.push({ from: date, to: null });
      } else throw new Error('Неизвестное действие с составом.');
      this.db.prepare('UPDATE staff_roster SET periods_json = ?, updated_at = ? WHERE id = ?').run(encode(periods), now(), id);
      return this.roster(regionId).find(item => item.id === id);
    })();
  }

  aiUsage(month) {
    return this.db.prepare('SELECT used_tokens, reserved_tokens FROM ai_usage WHERE month = ?').get(month) || { used_tokens: 0, reserved_tokens: 0 };
  }

  reserveAiBudget(month, tokens, limit) {
    return this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO ai_usage(month) VALUES (?)').run(month);
      const usage = this.aiUsage(month);
      if (usage.used_tokens + usage.reserved_tokens + tokens > limit) return false;
      this.db.prepare('UPDATE ai_usage SET reserved_tokens = reserved_tokens + ? WHERE month = ?').run(tokens, month);
      return true;
    })();
  }

  settleAiBudget(month, reserved, used) {
    this.db.prepare('UPDATE ai_usage SET reserved_tokens = max(0, reserved_tokens - ?), used_tokens = used_tokens + ? WHERE month = ?').run(reserved, Math.max(0, Math.ceil(used)), month);
  }

  ensure({ regionId, date, orders = [], team = [], plan = null }) {
    if (!regionId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Укажите регион и дату смены.');
    if (plan) requireExactPlan(plan);
    const saved = this.db.transaction(() => {
      let shift = this.db.prepare('SELECT * FROM shifts WHERE region_id = ? AND service_date = ?').get(regionId, date);
      if (!shift) {
        const stamp = now();
        const id = randomUUID();
        this.db.prepare('INSERT INTO shifts(id,region_id,service_date,orders_json,team_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, regionId, date, encode(orders), encode(team), stamp, stamp);
        shift = this.db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
        if (plan) this.#publishInitial(id, plan, orders, team);
      } else if (!shift.current_plan_id && plan) {
        this.#publishInitial(shift.id, plan, orders, team);
      } else if (shift.current_plan_id && plan) {
        const operationalEvents = this.db.prepare("SELECT count(*) AS total FROM shift_events WHERE shift_id = ? AND type NOT IN ('PLAN_REBUILT')").get(shift.id).total;
        const facts = this.db.prepare('SELECT count(*) AS total FROM visit_facts WHERE shift_id = ?').get(shift.id).total;
        if (operationalEvents || facts) throw new Error('Смена уже исполняется. Измените план через «Ход смены», чтобы сохранить историю и факты.');
        const nextRevision = shift.revision + 1, versionId = randomUUID(), eventId = randomUUID(), stamp = now();
        this.db.prepare('INSERT INTO plan_versions(id,shift_id,version,plan_json,orders_json,team_json,effective_at,source_event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(versionId, shift.id, nextRevision, encode(plan), encode(orders), encode(team), '00:00', eventId, stamp);
        this.db.prepare('INSERT INTO shift_events(id,shift_id,revision,type,event_time,reason,actor,payload_json,before_plan_id,after_plan_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(eventId, shift.id, nextRevision, 'PLAN_REBUILT', '00:00', 'Исходный план пересчитан до начала смены', 'Диспетчер', encode({}), shift.current_plan_id, versionId, stamp);
        this.db.prepare('UPDATE shifts SET revision = ?, current_plan_id = ?, orders_json = ?, team_json = ?, updated_at = ? WHERE id = ?').run(nextRevision, versionId, encode(orders), encode(team), stamp, shift.id);
      }
      return this.get(shift.id);
    })();
    this.seedRosterFromShifts();
    return saved;
  }

  #publishInitial(shiftId, plan, orders, team) {
    const id = randomUUID();
    const stamp = now();
    this.db.prepare('INSERT INTO plan_versions(id,shift_id,version,plan_json,orders_json,team_json,effective_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, shiftId, 1, encode(plan), encode(orders), encode(team), '00:00', stamp);
    this.db.prepare('UPDATE shifts SET revision = 1, current_plan_id = ?, orders_json = ?, team_json = ?, updated_at = ? WHERE id = ?').run(id, encode(orders), encode(team), stamp, shiftId);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
    if (!row) return null;
    const versions = this.db.prepare('SELECT * FROM plan_versions WHERE shift_id = ? ORDER BY version').all(id).map(item => ({ id: item.id, version: item.version, plan: decode(item.plan_json), orders: decode(item.orders_json), team: decode(item.team_json), effectiveAt: item.effective_at, sourceEventId: item.source_event_id }));
    const events = this.db.prepare('SELECT * FROM shift_events WHERE shift_id = ? ORDER BY revision, created_at').all(id).map(item => ({ id: item.id, revision: item.revision, type: item.type, time: item.event_time, reason: item.reason, actor: item.actor, payload: decode(item.payload_json), beforePlanId: item.before_plan_id, afterPlanId: item.after_plan_id }));
    const factLog = this.db.prepare('SELECT * FROM visit_facts WHERE shift_id = ? ORDER BY created_at, rowid').all(id).map(item => ({ id: item.id, orderId: item.order_id, status: item.status, time: item.fact_time, actor: item.actor, ...decode(item.payload_json) }));
    const latest = new Map(factLog.map(item => [String(item.orderId), item]));
    return { id: row.id, regionId: row.region_id, date: row.service_date, revision: row.revision, orders: decode(row.orders_json), team: decode(row.team_json), plan: versions.find(item => item.id === row.current_plan_id)?.plan || null, currentPlanId: row.current_plan_id, versions, events, facts: [...latest.values()], factLog };
  }

  byDate(regionId, date) {
    const row = this.db.prepare('SELECT id FROM shifts WHERE region_id = ? AND service_date = ?').get(regionId, date);
    return row ? this.get(row.id) : null;
  }

  history(regionId, throughDate, limit = 12) {
    if (!regionId || !/^\d{4}-\d{2}-\d{2}$/.test(throughDate || '')) return [];
    return this.db.prepare('SELECT id FROM shifts WHERE region_id = ? AND service_date <= ? AND current_plan_id IS NOT NULL ORDER BY service_date DESC LIMIT ?')
      .all(regionId, throughDate, Math.max(1, Math.min(31, Number(limit) || 12)))
      .map(row => this.get(row.id));
  }

  saveReportArtifact({ shift, mode, author, generatedAt, pdf }) {
    if (!shift?.id || !Buffer.isBuffer(pdf) || !pdf.length) throw new Error('Невозможно сохранить пустой отчёт.');
    const id = randomUUID();
    this.db.prepare('INSERT INTO report_artifacts(id,shift_id,region_id,service_date,revision,mode,generated_at,author,pdf) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, shift.id, shift.regionId, shift.date, shift.revision, mode, generatedAt, author || 'Диспетчер', pdf);
    return { id, shiftId: shift.id, regionId: shift.regionId, date: shift.date, revision: shift.revision, mode, generatedAt, author: author || 'Диспетчер' };
  }

  reportArtifact(id) {
    const row = this.db.prepare('SELECT * FROM report_artifacts WHERE id = ?').get(id);
    return row ? { id: row.id, shiftId: row.shift_id, regionId: row.region_id, date: row.service_date, revision: row.revision, mode: row.mode, generatedAt: row.generated_at, author: row.author, pdf: row.pdf } : null;
  }

  reportArchive(regionId, throughDate, limit = 50) {
    if (!regionId || !/^\d{4}-\d{2}-\d{2}$/.test(throughDate || '')) return [];
    return this.db.prepare('SELECT id,shift_id,region_id,service_date,revision,mode,generated_at,author FROM report_artifacts WHERE region_id = ? AND service_date <= ? ORDER BY service_date DESC, generated_at DESC LIMIT ?')
      .all(regionId, throughDate, Math.max(1, Math.min(100, Number(limit) || 50)))
      .map(row => ({ id: row.id, shiftId: row.shift_id, regionId: row.region_id, date: row.service_date, revision: row.revision, mode: row.mode, generatedAt: row.generated_at, author: row.author }));
  }

  startPreview(shiftId, baseRevision, event) {
    const shift = this.get(shiftId);
    if (!shift) throw new Error('Смена не найдена.');
    if (shift.revision !== baseRevision) throw new Error('План изменился. Обновите смену и повторите расчёт.');
    const eventTime = minuteOf(event?.time);
    if (eventTime == null) throw new Error('Укажите корректное время события.');
    if (eventTime < (minuteOf(shift.versions.at(-1)?.effectiveAt) ?? 0)) throw new Error('Время события раньше последней публикации. Хронологию смены нельзя менять задним числом.');
    const id = randomUUID();
    const factCount = this.db.prepare('SELECT count(*) AS total FROM visit_facts WHERE shift_id = ?').get(shiftId).total;
    this.db.prepare('INSERT INTO replan_previews(id,shift_id,base_revision,status,event_json,created_at,fact_count_at_start,progress_json) VALUES (?,?,?,?,?,?,?,?)').run(id, shiftId, baseRevision, 'RUNNING', encode(event), now(), factCount, encode({ phase: 'DRAFT', checkedRoads: 0 }));
    return id;
  }

  updatePreviewProgress(id, progress) {
    this.db.prepare('UPDATE replan_previews SET progress_json = ? WHERE id = ? AND status = ?').run(encode(progress), id, 'RUNNING');
  }

  completePreview(id, result) {
    this.db.prepare('UPDATE replan_previews SET status = ?, result_json = ?, progress_json = ? WHERE id = ? AND status = ?').run('READY', encode(result), encode({ phase: 'READY', checkedRoads: Number(result?.plan?.validation?.exactCheckedVisits) || 0 }), id, 'RUNNING');
  }

  failPreview(id, error) {
    this.db.prepare('UPDATE replan_previews SET status = ?, error = ? WHERE id = ? AND status = ?').run('FAILED', String(error?.message || error), id, 'RUNNING');
  }

  preview(id) {
    const row = this.db.prepare('SELECT * FROM replan_previews WHERE id = ?').get(id);
    if (!row) return null;
    const newerFacts = row.status !== 'DISCARDED' && this.db.prepare('SELECT count(*) AS total FROM visit_facts WHERE shift_id = ?').get(row.shift_id).total > row.fact_count_at_start;
    return { id, shiftId: row.shift_id, baseRevision: row.base_revision, status: newerFacts ? 'FAILED' : row.status, event: decode(row.event_json), result: newerFacts ? null : decode(row.result_json), progress: decode(row.progress_json), error: newerFacts ? 'После расчёта появился новый факт визита. Создайте новый черновик.' : row.error };
  }

  latestPreview(shiftId) {
    const row = this.db.prepare('SELECT id FROM replan_previews WHERE shift_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(shiftId);
    const latest = row ? this.preview(row.id) : null;
    return latest?.status === 'DISCARDED' ? null : latest;
  }

  discardPreview(shiftId, previewId, expectedRevision) {
    const shift = this.get(shiftId);
    if (!shift) throw new Error('Смена не найдена.');
    const preview = this.preview(previewId);
    if (!preview || preview.shiftId !== shiftId) throw new Error('Черновик смены не найден.');
    if (preview.baseRevision !== expectedRevision) throw new Error('Черновик устарел: смена уже была изменена.');
    this.db.prepare("UPDATE replan_previews SET status = 'DISCARDED' WHERE id = ? AND shift_id = ? AND base_revision = ? AND status <> 'DISCARDED'").run(previewId, shiftId, expectedRevision);
    return { id: previewId, shiftId, status: 'DISCARDED' };
  }

  publish(shiftId, previewId, expectedRevision, actor = 'Диспетчер') {
    return this.db.transaction(() => {
      const shift = this.get(shiftId);
      const preview = this.preview(previewId);
      if (!shift || !preview || preview.shiftId !== shiftId) throw new Error('Черновик смены не найден.');
      if (shift.revision !== expectedRevision || preview.baseRevision !== expectedRevision) throw new Error('Черновик устарел: смена уже была изменена.');
      if (this.latestPreview(shiftId)?.id !== previewId) throw new Error('Черновик устарел: создан более новый расчёт или прежний отменён.');
      if (preview.error?.includes('новый факт визита')) throw new Error(preview.error);
      if (preview.status !== 'READY' || !preview.result?.plan) throw new Error('Черновик ещё не прошёл расчёт.');
      const previewRow = this.db.prepare('SELECT fact_count_at_start FROM replan_previews WHERE id = ?').get(previewId);
      const newerFacts = this.db.prepare('SELECT count(*) AS total FROM visit_facts WHERE shift_id = ?').get(shiftId).total > previewRow.fact_count_at_start;
      if (newerFacts) throw new Error('После расчёта появился новый факт визита. Пересчитайте черновик, чтобы не изменить выполненную работу.');
      const { plan, orders, team } = preview.result;
      requireExactPlan(plan);
      const stamp = now();
      const versionId = randomUUID();
      const eventId = randomUUID();
      const revision = shift.revision + 1;
      this.db.prepare('INSERT INTO plan_versions(id,shift_id,version,plan_json,orders_json,team_json,effective_at,source_event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(versionId, shiftId, revision, encode(plan), encode(orders), encode(team), preview.event.time, eventId, stamp);
      this.db.prepare('INSERT INTO shift_events(id,shift_id,revision,type,event_time,reason,actor,payload_json,before_plan_id,after_plan_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(eventId, shiftId, revision, preview.event.type, preview.event.time, preview.event.reason, actor, encode(preview.event), shift.currentPlanId, versionId, stamp);
      this.db.prepare('UPDATE shifts SET revision = ?, current_plan_id = ?, orders_json = ?, team_json = ?, updated_at = ? WHERE id = ?').run(revision, versionId, encode(orders), encode(team), stamp, shiftId);
      return this.get(shiftId);
    })();
  }

  recordFact(shiftId, update, actor = 'Диспетчер') {
    return this.db.transaction(() => {
      const shift = this.get(shiftId);
      if (!shift) throw new Error('Смена не найдена.');
      const known = shift.orders.some(item => String(item.id) === String(update.orderId)) || shift.versions.some(version => version.orders.some(item => String(item.id) === String(update.orderId)));
      if (!known) throw new Error('Заявка не найдена в смене.');
      const introduced = shift.versions.find(version => version.orders.some(item => String(item.id) === String(update.orderId)));
      const firstAssignment = shift.versions.find(version => version.plan?.routes?.some(route => (route.assignments || []).some(item => String(item.orderId) === String(update.orderId))));
      const earliest = ['started', 'completed'].includes(update.status) ? firstAssignment?.effectiveAt : introduced?.effectiveAt;
      if ((minuteOf(update.time) ?? -1) < (minuteOf(earliest) ?? 0)) throw new Error('Фактическая отметка раньше появления заявки в плане смены.');
      const currentlyAssigned = (shift.plan?.routes || []).some(route => (route.assignments || []).some(item => String(item.orderId) === String(update.orderId)));
      if (['started', 'completed'].includes(update.status) && !currentlyAssigned) throw new Error('Начать или завершить можно только визит в текущем плане.');
      const prior = shift.facts.find(item => String(item.orderId) === String(update.orderId));
      const fact = nextFact(prior, update, { correction: Boolean(update.correctionReason) });
      this.db.prepare('INSERT INTO visit_facts(id,shift_id,order_id,status,fact_time,payload_json,actor,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), shiftId, String(update.orderId), fact.status, fact.time, encode(fact), actor, now());
      return this.get(shiftId);
    })();
  }

  rollback(shiftId, targetPlanId, expectedRevision, actor = 'Диспетчер', time = '00:00') {
    return this.db.transaction(() => {
      const shift = this.get(shiftId);
      if (!shift) throw new Error('Смена не найдена.');
      if (shift.revision !== expectedRevision) throw new Error('План уже изменился. Обновите смену.');
      const target = shift.versions.find(item => item.id === targetPlanId);
      if (!target || target.id === shift.currentPlanId) throw new Error('Предыдущая версия плана не найдена.');
      const at = minuteOf(time);
      if (at == null) throw new Error('Укажите время отката.');
      if (at < (minuteOf(shift.versions.at(-1)?.effectiveAt) ?? 0)) throw new Error('Время отката раньше последней публикации. Историю смены нельзя менять задним числом.');
      const currentPast = (shift.plan.routes || []).flatMap(route => (route.assignments || []).filter(item => (minuteOf(item.plannedStart) ?? 1440) < at).map(item => `${route.engineerId}:${item.orderId}:${item.plannedStart}`)).sort();
      const targetPast = (target.plan.routes || []).flatMap(route => (route.assignments || []).filter(item => (minuteOf(item.plannedStart) ?? 1440) < at).map(item => `${route.engineerId}:${item.orderId}:${item.plannedStart}`)).sort();
      if (JSON.stringify(currentPast) !== JSON.stringify(targetPast)) throw new Error('Откат затронет прошлую часть смены. Выберите допустимую версию или время.');
      const targetAssigned = new Set((target.plan.routes || []).flatMap(route => (route.assignments || []).map(item => String(item.orderId))));
      const protectedFacts = (shift.facts || []).filter(item => ['started', 'completed'].includes(item.status));
      if (protectedFacts.some(item => !targetAssigned.has(String(item.orderId)))) throw new Error('Откат удалит уже начатый или выполненный визит. Выберите другую версию.');
      const revision = shift.revision + 1;
      const versionId = randomUUID();
      const eventId = randomUUID();
      const stamp = now();
      this.db.prepare('INSERT INTO plan_versions(id,shift_id,version,plan_json,orders_json,team_json,effective_at,source_event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(versionId, shiftId, revision, encode(target.plan), encode(target.orders), encode(target.team), time, eventId, stamp);
      this.db.prepare('INSERT INTO shift_events(id,shift_id,revision,type,event_time,reason,actor,payload_json,before_plan_id,after_plan_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(eventId, shiftId, revision, 'PLAN_ROLLBACK', time, 'Восстановлена предыдущая версия плана', actor, encode({ targetPlanId, time }), shift.currentPlanId, versionId, stamp);
      this.db.prepare('UPDATE shifts SET revision = ?, current_plan_id = ?, orders_json = ?, team_json = ?, updated_at = ? WHERE id = ?').run(revision, versionId, encode(target.orders), encode(target.team), stamp, shiftId);
      return this.get(shiftId);
    })();
  }

  backup(target) {
    if (!target) throw new Error('Укажите путь резервной копии.');
    return this.db.backup(target);
  }
}
