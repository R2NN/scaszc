import { ratingName } from './engineerPresentation.js';
import { createIncidentAnnouncer, publishDispatchMapEvent } from './dispatchMapEvents.js';
import { createDispatchClockSync,adoptDispatchClock } from './dispatchClockSync.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock3, Route, RotateCcw, X } from 'lucide-react';
import { shiftClock } from './shiftClock.js';
import { BusinessSelect } from './BusinessSelect.jsx';
import { filterLabel } from './filterPresentation.js';
import { dispatchPreviewDetail, resolveDispatchCandidate } from './dispatchComparison.js';
import { dispatchConsequences, dispatchRecommendation, dispatchImpactPoints } from './dispatchConsequences.js';
import './emergency-dispatch.css';

const api = async (path, body) => {
  const response = await fetch(`/api/dispatch/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Не удалось получить решение аварии');
  return value;
};
const terminal = item => ['ACCEPTED', 'CANCELLED'].includes(item.status);

/** Bridge durable incidents to BeeGo's existing notifications and playback clock. */
export function useEmergencyDispatch({ shift, active = false, onApply, notify, onOpen, onRestart }) {
  const [incidents, setIncidents] = useState([]), [session, setSession] = useState(null), [selectedId, setSelectedId] = useState('');
  const [candidateId, setCandidateId] = useState(''), [error, setError] = useState(''), [policy, setPolicy] = useState(null);
  const [routeScope, setRouteScope] = useState('day');
  const [acceptingId, setAcceptingId] = useState('');
  const [submission,setSubmission] = useState(null);
  const refs = useRef({});
  refs.current = { shift, active, onApply, notify, onOpen, onRestart };
  const notified = useRef(new Set()), initialized = useRef(''), clockSync = useRef(null);
  const [serverOffset, setServerOffset] = useState(0);
  const announcer = useRef(null);
  const announce = items => {
    announcer.current ||= createIncidentAnnouncer(window,incident => {
      setSelectedId(incident.id);setCandidateId('');setRouteScope('day');
      refs.current.onOpen(incident,refs.current.shift);
    });
    announcer.current(items);
  };
  useEffect(() => {
    if (!shift?.id || shift.regionId.includes(':scenario:') || initialized.current === shift.id) return;
    initialized.current = shift.id;
    let alive = true;
    const restore = async () => {
      try {
        const value = await api(`context?baseShiftId=${shift.id}`);
        if (!alive || !value) return;
        const marker = `beego-dispatch-session:${shift.id}`;
        sessionStorage.setItem(marker, 'active');
        setSession(value); refs.current.onApply(value.shift);
        const chosenSpeed=shiftClock.getSnapshot().reviewSpeed;
        const reviewSpeed=chosenSpeed??value.clock.reviewSpeed??null;
        shiftClock.set({ minute: value.clock.minute, playing: false, speed:reviewSpeed??value.clock.speed, reviewSpeed, awaitingDecision:Boolean(value.clock.awaitingDecision), awaitingTransport:Boolean(value.clock.awaitingTransport), confirmingDecision:Boolean(value.clock.confirmingDecision), restartDay:null, restartFromMinute:null });
      } catch (e) { if (alive) setError(e.message); }
    };
    restore();
    return () => { alive = false; };
  }, [shift?.id]);
  useEffect(() => {
    if (!shift?.id) return;
    let alive = true;
    setIncidents([]);
    const loadPolicy = async () => {
      try { const value = await api(`shifts/${shift.id}/policy`); if (alive) setPolicy(value); }
      catch (e) { if (alive) setError(e.message); }
    };
    loadPolicy();
    const poll = async () => {
      try {
        const value = await api(`shifts/${shift.id}/incidents`);
        if (!alive || refs.current.shift?.id!==shift.id) return;
        if (value.clock && clockSync.current && !clockSync.current.apply(value.clock)) return;
        setServerOffset(value.serverNow-Date.now());
        setIncidents(value.incidents);
        announce(value.incidents);
        for (const incident of value.incidents) {
          for (const notice of incident.notifications) {
            if (notified.current.has(notice.id)) continue;
            notified.current.add(notice.id);
            refs.current.notify(notice.message, { ...notice, id: notice.id, type: 'EMERGENCY_INCIDENT', incidentId: incident.id, shiftId: shift.id, title: notice.title, showToast: !notice.read, read: notice.read });
          }
          if (incident.decision && incident.decision.revision > refs.current.shift.revision) {
            const response = await fetch(`/api/shifts/${shift.id}`);
            if (alive && response.ok) {const saved=await response.json();if(alive&&refs.current.shift?.id===shift.id)refs.current.onApply(saved);}
          }
        }
      } catch (e) { if (alive) setError(e.message); }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [shift?.id]);
  useEffect(() => {
    if (!shift?.regionId.includes(':scenario:')) return;
    const bridge = createDispatchClockSync({clock:shiftClock,scope:shift.id,
      send:snapshot => api(`shifts/${shift.id}/clock`,snapshot),
      onValue:value => {
        if(value.restarted){
          bridge.close();if(clockSync.current===bridge)clockSync.current=null;
          publishDispatchMapEvent(window,'clear');
          setSession(value);setSelectedId('');setCandidateId('');setRouteScope('day');setIncidents([]);setError('');setSubmission(null);setAcceptingId('');
          const clock={...value.clock,restartDay:null,restartFromMinute:null,selectedEngineerId:'',follow:false};
          if(!adoptDispatchClock(value.shiftId,clock))shiftClock.set(clock);
          refs.current.onApply(value.shift);
          refs.current.onRestart?.();
          return;
        }
        setIncidents(value.incidents || []);announce(value.incidents || []);
      },onError:e => {
        const clock=shiftClock.getSnapshot();
        if(clock.restartDay)shiftClock.set({minute:clock.restartFromMinute,restartDay:null,restartFromMinute:null,playing:false});
        setError(e.message);
      }});
    clockSync.current = bridge;
    return () => {bridge.close();if (clockSync.current === bridge) clockSync.current=null;};
  }, [shift?.id]);
  const open = async id => {
    try {
      const item = incidents.find(entry => entry.id === id) || await api(`incidents/${id}`);
      if (!item) return;
      let saved = refs.current.shift;
      if (saved.id !== item.shiftId) {
        const response = await fetch(`/api/shifts/${item.shiftId}`);
        if (!response.ok) throw new Error('Не удалось открыть смену уведомления');
        saved = await response.json();
        refs.current.onApply(saved);
      }
      setSelectedId(id); setCandidateId(''); setRouteScope('day'); refs.current.onOpen(item,saved);
      publishDispatchMapEvent(window,'clear');
      requestAnimationFrame(()=>publishDispatchMapEvent(window,'incident-focus',{coords:item.order.coords}));
    } catch (e) {setError(e.message);}
  };
  const preview = (candidate, scope = routeScope, engineerId = candidate.engineer.id, focusRoute = true) => {
    if (!refs.current.active) return false;
    try {
      const detail = dispatchPreviewDetail(refs.current.shift,candidate,{engineerId,scope});
      setError(''); setCandidateId(candidate.id); setRouteScope(scope);
      window.dispatchEvent(new CustomEvent('beego:dispatch-preview', {detail:{...detail,focusRoute}}));
      return true;
    } catch (e) { setError(e.message); return false; }
  };
  const changeRouteScope = scope => {
    if (!refs.current.active || !['day', 'next'].includes(scope)) return;
    setRouteScope(scope);
    window.dispatchEvent(new CustomEvent('beego:dispatch-scope', {detail:{scope}}));
  };
  const showChanges = (candidate, rows) => {
    if (!preview(candidate, routeScope, candidate.engineer.id, false)) return;
    window.dispatchEvent(new CustomEvent('beego:dispatch-impact', {detail:{features:dispatchImpactPoints(rows)}}));
  };
  const showResult = candidate => preview(candidate, routeScope);
  const startSession = async () => {
    try {
      const value = await api('sessions', { baseShiftId: session?.baseShiftId || shift.id, speed: shiftClock.getSnapshot().speed });
      publishDispatchMapEvent(window,'clear');
      sessionStorage.setItem(`beego-dispatch-session:${session?.baseShiftId || shift.id}`, 'active');
      setSession(value); setSelectedId(''); setCandidateId(''); setRouteScope('day'); setIncidents([]); refs.current.onApply(value.shift);
      shiftClock.set({ minute:360, playing:false, speed:value.clock.speed, awaitingDecision:false, confirmingDecision:false, selectedEngineerId:'', follow:false, restartDay:null, restartFromMinute:null });
      refs.current.onOpen();
    } catch (e) { setError(e.message); }
  };
  const accept = async (incident, candidate) => {
      if (acceptingId) return;
      setAcceptingId(incident.id);
      setSubmission({incidentId:incident.id,candidate});
      try {
        setError('');
        if (refs.current.shift.regionId.includes(':scenario:')) {
          await clockSync.current?.flush();
          if(refs.current.shift?.id!==incident.shiftId)return;
          const synchronized = await api(`shifts/${incident.shiftId}/clock`,shiftClock.getSnapshot());
          clockSync.current?.apply(synchronized.clock);
        }
        const result = await api(`incidents/${incident.id}/accept`, { candidateId:candidate.id, actor:'Диспетчер' });
        if(refs.current.shift?.id!==incident.shiftId)return;
        setIncidents(current => current.map(item => item.id === result.id ? result : item));
        if(result.status!=='ACCEPTED') return;
        setCandidateId(result.decision.candidateId);
        if (result.status === 'ACCEPTED' && result.decision.revision > refs.current.shift.revision) {
          const response = await fetch(`/api/shifts/${incident.shiftId}`);
          if (!response.ok) throw new Error('Решение сохранено, но обновить план не удалось. Обновите смену.');
          const saved=await response.json();if(refs.current.shift?.id!==incident.shiftId)return;
          refs.current.onApply(saved);
        }
        if (result.status === 'ACCEPTED') clockSync.current?.apply(result.playback);
      }
    catch (e) { if(refs.current.shift?.id===incident.shiftId)setError(e.message); }
    finally { setAcceptingId(current=>current===incident.id?'':current);setSubmission(current=>current?.incidentId===incident.id?null:current); }
  };
  const read = async item => {
    try { if (item.incidentId) await api(`incidents/${item.incidentId}/read`, {notificationId:item.id}); }
    catch (e) { setError(e.message); }
  };
  const retry = async id => {
    try { await api(`incidents/${id}/retry`, {}); }
    catch (e) { setError(e.message); }
  };
  const cancel = async id => {
    try { const result = await api(`incidents/${id}/cancel`, {}); setIncidents(current => current.map(item => item.id === id ? result : item)); }
    catch (e) { setError(e.message); }
  };
  const savePolicy = async value => {
    try { setPolicy(await api(`shifts/${shift.id}/policy`, value)); }
    catch (e) { setError(e.message); }
  };
  const select = incidents.find(item => item.id === selectedId) || incidents.find(item => !terminal(item)) || incidents.at(-1);
  useEffect(() => {
    publishDispatchMapEvent(window,'clear');
    if (active && select) {
      const candidate = resolveDispatchCandidate(select,candidateId) || select.candidates.find(item=>item.id===select.decision?.candidateId);
      if (candidate) preview(candidate,routeScope,candidate.engineer.id,false);
      else publishDispatchMapEvent(window,'incident-focus',{coords:select.order.coords});
    }
    return () => publishDispatchMapEvent(window,'clear');
  }, [active, shift?.id]);
  useEffect(() => {
    if (!active || !select || submission || terminal(select)) return;
    const improved = resolveDispatchCandidate(select, candidateId);
    if (improved && improved.id !== candidateId) preview(improved, routeScope, improved.engineer.id, false);
  }, [active, select, candidateId, submission]);
  return { incidents, selected:select, candidateId, routeScope, acceptingId, submission, changeRouteScope, showChanges, showResult, open, preview, startSession, session, error, serverOffset, policy, accept, read,
    retry, cancel, savePolicy };
}

/** A concrete job-level consequence can be opened directly on the map. */
function ConsequenceGroup({ title, rows, controller, candidate, accepted = false }) {
  const name = id => candidate.team?.find(engineer => String(engineer.id) === String(id))?.name || 'Инженер не указан';
  return <details className='dispatch-consequence-group'>
    <summary><span>{title}</span><b>{rows.length}</b></summary>
    {rows.length ? <>
      {rows.some(row => dispatchImpactPoints([row]).length) ? <button type='button' className='dispatch-map-action' onClick={() => controller.showChanges(candidate, rows)}>Показать адреса на карте</button> : null}
      <ul className='dispatch-consequence-list'>{rows.map(row => <li key={row.orderId}>
        <button type='button' className='dispatch-address' disabled={!dispatchImpactPoints([row]).length} onClick={() => controller.showChanges(candidate, [row])}>{row.address}</button>
        {row.before && row.after && row.before.engineerId !== row.after.engineerId ? <span>{name(row.before.engineerId)} → <b>{name(row.after.engineerId)}</b></span> : null}
        <span>{row.before?.plannedStart || 'Без назначения'} → {row.after?.plannedStart || 'Без назначения'}{row.delayMinutes > 0 ? ` · +${row.delayMinutes} мин` : ''}</span>
        {row.after ? <span className={`dispatch-window-${row.windowStatus}`}>{row.windowStatus === 'outside' ? 'Нарушение окна клиента' : row.windowStatus === 'inside' ? 'В окне клиента' : 'Окно клиента не проверено'}{row.windowStart && row.windowEnd ? ` · ${row.windowStart}–${row.windowEnd}` : ''}</span> : <strong className='dispatch-error'>{accepted ? 'Осталась без назначения' : 'Останется без назначения'}</strong>}
      </li>)}</ul>
    </> : <p className='dispatch-no-changes'>Таких заявок нет.</p>}
  </details>;
}

/** Full-shift alternatives lead with their operational effect, rather than diff volume. */
export function EmergencyDispatchPanel({ controller, onRoute }) {
  useEffect(() => () => publishDispatchMapEvent(window,'clear'), []);
  const { selected:item, candidateId, policy } = controller;
  const [now, setNow] = useState(Date.now());
  const [openedRouteId, setOpenedRouteId] = useState('');
  const accepted = item?.status === 'ACCEPTED';
  const acceptedCandidate = item?.candidates.find(option => option.id === item.decision?.candidateId);
  const submitting=controller.submission && item && controller.submission.incidentId===item.id ? controller.submission.candidate : null;
  const candidate = (!accepted && submitting) || resolveDispatchCandidate(item, candidateId) || acceptedCandidate;
  const candidateApplied = accepted && candidate?.id === acceptedCandidate?.id;
  const impacts = useMemo(() => new Map((item?.candidates || []).map(option => [option.id, dispatchConsequences(option)])), [item?.candidates]);
  const impact = candidate && (impacts.get(candidate.id) || dispatchConsequences(candidate));
  const applied = acceptedCandidate && impacts.get(acceptedCandidate.id);
  const decisionKey = accepted ? `${item.id}:${item.decision.at}` : '';
  const previousIncident = useRef({id:item?.id,status:item?.status});
  const currentController = useRef(controller);
  currentController.current = controller;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (decisionKey && previousIncident.current.id === item.id && previousIncident.current.status !== 'ACCEPTED' && acceptedCandidate) currentController.current.showResult(acceptedCandidate);
    previousIncident.current = {id:item?.id,status:item?.status};
  }, [decisionKey, item?.id, item?.status, acceptedCandidate]);
  const selectedVisits = candidate?.plan.routes.find(route => route.engineerId === candidate.engineer.id)?.assignments || [];
  const emergencyIndex = selectedVisits.findIndex(visit => visit.orderId === candidate?.visit.orderId);
  const hasContinuation = emergencyIndex >= 0 && emergencyIndex < selectedVisits.length - 1;
  const seconds = item ? Math.max(0, Math.ceil((item.deadlineAt - now - (controller.serverOffset || 0)) / 1000)) : 0;
  const countdown = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const searching = Boolean(item && !terminal(item) && (['QUEUED', 'SEARCHING'].includes(item.status) || item.search?.complete === false && !item.search?.stoppedReason && item.status !== 'ERROR'));
  const checkingIntercept = searching && item?.progress?.stage?.startsWith('INTERCEPT_');
  const repairingCoverage = searching && item?.progress?.stage === 'COVERAGE_REPAIR';
  const recommended = item?.candidates.find(option => option.id === item.recommendedId);
  const recommendation = useMemo(() => recommended ? dispatchRecommendation(recommended, item.candidates) : '', [recommended, item?.candidates]);
  const arrivalTimes = (item?.candidates || []).map(option => option.responseMinutes).filter(Number.isFinite);
  const fastest = arrivalTimes.length ? Math.min(...arrivalTimes) : null;
  const pending = !accepted && (controller.acceptingId === item?.id || item?.confirmation?.state==='CHECKING');
  return <section className='emergency-dispatch' aria-label='Решение аварии'>
    <div className='dispatch-heading'><div><small>ОПЕРАТИВНОЕ РЕШЕНИЕ</small><h3>Аварийный выезд</h3></div><AlertTriangle size={24}/></div>
    {item && (candidate || accepted || pending) ? <div className={`dispatch-decision-bar${accepted ? ' is-applied' : ''}`}>
      <div className='dispatch-decision-person'><b>{accepted ? ratingName(acceptedCandidate?.engineer) : candidate ? ratingName(candidate.engineer) : 'Выберите инженера'}</b><strong>{accepted ? acceptedCandidate?.visit.arrival : candidate?.visit.arrival || '—'}<small>прибытие</small></strong></div>
      {accepted ? <div className='dispatch-applied-title' role='status'><Check size={19}/><b>Направлен на аварию</b></div> : null}
      <p className='dispatch-main-impact'>{accepted ? applied?.summary : impact?.summary || (searching ? 'Проверенные варианты появятся ниже' : 'Выберите вариант ниже, чтобы увидеть последствия')}</p>
      {!terminal(item) ? <div className='dispatch-submit-row'><span className='dispatch-decision-timer'><Clock3 size={17}/>{item.policy?.enabled ? seconds ? `Автовыбор через ${countdown}` : 'Автовыбор: ожидаем готовое решение' : 'Ручное решение'}</span><button type='button' className='primary' disabled={!candidate || item.status !== 'WAITING' || pending} onClick={() => controller.accept(item, candidate)}>{pending ? 'Направляем…' : 'Направить на аварию'}</button></div> : null}
      {candidate ? <>
        {accepted && !candidateApplied ? <p className='dispatch-preview-label'>Непринятый вариант на карте: {ratingName(candidate.engineer)}</p> : null}
        <div className='dispatch-inline-key'>{candidate.kind !== 'Выезд из дома' ? <span className='before'>Исходный путь</span> : null}<span className='after'>До аварии</span>{hasContinuation ? <span className='continuation'>После аварии</span> : null}</div>
        <div className='dispatch-scope-controls' role='group' aria-label='Показывать маршрут'>{[{value:'day',label:'Весь оставшийся день'},{value:'next',label:'Ближайшее действие'}].map(option => <button key={option.value} type='button' aria-pressed={(controller.routeScope || 'day') === option.value} onClick={() => controller.changeRouteScope(option.value)}>{option.label}</button>)}</div>
      </> : null}
    </div> : null}
    {!item ? <div className='dispatch-empty'><h4>Бригада для срочного выезда</h4><p>При поступлении аварии здесь появятся проверенные варианты: кто приедет, какие заявки придётся передать и успеет ли команда закончить день.</p>{!controller.session?<div className='dispatch-scenario'><small>Демонстрационный сценарий</small><p>Общий показ смены 17 августа с 06:00: дорога в 09:30, авария в 11:17, метро в 14:25. События появляются на общей карте.</p><button type='button' className='shift-secondary' onClick={controller.startSession}>Запустить сценарий с 06:00</button></div>:null}</div> : <>
      <div className='dispatch-incident'><b>{item.order.address}</b><span>{item.time} · {accepted ? 'Решение принято' : item.status === 'CANCELLED' ? 'Отменена' : 'Требуется решение'}</span></div>
      {acceptedCandidate && accepted ? <div className='dispatch-result' role='status'>
        <Check size={24}/><div><b>{ratingName(acceptedCandidate.engineer)} направлен на аварию</b><strong>Прибытие {acceptedCandidate.visit.arrival}</strong><span>{item.decision.actor === 'system' ? 'Автовыбор' : 'Решение диспетчера'} · версия {item.decision.revision}</span></div>
        {item.confirmation?.routeUpdate ? <p>{item.confirmation.routeUpdate}</p> : null}
        {applied.transferred.length ? <><ul>{applied.transferred.slice(0,3).map(row => <li key={row.orderId}><b>{row.address}</b><span>Передана: {acceptedCandidate.team?.find(engineer => engineer.id === row.after.engineerId)?.name || row.after.engineerId} · {row.after.plannedStart}</span></li>)}</ul>{applied.transferred.length > 3 ? <details className='dispatch-result-more'><summary>Остальные передачи · {applied.transferred.length - 3}</summary><ul>{applied.transferred.slice(3).map(row => <li key={row.orderId}><b>{row.address}</b><span>Передана: {acceptedCandidate.team?.find(engineer => engineer.id === row.after.engineerId)?.name || row.after.engineerId} · {row.after.plannedStart}</span></li>)}</ul></details> : null}</> : <p>Прежние заявки другим инженерам не передавались.</p>}
        {applied.lost.length ? <strong className='dispatch-error'>Без назначения: {applied.lost.length}. Нужен разбор очереди.</strong> : null}
      </div> : null}
      {pending ? <div className='dispatch-confirming' role='status'><Clock3 size={20}/><div><b>Подтверждаем направление</b><span>{ratingName(submitting?.engineer || item.confirmation?.engineer)} · проверяем актуальный путь. Выбранный инженер сохраняется.</span></div></div> : null}
      {!terminal(item) && !pending ? <div className={`dispatch-search-state ${searching ? 'is-searching' : 'is-ready'}`} role='status'>
        <span className='dispatch-search-icon'><Clock3 size={19}/></span><div><b>{item.status === 'ERROR' ? 'Расчёт прерван' : checkingIntercept ? 'Проверяем перехват в пути' : repairingCoverage ? 'Восстанавливаем назначения' : searching ? 'Поиск продолжается' : resultCountLabel(item.candidates.length)}</b><span>{repairingCoverage ? 'Ищем обмены между инженерами · готовые варианты доступны' : checkingIntercept ? item.progress.engineerName || 'Ближайшая бригада' : searching ? item.candidates.length ? `Готовых вариантов: ${item.candidates.length} · уже можно выбирать` : 'Проверяем маршруты и окна клиентов' : item.search?.stoppedReason ? 'Поиск остановлен по лимиту' : item.status === 'ERROR' ? 'Можно повторить расчёт' : 'Расчёт завершён'}</span></div>
        {!candidate ? <div className='dispatch-search-meta'>
          {item.progress?.total > 0 ? <span>Проверено инженеров <b>{item.progress.completed ?? 0}/{item.progress.total}</b></span> : null}
          <span className='dispatch-decision-timer' aria-live='off'><Clock3 size={15}/>{item.policy?.enabled ? seconds ? `Автовыбор через ${countdown}` : 'Автовыбор: ожидаем готовое решение' : 'Ручное решение'}</span>
        </div> : null}
      </div> : null}
      {!pending && !accepted && item.candidates.length > 0 ? <p className='dispatch-preview-label'>Положение проверено на {item.candidates[0].scenarioTime}. Перед направлением уточним путь выбранного инженера по текущему времени.</p> : null}
      {!pending && item.candidates.length > 0 ? <details className='dispatch-alternatives' open={accepted ? undefined : true} key={accepted ? 'accepted' : 'choosing'}><summary>{accepted ? 'Сравнить сохранённые варианты' : 'Варианты направления'}</summary>{!candidate ? <p className='dispatch-choice-hint'>Выберите карточку инженера для сравнения маршрута и заявок.</p> : null}<div className='dispatch-options' role='group' aria-label='Проверенные варианты'>{item.candidates.map(option => {
        const effect = impacts.get(option.id);
        return <button type='button' key={option.id} aria-pressed={option.id === candidate?.id} className={`dispatch-option ${option.id === candidate?.id ? 'selected' : ''}`} onClick={() => controller.preview(option)}>
          <span className='dispatch-option-head'><span className='dispatch-option-kind'>{option.kind}</span>{option.id === item.recommendedId ? <strong>Рекомендуем</strong> : option.responseMinutes === fastest && item.candidates.length > 1 ? <em>Быстрее всех</em> : null}</span>
          <span className='dispatch-card-person'><b>{ratingName(option.engineer)}</b><strong>{option.visit.arrival}<small>прибытие</small></strong></span>
          <span className={`dispatch-card-impact${effect.lost.length || effect.outsideWindow.length ? ' is-risk' : ''}`}>{effect.summary}</span>
          <span className='dispatch-action-counts'><span>Передачи <b>{effect.transferred.length}</b></span><span>Начнутся позже <b>{effect.delayed.length}</b></span><span>Без назначения <b>{effect.lost.length}</b></span></span>
          {option.id === item.recommendedId ? <span className='dispatch-recommendation'>{recommendation}</span> : null}
          <span className='dispatch-card-meta'>Реакция {option.responseMinutes} мин · резерв {effect.reserveCount}</span>
          <span className='dispatch-card-coverage'>{effect.coverageLabel}</span>
        </button>;
      })}</div></details> : null}
      {candidate && !pending ? <div className='dispatch-details'>
        <h4 className='dispatch-section-title'>Последствия для прежних заявок</h4>
        <ConsequenceGroup title={candidateApplied ? 'Переданы другим инженерам' : 'Передаются другим инженерам'} rows={impact.transferred} controller={controller} candidate={candidate} accepted={candidateApplied}/>
        <ConsequenceGroup title='Начнутся позже исходного плана' rows={impact.delayed} controller={controller} candidate={candidate} accepted={candidateApplied}/>
        {impact.delayed.length ? <p className='dispatch-window-note'>В окне клиента: {impact.withinWindow.length} · вне окна: {impact.delayed.filter(row => row.windowStatus === 'outside').length}{impact.delayed.some(row => row.windowStatus === 'unknown') ? ` · окно не проверено: ${impact.delayed.filter(row => row.windowStatus === 'unknown').length}` : ''}</p> : null}
        <ConsequenceGroup title='Теряют назначение' rows={impact.lost} controller={controller} candidate={candidate} accepted={candidateApplied}/>
        {impact.outsideWindow.length ? <ConsequenceGroup title='Вне окна клиента' rows={impact.outsideWindow} controller={controller} candidate={candidate} accepted={candidateApplied}/> : null}
        {impact.restored.length ? <ConsequenceGroup title='Получают назначение из очереди' rows={impact.restored} controller={controller} candidate={candidate} accepted={candidateApplied}/> : null}
        <details className='dispatch-tech-details'><summary>Маршруты затронутых инженеров</summary>{candidate.loads.map(load => <div key={load.engineerId}><button className='dispatch-route' type='button' onClick={() => {setOpenedRouteId(current => current === load.engineerId ? '' : load.engineerId);onRoute(candidate.plan.routes.find(route => route.engineerId === load.engineerId), candidate);}}><Route size={17}/><span>{load.name}<small>Загрузка {load.before} → {load.after} мин</small></span></button>{openedRouteId === load.engineerId ? <ol className='dispatch-route-visits'>{candidate.plan.routes.find(route => route.engineerId === load.engineerId)?.assignments.map(visit => <li key={visit.orderId}><b>{candidate.orders.find(order => order.id === visit.orderId)?.address || visit.orderId}</b><span>Прибытие {visit.arrival} · работа {visit.plannedStart}–{visit.plannedFinish}</span></li>)}</ol> : null}</div>)}</details>
        <details className='dispatch-tech-details'><summary>Допуск, проверка и резерв</summary>
          <p>Вся смена проверена · исходная версия {candidate.baseRevision} · положение на {candidate.scenarioTime}.</p>
          {candidate.warnings?.map(warning => <p key={warning} className='dispatch-error'>{warning}</p>)}
          <p>{candidate.engineer.skills.map(filterLabel).join(', ')} · {filterLabel(candidate.engineer.transport)}</p><p>Оснащение: {(candidate.engineer.equipment || []).map(filterLabel).join(', ') || 'Не указано'}</p>
          {candidate.startPoint?.kind === 'home' ? <p>Домашний старт: {candidate.startPoint.address} · доступен с {candidate.startPoint.availableFrom}</p> : null}
          <p>{candidate.experience?.count ? `Аварийных визитов в архиве: ${candidate.experience.count}${candidate.experience.scenarioCount ? ` (сценарных: ${candidate.experience.scenarioCount})` : ''}` : 'В архиве нет завершённых аварийных визитов этого инженера.'} {candidate.experience?.ratingCount ? `Оценка клиентов: ${candidate.experience.rating.toFixed(1)} из 5 · ${candidate.experience.ratingCount} оценок` : 'Оценки клиентов ещё не собраны.'}</p>
          <p>Выезд {candidate.visit.departureAt} · дорога {candidate.visit.travelMinutes} мин.</p>
          <b>Остались в резерве: {candidate.reserve.length}</b>{candidate.reserve.map(crew => <p key={crew.engineerId}>{crew.name} · {crew.availableAt}–{crew.until}</p>)}
          <code>{candidate.contentSha256}</code>
        </details>
      </div> : null}
      {item.progress || item.search?.rejected?.length ? <details className='dispatch-tech-details'><summary>Подробности поиска</summary>{item.progress ? <p>Проверено инженеров: {item.progress.completed} из {item.progress.total} · проверок маршрута: {item.progress.routeChecks ?? '—'}</p> : null}{item.search?.stoppedReason ? <p>Достигнут лимит поиска. Показаны проверенные варианты; оптимальность не доказана.</p> : null}{item.search?.rejected?.map(entry => <p key={entry.engineerId}>{entry.engineerName}: {entry.reason}</p>)}</details> : null}
      {!terminal(item) ? <div className='dispatch-actions'><button type='button' onClick={() => controller.retry(item.id)} disabled={item.status === 'SEARCHING' || pending}><RotateCcw size={16}/>Повторить расчёт</button><button type='button' onClick={() => controller.cancel(item.id)} disabled={pending}><X size={16}/>Отменить аварию</button></div> : null}
    </>}
    {controller.error || item?.error ? <p role='alert' className='dispatch-error'>{controller.error || item.error}</p> : null}
    {policy ? <details className='dispatch-policy'><summary>Настройка автовыбора</summary><label><input type='checkbox' checked={policy.enabled} onChange={e => controller.savePolicy({...policy,enabled:e.target.checked})}/>Автоматическое решение</label><BusinessSelect ariaLabel='Время ожидания решения' value={String(policy.waitSeconds)} options={[30,60,120,300,600,900].map(value => ({value:String(value), label:value < 60 ? `${value} секунд` : `${value/60} минут`}))} onChange={value => controller.savePolicy({...policy,waitSeconds:Number(value)})}/><small>Настройка действует для новых аварий.</small></details> : null}
  </section>;
}

const resultCountLabel = count => count ? `Готовых вариантов: ${count}` : 'Проверенных вариантов пока нет';
