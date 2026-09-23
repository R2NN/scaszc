const SKILL_LABELS = {
  INSTALL: 'подключение',
  LOCAL: 'локальные работы',
  EMERGENCY: 'аварийные работы',
  UPSELL: 'дозаказ',
};

const minutes = value => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};
const time = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
const zoneOf = item => String(item?.zone || item?.zoneId || 'Без зоны').trim();
const skillOf = value => SKILL_LABELS[String(value || '').trim().toUpperCase()] || String(value || '').trim().toLocaleLowerCase('ru-RU');
const skillList = skills => {
  const names = skills.map(skill => `«${skill}»`);
  return names.length === 1 ? `навыком ${names[0]}` : `навыками ${names.slice(0, -1).join(', ')} и ${names.at(-1)}`;
};

function uncoveredInterval(engineer, peers, skill) {
  const start = minutes(engineer.shiftStart);
  const end = minutes(engineer.shiftEnd);
  if (start == null || end == null || end <= start) return null;
  const matching = peers.filter(peer => (peer.skills || []).some(value => skillOf(value) === skill))
    .map(peer => ({ start: minutes(peer.shiftStart), end: minutes(peer.shiftEnd) }))
    .filter(shift => shift.start != null && shift.end != null && shift.end > shift.start);
  const boundaries = matching.flatMap(shift => [Math.max(start, shift.start), Math.min(end, shift.end)])
    .filter(point => point > start && point < end);
  const points = [...new Set([start, end, ...boundaries])].sort((left, right) => left - right);
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (!matching.some(shift => shift.start <= from && shift.end >= to)) return `${time(from)}–${time(to)}`;
  }
  return null;
}

/**
 * Advise on releasing idle engineers using zone, skill and shift overlap.
 * This is a conservative staffing signal, not a validated emergency route.
 * @param {object} record Current planning record with team, orders and plan.
 * @param {Iterable<string>} releasedIds Engineers already marked as released.
 * @returns {Map<string, {level: 'keep' | 'review', reason: string}>}
 */
export function buildReserveReleaseAdvisories(record, releasedIds = []) {
  const routesWithWork = new Set((record?.plan?.routes || [])
    .filter(route => (route.assignments || []).length > 0)
    .map(route => String(route.engineerId)));
  const released = new Set([...releasedIds].map(String));
  const idle = (record?.team || []).filter(engineer => !routesWithWork.has(String(engineer.id)));
  const orders = record?.orders || [];
  const advisories = new Map();

  for (const engineer of idle) {
    const zone = zoneOf(engineer);
    const zoneOrders = orders.filter(order => zoneOf(order) === zone);
    const peers = idle.filter(other => String(other.id) !== String(engineer.id)
      && !released.has(String(other.id)) && zoneOf(other) === zone);
    const start = minutes(engineer.shiftStart);
    const end = minutes(engineer.shiftEnd);
    if (start == null || end == null || end <= start) {
      advisories.set(String(engineer.id), {
        level: 'keep',
        reason: `Не советуем снимать: время смены этой бригады не указано или некорректно. Нельзя понять, кто сможет заменить её в зоне «${zone}».`,
      });
      continue;
    }

    const demandSkills = new Set(zoneOrders.map(order => skillOf(order?.sourceData?.required_skill || order?.skill)));
    const relevantSkills = [...new Set((engineer.skills || []).map(skillOf))]
      .filter(skill => skill && (skill === 'аварийные работы' || demandSkills.has(skill)));
    const fullReplacement = relevantSkills.length ? peers.find(peer => {
      const peerStart = minutes(peer.shiftStart);
      const peerEnd = minutes(peer.shiftEnd);
      return peerStart != null && peerEnd != null && peerStart <= start && peerEnd >= end
        && relevantSkills.every(skill => (peer.skills || []).some(value => skillOf(value) === skill));
    }) : null;
    const uncovered = relevantSkills.map(skill => ({ skill, interval: uncoveredInterval(engineer, peers, skill) }))
      .find(item => item.interval);
    if (uncovered) {
      advisories.set(String(engineer.id), {
        level: 'keep',
        reason: `Советуем оставить: в зоне «${zone}» с ${uncovered.interval.replace('–', ' до ')} не будет другой свободной бригады с навыком «${uncovered.skill}».`,
      });
    } else if (!peers.length && zoneOrders.length) {
      advisories.set(String(engineer.id), {
        level: 'keep',
        reason: `Советуем оставить: после снятия в зоне «${zone}» не останется ни одной свободной бригады, хотя на этот день есть ${zoneOrders.length} заявок.`,
      });
    } else {
      advisories.set(String(engineer.id), {
        level: 'review',
        reason: fullReplacement
          ? `В зоне «${zone}» остаётся свободная бригада «${fullReplacement.name || fullReplacement.id}» с ${skillList(relevantSkills)} на всю смену с ${time(start)} до ${time(end)}. Эту бригаду можно рассмотреть для снятия со смены.`
          : relevantSkills.length
            ? `В зоне «${zone}» с ${time(start)} до ${time(end)} остаются другие свободные бригады с ${skillList(relevantSkills)}. Эту бригаду можно рассмотреть для снятия со смены.`
          : zoneOrders.length
            ? `В заявках зоны «${zone}» на этот день нет работ по навыкам этой бригады. Её можно рассмотреть для снятия со смены.`
            : `В зоне «${zone}» на этот день нет заявок. Эту бригаду можно рассмотреть для снятия со смены.`,
      });
    }
  }
  return advisories;
}
