const KNOWN_CITIES = {
  'москва': { id: 'moscow', coords: [55.7558, 37.6173], timezone: 'Europe/Moscow', artwork: 'capital' },
  'санкт петербург': { id: 'saint-petersburg', coords: [59.9343, 30.3351], timezone: 'Europe/Moscow', artwork: 'river' },
  'казань': { id: 'kazan', coords: [55.7961, 49.1064], timezone: 'Europe/Moscow', artwork: 'spire' },
  'нижний новгород': { id: 'nizhny-novgorod', coords: [56.2965, 43.9361], timezone: 'Europe/Moscow', artwork: 'hills' },
  'самара': { id: 'samara', coords: [53.1959, 50.1002], timezone: 'Europe/Samara', artwork: 'river' },
  'екатеринбург': { id: 'yekaterinburg', coords: [56.8389, 60.6057], timezone: 'Asia/Yekaterinburg', artwork: 'towers' },
  'новосибирск': { id: 'novosibirsk', coords: [55.0084, 82.9357], timezone: 'Asia/Novosibirsk', artwork: 'bridge' },
  'омск': { id: 'omsk', coords: [54.9885, 73.3242], timezone: 'Asia/Omsk', artwork: 'river' },
  'ростов на дону': { id: 'rostov-on-don', coords: [47.2357, 39.7015], timezone: 'Europe/Moscow', artwork: 'bridge' },
  'краснодар': { id: 'krasnodar', coords: [45.0355, 38.9753], timezone: 'Europe/Moscow', artwork: 'park' },
};

export const DEFAULT_REGION = {
  id: 'moscow', name: 'Москва', coords: [55.7558, 37.6173], timezone: 'Europe/Moscow', artwork: 'capital', hasData: false,
};

export const normalizeCityKey = value => String(value || '')
  .trim()
  .toLocaleLowerCase('ru-RU')
  .replace(/ё/g, 'е')
  .replace(/^(?:г\.?|city|город)\s+/i, '')
  .replace(/[()]/g, ' ')
  .replace(/[-–—]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const titleCase = value => String(value || '').trim().replace(/(^|[\s-])([a-zа-яё])/giu, (_, prefix, letter) => `${prefix}${letter.toLocaleUpperCase('ru-RU')}`);

const ADDRESS_MARKER = /(?:^|\s)(?:ул\.?|улица|проспект|пр-?кт|пр-д|проезд|пер\.?|переулок|шоссе|наб\.?|набережная|д\.?|дом|корп\.?|корпус|стр\.?|строение|район|обл\.?|область)(?:\s|$)/iu;
const localityBeforeAddress = value => String(value || '').split(/\s+(?=(?:ул\.?|улица|проспект|пр-?кт|пр-д|проезд|пер\.?|переулок|шоссе|наб\.?|набережная|д\.?|дом|корп\.?|корпус|стр\.?|строение)\b)/iu)[0].trim();
const knownCityInText = value => {
  const text = String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[-–—]+/g, ' ');
  return Object.keys(KNOWN_CITIES).find(city => {
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?:^|[^a-zа-я])${escaped}(?=$|[^a-zа-я])`, 'iu').test(text);
  }) || '';
};

export function cityNameFromAddress(address) {
  const text = String(address || '').trim();
  if (!text) return '';
  const known = knownCityInText(text);
  if (known) return titleCase(known);
  const explicit = text.match(/(?:^|[,;])\s*(?:(?:г\.?)\s*(?:город\s+)?|город\s+)([^,;]+)/iu);
  const locality = localityBeforeAddress(explicit?.[1]);
  return locality && !ADDRESS_MARKER.test(locality) ? titleCase(locality) : '';
}

export function cityNameFromValue(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const inferred = cityNameFromAddress(text);
  if (inferred) return inferred;
  const cleaned = text.replace(/^(?:г\.?|город)\s+/iu, '').trim();
  if (!cleaned || ADDRESS_MARKER.test(cleaned) || cleaned.split(/\s+/).length > 4) return '';
  return titleCase(cleaned);
}

export const resolveImportedCity = (city, address, fallback = DEFAULT_REGION.name) => {
  const explicitCity = cityNameFromValue(city);
  if (explicitCity) return explicitCity;
  const fallbackName = titleCase(fallback) || DEFAULT_REGION.name;
  const normalizedAddress = String(address || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  const fallbackKey = normalizeCityKey(fallbackName);
  // A service territory can extend beyond the city boundary. In particular,
  // Moscow datasets legitimately contain jobs in the Moscow oblast. Unless a
  // dedicated city column explicitly says otherwise, keep those rows in the
  // workspace selected for the import instead of silently splitting the file.
  if (fallbackKey === 'москва' && /московск(?:ая|ой)\s+обл(?:асть|\.)?/iu.test(normalizedAddress)) return fallbackName;
  return cityNameFromAddress(address) || fallbackName;
};

export function regionIdForCity(cityName) {
  const key = normalizeCityKey(cityName);
  if (KNOWN_CITIES[key]) return KNOWN_CITIES[key].id;
  const ascii = key
    .normalize('NFKD')
    .replace(/[^a-z0-9а-я\s-]/giu, '')
    .trim()
    .replace(/\s+/g, '-');
  if (!ascii) return DEFAULT_REGION.id;
  let hash = 2166136261;
  for (const character of ascii) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `city-${(hash >>> 0).toString(36)}`;
}

export function regionForCity(cityName, coords = null) {
  const name = titleCase(cityName) || DEFAULT_REGION.name;
  const known = KNOWN_CITIES[normalizeCityKey(name)];
  return {
    id: known?.id || regionIdForCity(name),
    name,
    coords: Array.isArray(coords) && coords.length === 2 ? coords : (known?.coords || null),
    timezone: known?.timezone || 'Europe/Moscow',
    artwork: known?.artwork || 'city',
    hasData: false,
  };
}

const validCoords = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

export function deriveRegions(orders = [], engineers = []) {
  const grouped = new Map();
  const add = (item, coords) => {
    const name = item.regionName || item.city || cityNameFromAddress(item.address || item.startAddress) || (item.regionId === 'moscow' ? 'Москва' : '');
    if (!name) return;
    const id = item.regionId || regionIdForCity(name);
    const entry = grouped.get(id) || { id, name: titleCase(name), points: [], orderCount: 0, engineerCount: 0 };
    if (validCoords(coords)) entry.points.push(coords);
    if ('duration' in item) entry.orderCount += 1;
    else entry.engineerCount += 1;
    grouped.set(id, entry);
  };
  orders.forEach(item => add(item, item.coords));
  engineers.forEach(item => add(item, item.startCoords));
  return [...grouped.values()].map(entry => {
    const center = entry.points.length ? [
      entry.points.reduce((sum, point) => sum + point[0], 0) / entry.points.length,
      entry.points.reduce((sum, point) => sum + point[1], 0) / entry.points.length,
    ] : null;
    return { ...regionForCity(entry.name, center), id: entry.id, hasData: true, orderCount: entry.orderCount, engineerCount: entry.engineerCount };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export function regionCatalog(orders = [], engineers = [], selectedRegion = DEFAULT_REGION) {
  const dynamic = deriveRegions(orders, engineers);
  if (dynamic.length) return dynamic;
  return [{ ...DEFAULT_REGION, ...selectedRegion, hasData: false, orderCount: 0, engineerCount: 0 }];
}
