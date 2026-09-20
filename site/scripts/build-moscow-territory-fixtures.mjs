import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const BOUNDARY_OUTPUT = path.join(ROOT, 'public', 'data', 'moscow-administrative-areas.geojson');
const JOBS_OUTPUT = path.join(ROOT, 'public', 'test-data', 'beego-moscow-territories.json');
const SOURCES = {
  zones: 'https://gis-lab.info/data/mos-adm/ao.geojson',
  districts: 'https://gis-lab.info/data/mos-adm/mo.geojson',
};

const ZONE_IDS = {
  'Восточный': 'EAST',
  'Западный': 'WEST',
  'Зеленоградский': 'ZELENOGRAD',
  'Новомосковский': 'NEW_MOSCOW',
  'Северный': 'NORTH',
  'Северо-Восточный': 'NORTHEAST',
  'Северо-Западный': 'NORTHWEST',
  'Троицкий': 'TROITSKY',
  'Центральный': 'CENTER',
  'Юго-Восточный': 'SOUTHEAST',
  'Юго-Западный': 'SOUTHWEST',
  'Южный': 'SOUTH',
};

const WORK_VARIANTS = [
  { bk_type: 'INSTALL', hd_type: 'Заявка на подключение', required_skill: 'Подключение', priority: 'NORMAL' },
  { bk_type: 'REPAIR', hd_type: 'Диагностика', required_skill: 'Диагностика', priority: 'NORMAL' },
  { bk_type: 'REPAIR', hd_type: 'Нет линка', required_skill: 'Диагностика', priority: 'NORMAL' },
  { bk_type: 'SERVICE', hd_type: 'Конвергенция абонента', required_skill: 'Подключение', priority: 'NORMAL' },
  { bk_type: 'EQUIPMENT', hd_type: 'Замена оборудования', required_skill: 'Замена оборудования', priority: 'HIGH' },
  { bk_type: 'EMERGENCY', hd_type: 'Аварийное восстановление', required_skill: 'Аварийные работы', priority: 'EMERGENCY' },
];

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  return Boolean(polygon?.length) && pointInRing(point, polygon[0]) && !polygon.slice(1).some(ring => pointInRing(point, ring));
}

function geometryContainsPoint(geometry, point) {
  if (geometry?.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.some(polygon => pointInPolygon(point, polygon));
  return false;
}

function boundsForCoordinates(coordinates) {
  const points = [];
  const visit = value => {
    if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') points.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
  };
  visit(coordinates);
  return points.reduce(
    (bounds, [lon, lat]) => [
      Math.min(bounds[0], lon), Math.min(bounds[1], lat),
      Math.max(bounds[2], lon), Math.max(bounds[3], lat),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

function representativePoint(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const ranked = polygons
    .map(polygon => ({ polygon, bbox: boundsForCoordinates(polygon) }))
    .sort((a, b) => (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]));
  for (const { bbox } of ranked) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
    if (geometryContainsPoint(geometry, center)) return center;
    for (let radius = 0; radius <= 20; radius += 1) {
      for (let x = 0; x <= 40; x += 1) {
        for (let y = 0; y <= 40; y += 1) {
          if (Math.max(Math.abs(x - 20), Math.abs(y - 20)) !== radius) continue;
          const candidate = [minLon + ((x + 0.5) / 41) * (maxLon - minLon), minLat + ((y + 0.5) / 41) * (maxLat - minLat)];
          if (geometryContainsPoint(geometry, candidate)) return candidate;
        }
      }
    }
  }
  throw new Error('Не удалось подобрать точку внутри полигона');
}

async function downloadJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'BeeGo territory fixture builder/1.0' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function normalizeFeature(feature, scope) {
  const name = feature.properties.NAME;
  const aoName = scope === 'zone' ? name : feature.properties.NAME_AO;
  return {
    type: 'Feature',
    bbox: boundsForCoordinates(feature.geometry.coordinates),
    properties: {
      scope,
      name,
      aoName,
      unitType: scope === 'zone' ? 'Административный округ' : feature.properties.TYPE_MO,
      okato: feature.properties.OKATO,
      oktmo: feature.properties.OKTMO || '',
      type: 'administrative',
      category: 'boundary',
      display_name: scope === 'zone' ? `${name} административный округ, Москва, Россия` : `${name}, ${aoName} административный округ, Москва, Россия`,
      source: 'GIS-Lab / OpenStreetMap',
    },
    geometry: feature.geometry,
  };
}

const useExistingCatalog = process.argv.includes('--from-catalog');
let catalog;
let zones;
let districts;
if (useExistingCatalog) {
  catalog = JSON.parse(await fs.readFile(BOUNDARY_OUTPUT, 'utf8'));
  zones = catalog.features.filter(feature => feature.properties.scope === 'zone');
  districts = catalog.features.filter(feature => feature.properties.scope === 'district');
} else {
  const [zoneSource, districtSource] = await Promise.all([
    downloadJson(SOURCES.zones),
    downloadJson(SOURCES.districts),
  ]);
  zones = zoneSource.features.map(feature => normalizeFeature(feature, 'zone'));
  districts = districtSource.features.map(feature => normalizeFeature(feature, 'district'));
  catalog = {
    type: 'FeatureCollection',
    name: 'Административные территории Москвы',
    source: 'https://gis-lab.info/qa/moscow-atd.html',
    features: [...zones, ...districts],
  };
}

const jobs = districts.map((feature, index) => {
  const [longitude, latitude] = representativePoint(feature.geometry);
  const containingZone = zones.find(zone => geometryContainsPoint(zone.geometry, [longitude, latitude]));
  const aoName = containingZone?.properties.name || feature.properties.aoName;
  feature.properties.aoName = aoName;
  const variant = WORK_VARIANTS[index % WORK_VARIANTS.length];
  const sourceId = `MOSCOW-AREA-${String(index + 1).padStart(3, '0')}`;
  return {
    job_id: sourceId,
    source_job_id: feature.properties.oktmo || feature.properties.okato,
    scenario: 'Проверка территорий Москвы',
    zone_id: ZONE_IDS[aoName] || aoName,
    zone_name: aoName,
    district: feature.properties.name,
    address: `Тестовая точка, ${feature.properties.name}, Москва`,
    latitude: Number(latitude.toFixed(7)),
    longitude: Number(longitude.toFixed(7)),
    window_start: '2026-09-17 09:00',
    window_end: '2026-09-17 18:00',
    service_duration_min: 60,
    ...variant,
    required_equipment: index % 7 === 0 ? 'Аварийный комплект' : '',
    status: 'Новая',
    notes: `Контроль отображения территории: ${feature.properties.name}`,
  };
});

const failures = jobs.filter((job, index) => !geometryContainsPoint(districts[index].geometry, [job.longitude, job.latitude]));
const normalizedNames = new Set(districts.map(feature => feature.properties.name.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')));
if (zones.length !== 12) throw new Error(`Ожидалось 12 округов, получено ${zones.length}`);
if (districts.length !== 146) throw new Error(`Ожидалось 146 муниципальных территорий, получено ${districts.length}`);
if (normalizedNames.size !== districts.length) throw new Error('После нормализации появились дубли названий территорий');
if (failures.length) throw new Error(`${failures.length} тестовых точек находятся вне своих полигонов`);

await fs.mkdir(path.dirname(BOUNDARY_OUTPUT), { recursive: true });
await fs.mkdir(path.dirname(JOBS_OUTPUT), { recursive: true });
await fs.writeFile(BOUNDARY_OUTPUT, `${JSON.stringify(catalog)}\n`, 'utf8');
await fs.writeFile(JOBS_OUTPUT, `${JSON.stringify({ jobs }, null, 2)}\n`, 'utf8');

console.log(`Создан каталог: ${zones.length} округов + ${districts.length} муниципальных территорий`);
console.log(`Создан тестовый импорт: ${jobs.length} заявок; все точки находятся внутри своих полигонов`);
