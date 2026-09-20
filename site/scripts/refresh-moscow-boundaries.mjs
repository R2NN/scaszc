import fs from 'node:fs/promises';

const catalogPath = 'public/data/moscow-administrative-areas.geojson';
const cachePath = '.codex-work/nominatim-moscow-boundaries-cache.json';
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
let cache = {};
try { cache = JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch {}

const normalize = value => String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const queryFor = feature => {
  const { name, scope, unitType } = feature.properties;
  if (scope === 'zone') return `${name} административный округ, Москва, Россия`;
  if (/поселение/i.test(unitType)) return `поселение ${name}, Москва, Россия`;
  if (/городской округ/i.test(unitType)) return `городской округ ${name}, Москва, Россия`;
  return `${name} район, Москва, Россия`;
};
const retryQueryFor = feature => {
  const { name, unitType } = feature.properties;
  if (/муниципальный округ/i.test(unitType)) return `район ${name}, Москва, Россия`;
  if (/поселение/i.test(unitType)) return `${name}, Москва, Россия`;
  if (/городской округ/i.test(unitType)) return `${name}, Москва, Россия`;
  return queryFor(feature);
};
const bboxFor = geometry => {
  const points = [];
  const visit = value => {
    if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') points.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
  };
  visit(geometry.coordinates);
  return points.reduce((bbox, [lon, lat]) => [Math.min(bbox[0], lon), Math.min(bbox[1], lat), Math.max(bbox[2], lon), Math.max(bbox[3], lat)], [Infinity, Infinity, -Infinity, -Infinity]);
};

let refreshed = 0;
let fallback = 0;
for (let index = 0; index < catalog.features.length; index += 1) {
  const feature = catalog.features[index];
  const key = `${feature.properties.scope}:${normalize(feature.properties.name)}`;
  let current = cache[key];
  if (!current) {
    if (index) await wait(1100);
    const query = encodeURIComponent(current === false ? retryQueryFor(feature) : queryFor(feature));
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=geojson&polygon_geojson=1&polygon_threshold=0.00015&limit=5&countrycodes=ru&accept-language=ru&q=${query}`, {
        headers: { 'User-Agent': 'BeeGo territory verifier/1.0', Accept: 'application/geo+json' },
      });
      if (response.ok) {
        const collection = await response.json();
        const target = normalize(feature.properties.name);
        current = collection.features.find(item =>
          ['Polygon', 'MultiPolygon'].includes(item.geometry?.type)
          && /Москв/i.test(item.properties?.display_name || '')
          && normalize(item.properties?.display_name).includes(target)
          && (item.properties?.type === 'administrative' || item.properties?.category === 'boundary')
        ) || null;
      }
    } catch {}
    cache[key] = current || false;
    await fs.writeFile(cachePath, `${JSON.stringify(cache)}\n`, 'utf8');
  }
  if (current) {
    feature.geometry = current.geometry;
    feature.bbox = current.bbox?.length === 4 ? current.bbox : bboxFor(current.geometry);
    feature.properties.display_name = current.properties?.display_name || feature.properties.display_name;
    feature.properties.source = 'OpenStreetMap / Nominatim';
    feature.properties.refreshedAt = '2026-09-17';
    refreshed += 1;
  } else {
    fallback += 1;
  }
  if ((index + 1) % 10 === 0 || index === catalog.features.length - 1) console.log(`Проверено ${index + 1}/${catalog.features.length}; обновлено ${refreshed}; резерв ${fallback}`);
}

await fs.writeFile(catalogPath, `${JSON.stringify(catalog)}\n`, 'utf8');
console.log(`Готово: ${refreshed} актуальных границ, ${fallback} локальных резервных границ`);
