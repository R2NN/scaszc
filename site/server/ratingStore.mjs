import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalDemoInput } from '../src/canonicalDemo.js';
import { engineerIdentity } from '../src/engineerPresentation.js';
import { staffActiveOn } from '../src/staffRoster.js';

const json = value => JSON.stringify(value);
const parse = value => value ? JSON.parse(value) : null;
const stamp = () => new Date().toISOString();
const effectiveReviewScore = (original, payload) => Number.isInteger(payload.correction?.score) && payload.correction.score >= 1 && payload.correction.score <= 5 ? payload.correction.score : original;
export const ratingSummary = reviews => {
  const included = reviews.filter(item => item.included !== false && item.included !== 0);
  const total = included.reduce((sum, item) => sum + Number(item.score), 0);
  const mean = included.length ? total / included.length : null;
  // Twenty prior reviews prevent a single five-star review outranking a proven specialist.
  const score = (total + 20 * 4.2) / (included.length + 20);
  return { score: Number(score.toFixed(4)), average: mean == null ? null : Number(mean.toFixed(4)), count: included.length, excluded: reviews.length - included.length,
    distribution: [5, 4, 3, 2, 1].map(stars => ({ stars, count: included.filter(item => Number(item.score) === stars).length })),
    repeatClients: included.filter(item => item.preferred).length };
};

export class RatingStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS rating_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rating_engineers (id TEXT PRIMARY KEY, region_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rating_visits (id TEXT PRIMARY KEY, engineer_id TEXT NOT NULL REFERENCES rating_engineers(id), payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rating_reviews (id TEXT PRIMARY KEY, engineer_id TEXT NOT NULL REFERENCES rating_engineers(id), visit_id TEXT NOT NULL UNIQUE REFERENCES rating_visits(id), score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5), included INTEGER NOT NULL DEFAULT 1, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rating_cases (id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES rating_reviews(id), status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rating_messages (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES rating_cases(id), created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rating_decisions (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES rating_cases(id), created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rating_scenarios (id TEXT PRIMARY KEY, region_id TEXT NOT NULL, service_date TEXT NOT NULL, status TEXT NOT NULL, saved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rating_case_triage (case_id TEXT PRIMARY KEY REFERENCES rating_cases(id), viewed_at TEXT, viewed_by TEXT, flagged INTEGER NOT NULL DEFAULT 0, incoming_id TEXT);
      CREATE INDEX IF NOT EXISTS rating_review_engineer ON rating_reviews(engineer_id);
      CREATE INDEX IF NOT EXISTS rating_message_case ON rating_messages(case_id, created_at);
      CREATE INDEX IF NOT EXISTS rating_scenario_date ON rating_scenarios(region_id, service_date, created_at DESC);
    `);
    for (const row of db.prepare("SELECT id,payload_json FROM rating_scenarios WHERE status='RUNNING'").all()) {
      this.updateScenario(row.id, { ...parse(row.payload_json), status: 'FAILED', error: 'Сервер перезапущен. Повторите расчёт сценария.' });
    }
  }
  version() { return Number(this.db.prepare("SELECT value FROM rating_meta WHERE key='version'").get()?.value || 1); }
  bump() { this.db.prepare("INSERT INTO rating_meta(key,value) VALUES ('version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.version() + 1)); }
  async seed(siteRoot = path.resolve(import.meta.dirname, '..')) {
    if (this.db.prepare("SELECT value FROM rating_meta WHERE key='seed'").get()) { this.seedCaseHistory(); this.seedFeedbackVisits(); this.ensureReserveRatingSpread(); return; }
    const [fixture, artifact] = await Promise.all(['public/test-data/beego-algorithm-initial.json', 'public/data/beego-exact-plans.json'].map(file => readFile(path.join(siteRoot, file), 'utf8').then(JSON.parse)));
    const base = canonicalDemoInput(fixture, artifact);
    const firstNames = ['Алексей', 'Дмитрий', 'Сергей', 'Андрей', 'Михаил', 'Илья', 'Павел', 'Никита', 'Антон', 'Максим'];
    const surnames = ['Волков', 'Соколов', 'Орлов', 'Морозов', 'Лебедев', 'Смирнов', 'Козлов', 'Новиков', 'Фёдоров', 'Зайцев'];
    const crew = [...base.engineers.map(item => ({ ...item, kind: 'staff', templateId: item.id })), ...Array.from({ length: 1000 }, (_, index) => {
      const template = base.engineers[index % base.engineers.length], id = `RATING-${String(index + 1).padStart(4, '0')}`;
      return { ...template, id, sourceId: id, kind: 'reserve', templateId: template.id,
        name: `${firstNames[index % 10]} ${surnames[Math.floor(index / 10) % 10]} · ${String(index + 1).padStart(4, '0')}`,
        sourceData: { ...template.sourceData, engineer_id: id }, synthetic: true };
    })];
    const addEngineer = this.db.prepare('INSERT INTO rating_engineers VALUES (?,?,?,?)');
    const addVisit = this.db.prepare('INSERT INTO rating_visits VALUES (?,?,?)');
    const addReview = this.db.prepare('INSERT INTO rating_reviews VALUES (?,?,?,?,1,?)');
    this.db.transaction(() => {
      crew.forEach((engineer, index) => {
        addEngineer.run(engineer.id, engineer.regionId, engineer.kind, json(engineer));
        const count = index < 35 ? 80 + (index * 17) % 71 : 12 + (index * 7) % 35;
        for (let n = 0; n < count; n++) {
          const key = `${engineer.id}-${n + 1}`, visitId = `RV-${key}`, reviewId = `RR-${key}`;
          const day = new Date(Date.UTC(2026, 7, 16) - (n % 90) * 86400000).toISOString().slice(0, 10);
          const original = base.orders.filter(item => item.zoneId === engineer.zoneId);
          const order = original[(n + index) % original.length];
          const quality = index < 35 ? 3 + index % 4 : 2 + index % 13;
          const score = n === 0 && index === 1 ? 1 : n === 0 && index === 35 ? 3 : (n * 37 + index * 11) % 100 < quality * 4 ? ((n + index) % 6 === 0 ? 3 : 4) : 5;
          const client = ['Анна К.', 'Михаил С.', 'Елена К.', 'Ольга Н.', 'Александр П.', 'Ирина В.'][(n + index) % 6];
          const visit = { id: visitId, engineerId: engineer.id, date: day, orderId: `QUALITY-${String(index + 1).padStart(4, '0')}-${n + 1}`, sourceOrderId: order.sourceId,
            address: order.address, coords: order.coords, skill: order.skill, client, arrivedAt: '13:50', startedAt: '14:00', finishedAt: '15:10', status: 'completed', provenance: 'SYNTHETIC_RATING_HISTORY' };
          const review = { id: reviewId, engineerId: engineer.id, visitId, client, date: `${day}T15:30:00+03:00`, preferred: score === 5 && n % 4 === 0,
            comment: index === 1 && n === 0 ? 'Мастер отличный, но назначения ждали неделю.' : index === 2 && n === 0 ? 'Мастер вежливый, но вечером интернет снова пропал.' : score === 5 ? ['Всё объяснил, подключение работает.', 'Аккуратная работа. Спасибо мастеру!', 'Проверили результат вместе, всё в порядке.'][n % 3] : score === 4 ? 'Работой доволен. Хотелось точнее знать время приезда.' : 'Проблема повторилась. Прошу проверить результат работы.',
            provenance: 'SYNTHETIC_RATING_HISTORY', createdAt: `${day}T15:30:00+03:00` };
          addVisit.run(visitId, engineer.id, json(visit));
          addReview.run(reviewId, engineer.id, visitId, score, json(review));
        }
      });
      for (const [index, text] of [[1, 'Прошу проверить оценку: клиент недоволен сроком назначения. Подключение проверили вместе, всё работает.'], [35, 'После визита проблема повторилась. Прикрепил фото подключения, готов уточнить обстоятельства.'], [2, 'В отзыве пять звёзд, но клиент пишет, что проблема осталась. Прошу уточнить результат.'], [36, 'Прошу проверить, относится ли оценка ко времени ожидания или к моей работе.']]) {
        const engineer = crew[index], review = this.reviews(engineer.id).find(item => item.id === `RR-${engineer.id}-1`), id = `RC-${index}`;
        const createdAt = '2026-08-16T16:00:00+03:00';
        this.db.prepare('INSERT INTO rating_cases VALUES (?,?,?,1,?)').run(id, review.id, index === 1 ? 'OPEN' : 'IN_PROGRESS', json({ id, engineerId: engineer.id, reviewId: review.id, subject: 'Проверка оценки клиента', createdAt, updatedAt: createdAt, synthetic: true }));
        this.insertMessage(id, { role: 'engineer', author: engineer.name, text, attachments: [] }, createdAt);
        this.insertMessage(id, { role: 'dispatcher', author: 'Юлия Кузнецова', text: 'Здравствуйте. Проверю отзыв и обстоятельства визита. Пришлите, пожалуйста, подтверждение результата работы.', attachments: [] }, '2026-08-16T16:05:00+03:00');
        this.insertMessage(id, { role: 'engineer', author: engineer.name, text: 'Прикрепил фото подключения. Клиент подтвердил, что интернет работает.', attachments: [{ name: 'Подключение.png', url: '/rating-attachments/router-installation.png', type: 'image/png', synthetic: true }] }, '2026-08-16T16:08:00+03:00');
      }
      this.db.prepare("INSERT INTO rating_meta VALUES ('seed','1')").run();
      this.db.prepare("INSERT OR IGNORE INTO rating_meta VALUES ('version','1')").run();
    })();
    this.seedCaseHistory(); this.seedFeedbackVisits(); this.ensureReserveRatingSpread();
  }
  ensureReserveRatingSpread() {
    if (this.db.prepare("SELECT value FROM rating_meta WHERE key='reserve-rating-spread-v1'").get()) return;
    const reserves = this.db.prepare("SELECT id FROM rating_engineers WHERE kind='reserve' ORDER BY id").all();
    const update = this.db.prepare('UPDATE rating_reviews SET score=? WHERE engineer_id=? AND id=?');
    this.db.transaction(() => {
      reserves.forEach((row, index) => {
        const target = index % 17 === 0 ? 2 : index % 11 === 0 ? 3 : null;
        if (target == null) return;
        const reviews = this.db.prepare('SELECT id FROM rating_reviews WHERE engineer_id=? ORDER BY id LIMIT 10').all(row.id);
        reviews.slice(0, target === 2 ? 8 : 5).forEach(review => update.run(target, row.id, review.id));
      });
      this.db.prepare("INSERT INTO rating_meta VALUES ('reserve-rating-spread-v1','1')").run();
      this.bump();
    })();
  }
  seedCaseHistory() {
    if (this.db.prepare("SELECT value FROM rating_meta WHERE key='case-history-v2'").get()) return;
    this.db.transaction(() => {
      for (const [id, score, comment] of [['RC-2', 5, 'Мастер вежливый, но вечером интернет снова пропал.'], ['RC-35', 3, 'После подключения проблема повторилась. Прошу проверить результат.'], ['RC-36', 4, 'Подключение работает, но дату визита переносили несколько раз.']]) {
        const row = this.db.prepare("SELECT r.* FROM rating_cases c JOIN rating_reviews r ON r.id=c.review_id WHERE c.id=? AND c.status!='RESOLVED' AND NOT EXISTS(SELECT 1 FROM rating_decisions d WHERE d.case_id=c.id)").get(id);
        if (!row) continue;
        const review = parse(row.payload_json);
        if (review.provenance !== 'SYNTHETIC_RATING_HISTORY') continue;
        this.db.prepare('UPDATE rating_reviews SET score=?,payload_json=? WHERE id=?').run(score, json({ ...review, comment }), row.id);
      }
      this.db.prepare("INSERT INTO rating_meta VALUES ('case-history-v2','1')").run();
      this.bump();
    })();
  }
  seedFeedbackVisits() {
    if (this.db.prepare("SELECT value FROM rating_meta WHERE key='feedback-visits'").get()) return;
    this.db.transaction(() => {
      for (const row of this.db.prepare('SELECT id FROM rating_engineers').all()) {
        const original = parse(this.db.prepare('SELECT payload_json FROM rating_visits WHERE engineer_id=? LIMIT 1').get(row.id)?.payload_json);
        if (!original) continue;
        const visit = { ...original, id: `RV-${row.id}-FEEDBACK`, orderId: `QUALITY-${row.id}-NEW`, client: '', feedbackPending: true };
        this.db.prepare('INSERT OR IGNORE INTO rating_visits VALUES (?,?,?)').run(visit.id, row.id, json(visit));
      }
      this.db.prepare("INSERT INTO rating_meta VALUES ('feedback-visits','1')").run();
    })();
  }
  syncCompletedVisits() {
    // Attribution comes from the published plan effective when completion was recorded.
    // The client never supplies an engineer ID.
    const completed = this.db.prepare("SELECT f.*,s.region_id,s.service_date FROM visit_facts f JOIN shifts s ON s.id=f.shift_id WHERE f.status='completed' AND NOT EXISTS(SELECT 1 FROM rating_visits v WHERE v.id='OP-'||f.shift_id||'-'||f.order_id)").all();
    this.db.transaction(() => {
      for (const fact of completed) {
        const version = this.db.prepare('SELECT id,plan_json,team_json,orders_json FROM plan_versions WHERE shift_id=? AND effective_at<=? ORDER BY version DESC LIMIT 1').get(fact.shift_id, fact.fact_time);
        if (!version) continue;
        const plan = parse(version.plan_json), route = plan.routes.find(item => item.assignments.some(entry => String(entry.orderId) === String(fact.order_id)));
        const engineer = parse(version.team_json).find(item => String(item.id) === String(route?.engineerId));
        const order = parse(version.orders_json).find(item => String(item.id) === String(fact.order_id));
        if (!engineer || !order) continue;
        const engineerId = engineerIdentity(engineer);
        this.db.prepare('INSERT OR IGNORE INTO rating_engineers VALUES (?,?,?,?)').run(engineerId, fact.region_id, 'staff', json({ ...engineer, id: engineerId, kind: 'staff', templateId: engineerId }));
        const visit = { id: `OP-${fact.shift_id}-${fact.order_id}`, engineerId, orderId: order.sourceId || order.id, address: order.address, coords: order.coords, client: order.client || '', date: fact.service_date, status: 'completed', finishedAt: fact.fact_time, provenance: 'OPERATIONAL_COMPLETED_FACT', planVersionId: version.id, factId: fact.id };
        this.db.prepare('INSERT OR IGNORE INTO rating_visits VALUES (?,?,?)').run(visit.id, engineerId, json(visit));
      }
    })();
  }
  syncRoster(roster) {
    this.db.transaction(() => {
      let changed = false;
      for (const member of roster) {
        const id = engineerIdentity(member);
        const existing = this.db.prepare('SELECT payload_json FROM rating_engineers WHERE id=?').get(id);
        const profile = member;
        const next = json({ ...parse(existing?.payload_json), ...profile, id, sourceId: id, kind: 'staff', templateId: id });
        if (next === existing?.payload_json) continue;
        this.db.prepare('INSERT INTO rating_engineers VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET region_id=excluded.region_id,kind=excluded.kind,payload_json=excluded.payload_json').run(id, member.regionId, 'staff', next);
        changed = true;
      }
      if (changed) this.bump();
    })();
  }
  addReview(input) {
    return this.db.transaction(() => {
      const visit = parse(this.db.prepare('SELECT payload_json FROM rating_visits WHERE id=?').get(String(input.visitId))?.payload_json);
      if (!visit || visit.status !== 'completed') throw new Error('Отзыв возможен только после завершённого визита.');
      if (this.db.prepare('SELECT id FROM rating_reviews WHERE visit_id=?').get(visit.id)) throw new Error('Для этого визита отзыв уже получен.');
      const client = String(input.client || '').trim(), comment = String(input.comment || '').trim(), score = Number(input.score);
      if (!client || client.length > 100 || comment.length < 3 || comment.length > 2000 || !Number.isInteger(score) || score < 1 || score > 5) throw new Error('Укажите клиента, оценку от 1 до 5 и отзыв от 3 до 2000 символов.');
      const review = { id: randomUUID(), engineerId: visit.engineerId, visitId: visit.id, client, comment, date: stamp(), createdAt: stamp(), preferred: input.preferred === true, provenance: visit.provenance };
      this.db.prepare('INSERT INTO rating_reviews VALUES (?,?,?,?,1,?)').run(review.id, visit.engineerId, visit.id, score, json(review));
      this.bump(); return this.engineer(visit.engineerId);
    })();
  }
  createCase(input) {
    return this.db.transaction(() => {
      const review = this.db.prepare('SELECT engineer_id FROM rating_reviews WHERE id=?').get(String(input.reviewId));
      if (!review) throw new Error('Отзыв не найден.');
      const existing = this.db.prepare("SELECT id FROM rating_cases WHERE review_id=? AND status!='RESOLVED'").get(input.reviewId);
      if (existing) return this.case(existing.id);
      const text = String(input.text || '').trim();
      if (text.length < 10 || text.length > 4000) throw new Error('Опишите причину обращения: от 10 до 4000 символов.');
      if(input.origin != null && !['engineer','client'].includes(input.origin))throw new Error('Источник обращения — инженер или клиент.');
      const origin=input.origin||'engineer';
      const id = randomUUID(), createdAt = stamp();
      this.db.prepare('INSERT INTO rating_cases VALUES (?,?,?,1,?)').run(id, input.reviewId, 'OPEN', json({ id, engineerId: review.engineer_id, reviewId: input.reviewId, origin, appealText:text, subject: origin==='client'?'Проверка результата работы':'Оспаривание отзыва', createdAt, updatedAt: createdAt }));
      const client=parse(this.db.prepare('SELECT payload_json FROM rating_reviews WHERE id=?').get(input.reviewId)?.payload_json)?.client;
      this.insertMessage(id, { role: origin, author: origin==='client'?client||'Клиент':this.engineer(review.engineer_id).name, text, attachments: [] });
      return this.case(id);
    })();
  }
  reviews(engineerId) {
    const seenSynthetic = new Set();
    return this.db.prepare('SELECT * FROM rating_reviews WHERE engineer_id=? ORDER BY id').all(engineerId).map(row => { const payload = parse(row.payload_json); return { ...payload, originalScore: row.score, score: effectiveReviewScore(row.score, payload), included: Boolean(row.included), visit: parse(this.db.prepare('SELECT payload_json FROM rating_visits WHERE id=?').get(row.visit_id)?.payload_json) }; }).sort((a, b) => b.date.localeCompare(a.date)).filter(review => {
      if (review.provenance !== 'SYNTHETIC_RATING_HISTORY') return true;
      const key = `${review.client || ''}|${String(review.date || '').slice(0, 10)}`;
      if (seenSynthetic.has(key)) return false;
      seenSynthetic.add(key);
      return true;
    });
  }
  catalog(regionId = 'moscow', date = null) {
    const summaries = new Map();
    const seenSynthetic = new Set();
    for (const row of this.db.prepare('SELECT engineer_id,score,included,payload_json FROM rating_reviews').all()) {
      const payload = parse(row.payload_json);
      if (payload.provenance === 'SYNTHETIC_RATING_HISTORY') {
        const key = `${row.engineer_id}|${payload.client || ''}|${String(payload.date || '').slice(0, 10)}`;
        if (seenSynthetic.has(key)) continue;
        seenSynthetic.add(key);
      }
      const list = summaries.get(row.engineer_id) || []; list.push({ score: effectiveReviewScore(row.score, payload), included: row.included, preferred: payload.preferred }); summaries.set(row.engineer_id, list);
    }
    return this.db.prepare('SELECT * FROM rating_engineers WHERE region_id=?').all(regionId).map(row => {
      const profile = parse(row.payload_json);
      return {...profile,available:profile.available !== false && (!date || !profile.rosterPeriods || staffActiveOn(profile,date)),rating:ratingSummary(summaries.get(row.id) || [])};
    }).sort((a, b) => b.rating.score - a.rating.score || b.rating.count - a.rating.count || a.id.localeCompare(b.id));
  }
  engineer(id) {
    const row = this.db.prepare('SELECT payload_json FROM rating_engineers WHERE id=?').get(id);
    if (!row) throw new Error('Инженер не найден.');
    const reviews = this.reviews(id);
    const pendingVisits = this.db.prepare('SELECT v.payload_json FROM rating_visits v LEFT JOIN rating_reviews r ON r.visit_id=v.id WHERE v.engineer_id=? AND r.id IS NULL').all(id).map(item => parse(item.payload_json));
    return { ...parse(row.payload_json), rating: ratingSummary(reviews), reviews, pendingVisits };
  }
  cases() { return this.db.prepare('SELECT * FROM rating_cases ORDER BY rowid').all().map(row => this.case(row.id, false)); }
  case(id, messages = true) {
    const row = this.db.prepare('SELECT * FROM rating_cases WHERE id=?').get(id);
    if (!row) throw new Error('Обращение не найдено.');
    const data = parse(row.payload_json), engineer = this.engineer(data.engineerId);
    const review = engineer.reviews.find(item => item.id === row.review_id);
    const triage=this.db.prepare('SELECT * FROM rating_case_triage WHERE case_id=?').get(id);
    const incoming=this.db.prepare("SELECT id,payload_json FROM rating_messages WHERE case_id=? AND json_extract(payload_json,'$.role')!='dispatcher' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id);
    const first=this.db.prepare('SELECT payload_json FROM rating_messages WHERE case_id=? ORDER BY created_at,rowid LIMIT 1').get(id);
    const firstMessage=parse(first?.payload_json);
    return { ...data, origin:data.origin || (firstMessage?.role === 'client' ? 'client' : 'engineer'), appealText:data.appealText || firstMessage?.text || data.subject,
      triage:{viewed:Boolean(triage?.viewed_at),viewedAt:triage?.viewed_at||null,viewedBy:triage?.viewed_by||null,flagged:Boolean(triage?.flagged),unread:!triage?.viewed_at || (incoming?.id||null)!==(triage?.incoming_id||null)},
      status: row.status, revision: row.revision, engineer: { id: engineer.id, name: engineer.name, rating: engineer.rating }, review, capabilities: { clientScoreCorrection: true,caseTriage:true },
      messages: messages ? this.db.prepare('SELECT payload_json FROM rating_messages WHERE case_id=? ORDER BY created_at,rowid').all(id).map(item => parse(item.payload_json)) : undefined,
      decisions: this.db.prepare('SELECT payload_json FROM rating_decisions WHERE case_id=? ORDER BY rowid').all(id).map(item => parse(item.payload_json)) };
  }
  triageCase(id,input) {
    this.case(id,false);
    if(typeof input.viewed!=='boolean' && typeof input.flagged!=='boolean')throw new Error('Укажите отметку просмотра или важности.');
    const existing=this.db.prepare('SELECT * FROM rating_case_triage WHERE case_id=?').get(id);
    const incoming=this.db.prepare("SELECT id FROM rating_messages WHERE case_id=? AND json_extract(payload_json,'$.role')!='dispatcher' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id);
    const viewed=input.viewed===true?stamp():input.viewed===false?null:existing?.viewed_at||null;
    const actor=input.viewed===true?String(input.actor||'Диспетчер').trim().slice(0,120):existing?.viewed_by||null;
    const flagged=typeof input.flagged==='boolean'?Number(input.flagged):existing?.flagged||0;
    const incomingId=input.viewed===true?incoming?.id||null:existing?.incoming_id||null;
    this.db.prepare('INSERT INTO rating_case_triage VALUES (?,?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET viewed_at=excluded.viewed_at,viewed_by=excluded.viewed_by,flagged=excluded.flagged,incoming_id=excluded.incoming_id').run(id,viewed,actor,flagged,incomingId);
    return this.case(id);
  }
  insertMessage(caseId, input, createdAt = stamp()) {
    const message = { id: randomUUID(), caseId, createdAt, ...input };
    this.db.prepare('INSERT INTO rating_messages VALUES (?,?,?,?)').run(message.id, caseId, createdAt, json(message));
    return message;
  }
  sendMessage(id, input) {
    const current = this.case(id, false);
    if (current.status === 'RESOLVED') throw new Error('Обращение завершено. Сначала откройте его повторно.');
    const text = String(input.text || '').trim();
    const attachments = (Array.isArray(input.attachments) ? input.attachments : []).map(item => {
      const data = String(item.url || '');
      if (!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(data) || data.length > 3_000_000) throw new Error('Можно прикрепить PNG, JPEG или WebP до 2 МБ.');
      return { name: String(item.name || 'Фото').slice(0, 120), url: data, type: data.split(';')[0].slice(5) };
    });
    if (attachments.length > 3 || text.length > 4000 || (!text && !attachments.length)) throw new Error('Напишите сообщение до 4000 символов или прикрепите до трёх фотографий.');
    const role = input.role === 'engineer' ? 'engineer' : 'dispatcher';
    const author = role === 'engineer' ? current.engineer.name : String(input.author || 'Диспетчер').trim().slice(0, 120);
    this.insertMessage(id, { role, author, text, attachments });
    this.db.prepare("UPDATE rating_cases SET status='IN_PROGRESS' WHERE id=?").run(id);
    return this.case(id);
  }
  decide(id, input) {
    return this.db.transaction(() => {
      const current = this.case(id);
      if (Number(input.expectedRevision) !== current.revision) throw new Error('Обращение уже изменилось. Обновите страницу.');
      if (current.status === 'RESOLVED') throw new Error('Решение уже принято. Сначала откройте обращение повторно.');
      const reason = String(input.reason || '').trim(), response = String(input.response || '').trim();
      if (reason.length < 10 || reason.length > 2000) throw new Error('Укажите причину решения: от 10 до 2000 символов.');
      if (!response || response.length > 2000) throw new Error('Напишите ответ инженеру: до 2000 символов.');
      if (!['VALID', 'NOT_ENGINEER_FAULT', 'CLIENT_ERROR', 'CORRECTED'].includes(input.outcome)) throw new Error('Выберите решение по отзыву.');
      let correction;
      if (input.outcome === 'CORRECTED') {
        const score = Number(input.correctedScore), method = input.clientConfirmation?.method, details = String(input.clientConfirmation?.details || '').trim();
        if (!Number.isInteger(score) || score < 1 || score > 5 || score === current.review.score) throw new Error('Выберите новую оценку от 1 до 5, отличающуюся от текущей.');
        if (input.clientConfirmed !== true || !['phone', 'written', 'visit'].includes(method) || details.length < 10 || details.length > 2000) throw new Error('Подтвердите согласие клиента, выберите способ связи и опишите подтверждение: от 10 до 2000 символов.');
        correction = { score, confirmation: { method, details, recordedAt: stamp(), recordedBy: String(input.actor || 'Диспетчер').slice(0,120) } };
      }
      const included = input.outcome === 'VALID' || input.outcome === 'CORRECTED';
      const ratingBefore = current.engineer.rating;
      if (correction) {
        const payload = parse(this.db.prepare('SELECT payload_json FROM rating_reviews WHERE id=?').get(current.reviewId).payload_json);
        this.db.prepare('UPDATE rating_reviews SET payload_json=? WHERE id=?').run(json({ ...payload, correction }), current.reviewId);
      }
      this.db.prepare('UPDATE rating_reviews SET included=? WHERE id=?').run(included ? 1 : 0, current.reviewId);
      const ratingAfter = this.engineer(current.engineer.id).rating;
      const decision = { id: randomUUID(), caseId: id, outcome: input.outcome, reason, response, actor: String(input.actor || 'Диспетчер').slice(0, 120), createdAt: stamp(), originalScore: current.review.originalScore ?? current.review.score, previousScore: current.review.score,
        ...(correction ? { correctedScore: correction.score, clientConfirmation: correction.confirmation } : {}),
        included, ratingBefore, ratingAfter, followUpRequired: input.followUpRequired === true, revision: current.revision + 1 };
      this.db.prepare('INSERT INTO rating_decisions VALUES (?,?,?,?)').run(decision.id, id, decision.createdAt, json(decision));
      this.db.prepare("UPDATE rating_cases SET status='RESOLVED',revision=revision+1 WHERE id=?").run(id);
      this.insertMessage(id, { role: 'dispatcher', author: decision.actor, text: response, attachments: [], decisionId: decision.id });
      this.bump();
      return this.case(id);
    })();
  }
  reopen(id) { this.case(id, false); this.db.prepare("UPDATE rating_cases SET status='IN_PROGRESS',revision=revision+1 WHERE id=?").run(id); return this.case(id); }
  scenario(id) { const row = this.db.prepare('SELECT * FROM rating_scenarios WHERE id=?').get(id); return row ? { ...parse(row.payload_json), id: row.id, saved: Boolean(row.saved), status: row.status } : null; }
  scenarios(regionId, date) { return this.db.prepare('SELECT id FROM rating_scenarios WHERE region_id=? AND service_date=? ORDER BY created_at DESC LIMIT 30').all(regionId, date).map(item => { const { plan, team, orders, ...summary } = this.scenario(item.id); return summary; }); }
  createScenario(input) {
    const id = randomUUID(), createdAt = stamp(), payload = { id, createdAt, status: 'RUNNING', progress: { phase: 'SELECTING_RATINGS' }, ...input };
    this.db.prepare('INSERT INTO rating_scenarios VALUES (?,?,?,?,0,?,?)').run(id, input.regionId, input.date, payload.status, createdAt, json(payload)); return payload;
  }
  updateScenario(id, input) { this.db.prepare('UPDATE rating_scenarios SET status=?,payload_json=? WHERE id=?').run(input.status, json(input), id); return this.scenario(id); }
  saveScenario(id) {
    const current = this.scenario(id);
    if (!current || current.status !== 'READY' || current.plan?.status !== 'EXACT_VALID' || current.plan?.validation?.status !== 'VALID') throw new Error('Сохранить можно только проверенный сценарий.');
    if (current.kind === 'staffing' && (!current.staffing?.complete || current.staffing?.hypothetical)) throw new Error('Для сохранения нужен полный план с реальными исполнителями. Сначала устраните дефицит и замените условного специалиста.');
    if (current.ratingVersion !== this.version()) throw new Error('Оценки изменились. Пересчитайте сценарий перед сохранением.');
    this.db.prepare('UPDATE rating_scenarios SET saved=1 WHERE id=?').run(id); return this.scenario(id);
  }
}

export const ratingFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
