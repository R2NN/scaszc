import { readFileSync } from 'node:fs';
import path from 'node:path';
import { engineerIdentity } from '../src/engineerPresentation.js';

const historicalProfiles = new Map();
const tokens = value => (Array.isArray(value) ? value : String(value || '').split('|')).map(item => String(item).trim()).filter(Boolean);
const sameTokens = (left, right) => JSON.stringify(tokens(left).sort()) === JSON.stringify(tokens(right).sort());
const rows = file => {
  const [header, ...lines] = readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const columns = header.split(';');
  return lines.map(line => Object.fromEntries(columns.map((column, index) => [column, line.split(';')[index]])));
};

function archiveProfiles(shift) {
  if (shift.plan?.provenance?.dataKind !== 'SYNTHETIC_INPUT_EXACT_PLAN') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shift.date || '')) throw new Error('Не указана дата архивного состава.');
  const key = `${shift.date}:${shift.plan.contentSha256}`;
  if (historicalProfiles.has(key)) return historicalProfiles.get(key);
  const directory = path.resolve(import.meta.dirname, '../../history', shift.date);
  const raw = JSON.parse(readFileSync(path.join(directory, 'final-exact.json'), 'utf8'));
  if (raw.content_sha256 !== shift.plan.contentSha256 || raw.validation?.status !== 'VALID' || raw.publication_allowed !== true) {
    throw new Error('Архив состава не соответствует проверенному плану.');
  }
  const common = path.join(directory, 'dataset/common');
  const skills = rows(path.join(common, 'engineer_skills.csv'));
  const equipment = rows(path.join(common, 'engineer_equipment.csv'));
  const offices = new Map(rows(path.join(common, 'offices.csv')).map(item => [item.office_id, item]));
  const result = new Map(rows(path.join(common, 'engineers.csv')).map(item => [item.engineer_id, {
    ...item, office: offices.get(item.start_office_id),
    skills: skills.filter(entry => entry.engineer_id === item.engineer_id).map(entry => entry.skill_id),
    equipment: equipment.filter(entry => entry.engineer_id === item.engineer_id).map(entry => entry.equipment_id),
  }]));
  historicalProfiles.set(key, result);
  return result;
}

/** Normalize retained profile fields without changing the saved shift or its plan. */
export function ratingPlanningShift(shift) {
  if (!shift) return shift;
  const archive = archiveProfiles(shift);
  const zones = new Map();
  for (const order of shift.orders || []) {
    if (!order.zone || !order.zoneId) continue;
    const ids = zones.get(order.zone) || new Set();
    ids.add(order.zoneId);
    zones.set(order.zone, ids);
  }
  return { ...shift, team: (shift.team || []).map(member => {
    const source = archive?.get(engineerIdentity(member));
    if (archive) {
      const office = source?.office;
      const coords = office && [Number(office.latitude), Number(office.longitude)];
      const legacyEquipment = sameTokens(member.equipment, member.sourceData?.equipment);
      if (!source || !office || member.shiftStart !== source.shift_start || member.shiftEnd !== source.shift_end
        || member.transport !== source.transport_type || !sameTokens(member.skills, source.skills)
        || member.startCoords?.length !== 2 || !member.startCoords.every((value, index) => Math.abs(value - coords[index]) < 1e-7)
        || member.zoneId && member.zoneId !== source.zone_id
        || !sameTokens(member.equipment, source.equipment) && !legacyEquipment) {
        throw new Error(`Профиль архивного инженера ${engineerIdentity(member)} изменился. Нужен новый проверенный план.`);
      }
      return { ...member, zoneId: source.zone_id, equipment: source.equipment,
        sourceData: { ...member.sourceData, max_jobs: Number(source.max_jobs), max_route_minutes: Number(source.max_route_minutes) } };
    }
    const ids = zones.get(member.zone);
    return { ...member,
      zoneId: member.zoneId || member.sourceData?.zone_id || (ids?.size === 1 ? [...ids][0] : undefined),
      equipment: tokens(member.equipment),
    };
  }) };
}
