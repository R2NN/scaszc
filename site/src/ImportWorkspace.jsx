import { useEffect, useMemo, useRef, useState } from 'react';
import { isInformationalOrder, translateServiceLabel } from './workTypes.js';
import {
  AlertTriangle, Check, ChevronDown, Filter,
  FilePlus2, Files, Info, Plus, Redo2, Search, ShieldCheck, Undo2, X,
} from 'lucide-react';
import { useDropdownPresence } from './useDropdownPresence.js';
import { regionForCity, resolveImportedCity } from './regions.js';
import { pushImportHistory, redoImportHistory, undoImportHistory } from './importHistory.js';
import { importedEquipmentRequirements, importedEquipmentTokens } from './importEquipment.js';
import { parseWorkNorms, workDurationFor, workNormFor } from './workNorms.js';
import { parseImportedDate } from './importDate.js';
import { territoryFromImportFile } from './importTerritory.js';

const ORDER_FIELD_GROUPS = [
  {
    id: 'identity',
    label: 'Идентификация',
    fields: [
      ['id', 'ID заявки', false],
      ['externalId', 'Внешний ID', false],
      ['customerId', 'ID клиента', false],
      ['objectId', 'ID объекта', false],
      ['contractNumber', 'Номер договора', false],
      ['accountNumber', 'Лицевой счёт', false],
      ['name', 'Имя клиента / объект', false],
      ['scenario', 'Сценарий', false],
    ],
  },
  {
    id: 'location',
    label: 'Местоположение',
    fields: [
      ['address', 'Адрес', false],
      ['locationId', 'ID адреса / локации', false],
      ['city', 'Город', false],
      ['region', 'Регион / область', false],
      ['district', 'Район', false],
      ['street', 'Улица', false],
      ['house', 'Дом', false],
      ['building', 'Корпус / строение', false],
      ['apartment', 'Квартира / помещение', false],
      ['postalCode', 'Почтовый индекс', false],
      ['entrance', 'Подъезд', false],
      ['floor', 'Этаж', false],
      ['latitude', 'Широта', false],
      ['longitude', 'Долгота', false],
      ['coordinateAccuracy', 'Точность координат', false],
      ['geocodeProvider', 'Источник геокодирования', false],
      ['geocodeObjectId', 'ID объекта геокодера', false],
      ['zone', 'Зона / участок', false],
      ['zoneId', 'ID зоны', false],
      ['zoneName', 'Название зоны', false],
    ],
  },
  {
    id: 'planning',
    label: 'Параметры заявки',
    fields: [
      ['windowStart', 'Начало окна', false],
      ['windowEnd', 'Конец окна', false],
      ['windowRange', 'Окно целиком', false],
      ['duration', 'Длительность из файла, мин', false],
      ['workType', 'Тип работ', false],
      ['serviceType', 'Подтип / операция', false],
      ['skill', 'Требуемый навык', false],
      ['priority', 'Приоритет', false],
      ['status', 'Статус', false],
      ['category', 'Категория', false],
      ['subcategory', 'Подкатегория', false],
      ['source', 'Источник заявки', false],
      ['channel', 'Канал обращения', false],
      ['slaMinutes', 'SLA, мин', false],
      ['requiredEngineers', 'Требуется исполнителей', false],
      ['preferredEngineerId', 'Предпочтительный инженер', false],
      ['teamId', 'ID бригады / команды', false],
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
      ['materialCode', 'Код материала', false],
      ['equipmentQuantity', 'Количество оборудования', false],
      ['gigabitRequired', 'Требуется гигабит', false],
    ],
  },
  {
    id: 'contacts',
    label: 'Контакты',
    fields: [
      ['phone', 'Телефон', false],
      ['email', 'Email', false],
      ['contactPerson', 'Контактное лицо', false],
    ],
  },
  {
    id: 'additional',
    label: 'Дополнительно',
    fields: [
      ['createdAt', 'Дата создания', false],
      ['serviceDate', 'Дата выполнения', false],
      ['completedAt', 'Дата завершения', false],
      ['geocodeStatus', 'Статус геокодирования', false],
      ['sourceSystem', 'Исходная система', false],
      ['tags', 'Метки', false],
      ['cancellationReason', 'Причина отмены', false],
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
      ['engineerPersonnelNumber', 'Табельный номер', false],
      ['engineerTeamId', 'ID бригады / команды', false],
      ['engineerRole', 'Роль', false],
      ['engineerStatus', 'Статус', false],
    ],
  },
  {
    id: 'schedule',
    label: 'Смена и навыки',
    fields: [
      ['engineerSkills', 'Навыки', true],
      ['engineerQualification', 'Квалификация', false],
      ['engineerSpecialization', 'Специализация', false],
      ['engineerShiftStart', 'Начало смены', true],
      ['engineerShiftEnd', 'Конец смены', true],
      ['engineerBreakMinutes', 'Перерыв, мин', false],
      ['engineerCapacityMinutes', 'Доступное время, мин', false],
      ['engineerMaxOrders', 'Максимум заявок', false],
    ],
  },
  {
    id: 'resources',
    label: 'Ресурсы',
    fields: [
      ['engineerTransport', 'Транспорт', true],
      ['engineerVehicleId', 'ID транспорта', false],
      ['engineerEquipment', 'Оборудование', false],
    ],
  },
  {
    id: 'location',
    label: 'Точка старта',
    fields: [
      ['engineerStartAddress', 'Адрес старта', false],
      ['engineerLocationId', 'ID стартовой локации', false],
      ['engineerCity', 'Город', false],
      ['engineerRegion', 'Регион / область', false],
      ['engineerDistrict', 'Район', false],
      ['engineerStartLatitude', 'Широта старта', false],
      ['engineerStartLongitude', 'Долгота старта', false],
      ['engineerZone', 'Зона / участок', false],
      ['engineerZoneId', 'ID зоны', false],
    ],
  },
  {
    id: 'additional',
    label: 'Дополнительно',
    fields: [
      ['engineerPhone', 'Телефон', false],
      ['engineerEmail', 'Email', false],
      ['engineerNotes', 'Комментарий', false],
      ['engineerSourceSystem', 'Исходная система', false],
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
  id: ['job id', 'order id', 'request id', 'ticket id', 'ticket number', 'ticket', 'request number', 'order number', 'incident id', 'crm id', 'id', 'ид заявки', 'номер заявки', '№ заявки', 'заявка', 'номер обращения', '№ обращения', 'номер заказа', '№ заказа', 'номер наряда', 'номер тикета', 'код заявки', 'код обращения', 'идентификатор', 'идентификатор обращения', 'номер', '№'],
  externalId: ['source job id', 'external id', 'source id', 'внешний id', 'исходный id'],
  customerId: ['customer id', 'client id', 'id клиента', 'ид клиента'],
  objectId: ['object id', 'site id', 'id объекта', 'ид объекта'],
  contractNumber: ['contract number', 'contract no', 'номер договора', 'договор'],
  accountNumber: ['account number', 'billing account', 'лицевой счет', 'лицевой счёт'],
  name: ['customer name', 'client name', 'name', 'имя клиента', 'клиент', 'наименование', 'название'],
  scenario: ['scenario', 'сценарий'],
  address: ['address', 'адрес'],
  locationId: ['location id', 'location_id', 'address id', 'id локации', 'id адреса'],
  city: ['city', 'locality', 'town', 'город', 'населенный пункт'],
  region: ['region', 'area', 'province', 'state', 'регион', 'область'],
  district: ['district', 'район'],
  street: ['street', 'street name', 'улица'],
  house: ['house', 'house number', 'building number', 'дом', 'номер дома'],
  building: ['building', 'block', 'structure', 'корпус', 'строение'],
  apartment: ['apartment', 'flat', 'office number', 'квартира', 'помещение', 'офис номер'],
  postalCode: ['postal code', 'zip', 'zip code', 'postcode', 'почтовый индекс', 'индекс'],
  entrance: ['entrance', 'подъезд'],
  floor: ['floor', 'этаж'],
  latitude: ['latitude', 'lat', 'широта'],
  longitude: ['longitude', 'lon', 'lng', 'долгота'],
  coordinateAccuracy: ['coordinate accuracy', 'coordinate_accuracy', 'accuracy', 'точность координат'],
  geocodeProvider: ['geocode provider', 'geocode_provider', 'geocoder', 'источник геокодирования'],
  geocodeObjectId: ['geocode object id', 'geocode_object_id', 'geocoder object id', 'id объекта геокодера'],
  zone: ['zone', 'зона', 'участок'],
  zoneId: ['zone id', 'id зоны', 'код зоны'],
  zoneName: ['zone name', 'название зоны'],
  windowStart: ['window start', 'time window start', 'appointment start', 'visit start', 'start time', 'start', 'начало', 'начало окна', 'начало интервала', 'время начала', 'время начала окна', 'окно с', 'время с', 'визит с', 'от', 'с'],
  windowEnd: ['window end', 'time window end', 'appointment end', 'visit end', 'end time', 'end', 'окончание', 'конец', 'конец окна', 'конец интервала', 'время окончания', 'время окончания окна', 'окно до', 'время до', 'визит до', 'до', 'по'],
  windowRange: ['time window', 'appointment window', 'visit window', 'окно заявки', 'окно обслуживания', 'интервал', 'время визита'],
  duration: ['service duration min', 'duration', 'длительность', 'норматив', 'норматив мин'],
  workType: ['bk type', 'work type', 'тип работ', 'тип заявки'],
  serviceType: ['hd type', 'service type', 'подтип работ', 'операция'],
  skill: ['required skill', 'skill', 'требуемый навык', 'навык'],
  priority: ['priority', 'приоритет'],
  status: ['status', 'статус'],
  category: ['category', 'категория'],
  subcategory: ['subcategory', 'sub category', 'подкатегория'],
  source: ['source', 'request source', 'order source', 'источник заявки'],
  channel: ['channel', 'request channel', 'канал обращения'],
  slaMinutes: ['sla min', 'sla minutes', 'sla_minutes', 'sla', 'срок sla'],
  requiredEngineers: ['required engineers', 'engineer count', 'required_engineers', 'количество исполнителей'],
  preferredEngineerId: ['preferred engineer id', 'preferred_engineer_id', 'предпочтительный инженер'],
  teamId: ['team id', 'brigade id', 'team_id', 'id бригады', 'id команды'],
  connectionType: ['connection type', 'тип подключения'],
  isEventJob: ['is event job', 'event job', 'событийная заявка'],
  transport: ['required transport', 'transport', 'transport type', 'транспорт'],
  equipment: ['required equipment', 'equipment', 'equipment codes', 'оборудование'],
  materialCode: ['material code', 'material_code', 'код материала'],
  equipmentQuantity: ['equipment quantity', 'equipment_quantity', 'количество оборудования'],
  gigabitRequired: ['gigabit required', 'требуется гигабит', 'гигабит'],
  phone: ['phone', 'telephone', 'телефон'],
  email: ['email', 'e mail', 'почта'],
  contactPerson: ['contact person', 'contact name', 'контактное лицо'],
  createdAt: ['created at', 'creation date', 'дата создания'],
  serviceDate: ['date', 'service date', 'work date', 'scheduled date', 'дата', 'дата выполнения', 'дата работ', 'день выполнения'],
  completedAt: ['completed at', 'completion date', 'дата завершения'],
  geocodeStatus: ['geocode status', 'статус геокодирования'],
  sourceSystem: ['source system', 'source_system', 'исходная система'],
  tags: ['tags', 'labels', 'метки', 'теги'],
  cancellationReason: ['cancellation reason', 'cancel reason', 'причина отмены'],
  notes: ['notes', 'note', 'comment', 'description', 'комментарий', 'примечание'],
};

const ENGINEER_ALIASES = {
  engineerId: ['engineer id', 'engineer_id', 'employee id', 'employee_id', 'technician id', 'worker id', 'id', 'ид инженера', 'табельный номер'],
  engineerName: ['engineer name', 'engineer_name', 'employee name', 'employee_name', 'technician name', 'worker name', 'name', 'фио', 'имя инженера', 'инженер'],
  engineerPersonnelNumber: ['personnel number', 'personnel_number', 'employee number', 'табельный номер'],
  engineerTeamId: ['team id', 'team_id', 'brigade id', 'id бригады', 'id команды'],
  engineerRole: ['role', 'position', 'должность', 'роль'],
  engineerSkills: ['skills', 'skill', 'engineer skills', 'required skills', 'competencies', 'навыки', 'навык', 'компетенции'],
  engineerQualification: ['qualification', 'grade', 'квалификация', 'разряд'],
  engineerSpecialization: ['specialization', 'speciality', 'специализация', 'специальность'],
  engineerShiftStart: ['shift start', 'shift_start', 'work start', 'work_start', 'start time', 'начало смены', 'смена с'],
  engineerShiftEnd: ['shift end', 'shift_end', 'work end', 'work_end', 'end time', 'конец смены', 'смена до'],
  engineerBreakMinutes: ['break minutes', 'break_minutes', 'перерыв мин'],
  engineerCapacityMinutes: ['capacity minutes', 'capacity_minutes', 'доступное время мин'],
  engineerMaxOrders: ['max orders', 'max_orders', 'максимум заявок'],
  engineerTransport: ['transport', 'transport type', 'vehicle', 'vehicle type', 'транспорт', 'тип транспорта'],
  engineerVehicleId: ['vehicle id', 'vehicle_id', 'car id', 'id транспорта'],
  engineerEquipment: ['equipment', 'equipment codes', 'tools', 'оборудование', 'инструменты'],
  engineerStartAddress: ['start address', 'start_address', 'base address', 'base_address', 'depot', 'office', 'адрес старта', 'база', 'офис'],
  engineerLocationId: ['location id', 'location_id', 'start location id', 'id стартовой локации'],
  engineerCity: ['city', 'locality', 'town', 'start city', 'base city', 'город', 'город старта'],
  engineerRegion: ['region', 'area', 'province', 'регион', 'область'],
  engineerDistrict: ['district', 'район'],
  engineerStartLatitude: ['start latitude', 'start_latitude', 'latitude', 'lat', 'широта старта', 'широта'],
  engineerStartLongitude: ['start longitude', 'start_longitude', 'longitude', 'lon', 'lng', 'долгота старта', 'долгота'],
  engineerZone: ['zone', 'zone name', 'district', 'region', 'зона', 'участок', 'район', 'регион'],
  engineerZoneId: ['zone id', 'zone_id', 'id зоны'],
  engineerStatus: ['status', 'availability', 'статус', 'доступность'],
  engineerPhone: ['phone', 'telephone', 'телефон'],
  engineerEmail: ['email', 'e mail', 'почта'],
  engineerNotes: ['notes', 'comment', 'комментарий', 'примечание'],
  engineerSourceSystem: ['source system', 'source_system', 'исходная система'],
};

const FIELD_CONFIG = {
  orders: { groups: ORDER_FIELD_GROUPS, meta: ORDER_FIELD_META, aliases: ORDER_ALIASES },
  engineers: { groups: ENGINEER_FIELD_GROUPS, meta: ENGINEER_FIELD_META, aliases: ENGINEER_ALIASES },
};

const FIELD_VALUE_TYPES = {
  id: ['text', 'number'], externalId: ['text', 'number'], customerId: ['text', 'number'], objectId: ['text', 'number'],
  contractNumber: ['text', 'number'], accountNumber: ['text', 'number'], name: ['text'], scenario: ['text'],
  address: ['text'], locationId: ['text', 'number'], city: ['text'], region: ['text'], district: ['text'],
  street: ['text'], house: ['text', 'number'], building: ['text', 'number'], apartment: ['text', 'number'],
  postalCode: ['text', 'number'], entrance: ['text', 'number'], floor: ['text', 'number'], latitude: ['number'], longitude: ['number'],
  coordinateAccuracy: ['text', 'number'], geocodeProvider: ['text'], geocodeObjectId: ['text', 'number'],
  zone: ['text'], zoneId: ['text', 'number'], zoneName: ['text'], windowStart: ['time', 'date'], windowEnd: ['time', 'date'], windowRange: ['text', 'time'],
  duration: ['number'], workType: ['text'], serviceType: ['text'], skill: ['text', 'list'], priority: ['text', 'number'], status: ['text'],
  category: ['text'], subcategory: ['text'], source: ['text'], channel: ['text'], slaMinutes: ['number'], requiredEngineers: ['number'],
  preferredEngineerId: ['text', 'number'], teamId: ['text', 'number'], connectionType: ['text'], isEventJob: ['boolean', 'number', 'text'],
  transport: ['text'], equipment: ['text', 'list'], materialCode: ['text', 'number'], equipmentQuantity: ['number'],
  gigabitRequired: ['boolean', 'number', 'text'], phone: ['phone', 'text', 'number'], email: ['email', 'text'], contactPerson: ['text'],
  createdAt: ['date', 'time', 'number'], serviceDate: ['date', 'time', 'number'], completedAt: ['date', 'time', 'number'],
  geocodeStatus: ['text'], sourceSystem: ['text'], tags: ['text', 'list'], cancellationReason: ['text'], notes: ['text'],
  engineerId: ['text', 'number'], engineerName: ['text'], engineerPersonnelNumber: ['text', 'number'], engineerTeamId: ['text', 'number'],
  engineerRole: ['text'], engineerStatus: ['text'], engineerSkills: ['text', 'list'], engineerQualification: ['text', 'number'],
  engineerSpecialization: ['text'], engineerShiftStart: ['time', 'date'], engineerShiftEnd: ['time', 'date'],
  engineerBreakMinutes: ['number'], engineerCapacityMinutes: ['number'], engineerMaxOrders: ['number'],
  engineerTransport: ['text'], engineerVehicleId: ['text', 'number'], engineerEquipment: ['text', 'list'],
  engineerStartAddress: ['text'], engineerLocationId: ['text', 'number'], engineerCity: ['text'], engineerRegion: ['text'],
  engineerDistrict: ['text'], engineerStartLatitude: ['number'], engineerStartLongitude: ['number'], engineerZone: ['text'],
  engineerZoneId: ['text', 'number'], engineerPhone: ['phone', 'text', 'number'], engineerEmail: ['email', 'text'],
  engineerNotes: ['text'], engineerSourceSystem: ['text'], ignore: ['any'],
};

const COLUMN_TYPE_LABELS = {
  unknown: 'Тип не определён',
  text: 'Текст',
  number: 'Число',
  boolean: 'Да / нет',
  time: 'Время',
  date: 'Дата',
  email: 'Email',
  phone: 'Телефон',
  list: 'Список значений',
};

const normalize = value => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[_./\\-]+/g, ' ')
  .replace(/\s+/g, ' ');

const countNoun = (count, one, few, many) => {
  const remainder = count % 10;
  return count % 100 >= 11 && count % 100 <= 14 ? many : remainder === 1 ? one : remainder >= 2 && remainder <= 4 ? few : many;
};
const countLabel = (count, one, few, many) => `${count} ${countNoun(count, one, few, many)}`;

export const autoMapHeaders = (headers, entityType = 'orders') => {
  const aliasesByField = FIELD_CONFIG[entityType]?.aliases || ORDER_ALIASES;
  const used = new Set();
  const exactOnly = new Set(['номер', 'ticket']);
  return Object.fromEntries(headers.map((header, index) => {
    const normalized = normalize(header);
    const matches = Object.entries(aliasesByField).filter(([field]) => !used.has(field)).map(([field, aliases]) => {
      const normalizedAliases = aliases.map(normalize);
      const exact = normalizedAliases.includes(normalized);
      const fuzzyLength = normalizedAliases.reduce((best, alias) => {
        if (alias.length < 4 || normalized.length < 4 || exactOnly.has(alias)) return best;
        return normalized.includes(alias) || alias.includes(normalized) ? Math.max(best, Math.min(alias.length, normalized.length)) : best;
      }, 0);
      return { field, score: exact ? 1000 : fuzzyLength };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    const match = matches[0];
    if (match) used.add(match.field);
    const fallbackName = String(header || `Столбец ${index + 1}`).trim();
    return [index, match?.field || `custom:${fallbackName}`];
  }));
};

const mappedValue = (row, mappings, field) => {
  const column = Object.keys(mappings).find(key => mappings[key] === field);
  return column === undefined ? '' : String(row[Number(column)] ?? '').trim();
};

const mappedWork = (row, mappings) => ({
  workType: mappedValue(row, mappings, 'workType'),
  serviceType: mappedValue(row, mappings, 'serviceType'),
  skill: mappedValue(row, mappings, 'skill'),
  name: mappedValue(row, mappings, 'name'),
});

/** Add an editable planned duration while keeping any incoming duration visible for audit. */
export function withWorkNormDefaults(dataset, norms) {
  const mappings = { ...(dataset.savedMappings || autoMapHeaders(dataset.headers, 'orders')) };
  const sourceDuration = Object.keys(mappings).find(key => mappings[key] === 'duration');
  const headers = [...dataset.headers];
  if (sourceDuration !== undefined) {
    headers[Number(sourceDuration)] = `Исходная длительность: ${headers[Number(sourceDuration)]}`;
    mappings[sourceDuration] = `custom:${headers[Number(sourceDuration)]}`;
  }
  const durationColumn = headers.length;
  headers.push('Норматив, мин');
  mappings[durationColumn] = 'duration';
  return {
    ...dataset,
    headers,
    rows: dataset.rows.map(row => {
      const norm = workNormFor(mappedWork(row, mappings), norms);
      return [...row, String(norm?.serviceMinutes ?? 60)];
    }),
    savedMappings: mappings,
  };
}

/** List rows whose work type has no entry in the configured norms. */
export function unmatchedWorkNorms(rows, mappings, norms) {
  if (!norms) return [];
  return rows.flatMap((row, index) => {
    const work = mappedWork(row, mappings);
    if (workNormFor(work, norms)) return [];
    return [{ index, type: work.workType || work.serviceType || work.skill || work.name || 'Вид работ не указан',
      duration: mappedValue(row, mappings, 'duration') }];
  });
}

const asNumber = value => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
};

const asTime = value => {
  const text = String(value ?? '').trim();
  const excelFraction = Number(text.replace(',', '.'));
  if (/^0[.,]\d+$/.test(text) && excelFraction >= 0 && excelFraction < 1) {
    const minutes = Math.round(excelFraction * 24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const dated = parseImportedDate(text);
  const dateTime = dated && text.match(/(?:T|\s+)([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,3})?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?$/i);
  const simple = text.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)(?::[0-5]\d)?$/);
  if (dateTime) return `${dateTime[1].padStart(2, '0')}:${dateTime[2]}`;
  if (simple) return `${simple[1].padStart(2, '0')}:${simple[2]}`;
  return '';
};

const windowFromRange = value => {
  const times = [...String(value ?? '').matchAll(/(?:^|\D)([01]?\d|2[0-3])[:.]([0-5]\d)(?=\D|$)/g)]
    .map(match => `${match[1].padStart(2, '0')}:${match[2]}`);
  return times.length === 2 ? times : ['', ''];
};

export function inferImportColumnProfile(values = [], header = '') {
  const sample = values.map(value => String(value ?? '').trim()).filter(Boolean).slice(0, 300);
  if (!sample.length) return { type: 'unknown', label: COLUMN_TYPE_LABELS.unknown, sampleSize: 0, confidence: 0 };
  const ratio = predicate => sample.filter(predicate).length / sample.length;
  const normalizedHeader = normalize(header);
  const booleanTokens = new Set(['1', '0', 'true', 'false', 'yes', 'no', 'y', 'n', 'да', 'нет']);
  const numberRatio = ratio(value => Number.isFinite(Number(value.replace(',', '.'))));
  const booleanRatio = ratio(value => booleanTokens.has(normalize(value)));
  const emailRatio = ratio(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  const timeRatio = ratio(value => /(?:^|T)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:$|[+Z\s])/.test(value));
  const dateRatio = ratio(value => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T\s].*)?$/.test(value) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}(?:\s.*)?$/.test(value));
  const phoneRatio = ratio(value => /^\+?[\d\s().-]{7,}$/.test(value) && value.replace(/\D/g, '').length >= 7);
  const listRatio = ratio(value => /[|;]|,\s*\S/.test(value));
  let type = 'text';
  let confidence = 1;
  if (emailRatio >= .8) ({ type, confidence } = { type: 'email', confidence: emailRatio });
  else if ((/phone|телефон/.test(normalizedHeader) && phoneRatio >= .7)) ({ type, confidence } = { type: 'phone', confidence: phoneRatio });
  else if (timeRatio >= .8) ({ type, confidence } = { type: 'time', confidence: timeRatio });
  else if (dateRatio >= .8) ({ type, confidence } = { type: 'date', confidence: dateRatio });
  else if (booleanRatio >= .9 && new Set(sample.map(normalize)).size <= 4) ({ type, confidence } = { type: 'boolean', confidence: booleanRatio });
  else if (numberRatio >= .9) ({ type, confidence } = { type: 'number', confidence: numberRatio });
  else if (listRatio >= .65) ({ type, confidence } = { type: 'list', confidence: listRatio });
  return { type, label: COLUMN_TYPE_LABELS[type], sampleSize: sample.length, confidence };
}

const fieldMatchesProfile = (fieldId, profile) => {
  if (fieldId === 'ignore' || profile.type === 'unknown') return true;
  return (FIELD_VALUE_TYPES[fieldId] || ['text']).includes(profile.type);
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

let workNormsPromise;
const configuredWorkNorms = () => {
  if (!workNormsPromise) workNormsPromise = (async () => {
    let response;
    try { response = await fetch('/data/work-norms.xlsx'); }
    catch { throw new Error('Не удалось загрузить системный файл нормативов работ.'); }
    if (!response.ok) throw new Error('Не удалось открыть системный файл нормативов работ.');
    const module = await import('xlsx');
    const XLSX = module.default || module;
    const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) throw new Error('Системный файл нормативов пуст.');
    return parseWorkNorms(XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '', raw: true }));
  })().catch(error => {
    workNormsPromise = null;
    throw error;
  });
  return workNormsPromise;
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
    const bytes = await file.arrayBuffer();
    const csvText = extension === 'csv' ? new TextDecoder('utf-8').decode(bytes) : '';
    const decodedCsv = csvText.includes('\uFFFD') ? new TextDecoder('windows-1251').decode(bytes) : csvText;
    const workbook = XLSX.read(extension === 'csv' ? decodedCsv.replace(/^\uFEFF/, '') : bytes, { type: extension === 'csv' ? 'string' : 'array', cellDates: false, raw: extension === 'csv' });
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
  const workNorms = datasets.orders ? await configuredWorkNorms() : null;
  if (datasets.orders) datasets.orders = withWorkNormDefaults(datasets.orders, workNorms);
  const primary = datasets[preferredEntityType] || Object.values(datasets)[0];
  const locationDataset = datasets.orders || datasets.engineers || primary;
  return {
    ...primary,
    entityType: primary.entityType || preferredEntityType,
    datasets,
    fileName: file.name,
    suggestedRegionId: detectSuggestedRegion(locationDataset.headers, locationDataset.rows),
    sourceFormat: extension,
    workNorms,
  };
}

/** Combine district files into one review while retaining a source-file column. */
export async function parseImportFiles(inputFiles, preferredEntityType = 'orders') {
  const files = inputFiles?.arrayBuffer ? [inputFiles] : Array.from(inputFiles || []);
  if (!files.length) throw new Error('Файлы не выбраны.');
  if (files.length === 1) return parseImportFile(files[0], preferredEntityType);
  const sessions = [];
  for (const file of files) {
    try { sessions.push(await parseImportFile(file, preferredEntityType)); }
    catch (error) { throw new Error(`${file.name}: ${error?.message || 'не удалось прочитать файл'}`); }
  }
  const datasets = {};
  for (const entityType of ['orders', 'engineers']) {
    const sources = sessions.filter(session => session.datasets[entityType]).map(session => ({
      fileName: session.fileName,
      dataset: session.datasets[entityType],
    }));
    if (!sources.length) continue;
    const columns = new Map();
    const mappedSources = sources.map(source => ({
      ...source, mapping: source.dataset.savedMappings || autoMapHeaders(source.dataset.headers, entityType),
    }));
    mappedSources.forEach(({ dataset, mapping }) => dataset.headers.forEach((header, index) => {
      const field = mapping[index];
      const key = field.startsWith('custom:') ? `custom:${normalize(header)}` : field;
      if (!columns.has(key)) columns.set(key, {
        header: field.startsWith('custom:') ? header : FIELD_CONFIG[entityType].meta.get(field)?.label || header,
        field,
      });
    }));
    columns.set('__sourceFile', { header: 'Файл импорта', field: 'custom:Файл импорта' });
    const keys = [...columns.keys()];
    datasets[entityType] = {
      entityType,
      headers: keys.map(key => columns.get(key).header),
      rows: mappedSources.flatMap(({ dataset, mapping, fileName }) => dataset.rows.map(row => {
        const values = new Map(dataset.headers.map((header, index) => {
          const field = mapping[index];
          return [field.startsWith('custom:') ? `custom:${normalize(header)}` : field, row[index]];
        }));
        values.set('__sourceFile', fileName);
        return keys.map(key => values.get(key) ?? '');
      })),
      savedMappings: Object.fromEntries(keys.map((key, index) => [index, columns.get(key).field])),
      sheetName: 'Объединённые данные',
      fileName: countLabel(files.length, 'файл', 'файла', 'файлов'),
      sourceFormat: 'mixed',
    };
  }
  const primary = datasets[preferredEntityType] || Object.values(datasets)[0];
  return {
    ...primary,
    entityType: primary.entityType,
    datasets,
    fileName: countLabel(files.length, 'файл', 'файла', 'файлов'),
    sourceFiles: sessions,
    suggestedRegionId: sessions.find(session => session.suggestedRegionId)?.suggestedRegionId || '',
    workNorms: sessions.find(session => session.workNorms)?.workNorms || null,
    sourceFormat: 'mixed',
  };
}

/** Read request rows with the same column aliases used by the full import screen. */
export async function parseReplanningOrderFile(file, region) {
  const session = await parseImportFile(file, 'orders');
  const dataset = session.datasets.orders;
  if (!dataset?.rows?.length) throw new Error('В файле не найдены заявки.');
  const mappings = autoMapHeaders(dataset.headers, 'orders');
  const mapped = new Set(Object.values(mappings));
  if (!mapped.has('id') && !mapped.has('externalId')) throw new Error('Для новой заявки нужен ID.');
  if (!(mapped.has('windowStart') && mapped.has('windowEnd')) && !mapped.has('windowRange')) {
    throw new Error('Для новой заявки нужны начало и конец окна или столбец с полным интервалом.');
  }
  if (validateRows(dataset.rows, mappings, 'orders', session.workNorms).size) {
    throw new Error('Проверьте ID, время окна и вид работ. Для неизвестного вида работ укажите длительность.');
  }
  return buildOrders(dataset.headers, dataset.rows, mappings, region, session.workNorms, session.fileName);
}

const ORDER_CORE_FIELDS = new Set([
  'id', 'externalId', 'name', 'scenario', 'address', 'locationId', 'city', 'region', 'district', 'street', 'house', 'building',
  'apartment', 'postalCode', 'entrance', 'floor', 'latitude', 'longitude', 'coordinateAccuracy', 'geocodeProvider', 'geocodeObjectId',
  'zone', 'zoneId', 'zoneName', 'windowStart', 'windowEnd', 'windowRange', 'duration', 'workType', 'serviceType', 'skill', 'priority', 'status',
  'connectionType', 'isEventJob', 'transport', 'equipment', 'gigabitRequired', 'phone', 'email', 'createdAt', 'serviceDate',
  'geocodeStatus', 'notes', 'ignore',
]);

const ENGINEER_CORE_FIELDS = new Set([
  'engineerId', 'engineerName', 'engineerStatus', 'engineerSkills', 'engineerShiftStart', 'engineerShiftEnd', 'engineerTransport',
  'engineerEquipment', 'engineerStartAddress', 'engineerLocationId', 'engineerCity', 'engineerRegion', 'engineerDistrict',
  'engineerStartLatitude', 'engineerStartLongitude', 'engineerZone', 'engineerZoneId', 'engineerPhone', 'engineerEmail', 'ignore',
]);

const supplementaryFields = (row, mappings, entityType, coreFields) => {
  const meta = FIELD_CONFIG[entityType]?.meta;
  return Object.fromEntries(Object.entries(mappings).flatMap(([column, field]) => {
    if (!field || field === 'ignore' || coreFields.has(field)) return [];
    const label = field.startsWith('custom:') ? field.slice(7) : (meta?.get(field)?.label || field);
    return [[label, row[Number(column)] ?? '']];
  }));
};

export function buildOrders(headers, rows, mappings, region, workNorms = null, sourceFileName = '') {
  const columnFor = fieldId => Number(Object.keys(mappings).find(key => mappings[key] === fieldId));
  const sourceFileColumn = headers.findIndex(header => header === 'Файл импорта');
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
    const name = valueFor(row, 'name');
    const [rangeStart, rangeEnd] = windowFromRange(valueFor(row, 'windowRange'));
    const windowDate = parseImportedDate(valueFor(row, 'windowStart') || valueFor(row, 'windowRange'));
    const duration = workDurationFor({ workType, serviceType, skill, name }, workNorms, valueFor(row, 'duration'));
    const informational = isInformationalOrder({ serviceType, workType, name: valueFor(row, 'name') });
    const lat = asNumber(valueFor(row, 'latitude'));
    const lon = asNumber(valueFor(row, 'longitude'));
    const customFields = supplementaryFields(row, mappings, 'orders', ORDER_CORE_FIELDS);
    const rowSourceFile = sourceFileColumn >= 0 ? String(row[sourceFileColumn] || '') : sourceFileName;
    const explicitZone = valueFor(row, 'zoneName') || valueFor(row, 'zone');
    const explicitZoneId = valueFor(row, 'zoneId');
    const inferredTerritory = !explicitZone && !explicitZoneId ? territoryFromImportFile(rowSourceFile) : null;
    const detailedAddress = [
      valueFor(row, 'street'),
      valueFor(row, 'house') ? `д. ${valueFor(row, 'house')}` : '',
      valueFor(row, 'building') ? `корп. ${valueFor(row, 'building')}` : '',
      valueFor(row, 'apartment') ? `пом. ${valueFor(row, 'apartment')}` : '',
    ].filter(Boolean).join(', ');
    const address = valueFor(row, 'address') || detailedAddress || [valueFor(row, 'district'), valueFor(row, 'zoneName'), valueFor(row, 'zone')].filter(Boolean).join(', ');
    const city = resolveImportedCity(valueFor(row, 'city'), address, region.name);
    const rowRegion = regionForCity(city, lat !== null && lon !== null ? [lat, lon] : null);
    return {
      id: `${rowRegion.id}:${sourceId}`,
      sourceId,
      name: name || `${serviceLabel || workType || 'Заявка'} ${sourceId}`,
      address,
      city: rowRegion.name,
      regionName: rowRegion.name,
      locationId: valueFor(row, 'locationId'),
      postalCode: valueFor(row, 'postalCode'),
      entrance: valueFor(row, 'entrance'),
      floor: valueFor(row, 'floor'),
      phone: valueFor(row, 'phone'),
      email: valueFor(row, 'email'),
      start: asTime(valueFor(row, 'windowStart')) || rangeStart,
      end: asTime(valueFor(row, 'windowEnd')) || rangeEnd,
      duration,
      durationSource: workNormFor({ workType, serviceType, skill, name }, workNorms)
        ? 'Нормативы.xlsx' : workNorms ? (duration === 60 ? 'Без норматива · 60 мин' : 'Изменено оператором') : 'Файл заявки',
      priority: informational ? 'Обычная' : translatePriority(valueFor(row, 'priority')),
      workType,
      skill: informational && /emerg|авар/i.test(skill) ? '' : translateSkill(skill, workType || serviceType),
      equipment: importedEquipmentRequirements(valueFor(row, 'equipment')),
      transport: valueFor(row, 'transport'),
      district: valueFor(row, 'district'),
      zone: explicitZone || inferredTerritory?.label || '',
      zoneId: explicitZoneId || inferredTerritory?.id || '',
      serviceType,
      connectionType: valueFor(row, 'connectionType'),
      gigabitRequired: valueFor(row, 'gigabitRequired'),
      isEventJob: valueFor(row, 'isEventJob'),
      scenario: valueFor(row, 'scenario'),
      notes: valueFor(row, 'notes'),
      createdAt: valueFor(row, 'createdAt'),
      serviceDate: valueFor(row, 'serviceDate') || windowDate?.toLocaleDateString('sv-SE') || '',
      regionId: rowRegion.id,
      status: valueFor(row, 'status') || 'Новая',
      coords: lat !== null && lon !== null ? [lat, lon] : null,
      geocodeStatus: valueFor(row, 'geocodeStatus') || (lat !== null && lon !== null ? 'ready' : 'needs_geocoding'),
      coordinateAccuracy: valueFor(row, 'coordinateAccuracy'),
      geocodeProvider: valueFor(row, 'geocodeProvider'),
      geocodeObjectId: valueFor(row, 'geocodeObjectId'),
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
  return String(value || '').trim();
};

export function buildEngineers(headers, rows, mappings, region) {
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
    const equipment = [...new Set(importedEquipmentTokens(valueFor(row, 'engineerEquipment')))];
    const customFields = supplementaryFields(row, mappings, 'engineers', ENGINEER_CORE_FIELDS);
    const startAddress = valueFor(row, 'engineerStartAddress') || region.name;
    const city = resolveImportedCity(valueFor(row, 'engineerCity'), startAddress, region.name);
    const rowRegion = regionForCity(city, lat !== null && lon !== null ? [lat, lon] : null);
    return {
      id: `${rowRegion.id}:${sourceId}`,
      sourceId: String(sourceId),
      name: valueFor(row, 'engineerName') || `Инженер ${index + 1}`,
      city: rowRegion.name,
      regionName: rowRegion.name,
      regionId: rowRegion.id,
      skills,
      transport: translateTransport(valueFor(row, 'engineerTransport')),
      shiftStart: asTime(valueFor(row, 'engineerShiftStart')) || '08:00',
      shiftEnd: asTime(valueFor(row, 'engineerShiftEnd')) || '18:00',
      equipment,
      startAddress,
      locationId: valueFor(row, 'engineerLocationId'),
      startCoords: lat !== null && lon !== null ? [lat, lon] : rowRegion.coords,
      zone: valueFor(row, 'engineerZone'),
      zoneId: valueFor(row, 'engineerZoneId'),
      district: valueFor(row, 'engineerDistrict'),
      status: valueFor(row, 'engineerStatus') || 'Доступность не указана',
      phone: valueFor(row, 'engineerPhone'),
      email: valueFor(row, 'engineerEmail'),
      load: 0,
      customFields,
      sourceData: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ''])),
    };
  });
}

function requirementState(mappings, entityType = 'orders', workNorms = null) {
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
    { label: 'Окно обслуживания', ok: (values.includes('windowStart') && values.includes('windowEnd')) || values.includes('windowRange') },
    { label: workNorms ? 'Норматив из системного файла' : 'Норматив работ', ok: Boolean(workNorms) || values.includes('duration') },
    { label: 'Тип работ или навык', ok: ['workType', 'serviceType', 'skill', 'name'].some(field => values.includes(field)) },
  ];
}

export function validateRows(rows, mappings, entityType = 'orders', workNorms = null) {
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
  const seenIds = new Map();
  rows.forEach((row, rowIndex) => {
    const hasId = ['id', 'externalId'].some(field => {
      const column = mappedColumn(field);
      return Number.isInteger(column) && String(row[column] ?? '').trim();
    });
    if (!hasId) ['id', 'externalId'].forEach(field => markBlank(row, rowIndex, field));
    else {
      const sourceId = ['id', 'externalId'].map(field => {
        const column = mappedColumn(field);
        return Number.isInteger(column) ? normalize(row[column]) : '';
      }).find(Boolean);
      if (seenIds.has(sourceId)) {
        const idColumn = Number.isInteger(mappedColumn('id')) ? mappedColumn('id') : mappedColumn('externalId');
        invalid.add(`${rowIndex}:${idColumn}`);
        invalid.add(`${seenIds.get(sourceId)}:${idColumn}`);
      } else seenIds.set(sourceId, rowIndex);
    }
    const addressColumn = mappedColumn('address');
    const latColumn = mappedColumn('latitude');
    const lonColumn = mappedColumn('longitude');
    const streetColumn = mappedColumn('street');
    const houseColumn = mappedColumn('house');
    const hasAddress = (Number.isInteger(addressColumn) && String(row[addressColumn] ?? '').trim())
      || (Number.isInteger(streetColumn) && String(row[streetColumn] ?? '').trim()
        && Number.isInteger(houseColumn) && String(row[houseColumn] ?? '').trim());
    const hasCoords = Number.isInteger(latColumn) && Number.isInteger(lonColumn) && asNumber(row[latColumn]) !== null && asNumber(row[lonColumn]) !== null;
    if (!hasAddress && !hasCoords) [addressColumn, latColumn, lonColumn].filter(Number.isInteger).forEach(column => invalid.add(`${rowIndex}:${column}`));
    const rangeColumn = mappedColumn('windowRange');
    const [rangeStart, rangeEnd] = Number.isInteger(rangeColumn) ? windowFromRange(row[rangeColumn]) : ['', ''];
    const startColumn = mappedColumn('windowStart');
    const endColumn = mappedColumn('windowEnd');
    const start = (Number.isInteger(startColumn) ? asTime(row[startColumn]) : '') || rangeStart;
    const end = (Number.isInteger(endColumn) ? asTime(row[endColumn]) : '') || rangeEnd;
    const startDate = Number.isInteger(startColumn) ? parseImportedDate(row[startColumn]) : null;
    const endDate = Number.isInteger(endColumn) ? parseImportedDate(row[endColumn]) : null;
    const differentDays = startDate && endDate && startDate.getTime() !== endDate.getTime();
    if (!start || !end || start >= end || differentDays) {
      [!start || start >= end || differentDays ? startColumn : null,
        !end || start >= end || differentDays ? endColumn : null, rangeColumn].filter(Number.isInteger)
        .forEach(column => invalid.add(`${rowIndex}:${column}`));
    }
    const durationColumn = mappedColumn('duration');
    const fieldValue = field => {
      const column = mappedColumn(field);
      return Number.isInteger(column) ? row[column] : '';
    };
    const duration = workDurationFor({ workType: fieldValue('workType'), serviceType: fieldValue('serviceType'),
      skill: fieldValue('skill'), name: fieldValue('name') }, workNorms, fieldValue('duration'));
    if (duration === null) {
      const column = [durationColumn, mappedColumn('workType'), mappedColumn('serviceType'),
        mappedColumn('skill'), mappedColumn('name')].find(Number.isInteger);
      if (Number.isInteger(column)) invalid.add(`${rowIndex}:${column}`);
    }
  });
  return invalid;
}

function MappingMenu({ column, header, values, mappings, entityType, onSelect, onClose, position, visible }) {
  const [customName, setCustomName] = useState('');
  const [showAll, setShowAll] = useState(false);
  const current = mappings[column] || '';
  const used = new Set(Object.entries(mappings).filter(([key]) => Number(key) !== column).map(([, value]) => value));
  const fieldGroups = FIELD_CONFIG[entityType]?.groups || ORDER_FIELD_GROUPS;
  const profile = useMemo(() => inferImportColumnProfile(values, header), [values, header]);
  const availableGroups = useMemo(() => fieldGroups.map(group => ({
    ...group,
    fields: group.fields.filter(([id]) => {
      if (used.has(id) && id !== 'ignore') return false;
      return showAll || id === current || fieldMatchesProfile(id, profile);
    }),
  })).filter(group => group.fields.length), [fieldGroups, used, showAll, current, profile]);
  const addCustom = () => {
    const name = customName.trim();
    if (!name) return;
    onSelect(`custom:${name}`);
  };
  return <div className={`import-mapping-menu dropdown-transition ${visible ? 'is-open' : 'is-closing'}`} style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }} role="listbox" aria-label="Назначение столбца">
    <div className="mapping-type-summary"><span><Info/></span><div><b>Назначение столбца</b></div><button type="button" onClick={() => setShowAll(value => !value)}>{showAll ? 'Только подходящие' : 'Все поля'}</button></div>
    <div className="mapping-menu-scroll">
      {availableGroups.map(group => <section key={group.id}><h4>{group.label}</h4>{group.fields.map(([id, label, required]) => <button type="button" role="option" aria-selected={current === id} className={current === id ? 'selected' : ''} key={id} onClick={() => onSelect(id)}><span>{label}{required ? <em>обязательно</em> : null}</span>{current === id ? <Check /> : null}</button>)}</section>)}
    </div>
    <div className="custom-field-create"><input value={customName} onChange={event => setCustomName(event.target.value)} onKeyDown={event => event.key === 'Enter' && addCustom()} placeholder="Своё поле"/><button type="button" onClick={addCustom} aria-label="Добавить своё поле"><Plus/></button></div>
    <button type="button" className="mapping-menu-close" onClick={onClose}><X/>Закрыть</button>
  </div>;
}

function FilterMenu({ header, values, selected, onApply, onReset, onClose, position, visible }) {
  const uniqueValues = useMemo(() => [...new Set(values.map(value => String(value ?? '')))].sort((left, right) => (
    left.localeCompare(right, 'ru', { numeric: true, sensitivity: 'base' })
  )), [values]);
  const [query, setQuery] = useState('');
  const [checkedValues, setCheckedValues] = useState(() => selected === undefined ? uniqueValues : selected);
  const filteredValues = useMemo(() => {
    const normalizedQuery = normalize(query);
    return normalizedQuery ? uniqueValues.filter(value => normalize(value || 'Пустые значения').includes(normalizedQuery)) : uniqueValues;
  }, [uniqueValues, query]);
  const checked = new Set(checkedValues);
  const toggleValue = value => setCheckedValues(current => (
    current.includes(value) ? current.filter(item => item !== value) : [...current, value]
  ));
  return <div className={`import-mapping-menu import-filter-menu dropdown-transition ${visible ? 'is-open' : 'is-closing'}`} style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }} role="dialog" aria-label={`Фильтр столбца ${header}`}>
    <div className="mapping-type-summary"><span><Filter/></span><div><b>Фильтр столбца</b><small title={header}>{header}</small></div></div>
    <label className="column-filter-search"><Search/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти значение"/>{query ? <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск"><X/></button> : null}</label>
    <div className="column-filter-select-all"><button type="button" onClick={() => setCheckedValues(uniqueValues)}>Выбрать все</button><button type="button" onClick={() => setCheckedValues([])}>Снять все</button></div>
    <div className="mapping-menu-scroll filter-values-list">
      {filteredValues.length ? filteredValues.map(value => <button type="button" role="checkbox" aria-checked={checked.has(value)} className={checked.has(value) ? 'selected' : ''} key={value} onClick={() => toggleValue(value)}><i>{checked.has(value) ? <Check/> : null}</i><span>{value || 'Пустые значения'}</span></button>) : <div className="filter-no-values">Значения не найдены</div>}
    </div>
    <div className="filter-menu-actions"><button type="button" onClick={onReset}>Сбросить</button><button type="button" className="primary" onClick={() => onApply(checkedValues)}>Применить</button></div>
    <button type="button" className="mapping-menu-close" onClick={onClose}><X/>Закрыть</button>
  </div>;
}

export function ImportWorkspace({ session, region, onCancel, onImport, files = [], onSelectFile, onAddFile, onFileError, closing = false }) {
  const reviewMode = session.mode === 'review';
  const requestClose = () => reviewMode ? onCancel() : setCancelConfirm(true);
  const datasets = session.datasets || { [session.entityType || 'orders']: session };
  const availableTypes = ['orders', 'engineers'].filter(entityType => datasets[entityType]);
  const [activeType, setActiveType] = useState(() => (
    datasets[session.entityType] ? session.entityType : availableTypes[0]
  ));
  const [draftHistory, setDraftHistory] = useState(() => session.editHistory || ({
    past: [],
    present: Object.fromEntries(availableTypes.map(entityType => [entityType, {
      rows: datasets[entityType].rows.map(row => [...row]),
      mappings: datasets[entityType].savedMappings
        ? { ...datasets[entityType].savedMappings }
        : autoMapHeaders(datasets[entityType].headers, entityType),
      editedCells: new Set(datasets[entityType].editedCells || []),
    }])),
    future: [],
  }));
  const [menuColumn, setMenuColumn] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 24, top: 120 });
  const [filterColumn, setFilterColumn] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterMenuVersion, setFilterMenuVersion] = useState(0);
  const [filterPosition, setFilterPosition] = useState({ left: 24, top: 120 });
  const [columnFilters, setColumnFilters] = useState(() => Object.fromEntries(availableTypes.map(entityType => [entityType, {}])));
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [search, setSearch] = useState('');
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [acceptedUnknownNorms, setAcceptedUnknownNorms] = useState(false);
  const tableRef = useRef(null);
  const fileMenuRef = useRef(null);
  const extraFileInputRef = useRef(null);
  const extraFileTypeRef = useRef('orders');
  const editHistoryKeyRef = useRef('');
  const mappingPresence = useDropdownPresence(menuOpen);
  const filterPresence = useDropdownPresence(filterOpen);
  const fileMenuPresence = useDropdownPresence(fileMenuOpen, 180);
  const drafts = draftHistory.present;
  useEffect(() => setAcceptedUnknownNorms(false), [session]);
  const unknownNormRows = useMemo(() => drafts.orders
    ? unmatchedWorkNorms(drafts.orders.rows, drafts.orders.mappings, session.workNorms)
    : [], [drafts.orders, session.workNorms]);
  const canUndo = draftHistory.past.length > 0;
  const canRedo = draftHistory.future.length > 0;
  const activeDataset = datasets[activeType];
  const activeDraft = drafts[activeType];
  const rows = activeDraft.rows;
  const mappings = activeDraft.mappings;
  const editedCells = activeDraft.editedCells;
  const activeColumnFilters = columnFilters[activeType] || {};
  const sourceFiles = useMemo(() => {
    const unique = new Map();
    [...files, ...(session.reviewFiles || []), ...(session.sourceFiles || []), session].forEach((item, index) => {
      if (!item) return;
      const key = item.fileId || `${item.fileName || 'Файл'}:${item.importedAt || index}`;
      unique.set(key, item);
    });
    return [...unique.values()];
  }, [files, session]);

  useEffect(() => {
    if (!fileMenuOpen) return undefined;
    const close = event => {
      if (!fileMenuRef.current?.contains(event.target)) setFileMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [fileMenuOpen]);

  const requirements = useMemo(() => requirementState(mappings, activeType, session.workNorms), [mappings, activeType, session.workNorms]);
  const mappingReady = requirements.every(item => item.ok);
  const invalidCells = useMemo(() => validateRows(rows, mappings, activeType, session.workNorms), [rows, mappings, activeType, session.workNorms]);
  const rowIssueCount = useMemo(() => new Set([...invalidCells].map(key => key.split(':')[0])).size, [invalidCells]);
  const mappedCount = Object.values(mappings).filter(Boolean).length;
  const validationByType = useMemo(() => Object.fromEntries(availableTypes.map(entityType => {
    const draft = drafts[entityType];
    const typeRequirements = requirementState(draft.mappings, entityType, session.workNorms);
    const typeInvalidCells = validateRows(draft.rows, draft.mappings, entityType, session.workNorms);
    return [entityType, {
      ready: typeRequirements.every(item => item.ok) && typeInvalidCells.size === 0,
      rowIssueCount: new Set([...typeInvalidCells].map(key => key.split(':')[0])).size,
      missing: typeRequirements.filter(item => !item.ok).map(item => item.label),
      invalidCellCount: typeInvalidCells.size,
    }];
  })), [drafts, availableTypes.join('|'), session.workNorms]);
  const allReady = availableTypes.every(entityType => validationByType[entityType].ready);
  const canSubmit = allReady && (!unknownNormRows.length || acceptedUnknownNorms);
  const validationMessages = useMemo(() => {
    const messages = requirements.filter(item => !item.ok).map(item => `Не сопоставлено обязательное поле: ${item.label}.`);
    [...invalidCells].sort((left, right) => left.localeCompare(right, 'ru', { numeric: true })).forEach(key => {
      const [rowIndexText, columnText] = key.split(':'), rowIndex = Number(rowIndexText), column = Number(columnText);
      const header = activeDataset.headers[column] || `Столбец ${column + 1}`;
      const field = mappings[column] || '';
      const raw = String(rows[rowIndex]?.[column] ?? '').trim();
      let reason = raw ? 'значение имеет неверный формат' : 'значение не заполнено';
      if (field === 'duration') reason = 'нужно положительное число минут для неизвестного вида работ';
      else if (field === 'id' || field === 'externalId') reason = raw ? 'ID повторяется в другом файле или строке' : 'ID не заполнен';
      else if (['windowStart', 'windowEnd', 'windowRange'].includes(field)) reason = 'укажите корректный интервал: начало раньше конца';
      else if (['workType', 'serviceType', 'skill', 'name'].includes(field)) reason = 'вид работ не найден в нормативах; укажите длительность отдельно';
      else if (field === 'engineerSkills') reason = raw ? 'разрешено не более трёх навыков' : 'навыки не заполнены';
      else if (field === 'engineerId') reason = raw ? 'ID повторяется в другой строке' : 'ID не заполнен';
      else if (field === 'engineerShiftStart' || field === 'engineerShiftEnd') reason = raw ? 'время должно быть в формате ЧЧ:ММ' : 'время смены не заполнено';
      else if (['address', 'latitude', 'longitude'].includes(field)) reason = 'укажите адрес либо корректные широту и долготу';
      messages.push(`Строка ${rowIndex + 2}, «${header}»: ${reason}.`);
    });
    availableTypes.filter(entityType => entityType !== activeType && !validationByType[entityType].ready).forEach(entityType => {
      const title = entityType === 'engineers' ? 'Инженеры' : 'Заявки';
      validationByType[entityType].missing.forEach(label => messages.push(`Вкладка «${title}»: не сопоставлено поле «${label}».`));
      if (validationByType[entityType].rowIssueCount) messages.push(`Вкладка «${title}»: ошибки в ${validationByType[entityType].rowIssueCount} строках (${validationByType[entityType].invalidCellCount} ячеек).`);
    });
    return messages;
  }, [requirements, invalidCells, activeDataset.headers, mappings, rows, availableTypes.join('|'), activeType, validationByType]);
  const visibleRows = useMemo(() => {
    const query = normalize(search);
    return rows.map((row, index) => ({ row, index })).filter(({ row }) => {
      const passesColumns = Object.entries(activeColumnFilters).every(([column, allowed]) => allowed.includes(String(row[Number(column)] ?? '')));
      return passesColumns && (!query || normalize(row.join(' ')).includes(query));
    });
  }, [rows, search, activeColumnFilters]);
  const normalizedSearch = normalize(search);

  const commitDrafts = (updater, historyKey = '') => {
    const coalesce = Boolean(historyKey) && editHistoryKeyRef.current === historyKey;
    editHistoryKeyRef.current = historyKey;
    setDraftHistory(history => {
      const next = updater(history.present);
      return pushImportHistory(history, next, { coalesce });
    });
  };

  const undoDraftChange = () => {
    editHistoryKeyRef.current = '';
    setDraftHistory(undoImportHistory);
  };

  const redoDraftChange = () => {
    editHistoryKeyRef.current = '';
    setDraftHistory(redoImportHistory);
  };

  useEffect(() => {
    const close = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && (event.target.closest?.('.import-mapping-menu') || event.target.closest?.('.column-mapping-button') || event.target.closest?.('.column-filter-button'))) return;
      setMenuOpen(false);
      setFilterOpen(false);
    };
    if (!menuOpen && !filterOpen) return undefined;
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen, filterOpen]);

  useEffect(() => {
    const onHistoryShortcut = event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoDraftChange();
        else undoDraftChange();
      } else if (key === 'y') {
        event.preventDefault();
        redoDraftChange();
      }
    };
    document.addEventListener('keydown', onHistoryShortcut);
    return () => document.removeEventListener('keydown', onHistoryShortcut);
  });

  const dropdownPosition = event => {
    const anchor = event.currentTarget.closest('th') || event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    // The app shell uses CSS zoom: DOM rectangles are visual pixels, while a
    // fixed child's left/top are still measured in unzoomed CSS pixels.
    const scale = rect.width / anchor.offsetWidth || 1;
    const width = 390;
    const visualLeft = Math.max(12, Math.min(rect.left, window.innerWidth - width * scale - 12));
    const visualTop = rect.bottom + 7;
    return {
      left: visualLeft / scale,
      top: visualTop / scale,
      maxHeight: Math.max(220, (window.innerHeight - visualTop - 12) / scale),
    };
  };

  const openMapping = (column, event) => {
    if (menuOpen && menuColumn === column) {
      setMenuOpen(false);
      return;
    }
    setFilterOpen(false);
    setMenuPosition(dropdownPosition(event));
    setMenuColumn(column);
    setMenuOpen(true);
  };

  const openFilter = (column, event) => {
    if (filterOpen && filterColumn === column) {
      setFilterOpen(false);
      return;
    }
    setMenuOpen(false);
    setFilterPosition(dropdownPosition(event));
    setFilterColumn(column);
    setFilterMenuVersion(version => version + 1);
    setFilterOpen(true);
  };

  const applyColumnFilter = selectedValues => {
    const uniqueValues = new Set(rows.map(row => String(row[filterColumn] ?? '')));
    setColumnFilters(current => {
      const nextForType = { ...(current[activeType] || {}) };
      if (selectedValues.length === uniqueValues.size) delete nextForType[filterColumn];
      else nextForType[filterColumn] = selectedValues;
      return { ...current, [activeType]: nextForType };
    });
    setFilterOpen(false);
    requestAnimationFrame(() => tableRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
  };

  const resetColumnFilter = () => {
    setColumnFilters(current => {
      const nextForType = { ...(current[activeType] || {}) };
      delete nextForType[filterColumn];
      return { ...current, [activeType]: nextForType };
    });
    setFilterOpen(false);
  };

  const selectMapping = field => {
    editHistoryKeyRef.current = '';
    if (activeType === 'orders') setAcceptedUnknownNorms(false);
    commitDrafts(current => {
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
    if (activeType === 'orders' && ['duration', 'workType', 'serviceType', 'skill', 'name'].includes(mappings[columnIndex])) {
      setAcceptedUnknownNorms(false);
    }
    commitDrafts(current => {
      const draft = current[activeType];
      const nextRows = draft.rows.map((row, index) => {
        if (index !== rowIndex) return row;
        const nextRow = row.map((cell, column) => column === columnIndex ? value : cell);
        if (activeType === 'orders' && session.workNorms
          && ['workType', 'serviceType', 'skill', 'name'].includes(draft.mappings[columnIndex])) {
          const durationColumn = Object.keys(draft.mappings).find(key => draft.mappings[key] === 'duration');
          if (durationColumn !== undefined && !draft.editedCells.has(`${rowIndex}:${durationColumn}`)) {
            nextRow[Number(durationColumn)] = String(workNormFor(mappedWork(nextRow, draft.mappings), session.workNorms)?.serviceMinutes ?? 60);
          }
        }
        return nextRow;
      });
      return { ...current, [activeType]: {
        ...draft,
        rows: nextRows,
        editedCells: new Set(draft.editedCells).add(`${rowIndex}:${columnIndex}`),
      } };
    }, `cell:${activeType}:${rowIndex}:${columnIndex}`);
  };

  const submit = () => {
    if (!canSubmit) return;
    const reviewedDatasets = Object.fromEntries(availableTypes.map(entityType => [entityType, {
      ...datasets[entityType],
      rows: drafts[entityType].rows.map(row => [...row]),
      savedMappings: { ...drafts[entityType].mappings },
      editedCells: [...drafts[entityType].editedCells],
    }]));
    onImport({
      orders: drafts.orders ? buildOrders(datasets.orders.headers, drafts.orders.rows, drafts.orders.mappings, region, session.workNorms, session.fileName) : [],
      engineers: drafts.engineers ? buildEngineers(datasets.engineers.headers, drafts.engineers.rows, drafts.engineers.mappings, region) : [],
    }, { ...session, datasets: reviewedDatasets, editHistory: draftHistory, reviewRegion: session.reviewRegion || region, mode: 'review' });
  };

  const requestAdditionalFile = entityType => {
    extraFileTypeRef.current = entityType;
    setFileMenuOpen(false);
    extraFileInputRef.current?.click();
  };

  const addAdditionalFile = async files => {
    if (!files?.length) return;
    try {
      const nextSession = await parseImportFiles(files, extraFileTypeRef.current);
      (onAddFile || session.onAddFile)?.({ ...nextSession, fileId: `${nextSession.fileName}:${Date.now()}`, importedAt: Date.now() });
    } catch (error) {
      (onFileError || session.onFileError)?.(error?.message || 'Не удалось прочитать дополнительный файл');
    }
  };

  const switchDataset = entityType => {
    setActiveType(entityType);
    setSearch('');
    setMenuOpen(false);
    setFilterOpen(false);
    requestAnimationFrame(() => tableRef.current?.scrollTo({ top: 0, left: 0, behavior: 'smooth' }));
  };

  const importButtonText = [
    drafts.orders ? countLabel(drafts.orders.rows.length, 'заявка', 'заявки', 'заявок') : '',
    drafts.engineers ? countLabel(drafts.engineers.rows.length, 'инженер', 'инженера', 'инженеров') : '',
  ].filter(Boolean).join(' и ');
  const entityLabel = activeType === 'engineers'
    ? countNoun(rows.length, 'инженер', 'инженера', 'инженеров')
    : countNoun(rows.length, 'заявка', 'заявки', 'заявок');
  const readyRequirementCount = requirements.filter(item => item.ok).length;
  const unknownWorkTypes = [...new Set(unknownNormRows.map(item => item.type))];
  return <div className={`import-workspace${reviewMode ? ' is-review' : ''}${closing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-label="Проверка и загрузка данных">
    <header className="import-header">
      <div className="import-title">{!reviewMode ? <img src="/beego-mark.png" alt="BeeGo"/> : null}<div><h1>Данные</h1><p>{activeDataset.fileName || session.fileName} · {rows.length} {entityLabel} · участок «{region.name}» · лист «{activeDataset.sheetName}»</p></div></div>
      {reviewMode ? <div className="import-file-picker" ref={fileMenuRef}>
        <button type="button" className="import-file-picker-trigger" aria-label="Открыть загруженные файлы" title="Загруженные файлы" aria-haspopup="menu" aria-expanded={fileMenuOpen} onClick={() => setFileMenuOpen(open => !open)}><Files/><span><small>{sourceFiles.length > 1 ? countLabel(sourceFiles.length, 'файл', 'файла', 'файлов') : 'Исходный файл'}</small><b>{session.fileName || activeDataset.fileName}</b></span><ChevronDown/></button>
        {fileMenuPresence.present ? <div className={`import-file-menu dropdown-transition ${fileMenuPresence.visible ? 'is-open' : 'is-closing'}`} role="menu">
          <header><span><Files/></span><div><b>Загруженные файлы</b><small>Выберите набор для просмотра</small></div></header>
          <div className="import-file-menu-list">{sourceFiles.map((file, index) => {
            const selected = (file.fileId && file.fileId === session.fileId) || (!file.fileId && file.fileName === session.fileName);
            const fileDatasets = file.datasets || {};
            const totalRows = Object.values(fileDatasets).reduce((total, dataset) => total + (dataset?.rows?.length || 0), 0) || file.rows?.length || 0;
            return <button type="button" role="menuitemradio" aria-checked={selected} className={selected ? 'selected' : ''} key={file.fileId || `${file.fileName}-${index}`} onClick={() => { setFileMenuOpen(false); if (!selected) (onSelectFile || session.onSelectFile)?.(file); }}><span><b>{file.fileName || `Файл ${index + 1}`}</b><small>{totalRows} строк · {Object.keys(fileDatasets).map(type => type === 'orders' ? 'заявки' : 'инженеры').join(' + ') || (file.entityType === 'engineers' ? 'инженеры' : 'заявки')}</small></span>{selected ? <Check/> : null}</button>;
          })}</div>
          <div className="import-file-menu-add"><b>Добавить ещё</b><button type="button" onClick={() => requestAdditionalFile('orders')}><FilePlus2/><span>Файл заявок<small>CSV, JSON, XLS или XLSX</small></span></button><button type="button" onClick={() => requestAdditionalFile('engineers')}><FilePlus2/><span>Файл инженеров<small>CSV, JSON, XLS или XLSX</small></span></button></div>
        </div> : null}
        <input ref={extraFileInputRef} className="workspace-file-input" type="file" multiple accept=".csv,.json,.xls,.xlsx,application/json" onChange={event => { addAdditionalFile(event.target.files); event.target.value = ''; }}/>
      </div> : null}
      {availableTypes.length > 1 ? <nav className="import-dataset-tabs" aria-label="Наборы данных">{availableTypes.map(entityType => <button type="button" key={entityType} className={activeType === entityType ? 'active' : ''} onClick={() => switchDataset(entityType)}><span>{entityType === 'orders' ? 'Заявки' : 'Инженеры'}</span><b>{drafts[entityType].rows.length}</b>{validationByType[entityType].ready ? <Check/> : <AlertTriangle/>}</button>)}</nav> : null}
      <button className="import-header-close" type="button" onClick={requestClose} aria-label={reviewMode ? 'Закрыть проверку данных' : 'Отменить загрузку'}><X/></button>
    </header>

    <main className="import-main">
      <section className={`import-table-area${unknownNormRows.length ? ' has-unknown-norms' : ''}`}>
        <div className="import-table-toolbar"><div><h2>Сопоставление и редактирование</h2><p>Выберите назначение столбцов и проверьте значения. Для известных видов работ берётся «Нормативы.xlsx»: технические работы + документы; дорогу рассчитывает маршрут.</p></div><div className="import-table-tools"><div className="import-status-summary" aria-label="Состояние файла"><span className={mappedCount === activeDataset.headers.length ? 'ok' : 'warning'}><small>Столбцы</small><b>{mappedCount}/{activeDataset.headers.length}</b></span><span className={mappingReady ? 'ok' : 'warning'}><small>Обязательные</small><b>{readyRequirementCount}/{requirements.length}</b></span><span><small>Изменено</small><b>{editedCells.size}</b></span><span className={rowIssueCount ? 'warning' : 'ok'}><small>Ошибки</small><b>{rowIssueCount}</b></span></div><div className="import-history-actions" aria-label="История изменений"><button type="button" disabled={!canUndo} onClick={undoDraftChange} aria-label="Отменить изменение" title="Назад · Ctrl+Z"><Undo2/></button><button type="button" disabled={!canRedo} onClick={redoDraftChange} aria-label="Вернуть изменение" title="Вперёд · Ctrl+Y"><Redo2/></button></div><label><Search/><input value={search} onChange={changeSearch} placeholder="Найти в таблице"/><kbd aria-live="polite">{visibleRows.length}/{rows.length}</kbd>{search ? <button type="button" onClick={() => setSearch('')} aria-label="Очистить поиск"><X/></button> : null}</label></div></div>
        {unknownNormRows.length ? <aside className="import-norm-warning" role="note" aria-label="Нет норматива для вида работ"><AlertTriangle/><div><b>Для {countLabel(unknownNormRows.length, 'заявки', 'заявок', 'заявок')} нет норматива работ</b><p>Изначально указано 60 минут на работу. Хотите изменить? Отредактируйте значения в столбце «Норматив, мин» перед загрузкой.</p><small>Виды работ: {unknownWorkTypes.slice(0, 4).join(', ')}{unknownWorkTypes.length > 4 ? ` и ещё ${unknownWorkTypes.length - 4}` : ''}</small></div><button type="button" className={acceptedUnknownNorms ? 'accepted' : ''} onClick={() => setAcceptedUnknownNorms(true)}>{acceptedUnknownNorms ? 'Время проверено' : 'Продолжить с указанным временем'}</button></aside> : null}
        <div className="import-table-scroll" ref={tableRef} onScroll={() => { setMenuOpen(false); setFilterOpen(false); }}>
          <table className="import-grid">
            <thead><tr>{activeDataset.headers.map((header, column) => {
              const field = mappings[column];
              const filterActive = Object.prototype.hasOwnProperty.call(activeColumnFilters, column);
              return <th key={`${header}-${column}`} className={!field ? 'unmapped' : ''}><button type="button" className="column-mapping-button" onClick={event => openMapping(column, event)} aria-expanded={menuOpen && menuColumn === column}><span><b>{fieldLabel(field, activeType)}</b><small>{groupClass(field, activeType) || 'Тип не выбран'}</small></span><ChevronDown/></button><button type="button" className={`column-filter-button ${filterActive ? 'active' : ''}`} onClick={event => openFilter(column, event)} aria-label={`Фильтр столбца ${header}`} aria-expanded={filterOpen && filterColumn === column}><span title={header}>{header}</span><Filter/></button></th>;
            })}</tr></thead>
            <tbody>{visibleRows.length ? visibleRows.map(({ row, index }) => <tr key={index} className={[...invalidCells].some(key => key.startsWith(`${index}:`)) ? 'has-error' : ''}>{row.map((cell, column) => {
              const key = `${index}:${column}`;
              const matchesSearch = normalizedSearch && normalize(cell).includes(normalizedSearch);
              return <td key={column} className={`${invalidCells.has(key) ? 'invalid ' : ''}${editedCells.has(key) ? 'edited ' : ''}${matchesSearch ? 'search-match' : ''}`}><input value={cell} onBlur={() => { editHistoryKeyRef.current = ''; }} onChange={event => editCell(index, column, event.target.value)} aria-label={`Строка ${index + 1}, ${activeDataset.headers[column]}`}/>{invalidCells.has(key) ? <AlertTriangle/> : editedCells.has(key) ? <Check/> : null}</td>;
            })}</tr>) : <tr className="import-no-results"><td colSpan={activeDataset.headers.length}><Search/><b>Ничего не найдено</b><span>Попробуйте изменить запрос</span></td></tr>}</tbody>
          </table>
        </div>
      </section>
    </main>

    <footer className="import-footer"><div className={`import-validation-summary ${validationMessages.length || (unknownNormRows.length && !acceptedUnknownNorms) ? 'has-errors' : 'is-ready'}`} tabIndex={validationMessages.length ? 0 : undefined} aria-describedby={validationMessages.length ? 'import-validation-details' : undefined}>{!mappingReady ? <><AlertTriangle/><span>Укажите все обязательные поля</span></> : invalidCells.size ? <><AlertTriangle/><span>Исправьте {rowIssueCount} {rowIssueCount === 1 ? 'строку' : 'строки'} с ошибками</span></> : !allReady ? <><AlertTriangle/><span>Проверьте вторую вкладку данных</span></> : unknownNormRows.length && !acceptedUnknownNorms ? <><AlertTriangle/><span>Проверьте время заявок без норматива</span></> : <><ShieldCheck/><span>{reviewMode ? 'Все наборы проверены. Изменения можно сохранить.' : 'Все наборы проверены. Можно загружать.'}</span></>}{validationMessages.length ? <aside id="import-validation-details" className="import-validation-details" role="tooltip"><b>Что именно нужно исправить</b><p>Наведите на сообщение или перейдите к нему клавишей Tab — список останется открытым.</p><ul>{validationMessages.slice(0, 12).map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul>{validationMessages.length > 12 ? <small>И ещё {validationMessages.length - 12} ошибок. Исправьте показанные строки — список обновится автоматически.</small> : null}</aside> : null}</div><button type="button" onClick={requestClose}>{reviewMode ? 'Закрыть' : 'Отменить'}</button><button type="button" className="primary" disabled={!canSubmit} onClick={submit}><Check/>{reviewMode ? 'Сохранить изменения' : `Загрузить ${importButtonText}`}</button></footer>

    {mappingPresence.present && menuColumn !== null ? <MappingMenu column={menuColumn} header={activeDataset.headers[menuColumn]} values={rows.map(row => row[menuColumn])} mappings={mappings} entityType={activeType} onSelect={selectMapping} onClose={() => setMenuOpen(false)} position={menuPosition} visible={mappingPresence.visible}/> : null}
    {filterPresence.present && filterColumn !== null ? <FilterMenu key={`${activeType}-${filterColumn}-${filterMenuVersion}`} header={activeDataset.headers[filterColumn]} values={rows.map(row => row[filterColumn])} selected={activeColumnFilters[filterColumn]} onApply={applyColumnFilter} onReset={resetColumnFilter} onClose={() => setFilterOpen(false)} position={filterPosition} visible={filterPresence.visible}/> : null}
    {cancelConfirm ? <div className="import-confirm-backdrop"><section className="import-confirm" role="alertdialog" aria-modal="true" aria-labelledby="cancel-import-title"><span><AlertTriangle/></span><h2 id="cancel-import-title">{reviewMode ? 'Закрыть проверку данных?' : 'Отменить загрузку?'}</h2><p>{reviewMode ? 'Несохранённые изменения в таблице будут потеряны.' : 'Сопоставление столбцов и все исправления в таблице будут потеряны.'}</p><footer><button type="button" onClick={() => setCancelConfirm(false)}>Вернуться к таблице</button><button type="button" className="danger-button" onClick={onCancel}>{reviewMode ? 'Да, закрыть' : 'Да, отменить'}</button></footer></section></div> : null}
  </div>;
}
