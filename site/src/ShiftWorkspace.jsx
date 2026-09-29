import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  Bike,
  BriefcaseBusiness,
  Bus,
  CalendarDays,
  Car,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Flag,
  Footprints,
  LogOut,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { EVENT_TYPES, crewOperationalSummary, minuteOf, playbackFrame, shiftDisplayAt, timeOf, visitStatusLabel } from "./shiftDomain.js";
import { shiftClock } from "./shiftClock.js";
import PdfPreview from "./PdfPreview.jsx";
import { BusinessSelect } from "./BusinessSelect.jsx";
import { TimePicker } from "./TimePicker.jsx";
import { WorkspaceFilters } from "./WorkspaceFilters.jsx";
import { filterLabel, matchesAnySelection, matchesSearch, orderSearchValues, orderWorkValues } from './filterPresentation.js';
import { profileAvatarColor } from "./profileAvatar.js";
import "./shift-workspace.css";

const filterTokens = value => (Array.isArray(value) ? value : String(value || '').split(/\s*[|,;]\s*/)).map(item => String(item).trim()).filter(Boolean);
const ShiftTransportIcon=({type})=>{const normalized=String(type||'').toLocaleLowerCase('ru-RU');if(/велосип|bike|bicycle/.test(normalized))return <Bike aria-hidden="true"/>;if(/обществен|автобус|public|bus|transit/.test(normalized))return <Bus aria-hidden="true"/>;if(/пеш|walk|foot/.test(normalized))return <Footprints aria-hidden="true"/>;return <Car aria-hidden="true"/>};
const shiftPointType = order => { const name = `${order?.workType || ''} ${order?.skill || ''}`.toLocaleLowerCase('ru'); if (['Авария', 'URGENT'].includes(order?.priority) || /авар|emergency/.test(name)) return 'emergency'; if (/подключ|конверген|монтаж|install/.test(name)) return 'connection'; if (/оборудован|роутер|пристав/.test(name)) return 'equipment'; return 'service'; };
const reportKind = mode => mode === 'full' ? 'Итоги смены' : mode === 'partial' ? 'Частичный факт' : 'Плановый брифинг';
const reportFileName = item => {
  const date = String(item.date || '');
  const time = String(item.generatedAt || '').slice(11, 19).replaceAll(':', '-');
  return `BeeGo_Отчёт_${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}_${item.mode === 'full' ? 'итоги' : item.mode === 'partial' ? 'статус' : 'план'}${time ? `_${time}` : ''}.pdf`;
};

const EVENT_LABELS = {
  [EVENT_TYPES.RECALCULATE]: 'Пересчитать план',
  [EVENT_TYPES.ENGINEER_UNAVAILABLE]: "Бригада недоступна",
  [EVENT_TYPES.VISIT_CANCELLED]: "Отмена визита",
  [EVENT_TYPES.ORDER_CANCELLED]: "Отмена заявки",
  [EVENT_TYPES.NEW_ORDER]: "Новая заявка",
  [EVENT_TYPES.CAPACITY_ADDED]: "Добавить бригаду",
  [EVENT_TYPES.ENGINEER_REPLACED]: "Замена бригады",
  [EVENT_TYPES.MANUAL_ASSIGN]: "Назначить вручную",
  [EVENT_TYPES.SHIFT_BOUNDARY_CHANGED]: "Границы смены",
  [EVENT_TYPES.SHIFT_EXTENDED]: "Продлить смену",
  [EVENT_TYPES.CLIENT_WINDOW_SHIFT]: "Новое окно клиента",
  PLAN_REBUILT: "Исходный план пересчитан",
  PLAN_ROLLBACK: "Восстановлен план",
};
const DIRECT_EVENTS = [EVENT_TYPES.RECALCULATE, EVENT_TYPES.ENGINEER_UNAVAILABLE, EVENT_TYPES.VISIT_CANCELLED, EVENT_TYPES.ORDER_CANCELLED, EVENT_TYPES.MANUAL_ASSIGN, EVENT_TYPES.CLIENT_WINDOW_SHIFT, EVENT_TYPES.ENGINEER_REPLACED];
const json = async (path, options) => {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error || `Ошибка ${response.status}`);
  return payload;
};
const post = (path, body) =>
  json(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const estimatedLegsLabel = count => `${count} ${count % 100 >= 11 && count % 100 <= 14 ? 'оценочных переездов' : count % 10 === 1 ? 'оценочный переезд' : count % 10 >= 2 && count % 10 <= 4 ? 'оценочных переезда' : 'оценочных переездов'}`;
const displayDate = value => value instanceof Date ? (Number.isNaN(value.getTime()) ? 'Выберите дату' : value.toLocaleDateString('ru-RU')) : /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('.') : value || 'Выберите дату';
const metric = (plan) => ({
  assigned:
    plan?.metrics?.assigned ??
    (plan?.routes || []).reduce(
      (sum, route) => sum + (route.assignments?.length || 0),
      0,
    ),
  unassigned: plan?.metrics?.unassigned ?? plan?.unassigned?.length ?? 0,
  km: Math.round(
    (plan?.routes || []).reduce(
      (sum, route) => sum + Number(route.distanceKm || 0),
      0,
    ),
  ),
});
const planChange = (before, after, orders = []) => {
  const index = plan => new Map((plan?.routes || []).flatMap(route => (route.assignments || []).map(item => [String(item.orderId), { ...item, crew: route.engineerName || route.engineerId }])));
  const first = index(before), second = index(after);
  const names = new Map(orders.map(order => [String(order.id), order.name || order.sourceId || order.id]));
  const moved = [...second].filter(([id, next]) => first.has(id) && (first.get(id).crew !== next.crew || first.get(id).plannedStart !== next.plannedStart)).map(([id, next]) => `${names.get(id) || id}: ${first.get(id).crew} ${first.get(id).plannedStart} → ${next.crew} ${next.plannedStart}`);
  const inserted = [...second].filter(([id]) => !first.has(id)).map(([id, next]) => `${names.get(id) || id} → ${next.crew} ${next.plannedStart}`);
  const removed = [...first].filter(([id]) => !second.has(id)).map(([id]) => names.get(id) || id);
  const risky = [...second].filter(([id, item]) => {
    const earlier = first.get(id);
    if (earlier && earlier.crew === item.crew && earlier.plannedStart === item.plannedStart) return false;
    const end = minuteOf(orders.find(order => String(order.id) === id)?.end);
    const start = minuteOf(item.plannedStart);
    return end != null && start != null && end - start <= 15;
  }).map(([id]) => names.get(id) || id);
  return { moved, inserted, removed, risky };
};

function PlaybackDropdown({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  const selected = options.find(option => String(option.value) === String(value)) || options[0];
  return <div className="shift-playback-select" ref={rootRef}>
    <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(current => !current)}>
      <span>{selected.label}</span><ChevronDown size={15} aria-hidden="true"/>
    </button>
    {open ? <div className="shift-playback-menu" role="menu" aria-label={label}>
      {options.map(option => <button type="button" key={option.value} role="menuitemradio" aria-checked={String(option.value) === String(value)} className={String(option.value) === String(value) ? 'selected' : ''} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span>{option.label}</span>{String(option.value) === String(value) ? <Check size={15} aria-hidden="true"/> : null}
      </button>)}
    </div> : null}
  </div>;
}

function ChatAvatar({ role, profile }) {
  if (role === 'assistant') return <span className="shift-chat-avatar assistant-avatar" aria-label="AI-помощник"><img src="/avatars/robot-static.png" alt=""/></span>;
  return <span className="shift-chat-avatar user-avatar" aria-label={profile?.name || 'Вы'} style={{ backgroundColor: profileAvatarColor(profile) }}>{profile?.avatar ? <img src={`/avatars/${profile.avatar}.png`} alt=""/> : 'Вы'}</span>;
}

function ReportBars({ title, items, className = '' }) {
  const max = Math.max(1, ...items.map(item => item.value));
  return <section className={`daily-report-card ${className}`}><h4>{title}</h4><div className="daily-report-bars">
    {items.length ? items.map((item, index) => <div className="daily-report-bar" key={`${item.label}-${index}`}>
      <span title={item.label}>{item.label}</span><i><b style={{ width: `${Math.max(2, item.value / max * 100)}%` }}/></i><strong>{item.value}</strong>
    </div>) : <p>Показателей пока нет.</p>}
  </div></section>;
}

function DailyReportDashboard({ report }) {
  const { counts, analysis } = report;
  const issues = [
    counts.unassigned ? { label: 'Заявки в очереди', value: counts.unassigned, detail: report.unassigned?.[0]?.reason } : null,
    report.hasFact && counts.notCompleted ? { label: 'Не выполнены', value: counts.notCompleted, detail: report.failures?.[0]?.reason } : null,
    report.hasFact && counts.withoutFact ? { label: 'Без итоговой отметки', value: counts.withoutFact, detail: 'Выполнение не подтверждено' } : null,
    analysis.urgentOpen.length ? { label: report.hasFact ? 'Срочные без подтверждения' : 'Срочные в очереди', value: analysis.urgentOpen.length, detail: analysis.urgentOpen[0]?.name } : null,
    analysis.windowRisks.length ? { label: 'Начало у конца окна', value: analysis.windowRisks.length, detail: analysis.windowRisks[0]?.name } : null,
  ].filter(Boolean);
  const cards = [
    ['Назначено', counts.assigned, `${analysis.assignmentRate}% активных заявок`],
    ['В очереди', counts.unassigned, 'Требуют решения'],
    [report.hasFact ? 'Выполнено' : 'Бригад в маршруте', report.hasFact ? counts.completed : analysis.activeCrews, report.hasFact ? `${analysis.completionRate}% назначенных` : `из ${report.crews.length}`],
    ['Не выполнено', report.hasFact ? counts.notCompleted : '—', report.hasFact ? 'По отметкам диспетчера' : 'Нет факта'],
    ['Без отметки', report.hasFact ? counts.withoutFact : '—', report.hasFact ? 'Нельзя считать завершёнными' : 'Нет факта'],
    ['Пробег по плану', `${Math.round(report.totalKm)} км`, `${Math.round(report.totalTravelMinutes / 60)} ч в дороге`],
  ];
  const previous = report.comparison;
  const delta = (current, old, unit = '') => { const difference = Math.round((current - old) * 10) / 10; return `${difference > 0 ? '+' : ''}${difference}${unit}`; };
  return <div className="daily-report-dashboard">
    <div className="daily-report-headline"><div><small>{report.hasFact ? 'ФАКТ И ПЛАН' : 'ТОЛЬКО ПЛАН · БЕЗ ФАКТА'}</small><h3>Операционная картина дня</h3><p>Главные отклонения и распределение ресурсов — без перечня каждой смены и каждого визита.</p></div><span>Версия плана {report.revision}</span></div>
    <div className="daily-report-metrics">{cards.map(([label, value, note]) => <div className="daily-report-metric" key={label}><small>{label}</small><strong>{value}</strong><span>{note}</span></div>)}</div>
    <div className="daily-report-main-grid">
      <section className="daily-report-card daily-report-attention"><h4>Требует внимания</h4>{issues.length ? <ul>{issues.map(item => <li key={item.label}><span><b>{item.label}</b><small>{item.detail}</small></span><strong>{item.value}</strong></li>)}</ul> : <p>Критичных отклонений по сохранённым данным нет.</p>}</section>
      <ReportBars title="Начало визитов по часам" items={analysis.byHour.filter(item => item.count).map(item => ({ label: item.hour, value: item.count }))} className="daily-report-hours"/>
      <ReportBars title="Территории с наибольшей нагрузкой" items={report.byZone.slice(0, 5).map(([label, value]) => ({ label, value }))}/>
      <section className="daily-report-card daily-report-resources"><h4>Ресурсы и изменения</h4><dl><div><dt>Бригад в маршруте</dt><dd>{analysis.activeCrews} из {report.crews.length}</dd></div><div><dt>Без маршрута</dt><dd>{analysis.idleCrews}</dd></div><div><dt>Плановая загрузка времени</dt><dd>{analysis.capacityLoad == null ? 'Нет данных' : `${analysis.capacityLoad}%`}</dd></div><div><dt>Отменено заявок</dt><dd>{counts.cancelled}</dd></div><div><dt>Изменений в течение дня</dt><dd>{analysis.eventCounts.reduce((sum, item) => sum + item[1], 0)}</dd></div></dl></section>
    </div>
    <section className="daily-report-comparison"><div><small>СРАВНЕНИЕ</small><h4>{previous ? `С предыдущим сохранённым днём · ${displayDate(previous.date)}` : 'Предыдущего сохранённого дня нет'}</h4></div>{previous ? <div className="daily-report-comparison-metrics"><span>Назначение <b>{delta(analysis.assignmentRate, previous.analysis.assignmentRate, ' п.п.')}</b></span><span>Очередь <b>{delta(counts.unassigned, previous.counts.unassigned)}</b></span>{report.hasFact && previous.hasFact ? <span>Выполнение <b>{delta(analysis.completionRate, previous.analysis.completionRate, ' п.п.')}</b></span> : null}</div> : <p>Сравнение появится после сохранения другой смены в этом регионе.</p>}</section>
    <p className="daily-report-disclaimer">{report.hasFact ? 'Выполнение учитывается только по итоговым отметкам диспетчера. Время и пробег остаются плановыми.' : 'Фактических отметок нет. Отчёт не подтверждает выполнение работ.'}</p>
  </div>;
}

export function ShiftPlaybackBar({ compact = false, shift = null, onSelectOrder, onEditOrder, selectedOrderId }) {
  const clock = useSyncExternalStore(shiftClock.subscribe, shiftClock.getSnapshot);
  const point = shiftDisplayAt(shift, clock.minute);
  const frame = point?.plan ? playbackFrame(point, clock.minute, clock.mode) : null;
  const selectedEngineer = clock.selectedEngineerId ? point?.team?.find(item => String(item.id) === String(clock.selectedEngineerId)) : null;
  const selected = clock.selectedEngineerId ? crewOperationalSummary(point, frame, clock.selectedEngineerId, clock.minute, clock.mode)
    || (selectedEngineer ? { route: { engineerId: selectedEngineer.id, engineerName: selectedEngineer.name, shiftStart: selectedEngineer.shiftStart, shiftEnd: selectedEngineer.shiftEnd, assignments: [] }, crew: null, upcomingOrder: null, phaseMinutes: null } : null) : null;
  const visits = new Map((frame?.visits || []).map(item => [String(item.orderId), item]));
  const selectedTask = selected?.route?.assignments?.find(item => String(item.orderId) === String(selectedOrderId));
  const selectedTaskOrder = selectedTask ? point?.orders?.find(item => String(item.id) === String(selectedTask.orderId)) : null;
  const axisStart = 360, axisSpan = 1020;
  const orderNumber = order => String(order?.sourceId || order?.id || '—').split(/[:-]/).at(-1);
  const seek = minute => shiftClock.set({ minute: Math.max(axisStart, Math.min(1380, minute)), playing: false });
  return <div className={`shift-timeline${compact ? ' engineer-playback-bar' : ''}`}>
    <div className="shift-playback-controls">
      <button type="button" aria-label={clock.playing ? 'Пауза' : 'Воспроизвести'} onClick={() => shiftClock.set({ playing: !clock.playing })}>{clock.playing ? <Pause/> : <Play/>}</button>
      <b>{timeOf(Math.floor(clock.minute))}</b>
      <PlaybackDropdown label="Режим смены" value={clock.mode} options={[{value:'plan',label:'По плану · демонстрация'},{value:'fact',label:'Фактическая смена'}]} onChange={mode => shiftClock.set({ mode })}/>
      <PlaybackDropdown label="Скорость воспроизведения" value={clock.speed} options={[30,60,120,300].map(speed => ({value:speed,label:`×${speed}`}))} onChange={speed => shiftClock.set({ speed:Number(speed) })}/>
      <label className="shift-follow-toggle"><input type="checkbox" checked={clock.follow} onChange={event => shiftClock.set({ follow:event.target.checked })}/><span className="shift-follow-check" aria-hidden="true"><Check size={13}/></span><span>Следить за бригадой</span></label>
    </div>
    {!compact && selected ? <div className="shift-timeline-crew"><strong>{selected.route.engineerName}</strong><span>{!selected.route.assignments?.length ? 'Без маршрута' : clock.mode === 'fact' ? 'По подтверждённым отметкам' : selected.crew?.status === 'travelling' ? `В пути ${selected.phaseMinutes} мин` : selected.crew?.status === 'working' ? `На объекте ${selected.phaseMinutes} мин` : 'По плану'}</span><span>Следующая: {selected.upcomingOrder ? orderNumber(selected.upcomingOrder) : 'нет'}</span><button type="button" onClick={() => shiftClock.set({ selectedEngineerId: '', follow: false })} aria-label="Снять выбор бригады">×</button></div> : null}
    {!compact && selected ? <div className="shift-task-rail" aria-label="Задачи выбранной бригады">
      <button type="button" className="shift-task-boundary" style={{ left: `${Math.max(0, Math.min(100, ((minuteOf(selected.route.shiftStart) ?? axisStart) - axisStart) / axisSpan * 100))}%` }} onClick={() => seek(minuteOf(selected.route.shiftStart) ?? axisStart)} title={`Выход бригады ${selected.route.shiftStart}`} aria-label={`Выход бригады ${selected.route.shiftStart}`}><LogOut size={14}/></button>
      {(selected.route.assignments || []).length ? selected.route.assignments.map(assignment => { const order = point?.orders?.find(item => String(item.id) === String(assignment.orderId)); const visit = visits.get(String(assignment.orderId)); const start = minuteOf(assignment.plannedStart) ?? axisStart; const finish = minuteOf(assignment.plannedFinish) ?? start + 15; const left = Math.max(0, Math.min(99, (start - axisStart) / axisSpan * 100)); const width = Math.max(2.2, Math.min(100 - left, (finish - start) / axisSpan * 100)); return <button type="button" key={assignment.orderId} className={`shift-task-segment status-${visit?.status || 'planned'}${String(selectedOrderId || '') === String(assignment.orderId) ? ' active' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${orderNumber(order)} · ${assignment.plannedStart}–${assignment.plannedFinish} · ${visitStatusLabel(visit?.status, clock.mode)}`} aria-label={`Заявка ${orderNumber(order)}, ${assignment.plannedStart}–${assignment.plannedFinish}, ${visitStatusLabel(visit?.status, clock.mode)}`} onClick={() => { seek(start); shiftClock.set({ follow: false }); onSelectOrder?.(order); }}><span>{orderNumber(order)}</span></button>; }) : <span className="shift-task-empty">Заявки не назначены</span>}
      <button type="button" className="shift-task-boundary finish" style={{ left: `${Math.max(0, Math.min(99, ((minuteOf(selected.route.shiftEnd) ?? 1380) - axisStart) / axisSpan * 100))}%` }} onClick={() => seek(minuteOf(selected.route.shiftEnd) ?? 1380)} title={`Завершение смены ${selected.route.shiftEnd}`} aria-label={`Завершение смены ${selected.route.shiftEnd}`}><Flag size={14}/></button>
    </div> : null}
    {!compact && selectedTask && selectedTaskOrder ? <div className="shift-timeline-task-detail"><b>№ {orderNumber(selectedTaskOrder)}</b><span title={selectedTaskOrder.name || selectedTaskOrder.sourceId}>{selectedTaskOrder.name || selectedTaskOrder.sourceId || 'Заявка'} · {selectedTask.plannedStart}–{selectedTask.plannedFinish}</span><em className={`shift-status status-${visits.get(String(selectedTask.orderId))?.status || 'planned'}`}>{visitStatusLabel(visits.get(String(selectedTask.orderId))?.status,clock.mode)}</em><button type="button" onClick={() => onEditOrder?.(selectedOrderId)}>Изменить</button></div> : null}
    <input type="range" min="360" max="1380" step="1" value={Math.floor(clock.minute)} onChange={event => shiftClock.set({ minute:Number(event.target.value), playing:false })} aria-label="Время смены"/>
    <div className="shift-time-axis">{['06:00','09:00','12:00','15:00','18:00','21:00','23:00'].map(label => <span key={label}>{label}</span>)}</div>
  </div>;
}

export function ShiftWorkspace({
  shift,
  selectedDate,
  initialTab = "crews",
  reportOnly = false,
  assistantOnly = false,
  reportDateControl = null,
  regionId = '',
  onReportDateSelect,
  motionClass = '',
  pendingEvent,
  onClearPending,
  onAddReplacement,
  onOpenManualAdd,
  onOpenIncludeCrew,
  onReturnCrew,
  onApply,
  onRefresh,
  onOpenOrders,
  onTabChange,
  standaloneReplanning = false,
  recalculateRequest = 0,
  onSelectOrder,
  selectedOrderId,
  onClose,
  actor = "Диспетчер",
  profile,
}) {
  const clock = useSyncExternalStore(
    shiftClock.subscribe,
    shiftClock.getSnapshot,
  );
  const [tab, setTab] = useState(initialTab);
  const lastSelectedOrderIdRef = useRef(selectedOrderId);
  const lastSelectedCrewIdRef = useRef(clock.selectedEngineerId);
  useEffect(() => { if (!reportOnly) onTabChange?.(tab); }, [tab, reportOnly, onTabChange]);
  const [eventType, setEventType] = useState(standaloneReplanning ? EVENT_TYPES.RECALCULATE : EVENT_TYPES.ENGINEER_UNAVAILABLE);
  const [targetId, setTargetId] = useState("");
  const [factOrderId, setFactOrderId] = useState("");
  const [factTime, setFactTime] = useState("12:00");
  const [correctionReason, setCorrectionReason] = useState("");
  const [time, setTime] = useState(standaloneReplanning ? '07:00' : '12:00');
  const [recalculateScope, setRecalculateScope] = useState('before');
  const [reason, setReason] = useState(standaloneReplanning ? 'Повторный расчёт плана до начала смены' : '');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restoreTargetId, setRestoreTargetId] = useState("");
  const [factReason, setFactReason] = useState("");
  const [reportUrl, setReportUrl] = useState("");
  const [reportArtifact, setReportArtifact] = useState(null);
  const [reportArchive, setReportArchive] = useState([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [reportData, setReportData] = useState(null);
  const [reportHistory, setReportHistory] = useState([]);
  const [chat, setChat] = useState([]);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiBudget, setAiBudget] = useState(null);
  const [question, setQuestion] = useState("");
  const [orderView, setOrderView] = useState('assigned');
  const [orderQuery, setOrderQuery] = useState('');
  const [orderStateFilter, setOrderStateFilter] = useState('all');
  const [orderWorkFilter, setOrderWorkFilter] = useState([]);
  const [orderTerritoryFilter, setOrderTerritoryFilter] = useState('all');
  const [orderPriorityFilter, setOrderPriorityFilter] = useState('all');
  const [orderEquipmentFilter, setOrderEquipmentFilter] = useState([]);
  const [crewQuery, setCrewQuery] = useState('');
  const [crewLoadFilter, setCrewLoadFilter] = useState('all');
  const [crewSkillFilter, setCrewSkillFilter] = useState([]);
  const [crewEquipmentFilter, setCrewEquipmentFilter] = useState([]);
  const [crewTerritoryFilter, setCrewTerritoryFilter] = useState('all');
  const [crewTransportFilter, setCrewTransportFilter] = useState('all');
  const [crewStatusFilter, setCrewStatusFilter] = useState('all');
  const [eventEngineerId, setEventEngineerId] = useState('');
  const [eventStart, setEventStart] = useState('');
  const [eventEnd, setEventEnd] = useState('');
  const reportSection = assistantOnly ? 'chat' : 'pdf';
  const chatThreadRef = useRef(null);
  const selectedReportRef = useRef(null);
  const shiftTabsRef = useRef(null);
  const [tabIndicator, setTabIndicator] = useState(null);
  useLayoutEffect(() => {
    if (reportOnly || !shiftTabsRef.current) return undefined;
    const nav = shiftTabsRef.current;
    const active = nav.querySelector('button.active');
    if (!active) return undefined;
    const measure = () => {
      const next = {
        x: active.offsetLeft,
        y: active.offsetTop,
        width: active.offsetWidth,
        height: active.offsetHeight,
      };
      setTabIndicator(previous => previous && Object.keys(next).every(key => Math.abs(previous[key] - next[key]) < .5) ? previous : next);
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(nav);
    observer?.observe(active);
    return () => observer?.disconnect();
  }, [tab, reportOnly]);
  useEffect(() => {
    if (reportSection !== 'chat' || !chatThreadRef.current || !chat.length) return;
    chatThreadRef.current.scrollTop = chatThreadRef.current.scrollHeight;
  }, [chat, busy, reportSection]);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useEffect(() => {
    if (!standaloneReplanning || !shift?.plan) return;
    const lastPublished = minuteOf(shift.versions?.at(-1)?.effectiveAt) ?? 0;
    if (lastPublished <= 420 && !(shift.facts || []).some(fact => ['started', 'completed'].includes(fact.status))) return;
    setRecalculateScope('during');
    setTime(timeOf(Math.max(420, lastPublished, Math.floor(shiftClock.getSnapshot().minute))));
    setReason('Перестроение оставшейся части дня');
  }, [standaloneReplanning, shift?.id, shift?.revision]);
  useEffect(() => {
    if (!recalculateRequest) return;
    const lastPublished = minuteOf(shift?.versions?.at(-1)?.effectiveAt) ?? 0;
    const beforeDay = lastPublished <= 420 && !(shift?.facts || []).some(fact => ['started', 'completed'].includes(fact.status));
    setTab('event');
    setEventType(EVENT_TYPES.RECALCULATE);
    setRecalculateScope(beforeDay ? 'before' : 'during');
    setTime(beforeDay ? '07:00' : timeOf(Math.max(420, lastPublished, Math.floor(shiftClock.getSnapshot().minute))));
    setReason(beforeDay ? 'Повторный расчёт плана до начала смены' : 'Перестроение оставшейся части дня');
    setError('');
  }, [recalculateRequest]);
  useEffect(() => {
    if (reportOnly || String(selectedOrderId || '') === String(lastSelectedOrderIdRef.current || '')) return;
    lastSelectedOrderIdRef.current = selectedOrderId;
    if (!selectedOrderId) return;
    const currentPoint = shiftDisplayAt(shift, shiftClock.getSnapshot().minute);
    const inRoute = currentPoint?.plan?.routes?.some(route => route.assignments?.some(item => String(item.orderId) === String(selectedOrderId)));
    setOrderView(inRoute ? 'assigned' : 'unassigned');
    setOrderQuery('');
    setOrderStateFilter('all');
    setOrderWorkFilter([]);
    setOrderTerritoryFilter('all');
    setOrderPriorityFilter('all');
    setOrderEquipmentFilter([]);
    setTab('orders');
  }, [selectedOrderId, reportOnly, shift]);
  useEffect(() => {
    if (reportOnly || String(clock.selectedEngineerId || '') === String(lastSelectedCrewIdRef.current || '')) return;
    lastSelectedCrewIdRef.current = clock.selectedEngineerId;
    if (!clock.selectedEngineerId) return;
    setCrewQuery('');
    setCrewLoadFilter('all');
    setCrewSkillFilter([]);
    setCrewEquipmentFilter([]);
    setCrewTerritoryFilter('all');
    setCrewTransportFilter('all');
    setCrewStatusFilter('all');
    setTab('crews');
  }, [clock.selectedEngineerId, reportOnly]);
  useLayoutEffect(() => {
    if (reportOnly || tab !== 'orders' || !selectedOrderId) return;
    const reveal = () => {
      const list = document.querySelector('.shift-layer:not(.report-layer) .shift-order-list');
      const row = [...(list?.querySelectorAll('.shift-order-row') || [])].find(item => String(item.dataset.orderId) === String(selectedOrderId));
      if (!row) return;
      const bodyRect = list.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (rowRect.top < bodyRect.top + 12 || rowRect.bottom > bodyRect.bottom - 12) {
        list.scrollTo({ top: list.scrollTop + rowRect.top - bodyRect.top - 24, behavior: 'smooth' });
      }
    };
    reveal();
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [reportOnly, tab, selectedOrderId, orderView, orderQuery, orderStateFilter, orderWorkFilter, orderTerritoryFilter, orderPriorityFilter, orderEquipmentFilter]);
  useLayoutEffect(() => {
    if (reportOnly || tab !== 'crews' || !clock.selectedEngineerId) return;
    const reveal = () => {
      const list = document.querySelector('.shift-layer:not(.report-layer) .shift-engineer-list');
      const row = [...(list?.querySelectorAll('.shift-crew-card') || [])].find(item => String(item.dataset.engineerId) === String(clock.selectedEngineerId));
      if (!row) return;
      const listRect = list.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (rowRect.top < listRect.top + 12 || rowRect.bottom > listRect.bottom - 12) {
        list.scrollTo({ top: list.scrollTop + rowRect.top - listRect.top - 20, behavior: 'smooth' });
      }
    };
    reveal();
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [reportOnly, tab, clock.selectedEngineerId, crewQuery, crewLoadFilter, crewSkillFilter, crewEquipmentFilter, crewTerritoryFilter, crewTransportFilter, crewStatusFilter]);
  useEffect(() => {
    if (!pendingEvent) return;
    setEventType(pendingEvent.type);
    setTime(pendingEvent.time || timeOf(Math.floor(shiftClock.getSnapshot().minute)));
    setReason(pendingEvent.reason || "");
    setPreview(null);
  }, [pendingEvent]);
  useEffect(() => {
    if (!shift?.id || pendingEvent) return;
    let live = true;
    const restorePreview = async () => {
      const saved = await json(`/api/shifts/${shift.id}/preview`).catch(() => null);
      if (!live || !saved || saved.baseRevision !== shift.revision || saved.status === 'FAILED') return;
      setEventType(saved.event?.type || EVENT_TYPES.ENGINEER_UNAVAILABLE);
      setTargetId(saved.event?.engineerId || saved.event?.orderId || '');
      setTime(saved.event?.time || '12:00');
      setReason(saved.event?.reason || '');
      setEventEngineerId(saved.event?.engineerId || '');
      setEventStart(saved.event?.start || '');
      setEventEnd(saved.event?.end || '');
      setPreview(saved);
    };
    restorePreview();
    return () => { live = false; };
  }, [shift?.id, shift?.revision, reportOnly]);
  useEffect(() => {
    if (preview?.status !== 'RUNNING' || !preview.id) return undefined;
    let live = true;
    let timer;
    const poll = async () => {
      try {
        const updated = await json(`/api/previews/${preview.id}`);
        if (!live) return;
        if (updated.status === 'FAILED') {
          setPreview(null);
          setError(updated.error || 'Точный расчёт не прошёл проверку.');
          return;
        }
        setPreview(updated);
        if (updated.status === 'RUNNING') timer = setTimeout(poll, 1500);
      } catch (issue) {
        if (live) timer = setTimeout(poll, 3000);
      }
    };
    timer = setTimeout(poll, 1200);
    return () => { live = false; clearTimeout(timer); };
  }, [preview?.id, preview?.status]);
  useEffect(
    () => () => {
      if (reportUrl) URL.revokeObjectURL(reportUrl);
    },
    [reportUrl],
  );
  useEffect(() => {
    setReportUrl("");
    setReportArtifact(null);
    setPreviewOpen(false);
    setReportData(null);
    setChat([]);
  }, [shift?.id, shift?.revision, shift?.factLog?.length]);
  useEffect(() => {
    if (!reportOnly || assistantOnly || !regionId) return;
    let live = true;
    json(`/api/shifts/history?regionId=${encodeURIComponent(regionId)}&throughDate=9999-12-31`).then(items => { if (live) setReportHistory(items); }).catch(() => { if (live) setReportHistory([]); });
    json(`/api/shifts/report-archive?regionId=${encodeURIComponent(regionId)}&throughDate=9999-12-31`).then(items => { if (live) setReportArchive(items); }).catch(() => { if (live) setReportArchive([]); });
    return () => { live = false; };
  }, [reportOnly, assistantOnly, regionId, selectedDate, shift?.revision]);
  useEffect(() => {
    if (!shift?.id || tab !== 'report') return;
    let live = true;
    json(`/api/shifts/${shift.id}/report-data`).then(data => { if (live) setReportData(data); }).catch(issue => { if (live) setError(issue.message); });
    return () => { live = false; };
  }, [shift?.id, shift?.revision, shift?.factLog?.length, tab]);
  useEffect(() => {
    if (!shift?.id || tab !== 'report') return;
    let live = true;
    json(`/api/shifts/${shift.id}/ai/status`).then(status => { if (live) { setAiConfigured(Boolean(status.configured)); setAiBudget(status.budget || null); } }).catch(() => { if (live) { setAiConfigured(false); setAiBudget(null); } });
    return () => { live = false; };
  }, [shift?.id, tab]);
  const point = shiftDisplayAt(shift, clock.minute);
  const aiAvailable = aiConfigured && (!aiBudget || aiBudget.limit - aiBudget.used_tokens - aiBudget.reserved_tokens >= 6000);
  const frame = useMemo(
    () => playbackFrame(point, clock.minute, clock.mode),
    [point, clock.minute, clock.mode],
  );
  const current = metric(shift?.plan);
  const lastPublicationMinute = minuteOf(shift?.versions?.at(-1)?.effectiveAt) ?? 0;
  const beforeReplanningAvailable = lastPublicationMinute <= 420 && !(shift?.facts || []).some(fact => ['started', 'completed'].includes(fact.status));
  // A restored plan is a new publication, not a one-minute movement of the
  // playback clock. Keep it after the latest publication and recorded fact.
  const restoreEffectiveTime = timeOf(Math.min(1439, Math.max(
    minuteOf(shift?.versions?.at(-1)?.effectiveAt) ?? 0,
    ...((shift?.factLog || []).map(fact => Math.min(1439, (minuteOf(fact.time) ?? 0) + 1))),
  )));
  const next = metric(preview?.result?.plan);
  const change = useMemo(() => planChange(shift?.plan, preview?.result?.plan, preview?.result?.orders || shift?.orders), [shift?.plan, shift?.orders, preview?.result]);
  const assigned = useMemo(
    () =>
      new Set(
        (shift?.plan?.routes || []).flatMap((route) =>
          (route.assignments || []).map((item) => String(item.orderId)),
        ),
      ),
    [shift],
  );
  const selectableOrders = (shift?.orders || []).filter((order) =>
    assigned.has(String(order.id)),
  );
  const eventOrders = [EVENT_TYPES.ORDER_CANCELLED, EVENT_TYPES.CLIENT_WINDOW_SHIFT, EVENT_TYPES.MANUAL_ASSIGN].includes(eventType) ? (shift?.orders || []) : selectableOrders;
  const assignedRouteByOrder = useMemo(() => new Map((point?.plan?.routes || []).flatMap(route => (route.assignments || []).map(assignment => [String(assignment.orderId), route]))), [point?.plan]);
  const visitByOrder = new Map(frame.orderStatuses.map(item => [String(item.orderId), item]));
  const factStatusByOrder = useMemo(() => {
    const statuses = new Map();
    for (const fact of shift?.factLog || shift?.facts || []) {
      if ((minuteOf(fact.time) ?? 1440) <= clock.minute) statuses.set(String(fact.orderId), fact.status);
    }
    return statuses;
  }, [shift?.factLog, shift?.facts, clock.minute]);
  const visitStatusFor = orderId => factStatusByOrder.get(String(orderId)) || visitByOrder.get(String(orderId))?.status || 'unassigned';
  const orderWorkOptions = [...new Set((point?.orders || []).flatMap(order => orderWorkValues(order)))].sort((a,b)=>filterLabel(a).localeCompare(filterLabel(b),'ru'));
  const orderTerritoryOptions = [...new Set((point?.orders || []).map(order => String(order.zone || order.district || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  const orderPriorityOptions = [...new Set((point?.orders || []).map(order => String(order.priority || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  const orderEquipmentOptions = [...new Set((point?.orders || []).flatMap(order => filterTokens(order.equipment)))].sort((a,b)=>a.localeCompare(b,'ru'));
  const crewSkillOptions = [...new Set((point?.team || []).flatMap(engineer => filterTokens(engineer.skills)))].sort((a,b)=>a.localeCompare(b,'ru'));
  const crewEquipmentOptions = [...new Set((point?.team || []).flatMap(engineer => filterTokens(engineer.equipment)))].sort((a,b)=>a.localeCompare(b,'ru'));
  const crewTerritoryOptions = [...new Set((point?.team || []).flatMap(engineer => [engineer.zone,engineer.district,engineer.regionName].map(value => String(value || '').trim()).filter(Boolean)))].sort((a,b)=>a.localeCompare(b,'ru'));
  const crewTransportOptions = [...new Set((point?.team || []).map(engineer => String(engineer.transport || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  const crewStatusOptions = [...new Set((point?.team || []).map(engineer => String(engineer.status || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'));
  const crewAdvanced = { skill: crewSkillFilter, equipment: crewEquipmentFilter, location: crewTerritoryFilter === 'all' ? '' : crewTerritoryFilter, transport: crewTransportFilter === 'all' ? '' : crewTransportFilter, status: crewStatusFilter === 'all' ? '' : crewStatusFilter };
  const updateCrewAdvanced = update => {
    const next = typeof update === 'function' ? update(crewAdvanced) : update;
    setCrewSkillFilter(next.skill);
    setCrewEquipmentFilter(next.equipment);
    setCrewTerritoryFilter(next.location || 'all');
    setCrewTransportFilter(next.transport || 'all');
    setCrewStatusFilter(next.status || 'all');
  };
  const crewSections = [
    ['skill', 'Навыки', [['', 'Все навыки'], ...crewSkillOptions.map(value => [value, filterLabel(value)])]],
    ['equipment', 'Оборудование', [['', 'Любое оборудование'], ...crewEquipmentOptions.map(value => [value, filterLabel(value)])]],
    ['location', 'Локация', [['', 'Все локации'], ...crewTerritoryOptions.map(value => [value, value])]],
    ['transport', 'Транспорт', [['', 'Любой транспорт'], ...crewTransportOptions.map(value => [value, filterLabel(value)])]],
    ['status', 'Доступность', [['', 'Любая доступность'], ...crewStatusOptions.map(value => [value, filterLabel(value)])]],
  ];
  const orderAdvanced = { skill: orderWorkFilter, equipment: orderEquipmentFilter, priority: orderPriorityFilter === 'all' ? '' : orderPriorityFilter, status: orderStateFilter === 'all' ? '' : orderStateFilter, location: orderTerritoryFilter === 'all' ? '' : orderTerritoryFilter };
  const hasOrderAdvanced = orderWorkFilter.length || orderEquipmentFilter.length || orderPriorityFilter !== 'all' || orderStateFilter !== 'all' || orderTerritoryFilter !== 'all';
  const clearOrderAdvanced = () => { setOrderWorkFilter([]); setOrderEquipmentFilter([]); setOrderPriorityFilter('all'); setOrderStateFilter('all'); setOrderTerritoryFilter('all'); };
  const updateOrderAdvanced = update => {
    const next = typeof update === 'function' ? update(orderAdvanced) : update;
    setOrderWorkFilter(next.skill);
    setOrderEquipmentFilter(next.equipment);
    setOrderPriorityFilter(next.priority || 'all');
    setOrderStateFilter(next.status || 'all');
    setOrderTerritoryFilter(next.location || 'all');
  };
  const orderSections = [
    ['skill', 'Вид работ', [['', 'Все виды работ'], ...orderWorkOptions.map(value => [value, filterLabel(value)])]],
    ['equipment', 'Оборудование', [['', 'Любое оборудование'], ...orderEquipmentOptions.map(value => [value, filterLabel(value)])]],
    ['priority', 'Приоритет', [['', 'Любой приоритет'], ...orderPriorityOptions.map(value => [value, filterLabel(value)])]],
    ['status', 'Статус визита', [['', 'Все статусы'], ['planned', 'Ожидается'], ['travelling', 'Бригада в пути'], ['waiting', 'Ожидает начала'], ['working', 'На объекте'], ['simulated_completed', 'По плану завершена'], ['started', 'Начата'], ['completed', 'Выполнена'], ['not_completed', 'Не выполнена'], ['no_fact', 'Нет отметки'], ['unassigned', 'В очереди']]],
    ['location', 'Территория', [['', 'Все территории'], ...orderTerritoryOptions.map(value => [value, value])]],
  ];
  const shiftOrders = (point?.orders || []).filter(order => {
    const assigned = assignedRouteByOrder.has(String(order.id));
    const matchesQuery = matchesSearch(orderQuery, orderSearchValues(order));
    const status = visitStatusFor(order.id);
    return (orderView === 'assigned' ? assigned : !assigned) && matchesQuery && (orderStateFilter === 'all' || status === orderStateFilter) && matchesAnySelection(orderWorkFilter, orderWorkValues(order)) && (orderTerritoryFilter === 'all' || String(order.zone || order.district || '').trim() === orderTerritoryFilter) && (orderPriorityFilter === 'all' || order.priority === orderPriorityFilter) && matchesAnySelection(orderEquipmentFilter, filterTokens(order.equipment));
  });
  const visibleCrews = (point?.team || []).filter(engineer => {
    const route = point?.plan?.routes?.find(item => String(item.engineerId) === String(engineer.id));
    const skills=filterTokens(engineer.skills),equipment=filterTokens(engineer.equipment),territories=[engineer.zone,engineer.district,engineer.regionName].map(value=>String(value||'').trim());
    return matchesSearch(crewQuery, [engineer.name, engineer.sourceId, engineer.startAddress, engineer.status, engineer.transport, skills, equipment, territories]) && (crewLoadFilter === 'all' || (crewLoadFilter === 'idle' ? !route?.assignments?.length : route?.assignments?.length > 0 && route.assignments.length <= 3)) && matchesAnySelection(crewSkillFilter, skills) && matchesAnySelection(crewEquipmentFilter, equipment) && (crewTerritoryFilter === 'all' || territories.includes(crewTerritoryFilter)) && (crewTransportFilter === 'all' || engineer.transport === crewTransportFilter) && (crewStatusFilter === 'all' || engineer.status === crewStatusFilter);
  });
  const selectedFact = (shift?.facts || []).find(item => String(item.orderId) === String(factOrderId));
  const eventOptions = (pendingEvent || eventType) && !DIRECT_EVENTS.includes(pendingEvent?.type || eventType) ? [...DIRECT_EVENTS, pendingEvent?.type || eventType] : DIRECT_EVENTS;
  const restoredManualAddition = !pendingEvent && [EVENT_TYPES.NEW_ORDER, EVENT_TYPES.CAPACITY_ADDED, EVENT_TYPES.ENGINEER_REPLACED].includes(preview?.event?.type) ? preview.event : null;
  const buildEvent = () => {
    const base = {
      type: pendingEvent?.type || eventType,
      time,
      reason: reason.trim(),
    };
    if (eventType === EVENT_TYPES.RECALCULATE && !pendingEvent) {
      base.time = recalculateScope === 'before' ? '07:00' : time;
      base.reason = reason.trim() || (recalculateScope === 'before' ? 'Повторный расчёт плана до начала смены' : 'Перестроение оставшейся части дня');
    }
    if (pendingEvent) return { ...pendingEvent, ...base };
    if (
      eventType === EVENT_TYPES.ENGINEER_UNAVAILABLE ||
      eventType === EVENT_TYPES.ENGINEER_REPLACED
    )
      base.engineerId = targetId;
    if (
      eventType === EVENT_TYPES.ORDER_CANCELLED ||
      eventType === EVENT_TYPES.VISIT_CANCELLED ||
      eventType === EVENT_TYPES.MANUAL_ASSIGN ||
      eventType === EVENT_TYPES.CLIENT_WINDOW_SHIFT
    )
      base.orderId = targetId;
    if (eventType === EVENT_TYPES.MANUAL_ASSIGN) base.engineerId = eventEngineerId;
    if (eventType === EVENT_TYPES.CLIENT_WINDOW_SHIFT) { base.start = eventStart; base.end = eventEnd; }
    return base;
  };
  const discardDraft = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = preview?.id ? preview : await json(`/api/shifts/${shift.id}/preview`).catch(error => {
        if (/Черновик не найден/.test(error.message)) return null;
        throw error;
      });
      if (saved?.baseRevision === shift.revision) {
        await json(`/api/shifts/${shift.id}/preview`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ previewId: saved.id, expectedRevision: shift.revision }),
        });
      }
      setPreview(null);
      onClearPending?.();
      setEventType(EVENT_TYPES.ENGINEER_UNAVAILABLE);
      setTargetId('');
      setEventEngineerId('');
      setEventStart('');
      setEventEnd('');
      setTime(timeOf(Math.floor(shiftClock.getSnapshot().minute)));
      setReason('');
    } catch (issue) {
      setError(issue.message || 'Не удалось отменить черновик.');
    } finally {
      setBusy(false);
    }
  };
  const editOrder = (orderId, type = EVENT_TYPES.CLIENT_WINDOW_SHIFT) => {
    if (preview) { setTab('event'); setError('Сначала опубликуйте или отмените сохранённый черновик.'); return; }
    const order = (point?.orders || shift?.orders || []).find(item => String(item.id) === String(orderId));
    if (!order) return;
    setTab('event'); setEventType(type); setTargetId(String(order.id));
    setEventStart(order.start || ''); setEventEnd(order.end || '');
    setEventEngineerId(''); setTime(timeOf(Math.max(Math.floor(clock.minute), minuteOf(shift?.versions?.at(-1)?.effectiveAt) || 0)));
    setReason(({ [EVENT_TYPES.CLIENT_WINDOW_SHIFT]: 'Изменение окна клиента', [EVENT_TYPES.MANUAL_ASSIGN]: 'Переназначение заявки', [EVENT_TYPES.VISIT_CANCELLED]: 'Отмена визита', [EVENT_TYPES.ORDER_CANCELLED]: 'Отмена заявки' })[type] || 'Изменение плана'); setPreview(null); setError('');
  };
  const calculate = async () => {
    if (!shift?.plan) {
      setError("Сначала постройте исходный план.");
      return;
    }
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const task = await post(`/api/shifts/${shift.id}/preview`, {
        expectedRevision: shift.revision,
        event: buildEvent(),
      });
      setPreview(task);
    } catch (issue) {
      setError(issue.message);
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      const publishedEvent = preview.event;
      const result = await post(`/api/shifts/${shift.id}/publish`, {
        previewId: preview.id,
        expectedRevision: shift.revision,
        actor,
      });
      onApply(result);
      setPreview(null);
      setReason("");
      setTargetId("");
      onClearPending?.();
      const addedEngineerId = publishedEvent?.engineer?.id || publishedEvent?.replacement?.id;
      if (addedEngineerId) {
        setCrewQuery('');
        setCrewLoadFilter('all');
        setCrewSkillFilter([]);
        setCrewEquipmentFilter([]);
        setCrewTerritoryFilter('all');
        setCrewTransportFilter('all');
        setCrewStatusFilter('all');
        shiftClock.set({ selectedEngineerId: String(addedEngineerId), follow: false, focusToken: Date.now() });
        setTab('crews');
      } else if (publishedEvent?.type === EVENT_TYPES.NEW_ORDER) {
        setOrderQuery('');
        const addedOrderId = String(publishedEvent.order?.id || '');
        const hasRoute = result.plan?.routes?.some(route => route.assignments?.some(assignment => String(assignment.orderId) === addedOrderId));
        setOrderView(hasRoute ? 'assigned' : 'unassigned');
        setOrderStateFilter('all');
        setOrderWorkFilter([]);
        setOrderTerritoryFilter('all');
        setOrderPriorityFilter('all');
        setOrderEquipmentFilter([]);
        const addedOrder = result.orders?.find(order => String(order.id) === addedOrderId);
        if (addedOrder) onSelectOrder?.(addedOrder);
        setTab('orders');
      } else {
        setTab('events');
      }
    } catch (issue) {
      setError(issue.message);
    } finally {
      setBusy(false);
    }
  };
  const markFact = async (status) => {
    const orderId = factOrderId;
    if (!orderId) {
      setError("Сначала выберите заявку.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onApply(
        await post(`/api/shifts/${shift.id}/facts`, {
          orderId,
          status,
          time: factTime,
          reason: factReason,
          correctionReason: correctionReason.trim() || undefined,
          actor,
        }),
      );
      setFactReason("");
      setCorrectionReason("");
    } catch (issue) {
      setError(issue.message);
    } finally {
      setBusy(false);
    }
  };
  const makeReport = async () => {
    setBusy(true);
    setError("");
    try {
      const artifact = await post(`/api/shifts/${shift.id}/report`, { author: actor });
      const response = await fetch(artifact.url);
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => ({}))).error ||
            "Не удалось сформировать PDF.",
        );
      if (reportUrl) URL.revokeObjectURL(reportUrl);
      setReportUrl(URL.createObjectURL(await response.blob()));
      setReportArtifact(artifact);
      setPreviewOpen(false);
      setReportData(await json(`/api/shifts/${shift.id}/report-data`));
      if (regionId) setReportArchive(await json(`/api/shifts/report-archive?regionId=${encodeURIComponent(regionId)}&throughDate=9999-12-31`));
    } catch (issue) {
      setError(issue.message);
    } finally {
      setBusy(false);
    }
  };
  const openSavedReport = async item => {
    setError('');
    try {
      const response = await fetch(`/api/shifts/${item.shiftId}/report?artifactId=${encodeURIComponent(item.id)}`);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Не удалось открыть сохранённый PDF.');
      if (reportUrl) URL.revokeObjectURL(reportUrl);
      setReportUrl(URL.createObjectURL(await response.blob()));
      setReportArtifact(item);
      setPreviewOpen(true);
    } catch (issue) { setError(issue.message); }
  };
  useEffect(() => {
    if (reportArtifact && reportUrl) selectedReportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [reportArtifact, reportUrl]);
  const downloadHistoricReport = async item => {
    setError('');
    try {
      const response = await fetch(`/api/shifts/${item.id}/report`);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Не удалось скачать отчёт.');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `beego-shift-${item.date}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (issue) { setError(issue.message); }
  };
  const askAi = async (customQuestion) => {
    customQuestion = typeof customQuestion === "string" ? customQuestion : "";
    if (busy) return;
    const prompt = customQuestion || 'Ключевые выводы по смене';
    const history = chat.slice(-6).map(({ role, text }) => ({ role, text }));
    setChat(current => [...current, { role: 'user', text: prompt }].slice(-12));
    setBusy(true);
    setError("");
    try {
      const result = await post(
        `/api/shifts/${shift.id}/ai/${customQuestion ? "question" : "summary"}`,
        customQuestion ? { question: customQuestion, history } : {},
      );
      setChat(current => [...current, { role: 'assistant', text: result.text }].slice(-12));
      setQuestion('');
    } catch (issue) {
      setChat(current => current.filter((message, index) => index !== current.length - 1 || message.role !== 'user' || message.text !== prompt));
      setError(issue.message);
    } finally {
      json(`/api/shifts/${shift.id}/ai/status`).then(status => setAiBudget(status.budget || null)).catch(() => {});
      setBusy(false);
    }
  };
  const restore = async (targetPlanId) => {
    const target = shift?.versions?.find(version => version.id === targetPlanId);
    if (!target || target.id === shift.currentPlanId) return;
    setBusy(true);
    setError("");
    try {
      onApply(
        await post(`/api/shifts/${shift.id}/rollback`, {
          targetPlanId: target.id,
          expectedRevision: shift.revision,
          actor,
          time: restoreEffectiveTime,
        }),
      );
      setRestoreTargetId("");
    } catch (issue) {
      setError(issue.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`shift-layer${reportOnly ? ' report-layer' : ''}${assistantOnly ? ' assistant-layer' : ''} ${motionClass}`}>
      <aside className={`shift-panel${!reportOnly && (tab === 'crews' || tab === 'orders') ? ' shift-list-panel' : ''}`}>
        <header>
          {!assistantOnly ? <small>{reportOnly ? 'ИТОГИ СМЕНЫ' : 'ОПЕРАТИВНОЕ УПРАВЛЕНИЕ'}</small> : null}
          <h2>{assistantOnly ? 'AI‑помощник' : reportOnly ? 'Отчёт PDF' : standaloneReplanning ? 'Перепланирование' : 'Ход смены'}</h2>
          <span>
            {displayDate(shift?.date || selectedDate)}
          </span>
          {assistantOnly ? <button type="button" className="assistant-close" onClick={onClose} aria-label="Закрыть AI‑помощника"><X size={20}/></button> : null}
        </header>
        {!reportOnly ? <nav ref={shiftTabsRef} className="shift-tabs" aria-label="Разделы смены">
          {tabIndicator ? <span className="shift-tab-indicator" aria-hidden="true" style={{ width: tabIndicator.width, height: tabIndicator.height, transform: `translate3d(${tabIndicator.x}px, ${tabIndicator.y}px, 0)` }} /> : null}
          {[
            ["crews", "Бригады"],
            ["orders", "Заявки"],
            ["event", "Изменить план"],
            ["fact", "Факт визита"],
            ["events", "Журнал"],
          ].map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
                setError("");
              }}
            >
              {label}
            </button>
          ))}
        </nav> : null}
        <div className="shift-panel-body">
          {shift?.plan &&
          tab === "event" &&
          !pendingEvent &&
          eventType === EVENT_TYPES.ENGINEER_REPLACED ? (
            <div className="shift-replacement-picker">
              <label>
                Кого заменить
                <BusinessSelect ariaLabel="Кого заменить" value={targetId} onChange={setTargetId} searchable options={[{value:'',label:'Выберите бригаду…'},...shift.team.map(item=>({value:String(item.id),label:item.name||String(item.id)}))]}/>
              </label>
              <button
                type="button"
                onClick={() =>
                  targetId
                    ? onAddReplacement?.(targetId)
                    : setError("Сначала выберите исходную бригаду.")
                }
              >
                Создать заменяющую бригаду
              </button>
            </div>
          ) : null}
          {!shift?.plan && !reportOnly ? (
            <div className="shift-empty">
              <img src="/mascot-empty-routes.png" alt="" />
              <small>ХОД СМЕНЫ</small>
              <b>Здесь оживёт ваш рабочий день</b>
              <p>Загрузите заявки и бригады, затем постройте план. После этого на карте можно будет проиграть маршруты, отметить фактические визиты и перепланировать смену.</p>
              <div className="shift-empty-steps"><span>1. Данные</span><span>2. План</span><span>3. Проигрывание</span></div>
              <div className="shift-empty-actions"><button type="button" onClick={onOpenOrders}>Открыть заявки</button><button type="button" onClick={onRefresh}>Обновить смену</button></div>
            </div>
          ) : null}
          {shift?.plan && tab === "crews" ? (
            <section className="shift-operational-list shift-crews-list" aria-label="Бригады смены">
              <div className="shift-operational-toolbar">
                <div className="shift-list-actions"><div className="shift-load-filters" role="group" aria-label="Фильтр загрузки бригад"><button type="button" className={crewLoadFilter==='all'?'selected':''} onClick={()=>setCrewLoadFilter('all')}>Все <b>{point?.team?.length || 0}</b></button><button type="button" className={crewLoadFilter==='idle'?'selected':''} onClick={()=>setCrewLoadFilter('idle')}>Без маршрута</button><button type="button" className={crewLoadFilter==='light'?'selected':''} onClick={()=>setCrewLoadFilter('light')}>1–3 заявки</button></div><button type="button" className="manual-add-trigger shift-manual-add" onClick={onOpenIncludeCrew} aria-label="Включить инженера из состава в смену" title="Включить бригаду в смену"><Plus aria-hidden="true"/></button></div>
                <div className="shift-search-row panel-search-row"><label className="panel-search"><Search size={17} aria-hidden="true"/><input type="search" value={crewQuery} onChange={event => setCrewQuery(event.target.value)} placeholder="Имя, навык, оборудование…" aria-label="Поиск бригад"/>{crewQuery?<button type="button" onClick={()=>setCrewQuery('')} aria-label="Очистить поиск"><X size={15}/></button>:null}</label><WorkspaceFilters title="Отобрать инженеров" sections={crewSections} value={crewAdvanced} onChange={updateCrewAdvanced} multiKeys={['skill','equipment']}/></div>
              </div>
              {(pendingEvent?.engineer || pendingEvent?.replacement) ? <div className="shift-manual-draft"><b>{pendingEvent.engineer?.name || pendingEvent.replacement?.name}</b><span>В составе · ещё не в опубликованном плане смены</span><button type="button" onClick={()=>setTab('event')}>Рассчитать и опубликовать</button></div> : null}
              <div className="engineer-list shift-engineer-list">
              {visibleCrews.map((engineer) => {
                  const route = point?.plan?.routes?.find(item => String(item.engineerId) === String(engineer.id)) || { engineerId: engineer.id, engineerName: engineer.name, assignments: [], shiftStart: engineer.shiftStart, shiftEnd: engineer.shiftEnd, distanceKm: 0 };
                  const crew = frame.crews.find(
                    (item) =>
                      String(item.engineerId) === String(route.engineerId),
                  );
                  const active=String(clock.selectedEngineerId)===String(route.engineerId);
                  const unavailable=crew?.status === 'unavailable' || crew?.status === 'off_shift' || /(недоступ|снят со смены|отпуск|выходн|боле|отсутств|заверш|unavailable|leave)/i.test(engineer.status||'');
                  const statusLabel=unavailable ? (crew?.status === 'off_shift' && clock.minute >= (minuteOf(route.shiftEnd) ?? 1440) ? 'Смена завершена' : crew?.status === 'off_shift' ? 'Ещё не на смене' : 'Недоступна') : clock.mode === 'fact' ? (crew?.status === 'completed' ? 'Есть завершение' : crew?.status === 'started' ? 'Есть начало' : crew?.status === 'not_completed' ? 'Не выполнено' : 'Нет отметок') : ({travelling:'В пути',working:'На объекте',waiting:'Ожидание'})[crew?.status] || 'Свободна';
                  const phase=unavailable ? 'unavailable' : crew?.status === 'travelling' ? 'travelling' : crew?.status === 'working' ? 'working' : crew?.status === 'waiting' ? 'waiting' : 'idle';
                  return (
                    <article className={`shift-crew-card ${active?'active':''} ${unavailable?'is-unavailable':''}`} data-engineer-id={route.engineerId} key={route.engineerId}>
                    <button
                      type="button"
                      className={`shift-crew engineer-list-row ${active ? "active selected" : ""}`}
                      aria-pressed={active}
                      onClick={() => {
                        onSelectOrder?.(null);
                        if(active){shiftClock.set({selectedEngineerId:'',follow:false});return}
                        shiftClock.set({
                          selectedEngineerId: String(route.engineerId),
                          follow: false,
                          focusToken: Date.now(),
                        });
                      }}
                    >
                      <span className="person-avatar">{(route.engineerName||engineer.name||'Бригада').split(' ').map(part=>part[0]).join('').slice(0,2)}</span>
                      <span className="engineer-list-main"><b>{route.engineerName||engineer.name}</b><span className="engineer-list-skills">{engineer.skills?.length?engineer.skills.map(skill=><small key={skill}>{filterLabel(skill)}</small>):<small>Навыки не указаны</small>}</span><span className="engineer-list-transport"><ShiftTransportIcon type={engineer.transport}/>{engineer.transport?filterLabel(engineer.transport):'Транспорт не указан'}</span><span className="engineer-list-load">{route.assignments.length ? `${route.assignments.length} заявок · ${Number(route.distanceKm||0).toFixed(1)} км` : 'Без маршрута'}</span></span>
                      <span className="engineer-list-shift"><b>{route.shiftStart||'—'}–{route.shiftEnd||'—'}</b><small className={`shift-crew-stage stage-${phase}`}>{statusLabel}</small></span>
                      <ChevronRight className="engineer-list-open"/>
                    </button>
                    {active && (engineer.unavailableFrom || /недоступ|снят со смены|unavailable/i.test(engineer.status||'')) ? <div className="shift-crew-management"><span>Возвращение в эту смену потребует проверки и новой версии плана.</span><button type="button" disabled={Boolean(pendingEvent)} onClick={()=>Promise.resolve(onReturnCrew?.(engineer,timeOf(Math.max(Math.floor(clock.minute),minuteOf(shift?.versions?.at(-1)?.effectiveAt)||0)))).catch(issue=>setError(issue.message||'Не удалось вернуть бригаду.'))}>Вернуть в смену</button></div> : active && !/(отпуск|выходн|боле|отсутств|leave)/i.test(engineer.status||'') ? <div className="shift-crew-management"><span>Снятие с текущей смены не удалит инженера из постоянного состава и не изменит прошлые визиты.</span><button type="button" disabled={Boolean(pendingEvent)} onClick={()=>{setEventType(EVENT_TYPES.ENGINEER_UNAVAILABLE);setTargetId(String(engineer.id));setTime(timeOf(Math.max(Math.floor(clock.minute),minuteOf(shift?.versions?.at(-1)?.effectiveAt)||0)));setReason(`Снятие бригады со смены: ${engineer.name}`);setPreview(null);setTab('event')}}>Снять со смены</button></div> : null}
                    </article>
                  );
                })}
              {!visibleCrews.length ? <p className="shift-muted">По выбранным фильтрам бригад нет.</p> : null}
              </div>
            </section>
          ) : null}
          {shift?.plan && tab === "orders" ? <section className="shift-orders-readonly" aria-label="Заявки смены">
            <div className="shift-list-actions shift-order-switch"><div className="status-tabs" role="group" aria-label="Статус заявок"><button type="button" className={orderView==='assigned'?'selected':''} onClick={()=>setOrderView('assigned')}>Назначены <b>{current.assigned}</b></button><button type="button" className={orderView==='unassigned'?'selected':''} onClick={()=>setOrderView('unassigned')}>Не назначены <b>{current.unassigned}</b></button></div><button type="button" className="manual-add-trigger shift-manual-add" onClick={()=>onOpenManualAdd?.('orders')} aria-label="Добавить заявку вручную" title="Добавить заявку вручную"><Plus aria-hidden="true"/></button></div>
            <div className="shift-search-row panel-search-row"><label className="panel-search"><Search size={17} aria-hidden="true"/><input type="search" value={orderQuery} onChange={event => { setOrderQuery(event.target.value); if (event.target.value.trim()) clearOrderAdvanced(); }} placeholder="Номер, тип работ или адрес…" aria-label="Поиск заявок"/>{orderQuery?<button type="button" onClick={()=>setOrderQuery('')} aria-label="Очистить поиск"><X size={15}/></button>:null}</label><WorkspaceFilters title="Отобрать заявки" sections={orderSections} value={orderAdvanced} onChange={updateOrderAdvanced} multiKeys={['skill','equipment']}/></div>
            {orderQuery || hasOrderAdvanced ? <div className="shift-filter-summary"><span>Показано {shiftOrders.length} из {orderView === 'assigned' ? current.assigned : current.unassigned}</span>{hasOrderAdvanced ? <button type="button" onClick={clearOrderAdvanced}>Сбросить фильтры</button> : null}</div> : null}
            {pendingEvent?.order ? <div className="shift-manual-draft"><b>{pendingEvent.order.name}</b><span>Черновик заявки · ещё не в опубликованном плане</span><button type="button" onClick={()=>setTab('event')}>Рассчитать и опубликовать</button></div> : null}
            <div className="shift-order-list order-list"><div className="table-head"><span>ЗАЯВКА</span><span>ОКНО</span></div>
            {shiftOrders.length ? shiftOrders.map(order => {
              const route = assignedRouteByOrder.get(String(order.id));
              const assignment = route?.assignments?.find(item => String(item.orderId) === String(order.id));
              const status = visitStatusFor(order.id);
              const active = String(selectedOrderId || '') === String(order.id);
              return <article className={`shift-order-card status-${status}${active ? ' active' : ''}`} data-visit-status={status} key={order.id}>
                <button type="button" data-order-id={order.id} className={`shift-order-row ${active ? 'active' : ''}`} aria-pressed={active} onClick={() => { shiftClock.set({ follow: false }); onSelectOrder?.(active ? null : order); }}>
                  <span className="check-dot" aria-hidden="true"/>
                  <span className="order-main"><b>{order.name || order.sourceId || order.id}</b><small>{order.address || 'Адрес не указан'}</small><em className={`shift-status status-${status}`}>{visitStatusLabel(status, clock.mode)}</em></span>
                  <span className="order-window">{order.start ? `${order.start}–${order.end}` : 'Гибкое'}</span><ChevronRight size={17} aria-hidden="true"/>
                </button>
                {active ? <div className="shift-order-actions"><div className="shift-order-meta"><span>{order.workType || order.skill || 'Вид работ не указан'}</span><span>{route ? `${route.engineerName || 'Бригада'} · ${assignment?.plannedStart || 'в плане'}` : 'Не назначена · требуется решение диспетчера'}</span></div><div className="shift-order-action-buttons"><button type="button" onClick={() => editOrder(order.id, EVENT_TYPES.CLIENT_WINDOW_SHIFT)}>Перенести время</button><button type="button" onClick={() => editOrder(order.id, EVENT_TYPES.MANUAL_ASSIGN)}>{route ? 'Сменить бригаду' : 'Назначить бригаду'}</button>{route ? <button type="button" onClick={() => editOrder(order.id, EVENT_TYPES.VISIT_CANCELLED)}>Отменить визит</button> : null}<button type="button" onClick={() => editOrder(order.id, EVENT_TYPES.ORDER_CANCELLED)}>Отменить заявку</button>{route ? <button type="button" onClick={() => { setFactOrderId(String(order.id)); setFactTime(timeOf(Math.floor(clock.minute))); setTab('fact'); }}>Факт визита</button> : null}</div></div> : null}
              </article>;
            }) : <p className="shift-muted">Заявок в этой группе нет.</p>}
            </div>
          </section>:null}
          {shift?.plan && tab === "events" ? (
            <div className="shift-journal">
              <div className="shift-section-title"><b>История планов</b></div>
              <p className="shift-journal-intro">Выберите сохранённый план для восстановления. Откат создаст новую версию; история и фактические отметки останутся.</p>
              <div className="shift-plan-history">
                {[...(shift.versions || [])].reverse().map(version => {
                  const isCurrent = version.id === shift.currentPlanId;
                  const source = shift.events?.find(event => event.afterPlanId === version.id);
                  const confirming = restoreTargetId === version.id;
                  return <article className={`shift-plan-version${isCurrent ? ' is-current' : ''}`} key={version.id}>
                    <div className="shift-plan-version-head"><strong>План v{version.version}</strong>{isCurrent ? <span>Текущий</span> : null}</div>
                    <p>{source?.reason || (version.version === 1 ? 'Первый сохранённый план смены' : 'Сохранённая версия плана')}</p>
                    <small>Действует с {version.effectiveAt || '00:00'}</small>
                    {!isCurrent && !confirming ? <button type="button" className="shift-plan-restore" onClick={() => { setRestoreTargetId(version.id); setError(''); }} disabled={busy}><RotateCcw size={15}/> Восстановить план v{version.version}</button> : null}
                    {confirming ? <div className="shift-plan-confirm"><p>Восстановить план v{version.version} вместо текущего? Изменение сохранится как новая версия.</p><div><button type="button" className="shift-primary" onClick={() => restore(version.id)} disabled={busy}>{busy ? 'Восстанавливаем…' : 'Подтвердить откат'}</button><button type="button" onClick={() => { setRestoreTargetId(''); setError(''); }} disabled={busy}>Отмена</button></div>{error ? <p className="shift-plan-error" role="alert">{error}</p> : null}</div> : null}
                  </article>;
                })}
              </div>
              <h3>События смены</h3>
              {shift.events?.length ? (
                [...shift.events].reverse().map((event) => (
                  <div className="shift-event-row" key={event.id}>
                    <strong>{EVENT_LABELS[event.type] || "Откат плана"}</strong>
                    <span>
                      {event.time} · версия {event.revision}
                    </span>
                    <p>{event.reason}</p>
                  </div>
                ))
              ) : (
                <p className="shift-muted">
                  Изменений опубликованного плана пока нет.
                </p>
              )}
              <h3>Фактические отметки</h3>
              {shift.factLog?.length ? (
                [...shift.factLog].reverse().map((fact) => (
                  <div className="shift-event-row" key={fact.id}>
                    <strong>
                      {shift.orders.find(
                        (order) => String(order.id) === String(fact.orderId),
                      )?.name || fact.orderId}
                    </strong>
                    <span>
                      {fact.time} ·{" "}
                      {fact.status === "completed"
                        ? "Выполнена"
                        : fact.status === "started"
                          ? "Начата"
                          : "Не выполнена"}
                    </span>
                    <p>{fact.reason || fact.correctionReason || fact.actor}</p>
                  </div>
                ))
              ) : (
                <p className="shift-muted">Отметок ещё нет.</p>
              )}
            </div>
          ) : null}
          {shift?.plan && tab === "event" ? (
            <div className="shift-form">
              {preview ? <div className="shift-pending shift-saved-draft"><b>Непубликованный черновик</b><span>Этот расчёт сохранён на сервере, поэтому появляется после обновления страницы. Действующий план и списки не изменились. Чтобы изменить исходные данные, сначала отмените черновик.</span><button type="button" onClick={discardDraft} disabled={busy}><X size={15}/>Отменить черновик</button></div> : null}
              <label>
                Сценарий
                <BusinessSelect
                  ariaLabel="Сценарий"
                  value={pendingEvent?.type || eventType}
                  disabled={Boolean(pendingEvent || preview)}
                  onChange={(value) => {
                    setEventType(value);
                    setTargetId("");
                    setEventEngineerId('');
                    if (value === EVENT_TYPES.RECALCULATE) {
                      setRecalculateScope(beforeReplanningAvailable ? 'before' : 'during');
                      setTime(beforeReplanningAvailable ? '07:00' : timeOf(Math.max(420, lastPublicationMinute, Math.floor(clock.minute))));
                    }
                    setPreview(null);
                  }}
                  options={eventOptions.map(type=>({value:type,label:EVENT_LABELS[type]}))}
                />
              </label>
              {!preview && !pendingEvent ? <button type="button" className="shift-add-replanning-order" onClick={() => onOpenManualAdd?.('orders')}><Plus size={16}/>Новая заявка: вручную или из файла</button> : null}
              {!pendingEvent && eventType === EVENT_TYPES.RECALCULATE ? <div className="shift-recalculate-mode" role="group" aria-label="Когда перестроить план">
                <b>Когда перестроить план</b>
                <button type="button" className={recalculateScope === 'before' ? 'selected' : ''} disabled={Boolean(preview) || !beforeReplanningAvailable} onClick={() => { setRecalculateScope('before'); setTime('07:00'); setReason(current => !current || current === 'Перестроение оставшейся части дня' ? 'Повторный расчёт плана до начала смены' : current); setPreview(null); }}>До начала смены <small>Все заявки и маршруты доступны для расчёта</small></button>
                <button type="button" className={recalculateScope === 'during' ? 'selected' : ''} disabled={Boolean(preview)} onClick={() => { setRecalculateScope('during'); setTime(timeOf(Math.max(420, lastPublicationMinute, Math.floor(clock.minute)))); setReason(current => !current || current === 'Повторный расчёт плана до начала смены' ? 'Перестроение оставшейся части дня' : current); setPreview(null); }}>В течение дня <small>Прошедшие и начатые визиты сохраняются</small></button>
                {!beforeReplanningAvailable ? <small>План уже менялся или есть факты визитов. Доступно перестроение оставшейся части дня.</small> : null}
              </div> : pendingEvent || restoredManualAddition ? (
                <div className="shift-pending">
                  <b>
                    Черновик: {(pendingEvent || restoredManualAddition).order?.name || (pendingEvent || restoredManualAddition).engineer?.name || (pendingEvent || restoredManualAddition).replacement?.name || shift.team.find(member=>String(member.id)===String((pendingEvent || restoredManualAddition).engineerId))?.name || EVENT_LABELS[(pendingEvent || restoredManualAddition).type]}
                  </b>
                  <span>
                    {(pendingEvent || restoredManualAddition).type === EVENT_TYPES.CAPACITY_ADDED && (pendingEvent || restoredManualAddition).engineerId
                      ? `Бригада остаётся в составе смены, но сейчас отмечена недоступной. ${preview ? 'Опубликуйте проверенный расчёт или отмените черновик.' : 'После проверки опубликуйте новую версию плана, чтобы вернуть её в работу.'}`
                      : (pendingEvent || restoredManualAddition).engineer || (pendingEvent || restoredManualAddition).replacement
                      ? `Бригада уже есть в постоянном составе, но ещё не включена в опубликованный план этой смены. ${preview ? 'Опубликуйте проверенный расчёт или отмените черновик.' : 'Рассчитайте черновик и опубликуйте проверенные изменения.'}`
                      : `Заявка ещё не добавлена в общий список. ${preview ? 'Опубликуйте проверенный расчёт или отмените черновик.' : 'Рассчитайте черновик и опубликуйте проверенные изменения.'}`}
                  </span>
                  {(pendingEvent || restoredManualAddition).type === EVENT_TYPES.CAPACITY_ADDED ? <span>Бригада уже есть в постоянном составе. Время публикации плана и служебная причина заполняются автоматически.</span> : null}
                  {(pendingEvent || restoredManualAddition).type === EVENT_TYPES.NEW_ORDER ? <span>Заявке не нужны время оперативного события и причина. Новая версия плана будет рассчитана с учётом уже опубликованных изменений смены.</span> : null}
                  {(pendingEvent || restoredManualAddition).type === EVENT_TYPES.NEW_ORDER && (minuteOf((pendingEvent || restoredManualAddition).order?.end) ?? 1440) <= (minuteOf(shift.versions?.at(-1)?.effectiveAt) ?? 0) ? <span>Окно этой заявки завершилось до последней версии плана. Заявка сохранится в смене, но не сможет получить маршрут в прошлом времени.</span> : null}
                  {!preview ? <button type="button" onClick={discardDraft} disabled={busy}><X size={15}/>Отменить черновик</button> : null}
                </div>
              ) : [
                  EVENT_TYPES.NEW_ORDER,
                  EVENT_TYPES.CAPACITY_ADDED,
                  EVENT_TYPES.ENGINEER_REPLACED,
                ].includes(eventType) ? (
                <div className="shift-pending">
                  Для добавления используйте кнопку «+» в «Заявках» или
                  «Инженерах»; данные попадут сюда как черновик. Для замены
                  сначала отметьте исходную бригаду недоступной, затем добавьте
                  новую.
                </div>
              ) : eventType !== EVENT_TYPES.RECALCULATE ? (
                <label>
                  {eventType === EVENT_TYPES.ENGINEER_UNAVAILABLE
                    ? "Бригада"
                    : "Заявка"}
                  <BusinessSelect ariaLabel={eventType===EVENT_TYPES.ENGINEER_UNAVAILABLE?'Бригада':'Заявка'} value={targetId} disabled={Boolean(preview)} onChange={value=>{setTargetId(value);setPreview(null)}} searchable options={[{value:'',label:'Выберите…'},...(eventType===EVENT_TYPES.ENGINEER_UNAVAILABLE?shift.team:eventOrders).map(item=>({value:String(item.id),label:item.name||item.sourceId||String(item.id)}))]}/>
                </label>
              ) : null}
              {!pendingEvent && eventType === EVENT_TYPES.MANUAL_ASSIGN ? <label>Новая бригада<BusinessSelect ariaLabel="Новая бригада для заявки" value={eventEngineerId} disabled={Boolean(preview)} onChange={value=>{setEventEngineerId(value);setPreview(null)}} searchable options={[{value:'',label:'Выберите бригаду…'},...shift.team.map(item=>({value:String(item.id),label:item.name||String(item.id)}))]}/></label> : null}
              {!pendingEvent && eventType === EVENT_TYPES.CLIENT_WINDOW_SHIFT ? <div className="shift-window-edit"><TimePicker label="Начало нового окна" value={eventStart} disabled={Boolean(preview)} onChange={value=>{setEventStart(value);setPreview(null)}}/><TimePicker label="Конец нового окна" value={eventEnd} disabled={Boolean(preview)} onChange={value=>{setEventEnd(value);setPreview(null)}}/><small>После проверки время визита может отличаться от начала окна: учитываются дорога, занятость и ограничения.</small></div> : null}
              {!pendingEvent && eventType === EVENT_TYPES.ENGINEER_UNAVAILABLE && !preview ? <div className="shift-absence-presets" role="group" aria-label="Причина отсутствия">{['Больничный', 'Отпуск', 'Не вышел на смену'].map(label=><button key={label} type="button" onClick={()=>setReason(label)}>{label}</button>)}</div> : null}
              {![EVENT_TYPES.CAPACITY_ADDED, EVENT_TYPES.NEW_ORDER].includes((pendingEvent || restoredManualAddition)?.type || eventType) && (eventType !== EVENT_TYPES.RECALCULATE || recalculateScope === 'during') ? <TimePicker label={eventType === EVENT_TYPES.RECALCULATE ? 'Перестроить с' : 'Время события'} value={time} disabled={Boolean(preview)} onChange={value=>{setTime(value);setPreview(null)}}/> : null}
              {![EVENT_TYPES.CAPACITY_ADDED, EVENT_TYPES.NEW_ORDER].includes((pendingEvent || restoredManualAddition)?.type || eventType) ? <label>
                Причина
                <textarea
                  value={reason}
                  disabled={Boolean(preview)}
                  onChange={(event) => { setReason(event.target.value); setPreview(null); }}
                  placeholder="Почему нужен пересчёт"
                />
              </label> : null}
              <button
                type="button"
                className="shift-primary"
                onClick={calculate}
                disabled={
                  busy || Boolean(preview) ||
                  (!pendingEvent &&
                    [
                      EVENT_TYPES.NEW_ORDER,
                      EVENT_TYPES.CAPACITY_ADDED,
                      EVENT_TYPES.ENGINEER_REPLACED,
                    ].includes(eventType))
                }
              >
                {busy
                  ? "Проверяем дороги и ограничения…"
                  : pendingEvent?.type === EVENT_TYPES.CAPACITY_ADDED ? 'Рассчитать план с бригадой' : eventType === EVENT_TYPES.RECALCULATE ? 'Пересчитать и сохранить черновик' : "Рассчитать черновик"}
              </button>
              {!preview && !pendingEvent && (eventType !== EVENT_TYPES.ENGINEER_UNAVAILABLE || targetId || reason.trim() || eventStart || eventEnd) ? <button type="button" className="shift-draft-reset" onClick={discardDraft} disabled={busy}><X size={15}/>Сбросить несохранённые изменения</button> : null}
              {preview?.status === "RUNNING" ? (
                <p className="shift-muted" role="status">
                  {preview.progress?.phase === 'ROAD_CHECK'
                    ? `Проверяем изменённые дороги и ограничения${preview.progress.checkedRoads ? ` · проверено участков: ${preview.progress.checkedRoads}` : ''}…`
                    : 'Собираем черновик маршрутов…'}
                </p>
              ) : null}
              {preview?.status === "READY" ? (
                <div className="shift-preview">
                  <h3>Было → стало</h3>
                  <p>Событие {preview.event?.time}: {preview.event?.reason}. {preview.result?.plan?.validation?.exactCheckedVisits ? `По реальным дорогам проверено ${preview.result.plan.validation.exactCheckedVisits} изменённых участков.` : 'Изменённых дорожных участков нет.'} {preview.result?.plan?.validation?.retainedEstimatedVisits ? `В неизменённой части прежнего плана: ${estimatedLegsLabel(preview.result.plan.validation.retainedEstimatedVisits)}.` : ''}</p>
                  {preview.result?.plan?.validation?.deferredAssignments ? <p className="shift-risk"><b>Требуется назначение:</b> дорожный сервис недоступен, поэтому будущие заявки снятой бригады оставлены в очереди. Снятие со смены можно опубликовать без неподтверждённых маршрутов.</p> : null}
                  <div>
                    <span>
                      Назначено{" "}
                      <b>
                        {current.assigned} → {next.assigned}
                      </b>
                    </span>
                    <span>
                      Без назначения{" "}
                      <b>
                        {current.unassigned} → {next.unassigned}
                      </b>
                    </span>
                    <span>
                      Пробег{" "}
                      <b>
                        {current.km} → {next.km} км
                      </b>
                    </span>
                  </div>
                  {change.moved.length || change.inserted.length || change.removed.length ? <div className="shift-change-list">
                    {change.moved.length ? <details open><summary>Изменены бригада или время · {change.moved.length}</summary><ul>{change.moved.map((item, index) => <li key={`moved-${index}`}>{item}</li>)}</ul></details> : null}
                    {change.inserted.length ? <details open><summary>Добавлены в маршруты · {change.inserted.length}</summary><ul>{change.inserted.map((item, index) => <li key={`inserted-${index}`}>{item}</li>)}</ul></details> : null}
                    {change.removed.length ? <details open><summary>Убраны из маршрутов · {change.removed.length}</summary><ul>{change.removed.map((item, index) => <li key={`removed-${index}`}>{item}</li>)}</ul></details> : null}
                  </div> : <p>Назначения и время визитов не изменились. Сравните общие показатели перед публикацией.</p>}
                  {(preview.result?.team || []).filter(item => { const old = shift.team.find(teamItem => String(teamItem.id) === String(item.id)); return !old || old.shiftStart !== item.shiftStart || old.shiftEnd !== item.shiftEnd || old.status !== item.status; }).length ? <p><b>Часы и состав:</b> {(preview.result.team || []).filter(item => { const old = shift.team.find(teamItem => String(teamItem.id) === String(item.id)); return !old || old.shiftStart !== item.shiftStart || old.shiftEnd !== item.shiftEnd || old.status !== item.status; }).slice(0, 4).map(item => `${item.name || item.id} ${item.shiftStart || '—'}–${item.shiftEnd || '—'}${item.status ? ` · ${item.status}` : ''}`).join('; ')}</p> : null}
                  {change.risky.length ? <p className="shift-risk"><b>Риск по клиентским окнам:</b> запас до конца окна не более 15 минут у {change.risky.slice(0, 4).join(', ')}.</p> : null}
                  {preview.result?.plan?.unassigned?.length ? (
                    <p>
                      Причины отказов:{" "}
                      {preview.result.plan.unassigned
                        .slice(0, 3)
                        .map(
                          (item) =>
                            item.reason || item.explanation || item.orderId,
                        )
                        .join("; ")}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="shift-primary"
                    onClick={publish}
                    disabled={busy}
                  >
                    Опубликовать проверенные изменения
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {shift?.plan && tab === "fact" ? (
            <div className="shift-form">
              <h3>Факт визита</h3>
              <label>
                Заявка
                <BusinessSelect ariaLabel="Заявка для отметки факта" value={factOrderId} onChange={setFactOrderId} searchable options={[{value:'',label:'Выберите…'},...selectableOrders.map(item=>({value:String(item.id),label:item.name||item.sourceId||String(item.id)}))]}/>
              </label>
              {selectedFact ? <p className="shift-muted">Последняя отметка: {selectedFact.status === 'completed' ? 'завершено' : selectedFact.status === 'started' ? 'начато' : 'не выполнено'} в {selectedFact.time}.</p> : null}
              <TimePicker label="Время факта" value={factTime} onChange={setFactTime}/>
              <label>
                Причина невыполнения
                <input
                  value={factReason}
                  onChange={(event) => setFactReason(event.target.value)}
                  placeholder="Если визит не выполнен"
                />
              </label>
              {selectedFact && selectedFact.status !== 'started' ? <label>Причина исправления отметки<input value={correctionReason} onChange={event => setCorrectionReason(event.target.value)} placeholder="Обязательно для исправления"/></label> : null}
              <div className="shift-fact-actions">
                <button
                  type="button"
                  onClick={() => markFact("started")}
                  disabled={busy || !factOrderId}
                >
                  Начать
                </button>
                <button
                  type="button"
                  onClick={() => markFact("completed")}
                  disabled={busy || !factOrderId}
                >
                  Завершить
                </button>
                <button
                  type="button"
                  onClick={() => markFact("not_completed")}
                  disabled={busy || !factOrderId}
                >
                  Не выполнено
                </button>
              </div>
            </div>
          ) : null}
          {tab === "report" && reportSection === 'pdf' ? <div className="daily-report-toolbar"><div><small>ДАТА ОТЧЁТА</small>{reportDateControl || <strong>{displayDate(selectedDate)}</strong>}</div><span>Выберите день с сохранённым планом</span></div> : null}
          {tab === "report" && reportSection === 'pdf' && !shift?.plan ? (
            <section className="shift-report-onboarding report-empty-state" aria-label="Как подготовить отчёт">
              <div className="shift-report-onboarding-intro">
                <span className="shift-report-onboarding-art"><FileText size={36}/></span>
                <small>ОТЧЁТ НЕ ДОСТУПЕН</small>
                <h3>На {displayDate(selectedDate)} нет сохранённого плана</h3>
                <p>Выберите другой день в календаре или подготовьте данные и сохраните план этой смены.</p>
                <button type="button" className="shift-primary report-generate-button" onClick={onOpenOrders}><BriefcaseBusiness size={19} aria-hidden="true"/><span>Открыть заявки</span><ChevronRight size={18} aria-hidden="true"/></button>
              </div>
              <div className="shift-report-onboarding-outline">
                <div className="shift-report-outline-heading"><small>КАК ПОЯВИТСЯ ОТЧЁТ</small><h4>Три шага до PDF</h4><p>Отчёт формируется только из данных выбранного дня.</p></div>
                <ol>
                  <li><b>01</b><span><strong>Загрузите заявки и бригады</strong><small>Для нужной даты смены</small></span></li>
                  <li><b>02</b><span><strong>Постройте и сохраните план</strong><small>Назначения, маршруты и окна станут источником PDF</small></span></li>
                  <li><b>03</b><span><strong>Сформируйте отчёт</strong><small>Его версия останется доступна в архиве ниже</small></span></li>
                </ol>
                <span className="shift-report-outline-note">Пустой PDF не создаётся</span>
              </div>
            </section>
          ) : null}
          {shift?.plan && tab === "report" && reportSection === 'pdf' ? <section className="daily-report-workspace report-generator" aria-label="Создать PDF-отчёт за день">
            <div className="report-generator-grid">
              <aside className="report-generator-intro">
                <span className="report-generator-icon"><FileText size={30}/></span>
                <small>ОТЧЁТ ДИСПЕТЧЕРА</small>
                <h3>Вся смена — в одном PDF</h3>
                <p>Решения на первых двух страницах, подробные расчёты — дальше. Без длинной панели графиков перед скачиванием.</p>
                <div className="report-generator-points"><span>8 страниц</span><span>Данные выбранного дня</span><span>Сохраняется в архиве</span></div>
              </aside>
              <div className="report-generator-form">
                <small>ВЫБРАННЫЙ ДЕНЬ</small>
                <h3>{displayDate(shift.date)}</h3>
                <div className="report-generator-status"><span>План сохранён</span><span>{reportData?.date === shift.date ? reportData.hasFact ? reportData.counts.withoutFact === 0 ? 'Итоговые статусы внесены' : 'Факт внесён частично' : 'Фактических отметок нет' : 'Проверяем данные…'}</span></div>
                <p>PDF отразит состояние этой смены на момент генерации. Новый отчёт создаст отдельную запись в архиве.</p>
                <button type="button" className={`shift-primary report-generate-button${busy?' is-busy':''}`} onClick={makeReport} disabled={busy} aria-label={`Сформировать PDF-отчёт за ${displayDate(shift.date)}`}>{busy?<span className="spinner" aria-hidden="true"/>:<FileText size={19} aria-hidden="true"/>}<span>{busy ? 'Формируем PDF…' : `Сформировать PDF за ${displayDate(shift.date)}`}</span>{!busy?<ChevronRight size={18} aria-hidden="true"/>:null}</button>
              </div>
            </div>
          </section> : null}
          {tab === "report" && reportSection === 'pdf' && reportUrl && reportArtifact ? <section ref={selectedReportRef} className="report-selected-document" aria-label="Открытый PDF"><div className="report-generated"><div><strong>Отчёт за {displayDate(reportArtifact.date)} готов</strong><small>{reportKind(reportArtifact.mode)} · {new Date(reportArtifact.generatedAt).toLocaleString('ru-RU')}</small></div><a href={reportUrl} download={reportFileName(reportArtifact)}><Download size={16}/>Скачать PDF</a></div><div className="report-preview-disclosure"><button type="button" onClick={() => setPreviewOpen(open => !open)} aria-expanded={previewOpen}><FileText size={16}/>{previewOpen ? 'Скрыть предпросмотр' : 'Показать страницы PDF'}<ChevronDown size={16}/></button>{previewOpen ? <div className="daily-report-pdf-preview"><PdfPreview url={reportUrl}/></div> : null}</div></section> : null}
          {tab === "report" && reportSection === 'pdf' ? <section className="report-archive-section" aria-label="Архив сформированных PDF"><div className="report-archive-heading"><div><small>АРХИВ PDF</small><h3>Сохранённые отчёты</h3></div><span>{reportArchive.length ? `Отчётов: ${reportArchive.length}` : 'Пока пусто'}</span></div>
            {reportArchive.length ? <div className="report-archive-list">{reportArchive.map(item => <article className={`report-archive-row ${item.id === reportArtifact?.id ? 'current' : ''}`} key={item.id}><span className="report-archive-icon"><FileText size={20}/></span><div className="report-archive-info"><strong>Отчёт за {displayDate(item.date)}</strong><small>{reportKind(item.mode)} · {new Date(item.generatedAt).toLocaleString('ru-RU')} · {item.author}</small></div><button type="button" onClick={() => openSavedReport(item)}>Открыть</button><a aria-label={`Скачать PDF за ${displayDate(item.date)}`} href={`/api/shifts/${item.shiftId}/report?artifactId=${encodeURIComponent(item.id)}`} download={reportFileName(item)}><Download size={16}/><span>Скачать</span></a></article>)}</div> : <p className="report-archive-empty">После генерации PDF появится здесь. Старые версии не перезаписываются.</p>}
            {reportHistory.length ? <div className="report-available-days"><small>ДНИ С СОХРАНЁННЫМ ПЛАНОМ</small><div>{reportHistory.map(item => <button type="button" key={item.id} className={item.date === shift?.date ? 'selected' : ''} onClick={() => onReportDateSelect?.(new Date(`${item.date}T12:00:00`))}><CalendarDays size={14}/>{displayDate(item.date)}</button>)}</div></div> : null}
          </section> : null}
          {tab === "report" && reportSection === 'chat' ? (
            <div className="shift-chat-layout"><section className="shift-chat" aria-label="Чат с AI по смене">
              <div className="shift-chat-thread" ref={chatThreadRef} aria-label="Диалог по смене" aria-live="polite">
                {chat.length ? chat.map((message, index) => <div className={`shift-chat-row ${message.role}`} key={`${index}-${message.role}`}>
                  <ChatAvatar role={message.role} profile={profile}/>
                  <div className="shift-chat-bubble"><small>{message.role === 'assistant' ? 'AI‑помощник' : 'Вы'}</small><p>{message.text}</p></div>
                </div>) : <div className="shift-chat-empty">
                  <span className="shift-chat-empty-icon"><img src="/avatars/robot-static.png" alt="Робот AI-помощника"/></span>
                  <b>{shift?.plan ? 'Что хотите узнать о смене?' : 'Здесь начнётся диалог'}</b>
                  <p>{shift?.plan ? 'Можно начать с готового вопроса или задать свой.' : 'Загрузите заявки и бригады, затем постройте план дня.'}</p>
                  {shift?.plan ? <div className="shift-chat-suggestions">
                    <button type="button" disabled={busy || !aiAvailable} onClick={() => askAi('')}><Sparkles size={14} aria-hidden="true"/> Ключевые выводы</button>
                    <button type="button" disabled={busy || !aiAvailable} onClick={() => askAi('Какие визиты завершены и что осталось?')}>Что уже выполнено?</button>
                    <button type="button" disabled={busy || !aiAvailable} onClick={() => askAi('Почему заявки остались без назначения?')}>Почему есть очередь?</button>
                  </div> : <button type="button" className="shift-chat-start" onClick={onOpenOrders}>Открыть заявки</button>}
                </div>}
                {busy ? <div className="shift-chat-row assistant"><ChatAvatar role="assistant" profile={profile}/><div className="shift-chat-bubble shift-chat-typing" role="status">Анализирую смену…</div></div> : null}
              </div>
              <form className="shift-chat-composer" onSubmit={event => { event.preventDefault(); if (question.trim()) askAi(question.trim()); }}>
                <div>
                  <input id="shift-ai-question" aria-label="Вопрос AI‑помощнику" value={question} maxLength={500} onChange={event => setQuestion(event.target.value)} placeholder={shift?.plan ? 'Напишите вопрос о смене…' : 'Сначала загрузите данные и постройте план'} disabled={busy || !aiAvailable || !shift?.plan}/>
                  <button type="submit" disabled={busy || !aiAvailable || !shift?.plan || !question.trim()} aria-label="Отправить вопрос"><Send size={18}/></button>
                </div>
              </form>
            </section><aside className="shift-chat-context" aria-label="Контекст диалога"><small>КОНТЕКСТ</small><h3>{shift?.plan ? 'Текущая смена' : 'Данные для ответа'}</h3>{shift?.plan ? <><dl><div><dt>Дата</dt><dd>{displayDate(shift.date)}</dd></div><div><dt>Назначено</dt><dd>{current.assigned}</dd></div><div><dt>В очереди</dt><dd>{current.unassigned}</dd></div></dl></> : <p>После построения плана здесь появятся показатели смены.</p>}<span>AI объясняет данные, но не меняет план и отметки визитов.</span></aside></div>
          ) : null}
          {error && tab !== 'events' ? (
            <div className="shift-error" role="alert">
              <AlertTriangle size={17} />
              {error}
            </div>
          ) : null}
        </div>
      </aside>
      {!reportOnly ? <ShiftPlaybackBar shift={shift} selectedOrderId={selectedOrderId} onSelectOrder={order=>{if(order)onSelectOrder?.(order)}} onEditOrder={orderId=>editOrder(orderId, EVENT_TYPES.CLIENT_WINDOW_SHIFT)}/> : null}
    </div>
  );
}
