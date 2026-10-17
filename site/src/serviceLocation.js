const addressWords = new Set(['г', 'город', 'ул', 'улица', 'д', 'дом']);

/** Compare address formatting while retaining city, street, house and building identifiers. */
export function addressIdentity(address) {
  return String(address || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')
    .replace(/\b(?:pr-?kt)\b/g, 'проспект').replace(/пр(?:-|\s)*кт|пр-т/g, 'проспект').replace(/пр-зд/g, 'проезд').replace(/б-р/g, 'бульвар')
    .replace(/(\d)([а-я])(?=\s|$)/g, '$1 $2').replace(/(\d)(к|корп|стр)(?=\d)/g, '$1 $2 ').replace(/([^\d])([0-9]+)/g, '$1 $2')
    .replace(/[^а-яa-z0-9/]+/g, ' ').trim().split(/\s+/)
    .filter(word => word && !addressWords.has(word))
    .map(word => ({ к: 'корпус', корп: 'корпус', стр: 'строение', пркт: 'проспект', 'пр-т': 'проспект' })[word] || word).join(' ');
}

const territoryKey = value => {
  const key = String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/[\s_-]+/g, '');
  return ({ восток: 'east', юговосток: 'southeast', югоцентр: 'southcenter', southcenter: 'southcenter' })[key] || key;
};

/** Check every declared operational territory, including original import fields. */
export function assertServiceTerritory(order, object) {
  if (order.regionId && object.regionId && order.regionId !== object.regionId) throw new Error(`Регион заявки не совпадает с регионом объекта «${object.address}».`);
  const territories = [object.zone, object.zoneId].filter(Boolean).map(territoryKey);
  if (!territories.length) return;
  const declared = [order.zone, order.zoneId, order.sourceData?.zone_name, order.sourceData?.zone_id].filter(value => String(value || '').trim());
  const wrong = declared.find(value => !territories.includes(territoryKey(value)));
  if (wrong) {
    const error = new Error(`Объект «${object.address}» относится к территории «${object.zone || object.zoneId}», в заявке указано «${wrong}». Исправьте территорию заявки.`);
    error.code = 'INVALID_INPUT';
    throw error;
  }
}

/** Moving the service point requires a new explicit object/infrastructure association. */
export function changeServiceLocation(form, location) {
  return { ...form, ...location, objectId: undefined, objectZone: undefined, zoneId: undefined, district: undefined, serviceEntities: undefined, durationSnapshot: undefined };
}

/** Select one registered place and its operational territory atomically. */
export function selectServiceObject(form, object) {
  return { ...changeServiceLocation(form, {}), objectId: object.id, address: object.address, coords: object.coords, locationSource: 'registry', zone: object.zone || form.zone, objectZone: object.zone, zoneId: object.zoneId, district: object.district, serviceEntities: { object: object.id } };
}

/** Fill only unique, mutually compatible infrastructure links; never guess between candidates. */
export function resolveServiceEntities(objectId, infrastructure, selected = {}) {
  const links = { ...selected, object: objectId };
  const byId = id => infrastructure.find(entity => entity.id === id);
  const line = byId(links.line);
  if (!links.node && line?.nodeId) links.node = line.nodeId;
  const node = byId(links.node);
  if (!links.entrance && node?.entranceId) links.entrance = node.entranceId;
  for (const scope of ['entrance', 'node', 'line']) {
    if (links[scope]) continue;
    const candidates = infrastructure.filter(entity => entity.kind === scope
      && (scope !== 'node' || !links.entrance || !entity.entranceId || entity.entranceId === links.entrance)
      && (scope !== 'entrance' || !byId(links.node)?.entranceId || entity.id === byId(links.node).entranceId)
      && (scope !== 'line' || !links.node || !entity.nodeId || entity.nodeId === links.node));
    if (candidates.length === 1) links[scope] = candidates[0].id;
  }
  return links;
}

/** Changing a parent clears incompatible descendants before resolving unique links. */
export function changeServiceEntity(objectId, infrastructure, selected, scope, value) {
  const links = { ...selected };
  if (value) links[scope] = value; else delete links[scope];
  if (scope === 'entrance') {
    const node = infrastructure.find(entity => entity.id === links.node);
    if (node?.entranceId && node.entranceId !== value) { delete links.node; delete links.line; }
  }
  if (scope === 'node') {
    const line = infrastructure.find(entity => entity.id === links.line);
    if (line?.nodeId && line.nodeId !== value) delete links.line;
    delete links.entrance;
  }
  if (scope === 'line') {
    const line = infrastructure.find(entity => entity.id === value);
    if (line?.nodeId) { links.node = line.nodeId; delete links.entrance; }
  }
  return resolveServiceEntities(objectId, infrastructure, links);
}

/** Reject a registered object paired with a different house or geographic point. */
export function assertServiceLocation(order, object) {
  assertServiceTerritory(order, object);
  if (order.address && object.address && addressIdentity(order.address) !== addressIdentity(object.address)) throw new Error('Адрес заявки не совпадает с выбранным объектом. Выберите объект для нового адреса.');
  if (Array.isArray(order.coords) && Array.isArray(object.coords)) {
    const radians = Math.PI / 180;
    const latitude = (order.coords[0] + object.coords[0]) * radians / 2;
    const distance = 6371000 * Math.hypot((order.coords[0] - object.coords[0]) * radians, (order.coords[1] - object.coords[1]) * radians * Math.cos(latitude));
    if (!Number.isFinite(distance) || distance > 75) throw new Error('Точка заявки не совпадает с выбранным объектом. Подтвердите объект для этой точки.');
  }
}
