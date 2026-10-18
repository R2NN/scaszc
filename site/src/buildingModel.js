// @ts-check
import { footprintAgreement, footprintSections, sectionPlanPoint } from './buildingGeometry.js';
import { validateFloorPlans } from './buildingInterior.js';
import { syntheticCustomerLocations, validateCustomerLocations } from './buildingCustomers.js';
/** Shared, deterministic building schema. Geometry never changes planning inputs. */
export const BUILDING_SCHEMA = 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const hash = value => [...String(value)].reduce((sum, character) => (Math.imul(sum, 31) + character.charCodeAt(0)) >>> 0, 17);
const finite = value => ['number', 'string'].includes(typeof value) && value !== '' && Number.isFinite(Number(value));
const text = (value, fallback = '') => String(value ?? fallback).trim().slice(0, 500);
const maximum = value => Math.max(...String(value || '').split(/[;,]/).map(Number).filter(Number.isFinite), 0);

/** Coherent demonstration interiors; these profiles are assumptions, never inferred survey facts. */
export function buildingInteriorProfile(type, floors, year = '') {
  if (type === 'industrial') return { layout: 'open', rooms: 0, elevators: 0, stairsX: .15, riserX: .88, boxEvery: Math.max(1, floors), feed: 'ground', source: 'model' };
  if (['public', 'office'].includes(type)) return { layout: 'corridor', rooms: 6, elevators: floors > 3 ? 1 : 0, stairsX: .14, riserX: .85, boxEvery: 1, feed: 'ground', source: 'model' };
  if (floors <= 5) return { layout: 'stairwell', rooms: 4, elevators: 0, stairsX: .35, riserX: .68, boxEvery: Number.parseInt(year) < 1965 ? 2 : 1, feed: 'basement', source: 'model' };
  if (floors <= 12) return { layout: 'stairwell', rooms: 4, elevators: 1, stairsX: .35, riserX: .68, boxEvery: 1, feed: 'attic', source: 'model' };
  return { layout: 'central', rooms: 6, elevators: 2, stairsX: .35, riserX: .68, boxEvery: 2, feed: 'basement', source: 'model' };
}

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
    const defaults = buildingInteriorProfile(input.type, floors, input.year);
    const interior = { ...defaults, ...section.interior };
    const integer = (value, min, max, label) => { const result = number(value, min, max, label); if (!Number.isInteger(result)) throw new Error(`${label}: нужно целое число.`); return result; };
    const basement = Boolean(section.basement);
    const floorList = (values, label) => { if (!Array.isArray(values) || values.length > 180) throw new Error(`${label}: ожидается список этажей.`); const result = [...new Set(values.map(value => integer(value, basement ? -1 : 1, floors, label)))]; if (result.includes(0)) throw new Error('Нулевой этаж не используется; задайте первый этаж как 1.'); return result.sort((a, b) => a - b); };
    const risers = section.risers ?? [{ id: `${id}-riser`, x: interior.riserX, fromFloor: basement ? -1 : 1, toFloor: floors, boxFloors: Array.from({ length: floors }, (_, index) => index + 1).filter(floor => (floor - 1) % interior.boxEvery === 0), source: 'model' }];
    if (!Array.isArray(risers) || risers.length > 8) throw new Error('В секции допустимо до 8 стояков.');
    const riserIds = new Set();
    return { id, label: text(section.label, 'Секция'), floors, width: number(section.width, 4, 300, 'Ширина секции'), depth: number(section.depth, 4, 150, 'Глубина секции'), x: number(section.x ?? 0, -1000, 1000, 'Положение секции'), z: number(section.z ?? 0, -1000, 1000, 'Положение крыла'), rotation: number(section.rotation ?? 0, -360, 360, 'Поворот секции'), roof: ['flat', 'gable', 'hip'].includes(section.roof) ? section.roof : 'flat', basement,
      interior: { layout: ['stairwell', 'central', 'corridor', 'open'].includes(interior.layout) ? interior.layout : defaults.layout, rooms: integer(interior.rooms, 0, 16, 'Помещений на этаже'), elevators: integer(interior.elevators, 0, 4, 'Лифтов'), stairsX: number(interior.stairsX, .08, .8, 'Положение лестницы'), riserX: number(interior.riserX, .1, .92, 'Положение стояка'), boxEvery: integer(interior.boxEvery, 1, 180, 'Шаг этажных коробок'), feed: ['basement', 'attic', 'ground'].includes(interior.feed) ? interior.feed : defaults.feed, source: text(interior.source, 'model') },
      technicalFloors: floorList(section.technicalFloors || [], 'Технические этажи'),
      risers: risers.map(riser => {
        if (!riser || !text(riser.id) || riserIds.has(text(riser.id))) throw new Error('У стояков должны быть разные идентификаторы.');
        const riserId = text(riser.id); riserIds.add(riserId);
        const fromFloor = integer(riser.fromFloor, basement ? -1 : 1, floors, 'Начало стояка'), toFloor = integer(riser.toFloor, 1, floors, 'Конец стояка');
        if (fromFloor === 0 || fromFloor > toFloor) throw new Error('Некорректный диапазон стояка.');
        const boxFloors = floorList(riser.boxFloors || [], 'Этажные коробки');
        if (boxFloors.some(floor => floor < fromFloor || floor > toFloor)) throw new Error('Этажная коробка вне диапазона стояка.');
        return { id: riserId, label: text(riser.label, 'Стояк связи'), x: number(riser.x, .08, .92, 'Положение стояка'), z: number(riser.z ?? .08, .02, .98, 'Глубина стояка'), fromFloor, toFloor, boxFloors, source: text(riser.source, 'model') };
      }) };
  });
  sections.forEach((section, index) => {
    const outline = input.sections[index].outline || [[0, 0], [section.width, 0], [section.width, section.depth], [0, section.depth]];
    if (!Array.isArray(outline) || outline.length < 3 || outline.length > 200) throw new Error('Некорректный контур секции.');
    section.outline = outline.map(point => { if (!Array.isArray(point) || point.length !== 2) throw new Error('Некорректная точка контура секции.'); return [number(point[0], 0, section.width, 'Контур секции'), number(point[1], 0, section.depth, 'Контур секции')]; });
    section.floorPlans = validateFloorPlans(input.sections[index].floorPlans, section);
  });
  const entityIds = new Set(entities.filter(entity => entity.kind === 'node').map(entity => entity.id));
  if (input.placements != null && !Array.isArray(input.placements)) throw new Error('Размещение оборудования должно быть списком.');
  const placements = (input.placements || []).map(placement => {
    if (!placement || typeof placement !== 'object') throw new Error('Некорректное размещение оборудования.');
    const section = sections.find(item => item.id === placement.sectionId);
    if (!entityIds.has(placement.entityId) || !section) throw new Error('Размещение ссылается на неизвестное оборудование или секцию.');
    const floor = number(placement.floor, section.basement ? -1 : 1, section.floors, 'Этаж оборудования');
    if (!Number.isInteger(floor) || floor === 0) throw new Error('Укажите существующий этаж оборудования.');
    const riser = section.risers.find(item => item.id === placement.riserId);
    if (placement.riserId && !riser) throw new Error('Размещение ссылается на неизвестный стояк.');
    return { entityId: placement.entityId, sectionId: section.id, floor, x: number(placement.x ?? riser?.x ?? section.interior.riserX, .08, .92, 'Положение оборудования'), z: number(placement.z ?? riser?.z ?? .08, .02, .98, 'Глубина оборудования'), riserId: riser?.id || section.risers[0]?.id || '', note: text(placement.note), source: text(placement.source, 'Уточнено оператором') };
  });
  if (new Set(placements.map(item => item.entityId)).size !== placements.length) throw new Error('Оборудование размещено несколько раз.');
  const footprint = Array.isArray(input.footprint) ? input.footprint : [];
  if (footprint.length > 1000 || footprint.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(value => finite(value) && Math.abs(Number(value)) <= 10000))) throw new Error('Некорректный контур здания.');
  const provenance = Object.fromEntries(['floors', 'entrances', 'layout', 'interior', 'network', 'equipment'].filter(key => input.provenance?.[key]).map(key => [key, text(input.provenance[key])]));
  if (input.cables != null && (!Array.isArray(input.cables) || input.cables.length > 500)) throw new Error('Кабельные трассы должны быть списком.');
  const cables = (input.cables || []).map(cable => {
    if (!cable || !Array.isArray(cable.points) || cable.points.length < 2 || cable.points.length > 200) throw new Error('Трасса должна содержать от 2 до 200 точек.');
    return { id: text(cable.id), label: text(cable.label, 'Кабельная трасса'), source: text(cable.source, 'import'), points: cable.points.map(point => {
      const section = sections.find(item => item.id === point.sectionId);
      if (!section) throw new Error('Трасса ссылается на неизвестную секцию.');
      return { sectionId: section.id, x: number(point.x, 0, section.width, 'Координата трассы'), z: number(point.z, 0, section.depth, 'Координата трассы'), floor: number(point.floor, section.basement ? -1 : 0, section.floors, 'Высота трассы') };
    }) };
  });
  const customerLocations = validateCustomerLocations(input.customerLocations ?? [], { sections });
  return { schemaVersion: BUILDING_SCHEMA, objectId, customerLocations, dataClass: ['synthetic', 'mixed', 'operator'].includes(input.dataClass) ? input.dataClass : input.source?.kind === 'model' ? 'synthetic' : 'mixed', type: ['apartments', 'house', 'office', 'industrial', 'public', 'other'].includes(input.type) ? input.type : 'other', title: text(input.title), year: text(input.year), sections, cables, geometry: { basis: ['footprint', 'model', 'operator'].includes(input.geometry?.basis) ? input.geometry.basis : 'operator', agreement: finite(input.geometry?.agreement) ? number(input.geometry.agreement, 0, 100, 'Сходство контура') : null }, footprint: footprint.map(point => point.map(Number)), placements, source: input.source && typeof input.source === 'object' ? { kind: text(input.source.kind), label: text(input.source.label), url: /^https:\/\/www\.openstreetmap\.org\//.test(input.source.url || '') ? input.source.url : '', fetchedAt: text(input.source.fetchedAt) } : { kind: 'operator', label: 'Уточнено оператором' }, provenance, infrastructureSource: 'Схема размещения; сведения об оборудовании — из реестра объекта' };
}

/** Generate a reusable model for any new registry object, preferring exact OSM identity. */
export function generateBuildingModel(object, entities = [], osm = null, entrances = []) {
  const seed = hash(object.id || object.address);
  const tags = osm?.tags || {};
  const footprint = localFootprint(osm?.geometry || object.buildingGeometry || []);
  const width = footprint.length ? Math.max(...footprint.map(point => point[0])) : null;
  const depth = footprint.length ? Math.max(...footprint.map(point => point[1])) : null;
  const declaredType = object.buildingType || tags.building || '';
  const type = ['apartments', 'house', 'office', 'industrial', 'public', 'other'].includes(declaredType) ? declaredType : /industrial|warehouse|hangar/.test(declaredType) ? 'industrial' : /school|kindergarten|hospital|civic/.test(declaredType) ? 'public' : /office|commercial|retail/.test(declaredType) ? 'office' : /house|detached|bungalow/.test(declaredType) ? 'house' : 'apartments';
  const measuredFloors = maximum(tags['building:levels']);
  const suppliedFloors = maximum(object.buildingLevels || object.floors);
  const regional = /(?:^|,\s*)(?:МО[ ,]|Московская\s+область)/i.test(object.address || '');
  const choices = type === 'industrial' ? [1, 1, 2, 3] : type === 'house' ? [1, 2, 2, 3] : type === 'public' ? [2, 3, 4] : regional ? [3, 4, 5, 9] : [5, 8, 9, 12, 14, 16, 17, 22, 25];
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
  const derived = footprintSections(footprint, count);
  const structure = derived.length ? derived : Array.from({ length: count }, (_, index) => ({ width: sectionWidth, depth: sectionDepth, x: index * sectionWidth, z: 0, rotation: 0 }));
  const sections = structure.map((shape, index) => {
    const interior = buildingInteriorProfile(type, floors, tags.start_date), basement = !['industrial', 'house'].includes(type), id = `section-${index + 1}`;
    const positions = floors > 12 && shape.width >= 22 ? [.32, .68] : [interior.riserX];
    const risers = positions.map((x, i) => ({ id: `${id}-riser-${i + 1}`, label: `Стояк ${i + 1}`, x, z: .08, fromFloor: basement ? -1 : 1, toFloor: floors, boxFloors: Array.from({ length: floors }, (_, floor) => floor + 1).filter(floor => (floor - 1) % interior.boxEvery === 0), source: 'model' }));
    return { ...shape, id, label: type === 'apartments' ? `Секция ${index + 1}` : structure.length === 1 ? 'Основной корпус' : `Корпус ${index + 1}`, floors, roof, basement, interior, risers };
  });
  const placements = entities.filter(entity => entity.kind === 'node').map((entity, index) => {
    const entrance = registeredEntrances.findIndex(item => item.id === entity.entranceId);
    const section = sections[clamp(entrance < 0 ? index : entrance, 0, sections.length - 1)];
    const location = String(entity.location || '');
    const floor = /подвал/i.test(location) && section.basement ? -1 : /верхн|чердак|техническом этаже/i.test(location) ? section.floors : 1;
    const riser = section.risers[index % section.risers.length];
    return { entityId: entity.id, sectionId: section.id, floor, x: riser.x, z: riser.z, riserId: riser.id, source: 'Модельное размещение по описанию реестра; требуется обследование', note: location };
  });
  const model = validateBuildingModel({ schemaVersion: BUILDING_SCHEMA, objectId: object.id, type, title: object.address, year: tags.start_date || '', footprint, sections, placements, geometry: { basis: derived.length ? 'footprint' : 'model', agreement: derived.length ? footprintAgreement(footprint, sections) : null }, source: { kind: osm ? 'osm' : 'model', label: osm ? 'OpenStreetMap' : 'Модель по параметрам объекта', url: osm ? `https://www.openstreetmap.org/way/${osm.id}` : '', fetchedAt: osm?.fetchedAt || '' }, provenance: { floors: measuredFloors ? 'Этажность из OpenStreetMap; высоты отдельных крыльев без обследования считаются одинаковыми' : suppliedFloors ? 'Этажность из карточки объекта' : 'Модельная этажность; требует уточнения', entrances: 'Секции разреза не равны подтверждённым подъездам; привязки узлов модельные', layout: derived.length ? 'Крылья приближены по контуру OSM; небольшие выступы фасада упрощены' : 'Условная геометрия; точный разрез отсутствует', interior: 'Демонстрационный профиль планировки по назначению и этажности. Лифты, помещения и лестницы не подтверждены', network: 'Модель стояков и шага этажных коробок; фактическая кабельная трасса неизвестна', equipment: 'Существующий синтетический инвентарь BeeGo; размещение по описанию' } }, object.id, entities);
  model.customerLocations = validateCustomerLocations(syntheticCustomerLocations(model, object), model);
  return model;
}

/** Resolve registered equipment and passive schematic risers without inventing customer links. */
export function buildingAssets(model, entities = []) {
  const assets = [];
  for (const section of model.sections) {
    const nodes = model.placements.filter(placement => placement.sectionId === section.id);
    for (const riser of section.risers) for (const floor of riser.boxFloors) {
      if (nodes.some(node => node.floor === floor && node.riserId === riser.id)) continue;
      assets.push({ id: `riser:${section.id}:${riser.id}:${floor}`, label: 'Этажная коробка', sectionId: section.id, floor, x: riser.x, z: riser.z, riserId: riser.id, schematic: true, entityIds: [], location: `${section.label} · ${floor} этаж`, note: 'Модельная точка стояка. Наличие и размещение оборудования не подтверждены обследованием.' });
    }
    for (const placement of nodes) {
      const node = entities.find(entity => entity.id === placement.entityId);
      const equipment = entities.filter(entity => entity.nodeId === node?.id && entity.kind === 'equipment');
      assets.push({ id: placement.entityId, label: node?.label || 'Шкаф связи', sectionId: section.id, floor: placement.floor, x: placement.x, z: placement.z, riserId: placement.riserId, schematic: false, entityIds: [placement.entityId, ...equipment.map(entity => entity.id)], equipment, location: `${section.label} · ${placement.floor < 0 ? 'подвал' : `${placement.floor} этаж`}`, note: placement.note || node?.location || '', placementSource: placement.source });
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
  const project = (x, floor, z, section = null) => { const [worldX, worldZ] = section ? sectionPlanPoint(section, x - section.x, z - section.z) : [x, z]; return [(worldX - minX) * xScale + (worldZ - minZ) * zScale, -floor * floorHeight - (worldZ - minZ) * 1.35]; };
  const corners = sections.flatMap(section => section.outline.flatMap(([dx, dz]) => [-1.8, section.floors + 1.7].map(floor => project(section.x + dx, floor, section.z + dz, section))));
  const left = Math.min(...corners.map(point => point[0])) - 65, top = Math.min(...corners.map(point => point[1])) - 12;
  return { sections, project, floorHeight, viewBox: [left, top, Math.max(...corners.map(point => point[0])) - left + 50, Math.max(...corners.map(point => point[1])) - top + 35] };
}
