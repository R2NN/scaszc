import { engineerIdentity } from '../src/engineerPresentation.js';

const addressKey = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
const accountKey = item => String(item?.clientId || item?.customerId || item?.accountId || '').trim();

/** Add explicit demo requests without fabricating operational visits or changing ratings. */
export function seedCustomerPreferenceExamples(ratings, shift) {
  const db = ratings.db;
  db.exec('CREATE TABLE IF NOT EXISTS rating_customer_requests (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)');
  if (!shift?.plan || db.prepare('SELECT id FROM rating_customer_requests LIMIT 1').get()) return;
  const examples = [];
  const routes = shift.plan.routes.filter(route => route.assignments.length);
  const names = ['Мария Соколова', 'Алексей Никитин', 'Елена Орлова', 'Дмитрий Кузнецов'];
  for (let index = 0; index < Math.min(4, routes.length); index++) {
    const route = routes[index];
    const order = shift.orders.find(item => String(item.id) === String(route.assignments[0].orderId));
    if (!order) continue;
    const member = shift.team.find(item => String(item.id) === String(route.engineerId));
    const otherZone = shift.team.find(item => item.zone !== member?.zone);
    examples.push({ id: `DEMO-RELATION-${index + 1}`, clientId: `DEMO-CLIENT-${index + 1}`, client: names[index],
      regionId: shift.regionId, address: order.address, sourceOrderId: order.sourceId || order.id,
      engineerId: engineerIdentity(index === 1 && otherZone ? otherZone : { id: route.engineerId }),
      type: index === 3 ? 'avoid' : 'preferred', score: index === 3 ? 1 : 5,
      date: '2026-08-01T15:00:00+03:00', synthetic: true,
      provenance: 'DEMO_CUSTOMER_REQUEST', comment: index === 3 ? 'После оценки 1★ клиент просит другого специалиста.' : 'Хочу снова этого специалиста.' });
  }
  db.transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO rating_customer_requests VALUES (?,?)');
    examples.forEach(item => insert.run(item.id, JSON.stringify(item)));
    if (examples.length) ratings.bump();
  })();
}

/** Resolve only linked customer identities and exact addresses, before the planning cutoff. */
export function customerPreferencesForShift(db, shift) {
  if (!shift?.date) return [];
  const cutoff = Date.parse(`${shift.date}T07:00:00+03:00`);
  const rules = [];
  const demoDay = shift.regionId === 'moscow' && (shift.plan?.provenance?.dataKind === 'SYNTHETIC_INPUT_EXACT_PLAN'
    || shift.date === '2026-08-17' && shift.orders.some(order => order.sourceId === 'EAST-74198'));
  if (demoDay && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rating_customer_requests'").get()) {
    for (const row of db.prepare('SELECT payload_json FROM rating_customer_requests ORDER BY id').all()) rules.push(JSON.parse(row.payload_json));
  }
  for (const row of db.prepare('SELECT r.id,r.engineer_id,r.score,r.included,r.payload_json,v.payload_json AS visit_json FROM rating_reviews r JOIN rating_visits v ON v.id=r.visit_id JOIN rating_engineers e ON e.id=r.engineer_id WHERE e.region_id=?').all(shift.regionId)) {
    const review = JSON.parse(row.payload_json), visit = JSON.parse(row.visit_json);
    if (!row.included) continue;
    const score = review.correction?.score ?? row.score;
    const clientId = accountKey(review) || accountKey(visit);
    if (score !== 1 && !(score >= 4 && review.preferred && clientId)) continue;
    // Model reviews apply only to model days. Names never identify a customer;
    // a one-star model review can still discourage an exact-address repeat.
    if (review.provenance === 'SYNTHETIC_RATING_HISTORY' && (!demoDay || score !== 1 && !clientId)) continue;
    rules.push({ id: row.id, reviewId: row.id, engineerId: engineerIdentity(row.engineer_id),
      clientId, client: review.client, address: visit.address, date: review.date,
      type: score === 1 ? 'avoid' : 'preferred', score, synthetic: visit.provenance === 'SYNTHETIC_RATING_HISTORY',
      provenance: review.provenance });
  }
  return shift.orders.flatMap(order => {
    const matched = rules.filter(rule => Date.parse(rule.date) < cutoff
      && (rule.synthetic && rule.provenance === 'DEMO_CUSTOMER_REQUEST'
        ? demoDay && rule.regionId === shift.regionId && String(rule.sourceOrderId) === String(order.sourceId || order.id) && addressKey(rule.address) === addressKey(order.address)
        : rule.type === 'preferred' ? Boolean(accountKey(order)) && accountKey(order) === rule.clientId
          : Boolean(addressKey(rule.address)) && addressKey(rule.address) === addressKey(order.address)));
    if (!matched.length) return [];
    const avoid = [...new Set(matched.filter(rule => rule.type === 'avoid').map(rule => rule.engineerId))];
    return [{ orderId: order.id, jobId: order.sourceId || String(order.id).replace(/^moscow:/, ''), address: order.address,
      client: matched[0].client, synthetic: matched.every(rule => rule.synthetic),
      preferredEngineerIds: [...new Set(matched.filter(rule => rule.type === 'preferred' && !avoid.includes(rule.engineerId)).map(rule => rule.engineerId))],
      avoidEngineerIds: avoid, evidence: matched.map(rule => ({ id: rule.id, type: rule.type, client: rule.client, engineerId: rule.engineerId, synthetic: rule.synthetic, date: rule.date })) }];
  });
}
