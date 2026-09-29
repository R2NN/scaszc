import { Fragment, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';
import {
  Activity, AlertTriangle, BarChart3, BriefcaseBusiness, CalendarDays,
  ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleHelp, Clock3,
  Crosshair, FileUp, Gauge, HardHat, MapPin, Pencil, Route, Search, ShieldCheck, Target,
  Bike, Bus, Car, Footprints, RotateCcw, Siren, TrendingUp, UserRoundPlus, UserX, Users, Wrench, X, Zap,
} from 'lucide-react';
import { buildHistoryModel, summarizeHistoryDay } from './analyticsHistory.js';
import { AreaAnomalies, AreaComparison, FinancePanel, MlDemandForecast, WeeklyComparison } from './AnalyticsAdvancedPanels.jsx';
import { analyzeResourceGaps, analyzeShiftEfficiency, analyzeTeamCapacity, buildShiftRecommendations, calculateEconomics, evaluateGoals, findOperationalGaps, generatePeriodInsights } from './analyticsAdvanced.js';
import { BusinessSelect } from './BusinessSelect.jsx';
import { calculateBaseline, hydrateBaselineInputs } from './baselinePlanning.js';
import { parseReplanningCsv } from './replanningInput.js';
import { resolveImportedDate } from './importDate.js';
import { transportLabel } from './transport.js';
import './analytics.css';
import './analytics-polish.css';

const SKILL_LABELS = {
  INSTALL: 'подключение',
  LOCAL: 'локальные работы',
  EMERGENCY: 'аварийные работы',
  UPSELL: 'дозаказ',
  'Подключение': 'подключение',
  'Локальные работы': 'локальные работы',
};

const DEFAULT_ANALYTICS_PREFERENCES = {
  targets: { coverage: 98, onTime: 95, cancelRate: 3, unassigned: 0 },
  rates: { perHour: 650, carKm: 16, transitShift: 320, bicycleShift: 120, walkingShift: 0 },
};
const EMPTY_ANALYTICS_HISTORY = Object.freeze([]);

const percent = (value, total) => total ? Math.round(value / total * 1000) / 10 : 0;
const plural = (value, forms) => forms[value % 10 === 1 && value % 100 !== 11 ? 0 : [2, 3, 4].includes(value % 10) && ![12, 13, 14].includes(value % 100) ? 1 : 2];
const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(Number(value) || 0);
const hours = minutes => `${number((Number(minutes) || 0) / 60)} ч`;
const minutesFromTime = value => { const [hour, minute] = String(value || '00:00').split(':').map(Number); return hour * 60 + minute; };
const currentTimeValue = () => { const date = new Date(); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
const quantile = (values, part) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * part) - 1))];
};
const orderZone = order => String(order?.zone || order?.zoneId || 'Без зоны').trim();
const sourceSkill = order => String(order?.sourceData?.required_skill || order?.skill || 'Навык не указан').trim();
const timeLabel = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const isValidTimeValue = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
const cleanTimeDraft = value => String(value || '').replace(/[^\d:]/g, '').slice(0, 5);
const crewInitials = value => String(value || 'Бригада').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const clusterOf = item => String(item?.cluster || item?.clusterName || item?.zone || item?.zoneName || item?.zoneId || item?.regionName || item?.regionId || 'Без региона').trim();
const CLUSTER_ORDER = ['Юго-восток', 'Восток', 'Югоцентр'];
const HACKATHON_PLANNING_DATE = '2026-08-17';
const TRANSPORT_LABELS = new Proxy({}, { get: (_, value) => transportLabel(value) });
const CLUSTER_MAP_CENTERS = { 'Юго-восток': [37.78, 55.67], 'Восток': [37.80, 55.77], 'Югоцентр': [37.62, 55.68] };
const isUrgentOrder = order => /urgent|emergency|авар|срочн/i.test(`${order?.priority || ''} ${order?.skill || ''}`);
const orderedClusters = values => [...new Set(values.filter(Boolean))].sort((left, right) => {
  const leftIndex = CLUSTER_ORDER.indexOf(left);
  const rightIndex = CLUSTER_ORDER.indexOf(right);
  return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex) || left.localeCompare(right, 'ru');
});

function ResourceModalPortal({ children }) {
  if (typeof document === 'undefined') return children;
  return createPortal(<div className="resources-workspace analytics-modal-portal">{children}</div>, document.body);
}

function filterRecordByCluster(record, cluster) {
  if (!cluster || cluster === 'all') return record;
  const orders = (record?.orders || []).filter(order => clusterOf(order) === cluster);
  const orderIds = new Set(orders.map(order => String(order.id)));
  const team = (record?.team || []).filter(engineer => clusterOf(engineer) === cluster);
  const teamIds = new Set(team.map(engineer => String(engineer.id)));
  const routes = (record?.plan?.routes || []).filter(route => teamIds.has(String(route.engineerId))).map(route => ({
    ...route,
    assignments: (route.assignments || []).filter(assignment => orderIds.has(String(assignment.orderId))),
  })).filter(route => route.assignments.length);
  const unassigned = (record?.plan?.unassigned || []).filter(item => orderIds.has(String(item.orderId)));
  return { ...record, orders, team, plan: record?.plan ? { ...record.plan, routes, unassigned } : record?.plan };
}

const localDateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayLabel = key => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
const longDayLabel = key => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
const rangeLabel = (start, end) => start === end ? longDayLabel(start) : `${longDayLabel(start)} — ${longDayLabel(end)}`;
const weekdayLabel = key => new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${key}T12:00:00Z`));
const CALENDAR_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const CALENDAR_MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const parseDateKey = key => {
  const [year, month, day] = String(key || '').split('-').map(Number);
  return new Date(year, Math.max(0, month - 1), day || 1);
};
const compactDateKeyLabel = key => {
  const date = parseDateKey(key);
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
};
const calendarDateLabel = date => `${date.getDate()} ${CALENDAR_MONTHS_GENITIVE[date.getMonth()]} ${date.getFullYear()}`;
const compactOrderAddress = value => String(value || 'Адрес не указан').replace(/^(город|\u0433\.)\s*Москва,?\s*/i, '').replace(/\bул\.(?=\S)/gi, 'ул. ').replace(/\s+/g, ' ').trim();
const brigadeLabel = value => /^бригада\s/i.test(String(value || '')) ? String(value) : `Бригада ${String(value || 'без имени')}`;
const displaySkill = value => {
  const label = SKILL_LABELS[value] || String(value || 'навык не указан').toLocaleLowerCase('ru-RU');
  return `${label.charAt(0).toLocaleUpperCase('ru-RU')}${label.slice(1)}`;
};
const monthNumber = date => date.getFullYear() * 12 + date.getMonth();

function HistoryPeriodPicker({ label, value, min, max, rangeStart, rangeEnd, onChange, boundary = 'start' }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('days');
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const selected = parseDateKey(value);
    return new Date(selected.getFullYear(), selected.getMonth(), 1);
  });
  const rootRef = useRef(null);
  const selectedDate = parseDateKey(value);
  const minDate = parseDateKey(min);
  const maxDate = parseDateKey(max);
  const minMonth = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  const maxMonth = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);
  const firstOffset = (visibleMonth.getDay() + 6) % 7;
  const gridStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1 - firstOffset);
  const days = Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
  const years = Array.from({ length: maxDate.getFullYear() - minDate.getFullYear() + 1 }, (_, index) => minDate.getFullYear() + index);

  useEffect(() => {
    if (!open) return undefined;
    const close = event => {
      if (event.key === 'Escape' || (event.type === 'mousedown' && !rootRef.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const select = date => {
    const key = localDateKey(date);
    if (key < min || key > max) return;
    onChange(key);
    setOpen(false);
    setMode('days');
  };
  const moveMonth = direction => {
    setVisibleMonth(current => {
      const next = new Date(current.getFullYear(), current.getMonth() + direction, 1);
      return monthNumber(next) < monthNumber(minMonth) || monthNumber(next) > monthNumber(maxMonth) ? current : next;
    });
    setMode('days');
  };
  const selectMonth = month => {
    const candidate = new Date(visibleMonth.getFullYear(), month, 1);
    if (monthNumber(candidate) < monthNumber(minMonth) || monthNumber(candidate) > monthNumber(maxMonth)) return;
    setVisibleMonth(candidate);
    setMode('days');
  };
  const selectYear = year => {
    const lower = year === minDate.getFullYear() ? minDate.getMonth() : 0;
    const upper = year === maxDate.getFullYear() ? maxDate.getMonth() : 11;
    const month = Math.min(upper, Math.max(lower, visibleMonth.getMonth()));
    setVisibleMonth(new Date(year, month, 1));
    setMode('days');
  };
  const toggle = () => {
    if (!open) {
      setVisibleMonth(new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1));
      setMode('days');
    }
    setOpen(current => !current);
  };
  const boundaryDate = boundary === 'start' ? minDate : maxDate;

  return <div className={`history-period-picker ${open ? 'open' : ''}`} ref={rootRef}>
    <span>{label}</span>
    <button type="button" className={`history-period-trigger ${open ? 'active' : ''}`} onClick={toggle} aria-expanded={open} aria-label={`${label === 'С' ? 'Начало' : 'Конец'} периода: ${longDayLabel(value)}`}>
      <CalendarDays/><strong>{compactDateKeyLabel(value)}</strong><ChevronDown/>
    </button>
    {open ? <section className="date-popover history-period-popover" role="dialog" aria-label={`${label === 'С' ? 'Начало' : 'Конец'} периода анализа`}>
      <div className="calendar-head">
        <button type="button" disabled={monthNumber(visibleMonth) <= monthNumber(minMonth)} onClick={() => moveMonth(-1)} aria-label="Предыдущий месяц"><ChevronLeft/></button>
        <div className="calendar-selectors">
          <button type="button" className={mode === 'months' ? 'calendar-select active' : 'calendar-select'} onClick={() => setMode(current => current === 'months' ? 'days' : 'months')} aria-expanded={mode === 'months'}>{CALENDAR_MONTHS[visibleMonth.getMonth()]}<ChevronDown/></button>
          <button type="button" className={mode === 'years' ? 'calendar-select active' : 'calendar-select'} onClick={() => setMode(current => current === 'years' ? 'days' : 'years')} aria-expanded={mode === 'years'}>{visibleMonth.getFullYear()}<ChevronDown/></button>
        </div>
        <button type="button" disabled={monthNumber(visibleMonth) >= monthNumber(maxMonth)} onClick={() => moveMonth(1)} aria-label="Следующий месяц"><ChevronRight/></button>
      </div>
      {mode === 'months' ? <div className="month-grid">{CALENDAR_MONTHS.map((month, index) => {
        const candidate = new Date(visibleMonth.getFullYear(), index, 1);
        const disabled = monthNumber(candidate) < monthNumber(minMonth) || monthNumber(candidate) > monthNumber(maxMonth);
        return <button type="button" key={month} disabled={disabled} className={index === visibleMonth.getMonth() ? 'selected' : ''} onClick={() => selectMonth(index)}>{month.slice(0, 3)}</button>;
      })}</div> : mode === 'years' ? <div className="year-grid">{years.map(year => <button type="button" key={year} className={year === visibleMonth.getFullYear() ? 'selected' : ''} onClick={() => selectYear(year)}>{year}</button>)}</div> : <>
        <div className="weekday-row">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <span key={day}>{day}</span>)}</div>
        <div className="calendar-grid">{days.map(date => {
          const key = localDateKey(date);
          const disabled = key < min || key > max;
          const outside = date.getMonth() !== visibleMonth.getMonth();
          const selected = key === value;
          const inRange = key > rangeStart && key < rangeEnd;
          const rangeEdge = key === rangeStart || key === rangeEnd;
          const className = [outside ? 'outside' : '', disabled ? 'future' : '', inRange ? 'in-range' : '', rangeEdge ? 'range-edge' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
          return <button type="button" key={key} disabled={disabled} className={className} onClick={() => select(date)} aria-label={`${calendarDateLabel(date)}${disabled ? ', недоступно' : ''}`}>{date.getDate()}</button>;
        })}</div>
      </>}
      <div className="calendar-footer"><button type="button" onClick={() => select(boundaryDate)}><CalendarDays/>{boundary === 'start' ? 'Первая смена' : 'Последняя смена'}</button><span>{calendarDateLabel(selectedDate)}</span></div>
    </section> : null}
  </div>;
}

const summarizePeriod = days => {
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const assigned = days.reduce((sum, day) => sum + day.assigned, 0);
  const distance = days.reduce((sum, day) => sum + (Number(day.distance) || 0), 0);
  return { total, assigned, distance, coverage: percent(assigned, total), distancePerVisit: assigned ? distance / assigned : null };
};

function buildAnalytics(orders, team, plan, actual = null) {
  const metrics = plan?.metrics || {};
  const routes = (plan?.routes || []).filter(route => route.assignments?.length);
  const assignments = routes.flatMap(route => route.assignments || []);
  const assignedIds = new Set(assignments.map(item => String(item.orderId)));
  const orderById = new Map(orders.map(order => [String(order.id), order]));
  const execution = summarizeHistoryDay({ orders, team, plan, actual });
  const resourceGaps = analyzeResourceGaps({ orders, team, plan });
  const teamCapacity = analyzeTeamCapacity({ orders, team, plan });
  const baseline = calculateBaseline(orders, team);
  const operationalGaps = findOperationalGaps({ orders, team, plan });
  const shiftRecommendations = buildShiftRecommendations({ orders, team, plan });
  const total = execution.total;
  const assigned = execution.assigned;
  const unassigned = execution.unassigned;
  const urgentOrders = orders.filter(isUrgentOrder);
  const urgentAssigned = urgentOrders.filter(order => assignedIds.has(String(order.id))).length;
  const routeStats = routes.map(route => {
    const capacity = Math.max(1, minutesFromTime(route.shiftEnd) - minutesFromTime(route.shiftStart));
    const utilization = Math.round((Number(route.workloadMinutes) || 0) / capacity * 100);
    return { ...route, utilization, capacity };
  }).sort((a, b) => b.utilization - a.utilization);
  const routeTimelines = routes.map(route => {
    const routeGaps = operationalGaps.filter(gap => String(gap.engineerId) === String(route.engineerId));
    return {
      engineerId: route.engineerId,
      engineerName: route.engineerName || route.engineerId,
      shiftStart: minutesFromTime(route.shiftStart),
      shiftEnd: minutesFromTime(route.shiftEnd),
      assignments: (route.assignments || []).map((assignment, index) => ({
        key: `${route.engineerId}:${assignment.orderId}:${index}`,
        orderId: assignment.orderId,
        orderName: orderById.get(String(assignment.orderId))?.name || `Заявка ${assignment.orderId}`,
        start: minutesFromTime(assignment.plannedStart),
        end: minutesFromTime(assignment.plannedFinish),
      })),
      gaps: routeGaps,
      priority: routeGaps.some(gap => gap.customerCall) ? 2 : routeGaps.length ? 1 : 0,
      largestGap: Math.max(0, ...routeGaps.map(gap => gap.minutes)),
    };
  }).filter(route => route.gaps.length).sort((left, right) => right.priority - left.priority || right.largestGap - left.largestGap || left.engineerName.localeCompare(right.engineerName, 'ru'));
  const loads = routeStats.map(route => route.utilization);
  const lowSlack = assignments.filter(assignment => {
    const order = orderById.get(String(assignment.orderId));
    if (!order?.end || !assignment.plannedStart) return false;
    const slack = minutesFromTime(order.end) - minutesFromTime(assignment.plannedStart);
    return slack >= 0 && slack <= 30;
  });
  const criticalSlack = lowSlack.filter(assignment => {
    const order = orderById.get(String(assignment.orderId));
    return minutesFromTime(order.end) - minutesFromTime(assignment.plannedStart) <= 15;
  });
  const lateStarts = assignments.filter(assignment => {
    const order = orderById.get(String(assignment.orderId));
    return order?.end && assignment.plannedStart && minutesFromTime(assignment.plannedStart) > minutesFromTime(order.end);
  });
  const distance = routeStats.length ? routeStats.reduce((sum, route) => sum + (Number(route.distanceKm) || 0), 0) : Number(metrics.distanceKm || 0);
  const travel = routeStats.length ? routeStats.reduce((sum, route) => sum + (Number(route.travelMinutes) || 0), 0) : Number(metrics.travelMinutes || 0);
  const hasWaitingTiming = assignments.some(assignment => (assignment.arrivalAt || assignment.arrival) && assignment.plannedStart);
  const waiting = hasWaitingTiming ? routes.reduce((total, route) => total + (route.assignments || []).reduce((routeTotal, assignment) => {
      const arrival = assignment.arrivalAt || assignment.arrival ? minutesFromTime(assignment.arrivalAt || assignment.arrival) : minutesFromTime(assignment.plannedStart);
      const plannedStart = minutesFromTime(assignment.plannedStart);
      const beforeVisit = Math.max(0, plannedStart - arrival);
      return routeTotal + beforeVisit;
    }, 0), 0) : Number(metrics.waitingMinutes || 0);
  const service = assignments.reduce((sum, assignment) => sum + (Number(orderById.get(String(assignment.orderId))?.duration) || 0), 0);
  const idle = teamCapacity.stats.reduce((sum, item) => sum + (Number(item.idleMinutes) || 0), 0);
  const timeTotal = Math.max(1, service + travel + waiting + idle);
  const completeOrders = orders.filter(order => order?.id != null && order?.start && order?.end && Number(order?.duration) > 0).length;
  const completeTeam = team.filter(engineer => engineer?.id != null && engineer?.name && engineer?.shiftStart && engineer?.shiftEnd).length;
  const dataCompleteness = percent(completeOrders + completeTeam, orders.length + team.length);
  const dataIssues = Math.max(0, orders.length - completeOrders) + Math.max(0, team.length - completeTeam);
  const cancellationReasons = [...execution.issues.cancelled.reduce((groups, item) => {
    const reason = String(item.reason || '').trim();
    if (reason) groups.set(reason, (groups.get(reason) || 0) + 1);
    return groups;
  }, new Map())].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'ru'));
  const needGroups = new Map();
  (plan?.unassigned || []).forEach(item => {
    const order = orderById.get(String(item.orderId));
    const key = `${orderZone(order)}|${sourceSkill(order)}`;
    needGroups.set(key, (needGroups.get(key) || 0) + 1);
  });
  const zones = new Map();
  orders.forEach(order => {
    const zone = orderZone(order);
    const current = zones.get(zone) || { name: zone, total: 0, assigned: 0, unassigned: 0, distanceKm: 0 };
    current.total += 1;
    if (assignedIds.has(String(order.id))) current.assigned += 1;
    else current.unassigned += 1;
    zones.set(zone, current);
  });
  assignments.forEach(assignment => {
    const current = zones.get(orderZone(orderById.get(String(assignment.orderId))));
    if (current) current.distanceKm += (Number(assignment.distanceM) || 0) / 1000;
  });
  return {
    total, assigned, unassigned, coverage: percent(assigned, total), urgentTotal: urgentOrders.length,
    urgentAssigned, routeStats, activeEngineers: routes.length,
    availableEngineers: team.length || Math.max(routes.length, Number(metrics.activeEngineers || 0)),
    distance, travel, waiting, service, idle, timeTotal, baseline, lowSlack, criticalSlack, lateStarts, operationalGaps, routeTimelines, shiftRecommendations, dataCompleteness,
    medianLoad: quantile(loads, .5), p90Load: quantile(loads, .9),
    causes: resourceGaps.causes,
    explanations: resourceGaps.explanations,
    idleCount: resourceGaps.idleCount,
    idleWithNeededSkill: resourceGaps.idleWithNeededSkill,
    idleWithoutNeededSkill: resourceGaps.idleWithoutNeededSkill,
    idleDiagnosis: resourceGaps.idleDiagnosis,
    teamStats: teamCapacity.stats,
    averageTeamLoad: teamCapacity.averageLoad,
    lowestActive: teamCapacity.lowestActive,
    missingTeamReasonCount: teamCapacity.missingReasonCount,
    needs: [...needGroups].map(([key, count]) => { const [zone, skill] = key.split('|'); return { zone, skill, count }; }).sort((a, b) => b.count - a.count),
    zones: [...zones.values()].sort((a, b) => b.unassigned - a.unassigned || b.total - a.total),
    timeShares: { service: percent(service, timeTotal), travel: percent(travel, timeTotal), waiting: percent(waiting, timeTotal), idle: percent(idle, timeTotal) },
    actualAvailable: execution.actualAvailable,
    completed: execution.completed,
    actualLate: execution.late,
    cancelled: execution.cancelled,
    cancellationReasons,
    dataIssues,
  };
}

function MetricCard({ icon: Icon, label, value, note, tone = '', delta = '', deltaTone = 'positive', onClick, actionLabel = 'Открыть' }) {
  const Tag = onClick ? 'button' : 'article';
  return <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`analytics-metric ${tone} ${onClick ? 'analytics-metric-clickable' : ''}`}><span><Icon/></span><div><small>{label}</small><b>{value}</b><p>{note}</p>{delta ? <em className={`analytics-metric-delta ${deltaTone}`}>{delta}</em> : null}{onClick ? <span className="analytics-card-action">{actionLabel}<ChevronRight/></span> : null}</div></Tag>;
}

function SectionHeading({ eyebrow, title, description, action }) {
  return <div className="analytics-section-heading"><div>{eyebrow ? <small>{eyebrow}</small> : null}<h2>{title}</h2>{description ? <p>{description}</p> : null}</div>{action}</div>;
}

function StatusHero({ data, onResolve }) {
  const hasIssues = data.unassigned > 0;
  const urgentOpen = Math.max(0, data.urgentTotal - data.urgentAssigned);
  const mainNeed = data.needs[0];
  return <section className={`analytics-status-hero shift-status-hero ${hasIssues ? 'attention' : 'success'}`}>
    <span className="analytics-status-icon">{hasIssues ? <AlertTriangle/> : <Check/>}</span>
    <div className="analytics-status-copy">
      <small>ИТОГ СМЕНЫ</small>
      <h2>{hasIssues ? `${data.unassigned} ${plural(data.unassigned, ['заявка требует', 'заявки требуют', 'заявок требуют'])} решения` : 'Все заявки распределены'}</h2>
      <p>{urgentOpen ? `${urgentOpen} ${plural(urgentOpen, ['срочная заявка ещё не назначена', 'срочные заявки ещё не назначены', 'срочных заявок ещё не назначено'])}. Их нужно разобрать в первую очередь.` : mainNeed ? `Срочные заявки назначены. Наибольший дефицит — зона «${mainNeed.zone}», навык «${SKILL_LABELS[mainNeed.skill] || mainNeed.skill}».` : 'Все заявки вошли в план. Следите за запасом времени до конца клиентских окон.'}</p>
    </div>
    {hasIssues ? <button type="button" className="analytics-status-action" onClick={onResolve}>Разобрать {data.unassigned} {plural(data.unassigned, ['заявку', 'заявки', 'заявок'])}<ChevronRight/></button> : null}
  </section>;
}

function RegionIsolationNotice({ cluster, data }) {
  if (!cluster || cluster === 'all' || !data.unassigned) return null;
  return <section className="region-isolation-notice"><span><ShieldCheck/></span><div><small>НЕЗАВИСИМЫЙ РЕГИОН</small><b>Регион «{cluster}» изолирован</b><p>Дефицит ресурсов нельзя закрыть ресурсами соседнего офиса. Рекомендации и покрытие рассчитаны только по бригадам этого региона.</p></div></section>;
}

function UnassignedExplanationList({ explanations = [], onOpenOrder, onOpenResource }) {
  if (!explanations.length) return null;
  return <section className="analytics-panel unassigned-explanations">
    <SectionHeading title="Почему заявки не вошли в план" description="Здесь — результат планирования. Проверка условий каждой бригады открывается отдельно."/>
    <div>{explanations.map(item => <article key={item.orderId}><span><CircleAlert/></span><div className="unassigned-explanation-copy"><header><div><small>ЗАЯВКА №{item.orderNumber || String(item.orderId).replace(/^.*:/, '')}</small><b>{item.label}</b></div><em>{item.zone} · {item.window}</em></header><p>{item.reasonCode === 'STATIC_ELIGIBLE_BUT_UNSERVED' ? 'Базово подходящие бригады есть, но в готовом плане заявка осталась без назначения. Точное ограничение видно только после проверки каждой бригады.' : item.detail}</p><footer><button type="button" className="primary-action" onClick={() => onOpenOrder?.(item.orderId)}>Разобрать заявку<ChevronRight/></button><button type="button" className="secondary-action" onClick={() => onOpenResource?.(item)}><Users/>Проверить бригады</button></footer></div></article>)}</div>
  </section>;
}

function ManualTimeField({ label, value, onChange }) {
  const adjustTime = delta => {
    if (!isValidTimeValue(value)) return;
    const next = (minutesFromTime(value) + delta + 1440) % 1440;
    onChange(timeLabel(next));
  };
  return <label className="shift-time-field">
    <span>{label}</span>
    <div className="shift-time-control">
      <Clock3 aria-hidden="true"/>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={5}
        placeholder="ЧЧ:ММ"
        aria-label={label}
        value={value}
        onChange={event => onChange(cleanTimeDraft(event.target.value))}
        onKeyDown={event => {
          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          adjustTime(event.key === 'ArrowUp' ? 15 : -15);
        }}
      />
      <span className="shift-time-step" aria-hidden="true">±15</span>
    </div>
  </label>;
}

function ShiftRecommendationTable({ recommendations = [], appliedIds = new Set(), appliedValues = {}, onApply, onApplyAll, onRevert, onRevertAll }) {
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [manualTimes, setManualTimes] = useState({ start: '', end: '' });
  const meaningful = recommendations.filter(item => item.startSaved + item.endSaved >= 30);
  if (!meaningful.length) return null;
  const shown = expanded ? meaningful : meaningful.slice(0, 3);
  const totalSaved = meaningful.reduce((sum, item) => sum + item.startSaved + item.endSaved, 0);
  const allApplied = meaningful.every(item => appliedIds.has(String(item.engineerId)));
  return <section className="shift-recommendations" aria-label="Рекомендованный режим смен">
    <header>
      <div className="shift-recommendation-heading"><h2>Оптимизация границ смен</h2><strong>Экономия: до {number(totalSaved / 60)} ч ({meaningful.length} {plural(meaningful.length, ['бригада', 'бригады', 'бригад'])})</strong></div>
      <div className="shift-recommendation-actions"><button type="button" className={allApplied ? 'revert-all' : 'primary'} onClick={() => allApplied ? onRevertAll?.(meaningful) : onApplyAll?.(meaningful)}>{allApplied ? 'Сбросить предложения' : `Подготовить предложения (${meaningful.length})`}</button></div>
    </header>
    <div className="shift-recommendation-list">{shown.map(item => {
      const applied = appliedIds.has(String(item.engineerId));
      const appliedValue = appliedValues[String(item.engineerId)];
      const displayedStart = appliedValue?.recommendedStart ?? item.recommendedStart;
      const displayedEnd = appliedValue?.recommendedEnd ?? item.recommendedEnd;
      const saved = Math.max(0, displayedStart - item.shiftStart) + Math.max(0, item.shiftEnd - displayedEnd);
      const editing = editingId === String(item.engineerId);
      const manualStart = minutesFromTime(manualTimes.start);
      const manualEnd = minutesFromTime(manualTimes.end);
      const manualFormatValid = isValidTimeValue(manualTimes.start) && isValidTimeValue(manualTimes.end);
      const manualValid = manualFormatValid && manualEnd > manualStart;
      const manualError = !manualFormatValid ? 'Укажите время в формате ЧЧ:ММ.' : manualEnd <= manualStart ? 'Завершение смены должно быть позже начала.' : '';
      const toggleManualEditor = () => {
        setEditingId(editing ? '' : String(item.engineerId));
        setManualTimes({ start: timeLabel(displayedStart), end: timeLabel(displayedEnd) });
      };
      return <article className={applied ? 'applied' : ''} key={item.engineerId}>
        <div className="shift-engineer"><i>{crewInitials(item.engineerName)}</i><span><b>{item.engineerName}</b><small>{item.assignments} {plural(item.assignments, ['визит', 'визита', 'визитов'])}</small></span></div>
        <div className="shift-time-change"><span>{timeLabel(item.shiftStart)}–{timeLabel(item.shiftEnd)}</span><ArrowRight aria-hidden="true"/><b>{timeLabel(displayedStart)}–{timeLabel(displayedEnd)}</b></div>
        <em>{saved ? `−${saved} мин` : 'Без изменений'}</em>
        <div className="shift-row-actions">{applied ? <><span className="shift-applied-status"><Check/>Предложение</span><button type="button" className="undo" onClick={() => { onRevert?.(item); setEditingId(''); }}>Сбросить</button></> : <><button type="button" className="apply" onClick={() => onApply?.({ ...item, source: 'algorithm' })}>Подготовить</button><button type="button" className={`edit-time ${editing ? 'active' : ''}`} aria-label={editing ? 'Закрыть редактирование времени' : `Задать время вручную для ${item.engineerName}`} title={editing ? 'Закрыть' : 'Задать вручную'} onClick={toggleManualEditor}><Pencil/></button></>}</div>
        {editing ? <div className="shift-manual-editor">
          <div className="shift-manual-copy"><small>РУЧНАЯ НАСТРОЙКА</small><b>{item.engineerName}</b></div>
          <ManualTimeField label="Новое начало" value={manualTimes.start} onChange={value => setManualTimes(current => ({ ...current, start: value }))}/>
          <ArrowRight className="shift-manual-arrow" aria-hidden="true"/>
          <ManualTimeField label="Новое завершение" value={manualTimes.end} onChange={value => setManualTimes(current => ({ ...current, end: value }))}/>
          <button type="button" disabled={!manualValid} onClick={() => { onApply?.({ ...item, recommendedStart: manualStart, recommendedEnd: manualEnd, startSaved: Math.max(0, manualStart - item.shiftStart), endSaved: Math.max(0, item.shiftEnd - manualEnd), source: 'manual' }); setEditingId(''); }}>Подготовить время</button>
          {!manualValid ? <small className="shift-manual-error">{manualError}</small> : null}
        </div> : null}
      </article>;
    })}</div>
    {meaningful.length > 3 ? <button type="button" className="shift-recommendation-more" onClick={() => setExpanded(value => !value)}>{expanded ? 'Свернуть' : `Показать еще ${meaningful.length - shown.length} ${plural(meaningful.length - shown.length, ['бригаду', 'бригады', 'бригад'])}`}<ChevronDown className={expanded ? 'open' : ''}/></button> : null}
  </section>;
}

function RouteGapTimeline({ route, selectedKey, selectedOrderKey, onSelectGap, onSelectOrder, decisions = {}, axis }) {
  const axisStart = axis?.start ?? route.shiftStart;
  const axisEnd = axis?.end ?? route.shiftEnd;
  const range = Math.max(1, axisEnd - axisStart);
  const position = value => Math.max(0, Math.min(100, (value - axisStart) / range * 100));
  const openGaps = route.gaps.filter(gap => !decisions[gap.key]);
  const largestGap = [...openGaps].sort((left, right) => right.minutes - left.minutes)[0];
  const ticks = axis?.ticks || Array.from({ length: Math.max(2, Math.floor((route.shiftEnd - route.shiftStart) / 120) + 1) }, (_, index) => Math.min(route.shiftEnd, Math.ceil(route.shiftStart / 120) * 120 + index * 120)).filter((value, index, values) => value >= route.shiftStart && (index === 0 || value !== values[index - 1]));
  return <article className="route-gap-timeline">
    <header><div><b>{route.engineerName}</b><small>{route.assignments.length} {plural(route.assignments.length, ['заказ', 'заказа', 'заказов'])} · смена {timeLabel(route.shiftStart)}–{timeLabel(route.shiftEnd)}</small></div><em className={!largestGap ? 'resolved' : ''}>{largestGap ? `${largestGap.customerCall ? 'Окно' : 'Резерв'} ${largestGap.minutes} мин (${timeLabel(largestGap.start)}–${timeLabel(largestGap.end)})` : route.shiftOptimized ? 'Границы смены оптимизированы' : 'Ранние визиты отработаны'}</em></header>
    <div className="route-gap-track" aria-label={`План работ ${route.engineerName}`}>
      {axis ? <span className="route-gap-shift-range" style={{ left: `${position(route.shiftStart)}%`, width: `${position(route.shiftEnd) - position(route.shiftStart)}%` }} title={`Смена ${timeLabel(route.shiftStart)}–${timeLabel(route.shiftEnd)}`}/> : null}
      {route.assignments.map((assignment, index) => <button type="button" className={`route-gap-job ${selectedOrderKey === assignment.key ? 'selected' : ''}`} key={assignment.key} title={`${index + 1}. ${assignment.orderName}: ${timeLabel(assignment.start)}–${timeLabel(assignment.end)}`} aria-label={`Открыть заказ ${index + 1}: ${assignment.orderName}`} onClick={() => onSelectOrder?.(route, assignment, index)} style={{ left: `${position(assignment.start)}%`, width: `${Math.max(1.8, position(assignment.end) - position(assignment.start))}%` }}><b>{index + 1}</b></button>)}
      {route.gaps.map(gap => { const decision = decisions[gap.key]; return <button type="button" key={gap.key} className={`route-gap-marker ${gap.customerCall && !decision ? 'call' : ''} ${decision ? 'resolved' : ''} ${selectedKey === gap.key ? 'selected' : ''}`} title={decision ? `Клиент отказался от раннего визита; сохранено время ${timeLabel(decision.fixedStart)}` : gap.customerCall ? `Возможен ранний визит по «${gap.nextOrderName}»` : `Окно ${gap.minutes} мин`} aria-label={decision ? `Ранний визит отработан, сохранено время ${timeLabel(decision.fixedStart)}` : gap.customerCall ? `Возможен ранний визит по заявке ${gap.nextOrderName}` : `Свободное окно ${gap.minutes} мин`} onClick={() => onSelectGap(gap)} style={{ left: `${position(gap.start)}%`, width: `${Math.max(1.2, position(gap.end) - position(gap.start))}%` }}><span>{decision ? 'Окно сохранено' : gap.customerCall ? 'Ранний визит' : `Окно ${gap.minutes} мин`}</span></button>; })}
    </div>
    <div className="route-gap-scale">{ticks.map(tick => <span key={tick} style={{ left: `${position(tick)}%` }}>{timeLabel(tick)}</span>)}</div>
  </article>;
}

function WindowReservePanel({ gaps = [], timelines = [], recommendations = [], decisionScope = 'current', onOpenRoute, onOpenUnassigned }) {
  const [selectedKey, setSelectedKey] = useState('');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [draftKind, setDraftKind] = useState('');
  const [shiftMode, setShiftMode] = useState('algorithm');
  const [manualShift, setManualShift] = useState({ start: '', end: '' });
  const [showAll, setShowAll] = useState(false);
  const [visitDecisions, setVisitDecisions] = useState(() => { try { return JSON.parse(localStorage.getItem('beego-early-visit-decisions') || '{}'); } catch { return {}; } });
  const [shiftOptimizations, setShiftOptimizations] = useState(() => { try { return JSON.parse(localStorage.getItem('beego-shift-optimizations') || '{}'); } catch { return {}; } });
  const scopedDecisionKey = gap => `${decisionScope}:${gap.nextOrderId || gap.key}`;
  const scopedShiftKey = engineerId => `${decisionScope}:${engineerId}`;
  const scopedDecisions = Object.fromEntries(gaps.map(gap => [gap.key, visitDecisions[scopedDecisionKey(gap)]]).filter(([, decision]) => decision));
  const appliedShiftIds = new Set(recommendations.filter(item => shiftOptimizations[scopedShiftKey(item.engineerId)]).map(item => String(item.engineerId)));
  const appliedShiftValues = Object.fromEntries(recommendations.map(item => [String(item.engineerId), shiftOptimizations[scopedShiftKey(item.engineerId)]]).filter(([, value]) => value));
  const selected = gaps.find(item => item.key === selectedKey);
  const selectedDecision = selected ? scopedDecisions[selected.key] : null;
  useEffect(() => {
    if (!selected || !['late_start', 'early_finish'].includes(selected.proposal.kind)) return;
    const recommendation = recommendations.find(item => String(item.engineerId) === String(selected.engineerId));
    setShiftMode('algorithm');
    setManualShift({
      start: timeLabel(recommendation?.recommendedStart ?? (selected.proposal.kind === 'late_start' ? Math.max(selected.start, selected.end - 15) : selected.start)),
      end: timeLabel(recommendation?.recommendedEnd ?? (selected.proposal.kind === 'early_finish' ? selected.start : selected.end)),
    });
  }, [selectedKey]);
  useEffect(() => {
    if (!selectedKey) return undefined;
    const close = event => {
      if (event.key === 'Escape') {
        setSelectedKey('');
        setSelectedOrder(null);
        setDraftKind('');
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [selectedKey]);
  if (!gaps.length) return <section className="analytics-panel window-reserve-panel"><SectionHeading eyebrow="РЕЗЕРВ В СМЕНАХ" title="Свободных промежутков нет" description="В этом плане нет промежутков от 45 минут до первого выезда, между визитами или после последней работы. Стандартный 15-минутный запас перед визитом не считается простоем."/><ShiftRecommendationTable recommendations={recommendations}/></section>;
  const choose = gap => {
    setSelectedOrder(null);
    setSelectedKey(gap.key);
    setDraftKind('');
  };
  const closeDetails = () => {
    setSelectedKey('');
    setSelectedOrder(null);
    setDraftKind('');
  };
  const persistVisitDecision = decision => {
    if (!selected) return;
    setVisitDecisions(current => {
      const next = { ...current, [scopedDecisionKey(selected)]: decision };
      try { localStorage.setItem('beego-early-visit-decisions', JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const declineEarlyVisit = () => {
    if (!selected?.customerCall || selected.nextStart == null) return;
    persistVisitDecision({ status: 'declined', fixedStart: selected.nextStart, decidedAt: new Date().toISOString() });
    closeDetails();
  };
  const applyShiftRecommendations = items => {
    setShiftOptimizations(current => {
      const next = { ...current };
      items.forEach(item => { next[scopedShiftKey(item.engineerId)] = { recommendedStart: item.recommendedStart, recommendedEnd: item.recommendedEnd, source: item.source || 'algorithm', appliedAt: new Date().toISOString() }; });
      try { localStorage.setItem('beego-shift-optimizations', JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const revertShiftRecommendations = items => {
    setShiftOptimizations(current => {
      const next = { ...current };
      items.forEach(item => { delete next[scopedShiftKey(item.engineerId)]; });
      try { localStorage.setItem('beego-shift-optimizations', JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const typeLabel = gap => gap.type === 'before_first'
    ? `До первого визита: ${gap.nextOrderName}`
    : gap.type === 'between'
      ? `Перед визитом: ${gap.nextOrderName}`
      : 'После последнего визита';
  const confirmProposal = () => {
    if (!selected) return;
    if (selected.proposal.kind === 'insert') onOpenUnassigned?.();
    else if (['late_start', 'early_finish'].includes(selected.proposal.kind)) {
      const recommendation = recommendations.find(item => String(item.engineerId) === String(selected.engineerId));
      const start = shiftMode === 'manual' ? minutesFromTime(manualShift.start) : recommendation?.recommendedStart;
      const end = shiftMode === 'manual' ? minutesFromTime(manualShift.end) : recommendation?.recommendedEnd;
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) applyShiftRecommendations([{ ...(recommendation || {}), engineerId: selected.engineerId, recommendedStart: start, recommendedEnd: end, source: shiftMode }]);
      setDraftKind(`${selected.proposal.kind}:${shiftMode}`);
    } else setDraftKind(selected.proposal.kind);
  };
  const candidate = selected?.candidate;
  const savedMinutes = selected ? (selected.proposal.kind === 'late_start' ? Math.max(0, selected.minutes - 15) : selected.proposal.kind === 'call_customer' ? selected.customerCall?.savedMinutes || 0 : selected.minutes) : 0;
  const transport = { CAR: [Car, 'Автомобиль'], WALKING: [Footprints, 'Пешеход'], BICYCLE: [Bike, 'Велосипед'], PUBLIC_TRANSIT: [Bus, 'Общ. транспорт'], TRANSIT: [Bus, 'Общ. транспорт'] };
  const [SelectedTransportIcon, selectedTransportLabel] = selected?.engineerTransport ? transport[selected.engineerTransport] || [null, ''] : [null, ''];
  const selectedOrderNumber = String(selected?.nextOrderSourceId || selected?.nextOrderId || '').match(/(\d+)$/)?.[1] || '';
  const selectedOrderLabel = selectedOrderNumber ? `Заявка №${selectedOrderNumber}` : selected?.nextOrderName || '';
  const selectedSkillLabel = selected?.nextOrderSkill ? `${selected.nextOrderSkill.charAt(0).toLocaleUpperCase('ru-RU')}${selected.nextOrderSkill.slice(1)}` : '';
  const formatAddress = value => String(value || '').replace(/(ул|пр-кт|просп|пер|д|к|стр)\.(?=\S)/giu, '$1. ');
  const recommendationByEngineer = new Map(recommendations.map(item => [String(item.engineerId), item]));
  const adjustedTimelines = timelines.map(route => {
    const recommendation = recommendationByEngineer.get(String(route.engineerId));
    const applied = shiftOptimizations[scopedShiftKey(route.engineerId)];
    if (!recommendation || !applied) return route;
    return { ...route, shiftStart: applied.recommendedStart, shiftEnd: applied.recommendedEnd, shiftOptimized: true, gaps: route.gaps.filter(gap => gap.type === 'between' && gap.start >= applied.recommendedStart && gap.end <= applied.recommendedEnd) };
  });
  const visibleTimelines = showAll ? adjustedTimelines : adjustedTimelines.slice(0, 8);
  return <section className="analytics-panel window-reserve-panel">
    <SectionHeading eyebrow="РЕЗЕРВ В СМЕНАХ" title="Где простаивают бригады"/>
    <div className="route-gap-legend"><span><i className="job"/>заказ</span><span><i className="call"/>возможен ранний визит</span><span><i className="reserve"/>другой свободный интервал</span></div>
    <div className="route-gap-list">{visibleTimelines.map(route => <RouteGapTimeline key={route.engineerId} route={route} selectedKey={selected?.key || ''} selectedOrderKey={selectedOrder?.assignment?.key || ''} onSelectGap={choose} onSelectOrder={(routeItem, assignment, index) => { setSelectedKey(''); setDraftKind(''); setSelectedOrder({ route: routeItem, assignment, index }); }} decisions={scopedDecisions}/>)}</div>
    {timelines.length > 8 ? <button type="button" className="route-gap-show-all" onClick={() => setShowAll(value => !value)}>{showAll ? 'Показать основные бригады' : `Показать все бригады (${timelines.length})`}</button> : null}
    <ShiftRecommendationTable recommendations={recommendations} appliedIds={appliedShiftIds} appliedValues={appliedShiftValues} onApply={item => applyShiftRecommendations([item])} onApplyAll={applyShiftRecommendations} onRevert={item => revertShiftRecommendations([item])} onRevertAll={revertShiftRecommendations}/>
    {selectedOrder ? <div className="window-reserve-drawer-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && closeDetails()}><aside className="window-reserve-drawer order-details-drawer" role="dialog" aria-modal="true" aria-label={`Информация о заказе ${selectedOrder.index + 1}`}>
      <header><div><small>ЗАКАЗ {selectedOrder.index + 1} В МАРШРУТЕ</small><h2>{selectedOrder.assignment.orderName}</h2><p>{selectedOrder.route.engineerName} · {selectedOrder.route.zone}</p></div><button type="button" onClick={closeDetails} aria-label="Закрыть подробности"><X/></button></header>
      <section className="window-drawer-recommendation"><small>ПЛАН ВИЗИТА</small><h3>{timeLabel(selectedOrder.assignment.start)}–{timeLabel(selectedOrder.assignment.end)}</h3><p>Клиентское окно и положение заказа в маршруте показаны по опубликованному плану.</p></section>
      <div className="window-drawer-metrics"><span><small>Начало</small><b>{timeLabel(selectedOrder.assignment.start)}</b></span><span><small>Завершение</small><b>{timeLabel(selectedOrder.assignment.end)}</b></span><span><small>Длительность</small><b>{Math.max(0, selectedOrder.assignment.end - selectedOrder.assignment.start)} мин</b></span></div>
      <section className="window-drawer-order"><small>ДЕТАЛИ ЗАЯВКИ</small><ul><li><b>Бригада:</b> {selectedOrder.route.engineerName}</li><li><b>Зона:</b> {selectedOrder.route.zone}</li><li><b>Смена:</b> {timeLabel(selectedOrder.route.shiftStart)}–{timeLabel(selectedOrder.route.shiftEnd)}</li>{selectedOrder.assignment.address ? <li><b>Адрес:</b> {selectedOrder.assignment.address}</li> : null}{selectedOrder.assignment.skill ? <li><b>Навык:</b> {SKILL_LABELS[selectedOrder.assignment.skill] || selectedOrder.assignment.skill}</li> : null}</ul></section>
      <footer className="window-reserve-buttons"><button type="button" className="secondary" onClick={() => onOpenRoute?.(selectedOrder.route.engineerId)}>Открыть весь маршрут</button><button type="button" className="primary" onClick={closeDetails}>Готово</button></footer>
    </aside></div> : null}
    {selected ? <div className="window-reserve-drawer-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && closeDetails()}><aside className="window-reserve-drawer" role="dialog" aria-modal="true" aria-label={`Разбор свободного промежутка ${selected.engineerName}`}>
      <header><div><small>СВОБОДНЫЙ ПРОМЕЖУТОК</small><h2>{selected.engineerName} · {selected.zone}</h2>{SelectedTransportIcon || selected.routeActive ? <p className="window-drawer-route-meta">{SelectedTransportIcon ? <><SelectedTransportIcon/>{selectedTransportLabel}</> : null}{SelectedTransportIcon && selected.routeActive ? <i/> : null}{selected.routeActive ? <span>Маршрут активен</span> : null}</p> : null}</div><button type="button" onClick={closeDetails} aria-label="Закрыть подробности"><X/></button></header>
      <section className={`window-drawer-recommendation ${selectedDecision ? 'resolved' : ''}`}><small>{selectedDecision ? 'РЕШЕНИЕ ЗАФИКСИРОВАНО' : 'РЕКОМЕНДАЦИЯ СИСТЕМЫ'}</small>{selectedDecision ? <><h3>Клиент отказался от раннего визита</h3><p>Согласованное время {timeLabel(selectedDecision.fixedStart)} сохранено. Этот интервал больше не требует внимания диспетчера.</p></> : selected.proposal.kind === 'call_customer' ? <><h3>Предложить ранний визит{selectedOrderLabel ? `: ${selectedOrderLabel}` : ''}</h3><p>Предыдущий заказ завершается в {timeLabel(selected.start)}. Предложите клиенту перенести начало с {timeLabel(selected.nextStart)} на {timeLabel(selected.customerCall?.proposedStart)}.</p></> : <><h3>{selected.proposal.title}</h3><p>{selected.proposal.impact} {candidate ? `Заявка «${candidate.orderName}» может поместиться с ${timeLabel(candidate.start)} до ${timeLabel(candidate.finish)}.` : typeLabel(selected)}</p></>}</section>
      <div className="window-drawer-metrics"><span><small>{selected.proposal.kind === 'call_customer' ? 'Ожидание до выезда' : 'Простой сейчас'}</small><b>{selected.minutes} мин</b></span>{selected.travelMinutes != null ? <span><small>Дорога к адресу</small><b>{selected.travelMinutes} мин{selected.travelDistanceKm != null ? ` (${number(selected.travelDistanceKm)} км)` : ''}</b></span> : null}{candidate || savedMinutes ? <span><small>{candidate ? 'Можно проверить' : selected.proposal.kind === 'call_customer' ? 'Сокращение ожидания' : 'Экономия времени'}</small><b>{candidate ? '1 заявка' : `−${savedMinutes} мин`}</b></span> : null}</div>
      {selected.proposal.kind === 'call_customer' && (selected.nextClientName || selected.nextClientPhone || selected.nextOrderAddress || selected.nextWindowStart != null || selected.nextWindowEnd != null || selected.customerCall?.proposedStart != null || selectedSkillLabel || selected.nextOrderDuration != null) ? <section className="window-drawer-order"><small>ПАРАМЕТРЫ ЗАЯВКИ{selectedOrderNumber ? ` №${selectedOrderNumber}` : ''}</small><ul>{selected.nextClientName ? <li><b>Клиент:</b> {selected.nextClientName}</li> : null}{selected.nextClientPhone ? <li><b>Телефон:</b> {selected.nextClientPhone}</li> : null}{selected.nextOrderAddress ? <li><b>Адрес клиента:</b> {formatAddress(selected.nextOrderAddress)}</li> : null}{selected.nextWindowStart != null && selected.nextWindowEnd != null ? <li><b>Согласованное окно:</b> {timeLabel(selected.nextWindowStart)}–{timeLabel(selected.nextWindowEnd)}</li> : null}{selected.customerCall?.proposedStart != null ? <li><b>Предлагаемое время:</b> {timeLabel(selected.customerCall.proposedStart)} — начало визита</li> : null}{selectedSkillLabel || selected.nextOrderDuration != null ? <li><b>Тип работ:</b> {selectedSkillLabel}{selectedSkillLabel && selected.nextOrderDuration != null ? ` · норматив ${selected.nextOrderDuration} мин` : selected.nextOrderDuration != null ? `Норматив ${selected.nextOrderDuration} мин` : ''}</li> : null}</ul></section> : null}
      {selected.proposal.kind !== 'call_customer' ? <section className="window-drawer-proposal"><small>{typeLabel(selected)}</small><b>{candidate ? `Кандидат из очереди: ${candidate.orderName}` : selected.proposal.action}</b><p>{candidate ? 'Проверены зона, навык, окно заявки и 20 минут на переход с обеих сторон.' : 'Изменение создаётся как черновик и требует подтверждения диспетчера.'}</p>{['late_start', 'early_finish'].includes(selected.proposal.kind) ? <div className="window-shift-editor"><div className="window-shift-modes"><button type="button" className={shiftMode === 'algorithm' ? 'active' : ''} onClick={() => setShiftMode('algorithm')}>По алгоритму</button><button type="button" className={shiftMode === 'manual' ? 'active' : ''} onClick={() => setShiftMode('manual')}>Задать вручную</button></div>{shiftMode === 'manual' ? <div className="window-shift-times"><ManualTimeField label="Начало смены" value={manualShift.start} onChange={value => setManualShift(current => ({ ...current, start: value }))}/><ManualTimeField label="Конец смены" value={manualShift.end} onChange={value => setManualShift(current => ({ ...current, end: value }))}/></div> : <div className="window-shift-algorithm"><Check/><span>Будут применены безопасные границы с запасом до первого и после последнего визита.</span></div>}</div> : null}{candidate && selected.customerCall ? <button type="button" onClick={() => setDraftKind('call_customer')}>Или подготовить звонок клиенту</button> : null}</section> : null}
      {!selectedDecision ? <p className="window-reserve-disclaimer">Изменения не публикуются автоматически. Перед применением точный планировщик повторно проверит дороги, окна и ограничения.</p> : null}
      {!selectedDecision && draftKind ? <div className="window-reserve-draft"><Check/><div><b>{draftKind === 'call_customer' ? 'Предложение раннего визита готово' : 'Черновик изменения смены готов'}</b><span>{draftKind === 'call_customer' ? `Уточните у клиента по «${selected.nextOrderName}», удобно ли начать в ${timeLabel(selected.customerCall?.proposedStart || selected.nextStart)} вместо ${timeLabel(selected.nextStart)}. При согласии бригада выедет в ${timeLabel(selected.customerCall?.proposedDeparture)} вместо ${timeLabel(selected.customerCall?.originalDeparture)}; ожидание до выезда сократится на ${selected.customerCall?.savedMinutes || 0} мин. Затем нужен точный пересчёт маршрута.` : draftKind.startsWith('late_start') || draftKind.startsWith('early_finish') ? `Для ${selected.engineerName} подготовлены границы ${manualShift.start}–${manualShift.end} (${draftKind.endsWith('manual') ? 'заданы диспетчером' : 'рассчитаны алгоритмом'}).` : `Промежуток ${timeLabel(selected.start)}–${timeLabel(selected.end)} отмечен как резерв для срочной заявки.`}</span></div></div> : null}
      <footer className="window-reserve-buttons"><button type="button" className="secondary" onClick={() => onOpenRoute?.(selected.engineerId)}>Открыть маршрут</button>{!selectedDecision && selected.proposal.kind === 'call_customer' && selected.nextStart != null ? <button type="button" className="decline" onClick={declineEarlyVisit}>Клиент отказался · сохранить {timeLabel(selected.nextStart)}</button> : null}{!selectedDecision ? <button type="button" className="primary" onClick={confirmProposal} disabled={shiftMode === 'manual' && (!manualShift.start || !manualShift.end || minutesFromTime(manualShift.end) <= minutesFromTime(manualShift.start))}>{selected.proposal.kind === 'call_customer' ? `Согласовать сдвиг на ${timeLabel(selected.customerCall?.proposedStart)}` : ['late_start', 'early_finish'].includes(selected.proposal.kind) ? shiftMode === 'manual' ? 'Применить выбранное время' : 'Принять рекомендацию' : selected.proposal.action}</button> : null}</footer>
    </aside></div> : null}
  </section>;
}

function BaselineComparison({ data }) {
  const baseline = data.baseline;
  const optimizedAverage = data.assigned ? data.distance / data.assigned : 0;
  const orderEffect = data.assigned - baseline.baselineAssignedCount;
  const engineerEffect = baseline.baselineEngineersUsed - data.activeEngineers;
  const distanceEffect = baseline.baselineTotalDistanceKm - data.distance;
  const averageEffect = baseline.baselineAvgKmPerOrder - optimizedAverage;
  const averageEffectPercent = baseline.baselineAvgKmPerOrder ? averageEffect / baseline.baselineAvgKmPerOrder * 100 : 0;
  const volumeEffectPercent = baseline.baselineAssignedCount ? orderEffect / baseline.baselineAssignedCount * 100 : 0;
  const tone = value => value > .05 ? 'positive' : value < -.05 ? 'negative' : 'neutral';
  const distanceContext = distanceEffect < -.05 && orderEffect > 0
    ? `+${number(Math.abs(distanceEffect))} км обусловлены выполнением +${orderEffect} дополнительных заявок (+${number(Math.round(volumeEffectPercent))}% к объёму работ)`
    : distanceEffect > .05
      ? `Суммарный пробег сократился на ${number(distanceEffect)} км при ${orderEffect >= 0 ? 'не меньшем' : 'меньшем'} объёме работ`
      : 'Суммарный пробег практически не изменился';
  const rows = [
    ['Назначение заявок', `${baseline.baselineAssignedCount} из ${data.total} (${number(percent(baseline.baselineAssignedCount, data.total))}%)`, `${data.assigned} из ${data.total} (${number(data.coverage)}%)`, orderEffect > 0 ? `+${orderEffect} ${plural(orderEffect, ['назначенная заявка', 'назначенные заявки', 'назначенных заявок'])}` : orderEffect < 0 ? `На ${Math.abs(orderEffect)} ${plural(Math.abs(orderEffect), ['заявку', 'заявки', 'заявок'])} меньше назначено` : 'Покрытие без изменений', tone(orderEffect)],
    ['Бригад на линии', `${baseline.baselineEngineersUsed} из ${data.availableEngineers}`, `${data.activeEngineers} из ${data.availableEngineers}`, engineerEffect > 0 ? `Резерв ${engineerEffect} ${plural(engineerEffect, ['бригады', 'бригад', 'бригад'])} под аварии или экономию ФОТ` : engineerEffect < 0 ? `Потребовалось на ${Math.abs(engineerEffect)} ${plural(Math.abs(engineerEffect), ['бригаду', 'бригады', 'бригад'])} больше` : 'Количество бригад без изменений', tone(engineerEffect)],
    ['Суммарный пробег', `${number(baseline.baselineTotalDistanceKm)} км`, `${number(data.distance)} км`, distanceContext, 'neutral'],
    ['Пробег на заявку', `${number(baseline.baselineAvgKmPerOrder)} км`, `${number(optimizedAverage)} км`, averageEffect > 0 ? `Экономия ${number(averageEffect)} км на каждом визите (−${number(Math.round(averageEffectPercent))}%)` : averageEffect < 0 ? `На ${number(Math.abs(averageEffect))} км больше на визит (+${number(Math.round(Math.abs(averageEffectPercent)))}%)` : 'Без изменения', tone(averageEffect), 'key-efficiency'],
  ];
  return <section className="analytics-panel baseline-comparison">
    <SectionHeading eyebrow="ЭФФЕКТИВНОСТЬ АЛГОРИТМА" title="Бейзлайн против нашего оптимизатора" description="Одинаковые заявки и бригады: бейзлайн распределяет их по порядку, оптимизатор перестраивает маршруты с учётом всех ограничений"/>
    <div className="baseline-versus" aria-label="Главное сравнение эффективности">
      <article className="baseline-side"><small>БЕЙЗЛАЙН · FCFS</small><b>{baseline.baselineAssignedCount}<span> из {data.total}</span></b><p>{number(percent(baseline.baselineAssignedCount, data.total))}% заявок вошли в план</p></article>
      <div className="baseline-vs"><span>VS</span><strong>{orderEffect > 0 ? `+${orderEffect}` : orderEffect}</strong><small>{plural(Math.abs(orderEffect), ['заявка', 'заявки', 'заявок'])}</small></div>
      <article className="optimizer-side"><small>НАШ ОПТИМИЗАТОР</small><b>{data.assigned}<span> из {data.total}</span></b><p>{number(data.coverage)}% заявок вошли в план</p></article>
    </div>
    <div className="baseline-result-callout"><Target/><div><small>ГЛАВНЫЙ РЕЗУЛЬТАТ</small><b>{orderEffect > 0 ? `Дополнительно назначено ${orderEffect} ${plural(orderEffect, ['заявка', 'заявки', 'заявок'])}` : orderEffect < 0 ? `На ${Math.abs(orderEffect)} ${plural(Math.abs(orderEffect), ['заявку', 'заявки', 'заявок'])} меньше, чем в бейзлайне` : 'Покрытие осталось на уровне бейзлайна'}</b></div></div>
    <div className="baseline-table"><header><span>Метрика</span><span>Бейзлайн</span><span>Наш оптимизатор</span><span>Что изменилось</span></header>{rows.slice(1).map(([label, baseValue, optimizedValue, effect, effectTone, rowClass]) => <article className={rowClass || undefined} key={label}><b>{label}</b><span>{baseValue}</span><strong>{optimizedValue}</strong><em className={effectTone}>{effect}</em></article>)}</div>
  </section>;
}

function ShiftView({ data, onOpenUnassigned, onOpenResource, onOpenRoutes, onOpenWindows, onInspect, isArchived = false }) {
  const mainNeed = data.needs[0];
  const urgentOpen = Math.max(0, data.urgentTotal - data.urgentAssigned);
  const actions = [
    urgentOpen ? {
      tone: 'danger', icon: AlertTriangle, title: `${urgentOpen} ${plural(urgentOpen, ['срочная заявка не назначена', 'срочные заявки не назначены', 'срочных заявок не назначено'])}`,
      text: 'Разберите их раньше обычной очереди.', action: 'Открыть срочные', onClick: onOpenUnassigned,
    } : null,
    data.unassigned ? {
      tone: 'danger', icon: UserRoundPlus, title: isArchived ? 'Не хватило ресурса в зоне' : 'Проверить ресурс в зоне',
      text: mainNeed ? `${mainNeed.count} ${plural(mainNeed.count, ['заявка', 'заявки', 'заявок'])}: ${SKILL_LABELS[mainNeed.skill] || mainNeed.skill.toLocaleLowerCase('ru-RU')}, зона «${mainNeed.zone}».` : `${data.unassigned} заявок не вошли в план.`,
      action: 'Показать бригады и заявку', onClick: onOpenResource,
    } : null,
    data.lateStarts.length ? {
      tone: 'warning', icon: Clock3, title: `${data.lateStarts.length} ${plural(data.lateStarts.length, ['поздний старт в плане', 'поздних старта в плане', 'поздних стартов в плане'])}`,
      text: 'Плановое начало выходит за клиентское окно.', action: 'Открыть маршруты', onClick: onOpenRoutes,
    } : null,
    data.operationalGaps.length ? {
      tone: 'neutral', icon: Gauge, title: `${data.operationalGaps.length} ${plural(data.operationalGaps.length, ['свободный промежуток', 'свободных промежутка', 'свободных промежутков'])} в сменах`,
      text: 'Проверьте, можно ли безопасно закрыть очередь или сдвинуть границы смены.',
      action: 'Открыть резервы', onClick: onOpenWindows,
    } : null,
  ].filter(Boolean).slice(0, 3);
  const orderDelta = data.assigned - data.baseline.baselineAssignedCount;
  const engineerSaving = data.baseline.baselineEngineersUsed - data.activeEngineers;
  const optimizedAverageDistance = data.assigned ? data.distance / data.assigned : 0;
  const averageDistanceSaving = data.baseline.baselineAvgKmPerOrder - optimizedAverageDistance;
  const averageDistanceSavingPercent = data.baseline.baselineAvgKmPerOrder ? averageDistanceSaving / data.baseline.baselineAvgKmPerOrder * 100 : 0;
  return <div className="shift-workspace">
    <div className="analytics-kpis">
      <MetricCard icon={Target} label="Заявки в плане" value={`${data.assigned} из ${data.total}`} note={`${number(data.coverage)}% спроса закрыто`} tone={data.coverage >= 99 ? 'good' : 'attention'} delta={`${orderDelta > 0 ? '+' : orderDelta < 0 ? '−' : ''}${Math.abs(orderDelta)} ${plural(Math.abs(orderDelta), ['заявка', 'заявки', 'заявок'])} vs Бейзлайн`} deltaTone={orderDelta > 0 ? 'positive' : orderDelta < 0 ? 'negative' : 'neutral'}/>
      <MetricCard icon={AlertTriangle} label="Аварии" value={`${data.urgentAssigned} из ${data.urgentTotal}`} note={data.urgentAssigned === data.urgentTotal ? 'Все срочные заявки назначены' : `${data.urgentTotal - data.urgentAssigned} требуют решения`} tone={data.urgentAssigned === data.urgentTotal ? 'good' : 'attention'}/>
      <MetricCard icon={Users} label="Задействованные бригады" value={`${data.activeEngineers}/${data.availableEngineers}`} note={data.idleCount ? `${data.idleCount} ${plural(data.idleCount, ['бригада без маршрута', 'бригады без маршрута', 'бригад без маршрута'])}` : 'Вся команда задействована'} delta={`${engineerSaving > 0 ? '−' : engineerSaving < 0 ? '+' : ''}${Math.abs(engineerSaving)} ${plural(Math.abs(engineerSaving), ['бригада', 'бригады', 'бригад'])} vs Бейзлайн`} deltaTone={engineerSaving > 0 ? 'positive' : engineerSaving < 0 ? 'negative' : 'neutral'}/>
      <MetricCard icon={MapPin} label="Общий пробег" value={`${number(data.distance)} км`} note={`${number(optimizedAverageDistance)} км на назначенную заявку`} delta={`${averageDistanceSaving > 0 ? '−' : averageDistanceSaving < 0 ? '+' : ''}${number(Math.abs(averageDistanceSaving))} км на заявку (${averageDistanceSaving > 0 ? '−' : averageDistanceSaving < 0 ? '+' : ''}${number(Math.round(Math.abs(averageDistanceSavingPercent)))}%) vs Бейзлайн`} deltaTone={averageDistanceSaving > 0 ? 'positive' : averageDistanceSaving < 0 ? 'negative' : 'neutral'}/>
    </div>

    <BaselineComparison data={data}/>

    <section className="analytics-panel analytics-actions-panel">
      <SectionHeading eyebrow={isArchived ? 'РАЗБОР СМЕНЫ' : 'СИГНАЛЫ СМЕНЫ'} title={isArchived ? 'Что требовало внимания' : 'Что сделать сейчас'} description={isArchived ? 'Сигналы, которые объясняют результат выбранного дня' : 'Только сигналы, которые могут изменить итог смены'}/>
      <div className="analytics-action-list">{actions.length ? actions.map(({ tone, icon: Icon, title, text, action, onClick }, index) => <article className={tone} key={title}>
        <span className="analytics-action-number">{index + 1}</span><span className="analytics-action-icon"><Icon/></span>
        <div><b>{title}</b><p>{text}</p></div>
        {onClick ? <button type="button" onClick={onClick}>{action}<ChevronRight/></button> : !isArchived ? <span className="analytics-action-tag">{action}</span> : null}
      </article>) : <div className="analytics-all-clear"><Check/><div><b>Вмешательство не требуется</b><p>План закрывает спрос без опозданий и конфликтов.</p></div></div>}</div>
    </section>
    <UnassignedExplanationList explanations={data.explanations} onOpenOrder={onOpenUnassigned} onOpenResource={onOpenResource}/>
    <div className="analytics-two-column">
      <section className="analytics-panel">
        <SectionHeading eyebrow="ГДЕ НУЖНА ПОМОЩЬ" title="Покрытие по зонам" description="Показывает, где именно не хватает мощности"/>
        <div className="zone-health-list">{data.zones.map(zone => <div key={zone.name}>
          <span className={zone.unassigned ? 'zone-dot attention' : 'zone-dot'}>{zone.name.slice(0, 2).toLocaleUpperCase('ru-RU')}</span>
          <div><b>{zone.name}</b><span><i style={{ width: `${percent(zone.assigned, zone.total)}%` }}/></span></div>
          <strong>{zone.assigned}/{zone.total}</strong>
          <em className={zone.unassigned ? 'attention' : ''}>{zone.unassigned ? `${zone.unassigned} нужно решить` : 'всё в плане'}</em>
        </div>)}</div>
      </section>
      <section className="analytics-panel">
        <SectionHeading eyebrow="КУДА УХОДИТ ВРЕМЯ" title="Структура смены" description="Полный фонд времени: работа, дорога, запас перед визитами и свободный резерв"/>
        <div className="time-composition" aria-label="Структура времени смены">
          <span className="service" style={{ width: `${data.timeShares.service}%` }}/><span className="travel" style={{ width: `${data.timeShares.travel}%` }}/><span className="waiting" style={{ width: `${data.timeShares.waiting}%` }}/><span className="idle" style={{ width: `${data.timeShares.idle}%` }}/>
        </div>
        <div className="time-legend">
          <div><i className="service"/><span>Работа у клиента</span><b>{hours(data.service)}</b><small>{number(data.timeShares.service)}%</small></div>
          <div><i className="travel"/><span>Дорога</span><b>{hours(data.travel)}</b><small>{number(data.timeShares.travel)}%</small></div>
          <div><i className="waiting"/><span>Запас до визита</span><b>{hours(data.waiting)}</b><small>{number(data.timeShares.waiting)}%</small></div>
          <div><i className="idle"/><span>Резерв и простой смен</span><b>{hours(data.idle)}</b><small>{number(data.timeShares.idle)}%</small></div>
        </div>
      </section>
    </div>
  </div>;
}

const EARLY_FINISH_THRESHOLD_MINUTES = 90;
const NORMAL_CLOSING_BUFFER_MINUTES = 60;

function ShiftOptimizationDrawer({ recommendations = [], appliedIds = new Set(), appliedValues = {}, onApply, onApplyAll, onRevert, onSend, onClose, isLive = false }) {
  const [editingId, setEditingId] = useState('');
  const [manualTimes, setManualTimes] = useState({ start: '', end: '' });
  const allApplied = recommendations.length > 0 && recommendations.every(item => appliedIds.has(String(item.engineerId)));

  useEffect(() => {
    const closeOnEscape = event => event.key === 'Escape' && onClose?.();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  return <div className="resource-shift-drawer-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose?.()}>
    <aside className="resource-shift-drawer" role="dialog" aria-modal="true" aria-label="Настройка оптимизации смен">
      <header><div><small>ОПТИМИЗАЦИЯ ГРАФИКОВ</small><h2>Настройка оптимизации смен</h2><p>{recommendations.length} {plural(recommendations.length, ['смена', 'смены', 'смен'])} с избыточным временем — проверьте рекомендации или задайте границы вручную.</p></div><button type="button" className="resource-shift-drawer-close" onClick={onClose} aria-label="Закрыть"><X/></button></header>
      <div className="resource-shift-drawer-list">{recommendations.map(item => {
        const applied = appliedIds.has(String(item.engineerId));
        const appliedValue = appliedValues[String(item.engineerId)];
        const displayedStart = appliedValue?.recommendedStart ?? item.recommendedStart;
        const displayedEnd = appliedValue?.recommendedEnd ?? item.recommendedEnd;
        const saved = Math.max(0, displayedStart - item.shiftStart) + Math.max(0, item.shiftEnd - displayedEnd);
        const editing = editingId === String(item.engineerId);
        const manualStart = minutesFromTime(manualTimes.start);
        const manualEnd = minutesFromTime(manualTimes.end);
        const manualFormatValid = isValidTimeValue(manualTimes.start) && isValidTimeValue(manualTimes.end);
        const manualValid = manualFormatValid && manualEnd > manualStart;
        const manualError = !manualFormatValid ? 'Укажите время в формате ЧЧ:ММ.' : manualEnd <= manualStart ? 'Завершение смены должно быть позже начала.' : '';
        const toggleEditor = () => {
          setEditingId(editing ? '' : String(item.engineerId));
          setManualTimes({ start: timeLabel(displayedStart), end: timeLabel(displayedEnd) });
        };
        return <article className={applied ? 'applied' : ''} key={item.engineerId}>
          <div className="resource-shift-drawer-engineer"><i>{crewInitials(item.engineerName)}</i><span><b>{item.engineerName}</b><small>{item.assignments} {plural(item.assignments, ['визит', 'визита', 'визитов'])}</small></span></div>
          <div className="resource-shift-drawer-time"><span>{timeLabel(item.shiftStart)}–{timeLabel(item.shiftEnd)}</span><ArrowRight/><b>{timeLabel(displayedStart)}–{timeLabel(displayedEnd)}</b></div>
          <em>−{saved} мин</em>
          <div className="resource-shift-drawer-actions"><button type="button" className={`edit ${editing ? 'active' : ''}`} onClick={toggleEditor} aria-label={editing ? `Закрыть редактирование для ${item.engineerName}` : `Изменить смену ${item.engineerName} вручную`} title={editing ? 'Закрыть редактирование' : 'Изменить вручную'}><Pencil/></button>{applied ? <><span><Check/>Предложение</span><button type="button" className="apply" disabled={!isLive} onClick={() => onSend?.(item, appliedValue)}>Точная проверка</button><button type="button" className="revert" onClick={() => { onRevert?.(item); setEditingId(''); }}>Сбросить</button></> : <button type="button" className="apply" onClick={() => onApply?.({ ...item, source: 'algorithm' })}>Подготовить</button>}</div>
          {editing ? <div className="resource-shift-drawer-editor"><ManualTimeField label="Новое начало" value={manualTimes.start} onChange={value => setManualTimes(current => ({ ...current, start: value }))}/><ArrowRight/><ManualTimeField label="Новое завершение" value={manualTimes.end} onChange={value => setManualTimes(current => ({ ...current, end: value }))}/><button type="button" disabled={!manualValid} onClick={() => { onApply?.({ ...item, recommendedStart: manualStart, recommendedEnd: manualEnd, startSaved: Math.max(0, manualStart - item.shiftStart), endSaved: Math.max(0, item.shiftEnd - manualEnd), source: 'manual' }); setEditingId(''); }}>Сохранить время</button>{!manualValid ? <small>{manualError}</small> : null}</div> : null}
        </article>;
      })}</div>
      <footer><button type="button" className="secondary" onClick={onClose}>Закрыть</button><button type="button" className="primary" disabled={allApplied} onClick={() => onApplyAll?.(recommendations.filter(item => !appliedIds.has(String(item.engineerId))))}>{allApplied ? 'Все предложения готовы' : 'Подготовить для всех'}</button></footer>
    </aside>
  </div>;
}

function ResourcesView({ data, record, decisionScope = 'current', viewMode = 'summary', focusNeed, isLive = false, onViewModeChange, onOpenUnassigned, onOpenRoute, onOpenOrder, onPreviewReplan, onApplyReplan }) {
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('load-asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [skillFilter, setSkillFilter] = useState('all');
  const [zoneFilter, setZoneFilter] = useState('all');
  const [transportFilter, setTransportFilter] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [action, setAction] = useState(null);
  const [manualAction, setManualAction] = useState(null);
  const [timelineSelection, setTimelineSelection] = useState(null);
  const [timelineProposal, setTimelineProposal] = useState(null);
  const [recentlyChangedCrew, setRecentlyChangedCrew] = useState(null);
  useEffect(() => setRecentlyChangedCrew(null), [decisionScope]);
  const [timelineBusy, setTimelineBusy] = useState(false);
  const [timelineError, setTimelineError] = useState('');
  const [clientRequest, setClientRequest] = useState(null);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [manualPreview, setManualPreview] = useState(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState('');
  const [actionNote, setActionNote] = useState('');
  const [releasePreview, setReleasePreview] = useState(null);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseError, setReleaseError] = useState('');
  const [releaseAcknowledged, setReleaseAcknowledged] = useState(false);
  const [restoreAction, setRestoreAction] = useState(null);
  const [restorePreview, setRestorePreview] = useState(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [shiftDrawerOpen, setShiftDrawerOpen] = useState(false);
  const [shiftOptimizations, setShiftOptimizations] = useState(() => { try { return JSON.parse(localStorage.getItem('beego-shift-optimizations') || '{}'); } catch { return {}; } });
  useEffect(() => {
    if (!focusNeed) return;
    setZoneFilter(focusNeed.zone || 'all');
    setSkillFilter((SKILL_LABELS[focusNeed.skill] || focusNeed.skill || 'all').toLocaleLowerCase('ru-RU'));
    setFilter('all');
    setShowAll(true);
  }, [focusNeed]);
  const transport = { CAR: [Car, 'Автомобиль'], WALKING: [Footprints, 'Пешеход'], BICYCLE: [Bike, 'Велосипед'], PUBLIC_TRANSIT: [Bus, 'Общ. транспорт'], TRANSIT: [Bus, 'Общ. транспорт'], UNKNOWN: [Route, 'Транспорт не указан'] };
  const duration = value => { const minutes = Math.max(0, Math.round(Number(value) || 0)); return `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} ч` : ''}${Math.floor(minutes / 60) && minutes % 60 ? ' ' : ''}${minutes % 60 ? `${minutes % 60} мин` : ''}` || '0 мин'; };
  const crewName = value => `Бригада ${String(value || '').replace(/^бригада\s*/i, '').trim() || 'без имени'}`;
  const unresolvedOrders = useMemo(() => {
    const ids = new Set((record?.plan?.unassigned || []).map(item => String(item.orderId)));
    return (record?.orders || []).filter(order => ids.has(String(order.id)));
  }, [record]);
  const routeByEngineer = useMemo(() => new Map((record?.plan?.routes || []).map(route => [String(route.engineerId), route])), [record]);
  const orderById = useMemo(() => new Map((record?.orders || []).map(order => [String(order.id), order])), [record]);
  const timelineByEngineer = useMemo(() => {
    const calculated = new Map((data.routeTimelines || []).map(route => [String(route.engineerId), route]));
    (record?.plan?.routes || []).forEach(route => {
      const key = String(route.engineerId);
      if (calculated.has(key)) return;
      calculated.set(key, {
        engineerId: route.engineerId,
        engineerName: route.engineerName || route.engineerId,
        shiftStart: minutesFromTime(route.shiftStart),
        shiftEnd: minutesFromTime(route.shiftEnd),
        assignments: (route.assignments || []).map((assignment, index) => ({
          key: `${route.engineerId}:${assignment.orderId}:${index}`,
          orderId: assignment.orderId,
          orderName: orderById.get(String(assignment.orderId))?.name || `Заявка ${assignment.orderId}`,
          start: minutesFromTime(assignment.plannedStart),
          end: minutesFromTime(assignment.plannedFinish),
        })),
        gaps: [],
      });
    });
    return calculated;
  }, [data.routeTimelines, orderById, record]);
  const matchingOrders = team => unresolvedOrders.filter(order => orderZone(order) === team.zone && team.skills.map(item => item.toLocaleLowerCase('ru-RU')).includes((SKILL_LABELS[sourceSkill(order)] || sourceSkill(order)).toLocaleLowerCase('ru-RU')));
  const teams = useMemo(() => data.teamStats.map(team => {
    const route = routeByEngineer.get(String(team.engineerId));
    const candidates = matchingOrders(team);
    const postVisitFreeMinutes = team.hasRoute && team.lastFinishMinute != null
      ? Math.max(0, minutesFromTime(route?.shiftEnd || '') - team.lastFinishMinute)
      : 0;
    const shiftCanEndEarly = postVisitFreeMinutes >= EARLY_FINISH_THRESHOLD_MINUTES;
    const closingStatus = postVisitFreeMinutes < NORMAL_CLOSING_BUFFER_MINUTES
      ? 'В пределах нормы закрытия смены.'
      : `Меньше порога сокращения смены (${duration(EARLY_FINISH_THRESHOLD_MINUTES)}).`;
    const known = !team.hasRoute
      ? team.explanation
      : team.lastFinishMinute != null
        ? `Последний визит завершён в ${timeLabel(team.lastFinishMinute)}. Свободно после последнего визита: ${duration(postVisitFreeMinutes)}. ${shiftCanEndEarly ? (candidates.length ? `В очереди зоны есть ${candidates.length} подходящих заявок.` : 'В очереди зоны нет подходящих заявок.') : closingStatus}`
        : team.explanation;
    const source = (record?.team || []).find(engineer => String(engineer.id) === String(team.engineerId));
    const released = /снят со смены|недоступен/i.test(source?.status || '');
    return { ...team, status: source?.status || '', released, candidates, postVisitFreeMinutes, shiftCanEndEarly, closingStatus, known, suggestedFinish: shiftCanEndEarly ? Math.min(minutesFromTime(route?.shiftEnd || ''), team.lastFinishMinute + 15) : null };
  }), [data.teamStats, routeByEngineer, unresolvedOrders, record?.team]);
  const totals = useMemo(() => teams.reduce((sum, team) => ({ capacity: sum.capacity + team.capacityMinutes, busy: sum.busy + team.workMinutes + team.travelMinutes, reserve: sum.reserve + team.idleMinutes, idle: sum.idle + Number(!team.hasRoute) }), { capacity: 0, busy: 0, reserve: 0, idle: 0 }), [teams]);
  const averageLoad = totals.capacity ? Math.round(totals.busy / totals.capacity * 100) : 0;
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase('ru-RU');
  const matchesTransport = team => transportFilter === 'all'
    || (transportFilter === 'TRANSIT' ? ['PUBLIC_TRANSIT', 'TRANSIT'].includes(team.transport) : team.transport === transportFilter);
  const statusTeams = (filter === 'idle' ? teams.filter(team => !team.hasRoute) : filter === 'attention' ? teams.filter(team => !team.hasRoute || team.utilization < 70) : teams).filter(team => zoneFilter === 'all' || team.zone === zoneFilter);
  const matchingTeams = statusTeams.filter(team => {
    const matchesName = !normalizedSearch || crewName(team.engineerName).toLocaleLowerCase('ru-RU').includes(normalizedSearch);
    const matchesSkill = skillFilter === 'all' || team.skills.some(skill => skill.toLocaleLowerCase('ru-RU') === skillFilter);
    return matchesName && matchesSkill && matchesTransport(team);
  });
  const filteredTeams = [...matchingTeams].sort((a, b) => sort === 'load-desc' ? b.utilization - a.utilization || a.engineerName.localeCompare(b.engineerName, 'ru') : sort === 'orders-desc' ? b.assignments - a.assignments || b.utilization - a.utilization : sort === 'distance-desc' ? b.distanceKm - a.distanceKm || b.assignments - a.assignments : sort === 'name' ? crewName(a.engineerName).localeCompare(crewName(b.engineerName), 'ru') : a.utilization - b.utilization || a.engineerName.localeCompare(b.engineerName, 'ru'));
  const recentTeam = recentlyChangedCrew && teams.find(team => String(team.engineerId) === recentlyChangedCrew.id);
  const visibleTeams = recentTeam
    ? [recentTeam, ...(showAll ? filteredTeams : filteredTeams.slice(0, 12)).filter(team => String(team.engineerId) !== recentlyChangedCrew.id)]
    : showAll ? filteredTeams : filteredTeams.slice(0, 12);
  const timelineRoutes = [...timelineByEngineer.values()];
  const timelineAxis = timelineRoutes.length ? (() => {
    const start = Math.floor(Math.min(...timelineRoutes.map(route => route.shiftStart)) / 120) * 120;
    const end = Math.ceil(Math.max(...timelineRoutes.map(route => route.shiftEnd)) / 120) * 120;
    return { start, end, ticks: Array.from({ length: Math.floor((end - start) / 120) + 1 }, (_, index) => start + index * 120) };
  })() : null;
  const selectedOrder = unresolvedOrders.find(order => String(order.id) === selectedOrderId);
  const manualWarning = manualAction?.team && selectedOrder ? (!manualAction.team.skills.map(item => item.toLocaleLowerCase('ru-RU')).includes((SKILL_LABELS[sourceSkill(selectedOrder)] || sourceSkill(selectedOrder)).toLocaleLowerCase('ru-RU')) ? `Нельзя назначить: заявка требует навык «${SKILL_LABELS[sourceSkill(selectedOrder)] || sourceSkill(selectedOrder)}», которого нет у бригады.` : 'Навык и зона подходят предварительно. Окно, дорога и занятость проверяются планировщиком.') : '';
  const closeAction = () => { setAction(null); setSelectedOrderId(''); setActionNote(''); setReleasePreview(null); setReleaseError(''); setReleaseAcknowledged(false); setManualPreview(null); setManualError(''); };
  const previewManualAssignment = async () => {
    if (!selectedOrder || !manualAction?.team || !isLive || !record?.plan) return;
    const model = { orders: record.orders, team: record.team, event: { type: 'MANUAL_ASSIGN', orderId: selectedOrder.id, engineerId: manualAction.team.engineerId, time: '00:00' } };
    setManualBusy(true); setManualError(''); setManualPreview(null);
    try {
      const nextPlan = await onPreviewReplan?.(model, record.plan);
      const assignedToCrew = (nextPlan?.routes || []).some(route => String(route.engineerId) === String(manualAction.team.engineerId) && route.assignments?.some(item => String(item.orderId) === String(selectedOrder.id)));
      if (!assignedToCrew || nextPlan.publicationAllowed === false || nextPlan.validation?.status !== 'VALID') throw new Error('Проверенный план не назначил заявку выбранной бригаде.');
      setManualPreview({ model, plan: nextPlan });
    } catch (error) { setManualError(error?.message || 'Не удалось проверить назначение.'); }
    finally { setManualBusy(false); }
  };
  const previewRelease = async () => {
    if (!action?.team || !isLive || !record?.plan) return;
    const model = {
      orders: record.orders,
      team: record.team.map(engineer => String(engineer.id) === String(action.team.engineerId) ? { ...engineer, statusBeforeRelease: engineer.status || 'Доступен сегодня', status: 'Снят со смены', unavailableFrom: '00:00' } : engineer),
      event: { type: 'ENGINEER_UNAVAILABLE', time: '00:00', engineerId: action.team.engineerId },
    };
    setReleaseBusy(true);
    setReleaseError('');
    try {
      const nextPlan = await onPreviewReplan?.(model, record.plan);
      if (!nextPlan || nextPlan.publicationAllowed === false || nextPlan.validation?.status !== 'VALID') throw new Error('Планировщик не подтвердил новый план.');
      setReleasePreview({ model, plan: nextPlan });
    } catch (error) { setReleaseError(error?.message || 'Не удалось проверить изменение.'); }
    finally { setReleaseBusy(false); }
  };
  const previewRestore = async () => {
    if (!restoreAction?.team || !isLive || !record?.plan) return;
    const model = {
      orders: record.orders,
      team: record.team.map(engineer => {
        if (String(engineer.id) !== String(restoreAction.team.engineerId)) return engineer;
        const { statusBeforeRelease, unavailableFrom, ...rest } = engineer;
        return { ...rest, status: statusBeforeRelease || 'Доступен сегодня' };
      }),
      event: { type: 'CAPACITY_ADDED', time: '00:00', engineerId: restoreAction.team.engineerId },
    };
    setRestoreBusy(true);
    setRestoreError('');
    try {
      const nextPlan = await onPreviewReplan?.(model, record.plan);
      if (!nextPlan || nextPlan.publicationAllowed === false || nextPlan.validation?.status !== 'VALID') throw new Error('Планировщик не подтвердил новый план.');
      setRestorePreview({ model, plan: nextPlan });
    } catch (error) { setRestoreError(error?.message || 'Не удалось проверить возвращение на смену.'); }
    finally { setRestoreBusy(false); }
  };
  const scopedShiftKey = engineerId => `${decisionScope}:${engineerId}`;
  const shiftRecommendations = data.shiftRecommendations.filter(item => item.startSaved + item.endSaved >= 30);
  const totalShiftSaving = shiftRecommendations.reduce((sum, item) => sum + item.startSaved + item.endSaved, 0);
  const appliedShiftIds = new Set(shiftRecommendations.filter(item => shiftOptimizations[scopedShiftKey(item.engineerId)]).map(item => String(item.engineerId)));
  const appliedShiftValues = Object.fromEntries(shiftRecommendations.map(item => [String(item.engineerId), shiftOptimizations[scopedShiftKey(item.engineerId)]]).filter(([, value]) => value));
  const pendingShiftRecommendations = shiftRecommendations.filter(item => !appliedShiftIds.has(String(item.engineerId)));
  const allShiftRecommendationsApplied = shiftRecommendations.length > 0 && shiftRecommendations.every(item => appliedShiftIds.has(String(item.engineerId)));
  const applyShiftRecommendations = items => {
    setShiftOptimizations(current => {
      const next = { ...current };
      items.forEach(item => { next[scopedShiftKey(item.engineerId)] = { recommendedStart: item.recommendedStart, recommendedEnd: item.recommendedEnd, source: item.source || 'algorithm', appliedAt: new Date().toISOString() }; });
      try { localStorage.setItem('beego-shift-optimizations', JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const revertShiftRecommendations = items => {
    setShiftOptimizations(current => {
      const next = { ...current };
      items.forEach(item => { delete next[scopedShiftKey(item.engineerId)]; });
      try { localStorage.setItem('beego-shift-optimizations', JSON.stringify(next)); } catch {}
      return next;
    });
  };
  const sendShiftRecommendation = (item, prepared) => {
    if (!isLive || !onApplyReplan) return;
    onApplyReplan({ event: { type: 'SHIFT_BOUNDARY_CHANGED', engineerId: item.engineerId, shiftStart: timeLabel(prepared?.recommendedStart ?? item.recommendedStart), shiftEnd: timeLabel(prepared?.recommendedEnd ?? item.recommendedEnd), reason: 'Изменение графика по рекомендации диспетчера' } });
    setShiftDrawerOpen(false);
  };
  const renderKnown = text => { const match = String(text).match(/(Свободно после последнего визита:\s*)([^.]+)/); return match ? <>{text.slice(0, match.index)}{match[1]}<b>{match[2]}</b>{text.slice((match.index || 0) + match[0].length)}</> : text; };
  const selectedRecommendation = timelineSelection ? data.shiftRecommendations.find(item => String(item.engineerId) === String(timelineSelection.team.engineerId)) : null;
  const routeSignature = route => JSON.stringify((route?.assignments || []).map(item => [String(item.orderId), item.departureAt, item.arrival, item.plannedStart, item.plannedFinish, item.distanceM]));
  const shiftIdleMinutes = (engineer, route) => {
    const start = minutesFromTime(engineer?.shiftStart || route?.shiftStart || '08:00');
    const end = minutesFromTime(engineer?.shiftEnd || route?.shiftEnd || '18:00');
    const used = (route?.assignments || []).reduce((sum, item) => sum + Math.max(0, minutesFromTime(item.plannedFinish) - minutesFromTime(item.plannedStart)) + (Number(item.travelMinutes) || 0), 0);
    return Math.max(0, end - start - used);
  };
  const resetTimelineDraft = () => { setTimelineProposal(null); setTimelineBusy(false); setTimelineError(''); setClientRequest(null); setActionNote(''); };
  const closeTimeline = () => { setTimelineSelection(null); resetTimelineDraft(); };
  const openTimelineGap = (team, gap) => { resetTimelineDraft(); setTimelineSelection({ type: 'gap', team, gap }); };
  const requestTimelinePreview = async ({ clientApproved = false } = {}) => {
    if (!timelineSelection || timelineSelection.type !== 'gap' || !record?.plan) return;
    if (!isLive) { setTimelineError('Изменения можно рассчитать и опубликовать только для текущей планируемой смены.'); return; }
    const { gap, team } = timelineSelection;
    if (gap.proposal?.kind === 'insert') { onOpenUnassigned?.(); return; }
    const sourceEngineer = (record.team || []).find(engineer => String(engineer.id) === String(team.engineerId));
    const beforeRoute = routeByEngineer.get(String(team.engineerId)) || null;
    let model;
    let savingMinutes = 0;
    if (gap.proposal?.kind === 'call_customer') {
      if (!clientApproved) return;
      const orderId = gap.nextOrderId;
      const proposedStart = timeLabel(gap.customerCall?.proposedStart ?? gap.nextStart);
      model = {
        orders: (record.orders || []).map(order => String(order.id) === String(orderId) ? { ...order, start: proposedStart, clientShiftStatus: 'approved', clientShiftRequestedAt: clientRequest?.requestedAt } : order),
        team: record.team || [],
        event: { type: 'CLIENT_WINDOW_SHIFT', orderId, time: '00:00', previousStart: timeLabel(gap.nextStart), start: proposedStart },
      };
      savingMinutes = 0;
    } else {
      const shiftStart = minutesFromTime(sourceEngineer?.shiftStart || beforeRoute?.shiftStart || '08:00');
      const shiftEnd = minutesFromTime(sourceEngineer?.shiftEnd || beforeRoute?.shiftEnd || '18:00');
      const nextStart = selectedRecommendation?.recommendedStart ?? (gap.proposal?.kind === 'late_start' ? Math.min(shiftEnd - 1, Math.max(shiftStart, gap.end - 15)) : shiftStart);
      const nextEnd = selectedRecommendation?.recommendedEnd ?? (gap.proposal?.kind === 'early_finish' ? Math.max(nextStart + 1, Math.min(shiftEnd, gap.start + 15)) : shiftEnd);
      model = {
        orders: record.orders || [],
        team: (record.team || []).map(engineer => String(engineer.id) === String(team.engineerId) ? { ...engineer, shiftStart: timeLabel(nextStart), shiftEnd: timeLabel(nextEnd) } : engineer),
        event: { type: 'SHIFT_BOUNDARY_CHANGED', engineerId: team.engineerId, time: '00:00', previousShiftStart: timeLabel(shiftStart), previousShiftEnd: timeLabel(shiftEnd), shiftStart: timeLabel(nextStart), shiftEnd: timeLabel(nextEnd) },
      };
      savingMinutes = Math.max(0, nextStart - shiftStart) + Math.max(0, shiftEnd - nextEnd);
    }
    setTimelineBusy(true);setTimelineError('');setActionNote('');
    try {
      const nextPlan = await onPreviewReplan?.(model, record.plan);
      if (!nextPlan || nextPlan.publicationAllowed === false || nextPlan.validation?.status !== 'VALID') throw new Error('Планировщик не подтвердил черновой расчёт.');
      const afterRoute = (nextPlan.routes || []).find(route => String(route.engineerId) === String(team.engineerId)) || null;
      const afterEngineer = model.team.find(engineer => String(engineer.id) === String(team.engineerId));
      const beforeAssigned = Number(record.plan?.metrics?.assigned || 0);
      const afterAssigned = Number(nextPlan.metrics?.assigned || 0);
      const beforeIdleMinutes = shiftIdleMinutes(sourceEngineer, beforeRoute);
      const afterIdleMinutes = shiftIdleMinutes(afterEngineer, afterRoute);
      const routeChanged = routeSignature(beforeRoute) !== routeSignature(afterRoute);
      const shiftChanged = sourceEngineer?.shiftStart !== afterEngineer?.shiftStart || sourceEngineer?.shiftEnd !== afterEngineer?.shiftEnd;
      const orderChanged = gap.proposal?.kind === 'call_customer' && model.orders.some((order, index) => order.start !== record.orders[index]?.start);
      const hasChange = routeChanged || shiftChanged || orderChanged;
      const safeToPublish = hasChange && afterAssigned >= beforeAssigned;
      setTimelineProposal({ model, plan: nextPlan, beforeRoute, afterRoute, beforeEngineer: sourceEngineer, afterEngineer, savingMinutes: Math.max(0, beforeIdleMinutes - afterIdleMinutes), beforeIdleMinutes, afterIdleMinutes, beforeAssigned, afterAssigned, routeChanged, shiftChanged, hasChange, safeToPublish, kind: gap.proposal?.kind });
      setActionNote(routeChanged ? 'Черновик маршрута рассчитан. Опубликованный план ещё не изменён.' : shiftChanged ? 'Проверены новые границы смены. Заявки и путь остались прежними; опубликованный план ещё не изменён.' : 'Предложение проверено. Опубликованный план ещё не изменён.');
    } catch (error) { setTimelineError(error?.message || 'Не удалось рассчитать предложение.'); }
    finally { setTimelineBusy(false); }
  };
  const recordClientRequest = () => {
    if (!timelineSelection?.gap) return;
    const requestedAt = new Date().toISOString();
    setClientRequest({ status: 'pending', requestedAt });
    setActionNote(`Запрос клиенту зафиксирован: предложено начало в ${timeLabel(timelineSelection.gap.customerCall?.proposedStart || timelineSelection.gap.nextStart)}. Маршрут не пересчитывался.`);
  };
  const declineClientRequest = () => { setClientRequest({ status: 'declined', requestedAt: clientRequest?.requestedAt, decidedAt: new Date().toISOString() }); setActionNote('Клиент отказался. Опубликованный маршрут и согласованное время сохранены без изменений.'); };
  const publishTimelineProposal = () => {
    if (!timelineProposal?.safeToPublish) return;
    onApplyReplan?.({ ...timelineProposal.model, plan: timelineProposal.plan });
    closeTimeline();
  };
  const emergencyReserveAfterRelease = action?.type === 'release'
    ? teams.filter(team => team.zone === action.team.zone && !team.hasRoute && !team.released && String(team.engineerId) !== String(action.team.engineerId) && team.skills.some(skill => /авар|emergency/i.test(skill))).length
    : 0;
  return <div className="resources-workspace">
    <div className="analytics-kpis analytics-kpis-three">
      <MetricCard icon={Gauge} label="Средняя загрузка (%)" value={`${averageLoad}%`} note="Работа и дорога от общей длительности смен"/>
      <MetricCard icon={Clock3} label="Неиспользованный ресурс / простой" value={`${duration(totals.reserve)}`} note="чел.-ч простоя за смену по бригадам выбранного региона" tone={totals.reserve ? 'attention' : 'good'} onClick={totals.reserve ? () => { setFilter('attention'); setShowAll(true); } : undefined} actionLabel="Открыть"/>
      <MetricCard icon={HardHat} label="Без маршрута" value={`${totals.idle} из ${teams.length}`} note={totals.idle ? 'Для каждой бригады показана причина и действие' : 'Все бригады задействованы'} onClick={totals.idle ? () => { setFilter('idle'); setShowAll(true); } : undefined} actionLabel="Показать"/>
    </div>
    {shiftRecommendations.length ? <aside className={`resource-optimization-banner ${allShiftRecommendationsApplied ? 'applied' : ''}`}>
      <p><span aria-hidden="true">⚡</span><span><b>Рекомендации по графику:</b> найдено {shiftRecommendations.length} {plural(shiftRecommendations.length, ['смена', 'смены', 'смен'])} с избыточным временем (потенциал −{(totalShiftSaving / 60).toFixed(1)} ч). Подготовка предложений не меняет опубликованный план.</span></p>
      <div className="resource-optimization-banner-actions"><button type="button" className="settings" onClick={() => setShiftDrawerOpen(true)}>Настроить смены <span aria-hidden="true">⚙️</span></button><button type="button" className={allShiftRecommendationsApplied ? 'reset' : 'primary'} onClick={() => allShiftRecommendationsApplied ? revertShiftRecommendations(shiftRecommendations) : applyShiftRecommendations(pendingShiftRecommendations)}>{allShiftRecommendationsApplied ? 'Сбросить предложения' : `Подготовить предложения (${shiftRecommendations.length})`}</button></div>
    </aside> : null}
    <section className="analytics-panel resource-roster-panel">
      <SectionHeading eyebrow="ПО БРИГАДАМ" title="Загрузка, таймлайн и действия" description="Статус загрузки и план дня собраны в одной строке. Сравнение с очередью выполняется только внутри выбранного региона."/>
      {focusNeed ? <div className="resource-focus-note"><div><b>Проверка ресурса: {focusNeed.zone}</b><span>Нужен навык «{SKILL_LABELS[focusNeed.skill] || focusNeed.skill}». Ниже показаны бригады с этим навыком; назначение требует проверки окна и дороги.</span></div><button type="button" onClick={() => onOpenUnassigned?.(focusNeed.orderId)}>Открыть заявку <ChevronRight/></button></div> : null}
      <div className="resource-controls">
        <div className="resource-view-switch" role="group" aria-label="Вид списка"><button type="button" className={viewMode === 'summary' ? 'active' : ''} onClick={() => onViewModeChange?.('summary')}>Сводка</button><button type="button" className={viewMode === 'timeline' ? 'active' : ''} onClick={() => onViewModeChange?.('timeline')}>Таймлайн (Гант)</button></div>
        <label className="resource-search"><Search/><input type="search" value={searchQuery} onChange={event => { setSearchQuery(event.target.value); setShowAll(false); }} placeholder="Поиск инженера..." aria-label="Поиск инженера"/></label>
        <BusinessSelect className="resource-constraint-filter" ariaLabel="Фильтр по зоне" value={zoneFilter} onChange={value => { setZoneFilter(value); setShowAll(false); }} options={[{ value: 'all', label: 'Все зоны' }, ...[...new Set(teams.map(team => team.zone).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')).map(zone => ({ value: zone, label: zone }))]}/>
        <BusinessSelect className="resource-constraint-filter" ariaLabel="Фильтр по навыку" value={skillFilter} onChange={value => { setSkillFilter(value); setShowAll(false); }} options={[{ value: 'all', label: 'Все навыки' }, { value: 'локальные работы', label: 'Локальные работы' }, { value: 'подключение', label: 'Подключение' }, { value: 'аварийные работы', label: 'Аварийные работы' }]}/>
        <BusinessSelect className="resource-constraint-filter transport" ariaLabel="Фильтр по транспорту" value={transportFilter} onChange={value => { setTransportFilter(value); setShowAll(false); }} options={[{ value: 'all', label: 'Все типы транспорта' }, { value: 'CAR', label: 'Автомобиль' }, { value: 'WALKING', label: 'Пешеход' }, { value: 'BICYCLE', label: 'Велосипед' }, { value: 'TRANSIT', label: 'Общ. транспорт' }]}/>
        <div className="resource-filter"><button type="button" className={filter === 'attention' ? 'active' : ''} onClick={() => { setFilter('attention'); setShowAll(false); }}>Требуют внимания</button><button type="button" className={filter === 'idle' ? 'active' : ''} onClick={() => { setFilter('idle'); setShowAll(false); }}>Без маршрута</button><button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => { setFilter('all'); setShowAll(false); }}>Все</button></div>
        <div className="resource-sort"><BusinessSelect ariaLabel="Сортировка бригад" value={sort} onChange={value => { setSort(value); setShowAll(false); }} options={[{ value: 'load-asc', label: 'Загрузка: сначала низкая' }, { value: 'load-desc', label: 'Загрузка: сначала высокая' }, { value: 'orders-desc', label: 'Заявки: сначала больше' }, { value: 'distance-desc', label: 'Пробег: сначала больше' }, { value: 'name', label: 'Название бригады' }]}/></div>
      </div>
      {viewMode === 'timeline' ? <div className="resource-timeline-legend"><span><i className="job"/>заказ</span><span><i className="call"/>ранний визит</span><span><i className="reserve"/>свободное окно</span><b>Общая шкала: {timelineAxis ? `${timeLabel(timelineAxis.start)}–${timeLabel(timelineAxis.end)}` : 'нет маршрутов'}</b></div> : null}
      {viewMode === 'timeline' && recentTeam ? <div className="resource-recent-change" role="status"><span><Check/><b>{crewName(recentTeam.engineerName)}: опубликованное изменение</b><small>{recentlyChangedCrew.before?.assignments?.length || 0} → {recentTeam.assignments} визитов · смена {timelineByEngineer.get(recentlyChangedCrew.id) ? `${timeLabel(timelineByEngineer.get(recentlyChangedCrew.id).shiftStart)}–${timeLabel(timelineByEngineer.get(recentlyChangedCrew.id).shiftEnd)}` : '—'}. Бригада закреплена первой, даже если фильтр или сортировка скрыли бы её.</small></span><button type="button" onClick={() => setRecentlyChangedCrew(null)}>Вернуться к фильтрам <X/></button></div> : null}
      <div className={`resource-table resource-roster-table ${viewMode === 'timeline' ? 'timeline-view' : 'summary-view'}`} role="table" aria-label="Загрузка бригад">
        <div className="resource-table-head" role="row"><span>Инженер</span><span>{viewMode === 'timeline' ? 'Таймлайн смены' : 'Загрузка и статус'}</span><span>Действие</span></div>
        {visibleTeams.map(team => {
          const [TransportIcon, transportLabel] = transport[team.transport] || transport.UNKNOWN;
          const hasRegionalUnassigned = unresolvedOrders.some(order => orderZone(order) === team.zone);
          const timeline = timelineByEngineer.get(String(team.engineerId));
           return <div className={`resource-table-row ${team.hasRoute ? '' : 'idle'} ${team.released ? 'is-released' : ''} ${recentlyChangedCrew?.id === String(team.engineerId) && viewMode === 'timeline' ? 'recently-changed' : ''}`} role="row" key={team.engineerId}>
           <span className="resource-crew"><i>{crewInitials(team.engineerName)}</i><span><b>{crewName(team.engineerName)}</b><small>{team.zone} · <TransportIcon/> {transportLabel}</small>{team.released ? <strong className="resource-released-label">Снят со смены</strong> : <em>{team.skills.map(skill => <span key={skill}>{skill}</span>)}</em>}</span></span>
          {viewMode === 'summary' ? <span className="resource-summary-cell"><span className="resource-load"><div className="resource-load-bar" aria-label={`Загрузка ${team.utilization}%: работа ${duration(team.workMinutes)}, дорога ${duration(team.travelMinutes)}, простой за смену ${duration(team.idleMinutes)}`} title={`Работа: ${duration(team.workMinutes)} | Дорога: ${duration(team.travelMinutes)} | Простой за смену: ${duration(team.idleMinutes)}`}><i className="work" style={{ width: `${percent(team.workMinutes, team.capacityMinutes)}%` }}/><i className="travel" style={{ width: `${percent(team.travelMinutes, team.capacityMinutes)}%` }}/><i className="idle" style={{ width: `${percent(team.idleMinutes, team.capacityMinutes)}%` }}/></div><b>{team.utilization}%</b><small className="resource-load-legend"><span><i className="work"/>Работа <strong>{duration(team.workMinutes)}</strong></span><span><i className="travel"/>Дорога <strong>{duration(team.travelMinutes)}</strong></span><span><i className="idle"/>Простой <strong>{duration(team.idleMinutes)}</strong></span></small></span><span className="resource-summary-status"><small>{team.hasRoute ? `${team.assignments} ${plural(team.assignments, ['заявка', 'заявки', 'заявок'])} · ${number(team.distanceKm)} км` : 'Без маршрута'}</small><p>{renderKnown(team.known)}</p></span></span> : <span className="resource-team-timeline">{timeline ? <RouteGapTimeline route={timeline} axis={timelineAxis} selectedKey={timelineSelection?.gap?.key || ''} selectedOrderKey={timelineSelection?.assignment?.key || ''} onSelectGap={gap => openTimelineGap(team, gap)} onSelectOrder={(route, assignment, index) => { resetTimelineDraft(); setTimelineSelection({ type: 'order', team, route, assignment, index }); }}/> : <span className="resource-timeline-empty"><Clock3/><b>Свободная смена</b><small>{team.known}</small></span>}</span>}
           <span className="resource-action">{team.released ? <button type="button" className="restore" onClick={() => { setRestoreAction({ team }); setRestorePreview(null); setRestoreError(''); }}><UserRoundPlus/>Вернуть на смену</button> : team.hasRoute ? <button type="button" className="map" onClick={() => onOpenRoute?.(team.engineerId)}><MapPin/>На карте</button> : hasRegionalUnassigned ? <button type="button" className="assign" onClick={() => { const first = unresolvedOrders.find(order => orderZone(order) === team.zone); setManualAction({ team }); setSelectedOrderId(String(first?.id || '')); setManualPreview(null); setManualError(''); }}><UserRoundPlus/>Назначить заявку</button> : <button type="button" className="release" onClick={() => setAction({ type: 'release', team })}><UserX/>Отпустить со смены</button>}</span>
        </div>; })}
        {!visibleTeams.length ? <div className="resource-table-empty">По выбранным фильтрам бригады не найдены.</div> : null}
      </div>
      {filteredTeams.length > 12 ? <button type="button" className="analytics-show-more" onClick={() => setShowAll(value => !value)}>{showAll ? 'Свернуть список' : `Показать все ${filteredTeams.length}`}<ChevronDown className={showAll ? 'open' : ''}/></button> : null}
    </section>
    {shiftDrawerOpen ? <ResourceModalPortal><ShiftOptimizationDrawer recommendations={shiftRecommendations} appliedIds={appliedShiftIds} appliedValues={appliedShiftValues} onApply={item => applyShiftRecommendations([item])} onApplyAll={applyShiftRecommendations} onRevert={item => revertShiftRecommendations([item])} onSend={sendShiftRecommendation} isLive={isLive} onClose={() => setShiftDrawerOpen(false)}/></ResourceModalPortal> : null}
    {manualAction ? <ResourceModalPortal><div className="resource-action-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && setManualAction(null)}><section className="resource-action-dialog resource-restore-dialog" role="dialog" aria-modal="true" aria-label="Назначить заявку бригаде"><button type="button" className="resource-dialog-close" onClick={() => setManualAction(null)} aria-label="Закрыть"><X/></button><small>ПРОВЕРЯЕМОЕ НАЗНАЧЕНИЕ</small><h2>Заявка для {crewName(manualAction.team.engineerName)}</h2><label>Неназначенная заявка<BusinessSelect className="resource-order-select" ariaLabel="Выбрать неназначенную заявку" value={selectedOrderId} onChange={value => { setSelectedOrderId(value); setManualPreview(null); setManualError(''); }} options={unresolvedOrders.filter(order => orderZone(order) === manualAction.team.zone).map(order => ({ value: String(order.id), label: `Заявка №${String(order.sourceId || order.id).replace(/^.*:/, '')}`, hint: `${SKILL_LABELS[sourceSkill(order)] || sourceSkill(order)} · окно ${order.start}–${order.end}` }))}/></label><p className={manualWarning.startsWith('Нельзя') ? 'danger' : ''}>{manualWarning}</p>{manualPreview ? <div className="resource-release-preview"><b>Заявка помещается в маршрут</b><span>Заявок в плане: {record.plan.metrics?.assigned ?? '—'} → {manualPreview.plan.metrics?.assigned ?? '—'}</span><span>Визит назначен выбранной бригаде; дорога для новой вставки оценена приближённо.</span></div> : null}{manualError ? <p className="resource-release-error" role="alert">{manualError}</p> : null}<footer><button type="button" onClick={() => setManualAction(null)}>Отмена</button>{manualPreview ? <button type="button" className="primary" onClick={() => { onApplyReplan?.({ ...manualPreview.model, plan: manualPreview.plan }); setManualAction(null); setManualPreview(null); }}>Передать на точную проверку</button> : <button type="button" className="primary" disabled={!selectedOrder || manualWarning.startsWith('Нельзя') || manualBusy || !isLive} onClick={previewManualAssignment}>{manualBusy ? 'Проверяем маршрут…' : 'Проверить маршрут'}</button>}</footer>{!isLive ? <small>Изменять можно только текущий опубликованный день.</small> : null}</section></div></ResourceModalPortal> : null}
    {restoreAction ? <ResourceModalPortal><div className="resource-action-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && setRestoreAction(null)}><section className="resource-action-dialog resource-restore-dialog" role="dialog" aria-modal="true" aria-label="Вернуть бригаду на смену"><button type="button" className="resource-dialog-close" onClick={() => setRestoreAction(null)} aria-label="Закрыть"><X/></button><small>ВОЗВРАТ НА СМЕНУ</small><h2>Вернуть {crewName(restoreAction.team.engineerName)}?</h2><p>Сначала проверим, какие заявки можно включить в маршрут при прежних границах смены. Карта, статус и аналитика изменятся только после публикации.</p>{restorePreview ? <div className="resource-release-preview"><b>Проверенный расчёт</b><span>Заявок в плане: {record.plan.metrics?.assigned ?? '—'} → {restorePreview.plan.metrics?.assigned ?? '—'}</span><span>Без назначения: {record.plan.metrics?.unassigned ?? '—'} → {restorePreview.plan.metrics?.unassigned ?? '—'}</span><span>Маршрут бригады: {(restorePreview.plan.routes || []).find(route => String(route.engineerId) === String(restoreAction.team.engineerId))?.assignments?.length || 0} остановок</span></div> : null}{restoreError ? <p className="resource-release-error" role="alert">{restoreError}</p> : null}<footer><button type="button" onClick={() => setRestoreAction(null)}>Оставить снятой</button>{restorePreview ? <button type="button" className="primary" onClick={() => { onApplyReplan?.({ ...restorePreview.model, plan: restorePreview.plan }); setRestoreAction(null); setRestorePreview(null); }}>Передать на точную проверку</button> : <button type="button" className="primary" disabled={restoreBusy || !isLive} onClick={previewRestore}>{restoreBusy ? 'Проверяем маршрут…' : 'Рассчитать возвращение'}</button>}</footer>{!isLive ? <small>Изменять можно только текущий опубликованный день.</small> : null}</section></div></ResourceModalPortal> : null}
    {timelineSelection ? <ResourceModalPortal>
      <div className="resource-action-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && closeTimeline()}>
        <section className="resource-action-dialog resource-timeline-dialog" role="dialog" aria-modal="true" aria-label="Подробности таймлайна">
          <button type="button" className="resource-dialog-close" onClick={closeTimeline} aria-label="Закрыть"><X/></button>
          {timelineSelection.type === 'order' ? <>
            <small>ЗАКАЗ {timelineSelection.index + 1} В МАРШРУТЕ</small>
            <h2>{timelineSelection.assignment.orderName}</h2>
            <p>{crewName(timelineSelection.team.engineerName)} · визит {timeLabel(timelineSelection.assignment.start)}–{timeLabel(timelineSelection.assignment.end)}</p>
            <div className="resource-timeline-metrics"><span><small>Начало</small><b>{timeLabel(timelineSelection.assignment.start)}</b></span><span><small>Завершение</small><b>{timeLabel(timelineSelection.assignment.end)}</b></span><span><small>Длительность</small><b>{duration(timelineSelection.assignment.end - timelineSelection.assignment.start)}</b></span></div>
            <footer><button type="button" onClick={closeTimeline}>Закрыть</button><button type="button" className="primary" onClick={() => onOpenOrder?.(timelineSelection.assignment.orderId)}>Показать точку на карте</button></footer>
          </> : <>
            <small>{timelineSelection.gap.customerCall ? 'СОГЛАСОВАНИЕ С КЛИЕНТОМ' : 'СВОБОДНОЕ ОКНО · ПРЕДЛОЖЕНИЕ'}</small>
            <h2>{timelineSelection.gap.customerCall ? `Можно начать раньше: ${timelineSelection.gap.nextOrderName}` : `Окно ${timelineSelection.gap.minutes} мин`}</h2>
            <p>{timelineSelection.gap.proposal?.impact || `${crewName(timelineSelection.team.engineerName)} свободна с ${timeLabel(timelineSelection.gap.start)} до ${timeLabel(timelineSelection.gap.end)}.`}</p>
            <div className="resource-timeline-metrics"><span><small>{timelineSelection.gap.customerCall ? 'Последний визит завершён' : 'Начало окна'}</small><b>{timeLabel(timelineSelection.gap.start)}</b></span><span><small>{timelineSelection.gap.customerCall ? 'Выезд по плану' : 'Конец окна'}</small><b>{timeLabel(timelineSelection.gap.end)}</b></span><span><small>{timelineSelection.gap.customerCall ? 'Ожидание до выезда' : 'Простой сейчас'}</small><b>{timelineSelection.gap.minutes} мин</b></span></div>
            {clientRequest ? <div className={`resource-client-request ${clientRequest.status}`}><b>{clientRequest.status === 'pending' ? 'Запрос клиенту зафиксирован' : 'Клиент отказался от сдвига'}</b><span>{clientRequest.status === 'pending' ? `Предложено: выезд в ${timeLabel(timelineSelection.gap.customerCall?.proposedDeparture)}, дорога ${timelineSelection.gap.customerCall?.travelMinutes || 0} мин, начало визита в ${timeLabel(timelineSelection.gap.customerCall?.proposedStart || timelineSelection.gap.nextStart)}. До ответа клиента опубликованный маршрут не меняется.` : 'Исходное клиентское окно и маршрут сохранены.'}</span></div> : null}
            {timelineProposal ? <div className="resource-timeline-proposal">
              <header><div><small>ЧЕРНОВИК · НЕ ОПУБЛИКОВАНО</small><b>{timelineProposal.routeChanged ? 'Маршрут перестроен' : timelineProposal.shiftChanged ? 'Меняются только границы смены' : 'Изменение клиентского окна'}</b><span>{timelineProposal.routeChanged ? 'Изменились остановки или время движения. Сравните маршрут перед публикацией.' : timelineProposal.shiftChanged ? 'Состав и порядок заявок не изменились. Сокращается оплачиваемый простой за счёт времени смены.' : 'Согласованное окно учтено в проверке. Маршрут может остаться прежним.'}</span></div><em>Предложение</em></header>
              <div className="resource-timeline-compare-grid">
                <span><small>Границы смены</small><b>{timelineProposal.beforeEngineer?.shiftStart || timelineProposal.beforeRoute?.shiftStart || '—'}–{timelineProposal.beforeEngineer?.shiftEnd || timelineProposal.beforeRoute?.shiftEnd || '—'}</b><ArrowRight/><strong>{timelineProposal.afterEngineer?.shiftStart || timelineProposal.afterRoute?.shiftStart || '—'}–{timelineProposal.afterEngineer?.shiftEnd || timelineProposal.afterRoute?.shiftEnd || '—'}</strong></span>
                <span><small>Простой смены</small><b>{timelineProposal.beforeIdleMinutes} мин</b><ArrowRight/><strong>{timelineProposal.afterIdleMinutes} мин</strong></span>
                <span><small>Сокращение простоя</small><b>—</b><ArrowRight/><strong>{timelineProposal.savingMinutes ? `−${timelineProposal.savingMinutes} мин` : 'Нет'}</strong></span>
                <span><small>Заявки в плане</small><b>{timelineProposal.beforeAssigned}</b><ArrowRight/><strong>{timelineProposal.afterAssigned}</strong></span>
              </div>
              <div className="resource-route-before-after"><div><small>Маршрут сейчас</small>{(timelineProposal.beforeRoute?.assignments || []).map((item, index) => <span key={`before:${item.orderId}:${index}`}><b>{item.plannedStart || item.arrival || '—'}</b>{orderById.get(String(item.orderId))?.name || `Заявка ${index + 1}`}</span>)}</div><ArrowRight/><div><small>После проверки</small>{(timelineProposal.afterRoute?.assignments || []).map((item, index) => <span key={`after:${item.orderId}:${index}`}><b>{item.plannedStart || item.arrival || '—'}</b>{orderById.get(String(item.orderId))?.name || `Заявка ${index + 1}`}</span>)}</div></div>
              {!timelineProposal.safeToPublish ? <p className="resource-proposal-blocked" role="alert">{!timelineProposal.hasChange ? 'Публикация не нужна: проверка не обнаружила изменений.' : 'Публикация заблокирована: после изменения в плане станет меньше назначенных заявок.'}</p> : null}
            </div> : null}
            {timelineError ? <p className="resource-release-error" role="alert">{timelineError}</p> : null}
            {actionNote ? <div className="resource-action-note"><Check/>{actionNote}</div> : null}
            <footer className="resource-timeline-actions">
              <button type="button" onClick={() => onOpenRoute?.(timelineSelection.team.engineerId)}>Открыть маршрут</button>
              {timelineProposal ? <button type="button" className="primary" disabled={!isLive || !timelineProposal.safeToPublish} onClick={publishTimelineProposal}>Передать на точную проверку</button> : timelineSelection.gap.proposal?.kind === 'call_customer' ? (!clientRequest ? <button type="button" className="primary" disabled={!isLive} onClick={recordClientRequest}>Зафиксировать запрос клиенту</button> : clientRequest.status === 'pending' ? <><button type="button" className="decline" onClick={declineClientRequest}>Клиент отказался</button><button type="button" className="primary" disabled={timelineBusy || !isLive} onClick={() => requestTimelinePreview({ clientApproved: true })}>{timelineBusy ? 'Пересчитываем…' : 'Клиент согласился · пересчитать'}</button></> : null) : <button type="button" className="primary" disabled={timelineBusy || !isLive} onClick={() => requestTimelinePreview()}>{timelineBusy ? 'Пересчитываем…' : timelineSelection.gap.proposal?.kind === 'insert' ? 'Открыть заявку' : 'Рассчитать предложение'}</button>}
            </footer>
            {!isLive ? <small>Это архивная смена: действия доступны только для просмотра.</small> : null}
          </>}
        </section>
      </div>
    </ResourceModalPortal> : null}
    {action ? <ResourceModalPortal><div className="resource-action-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && closeAction()}><section className="resource-action-dialog" role="dialog" aria-modal="true" aria-label="Действие с бригадой"><button type="button" className="resource-dialog-close" onClick={closeAction} aria-label="Закрыть"><X/></button>{action.type === 'shorten' ? <><small>СОКРАЩЕНИЕ СМЕНЫ</small><h2>Завершить смену в {timeLabel(action.team.suggestedFinish)}?</h2><p>Последний визит завершится в {timeLabel(action.team.lastFinishMinute)}. После 15 минут на завершение работ экономия составит {duration(Math.max(0, minutesFromTime(routeByEngineer.get(String(action.team.engineerId))?.shiftEnd || '') - action.team.suggestedFinish))}.</p><footer><button type="button" onClick={closeAction}>Отмена</button><button type="button" className="primary" onClick={() => setActionNote(`Черновик: смена ${crewName(action.team.engineerName)} может завершиться в ${timeLabel(action.team.suggestedFinish)}. Для публикации подтвердите изменение в планировщике.`)}>Подготовить черновик</button></footer></> : action.type === 'manual' ? <><small>РУЧНОЕ НАЗНАЧЕНИЕ</small><h2>Выберите заявку для {crewName(action.team.engineerName)}</h2><label>Неназначенная заявка<BusinessSelect className="resource-order-select" ariaLabel="Выбрать неназначенную заявку" value={selectedOrderId} onChange={setSelectedOrderId} options={unresolvedOrders.filter(order => orderZone(order) === action.team.zone).map(order => ({ value: String(order.id), label: `Заявка №${String(order.sourceId || order.id).replace(/^.*:/, '')}`, hint: `${SKILL_LABELS[sourceSkill(order)] || sourceSkill(order)} · окно ${order.start}–${order.end}` }))}/></label><p className={manualWarning.startsWith('Нельзя') ? 'danger' : ''}>{manualWarning}</p><footer><button type="button" onClick={closeAction}>Отмена</button><button type="button" className="primary" disabled={manualWarning.startsWith('Нельзя')} onClick={() => { setActionNote(`Заявка добавлена в черновик для ${crewName(action.team.engineerName)}. Запустите повторный проверяемый расчёт перед публикацией.`); onOpenUnassigned?.(); }}>Проверить в планировщике</button></footer></> : <><small>ДЕЖУРНЫЙ РЕЗЕРВ</small><h2>Отпустить {crewName(action.team.engineerName)} со смены?</h2><p className="resource-release-warning">Бригада останется недоступной для срочных аварий. В резерве зоны «{action.team.zone}» останется {emergencyReserveAfterRelease} {plural(emergencyReserveAfterRelease, ['бригада', 'бригады', 'бригад'])}. Отпустить?</p><div className={`resource-release-stage ${releasePreview ? 'ready' : 'draft'}`}><b>{releasePreview ? 'Пересчёт завершён' : 'Черновик изменения'}</b><span>{releasePreview ? 'Изменение ещё не опубликовано. Сначала сравните результат, затем подтвердите снятие.' : 'Статус бригады, карта и аналитика не изменятся до проверки и финального подтверждения.'}</span></div>{releasePreview ? <div className="resource-release-preview"><b>Сейчас → после изменения</b><span>{record.plan.metrics?.assigned ?? '—'} → {releasePreview.plan.metrics?.assigned ?? '—'} заявок в плане</span><span>Без назначения после изменения: {releasePreview.plan.metrics?.unassigned ?? '—'}</span></div> : null}{releaseError ? <p className="resource-release-error" role="alert">{releaseError}</p> : null}<label className="resource-release-ack"><input type="checkbox" checked={releaseAcknowledged} onChange={event => setReleaseAcknowledged(event.target.checked)}/>Понимаю, что аварийный резерв зоны сократится</label><footer><button type="button" onClick={closeAction}>Оставить в резерве</button>{releasePreview ? <button type="button" className="primary" disabled={!releaseAcknowledged} onClick={() => { onApplyReplan?.({ ...releasePreview.model, plan: releasePreview.plan }); closeAction(); }}>Передать на точную проверку</button> : <button type="button" className="primary" disabled={!releaseAcknowledged || releaseBusy || !isLive} onClick={previewRelease}>{releaseBusy ? 'Пересчитываем…' : 'Создать черновик и пересчитать'}</button>}</footer>{!isLive ? <small>Изменять можно только текущий опубликованный день.</small> : null}</>}{actionNote ? <div className="resource-action-note"><Check/>{actionNote}</div> : null}</section></div></ResourceModalPortal> : null}
  </div>;
}

function EfficiencyView({ record, rates, onOpenRoutes }) {
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const efficiency = useMemo(() => analyzeShiftEfficiency(record), [record]);
  const economics = useMemo(() => calculateEconomics(record, rates), [record, rates]);
  const money = value => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0)} ₽`;
  const transport = {
    car: { icon: Car, label: 'Автомобили' },
    transit: { icon: Bus, label: 'Общественный транспорт' },
    bicycle: { icon: Bike, label: 'Велосипеды' },
    walking: { icon: Footprints, label: 'Пешеходы' },
  };
  const supportedElevatedRoutes = efficiency.elevatedRoutes.filter(route => route.constrainingOrder && route.constraintReason);
  return <>
    <section className="analytics-panel fleet-efficiency-panel">
      <SectionHeading eyebrow="ЭФФЕКТИВНОСТЬ ФЛОТА" title="Сравнение способов передвижения" description="Стоимость и логистика рассчитаны из маршрутов выбранной даты, времени смен и действующих тарифов"/>
      <div className="fleet-efficiency-grid">{economics.fleetMetrics.map(item => { const Icon = transport[item.key].icon; return <article key={item.key}>
        <header><span><Icon/></span><div><b>{transport[item.key].label}</b><small>{item.routes} {plural(item.routes, ['бригада', 'бригады', 'бригад'])} на линии</small></div></header>
        <dl><div><dt>Пробег на визит</dt><dd>{number(item.averageDistancePerVisit)} км</dd></div><div><dt>Время между адресами</dt><dd>{number(item.averageTravelMinutes)} мин</dd></div><div className="fleet-cost"><dt>Себестоимость визита</dt><dd>{money(item.costPerVisit)}</dd></div></dl>
      </article>; })}</div>
    </section>
    <section className="analytics-panel elevated-routes-panel">
      <SectionHeading eyebrow="ОБЪЯСНИМОСТЬ ПЛАНА" title="Почему некоторые маршруты длиннее" description="Откройте маршрут, чтобы увидеть ограничивающую заявку, клиентское окно и условие, из-за которого появился дополнительный пробег."/>
      {supportedElevatedRoutes.length ? <div className="elevated-route-list">{supportedElevatedRoutes.map(route => <Fragment key={route.engineerId}><button type="button" aria-expanded={selectedRouteId === String(route.engineerId)} onClick={() => setSelectedRouteId(current => current === String(route.engineerId) ? '' : String(route.engineerId))}>
        <div className="elevated-route-heading"><span><b>{route.engineerName}</b><small>{route.zone} · {route.visits} {plural(route.visits, ['визит', 'визита', 'визитов'])}</small></span><strong>{number(route.distanceKm)} км</strong><em><ShieldCheck/>Ограничения проверены</em><ChevronRight/></div>
        <p><b>Ограничивающая заявка №{route.constrainingOrder.number}</b>{' '}<span>Окно клиента: {route.constrainingOrder.window}. {route.constraintReason}</span></p>
      </button>{selectedRouteId === String(route.engineerId) ? <div className="elevated-route-detail"><header><div><small>РАЗБОР МАРШРУТА</small><b>Почему маршрут длиннее</b></div><strong>{number(route.distanceKm)} км</strong></header><div className="elevated-route-facts"><span><small>Бригада</small><b>{route.engineerName}</b></span><span><small>Заявка</small><b>№{route.constrainingOrder.number}</b></span><span><small>Окно клиента</small><b>{route.constrainingOrder.window}</b></span><span><small>Визитов</small><b>{route.visits}</b></span></div><p>{route.constraintReason}</p><p>Перестроить маршрут можно только после повторной проверки клиентских окон, навыков и уже назначенных визитов.</p><button type="button" onClick={() => onOpenRoutes?.(route.engineerId)}>Показать маршрут на карте <ChevronRight/></button></div> : null}</Fragment>)}</div> : <div className="analytics-all-clear"><Check/><div><b>Все плечи доезда находятся в типичном диапазоне</b><p>Для выбранного региона нет маршрутов, заметно превышающих пробег сопоставимых бригад.</p></div></div>}
    </section>
  </>;
}

function DaySummaryView({ data, record, targets, onInspect, onOpenRoutes }) {
  const goals = useMemo(() => evaluateGoals(record, targets), [record, targets]);
  const factReady = data.actualAvailable;
  const completedRate = factReady ? percent(data.completed, Math.max(1, data.assigned)) : null;
  const issueCount = data.unassigned + (factReady ? data.actualLate + data.cancelled : 0);
  const status = !factReady
    ? { tone: 'attention', title: 'План готов, ждём факт исполнения', text: `${data.assigned} из ${data.total} заявок вошли в план. После загрузки факта появятся выполнение, отмены и соблюдение времени.` }
    : issueCount
      ? { tone: 'attention', title: `Смена завершена: ${issueCount} ${plural(issueCount, ['сигнал требует', 'сигнала требуют', 'сигналов требуют'])} внимания`, text: `${data.completed} визитов завершено; разберите невыполненные, отменённые и начатые позже окна заявки.` }
      : { tone: 'success', title: 'Смена прошла без критичных отклонений', text: `${data.completed} визитов завершено, все назначенные заявки выполнены в клиентских окнах.` };
  const highlights = [
    { icon: Check, title: 'Вошло в план', value: `${data.assigned} из ${data.total}`, text: data.unassigned ? `${data.unassigned} осталось без назначения` : 'Все заявки распределены', action: data.unassigned ? () => onInspect?.('unassigned', 'day') : null },
    { icon: Target, title: factReady ? 'Выполнено по факту' : 'Факт выполнения', value: factReady ? `${data.completed} из ${data.assigned}` : '—', text: factReady ? `${number(completedRate)}% от назначенных` : 'Результаты визитов ещё не загружены', action: null },
    { icon: Clock3, title: 'Начато вовремя', value: factReady && data.completed ? `${number(percent(data.completed - data.actualLate, data.completed))}%` : '—', text: factReady ? `${data.actualLate} ${plural(data.actualLate, ['визит начат', 'визита начаты', 'визитов начаты'])} позже окна` : 'Появится после загрузки времени визитов', action: factReady && data.actualLate ? () => onInspect?.('late', 'day') : null },
    { icon: ShieldCheck, title: 'Отменено', value: factReady ? data.cancelled : '—', text: factReady ? (data.cancelled ? 'Требуется разбор причин отмен' : 'Отменённых визитов нет') : 'Появится после загрузки факта', action: factReady && data.cancelled ? () => onInspect?.('cancelled', 'day') : null },
  ];
  const improvements = [
    ...(data.unassigned ? [{ icon: UserRoundPlus, title: `${data.unassigned} ${plural(data.unassigned, ['заявка не вошла', 'заявки не вошли', 'заявок не вошли'])} в план`, text: data.causes[0]?.action || 'Откройте очередь и выберите решение по ограничению.', action: 'Разобрать очередь', onClick: () => onInspect?.('unassigned', 'day') }] : []),
    ...(factReady && data.actualLate ? [{ icon: Clock3, title: `${data.actualLate} ${plural(data.actualLate, ['визит начат позже окна', 'визита начаты позже окна', 'визитов начаты позже окна'])}`, text: 'Сравните план и факт, чтобы понять причину задержки.', action: 'Открыть опоздания', onClick: () => onInspect?.('late', 'day') }] : []),
    ...(factReady && data.cancelled ? [{ icon: CircleAlert, title: `${data.cancelled} ${plural(data.cancelled, ['отменённый визит', 'отменённых визита', 'отменённых визитов'])}`, text: data.cancellationReasons[0] ? `Главная причина: ${data.cancellationReasons[0].reason}.` : 'Проверьте причины и связанные маршруты.', action: 'Открыть отмены', onClick: () => onInspect?.('cancelled', 'day') }] : []),
    ...(data.criticalSlack.length ? [{ icon: AlertTriangle, title: `${data.criticalSlack.length} ${plural(data.criticalSlack.length, ['визит с минимальным запасом', 'визита с минимальным запасом', 'визитов с минимальным запасом'])}`, text: 'В следующем расчёте не ставьте эти визиты в самый конец клиентского окна.', action: 'Открыть маршруты', onClick: onOpenRoutes }] : []),
    ...(data.dataIssues ? [{ icon: Activity, title: `${data.dataIssues} ${plural(data.dataIssues, ['поле требует', 'поля требуют', 'полей требуют'])} уточнения`, text: 'Исправьте неполные данные до следующего расчёта.', action: null, onClick: null }] : []),
  ].slice(0, 4);
  return <>
    <section className={`day-summary-hero ${status.tone}`}><span>{status.tone === 'success' ? <Check/> : <AlertTriangle/>}</span><div><small>ИТОГ ВЫБРАННОГО ДНЯ</small><h2>{status.title}</h2><p>{status.text}</p></div></section>
    <div className="analytics-kpis analytics-kpis-four day-summary-kpis">{highlights.map(({ icon, title, value, text, action }) => <MetricCard key={title} icon={icon} label={title} value={value} note={text} tone={action ? 'attention' : ''} onClick={action || undefined} actionLabel="Открыть"/>)}</div>
    <section className="analytics-panel day-summary-goals"><SectionHeading eyebrow="ЦЕЛИ СМЕНЫ" title="Что достигнуто" description="Показатели оцениваются по плану и фактическим визитам"/>
      <div className="day-summary-goal-list">{goals.map(goal => <button type="button" key={goal.key} disabled={goal.value == null} onClick={() => onInspect?.(goal.key === 'onTime' ? 'late' : goal.key === 'cancelRate' ? 'cancelled' : 'unassigned', 'day')}><span><b>{goal.label}</b><small>{goal.target == null ? 'цель не задана' : `цель ${goal.direction === 'min' ? 'не ниже' : 'не выше'} ${number(goal.target)}${goal.unit}`}</small></span><strong>{goal.value == null ? '—' : `${number(goal.value)}${goal.unit}`}</strong><em className={goal.status}>{goal.status === 'met' ? 'выполнено' : goal.status === 'failed' ? 'нужно улучшить' : goal.status === 'unknown' ? 'нет факта' : 'не задано'}</em><ChevronRight/></button>)}</div>
    </section>
    <section className="analytics-panel day-summary-actions"><SectionHeading eyebrow="ЧТО УЛУЧШИТЬ" title={improvements.length ? 'Главные точки внимания' : 'Работать дополнительно не требуется'} description={improvements.length ? 'Только действия, которые могут улучшить следующую смену' : 'План и факт не показали проблем, требующих отдельного решения'}/>
      {improvements.length ? <div className="day-summary-action-list">{improvements.map(({ icon: Icon, title, text, action, onClick }) => <article key={title}><span><Icon/></span><div><b>{title}</b><p>{text}</p></div>{action ? <button type="button" onClick={onClick}>{action}<ChevronRight/></button> : null}</article>)}</div> : <div className="analytics-all-clear"><Check/><div><b>Критичных сигналов нет</b><p>Следите за итогами следующих смен и динамикой в истории.</p></div></div>}
    </section>
    {data.causes.length ? <details className="day-summary-details"><summary><CircleHelp/>Почему заявки не вошли в план<ChevronDown/></summary><div className="cause-list">{data.causes.map(cause => <article key={cause.label}><span><CircleAlert/></span><div><b>{cause.label}</b><p>{cause.action}</p></div><b>{cause.count}</b></article>)}</div></details> : null}
  </>;
}

function DemandOverview({ orders, team, dateControl }) {
  const demand = useMemo(() => {
    const zones = new Map();
    const skills = new Map();
    let urgent = 0;
    let serviceMinutes = 0;
    orders.forEach(order => {
      const zone = orderZone(order);
      const skill = sourceSkill(order);
      zones.set(zone, (zones.get(zone) || 0) + 1);
      skills.set(skill, (skills.get(skill) || 0) + 1);
      urgent += isUrgentOrder(order) ? 1 : 0;
      serviceMinutes += Number(order.duration) || 0;
    });
    return {
      urgent,
      serviceMinutes,
      zones: [...zones].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      skills: [...skills].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    };
  }, [orders]);
  return <div className="analytics-workspace">
    <div className="analytics-toolbar analytics-empty-toolbar">{dateControl}</div>
    <section className="analytics-status-hero success">
      <span className="analytics-status-icon"><BarChart3/></span>
      <div className="analytics-status-copy"><small>ВХОДЯЩАЯ НАГРУЗКА</small><h2>{orders.length} {plural(orders.length, ['заявка готова', 'заявки готовы', 'заявок готовы'])} к распределению</h2><p>Спрос уже можно оценить по зонам, навыкам и нормативному времени. Маршрутные показатели появятся после расчёта плана.</p></div>
      <div className="analytics-status-proof"><span><Check/>Структура данных распознана</span></div>
    </section>
    <div className="analytics-kpis">
      <MetricCard icon={BriefcaseBusiness} label="Всего заявок" value={orders.length} note="В выбранной смене"/>
      <MetricCard icon={AlertTriangle} label="Аварии" value={demand.urgent} note="Требуют первоочередного назначения" tone={demand.urgent ? 'attention' : 'good'}/>
      <MetricCard icon={Clock3} label="Норматив работ" value={hours(demand.serviceMinutes)} note="Без учёта дороги и ожидания"/>
      <MetricCard icon={Users} label="Доступно бригад" value={team.length} note="По загруженному составу команды"/>
    </div>
    <div className="analytics-two-column">
      <section className="analytics-panel"><SectionHeading eyebrow="ГЕОГРАФИЯ СПРОСА" title="Заявки по зонам" description="Помогает заранее увидеть участки с наибольшей нагрузкой"/><div className="zone-health-list">{demand.zones.map(zone => <div key={zone.name}><span className="zone-dot">{zone.name.slice(0, 2).toLocaleUpperCase('ru-RU')}</span><div><b>{zone.name}</b><span><i style={{ width: `${percent(zone.count, orders.length)}%` }}/></span></div><strong>{zone.count}</strong><em>{number(percent(zone.count, orders.length))}% спроса</em></div>)}</div></section>
      <section className="analytics-panel"><SectionHeading eyebrow="КОМПЕТЕНЦИИ" title="Потребность по навыкам" description="Показывает, какие специалисты нужны в смене"/><div className="cause-list">{demand.skills.map(skill => <article key={skill.name}><span><Wrench/></span><div><b>{SKILL_LABELS[skill.name] || skill.name}</b><p>{number(percent(skill.count, orders.length))}% входящей нагрузки</p></div><b>{skill.count}</b></article>)}</div></section>
    </div>
  </div>;
}

function HistoryView({ records, comparisonRecords, mlForecast, forecastStatus = 'loading', selectedDate, planningDate, onSelectDate, onOpenDecision, region = 'all', section = 'overview', onSectionChange }) {
  const setSection = onSectionChange || (() => {});
  const [showMonth, setShowMonth] = useState(false);
  const [deepDiveOpen, setDeepDiveOpen] = useState(false);
  const firstAvailableDate = records[0]?.date || '';
  const lastAvailableDate = records.at(-1)?.date || '';
  const [periodStart, setPeriodStart] = useState(firstAvailableDate);
  const [periodEnd, setPeriodEnd] = useState(lastAvailableDate);
  const previousBounds = useRef({ first: firstAvailableDate, last: lastAvailableDate });
  const model = useMemo(() => buildHistoryModel(records, selectedDate), [records, selectedDate]);
  const { days, selected } = model;
  const periodDays = useMemo(() => days.filter(day => day.date >= periodStart && day.date <= periodEnd), [days, periodStart, periodEnd]);
  const fullHistoryRecords = comparisonRecords?.length ? comparisonRecords : records;
  const comparisonPeriodRecords = useMemo(() => fullHistoryRecords.filter(record => record.date >= periodStart && record.date <= periodEnd), [fullHistoryRecords, periodStart, periodEnd]);
  const periodTotals = useMemo(() => summarizePeriod(periodDays), [periodDays]);
  const periodInsights = useMemo(() => generatePeriodInsights(comparisonPeriodRecords), [comparisonPeriodRecords]);
  const analysisPeriodLabel = periodStart && periodEnd ? rangeLabel(periodStart, periodEnd) : 'период не выбран';
  useEffect(() => {
    if (!['overview', 'forecast'].includes(section)) setSection('overview');
  }, [section, setSection]);
  useEffect(() => {
    if (!firstAvailableDate || !lastAvailableDate) return;
    const before = previousBounds.current;
    setPeriodStart(current => !current || current === before.first || current < firstAvailableDate || current > lastAvailableDate ? firstAvailableDate : current);
    setPeriodEnd(current => !current || current === before.last || current < firstAvailableDate || current > lastAvailableDate ? lastAvailableDate : current);
    previousBounds.current = { first: firstAvailableDate, last: lastAvailableDate };
  }, [firstAvailableDate, lastAvailableDate]);
  if (!selected) return null;
  const openInspector = () => {
    onSelectDate?.(new Date(`${planningDate || HACKATHON_PLANNING_DATE}T12:00:00`));
    onOpenDecision?.();
  };
  const selectDay = day => {
    onSelectDate?.(new Date(`${day.date}T12:00:00`));
  };
  const visibleDays = showMonth ? periodDays : periodDays.slice(-7);
  const selectRecentPeriod = count => {
    const recent = days.slice(-count);
    if (!recent.length) return;
    setPeriodStart(recent[0].date);
    setPeriodEnd(recent.at(-1).date);
    setShowMonth(false);
  };
  const selectSection = id => setSection(id);
  return <div className="history-workspace">
    <div className="history-subnav" role="tablist" aria-label="Ракурсы истории">
      {[['overview', 'Обзор периода'], ['forecast', 'Прогноз спроса']].map(([id, label]) => <button type="button" role="tab" aria-selected={section === id} key={id} className={section === id ? 'active' : ''} onClick={() => selectSection(id)}>{label}</button>)}
    </div>
    {section === 'overview' ? <div className="history-overview">
      <section className="history-period-control" aria-label="Период анализа">
        <div><small>ПЕРИОД АНАЛИЗА</small><b>{analysisPeriodLabel}</b><span>{periodDays.length} {plural(periodDays.length, ['смена', 'смены', 'смен'])} в расчёте</span></div>
        <div className="history-period-fields">
          <HistoryPeriodPicker label="С" value={periodStart} min={firstAvailableDate} max={lastAvailableDate} rangeStart={periodStart} rangeEnd={periodEnd} boundary="start" onChange={value => { setPeriodStart(value); if (value > periodEnd) setPeriodEnd(value); setShowMonth(false); }}/>
          <HistoryPeriodPicker label="По" value={periodEnd} min={firstAvailableDate} max={lastAvailableDate} rangeStart={periodStart} rangeEnd={periodEnd} boundary="end" onChange={value => { setPeriodEnd(value); if (value < periodStart) setPeriodStart(value); setShowMonth(false); }}/>
        </div>
        <div className="history-period-quick"><button type="button" onClick={() => selectRecentPeriod(7)}>7 смен</button><button type="button" onClick={() => selectRecentPeriod(14)}>14 смен</button><button type="button" onClick={() => { setPeriodStart(firstAvailableDate); setPeriodEnd(lastAvailableDate); setShowMonth(false); }}>Вся история</button></div>
      </section>
      <div className="analytics-kpis analytics-kpis-three analytics-history-kpis">
        <MetricCard icon={BriefcaseBusiness} label="Заявки за период" value={number(periodTotals.total)} note={`${number(periodTotals.assigned)} вошли в планы`}/>
        <MetricCard icon={Target} label="Покрытие за период" value={`${number(periodTotals.coverage)}%`} note={`${number(periodTotals.total - periodTotals.assigned)} потребовали решения`} tone={periodTotals.coverage >= 95 ? 'good' : 'attention'}/>
        <MetricCard icon={Route} label="Пробег на заявку" value={periodTotals.distancePerVisit == null ? 'Нет данных' : `${number(periodTotals.distancePerVisit)} км`} note={`${number(periodTotals.distance)} км по ${number(periodTotals.assigned)} запланированным визитам`}/>
      </div>
      <WeeklyComparison records={records} selectedDate={selectedDate} onInspect={openInspector}/>
      <section className="analytics-panel analytics-history-panel">
        <SectionHeading eyebrow="ДИНАМИКА" title="Как менялась нагрузка" description="Выберите день, чтобы зафиксировать его в общем фильтре аналитики"/>
        {showMonth && periodDays.length > 7 ? <button type="button" className="analytics-show-more history-collapse-top" onClick={() => setShowMonth(false)}>Свернуть до семи смен <ChevronDown className="open"/></button> : null}
        <div className="analytics-history-list">{visibleDays.map(day => <button type="button" key={day.date} className={`analytics-history-day ${day.date === selected.date ? 'selected' : ''}`} onClick={() => selectDay(day)} aria-current={day.date === selected.date ? 'date' : undefined}>
          <span className="history-date"><small>{weekdayLabel(day.date)}</small><b>{dayLabel(day.date)}</b></span>
          <span className="history-demand"><b>{day.assigned} из {day.total}</b><span><i style={{ width: `${day.coverage || 0}%` }}/></span></span>
          <span className="history-coverage">{number(day.coverage)}%<small>в плане</small></span>
          <span className={`history-backlog ${day.unassigned ? 'attention' : ''}`}>{day.unassigned}<small>без назначения</small></span>
          <span className="history-fact">{day.activeEngineers}<small>бригад на линии</small></span>
          <ChevronRight/>
        </button>)}</div>
        {!showMonth && periodDays.length > 7 ? <button type="button" className="analytics-show-more" onClick={() => setShowMonth(true)}>{`Показать все ${periodDays.length} смен`}<ChevronDown/></button> : null}
      </section>
      <section className="analytics-panel">
        <SectionHeading eyebrow="ДОЛГОСРОЧНОЕ ПЛАНИРОВАНИЕ" title={`Что важно за ${periodDays.length} ${plural(periodDays.length, ['смену', 'смены', 'смен'])}`} description="Повторяющиеся сигналы по заявкам, навыкам и доступным бригадам. Каждый вывод относится к выбранному периоду."/>
        <div className="history-insights">{periodInsights.map(item => { const Icon = item.tone === 'good' ? Check : item.key === 'peak-day' ? TrendingUp : Wrench; return <div key={item.key}><span><Icon/></span><p><b>{item.title}</b><small>{item.detail}</small></p></div>; })}</div>
      </section>
      <details className="advanced-depth" onToggle={event => setDeepDiveOpen(event.currentTarget.open)}><summary><MapPin/><span><b>Регионы и необычные изменения</b><small>Сравнение территорий и отклонения от привычной нагрузки</small></span><em>{deepDiveOpen ? 'Скрыть раздел' : 'Показать раздел'}<ChevronDown/></em></summary>{deepDiveOpen ? <div><AreaComparison records={comparisonPeriodRecords} periodLabel={analysisPeriodLabel}/><AreaAnomalies records={fullHistoryRecords} periodStart={periodStart} periodEnd={periodEnd} onInspect={openInspector}/></div> : null}</details>
    </div> : null}
    {section === 'forecast' ? <>
      <MlDemandForecast forecast={mlForecast} region={region} records={records}/>
      {!mlForecast ? <section className="analytics-panel history-forecast-panel"><div className="history-empty-inline">{forecastStatus === 'error' ? <><CircleAlert/>Не удалось загрузить модель прогноза. Обновите страницу или проверьте файл данных прогноза.</> : <><Clock3/>Загружаем расчёт прогноза спроса…</>}</div></section> : null}
    </> : null}
  </div>;
}

function ReplanningLocationPicker({ latitude, longitude, cluster, onPick }) {
  const hostRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onPickRef = useRef(onPick);
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);
  useEffect(() => {
    if (!hostRef.current) return undefined;
    const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0;
    const center = hasLocation ? [longitude, latitude] : CLUSTER_MAP_CENTERS[cluster] || [37.6173, 55.7558];
    const map = new maplibregl.Map({
      container: hostRef.current,
      style: 'https://tiles.openfreemap.org/styles/bright',
      center,
      zoom: hasLocation ? 15 : 10,
      attributionControl: false,
      minZoom: 8,
      maxZoom: 19,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('click', event => onPickRef.current(event.lngLat.lat, event.lngLat.lng));
    mapRef.current = map;
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude === 0 || longitude === 0) return;
    if (!markerRef.current) markerRef.current = new maplibregl.Marker({ color: '#f6c900' }).setLngLat([longitude, latitude]).addTo(map);
    else markerRef.current.setLngLat([longitude, latitude]);
    map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 15), duration: 450 });
  }, [latitude, longitude]);
  return <div className="replanning-map-picker"><div ref={hostRef}/><span><Crosshair/>Нажмите на карту, чтобы уточнить точку выезда</span></div>;
}

function ReplanningView({ record, data, cluster = 'all', isLive = false, planningDate = HACKATHON_PLANNING_DATE, onPreview, onApply, onRollback, onOpenPlanningDay }) {
  const [eventType, setEventType] = useState('new');
  const [form, setForm] = useState({ externalId: '', name: '', address: '', zone: cluster === 'all' ? '' : cluster, skill: 'EMERGENCY', start: '13:00', end: '15:00', duration: '60', priority: 'Срочная', eventTime: currentTimeValue(), latitude: '', longitude: '', orderId: '', engineerId: '', resourceMode: 'add', resourceZone: cluster === 'all' ? '' : cluster, resourceSkill: 'INSTALL', resourceCount: '1', resourceTransport: 'CAR', resourceShiftStart: '08:00', resourceShiftEnd: '18:00', resourceEngineerId: '', extensionMinutes: '60' });
  const [preview, setPreview] = useState({ status: 'idle', plan: null, message: '', model: null });
  const [location, setLocation] = useState({ status: 'idle', message: '' });
  const [mapOpen, setMapOpen] = useState(false);
  const [csvMessage, setCsvMessage] = useState('');
  const draftIdRef = useRef(`draft-${Date.now()}`);
  const routes = record?.plan?.routes || [];
  const orderById = useMemo(() => new Map((record?.orders || []).map(order => [String(order.id), order])), [record]);
  const routeByEngineer = useMemo(() => new Map(routes.map(route => [String(route.engineerId), route])), [routes]);
  const assignmentByOrder = useMemo(() => {
    const result = new Map();
    routes.forEach(route => (route.assignments || []).forEach(assignment => result.set(String(assignment.orderId), { route, assignment })));
    return result;
  }, [routes]);
  const assignedOrders = useMemo(() => routes.flatMap(route => route.assignments || []).map(assignment => orderById.get(String(assignment.orderId))).filter(Boolean).filter(order => cluster === 'all' || clusterOf(order) === cluster), [routes, orderById, cluster]);
  const availableClusters = useMemo(() => orderedClusters((record?.orders || []).map(clusterOf)), [record]);
  const availableEngineers = useMemo(() => (record?.team || []).filter(engineer => cluster === 'all' || clusterOf(engineer) === cluster), [record, cluster]);
  const resetPreview = update => { setPreview({ status: 'idle', plan: null, message: '', model: null }); if (update) setForm(current => ({ ...current, ...update })); };
  const updateForm = (key, value) => {
    if (key === 'address') {
      setLocation({ status: 'idle', message: '' });
      resetPreview({ address: value, latitude: '', longitude: '' });
      return;
    }
    resetPreview({ [key]: value });
  };
  const selectEventType = id => {
    setEventType(id);
    if (id === 'resource' && (!form.resourceZone || cluster !== 'all')) {
      const primaryNeed = data.needs?.[0];
      resetPreview({
        resourceZone: cluster !== 'all' ? cluster : primaryNeed?.zone || form.resourceZone,
        resourceSkill: primaryNeed?.skill || form.resourceSkill,
      });
      return;
    }
    resetPreview();
  };
  useEffect(() => {
    if (cluster === 'all' || (form.zone === cluster && form.resourceZone === cluster)) return;
    setForm(current => ({ ...current, zone: cluster, resourceZone: cluster, address: '', latitude: '', longitude: '' }));
    setLocation({ status: 'idle', message: '' });
    setPreview({ status: 'idle', plan: null, message: '', model: null });
  }, [cluster, form.zone, form.resourceZone]);
  const setCoordinates = (latitude, longitude, source = 'map') => {
    setForm(current => ({ ...current, latitude: String(latitude), longitude: String(longitude) }));
    setPreview({ status: 'idle', plan: null, message: '', model: null });
    setLocation({ status: 'ready', message: source === 'search' ? 'Адрес найден, точка подтверждена.' : 'Точка на карте выбрана.' });
  };
  const searchAddress = async (address = form.address) => {
    const query = String(address || '').trim();
    if (!query) { setLocation({ status: 'error', message: 'Сначала введите адрес.' }); return; }
    setLocation({ status: 'loading', message: 'Ищем точный адрес…' });
    try {
      const response = await fetch('/api/geocode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addresses: [{ id: 'replanning-draft', address: query }], region: 'moscow' }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Сервис поиска адресов недоступен.');
      const result = payload.results?.[0];
      if (!Array.isArray(result?.coords) || result.coords.length !== 2) throw new Error(result?.error || 'Адрес не найден. Уточните улицу и дом или выберите точку на карте.');
      setForm(current => ({ ...current, address: result.formattedAddress || query, latitude: String(result.coords[0]), longitude: String(result.coords[1]) }));
      setPreview({ status: 'idle', plan: null, message: '', model: null });
      setLocation({ status: 'ready', message: result.status === 'exact' ? 'Адрес найден, точка подтверждена.' : 'Найдена ближайшая точка. Проверьте её на карте.' });
      setMapOpen(true);
    } catch (error) {
      setLocation({ status: 'error', message: error?.message || 'Не удалось найти адрес.' });
    }
  };
  const importCsv = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const requests = parseReplanningCsv(await file.text(), cluster === 'all' ? '' : cluster);
      const imported = requests[0];
      setForm(current => ({ ...current, ...imported, eventTime: imported.eventTime || current.eventTime, zone: cluster === 'all' ? imported.zone : cluster }));
      setPreview({ status: 'idle', plan: null, message: '', model: null });
      setCsvMessage(requests.length === 1 ? `Заявка ${imported.externalId} загружена из CSV.` : `В CSV ${requests.length} заявок. Для этого расчёта открыта первая: ${imported.externalId}.`);
      if (imported.latitude && imported.longitude) {
        setLocation({ status: 'ready', message: 'Координаты прочитаны из CSV.' });
        setMapOpen(true);
      } else await searchAddress(imported.address);
    } catch (error) {
      setCsvMessage(error?.message || 'Не удалось прочитать CSV.');
    }
  };
  const draftModel = useMemo(() => {
    const baseOrders = record?.orders || [];
    const baseTeam = record?.team || [];
    if (eventType === 'cancel') return { orders: baseOrders.filter(order => String(order.id) !== String(form.orderId)), team: baseTeam, event: { type: 'ORDER_CANCELLED', time: form.eventTime, orderId: form.orderId } };
    if (eventType === 'unavailable') return { orders: baseOrders, team: baseTeam.map(engineer => String(engineer.id) === String(form.engineerId) ? { ...engineer, status: 'Недоступен', unavailableFrom: form.eventTime } : engineer), event: { type: 'ENGINEER_UNAVAILABLE', time: form.eventTime, engineerId: form.engineerId } };
    if (eventType === 'resource') {
      if (form.resourceMode === 'extend') {
        const engineer = baseTeam.find(item => String(item.id) === String(form.resourceEngineerId));
        const extensionMinutes = Math.max(15, Math.min(180, Number(form.extensionMinutes) || 60));
        const extendedEnd = timeLabel(Math.min(1439, minutesFromTime(engineer?.shiftEnd || '18:00') + extensionMinutes));
        return {
          orders: baseOrders,
          team: baseTeam.map(item => String(item.id) === String(form.resourceEngineerId) ? { ...item, shiftEnd: extendedEnd } : item),
          event: { type: 'SHIFT_EXTENDED', time: engineer?.shiftEnd || '18:00', engineerId: form.resourceEngineerId, previousShiftEnd: engineer?.shiftEnd, shiftEnd: extendedEnd, extensionMinutes },
        };
      }
      const count = 1;
      const regionalReference = baseTeam.find(engineer => clusterOf(engineer) === form.resourceZone && Array.isArray(engineer.startCoords));
      const addedEngineers = Array.from({ length: count }, (_, index) => ({
        id: `${draftIdRef.current}-engineer-${index + 1}`,
        name: `Дополнительная бригада ${index + 1}`,
        skills: [form.resourceSkill],
        shiftStart: form.resourceShiftStart,
        shiftEnd: form.resourceShiftEnd,
        transport: form.resourceTransport,
        zone: form.resourceZone,
        startCoords: regionalReference?.startCoords,
        regionId: record?.regionId || baseTeam[0]?.regionId || 'moscow',
      }));
      return { orders: baseOrders, team: [...baseTeam, ...addedEngineers], event: { type: 'CAPACITY_ADDED', time: form.resourceShiftStart, engineerIds: addedEngineers.map(engineer => engineer.id), count, zone: form.resourceZone, skill: form.resourceSkill } };
    }
    const latitude = Number(form.latitude);
    const longitude = Number(form.longitude);
    const draftOrder = {
      id: form.externalId.trim() ? `draft-${form.externalId.trim()}` : draftIdRef.current,
      sourceId: form.externalId.trim(),
      name: form.name.trim() || `Новая заявка · ${form.address.trim()}`, address: form.address.trim(), zone: form.zone,
      skill: form.skill, start: form.start, end: form.end, duration: Number(form.duration),
      priority: form.priority, regionId: record?.regionId || 'moscow',
      coords: Number.isFinite(latitude) && Number.isFinite(longitude) ? [latitude, longitude] : null,
    };
    return { orders: [...baseOrders, draftOrder], team: baseTeam, event: { type: 'NEW_ORDER', time: form.eventTime, orderId: draftOrder.id } };
  }, [eventType, form, record]);
  const validationError = useMemo(() => {
    if (eventType !== 'resource' && !form.eventTime) return 'Укажите время события.';
    if (eventType === 'cancel' && !form.orderId) return 'Выберите отменённую заявку из опубликованного маршрута.';
    if (eventType === 'unavailable' && !form.engineerId) return 'Выберите инженера, который стал недоступен.';
    if (eventType === 'resource' && form.resourceMode === 'extend' && !form.resourceEngineerId) return 'Выберите инженера, чью смену нужно продлить.';
    if (eventType === 'resource' && form.resourceMode === 'extend' && (!Number(form.extensionMinutes) || Number(form.extensionMinutes) < 15 || Number(form.extensionMinutes) > 180)) return 'Продление смены должно быть от 15 до 180 минут.';
    if (eventType === 'resource' && form.resourceMode === 'add' && (!form.resourceZone || !form.resourceSkill)) return 'Укажите территорию и навык новой бригады.';
    if (eventType === 'resource' && form.resourceMode === 'add' && (!form.resourceShiftStart || !form.resourceShiftEnd || minutesFromTime(form.resourceShiftEnd) <= minutesFromTime(form.resourceShiftStart))) return 'Проверьте начало и завершение новой смены.';
    if (eventType === 'resource') return '';
    if (eventType !== 'new') return '';
    if (!form.externalId.trim()) return 'Укажите ID новой заявки.';
    if (!form.address.trim()) return 'Укажите адрес новой заявки.';
    if (!form.zone || !form.start || !form.end || !Number(form.duration)) return 'Заполните участок, окно и длительность работ.';
    if (!Number.isFinite(Number(form.latitude)) || !Number.isFinite(Number(form.longitude))) return 'Найдите адрес или выберите точку на карте — планировщику нужно место выезда.';
    if (minutesFromTime(form.end) <= minutesFromTime(form.start)) return 'Конец клиентского окна должен быть позже начала.';
    return '';
  }, [eventType, form]);
  const requestPreview = async () => {
    if (!isLive) { setPreview({ status: 'error', plan: null, model: null, message: `Откройте планируемую смену ${longDayLabel(planningDate)}: пересчёт и публикация доступны только для этого рабочего дня.` }); return; }
    if (validationError) { setPreview({ status: 'error', plan: null, model: null, message: validationError }); return; }
    setPreview({ status: 'loading', plan: null, model: draftModel, message: '' });
    try {
      const plan = await onPreview?.(draftModel, record?.plan);
      if (!plan) throw new Error('Планировщик не вернул проверенный план');
      setPreview({ status: 'ready', plan, model: draftModel, message: 'Черновик рассчитан и готов к принятию.' });
    } catch (error) {
      setPreview({ status: 'error', plan: null, model: null, message: error?.message || 'Не удалось выполнить проверяемый пересчёт.' });
    }
  };
  const rollbackDraft = async () => {
    try {
      if (preview.status === 'applied') await onRollback?.();
      setPreview({ status: 'idle', plan: null, message: '', model: null });
    } catch (error) {
      setPreview(current => ({ ...current, message: error?.message || 'Не удалось восстановить предыдущий план.' }));
    }
  };
  const afterData = useMemo(() => {
    if (!preview.plan || !preview.model) return null;
    const scoped = filterRecordByCluster({ orders: preview.model.orders, team: preview.model.team, plan: preview.plan }, cluster);
    const result = buildAnalytics(scoped.orders, scoped.team, scoped.plan);
    const unavailableEngineerId = preview.model.event?.type === 'ENGINEER_UNAVAILABLE' ? String(preview.model.event.engineerId) : '';
    const activeEngineers = (scoped.plan?.routes || []).filter(route => route.assignments?.length && String(route.engineerId) !== unavailableEngineerId).length;
    return { ...result, activeEngineers };
  }, [preview, cluster]);
  const hasPreview = preview.status === 'ready' || preview.status === 'applied';
  const applyPreview = async () => {
    if (!preview.plan || !preview.model) return;
    setPreview(current => ({ ...current, status: 'publishing', message: 'Публикуем проверенный план…' }));
    try {
      await onApply?.({ ...preview.model, plan: preview.plan });
      setPreview(current => ({ ...current, status: 'applied', message: 'План опубликован.' }));
    } catch (error) {
      setPreview(current => ({ ...current, status: 'ready', message: error?.message || 'Публикация не выполнена.' }));
    }
  };
  const normalizedDelta = value => Math.abs(Number(value) || 0) < 0.05 ? 0 : Math.round(Number(value) * 10) / 10;
  const delta = value => {
    const normalized = normalizedDelta(value);
    return normalized > 0 ? `+${number(normalized)}` : normalized < 0 ? `−${number(Math.abs(normalized))}` : '0';
  };
  const assignmentDelta = afterData ? normalizedDelta(afterData.assigned - data.assigned) : 0;
  const engineerDelta = afterData ? normalizedDelta(afterData.activeEngineers - data.activeEngineers) : 0;
  const riskDelta = afterData ? normalizedDelta(afterData.criticalSlack.length - data.criticalSlack.length) : 0;
  const kpis = [['Выполнение заявок', `${data.assigned} / ${data.total}`, afterData ? `${afterData.assigned} / ${afterData.total}` : '—', afterData ? `${delta(assignmentDelta)} ${plural(Math.abs(assignmentDelta), ['заявка', 'заявки', 'заявок'])}` : ''], ['Задействовано инженеров', String(data.activeEngineers), afterData ? String(afterData.activeEngineers) : '—', afterData ? `${delta(engineerDelta)} ${plural(Math.abs(engineerDelta), ['бригада', 'бригады', 'бригад'])}` : ''], ['Суммарный пробег', `${number(data.distance)} км`, afterData ? `${number(afterData.distance)} км` : '—', afterData ? `${delta(afterData.distance - data.distance)} км` : ''], ['SLA / риски', String(data.criticalSlack.length), afterData ? String(afterData.criticalSlack.length) : '—', afterData ? `${delta(riskDelta)} ${plural(Math.abs(riskDelta), ['визит в риске', 'визита в риске', 'визитов в риске'])}` : '']];
  const changedRoutes = useMemo(() => {
    if (!preview.plan) return [];
    const beforeByEngineer = new Map(routes.map(route => [String(route.engineerId), route]));
    const afterByEngineer = new Map((preview.plan.routes || []).map(route => [String(route.engineerId), route]));
    return [...new Set([...beforeByEngineer.keys(), ...afterByEngineer.keys()])].map(engineerId => ({ before: beforeByEngineer.get(engineerId) || null, after: afterByEngineer.get(engineerId) || null, engineerId })).filter(({ before, after }) => JSON.stringify((before?.assignments || []).map(item => [item.orderId, item.plannedStart])) !== JSON.stringify((after?.assignments || []).map(item => [item.orderId, item.plannedStart]))).slice(0, 6);
  }, [preview.plan, routes]);
  const routeStops = (route, lookup) => (route?.assignments || []).slice(0, 6).map(assignment => ({ id: assignment.orderId, name: lookup.get(String(assignment.orderId))?.name || `Заявка ${assignment.orderId}`, start: assignment.plannedStart || '—' }));
  const afterOrderById = useMemo(() => new Map((preview.model?.orders || []).map(order => [String(order.id), order])), [preview.model]);
  const assignmentExplanation = useMemo(() => {
    if (!preview.plan || !preview.model) return null;
    const explicit = preview.plan.assignmentExplanations || [];
    const eventOrderId = String(preview.model.event?.orderId || '');
    let targetOrderId = eventOrderId && preview.model.event?.type !== 'ORDER_CANCELLED' ? eventOrderId : '';
    const beforeEngineerByOrder = new Map(routes.flatMap(route => (route.assignments || []).map(assignment => [String(assignment.orderId), String(route.engineerId)])));
    if (!targetOrderId) {
      for (const route of preview.plan.routes || []) {
        const moved = (route.assignments || []).find(assignment => beforeEngineerByOrder.has(String(assignment.orderId)) && beforeEngineerByOrder.get(String(assignment.orderId)) !== String(route.engineerId));
        if (moved) { targetOrderId = String(moved.orderId); break; }
      }
    }
    const exact = explicit.find(item => String(item.orderId) === targetOrderId) || explicit[0];
    if (exact) return exact;
    if (!targetOrderId) return null;
    const route = (preview.plan.routes || []).find(item => (item.assignments || []).some(assignment => String(assignment.orderId) === targetOrderId));
    const index = route?.assignments?.findIndex(assignment => String(assignment.orderId) === targetOrderId) ?? -1;
    const assignment = index >= 0 ? route.assignments[index] : null;
    const order = afterOrderById.get(targetOrderId);
    const engineer = (preview.model.team || []).find(item => String(item.id) === String(route?.engineerId));
    if (!route || !assignment || !order || !engineer) return null;
    const finish = minutesFromTime(assignment.plannedFinish || assignment.plannedStart) || minutesFromTime(assignment.plannedStart) + (Number(order.duration) || 0);
    const next = route.assignments[index + 1];
    const scheduleBuffer = next ? Math.max(0, minutesFromTime(next.plannedStart) - finish) : Math.max(0, minutesFromTime(engineer.shiftEnd || route.shiftEnd) - finish);
    const requiredSkill = sourceSkill(order);
    const normalizedRequiredSkill = displaySkill(requiredSkill).toLocaleLowerCase('ru-RU');
    const matchingEngineers = (preview.model.team || []).filter(item => clusterOf(item) === clusterOf(order) && (item.skills || []).some(skill => displaySkill(skill).toLocaleLowerCase('ru-RU') === normalizedRequiredSkill));
    return {
      orderId: order.id,
      engineerId: engineer.id,
      engineerName: engineer.name || route.engineerName || engineer.id,
      zone: clusterOf(order),
      requiredSkill,
      engineerSkills: engineer.skills || [],
      transport: engineer.transport,
      travelMinutes: Number.isFinite(Number(assignment.travelMinutes)) ? Number(assignment.travelMinutes) : null,
      distanceKm: Number.isFinite(Number(assignment.distanceM)) ? Number(assignment.distanceM) / 1000 : Number.isFinite(Number(assignment.distanceKm)) ? Number(assignment.distanceKm) : null,
      plannedStart: assignment.plannedStart,
      plannedFinish: assignment.plannedFinish,
      windowStart: order.start,
      windowEnd: order.end,
      serviceMinutes: Number(order.duration) || null,
      scheduleBuffer,
      nextVisitStart: next?.plannedStart || null,
      feasibleCandidateCount: null,
      comparedEngineerCount: matchingEngineers.length,
      selectionRule: 'PLAN_RESULT',
    };
  }, [preview.plan, preview.model, routes, afterOrderById]);
  const decisionVerdict = useMemo(() => {
    if (!afterData || !preview.model) return '';
    const riskCount = afterData.criticalSlack.length;
    const riskText = riskCount ? `В зоне риска остаётся ${riskCount} ${plural(riskCount, ['визит', 'визита', 'визитов'])} с запасом до 15 минут.` : 'Визитов с критичным запасом не найдено.';
    if (eventType === 'new') {
      if (!assignmentExplanation) return `Новая заявка не получила допустимого назначения: проверьте очередь и ограничения. ${riskText}`;
      return `Новая заявка назначена ${brigadeLabel(assignmentExplanation.engineerName)} на ${assignmentExplanation.plannedStart || 'рассчитанное время'}. Использовано резервное окно с запасом ${assignmentExplanation.scheduleBuffer} мин; остальные клиентские окна сохранены. ${riskText}`;
    }
    if (eventType === 'unavailable') return `После недоступности инженера алгоритм перестроил ${changedRoutes.length} ${plural(changedRoutes.length, ['маршрут', 'маршрута', 'маршрутов'])} и перераспределил доступные будущие визиты между подходящими бригадами. ${riskText}`;
    if (eventType === 'cancel') return `Отменённый визит снят с маршрута, освободившееся окно учтено при пересчёте ${changedRoutes.length} ${plural(changedRoutes.length, ['маршрута', 'маршрутов', 'маршрутов'])}. ${riskText}`;
    if (form.resourceMode === 'extend') {
      const engineer = availableEngineers.find(item => String(item.id) === String(form.resourceEngineerId));
      return `Смена ${brigadeLabel(engineer?.name || engineer?.id)} продлена на ${form.extensionMinutes} мин. Алгоритм заново проверил очередь, окна и загрузку маршрута. ${riskText}`;
    }
    const recovered = Math.max(0, afterData.assigned - data.assigned);
    const resultText = recovered ? `Дополнительно назначено ${recovered} ${plural(recovered, ['заявка', 'заявки', 'заявок'])}.` : 'Допустимых новых назначений не найдено: нужно изменить навык, территорию или границы смены.';
    return `В расчёт добавлено ${form.resourceCount} ${plural(Number(form.resourceCount), ['бригада', 'бригады', 'бригад'])} с навыком «${displaySkill(form.resourceSkill)}» в зоне «${form.resourceZone}». ${resultText} ${riskText}`;
  }, [afterData, preview.model, eventType, assignmentExplanation, changedRoutes.length, form.resourceMode, form.resourceEngineerId, form.extensionMinutes, form.resourceCount, form.resourceSkill, form.resourceZone, availableEngineers, data.assigned]);
  const planningDayText = longDayLabel(planningDate).replace(/\s+\d{4}\s*г\.?$/i, '');
  return <div className="replanning-workspace">
    <section className="replanning-header"><div><small>ЦЕНТР РЕШЕНИЙ · СМЕНА {planningDayText.toLocaleUpperCase('ru-RU')}</small><h2>Оперативный симулятор смены</h2><p>Проверьте событие в черновом расчёте, сравните результат и только затем опубликуйте новый план.</p>{!isLive ? <div className="replanning-live-note"><CircleAlert/><span>Для публикации откройте <button type="button" onClick={onOpenPlanningDay}>{planningDayText}</button>.</span></div> : null}</div>{preview.status !== 'idle' ? <span className={hasPreview ? 'applied' : ''}>{preview.status === 'loading' ? <Activity/> : <Check/>}{preview.status === 'loading' ? 'Идёт расчёт' : preview.status === 'applied' ? 'Опубликовано' : 'Черновик готов'}</span> : null}</section>
    <section className="analytics-panel replanning-event-panel"><SectionHeading eyebrow="1 · СЦЕНАРИЙ" title="Выберите воздействие" description="Все изменения сначала рассчитываются как черновик и не затрагивают боевой маршрут"/>
      <div className="replanning-event-types" role="tablist" aria-label="Тип сценария">{[['new', '🚨', 'Срочная заявка'], ['unavailable', '👤', 'Инженер недоступен'], ['resource', '➕', 'Добавить бригаду / смену'], ['cancel', '✕', 'Отмена визита']].map(([id, emoji, label]) => <button type="button" role="tab" aria-selected={eventType === id} key={id} className={eventType === id ? 'active' : ''} onClick={() => selectEventType(id)}><span aria-hidden="true">{emoji}</span>{label}</button>)}</div>
      {eventType === 'new' ? <div className="replanning-new-order">
        <div className="replanning-entry-toolbar"><b>Новая заявка</b><div className="replanning-entry-buttons"><label className="replanning-csv-button"><FileUp/>Загрузить CSV<input type="file" accept=".csv,text/csv" onChange={importCsv}/></label></div></div>
        {csvMessage ? <div className="replanning-csv-message">{csvMessage}</div> : null}
        <div className="replanning-form">
          <label>Номер заявки<input value={form.externalId} placeholder="CRM-79450" onChange={event => updateForm('externalId', event.target.value)}/></label>
          <label>Клиент / объект<input value={form.name} placeholder="Клиент или объект" onChange={event => updateForm('name', event.target.value)}/></label>
          <label>Участок<BusinessSelect className="replanning-business-select" ariaLabel="Выбрать участок" value={form.zone} disabled={cluster !== 'all'} onChange={value => updateForm('zone', value)} options={[{ value: '', label: 'Выберите участок', hint: 'Региональные границы будут учтены в расчёте' }, ...availableClusters.map(item => ({ value: item, label: item, hint: `Бригады и маршруты зоны «${item}»` }))]}/></label>
          <label>Тип работ<BusinessSelect className="replanning-business-select" ariaLabel="Выбрать тип работ" value={form.skill} onChange={value => resetPreview({ skill: value, ...(value === 'EMERGENCY' ? { priority: 'Срочная' } : {}) })} options={[{ value: 'EMERGENCY', label: 'Аварийные работы', hint: 'Приоритетный выезд и аварийный допуск', priority: true }, { value: 'INSTALL', label: 'Подключение', hint: 'Монтаж и подключение оборудования' }, { value: 'LOCAL', label: 'Локальные работы', hint: 'Диагностика и ремонт на объекте' }]}/></label>
          <label className="wide replanning-address-field">Адрес<div><input value={form.address} placeholder="Москва, улица, дом" onChange={event => updateForm('address', event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); searchAddress(); } }}/><button type="button" onClick={() => searchAddress()} disabled={location.status === 'loading'}><Search/>{location.status === 'loading' ? 'Ищем…' : 'Найти'}</button><button type="button" className={mapOpen ? 'active' : ''} onClick={() => setMapOpen(current => !current)}><MapPin/>{mapOpen ? 'Скрыть карту' : 'Выбрать на карте'}</button></div>{location.message ? <span className={location.status}>{location.message}</span> : null}</label>
          <ManualTimeField label="Время события" value={form.eventTime} onChange={value => updateForm('eventTime', value)}/><ManualTimeField label="Начало окна" value={form.start} onChange={value => updateForm('start', value)}/><ManualTimeField label="Конец окна" value={form.end} onChange={value => updateForm('end', value)}/><label>Длительность, мин<input type="number" min="1" value={form.duration} onChange={event => updateForm('duration', event.target.value)}/></label><label>Приоритет<BusinessSelect className="replanning-business-select" ariaLabel="Выбрать приоритет" value={form.priority} onChange={value => updateForm('priority', value)} options={[{ value: 'Срочная', label: 'Срочная', hint: 'Обработать в первую очередь', priority: true }, { value: 'Обычная', label: 'Обычная', hint: 'Стандартный порядок планирования' }]}/></label>
        </div>
        {mapOpen ? <ReplanningLocationPicker key={form.zone || 'all'} latitude={Number(form.latitude)} longitude={Number(form.longitude)} cluster={form.zone} onPick={(latitude, longitude) => setCoordinates(latitude, longitude)}/> : null}
      </div> : null}
      {eventType === 'resource' ? <div className="replanning-resource-scenario">
        <div className="replanning-resource-mode" role="group" aria-label="Способ изменения ресурса"><button type="button" className={form.resourceMode === 'add' ? 'active' : ''} onClick={() => updateForm('resourceMode', 'add')}>Добавить бригаду</button><button type="button" className={form.resourceMode === 'extend' ? 'active' : ''} onClick={() => updateForm('resourceMode', 'extend')}>Продлить смену</button></div>
        {form.resourceMode === 'add' ? <div className="replanning-form resource-form">
          <label>Территория<BusinessSelect className="replanning-business-select" ariaLabel="Выбрать территорию бригады" value={form.resourceZone} disabled={cluster !== 'all'} onChange={value => updateForm('resourceZone', value)} options={[{ value: '', label: 'Выберите территорию' }, ...availableClusters.map(item => ({ value: item, label: item, hint: `Новая бригада будет закреплена за зоной` }))]}/></label>
          <label>Навык новой бригады<BusinessSelect className="replanning-business-select" ariaLabel="Выбрать навык новой бригады" value={form.resourceSkill} onChange={value => updateForm('resourceSkill', value)} options={[{ value: 'INSTALL', label: 'Подключение' }, { value: 'LOCAL', label: 'Локальные работы' }, { value: 'EMERGENCY', label: 'Аварийные работы', priority: true }]}/></label>
          <label>Количество бригад<input type="number" value="1" readOnly title="Каждая новая бригада проходит отдельную проверку и публикацию"/></label>
          <label>Транспорт<BusinessSelect className="replanning-business-select" ariaLabel="Выбрать транспорт новой бригады" value={form.resourceTransport} onChange={value => updateForm('resourceTransport', value)} options={[{ value: 'CAR', label: 'Автомобиль', hint: 'Оптимально для дальних выездов' }, { value: 'PUBLIC_TRANSIT', label: 'Общ. транспорт' }, { value: 'BICYCLE', label: 'Велосипед' }, { value: 'WALKING', label: 'Пешеход' }]}/></label>
          <ManualTimeField label="Начало смены" value={form.resourceShiftStart} onChange={value => updateForm('resourceShiftStart', value)}/>
          <ManualTimeField label="Завершение смены" value={form.resourceShiftEnd} onChange={value => updateForm('resourceShiftEnd', value)}/>
        </div> : <div className="replanning-select-event resource-extension"><label>Инженер<BusinessSelect className="replanning-business-select wide-menu" ariaLabel="Выбрать инженера для продления смены" value={form.resourceEngineerId} onChange={value => updateForm('resourceEngineerId', value)} options={[{ value: '', label: 'Выберите инженера' }, ...availableEngineers.map(engineer => ({ value: String(engineer.id), label: engineer.name || engineer.id, hint: `${engineer.shiftStart}–${engineer.shiftEnd} · ${clusterOf(engineer)} · ${TRANSPORT_LABELS[engineer.transport] || 'Транспорт не указан'}` }))]}/></label><label>Продлить на, минут<input type="number" min="15" max="180" step="15" value={form.extensionMinutes} onChange={event => updateForm('extensionMinutes', event.target.value)}/></label></div>}
        <p className="replanning-resource-note"><CircleHelp/>Новая мощность передаётся точному планировщику. Публикация доступна только после проверки территории, навыков, клиентских окон, смены и маршрутов.</p>
      </div> : null}
      {eventType === 'cancel' ? <div className="replanning-select-event compact"><label>Отменённый визит<BusinessSelect className="replanning-order-select" ariaLabel="Выбрать отменённый визит" value={form.orderId} onChange={value => updateForm('orderId', value)} options={[{ value: '', label: 'Выберите заявку из маршрута', hint: 'Можно найти нужную заявку по номеру, адресу и бригаде' }, ...assignedOrders.map(order => { const assigned = assignmentByOrder.get(String(order.id)); const numberLabel = String(order.sourceId || order.id).replace(/^.*:/, ''); return { value: String(order.id), label: `Заявка №${numberLabel} · ${compactOrderAddress(order.address)}`, hint: `${assigned?.route?.engineerName || 'Бригада не указана'} · окно ${order.start}–${order.end}` }; })]}/></label><ManualTimeField label="Время отмены" value={form.eventTime} onChange={value => updateForm('eventTime', value)}/></div> : null}
      {eventType === 'unavailable' ? <div className="replanning-select-event compact"><label>Инженер, который недоступен<BusinessSelect className="replanning-business-select wide-menu" ariaLabel="Выбрать недоступного инженера" value={form.engineerId} onChange={value => updateForm('engineerId', value)} options={[{ value: '', label: 'Выберите инженера' }, ...(record?.team || []).filter(engineer => cluster === 'all' || clusterOf(engineer) === cluster).map(engineer => { const route = routeByEngineer.get(String(engineer.id)); const visits = route?.assignments?.length || 0; return { value: String(engineer.id), label: engineer.name || engineer.id, hint: `${clusterOf(engineer)} · ${visits} ${plural(visits, ['заявка', 'заявки', 'заявок'])} в плане · ${TRANSPORT_LABELS[engineer.transport] || 'Транспорт не указан'}` }; })]}/></label><ManualTimeField label="Время недоступности" value={form.eventTime} onChange={value => updateForm('eventTime', value)}/></div> : null}
      <div className="replanning-actions scenario-calculate"><button type="button" className="primary" onClick={requestPreview} disabled={preview.status === 'loading'}>{preview.status === 'loading' ? 'Рассчитываем…' : 'Рассчитать сценарий ⚡'}</button></div>
      {preview.message ? <div className={`replanning-result ${hasPreview ? 'ready' : preview.status}`}><span>{hasPreview ? <Check/> : <CircleAlert/>}</span><p>{preview.message}</p></div> : null}
    </section>
    {hasPreview ? <>
      <section className="analytics-panel replanning-decision-panel"><SectionHeading eyebrow="2 · БЫЛО → СТАЛО" title="Панель принятия решения" description="Метрики рассчитаны по черновому плану и сопоставлены с опубликованным состоянием смены"/>
        <div className="replanning-kpis">{kpis.map(([label, from, to, impact]) => <article key={label}><small>{label}</small><div><b>{from}</b><ArrowRight/><strong>{to}</strong></div>{impact ? <em>{impact}</em> : null}</article>)}</div>
        <div className="replanning-verdict"><span><Zap/></span><div><small>ВЕРДИКТ АЛГОРИТМА</small><b>{preview.status === 'applied' ? 'Решение опубликовано' : 'Черновик можно принять'}</b><p>{decisionVerdict}</p></div></div>
      </section>
      <div className="replanning-grid"><section className="analytics-panel"><SectionHeading eyebrow="КОГО ЗАТРОНУЛО" title={changedRoutes.length ? `Изменено маршрутов: ${changedRoutes.length}` : 'Маршруты не изменились'}/>{changedRoutes.length ? changedRoutes.map(({ before, after, engineerId }) => <div className="route-diff" key={engineerId}><div><small>Было · {before?.engineerName || after?.engineerName || engineerId}</small>{routeStops(before, orderById).map(stop => <span key={`before:${stop.id}`}><b>{stop.start}</b>{stop.name}</span>)}</div><ArrowRight/><div><small>Станет · {after?.engineerName || before?.engineerName || engineerId}</small>{routeStops(after, afterOrderById).map(stop => <span key={`after:${stop.id}`}><b>{stop.start}</b>{stop.name}</span>)}</div></div>) : <p className="replanning-empty">Без изменений.</p>}</section><section className="analytics-panel replanning-explanation"><SectionHeading eyebrow="ПОЧЕМУ ЭТОТ ИСПОЛНИТЕЛЬ" title={assignmentExplanation ? `Почему выбрана ${brigadeLabel(assignmentExplanation.engineerName)}` : 'Ограничения соблюдены'}/>{assignmentExplanation ? <div className="replanning-candidates"><div><span><Route/></span><b>Логистика</b><small>{assignmentExplanation.feasibleCandidateCount ? `Проверено ${assignmentExplanation.comparedEngineerCount} ${plural(assignmentExplanation.comparedEngineerCount, ['бригада', 'бригады', 'бригад'])} региона, допустимых вариантов — ${assignmentExplanation.feasibleCandidateCount}. Этот вариант меньше всего меняет текущие маршруты.` : `Назначение рассчитано внутри региона «${assignmentExplanation.zone}».`}{assignmentExplanation.distanceKm != null || assignmentExplanation.travelMinutes != null ? ` Доезд к адресу: ${assignmentExplanation.distanceKm != null ? `${number(assignmentExplanation.distanceKm)} км` : ''}${assignmentExplanation.distanceKm != null && assignmentExplanation.travelMinutes != null ? ' / ' : ''}${assignmentExplanation.travelMinutes != null ? `${assignmentExplanation.travelMinutes} мин` : ''}${assignmentExplanation.transport ? ` (${TRANSPORT_LABELS[assignmentExplanation.transport] || String(assignmentExplanation.transport).toLocaleLowerCase('ru-RU')})` : ''}.` : ''}</small></div><div><span><Clock3/></span><b>График</b><small>Визит {assignmentExplanation.plannedStart || '—'}–{assignmentExplanation.plannedFinish || '—'} укладывается в окно {assignmentExplanation.windowStart || '—'}–{assignmentExplanation.windowEnd || '—'}{assignmentExplanation.serviceMinutes ? ` с нормативом ${assignmentExplanation.serviceMinutes} мин` : ''}. {assignmentExplanation.nextVisitStart ? `Следующий визит остаётся на ${assignmentExplanation.nextVisitStart}; запас — ${assignmentExplanation.scheduleBuffer} мин.` : `После выполнения до конца смены остаётся ${assignmentExplanation.scheduleBuffer} мин.`}</small></div><div><span><Wrench/></span><b>Навык и территория</b><small>{`${brigadeLabel(assignmentExplanation.engineerName)} закреплена в зоне «${assignmentExplanation.zone}» и имеет требуемый допуск «${displaySkill(assignmentExplanation.requiredSkill)}». Межрегиональный перенос не использовался.`}</small></div></div> : <div className="replanning-candidates"><div><span><Check/></span><b>Окна и маршруты проверены</b></div><div><span><Check/></span><b>Региональные границы сохранены</b></div>{afterData.explanations.slice(0, 2).map(item => <div key={item.orderId}><span><CircleAlert/></span><b>{item.title}</b><small>{item.reason}</small></div>)}</div>}</section></div>
      <section className="replanning-action-bar" aria-label="Фиксация решения"><div><small>3 · ФИКСАЦИЯ РЕШЕНИЯ</small><b>{preview.status === 'applied' ? 'Сценарий находится в боевом плане' : 'Черновик не влияет на маршруты, пока вы его не примете'}</b></div><div><button type="button" className="secondary" onClick={rollbackDraft}><RotateCcw/>{preview.status === 'applied' ? 'Вернуть предыдущий план' : 'Откатить черновик'}</button><button type="button" className="primary" disabled={preview.status !== 'ready'} onClick={applyPreview}>{preview.status === 'applied' ? <><Check/>Принято в боевой план</> : 'Принять в боевой план'}</button></div></section>
    </> : <section className="replanning-await"><Zap/><div><b>Настройте событие и рассчитайте сценарий</b><p>Здесь появятся сравнение «было → стало», объяснение алгоритма, риски и действия с черновиком.</p></div></section>}
  </div>;
}

const analyticsReturnPosition = { view: 'shift', scrollTop: 0 };

export function AnalyticsWorkspace({ orders = [], team = [], plan, date, onDateChange, history = EMPTY_ANALYTICS_HISTORY, dateControl, onUploadData, onOpenUnassigned, onOpenRoutes, onOpenOrder, onPreviewReplan, onApplyReplan, onRollbackReplan, onStartLiveReplan }) {
  const [view, setView] = useState(() => analyticsReturnPosition.view);
  const pendingReturnScrollRef = useRef(analyticsReturnPosition.scrollTop);
  const [toolbarStuck, setToolbarStuck] = useState(false);
  const toolbarSentinelRef = useRef(null);
  const [resourceViewMode, setResourceViewMode] = useState('summary');
  const [resourceFocus, setResourceFocus] = useState(null);
  const [cluster, setCluster] = useState('all');
  const [historySection, setHistorySection] = useState('overview');
  const [initialData, setInitialData] = useState({ status: 'idle', data: null });
  useEffect(() => { analyticsReturnPosition.view = view; }, [view]);
  useLayoutEffect(() => {
    const page = document.querySelector('.analytics-page');
    if (!page) return undefined;
    const remember = () => { analyticsReturnPosition.scrollTop = page.scrollTop; pendingReturnScrollRef.current = 0; };
    page.addEventListener('scroll', remember, { passive: true });
    return () => { analyticsReturnPosition.scrollTop = page.scrollTop; page.removeEventListener('scroll', remember); };
  }, []);
  useLayoutEffect(() => {
    const page = document.querySelector('.analytics-page');
    if (!page || !pendingReturnScrollRef.current) return;
    const target = pendingReturnScrollRef.current;
    const frame = requestAnimationFrame(() => {
      page.scrollTop = target;
      if (Math.abs(page.scrollTop - target) < 2) pendingReturnScrollRef.current = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [view, initialData.status, plan]);
  const [preferences, setPreferences] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('beego-analytics-preferences') || '{}');
      const savedRates = saved.rates || {};
      const rates = Object.fromEntries(Object.entries(DEFAULT_ANALYTICS_PREFERENCES.rates).map(([key, fallback]) => [key, savedRates[key] === '' || savedRates[key] == null ? fallback : savedRates[key]]));
      return {
        targets: { ...DEFAULT_ANALYTICS_PREFERENCES.targets, ...saved.targets },
        rates,
        ratesConfigured: Boolean(saved.ratesConfigured),
      };
    } catch { return DEFAULT_ANALYTICS_PREFERENCES; }
  });
  const [mlForecast, setMlForecast] = useState(null);
  const [forecastStatus, setForecastStatus] = useState('idle');
  const dateAligned = useRef(false);
  const useInitialData = !orders.length;
  useEffect(() => {
    try { localStorage.setItem('beego-analytics-preferences', JSON.stringify(preferences)); } catch { /* Storage may be unavailable. */ }
  }, [preferences]);
  useEffect(() => {
    if (initialData.data || initialData.status === 'loading' || initialData.status === 'error') return undefined;
    let active = true;
    setInitialData(current => ({ ...current, status: 'loading' }));
    const base = import.meta.env.BASE_URL || '/';
    Promise.all([
      fetch(`${base}data/analytics-history.json`).then(response => {
        if (!response.ok) throw new Error('Не удалось загрузить историю смен');
        return response.json();
      }),
      fetch(`${base}test-data/beego-algorithm-initial.json`).then(response => response.ok ? response.json() : null).catch(() => null),
    ]).then(([historyPayload, source]) => {
      const payload = hydrateBaselineInputs(historyPayload, source);
      if (!Array.isArray(payload.days) || !payload.days.length) throw new Error('История смен пуста');
      if (active) setInitialData({ status: 'ready', data: payload });
    }).catch(error => {
      if (active) setInitialData({ status: 'error', data: null, message: error?.message || 'Данные аналитики недоступны' });
    });
    return () => { active = false; };
  }, [initialData.data]);
  useEffect(() => {
    if (mlForecast) return undefined;
    let active = true;
    setForecastStatus('loading');
    const base = import.meta.env.BASE_URL || '/';
    fetch(base + 'data/ml-demand-forecast.json').then(response => response.ok ? response.json() : null).then(payload => {
      if (!active) return;
      if (payload?.total && Array.isArray(payload.zones) && Array.isArray(payload.skills) && Array.isArray(payload.timeBands)) {
        setMlForecast(payload);
        setForecastStatus('ready');
      } else setForecastStatus('error');
    }).catch(() => { if (active) setForecastStatus('error'); });
    return () => { active = false; };
  }, [mlForecast]);
  useEffect(() => {
    if (!useInitialData || !initialData.data || dateAligned.current) return;
    dateAligned.current = true;
    onDateChange?.(new Date(`${initialData.data.period.end}T12:00:00`));
  }, [useInitialData, initialData.data, onDateChange]);
  const importedDate = useMemo(() => resolveImportedDate(orders), [orders]);
  const liveDateKey = orders.length ? (importedDate ? localDateKey(importedDate) : date ? localDateKey(date) : HACKATHON_PLANNING_DATE) : '';
  const liveRecord = orders.length ? { date: liveDateKey, orders, team, plan, actual: null } : null;
  const rawRecords = useMemo(() => {
    const byDate = new Map();
    (initialData.data?.days || []).forEach(record => record?.date && byDate.set(record.date, record));
    (history || []).forEach(record => record?.date && byDate.set(record.date, record));
    if (liveRecord?.date) byDate.set(liveRecord.date, liveRecord);
    return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  }, [initialData.data, history, liveRecord?.date, orders, team, plan]);
  const selectedKey = date ? localDateKey(date) : rawRecords.at(-1)?.date;
  const rawSelectedRecord = rawRecords.find(record => record.date === selectedKey);
  const isPlanningDay = Boolean(liveDateKey) && selectedKey === liveDateKey;
  const rawActiveOrders = rawSelectedRecord?.orders || [];
  const rawActiveTeam = rawSelectedRecord?.team || [];
  const rawActivePlan = rawSelectedRecord?.plan || null;
  const clusterOptions = useMemo(() => orderedClusters(rawRecords.flatMap(record => [
    ...(record?.orders || []).map(clusterOf),
    ...(record?.team || []).map(clusterOf),
    ...(record?.plan?.routes || []).map(clusterOf),
  ]).filter(value => value && value !== 'Без региона' && value !== 'Без зоны')), [rawRecords]);
  const regionSelectOptions = useMemo(() => [
    { value: 'all', label: 'Все регионы' },
    ...clusterOptions.map(value => ({ value, label: value })),
  ], [clusterOptions]);
  useEffect(() => {
    if (cluster !== 'all' && !clusterOptions.includes(cluster)) setCluster('all');
  }, [cluster, clusterOptions]);
  const records = useMemo(() => rawRecords.map(record => filterRecordByCluster(record, cluster)), [rawRecords, cluster]);
  const selectedRecord = records.find(record => record.date === selectedKey);
  const activeOrders = selectedRecord?.orders || [];
  const activeTeam = selectedRecord?.team || [];
  const activePlan = selectedRecord?.plan || null;
  const previousSelectedKeyRef = useRef(selectedKey);
  useLayoutEffect(() => {
    if (previousSelectedKeyRef.current === selectedKey) return;
    previousSelectedKeyRef.current = selectedKey;
    analyticsReturnPosition.scrollTop = 0;
    pendingReturnScrollRef.current = 0;
    setToolbarStuck(false);
    const scrollRoot = toolbarSentinelRef.current?.closest('.analytics-page') || document.querySelector('.analytics-page');
    if (scrollRoot) scrollRoot.scrollTop = 0;
  }, [selectedKey]);
  useEffect(() => {
    const sentinel = toolbarSentinelRef.current;
    const scrollRoot = sentinel?.closest('.analytics-page');
    if (!sentinel || !scrollRoot) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      setToolbarStuck(scrollRoot.scrollTop > 16 && !entry.isIntersecting);
    }, { root: scrollRoot, threshold: 0 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [selectedKey, Boolean(activePlan), initialData.status]);
  const activeRecord = selectedRecord || { date: selectedKey, orders: activeOrders, team: activeTeam, plan: activePlan, actual: null };
  const historyRecords = records;
  const comparisonHistoryRecords = rawRecords;
  const data = useMemo(() => buildAnalytics(activeOrders, activeTeam, activePlan, activeRecord?.actual), [activeOrders, activeTeam, activePlan, activeRecord?.actual]);
  const selectView = nextView => {
    if (nextView === view) return;
    startTransition(() => setView(nextView));
  };
  const openInspector = (type, scope = 'day', zone = '', range = null, routeId = '') => {
    if (type === 'unassigned') { onOpenUnassigned?.(); return; }
    if (type === 'routes' && routeId) { onOpenRoutes?.(routeId); return; }
    onStartLiveReplan?.();
  };
  const openWhatIf = () => {
    onStartLiveReplan?.();
  };
  const openResourceForNeed = focus => {
    const need = focus?.zone ? focus : data.needs?.[0];
    setResourceFocus(need ? { ...need, openedAt: Date.now() } : null);
    setResourceViewMode('summary');
    selectView('resources');
  };
  const openUnassigned = useInitialData
    ? onOpenUnassigned || (() => openInspector('unassigned', 'day'))
    : onOpenUnassigned || (() => openInspector('unassigned', 'day'));
  const openRoutes = useInitialData
    ? (routeId = '') => openInspector('routes', 'day', '', null, routeId || data.criticalSlack[0]?.engineerId || data.lateStarts[0]?.engineerId || '')
    : onOpenRoutes || (() => openInspector('routes', 'day'));
  const openWindows = () => {
    setResourceViewMode('timeline');
    selectView('resources');
  };
  const updatePreference = (section, key, value) => {
    setPreferences(current => ({ ...current, [section]: { ...current[section], [key]: value === '' ? '' : Number(value) }, ...(section === 'rates' ? { ratesConfigured: true } : {}) }));
  };
  const views = [
    ['shift', 'Смена', Activity],
    ...(historyRecords.length ? [['history', 'История', TrendingUp]] : []),
    ['resources', 'Ресурсы', Users],
    ['comparison', 'Эффективность', BarChart3],
  ];
  const analyticsToolbar = <><span ref={toolbarSentinelRef} className="analytics-toolbar-sentinel" aria-hidden="true"/><div className={`analytics-toolbar${toolbarStuck?' is-stuck':''}`}><nav aria-label="Разделы аналитики">{views.map(([id, label, Icon]) => <button type="button" key={id} className={view === id ? 'active' : ''} onClick={() => selectView(id)}><Icon/>{label}{id === 'shift' && data.unassigned ? <b>{data.unassigned}</b> : null}</button>)}</nav><div className="analytics-global-filter"><small>Регион</small><BusinessSelect className="analytics-region-select" ariaLabel="Регион аналитики" value={cluster} onChange={setCluster} options={regionSelectOptions}/></div>{dateControl}</div></>;
  if (useInitialData && initialData.status !== 'ready') return <section className="analytics-loading-state" role="status" aria-live="polite"><img className="analytics-loading-art" src="/analytics-loading-illustration.png" alt="Графики, маршрут и показатели"/><div className="analytics-loading-copy"><small>АНАЛИТИКА BEEGO</small><h2>{initialData.status === 'error' ? 'Не удалось загрузить показатели' : 'Собираем картину смены'}</h2><p>{initialData.status === 'error' ? initialData.message : 'Проверяем заявки, маршруты и загрузку команды. Это может занять немного времени.'}</p>{initialData.status === 'error' ? <button type="button" className="analytics-loading-retry" onClick={() => setInitialData({ status: 'idle', data: null })}>Повторить загрузку</button> : null}</div></section>;
  if (!selectedRecord) return <div className="analytics-workspace analytics-empty-date"><div className="analytics-toolbar analytics-empty-toolbar">{dateControl}</div><section className="analytics-date-empty"><img src="/locations-empty.svg" alt=""/><h2>Данные не загружены</h2><p>За {date ? dayLabel(selectedKey) : 'выбранную дату'} пока нет заявок. Загрузите файл, чтобы увидеть аналитику.</p><button type="button" onClick={onUploadData}><FileUp/>Загрузить данные</button></section></div>;
  if (!activePlan) return <DemandOverview orders={activeOrders} team={activeTeam} dateControl={dateControl}/>;
  return <div className="analytics-workspace">
    {analyticsToolbar}
    <div className="analytics-view-stage" key={view}>
      {view === 'shift' ? <><StatusHero data={data} onResolve={openUnassigned}/><ShiftView data={data} onOpenUnassigned={openUnassigned} onOpenResource={openResourceForNeed} onOpenRoutes={openRoutes} onOpenWindows={openWindows} onInspect={openInspector} isArchived={Boolean(selectedRecord && liveDateKey && selectedRecord.date < liveDateKey)}/></> : null}
      {view === 'history' ? <HistoryView records={historyRecords} comparisonRecords={comparisonHistoryRecords} mlForecast={mlForecast} forecastStatus={forecastStatus} selectedDate={selectedKey} planningDate={liveDateKey} onSelectDate={onDateChange} onOpenDecision={onStartLiveReplan} region={cluster} section={historySection} onSectionChange={setHistorySection}/> : null}
      {view === 'resources' ? <ResourcesView data={data} record={activeRecord} decisionScope={selectedKey} viewMode={resourceViewMode} focusNeed={resourceFocus} isLive={isPlanningDay && Boolean(plan)} onViewModeChange={setResourceViewMode} onOpenUnassigned={openUnassigned} onOpenRoute={openRoutes} onOpenOrder={onOpenOrder} onPreviewReplan={onPreviewReplan} onApplyReplan={onApplyReplan}/> : null}
      {view === 'comparison' ? <div className="efficiency-workspace"><FinancePanel record={activeRecord} baseline={data.baseline} rates={preferences.rates} onRateChange={(key, value) => updatePreference('rates', key, value)} onInspect={openInspector}/><EfficiencyView record={activeRecord} rates={preferences.rates} onOpenRoutes={openRoutes}/></div> : null}
    </div>
  </div>;
}
