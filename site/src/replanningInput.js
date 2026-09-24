import { normalizePlanningPriority } from './planningPriority.js';

const normalizeHeader = value => String(value || '')
  .trim()
  .toLocaleLowerCase('ru-RU')
  .replace(/ё/g, 'е')
  .replace(/[^a-zа-я0-9]+/g, ' ')
  .trim();

const HEADER_ALIASES = {
  externalId: ['id', 'job id', 'order id', 'external id', 'номер', 'номер заявки', 'заявка'],
  name: ['name', 'client', 'customer', 'customer name', 'имя', 'клиент', 'объект', 'клиент объект'],
  address: ['address', 'адрес', 'адрес клиента'],
  zone: ['zone', 'zone name', 'region', 'cluster', 'зона', 'участок', 'регион'],
  skill: ['skill', 'required skill', 'work type', 'навык', 'тип работ', 'вид работ'],
  start: ['start', 'window start', 'time window start', 'начало', 'начало окна', 'окно с'],
  end: ['end', 'window end', 'time window end', 'конец', 'конец окна', 'окно до'],
  duration: ['duration', 'duration min', 'service duration min', 'длительность', 'длительность мин'],
  priority: ['priority', 'приоритет'],
  requiredTransport: ['required transport', 'transport', 'тип транспорта', 'транспорт'],
  eventTime: ['event time', 'incident time', 'created at', 'время события', 'время инцидента'],
  latitude: ['latitude', 'lat', 'широта'],
  longitude: ['longitude', 'lon', 'lng', 'долгота'],
};

const timeValue = value => {
  const match = String(value || '').match(/(?:^|T|\s)(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
};

const skillValue = value => {
  const normalized = normalizeHeader(value);
  if (/emergency|авар/.test(normalized)) return 'EMERGENCY';
  if (/install|connect|подключ|монтаж/.test(normalized)) return 'INSTALL';
  if (/upsell|дозаказ/.test(normalized)) return 'UPSELL';
  if (/local|локал|ремонт|диагност/.test(normalized)) return 'LOCAL';
  return 'INSTALL';
};

const priorityValue = value => {
  const code = normalizePlanningPriority(value);
  if (!code) throw new Error(`Неизвестный приоритет заявки: ${value}`);
  return code === 'URGENT' ? 'Срочная' : 'Обычная';
};

const transportValue = value => {
  const normalized = normalizeHeader(value);
  const aliases = {
    '': 'ANY', any: 'ANY', car: 'CAR', auto: 'CAR', автомобиль: 'CAR',
    public_transit: 'PUBLIC_TRANSIT', 'public transit': 'PUBLIC_TRANSIT', 'общественный транспорт': 'PUBLIC_TRANSIT',
    bicycle: 'BICYCLE', bike: 'BICYCLE', велосипед: 'BICYCLE',
    walking: 'WALKING', foot: 'WALKING', пешком: 'WALKING',
  };
  const mode = aliases[normalized];
  if (!mode) throw new Error(`Неизвестное требование к транспорту: ${value}`);
  return mode;
};

const parseMatrix = text => {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  const delimiter = [';', '\t', ','].sort((left, right) => firstLine.split(right).length - firstLine.split(left).length)[0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"' && quoted && next === '"') { cell += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
};

/** Parse one or more replanning requests from a CSV file without requiring coordinates. */
export function parseReplanningCsv(text, lockedZone = '') {
  const matrix = parseMatrix(text);
  if (matrix.length < 2) throw new Error('В CSV нужны строка заголовков и хотя бы одна заявка.');
  const headers = matrix[0].map(normalizeHeader);
  const indexByField = Object.fromEntries(Object.entries(HEADER_ALIASES).map(([field, aliases]) => [field, headers.findIndex(header => aliases.includes(header))]));
  if (indexByField.address < 0) throw new Error('В CSV нет колонки «Адрес».');
  const valueFor = (row, field) => indexByField[field] >= 0 ? String(row[indexByField[field]] || '').trim() : '';
  const requests = matrix.slice(1).filter(row => row.some(Boolean)).map((row, index) => {
    const latitude = Number(valueFor(row, 'latitude').replace(',', '.'));
    const longitude = Number(valueFor(row, 'longitude').replace(',', '.'));
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0;
    return {
      externalId: valueFor(row, 'externalId') || `CSV-${index + 1}`,
      name: valueFor(row, 'name'),
      address: valueFor(row, 'address'),
      zone: lockedZone || valueFor(row, 'zone'),
      skill: skillValue(valueFor(row, 'skill')),
      start: timeValue(valueFor(row, 'start')) || '09:00',
      end: timeValue(valueFor(row, 'end')) || '11:00',
      duration: String(Math.max(1, Number(valueFor(row, 'duration')) || 60)),
      priority: priorityValue(valueFor(row, 'priority')),
      requiredTransport: transportValue(valueFor(row, 'requiredTransport')),
      eventTime: timeValue(valueFor(row, 'eventTime')),
      latitude: hasCoordinates ? String(latitude) : '',
      longitude: hasCoordinates ? String(longitude) : '',
    };
  }).filter(item => item.address);
  if (!requests.length) throw new Error('В CSV нет заявок с адресом.');
  return requests;
}
