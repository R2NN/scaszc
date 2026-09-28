import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';

const FONT_CANDIDATES = [
  [process.env.BEEGO_PDF_FONT_REGULAR, process.env.BEEGO_PDF_FONT_BOLD],
  ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf'],
];
const colors = { ink: '#26303A', muted: '#687482', yellow: '#FFD21F', pale: '#FFF8D9', line: '#E1E6EC', red: '#B03D30', green: '#187353' };
const value = number => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(number || 0);
const safe = text => String(text ?? '').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim();
const EVENT_LABELS = { VISIT_CANCELLED: 'Визит отменён', ORDER_CANCELLED: 'Заявка отменена', NEW_ORDER: 'Новая заявка', ENGINEER_UNAVAILABLE: 'Бригада недоступна', ENGINEER_REPLACED: 'Замена бригады', CAPACITY_ADDED: 'Добавлена бригада', PLAN_ROLLBACK: 'План восстановлен', PLAN_REBUILT: 'План пересчитан' };
const STATUS_LABELS = { completed: 'Выполнено', not_completed: 'Не выполнено', started: 'В работе', no_fact: 'Без итоговой отметки' };
const minutes = time => { const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || '')); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
const duration = (start, end) => { const from = minutes(start); const to = minutes(end); return from == null || to == null ? 0 : Math.max(0, to - from); };
const grouped = (items, key) => [...items.reduce((map, item) => map.set(key(item) || 'Не указано', (map.get(key(item) || 'Не указано') || 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));

export function shiftReportData(shift) {
  if (!shift?.plan) throw new Error('Для отчёта нужен опубликованный план смены.');
  const orderById = new Map((shift.versions || []).flatMap(version => version.orders || []).concat(shift.orders || []).map(order => [String(order.id), order]));
  const latestFact = new Map((shift.facts || []).map(fact => [String(fact.orderId), fact]));
  const assignments = (shift.plan.routes || []).flatMap(route => (route.assignments || []).map(item => ({ ...item, engineerId: route.engineerId })));
  const assignedIds = new Set(assignments.map(item => String(item.orderId)));
  const cancelled = new Set((shift.events || []).filter(event => event.type === 'ORDER_CANCELLED').map(event => String(event.payload?.orderId)));
  const unassigned = (shift.plan.unassigned || []).map(item => ({ ...item, order: orderById.get(String(item.orderId)) }));
  const completed = [...latestFact.values()].filter(fact => fact.status === 'completed').length;
  const notCompleted = [...latestFact.values()].filter(fact => fact.status === 'not_completed').length;
  const hasFact = Boolean(shift.factLog?.length);
  const visits = (shift.plan.routes || []).flatMap(route => (route.assignments || []).map((item, index) => {
    const order = orderById.get(String(item.orderId));
    const fact = latestFact.get(String(item.orderId));
    return { orderId: String(item.orderId), sourceId: safe(order?.sourceId || order?.id || item.orderId), name: safe(order?.name || order?.sourceId || item.orderId), address: safe(order?.address), engineerId: String(route.engineerId), crew: safe(route.engineerName || shift.team?.find(engineer => String(engineer.id) === String(route.engineerId))?.name || route.engineerId), zone: safe(order?.zone), skill: safe(order?.skill), window: `${order?.start || '—'}–${order?.end || '—'}`, planned: `${item.plannedStart || '—'}–${item.plannedFinish || '—'}`, position: item.position || index + 1, status: fact?.status || 'no_fact', factTime: fact?.time || '', reason: safe(fact?.reason), travelMinutes: Number(item.travelMinutes) || 0, workMinutes: duration(item.plannedStart, item.plannedFinish) || Number(order?.duration) || 0 };
  }));
  const totalTravelMinutes = visits.reduce((sum, visit) => sum + visit.travelMinutes, 0);
  const totalWorkMinutes = visits.reduce((sum, visit) => sum + visit.workMinutes, 0);
  const activeCrews = (shift.plan.routes || []).filter(route => route.assignments?.length).length;
  const dailyTotal = assignedIds.size + unassigned.length;
  const completionRate = hasFact && assignedIds.size ? Math.round(completed / assignedIds.size * 1000) / 10 : null;
  const assignmentRate = dailyTotal ? Math.round(assignedIds.size / dailyTotal * 1000) / 10 : 0;
  const byHour = Array.from({ length: 13 }, (_, offset) => {
    const hour = offset + 7;
    return { hour: `${String(hour).padStart(2, '0')}:00`, count: visits.filter(visit => Math.floor((minutes(visit.planned.split('–')[0]) ?? -1) / 60) === hour).length };
  });
  const windowRisks = visits.filter(visit => {
    const order = orderById.get(visit.orderId);
    const plannedStart = minutes(visit.planned.split('–')[0]);
    const windowEnd = minutes(order?.end);
    return windowEnd != null && plannedStart != null && plannedStart >= windowEnd - 15;
  }).map(visit => ({ name: visit.name, crew: visit.crew, window: visit.window, planned: visit.planned }));
  const urgentOpen = (shift.orders || []).filter(order => order.priority === 'Авария' && !cancelled.has(String(order.id)) && (hasFact ? latestFact.get(String(order.id))?.status !== 'completed' : !assignedIds.has(String(order.id)))).map(order => ({ name: safe(order.name || order.sourceId || order.id), status: assignedIds.has(String(order.id)) ? 'Без отметки о выполнении' : 'В очереди' }));
  const eventCounts = grouped((shift.events || []).filter(event => event.type !== 'PLAN_REBUILT'), event => EVENT_LABELS[event.type] || event.type);
  const plannedMinutes = totalWorkMinutes + totalTravelMinutes;
  const capacityMinutes = (shift.team || []).reduce((sum, engineer) => sum + duration(engineer.shiftStart, engineer.shiftEnd), 0);
  const analysis = { assignmentRate, completionRate, activeCrews, idleCrews: Math.max(0, (shift.team || []).length - activeCrews), plannedMinutes, capacityMinutes, capacityLoad: capacityMinutes ? Math.round(plannedMinutes / capacityMinutes * 100) : null, byHour, windowRisks, urgentOpen, eventCounts };
  return {
    date: shift.date, regionId: shift.regionId, regionName: safe(shift.orders?.[0]?.regionName || shift.team?.[0]?.regionName || shift.regionId), revision: shift.revision, hasFact,
    counts: { all: (shift.orders || []).length + cancelled.size, assigned: assignedIds.size, unassigned: unassigned.length, completed, notCompleted, withoutFact: hasFact ? assignments.filter(item => !['completed', 'not_completed'].includes(latestFact.get(String(item.orderId))?.status)).length : null, cancelled: cancelled.size },
    crews: (shift.team || []).map(engineer => { const route = (shift.plan.routes || []).find(item => String(item.engineerId) === String(engineer.id)); const crewVisits = visits.filter(item => item.engineerId === String(engineer.id)); return { id: engineer.id, name: safe(engineer.name || route?.engineerName || engineer.id), shift: `${engineer.shiftStart || route?.shiftStart || '—'}–${engineer.shiftEnd || route?.shiftEnd || '—'}`, shiftMinutes: duration(engineer.shiftStart || route?.shiftStart, engineer.shiftEnd || route?.shiftEnd), status: /недоступ/i.test(engineer.status || '') ? 'Недоступна' : route?.assignments?.length ? 'В маршруте' : 'Без маршрута', visits: route?.assignments?.length || 0, completed: crewVisits.filter(item => item.status === 'completed').length, notCompleted: crewVisits.filter(item => item.status === 'not_completed').length, travelMinutes: crewVisits.reduce((sum, item) => sum + item.travelMinutes, 0), workMinutes: crewVisits.reduce((sum, item) => sum + item.workMinutes, 0), distanceKm: Number(route?.distanceKm) || 0, assignments: (route?.assignments || []).map(item => ({ name: safe(orderById.get(String(item.orderId))?.name || item.orderId), time: `${item.plannedStart || '—'}–${item.plannedFinish || '—'}`, status: latestFact.get(String(item.orderId))?.status || 'no_fact' })) }; }),
    visits,
    byZone: grouped(visits, item => item.zone),
    bySkill: grouped(visits, item => item.skill),
    unassigned: unassigned.map(item => ({ name: safe(item.order?.name || item.orderId), window: `${item.order?.start || '—'}–${item.order?.end || '—'}`, reason: safe(item.reason || item.explanation || item.reasonCode || 'Причина не указана') })),
    failures: [...latestFact.values()].filter(fact => fact.status === 'not_completed').map(fact => ({ name: safe(orderById.get(String(fact.orderId))?.name || fact.orderId), time: fact.time, reason: safe(fact.reason) })),
    withoutFact: hasFact ? assignments.filter(item => !['completed', 'not_completed'].includes(latestFact.get(String(item.orderId))?.status)).map(item => ({ name: safe(orderById.get(String(item.orderId))?.name || item.orderId), time: `${item.plannedStart || '—'}–${item.plannedFinish || '—'}` })) : [],
    cancelled: (shift.events || []).filter(event => event.type === 'ORDER_CANCELLED').map(event => ({ name: safe(orderById.get(String(event.payload?.orderId))?.name || event.payload?.orderId), time: event.time, reason: safe(event.reason) })),
    events: (shift.events || []).map(event => ({ time: event.time, type: EVENT_LABELS[event.type] || event.type, reason: safe(event.reason) })),
    totalKm: (shift.plan.routes || []).reduce((sum, route) => sum + (Number(route.distanceKm) || 0), 0), totalTravelMinutes, totalWorkMinutes,
    analysis,
  };
}

async function createLegacyShiftPdf(shift, previous = null) {
  const report = shiftReportData(shift);
  const fonts = FONT_CANDIDATES.find(pair => pair.every(path => path && existsSync(path)));
  if (!fonts) throw new Error('На сервере не найден кириллический шрифт для PDF. Задайте BEEGO_PDF_FONT_REGULAR и BEEGO_PDF_FONT_BOLD.');
  const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true, info: { Title: `BeeGo — отчёт за ${report.date}`, Author: 'BeeGo' } });
  doc.registerFont('regular', fonts[0]); doc.registerFont('bold', fonts[1]);
  const buffers = [];
  doc.on('data', part => buffers.push(part));
  const finished = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(buffers))); doc.on('error', reject); });
  const width = doc.page.width - 84;
  const newPage = () => { doc.addPage(); doc.y = 48; };
  const ensure = height => { if (doc.y + height > doc.page.height - 58) newPage(); };
  const text = (content, size = 10, opts = {}) => { doc.font(opts.bold ? 'bold' : 'regular').fontSize(size).fillColor(opts.color || colors.ink).text(safe(content), 42, doc.y, { width, lineGap: opts.lineGap ?? 3, ...opts }); };
  const section = title => { ensure(52); doc.moveDown(0.8); doc.font('bold').fontSize(13).fillColor(colors.ink).text(title, 42, doc.y, { width }); doc.moveDown(0.55); doc.moveTo(42, doc.y).lineTo(42 + width, doc.y).strokeColor(colors.line).lineWidth(1).stroke(); doc.moveDown(0.6); };
  const row = (left, right, options = {}) => { ensure(38); const y = doc.y; doc.font(options.bold ? 'bold' : 'regular').fontSize(10).fillColor(colors.ink).text(safe(left), 42, y, { width: width * 0.7 }); doc.font(options.bold ? 'bold' : 'regular').fillColor(options.color || colors.ink).text(safe(right), 42 + width * 0.7, y, { width: width * 0.3, align: 'right' }); doc.y = Math.max(doc.y, y + 19); };
  const detail = (title, description, note = '') => {
    const height = 13 + doc.font('bold').fontSize(9.5).heightOfString(safe(title), { width: width - 12 }) + doc.font('regular').fontSize(8.5).heightOfString(safe(description), { width: width - 12 }) + (note ? doc.heightOfString(safe(note), { width: width - 12 }) : 0);
    ensure(Math.min(height + 10, doc.page.height - 110));
    doc.font('bold').fontSize(9.5).fillColor(colors.ink).text(safe(title), 42, doc.y, { width: width - 12 });
    doc.moveDown(0.18); text(description, 8.5, { color: colors.muted, lineGap: 2 });
    if (note) { doc.moveDown(0.1); text(note, 8.5, { color: colors.red, lineGap: 2 }); }
    doc.moveDown(0.35);
    doc.moveTo(42, doc.y).lineTo(42 + width, doc.y).strokeColor(colors.line).lineWidth(0.5).stroke();
    doc.moveDown(0.4);
  };
  const progress = (title, segments) => {
    ensure(53);
    const y = doc.y;
    doc.font('bold').fontSize(10).fillColor(colors.ink).text(title, 42, y, { width });
    const total = Math.max(1, segments.reduce((sum, item) => sum + item.value, 0));
    let x = 42;
    const barY = y + 22;
    doc.roundedRect(42, barY, width, 12, 6).fill('#EFF2F5');
    for (const item of segments) {
      const segmentWidth = width * item.value / total;
      if (segmentWidth > 0) { doc.rect(x, barY, segmentWidth, 12).fill(item.color); x += segmentWidth; }
    }
    doc.y = y + 41;
    text(segments.map(item => `${item.label}: ${item.value}`).join('   '), 8.5, { color: colors.muted });
    doc.moveDown(0.55);
  };
  const chart = (title, items, labelWidth = 130) => {
    section(title);
    const max = Math.max(1, ...items.map(item => item.value));
    for (const item of items) {
      ensure(27);
      const y = doc.y;
      doc.font('regular').fontSize(9).fillColor(colors.ink).text(safe(item.label), 42, y + 3, { width: labelWidth - 8, ellipsis: true });
      doc.roundedRect(42 + labelWidth, y + 5, width - labelWidth - 30, 9, 4).fill('#EEF1F4');
      if (item.value > 0) doc.roundedRect(42 + labelWidth, y + 5, Math.max(5, (width - labelWidth - 30) * item.value / max), 9, 4).fill(item.color || colors.yellow);
      doc.font('bold').fontSize(9).fillColor(colors.ink).text(String(item.value), 42 + width - 27, y + 1, { width: 27, align: 'right' });
      doc.y = y + 25;
    }
    doc.moveDown(0.3);
  };
  doc.rect(0, 0, doc.page.width, 13).fill(colors.yellow);
  doc.y = 47; text('BeeGo!  /  ОТЧЁТ ДИСПЕТЧЕРА', 10, { bold: true, color: '#8C6B00' }); doc.moveDown(0.8);
  text(report.hasFact ? 'Итоги дня' : 'План дня - без факта', 23, { bold: true }); doc.moveDown(0.35);
  const readableDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${report.date}T12:00:00`));
  text(`${readableDate}  /  ${report.regionName}  /  версия плана ${report.revision}`, 10, { color: colors.muted }); doc.moveDown(1.2);
  const summary = report.hasFact
    ? `${report.counts.completed} из ${report.counts.assigned} визитов подтверждены. ${report.counts.notCompleted} не выполнено, ${report.counts.withoutFact} без итоговой отметки, ${report.counts.unassigned} в очереди.`
    : `${report.counts.assigned} из ${report.counts.assigned + report.counts.unassigned} заявок назначены. Факт визитов не внесён - выполнение этим отчётом не подтверждается.`;
  const boxY = doc.y; doc.roundedRect(42, boxY, width, 64, 10).fill(colors.pale); doc.font('bold').fontSize(11).fillColor(colors.ink).text(safe(summary), 56, boxY + 15, { width: width - 28, lineGap: 3 }); doc.y = boxY + 73;
  section('Ключевые показатели дня');
  const cards = [
    ['Назначено', `${report.counts.assigned}`, `${report.analysis.assignmentRate}% активных заявок`],
    ['Очередь', `${report.counts.unassigned}`, 'требует решения'],
    [report.hasFact ? 'Выполнено' : 'Бригад в маршруте', `${report.hasFact ? report.counts.completed : report.analysis.activeCrews}`, report.hasFact ? `${report.analysis.completionRate}% назначенных` : `из ${report.crews.length}`],
    ['Не выполнено', report.hasFact ? `${report.counts.notCompleted}` : '—', report.hasFact ? 'с отметкой диспетчера' : 'факт не внесён'],
    ['Без отметки', report.hasFact ? `${report.counts.withoutFact}` : '—', report.hasFact ? 'нельзя считать завершёнными' : 'факт не внесён'],
    ['Пробег по плану', `${value(report.totalKm)} км`, `${value(report.totalTravelMinutes / 60)} ч в дороге`],
  ];
  const cardGap = 9, cardWidth = (width - cardGap * 2) / 3, cardHeight = 68;
  const cardsTop = doc.y;
  cards.forEach(([label, number, note], index) => {
    const x = 42 + (index % 3) * (cardWidth + cardGap), y = cardsTop + Math.floor(index / 3) * (cardHeight + cardGap);
    doc.roundedRect(x, y, cardWidth, cardHeight, 8).fill('#F7F9FB');
    doc.font('regular').fontSize(8).fillColor(colors.muted).text(label, x + 11, y + 9, { width: cardWidth - 22 });
    doc.font('bold').fontSize(17).fillColor(colors.ink).text(number, x + 11, y + 24, { width: cardWidth - 22 });
    doc.font('regular').fontSize(7.4).fillColor(colors.muted).text(note, x + 11, y + 50, { width: cardWidth - 22 });
  });
  doc.y = cardsTop + cardHeight * 2 + cardGap + 12;
  progress('Состояние назначенных визитов', report.hasFact ? [
    { label: 'Выполнено', value: report.counts.completed, color: colors.yellow },
    { label: 'Не выполнено', value: report.counts.notCompleted, color: '#E76959' },
    { label: 'Без отметки', value: report.counts.withoutFact, color: '#B8C1CB' },
  ] : [{ label: 'Запланировано, факт отсутствует', value: report.counts.assigned, color: colors.yellow }]);
  chart('Когда начинается плановая работа', report.analysis.byHour.filter(item => item.count > 0).map(item => ({ label: item.hour, value: item.count })).slice(0, 12), 72);
  chart('Где сосредоточены визиты', report.byZone.slice(0, 5).map(([label, count]) => ({ label, value: count })), 160);
  section('Ресурсы и изменения');
  row('Бригады с маршрутом / без маршрута', `${report.analysis.activeCrews} / ${report.analysis.idleCrews}`);
  row('Плановая загрузка времени бригад', report.analysis.capacityLoad == null ? 'Нет данных о сменах' : `${report.analysis.capacityLoad}%`);
  row('Плановое время визитов / в дороге', `${value(report.totalWorkMinutes / 60)} / ${value(report.totalTravelMinutes / 60)} ч`);
  row('Изменений плана / отменённых заявок', `${report.analysis.eventCounts.reduce((sum, item) => sum + item[1], 0)} / ${report.counts.cancelled}`);
  if (previous) {
    section(`Сравнение с ${previous.date}`);
    row('Доля назначенных заявок', `${report.analysis.assignmentRate}%  (${report.analysis.assignmentRate - previous.analysis.assignmentRate >= 0 ? '+' : ''}${report.analysis.assignmentRate - previous.analysis.assignmentRate} п.п.)`);
    row('Очередь', `${report.counts.unassigned}  (${report.counts.unassigned - previous.counts.unassigned >= 0 ? '+' : ''}${report.counts.unassigned - previous.counts.unassigned})`);
    if (report.hasFact && previous.hasFact) row('Доля выполненных', `${report.analysis.completionRate}%  (${report.analysis.completionRate - previous.analysis.completionRate >= 0 ? '+' : ''}${report.analysis.completionRate - previous.analysis.completionRate} п.п.)`);
  }
  newPage();
  text('ТРЕБУЕТ ВНИМАНИЯ', 10, { bold: true, color: '#8C6B00' }); doc.moveDown(0.8);
  text('Исключения и решения', 21, { bold: true }); doc.moveDown(0.5);
  text('В этом разделе только отклонения, которые требуют проверки диспетчера. Полный поимённый реестр визитов намеренно не дублируется.', 9, { color: colors.muted });
  const issues = [
    ['Не назначены', report.unassigned, item => `${item.window} / ${item.reason}`],
    ['Не выполнены', report.failures, item => `${item.time || 'время не указано'} / ${item.reason || 'причина не указана'}`],
    ['Без итоговой отметки', report.hasFact ? report.withoutFact : [], item => `План ${item.time}`],
    ['Начало у конца окна', report.analysis.windowRisks, item => `Окно ${item.window}, план ${item.planned}`],
    [report.hasFact ? 'Срочные без подтверждения' : 'Срочные в очереди', report.analysis.urgentOpen, item => item.status],
  ];
  let anyIssue = false;
  for (const [heading, items, describe] of issues) {
    if (!items.length) continue;
    anyIssue = true;
    section(`${heading} (${items.length})`);
    for (const item of items.slice(0, 5)) detail(item.name, describe(item));
    if (items.length > 5) { text(`Ещё ${items.length - 5} - откройте данные смены для полного списка.`, 8.5, { color: colors.muted }); doc.moveDown(0.5); }
  }
  if (!anyIssue) { section('Отклонения'); text('Критичных исключений по доступным данным нет.', 10, { color: colors.muted }); }
  if (report.analysis.eventCounts.length) {
    section('Изменения в течение дня');
    for (const [label, count] of report.analysis.eventCounts.slice(0, 7)) row(label, String(count));
  }
  section('Источник и ограничения');
  text(`Отчёт относится только к ${report.date}, сохранённая версия плана ${report.revision}. Назначения, очередь, события и отметки получены из одного сохранённого снимка смены. Сравнение использует предыдущий сохранённый день в том же регионе.`, 9, { color: colors.muted, lineGap: 3 });
  doc.moveDown(0.55);
  text(report.hasFact ? 'Выполнение подтверждено только итоговой отметкой диспетчера. Время и пробег маршрутов остаются плановыми.' : 'Итоговых фактических отметок нет. Этот документ нельзя использовать как подтверждение выполненных работ.', 9, { color: colors.muted, lineGap: 3 });
  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index += 1) { doc.switchToPage(index); doc.font('regular').fontSize(8).fillColor(colors.muted).text(`BeeGo!  ·  ${report.date}  ·  ${index + 1}/${pages.count}`, 42, doc.page.height - 55, { width, align: 'right', lineBreak: false }); }
  doc.end();
  return finished;
}

export async function createShiftPdf(shift, previous = null, options = {}) {
  const { createDispatcherPdf } = await import('./dispatcherPdf.mjs');
  return createDispatcherPdf(shift, { ...options, previous });
}
