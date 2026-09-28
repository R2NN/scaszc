const LABELS = {
  LOCAL: 'Локальные работы',
  INSTALL: 'Подключение',
  EMERGENCY: 'Аварийные работы',
  CABLE_PACK: 'Кабельный комплект',
  CABLE_SET: 'Набор кабелей',
  DIAG_SET: 'Диагностический набор',
  INSTALL_SET: 'Монтажный набор',
  ONT_GIGABIT: 'Гигабитный терминал',
  ROUTER: 'Роутер',
  TV_BOX: 'ТВ-приставка',
  PUBLIC_TRANSIT: 'Общественный транспорт',
  BICYCLE: 'Велосипед',
  WALKING: 'Пешком',
  CAR: 'Автомобиль',
  NORMAL: 'Обычный',
  URGENT: 'Срочный',
  PENDING: 'Ожидает',
};

/** Return a Russian UI label while preserving the original dataset value. */
export const filterLabel = value => LABELS[String(value || '').trim().toUpperCase()] || String(value || '');

/** Match any selected item within one multiselect filter. */
export const matchesAnySelection = (selected, candidates) => {
  const values = Array.isArray(selected) ? selected.filter(Boolean) : selected ? [selected] : [];
  return !values.length || values.some(value => candidates.includes(value));
};

const normalize = value => String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim();

/** Search raw IDs and their visible Russian labels with the same query. */
export const matchesSearch = (query, values) => {
  const needle = normalize(query);
  return !needle || values.flatMap(value => Array.isArray(value) ? value : [value])
    .some(value => normalize(value).includes(needle) || normalize(filterLabel(value)).includes(needle));
};
