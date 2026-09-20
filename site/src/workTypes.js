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

export const workPointType = order => {
  const priority = normalize(order?.priority);
  const workType = normalize(order?.workType);
  const serviceType = normalize(order?.serviceType);
  const skill = normalize(order?.skill);
  const name = normalize(order?.name);
  const sourceType = [workType, serviceType].filter(Boolean).join(' ');
  const descriptiveText = [sourceType, skill, name].filter(Boolean).join(' ');

  // Red is reserved for an explicitly emergency job. Equipment never affects it.
  if (priority === 'авария' || /^(?:авария|аварийн(?:ая|ое|ый|ые)|emergency|critical)(?=\s|$)/.test(sourceType)) return 'emergency';
  if (/(?:^|\s)(?:информация|information)(?=\s|$)/.test(descriptiveText)) return 'other';
  if (/подключ|install|connection/.test(descriptiveText)) return 'connection';
  if (/оборуд|дозаказ|замен|upgrade|equipment/.test(descriptiveText)) return 'upgrade';
  if (/обслуж|ремонт|диагност|конверген|repair|service|diagnostic|нет\s*линка|no\s*link|ip[\s-]*адрес|разрыв|ошиб|низк.*скорост|работа\s+с\s+кабел|мониторинг|tve\/ent.*ошиб/.test(descriptiveText)) return 'service';
  return 'other';
};
