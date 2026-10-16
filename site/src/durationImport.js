const counts = { devices: [1, 100], points: [1, 100], sites: [1, 50], segments: [1, 100], floors: [0, 100] };
const enums = { line: ['unknown', 'existing', 'new'], cable: ['none', 'short', 'standard', 'large'], diagnosis: ['unknown', 'known', 'intermittent'], action: ['add', 'replace', 'move'], damage: ['unknown', 'cable', 'equipment', 'multiple'], elevator: ['unknown', 'working', 'unavailable'] };
const flags = ['requiresNode', 'replaceDevice', 'firmwareRequired', 'nodeSearch', 'readyConfig', 'carryEquipment'];

/** Validate structured import fields; final calculation remains server-owned. */
export function parseDurationImport(value, type) {
  if (value == null || value === '') return undefined;
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new Error('Укажите корректный JSON условий длительности.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Нужен объект JSON, не список.');
  if (type === 'serviceEntities') {
    if (Object.entries(parsed).some(([key, entry]) => !['object', 'entrance', 'node', 'line'].includes(key) || typeof entry !== 'string' || !entry.trim())) throw new Error('Проверьте ID связанных сущностей.');
  } else if (type === 'durationOverride') {
    if (!Number.isInteger(parsed.minutes) || parsed.minutes < 1 || parsed.minutes > 10080 || !String(parsed.reason || '').trim()) throw new Error('Ручное время требует минут и причины.');
  } else {
    for (const [key, entry] of Object.entries(parsed)) {
      if (counts[key]) { const [min, max] = counts[key]; if (!Number.isInteger(entry) || entry < min || entry > max) throw new Error('Проверьте количество операций.'); }
      else if (enums[key]) { if (!enums[key].includes(entry)) throw new Error('Проверьте категорию условия.'); }
      else if (flags.includes(key)) { if (typeof entry !== 'boolean') throw new Error('Условие должно быть логическим.'); }
      else throw new Error('Неизвестный фактор длительности.');
    }
  }
  return parsed;
}
