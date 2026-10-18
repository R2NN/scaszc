// @ts-check
import { floorPlanAt } from './buildingInterior.js';

const hash = value => [...String(value)].reduce((sum, character) => (Math.imul(sum, 31) + character.charCodeAt(0)) >>> 0, 17);
const unitKinds = new Set(['apartment', 'office']);

/** Customer homes are anchored to an explicit floor-space ID, never inferred from the building address. */
export function validateCustomerLocations(input, model) {
  if (!Array.isArray(input) || input.length > 2000) throw new Error('Расположение клиентов должно быть списком до 2000 записей.');
  const orders = new Set();
  return input.map(location => {
    const orderId = typeof location?.orderId === 'string' || typeof location?.orderId === 'number' ? String(location.orderId).trim() : '';
    if (!orderId || orderId.length > 150 || orders.has(orderId)) throw new Error('У расположения клиента нужен уникальный ID заявки.');
    orders.add(orderId);
    const section = model.sections.find(item => item.id === location.sectionId);
    if (!section || !Number.isInteger(location.floor) || location.floor < 1 || location.floor > section.floors) throw new Error('Клиент привязан к неизвестной секции или этажу.');
    const space = floorPlanAt(section, location.floor).spaces.find(item => item.id === location.spaceId && unitKinds.has(item.kind));
    if (!space) throw new Error('Квартира клиента должна ссылаться на существующую квартиру или помещение этажа.');
    if (!['synthetic', 'operator', 'import'].includes(location.source)) throw new Error('Укажите источник расположения клиента: synthetic, operator или import.');
    const unit = typeof location.unit === 'string' || (typeof location.unit === 'number' && Number.isFinite(location.unit)) ? String(location.unit).trim() : '';
    if (!unit || unit.length > 40) throw new Error('Укажите номер квартиры или помещения клиента до 40 символов.');
    return { orderId, sectionId: section.id, floor: location.floor, spaceId: space.id, unit, source: location.source };
  });
}

/** Seed only the existing synthetic hackathon registry; new real orders never get invented apartments. */
export function syntheticCustomerLocations(model, object) {
  if (!/complexity-v2|synthetic/i.test(object.source || '')) return [];
  return (object.examples || []).flatMap(order => {
    if (!['Подключение', 'Локальная заявка', 'Дозаказ'].includes(order.workType)) return [];
    const nodeId = order.serviceEntities?.node;
    const placement = model.placements.find(item => item.entityId === nodeId);
    const section = model.sections.find(item => item.id === placement?.sectionId);
    if (!section) return [];
    const seed = hash(order.id);
    let floor = 1 + seed % section.floors;
    let spaces = floorPlanAt(section, floor).spaces.filter(space => unitKinds.has(space.kind));
    if (!spaces.length && section.floors > 1) { floor = 2; spaces = floorPlanAt(section, floor).spaces.filter(space => unitKinds.has(space.kind)); }
    if (!spaces.length) return [];
    const index = Math.floor(seed / 17) % spaces.length, space = spaces[index];
    const previous = model.sections.slice(0, model.sections.indexOf(section)).reduce((sum, item) => sum + item.floors * item.interior.rooms, 0);
    return [{ orderId: String(order.id), sectionId: section.id, floor, spaceId: space.id, unit: String(previous + (floor - 1) * spaces.length + index + 1), source: 'synthetic' }];
  });
}

/** Resolve locations only for the current object's current-day orders; explicit order data has priority. */
export function buildingCustomers(model, orders) {
  if (!model) return [];
  return orders.filter(order => (order.serviceEntities?.object || order.objectId || order.durationSnapshot?.entities?.object) === model.objectId).map(order => {
    const supplied = order.buildingLocation;
    const candidate = supplied ? { ...supplied, orderId: String(order.id) } : (model.customerLocations || []).find(item => item.orderId === String(order.id));
    if (!candidate) return { order, orderId: String(order.id), known: false, reason: 'Расположение квартиры не указано' };
    try {
      const [location] = validateCustomerLocations([candidate], model);
      const section = model.sections.find(item => item.id === location.sectionId);
      const space = floorPlanAt(section, location.floor).spaces.find(item => item.id === location.spaceId);
      return { ...location, known: true, order, section, space, label: `${space.kind === 'apartment' ? 'Кв.' : 'Пом.'} ${location.unit}` };
    } catch {
      return { order, orderId: String(order.id), known: false, reason: 'Привязка квартиры требует уточнения' };
    }
  });
}

/** Bounded display number shared by the customer marker and its order card. */
export function customerOrderNumber(order) {
  return String(order.sourceData?.source_job_id || order.sourceId || order.id).replace(/^(EAST|SOUTHEAST|SOUTHCENTER)-/, '');
}
