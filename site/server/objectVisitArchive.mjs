import { readFile } from 'node:fs/promises';

let archive;
const normalized = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
/** Read saved schedules as schedules. Missing execution facts never become visits. */
export function objectArchivePlans(history, object, at, limit = 6) {
  const through = String(at).slice(0, 10);
  return (history.days || []).filter(day => day.date < through).sort((a, b) => b.date.localeCompare(a.date)).flatMap(day => {
    const orders = (day.orders || []).filter(order => order.regionId === object.regionId && normalized(order.address) === normalized(object.address));
    return orders.map(order => {
      const route = day.plan?.routes?.find(item => item.assignments?.some(assignment => String(assignment.orderId) === String(order.id)));
      const assignment = route?.assignments.find(item => String(item.orderId) === String(order.id));
      return { id: `${day.date}/${order.id}`, date: day.date, orderId: order.id, sourceId: order.sourceId, workType: order.workType, address: order.address, engineerId: route?.engineerId, engineerName: route?.engineerName, plannedStart: assignment?.plannedStart, plannedFinish: assignment?.plannedFinish, status: 'planned', executionConfirmed: false, dataKind: day.dataKind, source: 'analytics-history.json', sourceLabel: day.dataKind === 'SYNTHETIC_INPUT_EXACT_PLAN' ? 'Архив модельных дней · проверенный план' : 'Архивный план' };
    });
  }).slice(0, limit);
}
export async function loadObjectArchivePlans(object, at) {
  archive ||= readFile(new URL('../public/data/analytics-history.json', import.meta.url), 'utf8').then(JSON.parse).catch(error => { archive = null; throw error; });
  return objectArchivePlans(await archive, object, at);
}
