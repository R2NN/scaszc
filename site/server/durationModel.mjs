import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ruleRows = readFileSync(new URL('../../data/dataset/common/work_rules.csv', import.meta.url), 'utf8').trim().split(/\r?\n/).slice(1);
export const WORK_RULES = ruleRows.map(row => {
  const [workType, serviceType, , technical, documents] = row.split(';');
  return { workType, serviceType, technical: Number(technical), documents: Number(documents) };
});
export const WORK_KINDS = { connection: 'Подключение', local: 'Локальная заявка', equipment: 'Дозаказ', emergency: 'Аварийные работы', information: 'Информация' };
export const REASONS = { access: 'Доступ', extra: 'Дополнительные работы', diagnosis: 'Диагностика', customer: 'Ожидание клиента', simpler: 'Более простой объём', unknown: 'Причина неизвестна', other: 'Другое' };
export const DEFAULT_MODEL = {
  version: 'duration-1', effectiveAt: '2026-01-01T00:00:00+03:00',
  norms: { connection: [60, 10], local: [30, 0], equipment: [10, 10], emergency: [80, 0], information: [80, 0] },
  weights: { existingLine: -25, shortCable: -10, longCable: 25, device: 8, point: 12, site: 18, knownFault: -10, intermittent: 12, segment: 7, replacement: 12, firmware: 15, searchNode: 25, damage: 20, readyConfig: -15, stairs: 4 },
  history: { minimum: 3, shrinkage: 5, maxAgeDays: 120, outlierMinutes: 90 },
};
const ENUMS = { line: ['unknown', 'existing', 'new'], cable: ['none', 'short', 'standard', 'large'], diagnosis: ['unknown', 'known', 'intermittent'], action: ['add', 'replace', 'move'], damage: ['unknown', 'cable', 'equipment', 'multiple'], elevator: ['unknown', 'working', 'unavailable'] };
const COUNTS = { devices: [1, 100], points: [1, 100], sites: [1, 50], segments: [1, 100], floors: [0, 100] };
const BOOLEANS = ['requiresNode', 'replaceDevice', 'firmwareRequired', 'nodeSearch', 'readyConfig', 'carryEquipment'];
const KEYS = new Set([...Object.keys(ENUMS), ...Object.keys(COUNTS), ...BOOLEANS]);
const LABELS = { line: 'Пригодная существующая линия', cable: 'Объём кабельных работ', devices: 'Дополнительные устройства', points: 'Дополнительные точки', sites: 'Дополнительные площадки', diagnosis: 'Диагностика', segments: 'Проверяемые сегменты', replaceDevice: 'Замена и настройка устройства', firmwareRequired: 'Обязательное первоначальное обновление', nodeSearch: 'Поиск узла аварии', damage: 'Состав восстановления', readyConfig: 'Готовая пригодная конфигурация', floors: 'Подъём с оборудованием' };
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2 : 0; };
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Determine work semantics from the actual subtype, never from equipment. */
export function workKind(order) {
  const group = order.workType || order.sourceData?.bk_type || order.skill || '';
  const subtype = order.serviceType || order.sourceData?.hd_type || '';
  if (group === 'Глобальная проблема' && subtype === 'Информация') return 'information';
  if (/Авар|EMERGENCY/i.test(`${group} ${order.skill || ''} ${order.priority || ''}`) || (group === 'Глобальная проблема' && subtype === 'Авария')) return 'emergency';
  const classification = `${group} ${order.skill || ''}`;
  if (/Дозаказ|UPSELL|EQUIPMENT/i.test(classification)) return 'equipment';
  if (/Подключ|INSTALL|Монтаж/i.test(classification)) return 'connection';
  if (/Локаль|LOCAL|REPAIR|SERVICE|Диагност/i.test(classification)) return 'local';
  if (group === 'Глобальная проблема') throw new Error('Для глобальной проблемы укажите подтип: авария или информация.');
  throw new Error('Для расчёта длительности укажите поддерживаемый вид работ.');
}

/** Validate structured order factors. Missing values mean an explicit baseline scenario. */
export function normalizeFactors(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Условия работ должны быть объектом.');
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!KEYS.has(key)) throw new Error(`Неизвестное условие работ: ${key}`);
    if (ENUMS[key]) {
      if (!ENUMS[key].includes(raw)) throw new Error(`Недопустимое значение условия ${key}.`);
      result[key] = raw;
    } else if (COUNTS[key]) {
      const [min, max] = COUNTS[key];
      if (typeof raw === 'boolean' || raw === '' || !Number.isInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error(`Условие ${key}: допустимо целое число ${min}–${max}. Больший объём требует отдельной заявки.`);
      result[key] = Number(raw);
    } else {
      if (typeof raw !== 'boolean') throw new Error(`Условие ${key} должно быть логическим.`);
      result[key] = raw;
    }
  }
  if (result.firmwareRequired && !result.replaceDevice && result.action === 'move') throw new Error('Перенос исправного устройства не требует первоначального обновления.');
  return result;
}

/** Validate a complete, versioned configuration without arbitrary output clipping. */
export function validateModel(model) {
  for (const kind of Object.keys(WORK_KINDS)) {
    const pair = model.norms?.[kind];
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0]) || pair[0] < 1 || pair[0] > 600 || !Number.isInteger(pair[1]) || pair[1] < 0 || pair[1] > 120) throw new Error('Проверьте технические минуты и оформление нормативов.');
  }
  for (const [key, original] of Object.entries(DEFAULT_MODEL.weights)) {
    const value = model.weights?.[key];
    if (!Number.isFinite(value) || !Number.isInteger(value) || Math.abs(value) > 120 || (original < 0 ? value > 0 : value < 0)) throw new Error(`Недопустимый вес ${key}.`);
  }
  for (const [key, min, max] of [['minimum', 3, 30], ['shrinkage', 1, 100], ['maxAgeDays', 7, 730], ['outlierMinutes', 15, 240]]) {
    if (!Number.isInteger(model.history?.[key]) || model.history[key] < min || model.history[key] > max) throw new Error('Проверьте параметры пригодной истории.');
  }
  return model;
}

/** Calculate the sole authoritative duration in whole minutes; travel is never included. */
export function calculateDuration(order, { model = DEFAULT_MODEL, asOf, visits = [], conditions = [], entities = {} } = {}) {
  const kind = workKind(order);
  const factors = normalizeFactors(order.durationFactors || {});
  const [baseTechnical, documents] = model.norms[kind];
  const components = [{ key: 'base', label: 'Базовая техническая работа', minutes: baseTechnical, source: 'Нормативы.xlsx / рабочая гипотеза модели' }];
  const applied = {};
  const add = (key, minutes) => { if (!minutes) return; applied[key] = factors[key]; components.push({ key, label: LABELS[key], minutes, source: order.factorSources?.[key] || 'Состав заказа / исходный сценарий' }); };
  const w = model.weights;
  if (kind !== 'information') {
    if (kind === 'connection' && factors.line === 'existing') add('line', w.existingLine);
    if (['connection', 'local', 'equipment', 'emergency'].includes(kind) && factors.cable && factors.cable !== 'none' && !(kind === 'connection' && factors.line === 'existing')) add('cable', factors.cable === 'large' ? w.longCable : factors.cable === 'short' ? (kind === 'connection' ? w.shortCable : Math.max(3, Math.round(Math.abs(w.shortCable) / 2))) : 0);
    if (['connection', 'equipment'].includes(kind)) {
      add('devices', ((factors.devices ?? 1) - 1) * w.device);
      add('points', ((factors.points ?? 1) - 1) * w.point);
    }
    add('sites', ((factors.sites ?? 1) - 1) * w.site);
    if (kind === 'local') {
      add('diagnosis', factors.diagnosis === 'known' ? w.knownFault : factors.diagnosis === 'intermittent' ? w.intermittent : 0);
      add('segments', ((factors.segments ?? 1) - 1) * w.segment);
    }
    if (['local', 'equipment'].includes(kind) && (factors.replaceDevice || factors.action === 'replace')) add('replaceDevice', w.replacement);
    if (kind === 'equipment' && factors.action === 'move') { applied.action = 'move'; components.push({ key: 'move', label: 'Перенос устройства и проверка', minutes: w.device, source: 'Состав дозаказа' }); }
    if (kind === 'equipment' && factors.firmwareRequired) add('firmwareRequired', w.firmware);
    if (kind === 'emergency') {
      if (factors.nodeSearch) add('nodeSearch', w.searchNode);
      if (factors.damage && factors.damage !== 'unknown') add('damage', (factors.damage === 'multiple' ? 2 : 1) * w.damage);
      if (factors.readyConfig) add('readyConfig', w.readyConfig);
    }
    if (factors.carryEquipment && factors.elevator === 'unavailable' && factors.floors > 2) add('floors', (factors.floors - 2) * w.stairs);
  }
  const factorTechnical = Math.max(1, components.reduce((sum, component) => sum + component.minutes, 0));
  const operation = `${kind}:${digest(applied).slice(0, 16)}`;
  const at = asOf || `${order.serviceDate || '2026-08-17'}T07:00:00+03:00`;
  if (!Number.isFinite(Date.parse(at))) throw new Error('Укажите момент расчёта.');
  const applicable = conditions.filter(condition => condition.status === 'confirmed' && condition.kind === kind && condition.operation === operation && Date.parse(condition.knownAt) <= Date.parse(at) && Date.parse(condition.validFrom) <= Date.parse(at) && (!condition.validUntil || Date.parse(condition.validUntil) > Date.parse(at)) && (!condition.closedAt || Date.parse(condition.closedAt) > Date.parse(at)) && (condition.scope === 'operation' || entities[condition.scope] === condition.entityId) && (condition.scope !== 'node' || factors.requiresNode));
  const seen = new Set();
  const valid = visits.filter(visit => {
    if (seen.has(visit.id) || visit.excluded || !visit.eligible || visit.kind !== kind || visit.operation !== operation || Date.parse(visit.endedAt) > Date.parse(at) || Date.parse(visit.knownAt) > Date.parse(at) || Date.parse(at) - Date.parse(visit.endedAt) > model.history.maxAgeDays * 86400000 || !Number.isFinite(visit.actualTechnical) || !Number.isFinite(visit.factorTechnical)) return false;
    seen.add(visit.id); return true;
  });
  const histories = [];
  for (const component of ['technical', 'access']) {
    const candidates = applicable.filter(condition => condition.component === component).sort((a, b) => ['line', 'node', 'entrance', 'object', 'operation'].indexOf(a.scope) - ['line', 'node', 'entrance', 'object', 'operation'].indexOf(b.scope));
    for (const condition of candidates) {
      const group = valid.filter(visit => visit.reason === condition.reason && (condition.scope === 'operation' || visit.entities?.[condition.scope] === condition.entityId));
      const measured = group.map(visit => ({ visit, residual: component === 'access' ? visit.accessMinutes : visit.actualTechnical - factorTechnical })).filter(item => Number.isFinite(item.residual) && Math.abs(item.residual) <= model.history.outlierMinutes);
      const residuals = measured.map(item => item.residual);
      if (residuals.length < model.history.minimum) continue;
      const center = median(residuals), mad = median(residuals.map(value => Math.abs(value - center)));
      const inliers = measured.filter(item => Math.abs(item.residual - center) <= Math.max(8, 3 * mad));
      if (inliers.length < model.history.minimum) continue;
      const minutes = Math.round(median(inliers.map(item => item.residual)) * inliers.length / (inliers.length + model.history.shrinkage));
      histories.push({ component, minutes, count: inliers.length, evidence: inliers.map(item => ({ id: item.visit.id, revision: item.visit.revision || 1 })), conditionId: condition.id, scope: condition.scope, entityId: condition.entityId, reason: condition.reason, latestAt: inliers.map(item => item.visit.endedAt).sort().at(-1) });
      break;
    }
  }
  const historyMinutes = histories.filter(item => item.component === 'technical').reduce((sum, item) => sum + item.minutes, 0);
  const technical = Math.max(1, factorTechnical + historyMinutes);
  const access = Math.max(0, histories.filter(item => item.component === 'access').reduce((sum, item) => sum + item.minutes, 0));
  const calculatedTotal = technical + documents + access;
  const override = order.durationOverride;
  if (override && (!Number.isInteger(override.minutes) || override.minutes < 1 || override.minutes > 10080 || !String(override.reason || '').trim())) throw new Error('Ручная длительность: укажите положительные целые минуты и причину (до 7 суток).');
  return { modelVersion: model.version, normVersion: 'v2.2-published-normatives', kind, asOf: at, factors, operation, entities, baseTechnical, documents, factorTechnical, technical, access, historyMinutes, histories, components, coefficient: Number((technical / baseTechnical).toFixed(3)), calculatedTotal, total: override?.minutes ?? calculatedTotal, override: override || null, observationCount: histories.reduce((sum, item) => sum + item.count, 0), uncertainty: Object.keys(factors).length ? 'Объём указан; веса требуют калибровки' : 'Исходный сценарий: состав работ не уточнён', travelIncluded: false, units: 'minutes', rounding: 'whole-minute' };
}
