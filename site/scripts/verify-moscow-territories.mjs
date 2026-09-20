import fs from 'node:fs/promises';
import { normalizeTerritoryKey, zoneBoundaryName } from '../src/territoryAliases.js';
import { translateServiceLabel, workPointType } from '../src/workTypes.js';

const catalog = JSON.parse(await fs.readFile('public/data/moscow-administrative-areas.geojson', 'utf8'));
const { jobs } = JSON.parse(await fs.readFile('public/test-data/beego-moscow-territories.json', 'utf8'));
const zones = catalog.features.filter(feature => feature.properties.scope === 'zone');
const districts = catalog.features.filter(feature => feature.properties.scope === 'district');

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

function contains(geometry, point) {
  if (geometry?.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.some(polygon => pointInPolygon(point, polygon));
  return false;
}

function fail(message) {
  throw new Error(message);
}

if (zones.length !== 12) fail(`Ожидалось 12 округов, найдено ${zones.length}`);
if (districts.length !== 146) fail(`Ожидалось 146 территорий, найдено ${districts.length}`);
if (jobs.length !== districts.length) fail(`Число заявок ${jobs.length} не совпадает с числом территорий ${districts.length}`);

const districtByName = new Map(districts.map(feature => [normalizeTerritoryKey(feature.properties.name), feature]));
const zoneByName = new Map(zones.map(feature => [normalizeTerritoryKey(feature.properties.name), feature]));
const districtFailures = [];
const zoneFailures = [];

for (const job of jobs) {
  const point = [Number(job.longitude), Number(job.latitude)];
  const district = districtByName.get(normalizeTerritoryKey(job.district));
  const zone = zoneByName.get(normalizeTerritoryKey(job.zone_name));
  if (!district || !contains(district.geometry, point)) districtFailures.push(job.district);
  if (!zone || !contains(zone.geometry, point)) zoneFailures.push(`${job.zone_name}: ${job.district}`);
}

if (districtFailures.length) fail(`Точки вне района: ${districtFailures.join(', ')}`);
if (zoneFailures.length) fail(`Точки вне округа: ${zoneFailures.join(', ')}`);

const aliasCases = new Map([
  ['Восток', 'Восточный'], ['ВАО', 'Восточный'], ['EAST', 'Восточный'],
  ['Запад', 'Западный'], ['ЗАО', 'Западный'], ['WEST', 'Западный'],
  ['Север', 'Северный'], ['САО', 'Северный'], ['NORTH', 'Северный'],
  ['Юг', 'Южный'], ['ЮАО', 'Южный'], ['SOUTH', 'Южный'],
  ['Северо-Восток', 'Северо-Восточный'], ['СВАО', 'Северо-Восточный'], ['NORTHEAST', 'Северо-Восточный'],
  ['Северо-Запад', 'Северо-Западный'], ['СЗАО', 'Северо-Западный'], ['NORTHWEST', 'Северо-Западный'],
  ['Юго-Восток', 'Юго-Восточный'], ['ЮВАО', 'Юго-Восточный'], ['SOUTHEAST', 'Юго-Восточный'],
  ['Юго-Запад', 'Юго-Западный'], ['ЮЗАО', 'Юго-Западный'], ['SOUTHWEST', 'Юго-Западный'],
  ['Центр', 'Центральный'], ['ЦАО', 'Центральный'], ['CENTER', 'Центральный'],
  ['Зеленоград', 'Зеленоградский'], ['ЗелАО', 'Зеленоградский'], ['ZELENOGRAD', 'Зеленоградский'],
  ['Новомосковский', 'Новомосковский'], ['НАО', 'Новомосковский'], ['NEW_MOSCOW', 'Новомосковский'],
  ['Троицкий', 'Троицкий'], ['ТАО', 'Троицкий'], ['TROITSKY', 'Троицкий'],
]);

for (const [alias, expected] of aliasCases) {
  const resolved = zoneBoundaryName(alias);
  if (normalizeTerritoryKey(resolved) !== normalizeTerritoryKey(expected)) fail(`Псевдоним ${alias} определён неверно: ${resolved}`);
  if (!zoneByName.has(normalizeTerritoryKey(resolved))) fail(`Для ${alias} отсутствует локальная граница`);
}

for (const arbitrary of ['Югоцентр', 'Юг-Центр', 'Восток-1', 'Северный кластер']) {
  if (zoneBoundaryName(arbitrary)) fail(`Условная зона ${arbitrary} ошибочно получила административную границу`);
}

const pointTypeCases = [
  [{ name: 'Информация TEST-1', serviceType: 'Информация', priority: 'Обычная', equipment: 'Аварийный комплект' }, 'other'],
  [{ name: 'Конвергенция абонента TEST-2', serviceType: 'Конвергенция абонента', skill: 'Подключение', priority: 'Обычная', equipment: 'Аварийный комплект' }, 'connection'],
  [{ name: 'Нет линка TEST-3', serviceType: 'Нет линка', skill: 'Диагностика', priority: 'Обычная' }, 'service'],
  [{ name: 'Аварийное восстановление TEST-4', serviceType: 'Аварийное восстановление', priority: 'Авария' }, 'emergency'],
  [{ serviceType: 'Заявка на подключение', priority: 'Обычная' }, 'connection'],
  [{ serviceType: 'Заказ подключения/Дозаказ оборудования', priority: 'Обычная' }, 'connection'],
  [{ serviceType: 'Дозаказ оборудования', priority: 'Обычная' }, 'upgrade'],
  [{ serviceType: 'Переключение на Гбит/с', workType: 'Подключение', priority: 'Обычная' }, 'connection'],
  [{ serviceType: 'Работа с кабелем', priority: 'Обычная' }, 'service'],
  [{ serviceType: 'IP-адрес 169...', priority: 'Обычная' }, 'service'],
  [{ serviceType: 'Разрывы', priority: 'Обычная' }, 'service'],
  [{ serviceType: 'Рост ошибок на порту', priority: 'Обычная' }, 'service'],
  [{ serviceType: 'Роутер. Замена техническим специалистом', priority: 'Обычная' }, 'upgrade'],
  [{ serviceType: 'Низкая скорость', priority: 'Обычная' }, 'service'],
  [{ serviceType: 'TVE/ENT. Замена приставки техником', priority: 'Обычная' }, 'upgrade'],
  [{ serviceType: 'ТВ. Замена приставки техником', priority: 'Обычная' }, 'upgrade'],
  [{ serviceType: 'TVE/ENT. Другие ошибки', priority: 'Обычная' }, 'service'],
  [{ serviceType: 'Мониторинг', priority: 'Обычная' }, 'service'],
];
for (const [order, expected] of pointTypeCases) {
  const actual = workPointType(order);
  if (actual !== expected) fail(`${order.name}: ожидался тип ${expected}, получен ${actual}`);
}
if (translateServiceLabel('Нет линка') !== 'Нет связи') fail('Не переведено обозначение «Нет линка»');
if (translateServiceLabel('Информация') !== 'Информационная заявка') fail('Не переведено обозначение «Информация»');

console.log(`PASS: ${zones.length} административных округов`);
console.log(`PASS: ${districts.length} районов/поселений/городских округов`);
console.log(`PASS: ${jobs.length} точек находятся внутри района и административного округа`);
console.log(`PASS: ${aliasCases.size} вариантов названий округов`);
console.log('PASS: условные зоны не получают ложный полигон');
console.log('PASS: красный цвет зарезервирован для аварий');
