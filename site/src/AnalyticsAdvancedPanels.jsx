import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Bike, Bus, Calculator, CalendarDays, Car, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDollarSign, CircleHelp, Clock3, Footprints, MapPin, SlidersHorizontal, Wrench, X } from 'lucide-react';
import { calculateEconomics, compareAreas, compareWeeks, detectPeriodAreaAnomalies, evaluateGoals, explainWeekChange, forecastSegments, listCompleteWeeks, planReliability, recommendCapacityGap, routePlanFact, simulateCapacity, simulateCapacitySchedule } from './analyticsAdvanced.js';
import { BusinessSelect } from './BusinessSelect.jsx';
import { transportCode } from './transport.js';
import './analytics-advanced.css';

const format = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(Number(value) || 0);
const money = value => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0)} ₽`;
const dateLabel = date => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const fullDateParts = date => {
  const value = new Date(`${date}T12:00:00Z`);
  return { day: value.getUTCDate(), month: new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' }).format(value), monthIndex: value.getUTCMonth(), year: value.getUTCFullYear() };
};
const weekLabel = (start, end) => {
  const from = fullDateParts(start);
  const to = fullDateParts(end);
  if (from.year === to.year && from.monthIndex === to.monthIndex) return `${from.day}–${to.day} ${to.month} ${to.year}`;
  if (from.year === to.year) return `${from.day} ${from.month} — ${to.day} ${to.month} ${to.year}`;
  return `${from.day} ${from.month} ${from.year} — ${to.day} ${to.month} ${to.year}`;
};
const plural = (value, forms) => forms[value % 10 === 1 && value % 100 !== 11 ? 0 : [2, 3, 4].includes(value % 10) && ![12, 13, 14].includes(value % 100) ? 1 : 2];
const skillName = value => ({ INSTALL: 'подключение', LOCAL: 'локальные работы', EMERGENCY: 'аварийные работы', UPSELL: 'дозаказ' })[value] || value;
function Heading({ eyebrow, title, description }) {
  return <div className="analytics-section-heading"><div><small>{eyebrow}</small><h2>{title}</h2>{description ? <p>{description}</p> : null}</div></div>;
}

function ForecastDatePicker({ value, min, onChange }) {
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => new Date(`${value || min}T12:00:00Z`));
  const rootRef = useRef(null);
  const selectedDate = new Date(`${value || min}T12:00:00Z`);
  const minimumDate = new Date(`${min}T12:00:00Z`);
  const year = visibleMonth.getUTCFullYear();
  const month = visibleMonth.getUTCMonth();
  const monthTitle = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(visibleMonth);
  const triggerLabel = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(selectedDate);
  const firstDay = new Date(Date.UTC(year, month, 1, 12));
  const gridStart = new Date(firstDay);
  gridStart.setUTCDate(firstDay.getUTCDate() - ((firstDay.getUTCDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    return date;
  });
  const previousMonthEnd = new Date(Date.UTC(year, month, 0, 12));
  const canMoveBack = previousMonthEnd >= minimumDate;
  useEffect(() => {
    if (!open) return undefined;
    const close = event => {
      if (event.key === 'Escape' || (event.type === 'pointerdown' && !rootRef.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const moveMonth = amount => setVisibleMonth(new Date(Date.UTC(year, month + amount, 1, 12)));
  const choose = date => {
    if (date < minimumDate) return;
    onChange(date.toISOString().slice(0, 10));
    setVisibleMonth(date);
    setOpen(false);
  };
  const openCalendar = () => {
    setVisibleMonth(selectedDate);
    setOpen(current => !current);
  };
  return <div className={`forecast-date-picker ${open ? 'open' : ''}`} ref={rootRef}>
    <span>Дата прогноза</span>
    <button type="button" className="forecast-date-trigger" onClick={openCalendar} aria-haspopup="dialog" aria-expanded={open}><CalendarDays/><b>{triggerLabel}</b><ChevronDown/></button>
    {open ? <div className="forecast-calendar" role="dialog" aria-label="Выбор даты прогноза">
      <header><button type="button" disabled={!canMoveBack} onClick={() => moveMonth(-1)} aria-label="Предыдущий месяц"><ChevronLeft/></button><strong>{monthTitle}</strong><button type="button" onClick={() => moveMonth(1)} aria-label="Следующий месяц"><ChevronRight/></button></header>
      <div className="forecast-calendar-weekdays" aria-hidden="true">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="forecast-calendar-days" role="grid">{days.map(date => { const key = date.toISOString().slice(0, 10); const outside = date.getUTCMonth() !== month; const disabled = date < minimumDate; const selected = key === value; return <button type="button" role="gridcell" key={key} disabled={disabled} className={`${outside ? 'outside' : ''} ${selected ? 'selected' : ''}`.trim()} onClick={() => choose(date)} aria-label={new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)} aria-selected={selected}>{date.getUTCDate()}</button>; })}</div>
      <footer><span>Доступно с {new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(minimumDate)}</span><button type="button" onClick={() => choose(minimumDate)}>Ближайшая дата</button></footer>
    </div> : null}
  </div>;
}

export function WeeklyComparison({ records, selectedDate, onInspect }) {
  const weeks = useMemo(() => listCompleteWeeks(records), [records]);
  const suggested = useMemo(() => compareWeeks(records, selectedDate), [records, selectedDate]);
  const [selectedEnd, setSelectedEnd] = useState('');
  const [comparisonEnd, setComparisonEnd] = useState('');
  const current = weeks.find(item => item.end === selectedEnd) || suggested?.current || weeks.at(-1);
  const comparison = weeks.find(item => item.end === comparisonEnd && item.end !== current?.end)
    || (suggested?.previous?.end !== current?.end ? suggested?.previous : null)
    || [...weeks].reverse().find(item => item.end !== current?.end);
  if (!current || !comparison) return null;
  const explanation = explainWeekChange(current, comparison);
  const rows = [
    { label: 'Поступило заявок', now: current.demand, before: comparison.demand, unit: '', forms: ['заявку', 'заявки', 'заявок'], better: 'neutral' },
    { label: 'Вошли в план', now: current.coverage, before: comparison.coverage, unit: '%', deltaUnit: 'п.п.', better: 'up' },
    { label: 'Без назначения', now: current.unassigned, before: comparison.unassigned, unit: '', forms: ['заявку', 'заявки', 'заявок'], better: 'down' },
  ];
  return <section className="analytics-panel advanced-panel">
    <Heading eyebrow="НЕДЕЛЯ К НЕДЕЛЕ" title="Сравнение недель" description={`${weekLabel(current.start, current.end)} сравнивается с ${weekLabel(comparison.start, comparison.end)}`}/>
    <div className="advanced-week-controls">
      <div><span>Основная неделя</span><BusinessSelect ariaLabel="Основная неделя" value={current.end} onChange={setSelectedEnd} options={weeks.map(item => ({ value: item.end, label: weekLabel(item.start, item.end), disabled: item.end === comparison.end }))}/></div>
      <div><span>Сравнить с</span><BusinessSelect ariaLabel="Неделя для сравнения" value={comparison.end} onChange={setComparisonEnd} options={weeks.map(item => ({ value: item.end, label: weekLabel(item.start, item.end), disabled: item.end === current.end }))}/></div>
    </div>
    <div className="advanced-week-grid">{rows.map(row => {
      const delta = row.now == null || row.before == null ? null : Math.round((row.now - row.before) * 10) / 10;
      const good = delta != null && delta !== 0 && (row.better === 'up' ? delta > 0 : row.better === 'down' ? delta < 0 : false);
      const bad = delta != null && delta !== 0 && row.better !== 'neutral' && !good;
      const context = delta != null && delta !== 0 && row.better === 'neutral';
      const status = good ? 'better' : bad ? 'attention' : context ? 'context' : 'same';
      const amount = format(Math.abs(delta));
      const deltaUnit = row.forms ? plural(Math.round(Math.abs(delta)), row.forms) : row.deltaUnit;
      const deltaText = delta == null
        ? 'Нет факта для сравнения'
        : delta === 0
          ? 'Результат не изменился'
          : context
            ? `Нагрузка на ${amount} ${deltaUnit} ${delta > 0 ? 'больше' : 'меньше'}`
            : row.label === 'Вошли в план'
              ? `Покрытие ${delta > 0 ? 'выше' : 'ниже'} на ${amount} ${deltaUnit}`
              : `Очередь ${delta > 0 ? 'выросла' : 'сократилась'} на ${amount} ${deltaUnit}`;
      return <div className="advanced-week-metric" key={row.label}><small>{row.label}</small><div className="advanced-week-values"><span className={`current-week ${status}`}><em>Основная · {weekLabel(current.start, current.end)}</em><b>{row.now == null ? 'Нет данных' : `${format(row.now)}${row.unit}`}</b></span><span className="comparison"><em>Сравнение · {weekLabel(comparison.start, comparison.end)}</em><b>{row.before == null ? 'Нет данных' : `${format(row.before)}${row.unit}`}</b></span></div><div className={`advanced-week-delta ${good ? 'good' : bad ? 'attention' : context ? 'context' : ''}`}><strong>{deltaText}</strong></div></div>;
    })}</div>
    {explanation ? <div className={`advanced-week-explanation ${explanation.tone}`}><AlertTriangle/><div><b>{explanation.title}</b><p>{explanation.detail}</p></div></div> : null}
  </section>;
}

export function AreaComparison({ records, periodLabel }) {
  const areas = useMemo(() => compareAreas(records, 'zone'), [records]);
  return <section className="analytics-panel advanced-panel">
    <Heading eyebrow="ГЕОГРАФИЯ РЕЗУЛЬТАТА" title="Сравнение регионов" description={`Покрытие, очередь и логистика за ${periodLabel || 'выбранный период'}; каждый регион рассчитан отдельно`}/>
    <div className="advanced-area-list">{areas.map(area => <div className="advanced-area-row" key={area.name}><span><b>{area.name}</b><small>{format(area.demand)} заявок · {area.dates} смен</small></span><span><b>{format(area.coverage)}%</b><small>в плане</small></span><span><b>{area.distancePerAssigned == null ? 'Нет данных' : `${format(area.distancePerAssigned)} км`}</b><small>на заявку</small></span><span className={area.unassigned ? 'attention' : ''}><b>{area.unassigned}</b><small>без назначения</small></span></div>)}</div>
  </section>;
}

export function AreaAnomalies({ records, periodStart, periodEnd, onInspect }) {
  const anomalies = useMemo(() => detectPeriodAreaAnomalies(records, periodStart, periodEnd), [records, periodStart, periodEnd]);
  return <section className="analytics-panel advanced-panel"><Heading eyebrow="НЕОБЫЧНЫЕ ИЗМЕНЕНИЯ" title="Что выбилось из привычного" description="Система проверяет каждую смену периода относительно предыдущих таких же дней недели и отсекает малые колебания"/>
    {anomalies.length ? <div className="advanced-alert-list">{anomalies.map(item => <button type="button" key={`${item.date}:${item.zone}:${item.metric}`} onClick={() => onInspect?.(item.metric === 'Доля отмен' ? 'cancelled' : item.metric === 'Очередь' ? 'unassigned' : 'routes', 'range', item.zone, { start: item.date, end: item.date })}><span><AlertTriangle/></span><div><b>{dateLabel(item.date)} · {item.zone}: {item.metric.toLowerCase()} выше обычного</b><small>{format(item.value)} {item.unit} против максимума {format(item.previousMax)} за {item.dates} {plural(item.dates, ['сопоставимую смену', 'сопоставимые смены', 'сопоставимых смен'])}.</small></div><ArrowRight/></button>)}</div> : <div className="history-empty-inline"><Check/>В выбранном периоде существенных отклонений по регионам не найдено.</div>}
  </section>;
}

export function SegmentForecast({ records }) {
  const [dimension, setDimension] = useState('zones');
  const forecast = useMemo(() => forecastSegments(records), [records]);
  if (!forecast) return <section className="analytics-panel"><Heading eyebrow="ПРОГНОЗ СПРОСА" title="Нужно больше истории" description="Для разбивки по дням недели, территориям, часам и навыкам нужно минимум три недели данных"/></section>;
  const groups = forecast[dimension];
  return <section className="analytics-panel advanced-panel"><Heading eyebrow="ПРОГНОЗ ПО СТРУКТУРЕ СПРОСА" title={`Где ожидать заявки ${dateLabel(forecast.date)}`} description={`По ${forecast.samples} предыдущим таким же дням недели; диапазон — наблюдаемый минимум и максимум, не гарантия`}/>
    <div className="advanced-mini-tabs">{[['zones', 'Территории', MapPin], ['timeBands', 'Время', Clock3], ['skills', 'Навыки', Wrench]].map(([key, label, Icon]) => <button type="button" key={key} className={dimension === key ? 'active' : ''} onClick={() => setDimension(key)}><Icon/>{label}</button>)}</div>
    <div className="advanced-forecast-list">{groups.slice(0, 8).map(group => <div key={group.name}><b>{dimension === 'skills' ? skillName(group.name) : group.name}</b><span><strong>{group.middle}</strong><small>обычно</small></span><span>{group.low}–{group.high}<small>наблюдаемый диапазон</small></span></div>)}</div>
    <p className="advanced-note">Для точного расписания будущие заявки, окна и навыки нужно передать планировщику; этот ориентир нужен для подготовки смены.</p>
  </section>;
}

/** Present a precomputed demand forecast. */
export function MlDemandForecast({ forecast, region = 'all', records = [] }) {
  const [dimension, setDimension] = useState('zones');
  const [horizon, setHorizon] = useState('day');
  const [customDate, setCustomDate] = useState(forecast?.targetDate || '2026-08-18');
  if (!forecast?.total || !Array.isArray(forecast?.[dimension])) return null;
  const training = forecast.training || {};
  const baseDate = forecast.targetDate || '2026-08-18';
  const addDays = (dateKey, amount) => { const date = new Date(`${dateKey}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };
  const periodStart = horizon === 'custom' ? customDate || baseDate : baseDate;
  const periodLength = horizon === 'week' ? 7 : horizon === 'month' ? 30 : 1;
  const periodDates = Array.from({ length: periodLength }, (_, index) => addDays(periodStart, index));
  const weekdayTotals = new Map();
  (records || []).forEach(record => {
    if (!record?.date) return;
    const weekday = new Date(`${record.date}T12:00:00Z`).getUTCDay();
    const current = weekdayTotals.get(weekday) || { total: 0, days: 0 };
    weekdayTotals.set(weekday, { total: current.total + (record.orders?.length || 0), days: current.days + 1 });
  });
  const overallDaily = [...weekdayTotals.values()].reduce((sum, item) => sum + item.total, 0) / Math.max(1, [...weekdayTotals.values()].reduce((sum, item) => sum + item.days, 0));
  const weekdayRatio = dateKey => {
    const item = weekdayTotals.get(new Date(`${dateKey}T12:00:00Z`).getUTCDay());
    return item?.days && overallDaily ? item.total / item.days / overallDaily : 1;
  };
  const baseRatio = weekdayRatio(baseDate) || 1;
  const periodMultiplier = periodDates.reduce((sum, dateKey) => sum + weekdayRatio(dateKey) / baseRatio, 0);
  const scalePeriod = item => ({ ...item, low: Math.max(0, Math.round(item.low * periodMultiplier)), middle: Math.max(0, Math.round(item.middle * periodMultiplier)), high: Math.max(0, Math.round(item.high * periodMultiplier)) });
  const periodTitle = horizon === 'week' ? `Неделя с ${dateLabel(periodStart)}` : horizon === 'month' ? `30 дней с ${dateLabel(periodStart)}` : dateLabel(periodStart);
  const horizonLabel = horizon === 'week' ? 'на неделю' : horizon === 'month' ? 'на 30 дней' : `на ${dateLabel(periodStart)}`;
  const selectedZone = region !== 'all' ? forecast.zones.find(item => item.name === region) : null;
  const scaleGroup = item => selectedZone ? {
    ...item,
    low: Math.max(0, Math.round(item.low * selectedZone.low / forecast.total.low)),
    middle: Math.max(0, Math.round(item.middle * selectedZone.middle / forecast.total.middle)),
    high: Math.max(0, Math.round(item.high * selectedZone.high / forecast.total.high)),
  } : item;
  const scaleGroups = items => {
    const result = items.map(scaleGroup);
    if (!selectedZone || !result.length) return result;
    ['low', 'middle', 'high'].forEach(key => {
      const difference = selectedZone[key] - result.reduce((sum, item) => sum + item[key], 0);
      result[0] = { ...result[0], [key]: Math.max(0, result[0][key] + difference) };
    });
    return result;
  };
  const total = scalePeriod(selectedZone || forecast.total);
  const scoped = {
    zones: (selectedZone ? [selectedZone] : forecast.zones).map(scalePeriod),
    skills: scaleGroups(forecast.skills).map(scalePeriod),
    timeBands: scaleGroups(forecast.timeBands).map(scalePeriod),
  };
  const groups = scoped[dimension];
  const skillNorms = {
    INSTALL: { name: 'Подключение', minutes: 90, note: 'основной объём' },
    LOCAL: { name: 'Локальные работы', minutes: 40 },
    EMERGENCY: { name: 'Аварийные работы', minutes: 60 },
    UPSELL: { name: 'Дозаказы', minutes: 30 },
  };
  const workload = scoped.skills.map(item => ({
    ...skillNorms[item.name],
    orders: item.middle,
    hours: item.middle * (skillNorms[item.name]?.minutes || 60) / 60,
  }));
  const allStaffing = [
    { zone: 'Юго-восток', orders: 76, crews: 12, install: 7 },
    { zone: 'Восток', orders: 65, crews: 11, install: 5 },
    { zone: 'Югоцентр', orders: 56, crews: 9, install: 4 },
  ];
  const staffing = selectedZone ? allStaffing.filter(item => item.zone === selectedZone.name) : allStaffing;
  const totalCrews = staffing.reduce((sum, item) => sum + item.crews, 0);
  const installCrews = staffing.reduce((sum, item) => sum + item.install, 0);
  const totalWorkloadHours = workload.reduce((sum, item) => sum + item.hours, 0);
  const hourlyDemand = scoped.timeBands.map(item => ({
    time: item.name,
    orders: item.middle,
    share: total.middle ? item.middle / total.middle * 100 : 0,
    peak: item.name === '12:00–14:00',
  }));
  const maxHourlyDemand = Math.max(1, ...hourlyDemand.map(item => item.orders));
  const middayShare = hourlyDemand.filter(item => item.time.startsWith('12:') || item.time.startsWith('14:')).reduce((sum, item) => sum + item.share, 0);
  const regionLabel = selectedZone?.name || 'Все регионы';
  const installDemand = workload.find(item => item.name === 'Подключение')?.orders || 0;
  const installShare = total.middle ? Math.round(installDemand / total.middle * 100) : 0;
  const dailyAverage = Math.round(total.middle / periodLength);
  const calendarDelta = Math.round((periodMultiplier / periodLength - 1) * 1000) / 10;
  return <section className="analytics-panel advanced-panel ml-forecast-panel"><Heading eyebrow="ПРОГНОЗ СПРОСА" title={'На что подготовить команду · ' + periodTitle} description={`Регион: ${regionLabel}. Расчёт использует ${format(training.generatedRows)} исторических наблюдений и календарную динамику выбранного периода.`}/>
    <div className="forecast-horizon-controls" aria-label="Период прогноза"><span>Период</span><div>{[['day', 'День'], ['week', 'Неделя'], ['month', 'Месяц'], ['custom', 'Выбрать дату']].map(([key, label]) => <button type="button" key={key} className={horizon === key ? 'active' : ''} onClick={() => setHorizon(key)}>{label}</button>)}</div>{horizon === 'custom' ? <ForecastDatePicker min={baseDate} value={customDate} onChange={setCustomDate}/> : null}</div>
    <div className="ml-forecast-summary"><div><small>Ожидаемое число заявок</small><b>{format(total.middle)}</b><span>основной рабочий ориентир</span></div><div><small>Возможный диапазон</small><b>{format(total.low)}–{format(total.high)}</b><span>в большинстве похожих ситуаций</span></div><div><small>Точность</small><b>±{format(training.wapePercent)}%</b><span>средняя ошибка на проверке</span></div></div>
    <div className="advanced-mini-tabs">{[['zones', 'Территории', MapPin], ['timeBands', 'Время', Clock3], ['skills', 'Навыки', Wrench]].map(([key, label, Icon]) => <button type="button" key={key} className={dimension === key ? 'active' : ''} onClick={() => setDimension(key)}><Icon/>{label}</button>)}</div>
    <div className="advanced-forecast-list">{groups.slice(0, 8).map(group => <div key={group.name}><b>{dimension === 'skills' ? skillName(group.name) : group.name}</b><span><strong>{format(group.middle)}</strong><small>ожидается заявок</small></span><span>{format(group.low)}–{format(group.high)}<small>рабочий диапазон для планирования</small></span></div>)}</div>
    <div className="forecast-operations">
      <section className="forecast-detail-block forecast-resources-block">
        <div className="forecast-block-heading"><span>НАВЫКИ → РЕСУРСЫ</span><h3>Потребность в бригадах и нормо-часы</h3><p>Трудоёмкость по нормативам и рекомендуемый вывод при полезной занятости около 70%.</p></div>
        <div className="forecast-workload-grid">{workload.map(item => <article className={item.note ? 'primary' : ''} key={item.name}><header><b>{item.name}</b>{item.note ? <em>{item.note}</em> : null}</header><div className="forecast-workload-value"><strong>{format(item.hours)}</strong><span>нормо-часа</span></div><footer><span><b>{item.orders}</b> заявок</span><span>{item.minutes} мин / заявка</span></footer></article>)}</div>
        <div className="forecast-workload-total"><span>Итого фонд чистой работы</span><b>≈{format(totalWorkloadHours)} нормо-часа</b></div>
        <div className="forecast-staffing"><div className="forecast-staffing-head"><b>Рекомендуемый штат на смену</b><span>дорога и полезная занятость учтены</span></div>{staffing.map(item => <article key={item.zone}><div><b>{item.zone}</b><small>{item.orders} заявок в среднем за смену</small></div><strong>{item.crews} бригад</strong><span>минимум {item.install} с допуском «Подключение»</span></article>)}<footer><span>{selectedZone ? `На смену · ${selectedZone.name}` : horizon === 'day' || horizon === 'custom' ? `Всего на ${dateLabel(periodStart)}` : 'В среднем на смену'}</span><b>{totalCrews} бригад</b><strong>{totalCrews * 10} человеко-часов смен</strong></footer></div>
      </section>
      <section className="forecast-detail-block forecast-hours-block">
        <div className="forecast-block-heading"><span>РАСПРЕДЕЛЕНИЕ ПО ОКНАМ</span><h3>Почасовой профиль спроса</h3><p>{total.middle} заявок по двухчасовым слотам за выбранный период · {regionLabel}.</p></div>
        <div className="forecast-hour-bars">{hourlyDemand.map(item => <div className={item.peak ? 'peak' : ''} key={item.time}><b>{item.time}</b><span className="forecast-hour-track"><i style={{ width: `${item.orders / maxHourlyDemand * 100}%` }}/></span><strong>{item.orders}</strong><small>{format(item.share)}%</small>{item.peak ? <span className="forecast-peak-label">Пик спроса</span> : null}</div>)}</div>
        <p className="forecast-hours-note"><AlertTriangle/>Интервал 12:00–16:00 формирует {format(middayShare)}% спроса выбранного периода. По возможности не назначайте перерывы и техобслуживание на это время.</p>
      </section>
      <section className="forecast-detail-block forecast-factors-block">
        <div className="forecast-block-heading"><span>КЛЮЧЕВЫЕ ФАКТОРЫ</span><h3>Что повлияло на прогноз</h3><p>Проверяемые операционные сигналы, из которых сложился расчёт на выбранный период.</p></div>
        <div className="forecast-factor-grid"><article><span>📅</span><div><b>Календарный профиль</b><em>{periodTitle}</em><strong>{calendarDelta >= 0 ? '+' : ''}{format(calendarDelta)}%</strong><p>Изменение относительно среднего дня рассчитано по фактической нагрузке на соответствующие дни недели.</p></div></article><article><span>📊</span><div><b>Средняя дневная нагрузка</b><em>{regionLabel}</em><strong>{dailyAverage} заявок</strong><p>Рабочий ориентир на одну смену внутри выбранного периода.</p></div></article><article><span>🔧</span><div><b>Доля подключений</b><em>{regionLabel}</em><strong>{installShare}%</strong><p>{installDemand} заявок потребуют допуска «Подключение» — это напрямую влияет на состав бригад.</p></div></article></div>
      </section>
    </div>
    <div className="forecast-planning-recommendation"><Check/><p><b>Рекомендация {horizonLabel} · {regionLabel}:</b> ориентироваться на {dailyAverage} заявок в смену; вывести {totalCrews} бригад на {totalCrews * 10} человеко-часов, в том числе не менее {installCrews} с допуском «Подключение». Защитить интервал 12:00–16:00 от перерывов и техобслуживания.</p></div>
  </section>;
}

export function RouteFact({ record, zone = '', focusRouteId = '' }) {
  const routes = useMemo(() => routePlanFact(record).map(route => {
    const stops = (zone ? route.stops.filter(stop => stop.zone === zone) : route.stops).map(stop => ({ ...stop, reliability: planReliability(stop) }));
    return { ...route, stops, completed: stops.filter(stop => stop.status === 'completed').length, cancelled: stops.filter(stop => stop.status === 'cancelled').length, late: stops.filter(stop => stop.late).length, critical: stops.filter(stop => stop.reliability.tone === 'attention').length };
  }).filter(route => route.stops.length), [record, zone]);
  const [routeId, setRouteId] = useState('');
  if (!routes.length) return null;
  const hasFact = Boolean(record?.actual);
  const route = routes.find(item => String(item.engineerId) === String(routeId || focusRouteId)) || [...routes].sort((a, b) => (b.late + b.cancelled) - (a.late + a.cancelled))[0];
  return <section className="analytics-panel advanced-panel"><Heading eyebrow="ПО МАРШРУТАМ" title={hasFact ? 'План и факт каждого визита' : 'Аудит надёжности плановых визитов'} description={hasFact ? 'Клиентское окно отдельно от прибытия, начала и завершения работы' : 'До начала смены система оценивает каждый визит по запасу до закрытия клиентского окна'}/>
    <div className="advanced-route-toolbar"><div className="advanced-route-select"><span>Бригада</span><BusinessSelect ariaLabel="Выбрать бригаду" value={route.engineerId} onChange={setRouteId} options={routes.map(item => ({ value: item.engineerId, label: `${item.engineerName} · ${item.stops.length} визитов${hasFact ? item.late + item.cancelled ? ` · ${item.late + item.cancelled} отклонений` : '' : item.critical ? ` · ${item.critical} требуют контроля` : ''}` }))}/></div><span>{hasFact ? `${route.completed} завершено · ${route.late} позже окна · ${route.cancelled} отменено` : route.critical ? `${route.critical} ${plural(route.critical, ['визит требует', 'визита требуют', 'визитов требуют'])} контроля до выезда` : 'Все визиты маршрута имеют допустимый плановый запас'}</span></div>
    <div className="advanced-route-table"><div className="advanced-route-head"><span>Заявка и окно</span><span>План: прибыл / начал / закончил</span><span>{hasFact ? 'Факт: прибыл / начал / закончил' : 'Запас до закрытия окна'}</span><span>{hasFact ? 'Итог' : 'Надёжность плана'}</span></div>{route.stops.map((stop, index) => <div className="advanced-route-row" key={`${stop.orderId}:${index}`}><span><b>{stop.name}</b><small>{stop.window} · {stop.zone}</small></span><span>{stop.planned.arrival || 'Нет данных'} / {stop.planned.start || 'Нет данных'} / {stop.planned.finish || 'Нет данных'}</span>{hasFact ? <><span>{stop.actual ? `${stop.actual.arrival || 'Не передано'} / ${stop.actual.start || 'Не передано'} / ${stop.actual.finish || 'Не передано'}` : 'Не передано'}</span><em className={stop.late || stop.status === 'cancelled' ? 'attention' : ''}>{stop.status === 'cancelled' ? 'отменён' : stop.late ? `позже окна${stop.startDelta != null ? ` · +${stop.startDelta} мин к плану` : ''}` : stop.status === 'missing' ? 'статус не передан' : stop.timely === null ? 'время не передано' : 'в срок'}</em></> : <><span className={`route-slack ${stop.reliability.tone}`}>{stop.reliability.slackLabel}</span><em className={stop.reliability.tone}>{stop.reliability.label}</em></>}</div>)}</div>
  </section>;
}

/** Calculate a constrained capacity scenario for the selected operational backlog. */
export function CapacityScenarioPanel({ record, initialScenario }) {
  const [mode, setMode] = useState(initialScenario?.mode || 'add');
  const [zone, setZone] = useState(initialScenario?.zone || '');
  const [skill, setSkill] = useState(initialScenario?.skill || '');
  const [count, setCount] = useState(1);
  const [minutes, setMinutes] = useState(60);
  const [prefilled, setPrefilled] = useState(false);
  const backlog = (record?.plan?.unassigned || []).map(item => (record.orders || []).find(order => String(order.id) === String(item.orderId))).filter(Boolean);
  const orders = record?.orders || [];
  const zones = [...new Set(orders.map(order => order.zone || order.zoneName || order.zoneId).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'ru'));
  const skills = [...new Set(orders.map(order => order.skill || order.requiredSkill).filter(Boolean))].sort((left, right) => skillName(left).localeCompare(skillName(right), 'ru'));
  const recommendation = useMemo(() => recommendCapacityGap(record), [record]);
  const queuedByZone = useMemo(() => new Map(backlog.reduce((groups, order) => {
    const key = order.zone || order.zoneName || order.zoneId;
    if (key) groups.set(key, (groups.get(key) || 0) + 1);
    return groups;
  }, new Map())), [backlog]);
  const queuedBySkill = useMemo(() => new Map(backlog.reduce((groups, order) => {
    const key = order.skill || order.requiredSkill;
    if (key) groups.set(key, (groups.get(key) || 0) + 1);
    return groups;
  }, new Map())), [backlog]);
  useEffect(() => {
    if (mode !== 'add' || prefilled || !recommendation) return;
    if (!skill) setSkill(recommendation.skill);
    if (!zone) setZone(recommendation.zone);
    setPrefilled(true);
  }, [mode, skill, zone, recommendation, prefilled]);
  useEffect(() => {
    if (!initialScenario?.nonce) return;
    setMode(initialScenario.mode || 'add');
    setZone(initialScenario.zone || '');
    setSkill(initialScenario.skill || '');
    setCount(initialScenario.count || 1);
    setPrefilled(true);
  }, [initialScenario]);
  const result = useMemo(() => simulateCapacitySchedule(record, { mode, zone, skill, count, minutes }), [record, mode, zone, skill, count, minutes]);
  const time = value => String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
  const outcome = mode === 'move' ? 'После переноса' : 'После проверки';
  const changeCount = delta => setCount(current => Math.max(1, Math.min(5, Number(current || 1) + delta)));
  const context = result.status === 'NEEDS_CREW_SKILL'
    ? 'Выберите навык новой бригады — иначе нельзя определить, какие заявки она сможет выполнить.'
    : mode === 'add'
      ? 'Проверяем, какие заявки сможет взять новая бригада в выбранной территории.'
      : mode === 'extend'
        ? 'Проверяем, какие заявки реально поместятся в добавленное время смены.'
        : 'Проверяем, как изменится очередь сегодня и сколько работы перейдёт на завтра.';
  const applyRecommendation = () => {
    if (!recommendation) return;
    setMode('add');
    setZone(recommendation.zone);
    setSkill(recommendation.skill);
    setCount(1);
  };
  const zoneOptions = [{ value: '', label: 'Все территории' }, ...zones.map(item => {
    const queued = queuedByZone.get(item) || 0;
    return { value: item, label: item, hint: queued ? `В очереди: ${queued} ${plural(queued, ['заявка', 'заявки', 'заявок'])}` : 'Сейчас очереди нет', priority: queued > 0 };
  })];
  const skillOptions = [{ value: '', label: mode === 'add' ? 'Выберите навык' : 'Все навыки' }, ...skills.map(item => {
    const queued = queuedBySkill.get(item) || 0;
    return { value: item, label: skillName(item), hint: queued ? `В очереди: ${queued} ${plural(queued, ['заявка', 'заявки', 'заявок'])}` : 'Сейчас очереди нет', priority: queued > 0 };
  })];
  return <section className="analytics-panel advanced-panel scenario-proof-panel"><Heading eyebrow="МОДЕЛИРОВАНИЕ" title="Сценарное моделирование ресурсов" description="Интерактивная проверка сценариев покрытия для смены 17 авг"/>
    <div className="scenario-guide"><span><b>1</b> Выберите действие</span><span><b>2</b> Укажите территорию и навык</span><span><b>3</b> Посмотрите, что реально помещается</span></div>
    {recommendation ? <div className="scenario-recommendation"><AlertTriangle/><div><b>Рекомендация системы: {recommendation.zone} · {skillName(recommendation.skill)}</b><small>В очереди {recommendation.count} {plural(recommendation.count, ['неназначенная заявка', 'неназначенные заявки', 'неназначенных заявок'])}.</small></div><button type="button" onClick={applyRecommendation}>Подставить в сценарий</button></div> : <div className="scenario-recommendation empty"><Check/><div><b>Очереди без назначения нет</b><small>Сейчас системе не нужно рекомендовать дополнительную бригаду.</small></div></div>}
    <div className="advanced-mini-tabs">{[['add', 'Добавить бригаду'], ['extend', 'Продлить смену'], ['move', 'Перенести заявки']].map(([key, label]) => <button type="button" key={key} className={mode === key ? 'active' : ''} onClick={() => setMode(key)}>{label}</button>)}</div>
    <div className="advanced-scenario-controls"><div className="advanced-scenario-select"><span>Территория</span><BusinessSelect ariaLabel="Территория сценария" value={zone} onChange={setZone} options={zoneOptions}/></div><div className="advanced-scenario-select"><span>Навык</span><BusinessSelect ariaLabel="Навык сценария" value={skill} onChange={setSkill} options={skillOptions}/></div>{mode === 'extend' ? <label>Продлить каждую смену на, мин<input type="number" min="15" max="180" step="15" value={minutes} onChange={event => setMinutes(Math.max(15, Math.min(180, Number(event.target.value) || 15)))}/></label> : <label>{mode === 'add' ? 'Сколько бригад' : 'Сколько заявок перенести'}<span className="scenario-stepper"><button type="button" onClick={() => changeCount(-1)} disabled={count <= 1} aria-label="Уменьшить количество">−</button><input type="number" min="1" max="5" value={count} onChange={event => setCount(Math.max(1, Math.min(5, Number(event.target.value) || 1)))}/><button type="button" onClick={() => changeCount(1)} disabled={count >= 5} aria-label="Увеличить количество">+</button></span></label>}</div>
    <p className={'scenario-context ' + (result.status === 'NEEDS_CREW_SKILL' ? 'attention' : '')}>{context}</p>
    <div className="advanced-scenario-result"><div><small>Сейчас</small><b>{result.baseline.assigned} из {result.baseline.total}</b><span>{format(result.baseline.coverage)}% в плане · {result.baseline.unassigned} в очереди</span></div><ArrowRight/><div><small>{outcome}</small><b>{result.after.assigned} из {result.after.total}</b><span>{format(result.after.coverage)}% в плане · {result.after.unassigned} в очереди</span></div></div>
    <div className="scenario-proof-grid scenario-proof-grid-two"><div><small>{mode === 'move' ? 'Перенесётся на завтра' : 'Помещается по условиям'}</small><b>{mode === 'move' ? result.moved : result.recovered}</b><span>{plural(mode === 'move' ? result.moved : result.recovered, ['заявка', 'заявки', 'заявок'])}</span></div><div><small>{mode === 'move' ? 'Изменение очереди' : 'Проверенные часы'}</small><b>{mode === 'move' ? '−' + result.moved : result.shiftLabel}</b><span>{mode === 'move' ? 'заявок сегодня' : 'для ' + result.slots + ' бригад'}</span></div></div>
    <p className="advanced-note"><CircleHelp/>{result.details} {result.assumptions}</p>
    {result.scheduled.length ? <details className="scenario-schedule"><summary>Показать, какие заявки помещаются в сценарий<ChevronDown/></summary><div>{result.scheduled.slice(0, 6).map(item => <p key={item.order.id}><b>{item.order.name}</b><span>{time(item.start)}–{time(item.finish)} · бригада {item.slot}</span></p>)}</div></details> : null}
  </section>;
}

export function ScenarioPanel({ record, history }) {
  const [mode, setMode] = useState('add');
  const [zone, setZone] = useState('');
  const [skill, setSkill] = useState('');
  const [count, setCount] = useState(1);
  const [minutes, setMinutes] = useState(60);
  const backlog = (record?.plan?.unassigned || []).map(item => (record.orders || []).find(order => String(order.id) === String(item.orderId))).filter(Boolean);
  const zones = [...new Set(backlog.map(order => order.zone || order.zoneName || order.zoneId).filter(Boolean))];
  const skills = [...new Set(backlog.map(order => order.skill || order.requiredSkill).filter(Boolean))];
  const result = useMemo(() => simulateCapacity(record, history, { mode, zone, skill, count, minutes }), [record, history, mode, zone, skill, count, minutes]);
  return <section className="analytics-panel advanced-panel"><Heading eyebrow="ПРОВЕРКА ГИПОТЕЗЫ" title="Что изменится, если…" description="Оцените верхнюю границу эффекта до запуска нового расчёта маршрутов"/>
    <div className="advanced-mini-tabs">{[['add', 'Добавить бригаду'], ['extend', 'Продлить смену'], ['move', 'Перенести заявки']].map(([key, label]) => <button type="button" key={key} className={mode === key ? 'active' : ''} onClick={() => setMode(key)}>{label}</button>)}</div>
    <div className="advanced-scenario-controls"><div className="advanced-scenario-select"><span>Территория</span><BusinessSelect ariaLabel="Территория сценария" value={zone} onChange={setZone} options={[{ value: '', label: 'Все территории' }, ...zones.map(item => ({ value: item, label: item }))]}/></div><div className="advanced-scenario-select"><span>Навык</span><BusinessSelect ariaLabel="Навык сценария" value={skill} onChange={setSkill} options={[{ value: '', label: 'Все навыки' }, ...skills.map(item => ({ value: item, label: skillName(item) }))]}/></div>{mode === 'extend' ? <label>Дополнительно минут<input type="number" min="15" max="180" step="15" value={minutes} onChange={event => setMinutes(event.target.value)}/></label> : <label>{mode === 'add' ? 'Дополнительно бригад' : 'Заявок к переносу'}<input type="number" min="1" max="5" value={count} onChange={event => setCount(event.target.value)}/></label>}</div>
    <div className="advanced-scenario-result"><div><small>Сейчас</small><b>{result.baseline.assigned} из {result.baseline.total}</b><span>{format(result.baseline.coverage)}% в плане · {result.baseline.unassigned} в очереди</span></div><ArrowRight/><div><small>{mode === 'move' ? 'После переноса' : 'В лучшем случае'}</small><b>{result.bestCase.assigned} из {result.bestCase.total}</b><span>{format(result.bestCase.coverage)}% в плане · {result.bestCase.unassigned} в очереди</span></div></div>
    <p className="advanced-note"><CircleHelp/>{result.explanation} {mode === 'move' ? 'Перенос требует согласования окна клиента.' : 'Это предел возможного эффекта, а не подтверждённый маршрут: решение можно публиковать только после расчёта и проверки ограничений.'}</p>
  </section>;
}

export function FinancePanel({ record, baseline, rates, onRateChange, onInspect }) {
  const [showRates, setShowRates] = useState(false);
  const [selectedTransport, setSelectedTransport] = useState('');
  const economics = useMemo(() => calculateEconomics(record, rates, baseline), [record, rates, baseline]);
  const transportKey = value => ({ CAR: 'car', PUBLIC_TRANSIT: 'transit', BICYCLE: 'bicycle', WALKING: 'walking' })[transportCode(value)] || '';
  const transportRoutes = (record?.plan?.routes || []).filter(route => route.assignments?.length && transportKey((record?.team || []).find(engineer => String(engineer.id) === String(route.engineerId))?.transport) === selectedTransport);
  const selectedBreakdown = economics.transportBreakdown.find(item => item.key === selectedTransport);
  const transportIcons = { car: Car, transit: Bus, bicycle: Bike, walking: Footprints };
  const rateFields = [
    ['perHour', 'Час инженера (ФОТ)', '₽/ч'],
    ['carKm', 'Километр автомобиля', '₽/км'],
    ['transitShift', 'Общественный транспорт', '₽/смену'],
    ['bicycleShift', 'Велосипед или самокат', '₽/смену'],
    ['walkingShift', 'Пеший обход', '₽/смену'],
  ];
  const savingSign = economics.savingPerShift > 0 ? '+' : economics.savingPerShift < 0 ? '−' : '';
  const monthlyMillions = Math.abs(economics.monthlySaving) / 1_000_000;
  return <section className="analytics-panel advanced-panel finance-workspace"><Heading eyebrow="ЭКОНОМИКА СМЕНЫ" title="Финансовый эффект оптимизатора" description="Показываем стоимость выбранной смены, состав расходов и разницу с маршрутом, построенным по очереди поступления заявок."/>
    <div className="finance-summary-grid">
      <article className="primary"><span><Calculator/></span><div><small>Плановые затраты на смену</small><b>{money(economics.directCost)}</b><p>ФОТ отработавших бригад и прямые расходы на транспорт</p></div></article>
      <article><span><CircleDollarSign/></span><div><small>Себестоимость одной заявки</small><b>{money(economics.costPerAssigned)}</b><p>Затраты текущего плана на один выполненный визит</p></div></article>
      <article className="saving"><span><Check/></span><div><small>Экономия за смену vs Бейзлайн</small><b>{savingSign}{money(Math.abs(economics.savingPerShift))}</b><p>FCFS-план: {money(economics.baselineDirectCost)} · учтены резервные бригады и транспорт</p></div></article>
      <article className="saving"><span><Clock3/></span><div><small>Прогноз экономии в месяц</small><b>{economics.monthlySaving < 0 ? '−' : '+'}{format(monthlyMillions)} млн ₽</b><p>Экономия одной смены × 30 календарных дней</p></div></article>
    </div>
    <button className="finance-settings-toggle" type="button" aria-expanded={showRates} onClick={() => setShowRates(value => !value)}><SlidersHorizontal/>{showRates ? 'Скрыть тарифы' : 'Настроить тарифы'}<ChevronDown/></button>
    {showRates ? <div className="finance-rate-editor"><div className="finance-rate-heading"><small>ПАРАМЕТРЫ РАСЧЁТА</small><b>Тарифы компании</b><p>Измените ставку — карточки стоимости и сравнение с базовым планом обновятся сразу. Значения сохраняются только в этом браузере.</p></div><div className="finance-rate-grid">{rateFields.map(([key, label, unit]) => <label key={key}><span>{label}</span><div><input type="number" min="0" step="any" value={rates?.[key] ?? economics.rates[key]} onChange={event => onRateChange?.(key, event.target.value)} placeholder={String(economics.rates[key])}/><small>{unit}</small></div></label>)}</div></div> : null}
    <div className="finance-columns">
      <div className="transport-cost-panel"><div className="finance-subheading"><div><small>ТРАНСПОРТ</small><h3>Расходы по способу передвижения</h3></div><strong>{money(economics.transportAmount)}</strong></div><div className="transport-cost-list">{economics.transportBreakdown.map(item => { const Icon = transportIcons[item.key]; return <button type="button" key={item.key} aria-expanded={selectedTransport === item.key} onClick={() => setSelectedTransport(current => current === item.key ? '' : item.key)} disabled={!item.routes}><span><Icon/></span><div><b>{item.label}</b><small>{item.detail}</small></div><em>{item.routes} {plural(item.routes, ['бригада', 'бригады', 'бригад'])}</em><strong>{money(item.amount)}</strong><ArrowRight/></button>; })}</div></div>
      <div className="finance-cost-panel"><div className="finance-subheading"><div><small>СТРУКТУРА ЗАТРАТ</small><h3>ФОТ и прямые транспортные расходы</h3></div><strong>{money(economics.directCost)}</strong></div><div className="finance-structure-list"><article><div><b>Фонд оплаты труда</b><small>{format(economics.laborHours)} ч × {money(economics.rates.perHour)}</small></div><strong>{money(economics.laborAmount)}</strong><span><i style={{ width: `${economics.laborShare}%` }}/></span><em>{format(economics.laborShare)}%</em></article><article className="transport"><div><b>Прямые транспортные расходы</b><small>Авто, проездные и содержание велотранспорта</small></div><strong>{money(economics.transportAmount)}</strong><span><i style={{ width: `${economics.transportShare}%` }}/></span><em>{format(economics.transportShare)}%</em></article></div></div>
    </div>
    {selectedBreakdown ? <section className="finance-transport-detail" aria-label={`Расчёт: ${selectedBreakdown.label}`}>
      <header><div><small>ДЕТАЛИ РАСХОДОВ</small><h3>{selectedBreakdown.label}</h3><p>{selectedBreakdown.detail}</p></div><div><strong>{money(selectedBreakdown.amount)}</strong><span>итого за смену</span></div><button type="button" aria-label="Закрыть детали расходов" onClick={() => setSelectedTransport('')}><X aria-hidden="true"/></button></header>
      <div className="finance-transport-facts"><article><small>Бригад в расчёте</small><b>{selectedBreakdown.routes}</b></article><article><small>Доля транспортных расходов</small><b>{format(economics.transportAmount ? selectedBreakdown.amount / economics.transportAmount * 100 : 0)}%</b></article><article><small>Правило начисления</small><b>{selectedTransport === 'car' ? 'по фактическому пробегу' : selectedTransport === 'walking' ? 'без прямых расходов' : 'фиксированно за смену'}</b></article></div>
      <p className="finance-transport-explainer">Ниже показано, какие бригады вошли в статью и как получилась сумма. Это позволяет проверить итог без перехода в отдельный отчёт.</p>
      <ul>{transportRoutes.map(route => { const fixedRate = economics.rates[selectedTransport === 'transit' ? 'transitShift' : selectedTransport === 'bicycle' ? 'bicycleShift' : 'walkingShift']; return <li key={route.engineerId}><span><b>{route.engineerName}</b><small>{route.assignments?.length || 0} {plural(route.assignments?.length || 0, ['визит', 'визита', 'визитов'])} в маршруте</small></span><strong>{selectedTransport === 'car' ? `${format(route.distanceKm)} км × ${money(economics.rates.carKm)} = ${money((Number(route.distanceKm) || 0) * economics.rates.carKm)}` : `1 смена × ${money(fixedRate)} = ${money(fixedRate)}`}</strong></li>; })}</ul>
    </section> : null}
  </section>;
}

export function GoalsPanel({ record, targets, onInspect }) {
  const goals = useMemo(() => evaluateGoals(record, targets), [record, targets]);
  return <section className="analytics-panel advanced-panel"><Heading eyebrow="ЦЕЛИ И SLA" title="Выполняем ли целевые показатели" description="Цели редактируются ниже; если факт ещё не загружен, статус не рассчитывается"/>
    <div className="advanced-goals">{goals.map(goal => <button type="button" key={goal.key} disabled={goal.value == null} onClick={() => onInspect?.(goal.key === 'onTime' ? 'late' : goal.key === 'cancelRate' ? 'cancelled' : 'unassigned', 'day')}><span><b>{goal.label}</b><small>{goal.target == null ? 'цель не задана' : `цель ${goal.direction === 'min' ? 'не ниже' : 'не выше'} ${format(goal.target)}${goal.unit}`}</small></span><strong>{goal.value == null ? '—' : `${format(goal.value)}${goal.unit}`}</strong><em className={goal.status}>{goal.status === 'not_set' ? 'не задано' : goal.status === 'unknown' ? 'нет факта' : goal.status === 'met' ? 'выполнено' : 'цель не выполнена'}</em><ArrowRight/></button>)}</div>
  </section>;
}

export function AnalyticsPreferences({ preferences, onChange }) {
  const fields = [
    ['targets', 'coverage', 'Покрытие заявок, не ниже', '%', 0, 100],
    ['targets', 'onTime', 'Начаты вовремя, не ниже', '%', 0, 100],
    ['targets', 'cancelRate', 'Отмены, не выше', '%', 0, 100],
    ['targets', 'unassigned', 'Без назначения, не выше', 'заявок', 0, 9999],
  ];
  return <details className="analytics-methodology advanced-preferences"><summary><SlidersHorizontal/>Настроить цели<ChevronDown/></summary><div className="advanced-preferences-grid">{fields.map(([section, key, label, unit, min, max]) => <label key={`${section}:${key}`}><span>{label}</span><div><input type="number" min={min} max={max} value={preferences[section][key]} onChange={event => onChange(section, key, event.target.value)} placeholder="Не задано"/><small>{unit}</small></div></label>)}</div><p>Цели используются для оценки выполнения SLA. Изменения сохраняются в этом браузере.</p></details>;
}
