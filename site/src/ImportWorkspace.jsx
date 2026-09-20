import { useEffect, useMemo, useRef, useState } from 'react';
import { translateServiceLabel } from './workTypes.js';
import {
  AlertTriangle, Check, ChevronDown, FileSpreadsheet,
  Info, Plus, Search, ShieldCheck, X,
} from 'lucide-react';
import { useDropdownPresence } from './useDropdownPresence.js';

const ORDER_FIELD_GROUPS = [
  {
    id: 'identity',
    label: 'Идентификация',
    fields: [
      ['id', 'ID заявки', true],
      ['externalId', 'Внешний ID', false],
      ['name', 'Имя клиента / объект', false],
      ['scenario', 'Сценарий', false],
    ],
  },
  {
    id: 'location',
    label: 'Местоположение',
    fields: [
      ['address', 'Адрес', false],
      ['district', 'Район', false],
      ['latitude', 'Широта', false],
      ['longitude', 'Долгота', false],
      ['zone', 'Зона / участок', false],
      ['zoneId', 'ID зоны', false],
      ['zoneName', 'Название зоны', false],
    ],
  },
  {
    id: 'planning',
    label: 'Параметры заявки',
    fields: [
      ['windowStart', 'Начало окна', true],
      ['windowEnd', 'Конец окна', true],
      ['duration', 'Норматив, мин', true],
      ['workType', 'Тип работ', false],
      ['serviceType', 'Подтип / операция', false],
      ['skill', 'Требуемый навык', false],
      ['priority', 'Приоритет', false],
      ['status', 'Статус', false],
      ['connectionType', 'Тип подключения', false],
      ['isEventJob', 'Событийная заявка', false],
    ],
  },
  {
    id: 'resources',
    label: 'Ресурсы',
    fields: [
      ['transport', 'Транспорт', false],
      ['equipment', 'Оборудование', false],
      ['gigabitRequired', 'Требуется гигабит', false],
    ],
  },
  {
    id: 'contacts',
    label: 'Контакты',
    fields: [
      ['phone', 'Телефон', false],
      ['email', 'Email', false],
    ],
  },
  {
    id: 'additional',
    label: 'Дополнительно',
    fields: [
      ['createdAt', 'Дата создания', false],
      ['geocodeStatus', 'Статус геокодирования', false],
      ['notes', 'Комментарий', false],
      ['ignore', 'Не импортировать', false],
    ],
  },
];

const ENGINEER_FIELD_GROUPS = [
  {
    id: 'identity',
    label: 'Инженер',
    fields: [
      ['engineerId', 'ID инженера', true],
      ['engineerName', 'Имя инженера', true],
      ['engineerStatus', 'Статус', false],
    ],
  },
  {
    id: 'schedule',
    label: 'Смена и навыки',
    fields: [
      ['engineerSkills', 'Навыки', true],
      ['engineerShiftStart', 'Начало смены', true],
      ['engineerShiftEnd', 'Конец смены', true],
    ],
  },
  {
    id: 'resources',
    label: 'Ресурсы',
    fields: [
      ['engineerTransport', 'Транспорт', true],
      ['engineerEquipment', 'Оборудование', false],
    ],
  },
  {
    id: 'location',
    label: 'Точка старта',
    fields: [
      ['engineerStartAddress', 'Адрес старта', false],
      ['engineerStartLatitude', 'Широта старта', false],
      ['engineerStartLongitude', 'Долгота старта', false],
      ['engineerZone', 'Зона / участок', false],
    ],
  },
  {
    id: 'additional',
    label: 'Дополнительно',
    fields: [
      ['engineerPhone', 'Телефон', false],
      ['engineerEmail', 'Email', false],
      ['ignore', 'Не импортировать', false],
    ],
  },
];

const ORDER_FIELD_META = new Map(
  ORDER_FIELD_GROUPS.flatMap(group => group.fields.map(([id, label, required]) => [id, {
    id, label, required, groupId: group.id, groupLabel: group.label,
  }])),
);

const ENGINEER_FIELD_META = new Map(
  ENGINEER_FIELD_GROUPS.flatMap(group => group.fields.map(([id, label, required]) => [id, {
    id, label, required, groupId: group.id, groupLabel: group.label,
  }])),
);

const ORDER_ALIASES = {
  id: ['job id', 'order id', 'request id', 'id', 'ид заявки', 'номер заявки', 'идентификатор'],
  externalId: ['source job id', 'external id', 'source id', 'внешний id', 'исходный id'],
  name: ['customer name', 'client name', 'name', 'имя клиента', 'клиент', 'наименование'],
  scenario: ['scenario', 'сценарий'],
  address: ['address', 'адрес'],
  district: ['district', 'район'],
  latitude: ['latitude', 'lat', 'широта'],
  longitude: ['longitude', 'lon', 'lng', 'долгота'],
  zone: ['zone', 'зона', 'участок'],
  zoneId: ['zone id', 'id зоны', 'код зоны'],
  zoneName: ['zone name', 'название зоны'],
  windowStart: ['window start', 'time window start', 'start', 'начало окна', 'окно с'],
  windowEnd: ['window end', 'time window end', 'end', 'конец окна', 'окно до'],
  duration: ['service duration min', 'duration', 'длительность', 'норматив', 'норматив мин'],
  workType: ['bk type', 'work type', 'тип работ', 'тип заявки'],
  serviceType: ['hd type', 'service type', 'подтип работ', 'операция'],
  skill: ['required skill', 'skill', 'требуемый навык', 'навык'],
  priority: ['priority', 'приоритет'],
  status: ['status', 'статус'],
  connectionType: ['connection type', 'тип подключения'],
  isEventJob: ['is event job', 'event job', 'событийная заявка'],
  transport: ['required transport', 'transport', 'transport type', 'транспорт'],
  equipment: ['required equipment', 'equipment', 'equipment codes', 'оборудование'],
  gigabitRequired: ['gigabit required', 'требуется гигабит', 'гигабит'],
  phone: ['phone', 'telephone', 'телефон'],
  email: ['email', 'e mail', 'почта'],
  createdAt: ['created at', 'creation date', 'дата создания'],
  geocodeStatus: ['geocode status', 'статус геокодирования'],
  notes: ['notes', 'note', 'comment', 'description', 'комментарий', 'примечание'],
};

const ENGINEER_ALIASES = {
  engineerId: ['engineer id', 'engineer_id', 'employee id', 'employee_id', 'technician id', 'worker id', 'id', 'ид инженера', 'табельный номер'],
  engineerName: ['engineer name', 'engineer_name', 'employee name', 'employee_name', 'technician name', 'worker name', 'name', 'фио', 'имя инженера', 'инженер'],
  engineerSkills: ['skills', 'skill', 'engineer skills', 'required skills', 'competencies', 'навыки', 'навык', 'компетенции'],
  engineerShiftStart: ['shift start', 'shift_start', 'work start', 'work_start', 'start time', 'начало смены', 'смена с'],
  engineerShiftEnd: ['shift end', 'shift_end', 'work end', 'work_end', 'end time', 'конец смены', 'смена до'],
  engineerTransport: ['transport', 'transport type', 'vehicle', 'vehicle type', 'транспорт', 'тип транспорта'],
  engineerEquipment: ['equipment', 'equipment codes', 'tools', 'оборудование', 'инструменты'],
  engineerStartAddress: ['start address', 'start_address', 'base address', 'base_address', 'depot', 'office', 'адрес старта', 'база', 'офис'],
  engineerStartLatitude: ['start latitude', 'start_latitude', 'latitude', 'lat', 'широта старта', 'широта'],
  engineerStartLongitude: ['start longitude', 'start_longitude', 'longitude', 'lon', 'lng', 'долгота старта', 'долгота'],
  engineerZone: ['zone', 'zone name', 'district', 'region', 'зона', 'участок', 'район', 'регион'],
  engineerStatus: ['status', 'availability', 'статус', 'доступность'],
  engineerPhone: ['phone', 'telephone', 'телефон'],
  engineerEmail: ['email', 'e mail', 'почта'],
};

const FIELD_CONFIG = {
  orders: { groups: ORDER_FIELD_GROUPS, meta: ORDER_FIELD_META, aliases: ORDER_ALIASES },
  engineers: { groups: ENGINEER_FIELD_GROUPS, meta: ENGINEER_FIELD_META, aliases: ENGINEER_ALIASES },
};

const normalize = value => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[_./\\-]+/g, ' ')
  .replace(/\s+/g, ' ');

const autoMapHeaders = (headers, entityType = 'orders') => {
  const aliasesByField = FIELD_CONFIG[entityType]?.aliases || ORDER_ALIASES;
  const used = new Set();
  return Object.fromEntries(headers.map((header, index) => {
    const normalized = normalize(header);
    const match = Object.entries(aliasesByField).find(([field, aliases]) => !used.has(field) && aliases.map(normalize).includes(normalized));
    if (match) used.add(match[0]);
    return [index, match?.[0] || ''];
  }));
};

const asNumber = value => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
};

const asTime = value => {
  const text = String(value ?? '').trim();
  const iso = text.match(/T(\d{2}:\d{2})/);
  const simple = text.match(/^(\d{1,2}):(\d{2})/);
  if (iso) return iso[1];
  if (simple) return `${simple[1].padStart(2, '0')}:${simple[2]}`;
  return '';
};

const translatePriority = value => {
  const text = normalize(value);
  if (/urgent|emergency|critical|авар/.test(text)) return 'Авария';
  if (/high|высок/.test(text)) return 'Высокий';
  return 'Обычная';
};

const translateSkill = (skill, workType) => {
  const text = normalize(skill || workType);
  if (/emerg|авар/.test(text)) return 'Аварийные работы';
  if (/install|подключ/.test(text)) return 'Подключение';
  if (/local|локал/.test(text)) return 'Локальные работы';
  if (/дозаказ/.test(text)) return 'Дозаказ';
  return String(workType || skill || 'Локальные работы');
};

const translateEquipment = value => {
  const text = normalize(value);
  if (!text || text === 'any' || text === 'нет') return '';
  if (/emergency|diag set|авар/.test(text)) return 'Аварийный комплект';
  if (/ont|router|роутер|install set|cable pack/.test(text)) return 'Роутер';
  return String(value).split('|')[0];
};

const groupClass = (fieldId, entityType = 'orders') => {
  if (!fieldId) return '';
  if (fieldId.startsWith('custom:')) return 'Своё поле';
  return FIELD_CONFIG[entityType]?.meta.get(fieldId)?.groupLabel || '';
};

const fieldLabel = (fieldId, entityType = 'orders') => {
  if (!fieldId) return 'Выбрать поле';
  if (fieldId.startsWith('custom:')) return fieldId.slice(7);
  return FIELD_CONFIG[entityType]?.meta.get(fieldId)?.label || fieldId;
};

const jsonCellValue = value => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(item => (
    item && typeof item === 'object' ? JSON.stringify(item) : String(item)
  )).join(' | ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const JSON_COLLECTION_KEYS = {
  orders: ['jobs', 'orders', 'requests', 'заявки'],
  engineers: ['engineers', 'technicians', 'workers', 'resources', 'инженеры', 'исполнители'],
};

const jsonCollection = (payload, entityType, allowArray = false) => {
  if (Array.isArray(payload)) return allowArray ? { records: payload, collectionName: 'JSON' } : null;
  if (!payload || typeof payload !== 'object') return null;
  const keys = JSON_COLLECTION_KEYS[entityType];
  const candidates = keys.flatMap(key => [
    [key, payload[key]],
    [`data.${key}`, payload.data?.[key]],
  ]);
  const match = candidates.find(([, value]) => Array.isArray(value));
  return match ? { records: match[1], collectionName: match[0] } : null;
};

const recordsToDataset = (source, fileName, sourceFormat) => {
  const records = source.records.filter(record => record && typeof record === 'object' && !Array.isArray(record));
  if (!records.length) return null;
  const headers = [...new Set(records.flatMap(record => Object.keys(record)))];
  if (!headers.length) return null;
  return {
    headers,
    rows: records.map(record => headers.map(header => jsonCellValue(record[header]))),
    sheetName: source.collectionName,
    fileName,
    sourceFormat,
  };
};

const matrixToDataset = (matrix, sheetName, fileName, sourceFormat, entityType) => {
  if (matrix.length < 2) return null;
  const headers = matrix[0].map((value, index) => String(value || `Столбец ${index + 1}`).trim());
  const rows = matrix.slice(1).filter(row => row.some(value => String(value).trim())).map(row => (
    headers.map((_, index) => String(row[index] ?? ''))
  ));
  if (!rows.length) return null;
  return { headers, rows, sheetName, fileName, sourceFormat, entityType };
};

const sheetEntityType = sheetName => {
  const name = normalize(sheetName);
  if (/инжен|исполн|engineer|technician|worker|resource/.test(name)) return 'engineers';
  if (/заяв|заказ|job|order|request/.test(name)) return 'orders';
  return '';
};

const detectSuggestedRegion = (headers, rows) => {
  const searchableHeaders = new Set(['address', 'start address', 'base address', 'city', 'region', 'district', 'zone name', 'адрес', 'адрес старта', 'город', 'регион', 'район', 'зона']);
  const locationColumns = headers.map((header, index) => searchableHeaders.has(normalize(header)) ? index : -1).filter(index => index >= 0);
  const locationSample = normalize(rows.slice(0, 100).flatMap(row => locationColumns.map(index => row[index])).join(' '));
  return /москва|moscow/.test(locationSample) ? 'moscow' : '';
};

export async function parseImportFile(file, preferredEntityType = 'orders') {
  if (!file) throw new Error('Файл не выбран');
  if (file.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ. Разделите его на несколько файлов.');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['csv', 'json', 'xls', 'xlsx'].includes(extension)) throw new Error('Поддерживаются CSV, JSON, XLSX и XLS.');
  const datasets = {};
  if (extension === 'json') {
    let payload;
    try {
      payload = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
    } catch {
      throw new Error('JSON не удалось прочитать. Проверьте синтаксис файла.');
    }
    for (const entityType of ['orders', 'engineers']) {
      const source = jsonCollection(payload, entityType, entityType === preferredEntityType);
      const dataset = source ? recordsToDataset(source, file.name, 'json') : null;
      if (dataset) datasets[entityType] = { ...dataset, entityType };
    }
    if (!Object.keys(datasets).length) throw new Error('В JSON нужен массив заявок/инженеров или объект с массивами jobs и engineers.');
  } else {
    const module = await import('xlsx');
    const XLSX = module.default || module;
    // SheetJS interprets values such as "48/2" in CSV address columns as dates
    // unless raw mode is enabled. XLS/XLSX keep their normal formatted-cell path.
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false, raw: extension === 'csv' });
    for (const [sheetIndex, sheetName] of workbook.SheetNames.entries()) {
      const detectedType = sheetEntityType(sheetName);
      if (!detectedType && sheetIndex > 0) continue;
      const entityType = detectedType || preferredEntityType;
      if (datasets[entityType]) continue;
      const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1, defval: '', raw: false, blankrows: false,
      });
      const dataset = matrixToDataset(matrix, sheetName, file.name, extension, entityType);
      if (dataset) datasets[entityType] = dataset;
    }
    if (!Object.keys(datasets).length) throw new Error('В файле должны быть заголовки и хотя бы одна строка данных.');
  }
  const primary = datasets[preferredEntityType] || Object.values(datasets)[0];
  const locationDataset = datasets.orders || datasets.engineers || primary;
  return {
    ...primary,
    entityType: primary.entityType || preferredEntityType,
    datasets,
    fileName: file.name,
    suggestedRegionId: detectSuggestedRegion(locationDataset.headers, locationDataset.rows),
    sourceFormat: extension,
  };
}

function buildOrders(headers, rows, mappings, region) {
  const columnFor = fieldId => Number(Object.keys(mappings).find(key => mappings[key] === fieldId));
  const valueFor = (row, fieldId) => {
    const column = columnFor(fieldId);
    return Number.isInteger(column) ? String(row[column] ?? '').trim() : '';
  };
  return rows.map((row, index) => {
    const sourceId = valueFor(row, 'id') || valueFor(row, 'externalId') || String(index + 1);
    const workType = valueFor(row, 'workType');
    const serviceType = valueFor(row, 'serviceType');
    const serviceLabel = translateServiceLabel(serviceType);
    const skill = valueFor(row, 'skill');
    const lat = asNumber(valueFor(row, 'latitude'));
    const lon = asNumber(valueFor(row, 'longitude'));
    const customFields = {};
    Object.entries(mappings).forEach(([column, field]) => {
      if (field?.startsWith('custom:')) customFields[field.slice(7)] = row[Number(column)] ?? '';
    });
    return {
      id: index + 1,
      sourceId,
      name: valueFor(row, 'name') || `${serviceLabel || workType || 'Заявка'} ${sourceId}`,
      address: valueFor(row, 'address') || [valueFor(row, 'district'), valueFor(row, 'zoneName'), valueFor(row, 'zone')].filter(Boolean).join(', '),
      phone: valueFor(row, 'phone'),
      email: valueFor(row, 'email'),
      start: asTime(valueFor(row, 'windowStart')),
      end: asTime(valueFor(row, 'windowEnd')),
      duration: asNumber(valueFor(row, 'duration')) || 60,
      priority: translatePriority(valueFor(row, 'priority')),
      workType,
      skill: translateSkill(skill, workType || serviceType),
      equipment: translateEquipment(valueFor(row, 'equipment')),
      transport: valueFor(row, 'transport'),
      district: valueFor(row, 'district'),
      zone: valueFor(row, 'zoneName') || valueFor(row, 'zone'),
      zoneId: valueFor(row, 'zoneId'),
      serviceType,
      connectionType: valueFor(row, 'connectionType'),
      gigabitRequired: valueFor(row, 'gigabitRequired'),
      isEventJob: valueFor(row, 'isEventJob'),
      scenario: valueFor(row, 'scenario'),
      notes: valueFor(row, 'notes'),
      createdAt: valueFor(row, 'createdAt'),
      regionId: region.id,
      status: valueFor(row, 'status') || 'Новая',
      coords: lat !== null && lon !== null ? [lat, lon] : null,
      geocodeStatus: valueFor(row, 'geocodeStatus') || (lat !== null && lon !== null ? 'ready' : 'needs_geocoding'),
      customFields,
      sourceData: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ''])),
    };
  });
}

const splitList = value => String(value || '')
  .split(/\s*[|;,]\s*/)
  .map(item => item.trim())
  .filter(Boolean);

const translateEngineerSkill = value => {
  const text = normalize(value);
  if (/emerg|авар/.test(text)) return 'Аварийные работы';
  if (/install|connect|монтаж|подключ/.test(text)) return 'Подключение';
  if (/local|локал|ремонт|диагност/.test(text)) return 'Локальные работы';
  if (/upsell|additional|дозаказ/.test(text)) return 'Дозаказ';
  return String(value).trim();
};

const translateTransport = value => {
  const text = normalize(value);
  if (/public|transit|bus|обществен/.test(text)) return 'Общественный транспорт';
  if (/foot|walk|пеш/.test(text)) return 'Пешком';
  if (/bike|bicycle|вело/.test(text)) return 'Велосипед';
  if (/car|auto|авто/.test(text)) return 'Автомобиль';
  return String(value || 'Автомобиль').trim();
};

function buildEngineers(headers, rows, mappings, region) {
  const columnFor = fieldId => Number(Object.keys(mappings).find(key => mappings[key] === fieldId));
  const valueFor = (row, fieldId) => {
    const column = columnFor(fieldId);
    return Number.isInteger(column) ? String(row[column] ?? '').trim() : '';
  };
  return rows.map((row, index) => {
    const sourceId = valueFor(row, 'engineerId') || `engineer-${index + 1}`;
    const lat = asNumber(valueFor(row, 'engineerStartLatitude'));
    const lon = asNumber(valueFor(row, 'engineerStartLongitude'));
    const skills = [...new Set(splitList(valueFor(row, 'engineerSkills')).map(translateEngineerSkill))];
    const equipment = [...new Set(splitList(valueFor(row, 'engineerEquipment')).map(translateEquipment).filter(Boolean))];
    const customFields = {};
    Object.entries(mappings).forEach(([column, field]) => {
      if (field?.startsWith('custom:')) customFields[field.slice(7)] = row[Number(column)] ?? '';
    });
    return {
      id: String(sourceId),
      sourceId: String(sourceId),
      name: valueFor(row, 'engineerName') || `Инженер ${index + 1}`,
      regionId: region.id,
      skills,
      transport: translateTransport(valueFor(row, 'engineerTransport')),
      shiftStart: asTime(valueFor(row, 'engineerShiftStart')) || '08:00',
      shiftEnd: asTime(valueFor(row, 'engineerShiftEnd')) || '18:00',
      equipment,
      startAddress: valueFor(row, 'engineerStartAddress') || region.office,
      startCoords: lat !== null && lon !== null ? [lat, lon] : region.coords,
      zone: valueFor(row, 'engineerZone'),
      status: valueFor(row, 'engineerStatus') || 'Доступен сегодня',
      phone: valueFor(row, 'engineerPhone'),
      email: valueFor(row, 'engineerEmail'),
      load: 0,
      customFields,
      sourceData: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ''])),
    };
  });
}

function requirementState(mappings, entityType = 'orders') {
  const values = Object.values(mappings);
  if (entityType === 'engineers') return [
    { label: 'ID инженера', ok: values.includes('engineerId') },
    { label: 'Имя инженера', ok: values.includes('engineerName') },
    { label: 'Навыки', ok: values.includes('engineerSkills') },
    { label: 'Рабочая смена', ok: values.includes('engineerShiftStart') && values.includes('engineerShiftEnd') },
    { label: 'Транспорт', ok: values.includes('engineerTransport') },
  ];
  return [
    { label: 'ID заявки', ok: values.includes('id') || values.includes('externalId') },
    { label: 'Адрес или координаты', ok: values.includes('address') || (values.includes('latitude') && values.includes('longitude')) },
    { label: 'Окно обслуживания', ok: values.includes('windowStart') && values.includes('windowEnd') },
    { label: 'Норматив работ', ok: values.includes('duration') },
    { label: 'Тип работ или навык', ok: values.includes('workType') || values.includes('skill') },
  ];
}

function validateRows(rows, mappings, entityType = 'orders') {
  const invalid = new Set();
  const mappedColumn = field => Number(Object.keys(mappings).find(key => mappings[key] === field));
  const markBlank = (row, rowIndex, field) => {
    const column = mappedColumn(field);
    if (Number.isInteger(column) && !String(row[column] ?? '').trim()) invalid.add(`${rowIndex}:${column}`);
  };
  if (entityType === 'engineers') {
    const idColumn = mappedColumn('engineerId');
    const seenIds = new Map();
    rows.forEach((row, rowIndex) => {
      ['engineerId', 'engineerName', 'engineerSkills', 'engineerShiftStart', 'engineerShiftEnd', 'engineerTransport'].forEach(field => markBlank(row, rowIndex, field));
      const skillsColumn = mappedColumn('engineerSkills');
      if (Number.isInteger(skillsColumn) && splitList(row[skillsColumn]).length > 3) invalid.add(`${rowIndex}:${skillsColumn}`);
      const id = Number.isInteger(idColumn) ? normalize(row[idColumn]) : '';
      if (id) {
        if (seenIds.has(id)) {
          invalid.add(`${rowIndex}:${idColumn}`);
          invalid.add(`${seenIds.get(id)}:${idColumn}`);
        } else seenIds.set(id, rowIndex);
      }
      ['engineerShiftStart', 'engineerShiftEnd'].forEach(field => {
        const column = mappedColumn(field);
        if (Number.isInteger(column) && String(row[column] ?? '').trim() && !asTime(row[column])) invalid.add(`${rowIndex}:${column}`);
      });
    });
    return invalid;
  }
  rows.forEach((row, rowIndex) => {
    const hasId = ['id', 'externalId'].some(field => {
      const column = mappedColumn(field);
      return Number.isInteger(column) && String(row[column] ?? '').trim();
    });
    if (!hasId) ['id', 'externalId'].forEach(field => markBlank(row, rowIndex, field));
    const addressColumn = mappedColumn('address');
    const latColumn = mappedColumn('latitude');
    const lonColumn = mappedColumn('longitude');
    const hasAddress = Number.isInteger(addressColumn) && String(row[addressColumn] ?? '').trim();
    const hasCoords = Number.isInteger(latColumn) && Number.isInteger(lonColumn) && asNumber(row[latColumn]) !== null && asNumber(row[lonColumn]) !== null;
    if (!hasAddress && !hasCoords) [addressColumn, latColumn, lonColumn].filter(Number.isInteger).forEach(column => invalid.add(`${rowIndex}:${column}`));
    ['windowStart', 'windowEnd', 'duration'].forEach(field => markBlank(row, rowIndex, field));
    const durationColumn = mappedColumn('duration');
    if (Number.isInteger(durationColumn) && (asNumber(row[durationColumn]) ?? 0) <= 0) invalid.add(`${rowIndex}:${durationColumn}`);
  });
  return invalid;
}

function MappingMenu({ column, mappings, entityType, onSelect, onClose, position, visible }) {
  const [customName, setCustomName] = useState('');
  const current = mappings[column] || '';
  const used = new Set(Object.entries(mappings).filter(([key]) => Number(key) !== column).map(([, value]) => value));
  const fieldGroups = FIELD_CONFIG[entityType]?.groups || ORDER_FIELD_GROUPS;
  const addCustom = () => {
    const name = customName.trim();
    if (!name) return;
    onSelect(`custom:${name}`);
  };
  return <div className={`import-mapping-menu dropdown-transition ${visible ? 'is-open' : 'is-closing'}`} style={{ left: position.left, top: position.top }} role="listbox" aria-label="Тип данных столбца">
    <div className="mapping-menu-scroll">
      {fieldGroups.map(group => <section key={group.id}><h4>{group.label}</h4>{group.fields.map(([id, label, required]) => <button type="button" role="option" aria-selected={current === id} disabled={used.has(id) && id !== 'ignore'} className={current === id ? 'selected' : ''} key={id} onClick={() => onSelect(id)}><span>{label}{required ? <em>обязательно</em> : null}</span>{current === id ? <Check /> : null}</button>)}</section>)}
    </div>
    <div className="custom-field-create"><input value={customName} onChange={event => setCustomName(event.target.value)} onKeyDown={event => event.key === 'Enter' && addCustom()} placeholder="Своё поле"/><button type="button" onClick={addCustom} aria-label="Добавить своё поле"><Plus/></button></div>
    <button type="button" className="mapping-menu-close" onClick={onClose}><X/>Закрыть</button>
  </div>;
}

export function ImportWorkspace({ session, region, onCancel, onImport }) {
  const datasets = session.datasets || { [session.entityType || 'orders']: session };
  const availableTypes = ['orders', 'engineers'].filter(entityType => datasets[entityType]);
  const [activeType, setActiveType] = useState(() => (
    datasets[session.entityType] ? session.entityType : availableTypes[0]
  ));
  const [drafts, setDrafts] = useState(() => Object.fromEntries(availableTypes.map(entityType => [entityType, {
    rows: datasets[entityType].rows.map(row => [...row]),
    mappings: autoMapHeaders(datasets[entityType].headers, entityType),
    editedCells: new Set(),
  }])));
  const [menuColumn, setMenuColumn] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 24, top: 120 });
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [search, setSearch] = useState('');
  const tableRef = useRef(null);
  const mappingPresence = useDropdownPresence(menuOpen);
  const activeDataset = datasets[activeType];
  const activeDraft = drafts[activeType];
  const rows = activeDraft.rows;
  const mappings = activeDraft.mappings;
  const editedCells = activeDraft.editedCells;

  const requirements = useMemo(() => requirementState(mappings, activeType), [mappings, activeType]);
  const mappingReady = requirements.every(item => item.ok);
  const invalidCells = useMemo(() => validateRows(rows, mappings, activeType), [rows, mappings, activeType]);
  const rowIssueCount = useMemo(() => new Set([...invalidCells].map(key => key.split(':')[0])).size, [invalidCells]);
  const mappedCount = Object.values(mappings).filter(Boolean).length;
  const validationByType = useMemo(() => Object.fromEntries(availableTypes.map(entityType => {
    const draft = drafts[entityType];
    const typeRequirements = requirementState(draft.mappings, entityType);
    const typeInvalidCells = validateRows(draft.rows, draft.mappings, entityType);
    return [entityType, {
      ready: typeRequirements.every(item => item.ok) && typeInvalidCells.size === 0,
      rowIssueCount: new Set([...typeInvalidCells].map(key => key.split(':')[0])).size,
    }];
  })), [drafts, availableTypes.join('|')]);
  const allReady = availableTypes.every(entityType => validationByType[entityType].ready);
  const visibleRows = useMemo(() => {
    const query = normalize(search);
    if (!query) return rows.map((row, index) => ({ row, index }));
    return rows.map((row, index) => ({ row, index })).filter(({ row }) => normalize(row.join(' ')).includes(query));
  }, [rows, search]);
  const normalizedSearch = normalize(search);

  useEffect(() => {
    const close = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && (event.target.closest?.('.import-mapping-menu') || event.target.closest?.('.column-mapping-button'))) return;
      setMenuOpen(false);
    };
    if (!menuOpen) return undefined;
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  const openMapping = (column, event) => {
    if (menuOpen && menuColumn === column) {
      setMenuOpen(false);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const menuHeight = Math.min(610, window.innerHeight - 24);
    setMenuPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 402)),
      top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - menuHeight - 12)),
    });
    setMenuColumn(column);
    setMenuOpen(true);
  };

  const selectMapping = field => {
    setDrafts(current => {
      const nextMappings = { ...current[activeType].mappings };
      if (field !== 'ignore') Object.keys(nextMappings).forEach(key => { if (nextMappings[key] === field) nextMappings[key] = ''; });
      nextMappings[menuColumn] = field;
      return { ...current, [activeType]: { ...current[activeType], mappings: nextMappings } };
    });
    setMenuOpen(false);
  };

  const changeSearch = event => {
    setSearch(event.target.value);
    requestAnimationFrame(() => tableRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
  };

  const editCell = (rowIndex, columnIndex, value) => {
    setDrafts(current => {
      const draft = current[activeType];
      return { ...current, [activeType]: {
        ...draft,
        rows: draft.rows.map((row, index) => index === rowIndex ? row.map((cell, column) => column === columnIndex ? value : cell) : row),
        editedCells: new Set(draft.editedCells).add(`${rowIndex}:${columnIndex}`),
      } };
    });
  };

  const submit = () => {
    if (!allReady) return;
    onImport({
      orders: drafts.orders ? buildOrders(datasets.orders.headers, drafts.orders.rows, drafts.orders.mappings, region) : [],
      engineers: drafts.engineers ? buildEngineers(datasets.engineers.headers, drafts.engineers.rows, drafts.engineers.mappings, region) : [],
    });
  };

  const switchDataset = entityType => {
    setActiveType(entityType);
    setSearch('');
    setMenuOpen(false);
    requestAnimationFrame(() => tableRef.current?.scrollTo({ top: 0, left: 0, behavior: 'smooth' }));
  };

  const importButtonText = [
    drafts.orders ? `${drafts.orders.rows.length} заявок` : '',
    drafts.engineers ? `${drafts.engineers.rows.length} инженеров` : '',
  ].filter(Boolean).join(' и ');
  const entityLabel = activeType === 'engineers' ? 'инженеров' : 'заявок';
  const requirementHeading = activeType === 'engineers' ? 'Для команды' : 'Для планирования';

  return <div className="import-workspace" role="dialog" aria-modal="true" aria-label="Проверка и загрузка данных">
    <header className="import-header">
      <div className="import-title"><span><FileSpreadsheet/></span><div><h1>Проверка данных</h1><p>{session.fileName} · {rows.length} {entityLabel} · участок «{region.name}» · лист «{activeDataset.sheetName}»</p></div></div>
      {availableTypes.length > 1 ? <nav className="import-dataset-tabs" aria-label="Наборы данных">{availableTypes.map(entityType => <button type="button" key={entityType} className={activeType === entityType ? 'active' : ''} onClick={() => switchDataset(entityType)}><span>{entityType === 'orders' ? 'Заявки' : 'Инженеры'}</span><b>{drafts[entityType].rows.length}</b>{validationByType[entityType].ready ? <Check/> : <AlertTriangle/>}</button>)}</nav> : null}
      <button className="import-header-close" type="button" onClick={() => setCancelConfirm(true)} aria-label="Отменить загрузку"><X/></button>
    </header>

    <main className="import-main">
      <aside className="import-checklist">
        <div><h2>Что нужно проверить</h2><p>Укажите, что означает каждый столбец, и исправьте данные прямо в таблице.</p></div>
        <section className="requirements-list"><h3>{requirementHeading}</h3>{requirements.map(item => <div className={item.ok ? 'ok' : ''} key={item.label}>{item.ok ? <Check/> : <span/>}<b>{item.label}</b></div>)}</section>
        <section className="import-stats"><h3>Состояние файла</h3><div><span>Столбцы</span><b>{mappedCount} из {activeDataset.headers.length}</b></div><div><span>Исправлено ячеек</span><b>{editedCells.size}</b></div><div className={rowIssueCount ? 'warning' : ''}><span>Строки с ошибками</span><b>{rowIssueCount}</b></div></section>
        <div className="import-help"><Info/><p>Изменения применятся только после загрузки.</p></div>
      </aside>

      <section className="import-table-area">
        <div className="import-table-toolbar"><div><h2>Сопоставление и редактирование</h2><p>Выберите назначение столбцов и проверьте значения.</p></div><label><Search/><input value={search} onChange={changeSearch} placeholder="Найти в таблице"/><kbd aria-live="polite">{visibleRows.length}/{rows.length}</kbd>{search ? <button type="button" onClick={() => setSearch('')} aria-label="Очистить поиск"><X/></button> : null}</label></div>
        <div className="import-table-scroll" ref={tableRef} onScroll={() => setMenuOpen(false)}>
          <table className="import-grid">
            <thead><tr>{activeDataset.headers.map((header, column) => {
              const field = mappings[column];
              return <th key={`${header}-${column}`} className={!field ? 'unmapped' : ''}><button type="button" className="column-mapping-button" onClick={event => openMapping(column, event)} aria-expanded={menuOpen && menuColumn === column}><span><b>{fieldLabel(field, activeType)}</b><small>{groupClass(field, activeType) || 'Тип не выбран'}</small></span><ChevronDown/></button><em title={header}>{header}</em></th>;
            })}</tr></thead>
            <tbody>{visibleRows.length ? visibleRows.map(({ row, index }) => <tr key={index} className={[...invalidCells].some(key => key.startsWith(`${index}:`)) ? 'has-error' : ''}>{row.map((cell, column) => {
              const key = `${index}:${column}`;
              const matchesSearch = normalizedSearch && normalize(cell).includes(normalizedSearch);
              return <td key={column} className={`${invalidCells.has(key) ? 'invalid ' : ''}${editedCells.has(key) ? 'edited ' : ''}${matchesSearch ? 'search-match' : ''}`}><input value={cell} onChange={event => editCell(index, column, event.target.value)} aria-label={`Строка ${index + 1}, ${activeDataset.headers[column]}`}/>{invalidCells.has(key) ? <AlertTriangle/> : editedCells.has(key) ? <Check/> : null}</td>;
            })}</tr>) : <tr className="import-no-results"><td colSpan={activeDataset.headers.length}><Search/><b>Ничего не найдено</b><span>Попробуйте изменить запрос</span></td></tr>}</tbody>
          </table>
        </div>
      </section>
    </main>

    <footer className="import-footer"><div>{!mappingReady ? <><AlertTriangle/><span>Укажите все обязательные поля</span></> : invalidCells.size ? <><AlertTriangle/><span>Исправьте {rowIssueCount} {rowIssueCount === 1 ? 'строку' : 'строки'} с ошибками</span></> : !allReady ? <><AlertTriangle/><span>Проверьте вторую вкладку данных</span></> : <><ShieldCheck/><span>Все наборы проверены. Можно загружать.</span></>}</div><button type="button" onClick={() => setCancelConfirm(true)}>Отменить</button><button type="button" className="primary" disabled={!allReady} onClick={submit}><Check/>Загрузить {importButtonText}</button></footer>

    {mappingPresence.present && menuColumn !== null ? <MappingMenu column={menuColumn} mappings={mappings} entityType={activeType} onSelect={selectMapping} onClose={() => setMenuOpen(false)} position={menuPosition} visible={mappingPresence.visible}/> : null}
    {cancelConfirm ? <div className="import-confirm-backdrop"><section className="import-confirm" role="alertdialog" aria-modal="true" aria-labelledby="cancel-import-title"><span><AlertTriangle/></span><h2 id="cancel-import-title">Отменить загрузку?</h2><p>Сопоставление столбцов и все исправления в таблице будут потеряны.</p><footer><button type="button" onClick={() => setCancelConfirm(false)}>Вернуться к таблице</button><button type="button" className="danger-button" onClick={onCancel}>Да, отменить</button></footer></section></div> : null}
  </div>;
}
