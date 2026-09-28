export const SHARED_STOCK_LABELS = {
  ROUTER: 'Роутер',
  TV_BOX: 'ТВ-приставка',
  ONT_GIGABIT: 'Гигабитный ONT',
  CABLE_PACK: 'Кабельные материалы',
};

const ALIASES = {
  'роутер': 'ROUTER',
  'тв-приставка': 'TV_BOX',
  'тв приставка': 'TV_BOX',
  'онт': 'ONT_GIGABIT',
  'ont': 'ONT_GIGABIT',
  'гигабитный ont': 'ONT_GIGABIT',
  'кабель': 'CABLE_PACK',
  'кабельные материалы': 'CABLE_PACK',
  'комплект кабельных материалов': 'CABLE_PACK',
};

const ZONES = { 'восток': 'EAST', 'юго-восток': 'SOUTHEAST', 'югоцентр': 'SOUTHCENTER' };
const normalizeZone = value => ZONES[String(value || '').trim().toLocaleLowerCase('ru-RU')] || String(value || '').trim();
const stockKey = (zoneId, equipmentId) => `${zoneId}|${equipmentId}`;

/** List only shared equipment actually required by the selected jobs. */
export function sharedStockRequirements(orders) {
  const keys = new Set();
  for (const order of orders) {
    const zoneId = normalizeZone(order.zoneId || order.sourceData?.zone_id || order.zone);
    const raw = order.equipment || order.sourceData?.required_equipment || '';
    for (const part of String(raw).split(/\s*[|;,·]\s*/)) {
      const equipmentId = ALIASES[part.trim().toLocaleLowerCase('ru-RU')] || part.trim().toUpperCase();
      if (zoneId && SHARED_STOCK_LABELS[equipmentId]) keys.add(stockKey(zoneId, equipmentId));
    }
  }
  return [...keys].sort().map(key => {
    const [zoneId, equipmentId] = key.split('|');
    return { key, zoneId, equipmentId };
  });
}

/** Convert only edited stock fields to exact-planner inventory overrides. */
export function stockOverrides(rows, edits) {
  return rows.filter(row => edits[row.key] !== undefined).map(row => ({
    zoneId: row.zoneId,
    equipmentId: row.equipmentId,
    quantity: Number(edits[row.key]),
  }));
}
