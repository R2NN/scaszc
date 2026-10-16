import { readFile } from 'node:fs/promises';
import { calculateDuration, digest } from './durationModel.mjs';
import { canonicalDemoInput } from '../src/canonicalDemo.js';

const dayAt = (anchor, days) => new Date(Date.parse(`${anchor}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const minuteOf = value => { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; };
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const generator = seed => () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };

/** Simulate independent stage operations using hidden properties, never forecast plus noise. */
export function simulateVisit(kind, factors, hidden, random) {
  const variation = () => 0.84 + random() * 0.32;
  let technical;
  if (kind === 'connection') {
    technical = (factors.line === 'existing' ? 29 : 53) + (factors.cable === 'large' ? 30 : factors.cable === 'short' ? -7 : 0);
    technical += ((factors.devices || 1) - 1) * 9 + ((factors.points || 1) - 1) * 14;
  } else if (kind === 'local') {
    technical = (factors.diagnosis === 'known' ? 18 : factors.diagnosis === 'intermittent' ? 43 : 29) + ((factors.segments || 1) - 1) * 8 + (factors.replaceDevice ? 13 : 0) + (factors.cable === 'large' ? 28 : 0);
  } else if (kind === 'equipment') {
    technical = 9 + ((factors.devices || 1) - 1) * 9 + (factors.action === 'replace' ? 14 : 0) + (factors.firmwareRequired ? 18 : 0) + (factors.cable === 'large' ? 28 : factors.cable === 'short' ? 3 : 0);
  } else if (kind === 'emergency') {
    technical = 76 + (factors.nodeSearch ? 29 : 0) + (factors.damage === 'multiple' ? 45 : factors.damage && factors.damage !== 'unknown' ? 21 : 0) - (factors.readyConfig ? 17 : 0);
  } else technical = 77;
  technical += ((factors.sites || 1) - 1) * 20;
  if (factors.carryEquipment && factors.elevator === 'unavailable') technical += Math.max(0, (factors.floors || 0) - 2) * 5;
  technical = Math.max(2, Math.round(technical * hidden.operationSpeed * variation() + hidden.persistentTechnical));
  const access = Math.round(hidden.access * variation());
  const documents = ['connection', 'equipment'].includes(kind) ? Math.round(8 + random() * 5) : 0;
  const customer = random() < 0.07 ? Math.round(8 + random() * 25) : 0;
  const rare = random() < 0.018 ? Math.round(100 + random() * 80) : 0;
  return { technical: technical + rare, access, documents, customer, rare };
}

/** Reproducible enrichment of original IDs, addresses and verified coordinate points. */
export async function seedComplexity(registry, { seed = 17082026, anchor = '2026-08-17', force = false } = {}) {
  if (registry.db.prepare("SELECT count(*) AS n FROM service_objects").get().n && !force) return;
  const fixture = JSON.parse(await readFile(new URL('../public/test-data/beego-algorithm-initial.json', import.meta.url), 'utf8'));
  const artifact = JSON.parse(await readFile(new URL('../public/data/beego-exact-plans.json', import.meta.url), 'utf8'));
  const input = canonicalDemoInput(fixture, artifact);
  const random = generator(seed);
  const objects = new Map();
  for (const order of input.orders) {
    const source = order.sourceData.geocode_object_id || order.sourceData.location_id;
    const id = `OBJ-${digest(['moscow', source]).slice(0, 18)}`;
    if (!objects.has(id)) objects.set(id, { id, address: order.address, coords: order.coords, regionId: 'moscow', zone: order.zone, zoneId: order.zoneId, district: order.district, sourceId: source, source: 'Адрес/координаты: исходный набор, OpenStreetMap/Nominatim. Инфраструктура: генератор complexity-v1.', orderDefaults: {}, examples: [] });
    const object = objects.get(id);
    const group = order.workType;
    const q = random();
    let durationFactors = {};
    if (group === 'Подключение') durationFactors = q < 0.3 ? { line: 'existing', devices: 1, points: 1 } : q > 0.84 ? { line: 'new', cable: 'large', devices: 2, points: 2, requiresNode: true } : { line: 'new', cable: 'standard', devices: 1, points: 1 };
    else if (group === 'Локальная заявка') durationFactors = q < 0.28 ? { diagnosis: 'known', segments: 1 } : q > 0.78 ? { diagnosis: 'intermittent', segments: 3, requiresNode: true } : { diagnosis: 'unknown', segments: 1 };
    else if (group === 'Дозаказ') durationFactors = q > 0.82 ? { devices: 2, action: 'replace', firmwareRequired: true } : { devices: 1, action: 'add' };
    else if (order.serviceType !== 'Информация') durationFactors = q > 0.8 ? { nodeSearch: true, damage: 'multiple', sites: 2, requiresNode: true } : q < 0.25 ? { readyConfig: true, requiresNode: true } : { requiresNode: true };
    const entrance = random() < 0.5 ? 1 : 2;
    const serviceEntities = { object: id, entrance: `${id}-ENT-${entrance}`, node: `${id}-NODE-${entrance}`, line: `${id}-LINE-${order.id}` };
    const defaults = { durationFactors, serviceEntities, factorSources: Object.fromEntries(Object.keys(durationFactors).map(key => [key, 'Синтетическое дополнение технического инвентаря complexity-v1'])) };
    object.orderDefaults[order.id] = defaults;
    object.examples.push({ ...order, ...defaults, objectId: id });
  }
  registry.db.transaction(() => {
    for (const object of objects.values()) {
      const entities = [1, 2].flatMap(index => [{ id: `${object.id}-ENT-${index}`, kind: 'entrance', label: `Подъезд ${index}`, objectId: object.id }, { id: `${object.id}-NODE-${index}`, kind: 'node', label: `Узел подъезда ${index}`, entranceId: `${object.id}-ENT-${index}`, objectId: object.id, location: 'Технический шкаф; точные координаты не установлены' }, { id: `${object.id}-DEVICE-${index}`, kind: 'equipment', label: `Оборудование узла ${index}`, nodeId: `${object.id}-NODE-${index}`, objectId: object.id }]);
      for (const order of object.examples) entities.push({ id: order.serviceEntities.line, kind: 'line', label: `Линия заявки ${order.sourceId}`, nodeId: order.serviceEntities.node, objectId: object.id });
      registry.registerObject(object, entities);
    }
  })();
  const schedules = new Map();
  let objectIndex = 0;
  registry.db.transaction(() => {
    for (const object of objects.values()) {
      const ordinal = objectIndex++;
      const order = object.examples[0];
      const count = ordinal % 7 === 0 ? 0 : ordinal % 5 === 0 ? 2 : 10 + Math.floor(random() * 7);
      const resolvedAccess = ordinal % 19 === 0 && ordinal % 17 !== 0;
      const hidden = { operationSpeed: 0.92 + random() * 0.18, persistentTechnical: ordinal % 13 === 0 ? 18 : ordinal % 11 === 0 ? -9 : 0, access: ordinal % 17 === 0 ? 15 : resolvedAccess ? 10 : 0 };
      const engineers = input.engineers.filter(engineer => engineer.zoneId === order.zoneId);
      const first = registry.estimate(order, `${dayAt(anchor, -65)}T07:00:00+03:00`);
      const reason = hidden.access ? 'access' : hidden.persistentTechnical > 0 ? 'diagnosis' : hidden.persistentTechnical < 0 ? 'simpler' : 'unknown';
      for (let index = 0; index < count; index++) {
        const date = dayAt(anchor, -60 + index * 4);
        if (date >= anchor) continue;
        const engineer = engineers[(ordinal + index) % engineers.length];
        const key = `${date}/${engineer.id}`;
        const start = schedules.get(key) ?? minuteOf(engineer.shiftStart);
        const forecast = registry.estimate(order, `${date}T07:00:00+03:00`);
        const stages = simulateVisit(forecast.kind, order.durationFactors, resolvedAccess && date >= dayAt(anchor, -14) ? { ...hidden, access: 0 } : hidden, random);
        const total = stages.technical + stages.access + stages.documents + stages.customer;
        if (start + total > minuteOf(engineer.shiftEnd)) continue;
        schedules.set(key, start + total + 25);
        const endedAt = `${date}T${clock(start + total)}:00+03:00`;
        const eligible = index % 11 !== 7;
        registry.recordVisit({ id: `HIST-${seed}-${object.id}-${index}`, orderId: `HIST-ORDER-${object.id}-${index}`, entities: order.serviceEntities, kind: forecast.kind, operation: forecast.operation, factorTechnical: forecast.factorTechnical, forecast, startedAt: index % 11 === 7 ? null : `${date}T${clock(start)}:00+03:00`, endedAt, knownAt: endedAt, actualTechnical: eligible ? stages.technical : null, accessMinutes: eligible ? stages.access : null, documentMinutes: eligible ? stages.documents : null, customerMinutes: eligible ? stages.customer : null, total: eligible ? total : null, eligible, excluded: false, reason: stages.rare || stages.customer ? 'unknown' : reason, engineerId: engineer.id, partition: date < dayAt(anchor, -16) ? 'train' : 'holdout', source: 'synthetic-independent-stage-simulator-v1', status: 'completed', comment: stages.rare ? 'Разовое отклонение; причина не установлена' : '' }, 'Исторический визит: независимая симуляция этапов', 'Генератор complexity-v1');
        if (ordinal % 23 === 0 && [2, 8].includes(index)) {
          const recorded = registry.visits(endedAt, object.id).find(visit => visit.id === `HIST-${seed}-${object.id}-${index}`);
          const knownAt = `${dayAt(date, 1)}T12:00:00+03:00`;
          const correction = start + total + 2 <= minuteOf(engineer.shiftEnd) ? 2 : -2;
          if (knownAt < `${anchor}T07:00:00+03:00`) registry.recordVisit({ ...recorded, knownAt, ...(index === 2 ? { excluded: true, comment: 'Этапы внесены с ошибкой; исключено оператором' } : { endedAt: `${date}T${clock(start + total + correction)}:00+03:00`, actualTechnical: recorded.actualTechnical == null ? null : recorded.actualTechnical + correction, total: recorded.total == null ? null : recorded.total + correction, comment: 'Время этапа уточнено по отметке исполнителя' }) }, index === 2 ? 'Исключение ошибочного измерения' : 'Исправление измеренного этапа', 'Оператор');
        }
        if (index === 4 && reason !== 'unknown' && count > 5) {
          const evidence = registry.visits(endedAt, object.id).filter(visit => visit.eligible && visit.reason === reason);
          if (evidence.length >= 3) {
            const condition = { id: `SEED-CONDITION-${seed}-${object.id}`, objectId: object.id, entityId: order.serviceEntities.node, scope: order.durationFactors.requiresNode ? 'node' : 'line', kind: first.kind, operation: first.operation, reason, component: reason === 'access' ? 'access' : 'technical', status: 'confirmed', knownAt: endedAt, validFrom: endedAt, validUntil: reason === 'access' ? `${dayAt(anchor, 3)}T23:59:00+03:00` : null, evidenceIds: evidence.map(visit => visit.id), source: 'Сопоставимые этапы визитов, решение оператора в истории генератора', actor: 'Оператор' };
            if (condition.scope === 'line') condition.entityId = order.serviceEntities.line;
            if (resolvedAccess) { condition.validUntil = `${dayAt(anchor, -14)}T12:00:00+03:00`; condition.closedAt = condition.validUntil; }
            registry.db.prepare('INSERT OR IGNORE INTO object_conditions VALUES (?,?,?)').run(condition.id, object.id, JSON.stringify(condition));
            registry.audit(object.id, 'CONDITION_CONFIRMED', condition.source, null, condition, 'Оператор', endedAt);
          }
        }
      }
    }
  })();
  return { seed, version: 'complexity-v1', anchor, objects: objects.size, visits: registry.visits().length };
}
