import { serviceEntrances } from './complexityCatalog.mjs';
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
    technical = 9 + ((factors.devices || 1) - 1) * 9 + (factors.action === 'replace' ? 14 : 0) + (factors.firmwareRequired ? 18 : 0) + (factors.cable === 'large' ? 28 : factors.cable === 'standard' ? 13 : factors.cable === 'short' ? 6 : 0);
  } else if (kind === 'emergency') {
    technical = 76 + (factors.nodeSearch ? 29 : 0) + (factors.damage === 'multiple' ? 45 : factors.damage && factors.damage !== 'unknown' ? 21 : 0) - (factors.readyConfig ? 17 : 0);
  } else technical = 77;
  if (!['connection', 'equipment'].includes(kind) && factors.cable && factors.cable !== 'none') technical += ({ short: 4, standard: 9, large: 18 })[factors.cable] || 0;
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
export async function seedComplexity(registry, { seed = 27082026, anchor = '2026-08-17', force = false } = {}) {
  if (registry.db.prepare("SELECT count(*) AS n FROM service_objects").get().n && !force) return;
  const fixture = JSON.parse(await readFile(new URL('../public/test-data/beego-algorithm-initial.json', import.meta.url), 'utf8'));
  const artifact = JSON.parse(await readFile(new URL('../public/data/beego-exact-plans.json', import.meta.url), 'utf8'));
  const input = canonicalDemoInput(fixture, artifact);
  const random = generator(seed);
  const stockRows = (await readFile(new URL('../../data/dataset/core/shared_inventory.csv', import.meta.url), 'utf8')).trim().split(/\r?\n/).slice(1).map(row => row.split(';'));
  const stockLimits = new Map(stockRows.map(row => [`${row[1]}/${row[3]}`, Number(row[4])]));
  const sharedItems = new Set(stockRows.map(row => row[3]));
  const tokens = value => Array.isArray(value) ? value : String(value || '').split('|').map(item => item.trim()).filter(Boolean);
  const requiredSkill = { connection: 'INSTALL', local: 'LOCAL', equipment: 'INSTALL', emergency: 'EMERGENCY', information: 'EMERGENCY' };
  const neededEquipment = order => tokens(order.equipment || order.sourceData?.required_equipment);
  const qualified = (engineer, order, kind) => engineer.zoneId === order.zoneId && engineer.skills.includes(requiredSkill[kind]) && (!order.transport || order.transport === 'ANY' || engineer.transport === order.transport) && neededEquipment(order).filter(item => !sharedItems.has(item)).every(item => engineer.equipment.includes(item));
  const objects = new Map();
  for (const order of input.orders) {
    const source = order.sourceData.geocode_object_id || order.sourceData.location_id;
    const id = `OBJ-${digest(['moscow', source]).slice(0, 18)}`;
    if (!objects.has(id)) objects.set(id, { id, address: order.address, coords: order.coords, regionId: 'moscow', zone: order.zone, zoneId: order.zoneId, district: order.district, sourceId: source, entranceCount: 1 + objects.size % 3, source: 'Адрес/координаты: исходный набор, OpenStreetMap/Nominatim. Инфраструктура и история: генератор complexity-v2.', orderDefaults: {}, examples: [] });
    const object = objects.get(id);
    const group = order.workType;
    const q = random();
    let durationFactors = {};
    if (group === 'Подключение') durationFactors = q < 0.3 ? { line: 'existing', devices: 1, points: 1 } : q > 0.84 ? { line: 'new', cable: 'large', devices: 2, points: 2, requiresNode: true } : { line: 'new', cable: 'standard', devices: 1, points: 1 };
    else if (group === 'Локальная заявка') durationFactors = q < 0.28 ? { diagnosis: 'known', segments: 1 } : q > 0.78 ? { diagnosis: 'intermittent', segments: 3, requiresNode: true } : { diagnosis: 'unknown', segments: 1 };
    else if (group === 'Дозаказ') durationFactors = q > 0.82 ? { devices: 2, action: 'replace', firmwareRequired: true } : { devices: 1, action: 'add' };
    else if (order.serviceType !== 'Информация') durationFactors = q > 0.8 ? { nodeSearch: true, damage: 'multiple', sites: 2, requiresNode: true } : q < 0.25 ? { readyConfig: true, requiresNode: true } : { requiresNode: true };
    const entrance = serviceEntrances[order.id] || 1;
    object.entranceCount = Math.max(object.entranceCount, entrance);
    const serviceEntities = { object: id, entrance: `${id}-ENT-${entrance}`, node: `${id}-NODE-${entrance}`, line: `${id}-LINE-${order.id}` };
    const defaults = { durationFactors, serviceEntities, factorSources: Object.fromEntries(Object.keys(durationFactors).map(key => [key, 'Синтетическое дополнение технического инвентаря complexity-v2'])) };
    object.orderDefaults[order.id] = defaults;
    object.examples.push({ ...order, ...defaults, objectId: id });
  }
  registry.db.transaction(() => {
    for (const object of objects.values()) {
      const entries = Array.from({ length: object.entranceCount }, (_, index) => index + 1);
      const locations = ['Шкаф связи в техническом помещении первого этажа', 'Технический шкаф в подвале подъезда', 'Оборудование в общем коридоре верхнего этажа'];
      const entities = entries.flatMap(index => [{ id: `${object.id}-ENT-${index}`, kind: 'entrance', label: `Подъезд ${index}`, objectId: object.id }, { id: `${object.id}-NODE-${index}`, kind: 'node', label: `Узел подъезда ${index}`, entranceId: `${object.id}-ENT-${index}`, objectId: object.id, location: `${locations[(object.entranceCount + index) % locations.length]}; положение известно по описанию, координаты не измерены` }, { id: `${object.id}-DEVICE-${index}`, kind: 'equipment', label: index % 2 ? 'Коммутатор доступа' : 'Распределительная панель', nodeId: `${object.id}-NODE-${index}`, objectId: object.id }]);
      for (const order of object.examples) entities.push({ id: order.serviceEntities.line, kind: 'line', label: `Абонентская линия · ${order.sourceId}`, nodeId: order.serviceEntities.node, objectId: object.id });
      entities.push({ id: `${object.id}-LINE-SECOND`, kind: 'line', label: 'Другая линия в этом здании', nodeId: `${object.id}-NODE-${object.entranceCount}`, objectId: object.id });
      registry.registerObject(object, entities);
    }
  })();
  const schedules = new Map();
  const stocks = new Map();
  const records = [];
  let objectIndex = 0;
  for (const object of objects.values()) {
    const ordinal = objectIndex++;
    const original = object.examples[0];
    const count = ordinal % 7 === 0 ? 0 : ordinal % 5 === 0 ? 2 : 13 + Math.floor(random() * 5);
    for (let index = 0; index < count; index++) {
      const date = dayAt(anchor, -66 + index * 4);
      if (date >= anchor) continue;
      const alternate = index % 6 === 2;
      const template = alternate ? input.orders.find(item => item.zoneId === original.zoneId && item.workType === (original.workType === 'Локальная заявка' ? 'Подключение' : 'Локальная заявка')) || original : original;
      const factors = alternate ? { ...(template.workType === 'Подключение' ? { line: 'existing', devices: 1, points: 1 } : { diagnosis: 'known', segments: 1 }) } : { ...original.durationFactors };
      if (index % 6 === 1) {
        if (template.workType === 'Подключение' || template.workType === 'Дозаказ') factors.devices = (factors.devices || 1) + 1;
        if (template.workType === 'Локальная заявка') factors.segments = (factors.segments || 1) + 1;
        factors.requiresNode = true;
      }
      const otherLine = index % 6 === 4;
      const entities = otherLine ? { object: object.id, entrance: `${object.id}-ENT-${object.entranceCount}`, node: `${object.id}-NODE-${object.entranceCount}`, line: `${object.id}-LINE-SECOND` } : { ...original.serviceEntities };
      const historyOrderId = `ARCHIVE-${seed}-${ordinal + 1}-${index + 1}`;
      const order = { ...template, id: historyOrderId, sourceId: historyOrderId, name: `Архивный наряд ${ordinal + 1}/${index + 1}`, address: object.address, coords: object.coords, objectId: object.id, serviceEntities: entities, durationFactors: factors, serviceDate: date, sourceData: { ...template.sourceData, job_id: historyOrderId, address: object.address, geocode_object_id: object.sourceId, created_at: `${date}T07:00:00+03:00` } };
      const base = calculateDuration(order, { asOf: `${date}T07:00:00+03:00`, entities, model: registry.model(`${date}T07:00:00+03:00`) });
      const nodeAccess = ordinal % 17 === 0 && factors.requiresNode && entities.node === original.serviceEntities.node;
      const resolvedAccess = ordinal % 19 === 0 && factors.requiresNode && date < dayAt(anchor, -14);
      const privateTechnical = !nodeAccess && !resolvedAccess && !otherLine && !alternate ? ordinal % 13 === 0 ? 18 : ordinal % 11 === 0 ? -9 : 0 : 0;
      const sharedOperation = !nodeAccess && !resolvedAccess && !privateTechnical && base.kind === 'local' && factors.diagnosis === 'intermittent';
      const hidden = { operationSpeed: sharedOperation ? 1.14 : 0.94 + (ordinal % 7) * 0.015, persistentTechnical: privateTechnical, access: nodeAccess ? 15 : resolvedAccess ? 10 : 0 };
      const stages = simulateVisit(base.kind, factors, hidden, random);
      const total = stages.technical + stages.access + stages.documents + stages.customer;
      const stockAvailable = neededEquipment(order).filter(item => sharedItems.has(item)).every(item => (stocks.get(`${date}/${object.zoneId}/${item}`) || 0) < (stockLimits.get(`${object.zoneId}/${item}`) || 0));
      if (!stockAvailable) continue;
      const candidates = input.engineers.filter(engineer => qualified(engineer, order, base.kind)).map(engineer => {
        const previous = schedules.get(`${date}/${engineer.id}`);
        const coords = previous?.coords || engineer.coords;
        const km = coords && object.coords ? Math.hypot((coords[0] - object.coords[0]) * 111, (coords[1] - object.coords[1]) * 63) : 0;
        const transfer = Math.ceil(km * 1.5 / (engineer.transport === 'CAR' ? 25 : 15) * 60) + 10;
        return { engineer, start: previous ? previous.end + transfer : minuteOf(engineer.shiftStart) + transfer };
      }).filter(item => item.start + total <= minuteOf(item.engineer.shiftEnd)).sort((a, b) => a.start - b.start || a.engineer.id.localeCompare(b.engineer.id));
      const chosen = candidates[0];
      if (!chosen) continue;
      const { engineer, start } = chosen;
      schedules.set(`${date}/${engineer.id}`, { end: start + total, coords: object.coords });
      for (const item of neededEquipment(order).filter(item => sharedItems.has(item))) stocks.set(`${date}/${object.zoneId}/${item}`, (stocks.get(`${date}/${object.zoneId}/${item}`) || 0) + 1);
      const reason = stages.rare || stages.customer ? 'unknown' : hidden.access ? 'access' : privateTechnical > 0 || sharedOperation ? 'diagnosis' : privateTechnical < 0 ? 'simpler' : 'unknown';
      const finding = reason === 'unknown' ? stages.customer ? 'Зафиксировано ожидание клиента; причина технического отклонения не установлена' : 'Причина отклонения пока не установлена' : reason === 'access' ? 'Доступ к техническому шкафу согласуется с ответственным за помещение' : sharedOperation ? 'Периодический сбой проявляется под нагрузкой: требуется повторная проверка соединения' : privateTechnical > 0 ? 'На этой линии нестабильный контакт, требуется повторная проверка после настройки' : privateTechnical < 0 ? 'Исправный ввод и подписанная линия сокращают поиск места подключения' : stages.customer ? 'Ожидание клиента отмечено отдельно' : 'Причина отклонения пока не установлена';
      const preparation = reason === 'access' ? 'Заранее согласовать открытие технического помещения' : reason === 'diagnosis' ? 'Подготовить диагностический комплект и выполнить проверку под нагрузкой' : reason === 'simpler' ? 'Использовать подтверждённую маркировку линии' : '';
      const findingKey = reason === 'unknown' ? 'unknown' : reason === 'access' ? 'access:technical-room' : sharedOperation ? 'operation:load-test' : reason === 'diagnosis' ? 'line:contact-check' : reason === 'simpler' ? 'line:labelled-ready' : 'unknown';
      const eligible = index % 11 !== 7;
      records.push({ order, object, ordinal, index, resolvedAccess, sharedOperation, visit: { id: `HIST-V2-${seed}-${ordinal}-${index}`, orderId: historyOrderId, orderLabel: order.name, workType: order.workType, serviceType: order.serviceType, factors, entities, kind: base.kind, operation: base.operation, factorTechnical: base.factorTechnical, startedAt: eligible ? `${date}T${clock(start)}:00+03:00` : null, endedAt: `${date}T${clock(start + total)}:00+03:00`, knownAt: `${date}T${clock(start + total)}:00+03:00`, actualTechnical: eligible ? stages.technical : null, accessMinutes: eligible ? stages.access : null, documentMinutes: eligible ? stages.documents : null, customerMinutes: eligible ? stages.customer : null, total: eligible ? total : null, eligible, excluded: false, reason, findingKey, finding, preparation, comment: finding, engineerId: engineer.id, engineerName: engineer.name, requiredSkill: requiredSkill[base.kind], requiredEquipment: neededEquipment(order), requiredTransport: order.transport, partition: date < dayAt(anchor, -16) ? 'train' : 'holdout', source: 'synthetic-independent-stage-simulator-v2', status: 'completed' } });
    }
  }
  records.sort((a, b) => a.visit.endedAt.localeCompare(b.visit.endedAt) || a.visit.id.localeCompare(b.visit.id));
  const confirmed = new Set();
  registry.db.transaction(() => {
    for (const record of records) {
      const { order, object, ordinal, index, visit } = record;
      visit.forecast = registry.estimate(order, `${visit.endedAt.slice(0, 10)}T07:00:00+03:00`);
      const clarify = ordinal % 29 === 0 && index === 6 && visit.reason !== 'unknown' && visit.eligible;
      registry.recordVisit(clarify ? { ...visit, reason: 'unknown', findingKey: 'unknown', finding: 'Причина проверяется по акту исполнителя' } : visit, 'Архивная отметка этапов по наряду', visit.engineerName);
      if (ordinal % 23 === 0 && index === 2 && visit.eligible) registry.reviseVisit(visit.id, { excluded: true, reason: 'В отметке этапов обнаружена ошибка', at: `${dayAt(visit.endedAt.slice(0, 10), 1)}T12:00:00+03:00`, actor: 'Оператор архива' });
      if (!clarify && !['unknown', 'customer', 'other'].includes(visit.reason) && visit.eligible) {
        const scope = visit.reason === 'access' ? 'node' : record.sharedOperation ? 'operation' : 'line';
        const key = `${scope}/${scope === 'operation' ? visit.operation : visit.entities[scope]}/${visit.reason}/${visit.findingKey}`;
        if (!confirmed.has(key)) {
          const comparable = registry.visits(visit.knownAt).filter(item => item.reason === visit.reason && item.findingKey === visit.findingKey && item.eligible && !item.excluded && (scope === 'operation' ? item.operation === visit.operation : item.entities?.[scope] === visit.entities[scope]));
          if (comparable.length >= 3 && (scope !== 'operation' || new Set(comparable.map(item => item.entities.object)).size >= 3)) {
            try {
              const validUntil = record.resolvedAccess ? `${dayAt(anchor, -14)}T12:00:00+03:00` : visit.reason === 'access' ? `${dayAt(anchor, 3)}T23:59:00+03:00` : null;
              const condition = registry.decide({ visitId: visit.id, action: 'confirm', scope, at: visit.knownAt, reason: 'Особенность подтверждена отметками этапов и разбором нарядов', validUntil, actor: 'Оператор архива' });
              confirmed.add(key);
              if (record.resolvedAccess && validUntil) registry.closeCondition(condition.id, { at: validUntil, reason: 'Порядок доступа согласован, помещение доступно без дополнительного ожидания', actor: 'Оператор архива' });
            } catch (issue) { if (!/Недостаточно/.test(issue.message)) throw issue; }
          }
        }
      }
      if (clarify) {
        const clarificationAt = `${dayAt(visit.endedAt.slice(0, 10), 1)}T12:00:00+03:00`;
        if (clarificationAt < `${anchor}T07:00:00+03:00`) {
          registry.reviseVisit(visit.id, { deviationReason: visit.reason, finding: visit.finding, findingKey: visit.findingKey, preparation: visit.preparation, reason: 'Получен акт исполнителя с описанием установленной причины', at: clarificationAt, actor: 'Оператор архива' });
        }
      }
    }
  })();
  return { seed, version: 'complexity-v2', anchor, objects: objects.size, visits: registry.visits().length };
}
