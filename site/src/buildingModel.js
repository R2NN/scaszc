// @ts-check
/** Shared, deterministic building schema. Geometry never changes planning inputs. */
export const BUILDING_SCHEMA = 1;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const hash = value => [...String(value)].reduce((sum, character) => (Math.imul(sum, 31) + character.charCodeAt(0)) >>> 0, 17);
const finite = value => ['number', 'string'].includes(typeof value) && value !== '' && Number.isFinite(Number(value));
const text = (value, fallback = '') => String(value ?? fallback).trim().slice(0, 500);
const maximum = value => Math.max(...String(value || '').split(/[;,]/).map(Number).filter(Number.isFinite), 0);

/** Convert a georeferenced footprint into local metres without inventing interior walls. */
export function localFootprint(geometry = []) {
  const points = geometry.filter(point => finite(point.lat) && finite(point.lon));
  if (points.length < 3) return [];
  const latitude = points.reduce((sum, point) => sum + Number(point.lat), 0) / points.length;
  const longitude = points.reduce((sum, point) => sum + Number(point.lon), 0) / points.length;
  const metres = points.map(point => [(Number(point.lon) - longitude) * 111320 * Math.cos(latitude * Math.PI / 180), (Number(point.lat) - latitude) * 111320]);
  let angle = 0, longest = 0;
  metres.forEach((point, index) => {
    const next = metres[(index + 1) % metres.length];
    const length = Math.hypot(next[0] - point[0], next[1] - point[1]);
    if (length > longest) { longest = length; angle = Math.atan2(next[1] - point[1], next[0] - point[0]); }
  });
  const rotated = metres.map(([x, z]) => [x * Math.cos(angle) + z * Math.sin(angle), -x * Math.sin(angle) + z * Math.cos(angle)]);
  const minX = Math.min(...rotated.map(point => point[0])), minZ = Math.min(...rotated.map(point => point[1]));
  return rotated.map(([x, z]) => [Math.round((x - minX) * 100) / 100, Math.round((z - minZ) * 100) / 100]);
}

/** Validate imported/operator geometry, including arbitrary wings and unequal-height sections. */
export function validateBuildingModel(input, objectId, entities = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Ожидается описание здания.');
  if (input.objectId !== objectId) throw new Error('Схема относится к другому объекту.');
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > 80) throw new Error('Укажите от 1 до 80 секций здания.');
  const ids = new Set();
  const number = (value, min, max, label) => {
    if (!finite(value) || Number(value) < min || Number(value) > max) throw new Error(`${label}: допустимо от ${min} до ${max}.`);
    return Number(value);
  };
  const sections = input.sections.map(section => {
    if (!section || typeof section !== 'object') throw new Error('Некорректное описание секции.');
    const id = text(section.id);
    if (!id || ids.has(id)) throw new Error('У секций должны быть разные непустые идентификаторы.');
    ids.add(id);
    const floors = number(section.floors, 1, 180, 'Этажность');
    if (!Number.isInteger(floors)) throw new Error('Этажность должна быть целым числом.');
    return { id, label: text(section.label, 'Секция'), floors, width: number(section.width, 4, 300, 'Ширина секции'), depth: number(section.depth, 4, 150, 'Глубина секции'), x: number(section.x ?? 0, -1000, 1000, 'Положение секции'), z: number(section.z ?? 0, -1000, 1000, 'Положение крыла'), roof: ['flat', 'gable', 'hip'].includes(section.roof) ? section.roof : 'flat', basement: Boolean(section.basement) };
  });
  const entityIds = new Set(entities.filter(entity => entity.kind === 'node').map(entity => entity.id));
  if (input.placements != null && !Array.isArray(input.placements)) throw new Error('Размещение оборудования должно быть списком.');
  const placements = (input.placements || []).map(placement => {
    if (!placement || typeof placement !== 'object') throw new Error('Некорректное размещение оборудования.');
    const section = sections.find(item => item.id === placement.sectionId);
    if (!entityIds.has(placement.entityId) || !section) throw new Error('Размещение ссылается на неизвестное оборудование или секцию.');
    const floor = number(placement.floor, section.basement ? -1 : 1, section.floors, 'Этаж оборудования');
    if (!Number.isInteger(floor) || floor === 0) throw new Error('Укажите существующий этаж оборудования.');
    return { entityId: placement.entityId, sectionId: section.id, floor, note: text(placement.note), source: text(placement.source, 'Уточнено оператором') };
  });
  if (new Set(placements.map(item => item.entityId)).size !== placements.length) throw new Error('Оборудование размещено несколько раз.');
  const footprint = Array.isArray(input.footprint) ? input.footprint : [];
  if (footprint.length > 1000 || footprint.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(value => finite(value) && Math.abs(Number(value)) <= 10000))) throw new Error('Некорректный контур здания.');
  const provenance = Object.fromEntries(['floors', 'entrances', 'layout', 'equipment'].filter(key => input.provenance?.[key]).map(key => [key, text(input.provenance[key])]));
  return { schemaVersion: BUILDING_SCHEMA, objectId, type: ['apartments', 'house', 'office', 'industrial', 'public', 'other'].includes(input.type) ? input.type : 'other', title: text(input.title), year: text(input.year), sections, footprint: footprint.map(point => point.map(Number)), placements, source: input.source && typeof input.source === 'object' ? { kind: text(input.source.kind), label: text(input.source.label), url: /^https:\/\/www\.openstreetmap\.org\//.test(input.source.url || '') ? input.source.url : '', fetchedAt: text(input.source.fetchedAt) } : { kind: 'operator', label: 'Уточнено оператором' }, provenance, infrastructureSource: 'Схема размещения; сведения об оборудовании — из реестра объекта' };
}

/** Generate a reusable model for any new registry object, preferring exact OSM identity. */
export function generateBuildingModel(object, entities = [], osm = null, entrances = []) {
  const seed = hash(object.id || object.address);
  const tags = osm?.tags || {};
  const footprint = localFootprint(osm?.geometry || object.buildingGeometry || []);
  const width = footprint.length ? Math.max(...footprint.map(point => point[0])) : null;
  const depth = footprint.length ? Math.max(...footprint.map(point => point[1])) : null;
  const type = /industrial|warehouse|hangar/.test(tags.building || '') ? 'industrial' : /school|kindergarten|hospital|civic/.test(tags.building || '') ? 'public' : /office|commercial|retail/.test(tags.building || '') ? 'office' : /house|detached|bungalow/.test(tags.building || '') ? 'house' : 'apartments';
  const measuredFloors = maximum(tags['building:levels']);
  const suppliedFloors = maximum(object.buildingLevels || object.floors);
  const choices = type === 'industrial' ? [1, 1, 2, 3] : type === 'house' ? [1, 2, 2, 3] : type === 'public' ? [2, 3, 4] : [5, 8, 9, 12, 14, 16, 17, 22, 25];
  const floors = clamp(measuredFloors || suppliedFloors || choices[seed % choices.length], 1, 180);
  const registeredEntrances = entities.filter(entity => entity.kind === 'entrance');
  const observed = entrances.filter(entrance => (osm?.geometry || []).some(point => Math.abs(point.lat - entrance.lat) < .0000001 && Math.abs(point.lon - entrance.lon) < .0000001) && entrance.tags?.entrance !== 'service');
  const numbered = observed.map(entrance => Number(entrance.tags?.ref)).filter(value => Number.isInteger(value) && value > 0 && value < 81);
  const estimateCount = type === 'apartments' ? Math.round((width || (25 + seed % 65)) / (floors > 18 ? 28 : 24)) : 1;
  const count = clamp(Math.max(registeredEntrances.length, Number(object.entranceCount) || 0, ...numbered, observed.length, estimateCount, 1), 1, 40);
  const bodyWidth = Math.max(count * 12, width || count * (17 + seed % 8));
  const sectionWidth = clamp(bodyWidth / count, 8, 80);
  const roof = tags['roof:shape'] === 'hipped' ? 'hip' : tags['roof:shape'] === 'gabled' || (!measuredFloors && floors <= 3) ? 'gable' : 'flat';
  // A concave house's bounding box is not the depth of an individual staircase section.
  const sectionDepth = clamp(depth || (floors > 16 ? 19 : 13), 6, type === 'apartments' ? 22 : type === 'public' ? 30 : 70);
  const sections = Array.from({ length: count }, (_, index) => ({ id: `section-${index + 1}`, label: type === 'apartments' ? `Подъезд ${index + 1}` : count === 1 ? 'Основной корпус' : `Корпус ${index + 1}`, floors, width: sectionWidth, depth: sectionDepth, x: index * sectionWidth, z: 0, roof, basement: !['industrial', 'house'].includes(type) }));
  const placements = entities.filter(entity => entity.kind === 'node').map((entity, index) => {
    const entrance = registeredEntrances.findIndex(item => item.id === entity.entranceId);
    const section = sections[clamp(entrance < 0 ? index : entrance, 0, count - 1)];
    const location = String(entity.location || '');
    const floor = /подвал/i.test(location) && section.basement ? -1 : /верхн|чердак|техническом этаже/i.test(location) ? section.floors : 1;
    return { entityId: entity.id, sectionId: section.id, floor, source: 'Модельное размещение по описанию реестра; требуется обследование', note: location };
  });
  return validateBuildingModel({ schemaVersion: BUILDING_SCHEMA, objectId: object.id, type, title: object.address, year: tags.start_date || '', footprint, sections, placements, source: { kind: osm ? 'osm' : 'model', label: osm ? 'OpenStreetMap' : 'Модель по параметрам объекта', url: osm ? `https://www.openstreetmap.org/way/${osm.id}` : '', fetchedAt: osm?.fetchedAt || '' }, provenance: { floors: measuredFloors ? 'Этажность из OpenStreetMap' : suppliedFloors ? 'Этажность из карточки объекта' : 'Модельная этажность; требует уточнения', entrances: 'Условные секции: входы OSM, размеры контура и связи реестра', layout: footprint.length ? 'Контур из OpenStreetMap; внутреннее устройство условное' : 'Условная геометрия; точный контур отсутствует', equipment: 'Существующий модельный инвентарь BeeGo; размещение по описанию' } }, object.id, entities);
}

/** Resolve registered equipment and passive schematic risers without inventing customer links. */
export function buildingAssets(model, entities = []) {
  const assets = [];
  for (const section of model.sections) {
    const nodes = model.placements.filter(placement => placement.sectionId === section.id);
    for (let floor = 1; floor <= section.floors; floor++) {
      if (nodes.some(node => node.floor === floor)) continue;
      assets.push({ id: `riser:${section.id}:${floor}`, label: 'Этажная коробка', sectionId: section.id, floor, schematic: true, entityIds: [], location: `${section.label} · ${floor} этаж`, note: 'Модельная точка стояка. Наличие и размещение оборудования не подтверждены обследованием.' });
    }
    for (const placement of nodes) {
      const node = entities.find(entity => entity.id === placement.entityId);
      const equipment = entities.filter(entity => entity.nodeId === node?.id && entity.kind === 'equipment');
      assets.push({ id: placement.entityId, label: node?.label || 'Шкаф связи', sectionId: section.id, floor: placement.floor, schematic: false, entityIds: [placement.entityId, ...equipment.map(entity => entity.id)], equipment, location: `${section.label} · ${placement.floor < 0 ? 'подвал' : `${placement.floor} этаж`}`, note: placement.note || node?.location || '', placementSource: placement.source });
    }
  }
  return assets;
}

/** Match only explicit infrastructure associations, never a shared address alone. */
export function linkedBuildingOrders(asset, orders, objectId, entities = []) {
  if (!asset || asset.schematic) return [];
  const lines = new Set(entities.filter(entity => entity.kind === 'line' && asset.entityIds.includes(entity.nodeId)).map(entity => entity.id));
  return orders.filter(order => {
    const links = order.serviceEntities || order.durationSnapshot?.entities || {};
    if ((links.object || order.objectId) !== objectId) return false;
    return asset.entityIds.includes(links.node) || asset.entityIds.includes(links.equipment) || lines.has(links.line);
  });
}

/** Project sections to a common isometric scene, retaining true floor counts. */
export function buildingScene(model, entranceId = 'all') {
  const filtered = model.sections.filter(section => entranceId === 'all' || section.id === entranceId);
  const sections = filtered.length ? filtered : model.sections;
  const minX = Math.min(...sections.map(section => section.x));
  const minZ = Math.min(...sections.map(section => section.z));
  const xScale = 6, floorHeight = 32, zScale = 2.7;
  const project = (x, floor, z) => [(x - minX) * xScale + (z - minZ) * zScale, -floor * floorHeight - (z - minZ) * 1.35];
  const corners = sections.flatMap(section => [project(section.x, -1.8, section.z), project(section.x + section.width, -1.8, section.z), project(section.x, section.floors + 1.7, section.z + section.depth), project(section.x + section.width, section.floors + 1.7, section.z + section.depth)]);
  const left = Math.min(...corners.map(point => point[0])) - 65, top = Math.min(...corners.map(point => point[1])) - 12;
  return { sections, project, floorHeight, viewBox: [left, top, Math.max(...corners.map(point => point[0])) - left + 50, Math.max(...corners.map(point => point[1])) - top + 35] };
}
