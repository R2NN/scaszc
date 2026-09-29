const EMPTY_EQUIPMENT = new Set(['any', 'нет']);
const EQUIPMENT_LABELS = new Map([
  ['диагностический комплект', 'DIAG_SET'],
  ['аварийный комплект', 'DIAG_SET'],
  ['монтажный комплект', 'INSTALL_SET'],
  ['кабельный комплект', 'CABLE_SET'],
  ['кабель', 'CABLE_PACK'],
  ['роутер', 'ROUTER'],
  ['ont', 'ONT_GIGABIT'],
  ['гигабитный ont', 'ONT_GIGABIT'],
  ['тв приставка', 'TV_BOX'],
  ['тв-приставка', 'TV_BOX'],
]);

/** Preserve every equipment code from an imported row without guessing a replacement. */
export const importedEquipmentTokens = value => String(value ?? '')
  .split(/\s*[|;,·]\s*/)
  .map(item => item.trim())
  .filter(item => item && !EMPTY_EQUIPMENT.has(item.toLocaleLowerCase('ru-RU')))
  .map(item => EQUIPMENT_LABELS.get(item.toLocaleLowerCase('ru-RU')) || item);

/** Return the exact equipment requirements in the format expected by the planner. */
export const importedEquipmentRequirements = value => [...new Set(importedEquipmentTokens(value))].join('|');
