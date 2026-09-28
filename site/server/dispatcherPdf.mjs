import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { buildDispatcherReportModel } from './dispatcherReportModel.mjs';

const C = { graphite: '#1D2127', ink: '#222B36', muted: '#66717F', yellow: '#FFCC21', cream: '#FBFBF8', pale: '#FFF4CB', red: '#C9463D', pink: '#FFF0EC', green: '#267A4B', greenPale: '#E8F5EC', blue: '#3977A8', bluePale: '#EAF3F9', line: '#DEE4E9', white: '#FFFFFF' };
const fmt = (n, digits = 0) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(n) || 0);
const money = n => `${fmt(Math.round(n))} ₽`;
const pct = n => `${fmt(n, 1)}%`;
const hours = n => `${fmt(n / 60, 1)} ч`;
const longDuration = n => `${Math.floor(n / 60)} ч ${String(Math.round(n % 60)).padStart(2, '0')} мин`;
const date = value => value ? `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}` : 'Не указано';
const val = value => String(value ?? '').trim() || 'Не указан';
const clean = value => val(value).replace(/<[^>]*>/g, '').replace(/[\$~]/g, '').replace(/\\(?:text|%)/g, '').replace(/\s+/g, ' ');
const window = (a, b) => /^\d{2}:\d{2}$/.test(a || '') && /^\d{2}:\d{2}$/.test(b || '') ? `${a}-${b}` : 'Не указано';
const sid = order => val(order?.sourceId || String(order?.id || '').split(':').at(-1));
const fonts = [
  [process.env.BEEGO_PDF_FONT_REGULAR, process.env.BEEGO_PDF_FONT_BOLD],
  ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf'],
];

export function reportMode(shift) { return buildDispatcherReportModel(shift, { history: [] }).mode; }

export async function createDispatcherPdf(shift, options = {}) {
  const m = buildDispatcherReportModel(shift, options);
  const pair = fonts.find(item => item.every(file => file && existsSync(file)));
  if (!pair) throw new Error('Не найден кириллический шрифт PDF. Задайте BEEGO_PDF_FONT_REGULAR и BEEGO_PDF_FONT_BOLD.');
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, compress: true, info: { Title: `BeeGo — ${m.mode === 'plan' ? 'оперативный план' : m.mode === 'partial' ? 'оперативный статус' : 'итоги смены'} ${date(shift.date)}`, Author: m.author, Subject: 'Аналитический отчёт диспетчера' } });
  doc.registerFont('regular', pair[0]).registerFont('bold', pair[1]);
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const W = 595.28, H = 841.89, L = 38, R = W - L, CW = R - L;
  const drawText = (s, x, y, w, size = 9.5, color = C.ink, bold = false, opts = {}) => {
    doc.font(bold ? 'bold' : 'regular').fontSize(size).fillColor(color);
    doc.text(clean(s), x, y, { width: w, lineGap: 2.2, ...opts });
    return doc.y;
  };
  const line = (x1, y, x2, color = C.line, width = 0.8) => doc.moveTo(x1, y).lineTo(x2, y).lineWidth(width).strokeColor(color).stroke();
  const box = (x, y, w, h, fill = C.white, stroke = C.line, radius = 10) => { doc.roundedRect(x, y, w, h, radius).fillAndStroke(fill, stroke); };
  const label = (s, x, y, w, color = C.muted) => drawText(s.toLocaleUpperCase('ru-RU'), x, y, w, 8, color, true, { characterSpacing: 0.65 });
  const section = (n, title, y) => { label(`${n} / ${title}`, L, y, CW, C.blue); line(L, y + 18, R); };
  const para = (text, x, y, w, size = 9.5, color = C.ink, bold = false) => drawText(text, x, y, w, size, color, bold);
  const badge = (text, x, y, w, fill, color) => { box(x, y, w, 22, fill, fill, 7); drawText(text, x + 7, y + 6, w - 14, 8, color, true, { align: 'center' }); };
  const page = (number, heading, subtitle) => {
    doc.addPage(); doc.rect(0, 0, W, H).fill(C.cream); doc.rect(0, 0, W, 94).fill(C.graphite); doc.rect(0, 94, W, 5).fill(C.yellow);
    label('BeeGo!  /  Диспетчерский отчёт', L, 20, CW, C.yellow);
    drawText(heading, L, 38, CW, 20, C.white, true);
    drawText(subtitle, L, 72, CW, 9, '#CBD2D8');
    line(L, 805, R); drawText(`${date(shift.date)}  •  план v${shift.revision}  •  ${m.mode === 'plan' ? 'план' : m.mode === 'partial' ? 'частичный факт' : 'полный факт'}`, L, 813, 400, 8, C.muted);
    drawText(`${number} / 8`, R - 60, 813, 60, 8, C.muted, true, { align: 'right' });
  };
  const kpi = (x, y, w, title, figure, note, color = C.ink) => {
    box(x, y, w, 75); label(title, x + 12, y + 11, w - 24); drawText(figure, x + 12, y + 28, w - 24, 20, color, true); drawText(note, x + 12, y + 56, w - 24, 8, C.muted);
  };
  const strip = (x, y, w, h, title, body, tone = 'blue') => {
    const bg = tone === 'red' ? C.pink : tone === 'green' ? C.greenPale : tone === 'yellow' ? C.pale : C.bluePale;
    const fg = tone === 'red' ? C.red : tone === 'green' ? C.green : tone === 'yellow' ? '#805F00' : C.blue;
    box(x, y, w, h, bg, bg); label(title, x + 12, y + 9, w - 24, fg); para(body, x + 12, y + 26, w - 24, 9.2);
  };
  const tableHeader = (cols, y, widths, x = L) => {
    doc.roundedRect(x, y, widths.reduce((a, b) => a + b, 0), 24, 5).fill(C.graphite);
    let xx = x; cols.forEach((name, i) => { drawText(name, xx + 6, y + 7, widths[i] - 12, 8, C.white, true); xx += widths[i]; });
  };
  const tableRow = (cells, y, widths, h = 38, x = L, tint = C.white) => {
    doc.rect(x, y, widths.reduce((a, b) => a + b, 0), h).fill(tint); line(x, y + h, x + widths.reduce((a, b) => a + b, 0));
    let xx = x; cells.forEach((value, i) => { drawText(value, xx + 6, y + 7, widths[i] - 12, 8.5, C.ink, i === 0); xx += widths[i]; });
  };
  const bar = (x, y, w, filled, color) => { box(x, y, w, 9, '#ECF0F2', '#ECF0F2', 4); if (filled > 0) doc.roundedRect(x, y, Math.max(4, Math.min(w, w * filled)), 9, 4).fill(color); };

  // Page 1: the two-minute brief.
  page(1, m.mode === 'plan' ? 'ОПЕРАТИВНЫЙ ПЛАН СМЕНЫ' : m.mode === 'partial' ? 'ОПЕРАТИВНЫЙ СТАТУС СМЕНЫ' : 'ИТОГИ СМЕНЫ', m.mode === 'plan' ? 'Предсменный брифинг диспетчера' : 'Сводка и решения диспетчера');
  drawText(`${date(shift.date)}  •  ${m.summary.regionName}  •  регион ${shift.regionId}  •  версия ${shift.revision}`, L, 108, 360, 9, C.muted);
  drawText(`Сформировано ${new Date(m.generatedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`, 365, 108, R - 365, 8, C.muted, false, { align: 'right' });
  badge(m.mode === 'plan' ? 'ПЛАНОВЫЙ СНИМОК — ФАКТИЧЕСКИЕ СТАТУСЫ НЕ ВНЕСЕНЫ' : m.mode === 'partial' ? `ЧАСТИЧНЫЙ ФАКТ · ${m.finalCount}/${m.summary.counts.assigned} ИТОГОВЫХ ОТМЕТОК` : 'ПОЛНЫЙ ФАКТ ПО НАЗНАЧЕННЫМ ВИЗИТАМ', L, 131, CW, m.mode === 'full' ? C.greenPale : C.pale, m.mode === 'full' ? C.green : '#725500');
  const gap = 9, kw = (CW - gap * 3) / 4;
  kpi(L, 164, kw, 'Назначено', `${m.summary.counts.assigned}/${m.summary.counts.assigned + m.summary.counts.unassigned}`, `${pct(m.summary.analysis.assignmentRate)} заявок`);
  kpi(L + kw + gap, 164, kw, 'Решить', `${m.summary.counts.unassigned}`, 'в открытой очереди', m.summary.counts.unassigned ? C.red : C.green);
  kpi(L + (kw + gap) * 2, 164, kw, 'В маршрутах', `${m.summary.analysis.activeCrews}/${m.summary.crews.length}`, 'бригад сегодня');
  kpi(L + (kw + gap) * 3, 164, kw, 'Загрузка', `${m.summary.analysis.capacityLoad ?? '—'}%`, 'работа + дорога');
  const criticalOrder = m.critical?.order;
  strip(L, 251, CW, 58, 'Главный вывод', m.summary.counts.unassigned ? `Общего дефицита мощности нет: ${m.idle.length} бригады без маршрута. Очередь требует проверки сочетания навыка, территории и клиентского окна.` : 'Очередь пуста. Контролируйте запас до правой границы клиентских окон и фактические отметки.', m.summary.counts.unassigned ? 'yellow' : 'green');
  section('01', 'Что требует решения', 322);
  const actions = [
    m.critical ? ['КРИТИЧНО', `${sid(criticalOrder)} без назначения`, `Проверить бригаду с навыком ${val(criticalOrder.skill)} и допустимый маршрут; при отсутствии — связаться с клиентом.`, `Диспетчер · до ${val(criticalOrder.start)}`] : ['КОНТРОЛЬ', 'Открытой очереди нет', 'Проверить новые заявки при изменении плана.', 'Диспетчер · до выхода'],
    m.risks.length ? [m.risks[0].level.toUpperCase(), `Окно ${sid(m.risks[0].order)} · запас ${m.risks[0].slack} мин`, 'Следить за предыдущим визитом и переездом, предупредить клиента до каскадного сдвига.', `Диспетчер · до ${val(m.risks[0].assignment.plannedStart)}`] : ['КОНТРОЛЬ', 'Рисков по окнам не найдено', 'Сверить новые факты с планом.', 'Диспетчер · в смену'],
    m.mode !== 'full' ? ['ДАННЫЕ', m.mode === 'plan' ? 'Факт визитов не внесён' : `Без итоговой отметки: ${m.summary.counts.withoutFact}`, 'Запросить итоговые статусы; план нельзя трактовать как выполнение.', 'Диспетчер · после смены'] : ['ДАННЫЕ', 'Итоговые статусы внесены', 'Проверить причины неуспеха и полноту временных меток.', 'Диспетчер · при закрытии'],
  ];
  actions.forEach((row, i) => { const y = 346 + i * 51; box(L, y, CW, 46, i === 0 && m.critical ? C.pink : C.white); label(row[0], L + 10, y + 8, 80, i === 0 && m.critical ? C.red : C.blue); drawText(row[1], L + 91, y + 7, 182, 9, C.ink, true); drawText(row[2], L + 91, y + 22, 285, 7.8, C.muted); drawText(row[3], R - 137, y + 8, 126, 7.8, C.ink, true, { align: 'right' }); });
  section('02', 'Критическая заявка и территория', 510);
  box(L, 535, 321, 249, C.white);
  if (criticalOrder) {
    drawText(sid(criticalOrder), L + 12, 548, 230, 15, C.ink, true);
    const fields = [
      ['Тип / приоритет', `${val(criticalOrder.workType || criticalOrder.serviceType)} · ${val(criticalOrder.priority)}`],
      ['Окно / работа', `${window(criticalOrder.start, criticalOrder.end)} · ${val(criticalOrder.duration)} мин`],
      ['Адрес', val(criticalOrder.address)],
      ['Клиент / телефон', `${val(criticalOrder.clientName || criticalOrder.customerName)} / ${val(criticalOrder.phone || criticalOrder.clientPhone)}`],
      ['Договор / куратор', `${val(criticalOrder.contractNumber)} / ${val(criticalOrder.contractCurator)}`],
      ['Причина', val(m.critical.item.reason)],
    ];
    let yy = 576;
    fields.forEach(([name, value]) => { label(name, L + 12, yy, 90); const end = drawText(value, L + 107, yy - 1, 202, 8.2, C.ink); yy = Math.max(yy + 19, end + 4); });
    drawText('Контакты/договор: данные отсутствуют в карточке заявки.', L + 12, 722, 296, 7.8, C.muted);
    drawText('Действие: проверить доступных по навыку, затем согласовать решение с клиентом до окна.', L + 12, 740, 296, 8.1, C.ink, true);
    if (m.url) { box(L + 11, 764, 148, 18, C.pale, C.yellow, 5); drawText('Открыть заявку в BeeGo  ↗', L + 17, 768, 138, 7.7, C.ink, true, { link: m.url }); doc.link(L + 11, 764, 148, 18, m.url); }
  } else drawText('Неназначенных заявок нет.', L + 12, 550, 290, 10);
  box(371, 535, R - 371, 249, C.white); label('Схема территорий', 384, 547, R - 397);
  const zoneColors = [C.red, C.yellow, C.blue];
  m.zones.slice(0, 3).forEach((zone, i) => {
    const yy = 582 + i * 57; const share = m.summary.counts.assigned ? zone.count / m.summary.counts.assigned : 0;
    doc.circle(397, yy + 8, 9 + share * 16).fill(zoneColors[i]);
    drawText(zone.name, 424, yy - 2, R - 437, 9, C.ink, true);
    drawText(`${zone.count} · ${pct(share * 100)}`, 424, yy + 13, R - 437, 8, C.muted);
  });
  if (m.critical) drawText(`◆ ${sid(criticalOrder)} · без назначения`, 384, 755, R - 397, 7.7, C.red, true);

  // Page 2: risks are evaluated against visit START, never conflated with completion.
  page(2, 'РИСКИ И КОНТРОЛЬНЫЕ ТОЧКИ', 'Executive Brief · что проверить в течение дня');
  section('03', 'Пять минимальных запасов до конца окна', 121);
  const rw = [59, 92, 76, 77, 42, 85, 88];
  tableHeader(['Риск', 'Заявка', 'Окно', 'План', 'Запас', 'До неё', 'Действие'], 148, rw);
  m.risks.forEach((risk, i) => tableRow([risk.level, sid(risk.order), window(risk.order.start, risk.order.end), window(risk.assignment.plannedStart, risk.assignment.plannedFinish), `${risk.slack} мин`, risk.previous ? sid(risk.previous) : 'Старт', risk.slack <= 5 ? 'Проверить выезд' : 'Мониторинг'], 172 + i * 44, rw, 44, L, i % 2 ? '#F6F8F8' : C.white));
  strip(L, 404, CW, 66, 'Как читать риск', 'Следить нужно не только за рискованным адресом, но и за предыдущим визитом и переездом. Вмешательство должно происходить до фактического опоздания. Запас считается до правой границы окна по плановому началу.', 'blue');
  section('04', 'Контрольные точки', 491);
  const checkpoints = [
    ['До выхода бригад', 'Решить очередь и подтвердить доступность компетентной бригады.'],
    ['До 15:30', 'Проверить задержки перед пиковыми часами и предупредить клиентов.'],
    ['15:30-18:30', 'Следить за окнами и каскадными сдвигами маршрутов.'],
    ['После смены', 'Собрать итоговые статусы и причины невыполнения.'],
  ];
  checkpoints.forEach(([when, what], i) => { const y = 518 + i * 43; box(L, y, CW, 37, C.white); drawText(when, L + 11, y + 10, 111, 9, C.ink, true); drawText(what, L + 127, y + 9, CW - 139, 9, C.ink); });
  const at16 = m.hourCounts.find(item => item[0] === '16')?.[1] || 0, at18 = m.hourCounts.find(item => item[0] === '18')?.[1] || 0;
  strip(L, 703, CW, 70, 'Пик плановых стартов', `В 16:00 начинается ${at16} визитов, в 18:00 — ${at18}. За эти два часа стартует ${at16 + at18} визит(ов), ${pct((at16 + at18) / Math.max(1, m.summary.counts.assigned) * 100)} всего плана. Буфер перед пиком не сокращать автоматически.`, 'yellow');

  // Page 3: demand and territory.
  page(3, 'СПРОС И ГЕОГРАФИЯ', 'Аналитическое приложение · где сосредоточена нагрузка');
  section('05', 'Почасовые старты визитов', 121);
  const maxHour = Math.max(1, ...m.hourCounts.map(item => item[1]));
  m.hourCounts.forEach(([hour, count], i) => { const y = 151 + i * 25; drawText(`${hour}:00`, L, y, 48, 9, C.ink, true); bar(L + 65, y + 3, 371, count / maxHour, count >= maxHour - 1 ? C.yellow : C.blue); drawText(String(count), R - 62, y - 1, 62, 9, C.ink, true, { align: 'right' }); });
  section('06', 'Территории · схема, не географическая карта', 469);
  m.zones.slice(0, 3).forEach((zone, i) => { const x = L + i * 177, share = zone.count / Math.max(1, m.summary.counts.assigned); box(x, 499, 166, 154, i === 0 ? '#FCE7DA' : i === 1 ? '#FFF2C7' : '#E5F1F7', C.white); doc.circle(x + 83, 553, 18 + share * 46).fill([C.red, C.yellow, C.blue][i]); drawText(zone.name, x + 10, 606, 146, 10, C.ink, true, { align: 'center' }); drawText(`${zone.count} · ${pct(share * 100)}`, x + 10, 626, 146, 9, C.muted, false, { align: 'center' }); });
  if (m.critical) strip(L, 669, CW, 101, 'Структурный дефицит', `${m.zones[0]?.name || 'Ведущая зона'} — самая загруженная территория; здесь же находится ${sid(criticalOrder)}. Свободная местная бригада без навыка «${val(criticalOrder.skill)}» не закрывает очередь. Это проблема сочетания компетенции, территории и окна, а не только численности.`, 'red');
  else strip(L, 669, CW, 101, 'Вывод', 'Территориальная нагрузка сбалансирована относительно доступных маршрутов; открытой очереди нет.', 'green');

  // Page 4: paid capacity and usable reserve are distinct concepts.
  page(4, 'СТРУКТУРА ВРЕМЕНИ И РЕЗЕРВ', 'Плановый фонд бригад · не путать простой с доступным слотом');
  section('07', `Общий фонд смен: ${hours(m.time.allMinutes)}`, 121);
  const timeParts = [
    ['Работа у клиента', m.time.workMinutes, C.yellow], ['Дорога', m.time.travelMinutes, C.blue],
    ['Запас до визита', m.time.waitMinutes, '#A7C9DD'], ['Резерв и простой', m.time.reserveMinutes, '#CED7DB'],
  ];
  let bx = L; timeParts.forEach(([, minutes, color]) => { const w = CW * minutes / Math.max(1, m.time.allMinutes); doc.rect(bx, 153, w, 26).fill(color); bx += w; });
  timeParts.forEach(([name, minutes, color], i) => { const y = 198 + i * 42; doc.circle(L + 9, y + 7, 6).fill(color); drawText(name, L + 25, y, 210, 10, C.ink, true); drawText(`${hours(minutes)} · ${pct(minutes / Math.max(1, m.time.allMinutes) * 100)}`, R - 160, y, 160, 10, C.ink, true, { align: 'right' }); line(L, y + 31, R); });
  kpi(L, 387, 249, 'Резерв и простой', longDuration(m.time.reserveMinutes), `${pct(m.time.reserveMinutes / Math.max(1, m.time.allMinutes) * 100)} общего фонда смен`);
  kpi(L + 260, 387, 259, 'Плановая загрузка', `${m.summary.analysis.capacityLoad ?? '—'}%`, 'работа и дорога / фонд');
  strip(L, 477, CW, 91, 'Ограничение интерпретации', `${hours(m.time.reserveMinutes)} — не единый доступный пул. Сюда входят длительный простой бригад без маршрута и короткие интервалы. Заявку можно вставить лишь при совпадении навыка, зоны и транспорта, с учётом дороги, работы и обязательного резерва.`, 'blue');
  section('08', 'Безопасные варианты оптимизации', 585);
  const adjustable = m.shiftRecommendations.filter(item => item.startSaved + item.endSaved > 0);
  const metrics = [
    [`${adjustable.length}`, 'смен с возможностью сузить границы'],
    [hours(m.reducibleMinutes), 'потенциал по времени без смены порядка визитов'],
    [`${m.gaps.length}`, 'свободных интервалов для проверки'],
  ];
  metrics.forEach(([num, description], i) => { const x = L + i * 177; box(x, 617, 166, 82, C.white); drawText(num, x + 11, 629, 144, 17, C.ink, true); drawText(description, x + 11, 656, 144, 8.3, C.muted); });
  strip(L, 713, CW, 64, 'Правило перед пиком', 'Не уменьшайте буфер перед 16:00 и 18:00 механически: сначала проверьте окно, фактический выезд и точное время дороги.', 'yellow');

  // Page 5: idle crews and the particular skill mismatch.
  page(5, 'РЕСУРСЫ И БРИГАДЫ', 'Аналитическое приложение · настоящий резерв и несовместимый ресурс');
  section('09', 'Состояние команды', 121);
  kpi(L, 150, 165, 'Средняя загрузка', `${m.capacity.averageLoad}%`, 'по всем бригадам');
  kpi(L + 177, 150, 165, 'Без маршрута', `${m.idle.length}`, 'не равны готовому слоту');
  kpi(L + 354, 150, 165, 'Интервалы', `${m.gaps.length}`, 'только кандидаты для проверки');
  section('10', 'Бригады без маршрута', 248);
  m.idle.slice(0, 5).forEach((crew, i) => {
    const y = 277 + i * 84; const engineer = shift.team.find(item => String(item.id) === String(crew.engineerId));
    const skills = (engineer?.skills || []).join(', ') || 'Не указаны';
    const localMismatch = criticalOrder && engineer?.zone === criticalOrder.zone && !(engineer.skills || []).includes(criticalOrder.skill);
    box(L, y, CW, 77, localMismatch ? C.pink : C.white);
    drawText(val(crew.engineerName), L + 11, y + 9, 210, 10, C.ink, true);
    drawText(`${val(engineer?.zone)} · ${val(engineer?.transport)}`, L + 11, y + 27, 240, 8.5, C.muted);
    drawText(`Навыки: ${skills}`, L + 11, y + 43, 310, 8.5, C.ink);
    drawText(`Простой ${longDuration(crew.capacityMinutes || 0)}`, R - 147, y + 10, 136, 8.5, C.ink, true, { align: 'right' });
    drawText(localMismatch ? 'Не подходит для очереди: нет навыка подключения' : 'Оперативный резерв; снять только после проверки срочного спроса', R - 170, y + 31, 159, 8, localMismatch ? C.red : C.green, true, { align: 'right' });
    drawText(localMismatch ? 'Действие: искать допущенную бригаду' : 'Действие: оставить доступной', R - 170, y + 57, 159, 7.9, C.muted, false, { align: 'right' });
  });
  strip(L, 704, CW, 75, 'Решение по очереди', criticalOrder ? `Свободная бригада в ${val(criticalOrder.zone)} не имеет навыка «${val(criticalOrder.skill)}». Диспетчер проверяет другой допустимый маршрут и контактирует с клиентом. Остальные свободные бригады сохраняются как оперативный резерв.` : 'Неназначенных заявок нет. Свободные бригады можно перераспределять только после проверки навыка, зоны, транспорта и окна.', criticalOrder ? 'red' : 'green');

  // Page 6: comparison uses the project's own baseline and tariff functions.
  page(6, 'ЭФФЕКТИВНОСТЬ И ЭКОНОМИКА', 'Плановая модель · одинаковые заявки и команда для двух алгоритмов');
  section('11', 'Оптимизатор против FCFS', 121);
  const b = m.baseline, e = m.economics;
  const compare = [
    ['Назначено', `${b.baselineAssignedCount}/${shift.orders.length}`, `${m.summary.counts.assigned}/${shift.orders.length}`],
    ['Бригад в маршрутах', b.baselineEngineersUsed, m.summary.analysis.activeCrews],
    ['Общий пробег', `${fmt(b.baselineTotalDistanceKm, 1)} км`, `${fmt(m.summary.totalKm, 1)} км`],
    ['Пробег на заявку', `${fmt(b.baselineAvgKmPerOrder, 1)} км`, `${fmt(m.summary.totalKm / Math.max(1, m.summary.counts.assigned), 1)} км`],
    ['Прямые затраты', money(e.baselineDirectCost), money(e.directCost)],
  ];
  tableHeader(['Показатель', 'FCFS', 'Оптимизатор'], 150, [232, 143, 144]);
  compare.forEach((row, i) => tableRow(row, 174 + i * 42, [232, 143, 144], 42, L, i % 2 ? '#F6F8F8' : C.white));
  strip(L, 398, CW, 92, 'Что означает разница', `Оптимизатор назначает на ${m.summary.counts.assigned - b.baselineAssignedCount} заявок больше. Общий пробег выше на ${fmt(m.summary.totalKm - b.baselineTotalDistanceKm, 1)} км из-за большего объёма; сопоставимый показатель — пробег на заявку: ${fmt(b.baselineAvgKmPerOrder, 1)} против ${fmt(m.summary.totalKm / Math.max(1, m.summary.counts.assigned), 1)} км. Расчётное снижение удельного пробега ${fmt((1 - (m.summary.totalKm / Math.max(1, m.summary.counts.assigned)) / b.baselineAvgKmPerOrder) * 100)}%.`, 'blue');
  section('12', 'Структура расчётной стоимости', 510);
  const costRows = [['ФОТ', money(e.laborAmount)], ['Транспорт', money(e.transportAmount)], ['На назначенную заявку', money(e.costPerAssigned)], ['Расчётная экономия к FCFS', money(e.savingPerShift)]];
  costRows.forEach(([name, figure], i) => { const y = 537 + i * 31; drawText(name, L + 5, y, 300, 9, C.ink); drawText(figure, R - 170, y, 165, 10, i === 3 ? C.green : C.ink, true, { align: 'right' }); line(L, y + 23, R); });
  section('13', 'Маршруты с повышенным пробегом', 675);
  m.longRoutes.slice(0, 2).forEach((item, i) => { const y = 701 + i * 41; drawText(`${val(item.route.engineerName)} · ${fmt(item.route.distanceKm, 1)} км`, L, y, 240, 8.8, C.ink, true); drawText(`${item.windows.join('; ') || 'Окна не указаны'} · ${item.skills.join(', ') || 'Навык не указан'} · ${item.zones.join(', ')}`, L, y + 16, CW, 8, C.muted); });
  drawText('Более короткий допустимый маршрут не подтверждён; альтернативу проверять точным пересчётом.', L, 784, CW, 7.8, C.muted);

  // Page 7: history is historical, never mixed into the current day's fact.
  page(7, 'ИСТОРИЯ И СИСТЕМНЫЕ ПРИЧИНЫ', 'Аналитическое приложение · сравнение сопоставимых плановых покрытий');
  section('14', 'Покрытие заявок', 121);
  kpi(L, 150, 165, 'Текущий день', pct(m.summary.analysis.assignmentRate), `${m.summary.counts.assigned}/${shift.orders.length}`);
  kpi(L + 177, 150, 165, 'Семь дней', m.coverageWeek == null ? '—' : pct(m.coverageWeek), 'взвешенное среднее');
  kpi(L + 354, 150, 165, 'История', m.coverageAll == null ? '—' : pct(m.coverageAll), `${m.historyCount} сохранённых дней`);
  section('15', 'Очередь по последним семи дням', 248);
  const maxQueue = Math.max(1, ...m.lastSeven.map(day => day.queue));
  m.lastSeven.forEach((item, i) => { const y = 277 + i * 35; drawText(date(item.date), L + 7, y, 82, 9, C.ink, true); bar(L + 100, y + 4, 304, item.queue / maxQueue, item.queue >= 5 ? C.red : C.yellow); drawText(`${item.queue} · ${pct(item.assigned / Math.max(1, item.total) * 100)}`, R - 101, y, 94, 9, C.ink, true, { align: 'right' }); });
  strip(L, 541, CW, 79, 'Интерпретация', m.lastSeven.length ? `Текущий план ${m.summary.analysis.assignmentRate >= m.coverageWeek ? 'выше' : 'ниже'} среднего недели. За последние семь дней очередь достигала ${Math.max(...m.lastSeven.map(day => day.queue))} заявок; единичный хороший день не доказывает устойчивость процесса.` : 'История смен не загружена; динамическое сравнение недоступно.', 'blue');
  section('16', 'Повторяющийся дефицит', 640);
  drawText(`${m.recurringCount} из ${m.historicalUnassigned}`, L, 667, 240, 21, C.ink, true);
  drawText(`случаев очереди: Юго-восток + подключение за прошлые ${Math.max(0, m.historyCount - 1)} смен; проблема встречалась в ${m.recurringDays} днях.`, L + 238, 670, CW - 238, 9, C.ink);
  strip(L, 718, CW, 60, 'Разделение ответственности', 'Диспетчер решает сегодняшнюю очередь. Руководитель ресурсов проверяет допуск к подключению минимум двух сотрудников и территориальную доступность в Юго-востоке.', 'yellow');

  // Page 8: handoff and the explicit evidence boundary.
  page(8, 'ПЕРЕДАЧА СМЕНЫ И ДОСТОВЕРНОСТЬ', 'Готовая запись в журнал · что можно и нельзя утверждать');
  section('17', 'Запись для следующего диспетчера', 121);
  const handoff = `План v${shift.revision} за ${date(shift.date)}: назначено ${m.summary.counts.assigned} из ${shift.orders.length}, в очереди ${m.summary.counts.unassigned}. ${criticalOrder ? `Критическая заявка ${sid(criticalOrder)} (${window(criticalOrder.start, criticalOrder.end)}): проверить подходящий навык и маршрут, при необходимости связаться с клиентом.` : 'Критической очереди нет.'} Минимальный запас по окнам: ${m.risks.length ? `${sid(m.risks[0].order)} — ${m.risks[0].slack} мин` : 'не определён'}. Пики: ${m.peaks.map(([hour, count]) => `${hour}:00 — ${count}`).join(', ') || 'нет данных'}. Бригад без маршрута ${m.idle.length}; резерв не равен доступной мощности. ${m.mode === 'plan' ? 'Фактические статусы не внесены.' : m.mode === 'partial' ? `Итоговый факт по ${m.finalCount} из ${m.summary.counts.assigned}; остальные требуют проверки.` : `Итоговый статус внесён по ${m.finalCount} визитам.`} Ответственный за очередь и окна — диспетчер; за повторяющийся дефицит навыка — руководитель ресурсов.`;
  box(L, 151, CW, 188, C.white); para(handoff, L + 14, 166, CW - 28, 9.3);
  section('18', 'Чек-лист закрытия', 357);
  const checklist = ['Очередь: есть решение или открытый ответственный и срок?', 'Клиентские окна: проверены предыдущие визиты и переезды?', 'Аварийный резерв: есть доступная бригада для срочного вызова?', 'Фактические статусы: нет пропусков и противоречий?', 'Открытые действия: переданы следующему диспетчеру?'];
  checklist.forEach((item, i) => { const y = 384 + i * 35; doc.roundedRect(L + 5, y + 2, 14, 14, 3).strokeColor(C.muted).stroke(); drawText(item, L + 29, y, CW - 34, 9, C.ink); line(L, y + 28, R); });
  section('19', 'Граница достоверности', 583);
  const factsLine = m.mode === 'plan' ? 'Нет фактических статусов, временных отметок прибытия и фактического пробега.' : m.mode === 'partial' ? `Факт частичный: ${m.finalCount} из ${m.summary.counts.assigned} итоговых отметок; время прибытия и фактический пробег не подтверждены.` : 'Итоговые статусы есть по всем назначенным визитам; время прибытия, фактический пробег и полная фактическая стоимость не подтверждены.';
  strip(L, 611, CW, 68, 'Доступно', `Сохранённый план, заявки, окна, команда, маршруты, расчёт FCFS, тарифы и исторические смены (${m.historyCount}).`, 'green');
  strip(L, 691, CW, 87, 'Недоступно / не утверждать', `${factsLine} Плановые числа нельзя подписывать как фактическую экономию, соблюдение SLA или отсутствие опозданий.`, 'red');

  doc.end();
  return finished;
}
