import { orderSemantics } from './orderSemantics.js';
const normalize = value => String(value || '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');

const DISPLAY_LABELS = [
  { pattern: /^(?:нет\s*линка|no\s*link)(?=\s|$)/i, label: 'Нет связи' },
  { pattern: /^(?:информация|information)(?=\s|$)/i, label: 'Информационная заявка' },
  { pattern: /^diagnostics?\b/i, label: 'Диагностика' },
  { pattern: /^installation?\b/i, label: 'Подключение' },
  { pattern: /^repair\b/i, label: 'Ремонт' },
];

export const translateServiceLabel = value => {
  const source = String(value || '').trim();
  const rule = DISPLAY_LABELS.find(item => item.pattern.test(source));
  return rule ? source.replace(rule.pattern, rule.label) : source;
};

export const displayOrderName = order => translateServiceLabel(order?.name || 'Заявка');

export const isGlobalProblemOrder = order => [order?.workType, order?.serviceType, order?.skill]
  .some(value => /^(?:глобальная проблема|global problem|global issue)(?=\s|$)/.test(normalize(value)));

/** Queue priority and work qualification use the duration/planner contract. */
export const isUrgentOrder = order => orderSemantics(order).priority === 'URGENT';
export const isEmergencyWorkOrder = order => orderSemantics(order).kind === 'emergency';
export const isInformationalOrder = order => orderSemantics(order).kind === 'information';
export const effectiveOrderSkill = order => orderSemantics(order).skillLabel || String(order?.skill || order?.workType || '').trim();

export const workPointType = order => {
  const semantics = orderSemantics(order);
  if (semantics.kind) return ({ connection: 'connection', local: 'service', equipment: 'upgrade', emergency: 'emergency', information: 'other' })[semantics.kind];
  const priority = normalize(order?.priority);
  const workType = normalize(order?.workType);
  const serviceType = normalize(order?.serviceType);
  const skill = normalize(order?.skill);
  const name = normalize(order?.name);
  const sourceType = [workType, serviceType].filter(Boolean).join(' ');
  const descriptiveText = [sourceType, skill, name].filter(Boolean).join(' ');

  // Red is reserved for an explicitly emergency job. Equipment never affects it.
  if (isInformationalOrder(order)) return 'other';
  if (isGlobalProblemOrder(order) || ['авария', 'urgent', 'critical'].includes(priority) || /^(?:авария|аварийн(?:ая|ое|ый|ые)|emergency|critical)(?=\s|$)/.test(sourceType) || /^(?:emergency|аварийн)/.test(skill)) return 'emergency';
  if (/подключ|install|connection/.test(descriptiveText)) return 'connection';
  if (/оборуд|дозаказ|замен|upgrade|equipment/.test(descriptiveText)) return 'upgrade';
  if (/обслуж|ремонт|диагност|конверген|repair|service|diagnostic|нет\s*линка|no\s*link|ip[\s-]*адрес|разрыв|ошиб|низк.*скорост|работа\s+с\s+кабел|мониторинг|tve\/ent.*ошиб/.test(descriptiveText)) return 'service';
  return 'other';
};
