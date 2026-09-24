import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizePlanningPriority } from '../src/planningPriority.js';

const normalize = value => String(value ?? '').trim();
const clock = value => normalize(value).match(/T(\d{2}:\d{2})/)?.[1] || normalize(value).slice(0, 5);
const id = item => normalize(item?.sourceId || item?.sourceData?.job_id || item?.sourceData?.engineer_id || item?.id).split(':').at(-1);
const skill = value => {
  const raw = normalize(value).toLocaleLowerCase('ru-RU');
  return { 'локальные работы': 'LOCAL', 'подключение': 'INSTALL', 'аварийные работы': 'EMERGENCY', 'дозаказ': 'UPSELL' }[raw] || raw.toUpperCase();
};
const transport = value => {
  const raw = normalize(value).toLocaleLowerCase('ru-RU');
  return { 'автомобиль': 'CAR', 'общественный транспорт': 'PUBLIC_TRANSIT', 'пешком': 'WALKING', 'велосипед': 'BICYCLE', auto: 'CAR', foot: 'WALKING', bike: 'BICYCLE' }[raw] || raw.toUpperCase();
};
const equipmentCode = value => {
  const raw = normalize(value).toLocaleLowerCase('ru-RU');
  return {
    'диагностический комплект': 'DIAG_SET', 'монтажный комплект': 'INSTALL_SET',
    'кабельный комплект': 'CABLE_SET', 'кабель': 'CABLE_PACK', 'роутер': 'ROUTER',
    'онт': 'ONT_GIGABIT', 'ont': 'ONT_GIGABIT', 'тв-приставка': 'TV_BOX',
  }[raw] || raw.toUpperCase();
};
const codes = value => normalize(value).split(/\s*[|;,·]\s*/).filter(Boolean).map(equipmentCode).sort().join('|');
const samePoint = (point, latitude, longitude) => Array.isArray(point) && point.length === 2 && Math.abs(Number(point[0]) - Number(latitude)) < 0.000001 && Math.abs(Number(point[1]) - Number(longitude)) < 0.000001;

/** Use a sealed artifact only when every model relevant input matches its source dataset. */
export function isCanonicalPlanningInput(payload, artifact, repositoryRoot = process.cwd()) {
  const orders = payload?.orders;
  const engineers = payload?.engineers;
  const ids = artifact?.canonical?.initialJobIds;
  const engineerIds = artifact?.canonical?.engineerIds;
  if (!Array.isArray(orders) || !Array.isArray(engineers) || !Array.isArray(ids) || !Array.isArray(engineerIds) || orders.length !== ids.length || engineers.length !== engineerIds.length) return false;
  if (payload.planningDate && normalize(payload.planningDate).slice(0, 10) !== normalize(artifact.plans?.initial?.planningAt).slice(0, 10)) return false;
  if (Array.isArray(payload.sharedInventory) && payload.sharedInventory.length) return false;
  const fixture = JSON.parse(readFileSync(path.join(repositoryRoot, 'public', 'test-data', 'beego-algorithm-initial.json'), 'utf8'));
  const jobs = new Map(fixture.jobs.map(item => [item.job_id, item]));
  const crew = new Map(fixture.engineers.map(item => [item.engineer_id, item]));
  if (new Set(orders.map(id)).size !== ids.length || new Set(engineers.map(id)).size !== engineerIds.length) return false;
  if (orders.some(item => {
    const source = jobs.get(id(item));
    const imported = item.sourceData;
    if (!source || normalize(imported?.job_id) !== source.job_id) return true;
    if (!['window_start', 'window_end', 'service_duration_min', 'priority', 'required_skill', 'required_transport', 'required_equipment', 'zone_id', 'latitude', 'longitude'].every(key => normalize(imported[key]) === normalize(source[key]))) return true;
    return clock(item.start) !== clock(source.window_start)
      || clock(item.end) !== clock(source.window_end)
      || Number(item.duration) !== Number(source.service_duration_min)
      || skill(item.skill) !== source.required_skill
      || normalizePlanningPriority(item.priority ?? imported.priority ?? source.priority) !== source.priority
      || transport(item.transport || source.required_transport) !== source.required_transport
      || normalize(item.zoneId || imported.zone_id) !== source.zone_id
      || !samePoint(item.coords, source.latitude, source.longitude)
      || (item.equipment && codes(item.equipment) !== codes(source.required_equipment));
  })) return false;
  if (engineers.some(item => {
    const source = crew.get(id(item));
    const imported = item.sourceData;
    if (!source || normalize(imported?.engineer_id) !== source.engineer_id) return true;
    return clock(item.shiftStart) !== clock(source.shift_start)
      || clock(item.shiftEnd) !== clock(source.shift_end)
      || transport(item.transport) !== source.transport
      || (item.startCoords && !samePoint(item.startCoords, source.start_latitude, source.start_longitude))
      || (!item.startCoords && normalize(imported.start_office_id) !== normalize(artifact.canonical.engineerModels?.[id(item)]?.start_office_id))
      || !Array.isArray(item.skills)
      || item.skills.map(skill).sort().join('|') !== source.skills.split('|').map(skill).sort().join('|')
      || (item.equipment && codes(item.equipment) !== codes(source.equipment));
  })) return false;
  return true;
}
