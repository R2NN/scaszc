import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Clock3, Route, RotateCcw, X } from 'lucide-react';
import { shiftClock } from './shiftClock.js';
import { BusinessSelect } from './BusinessSelect.jsx';
import { filterLabel } from './filterPresentation.js';
import './emergency-dispatch.css';

const api = async (path, body) => {
  const response = await fetch(`/api/dispatch/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Не удалось получить решение аварии');
  return value;
};
const terminal = item => ['ACCEPTED', 'CANCELLED'].includes(item.status);

/** Bridge durable incidents to BeeGo's existing notifications and playback clock. */
export function useEmergencyDispatch({ shift, onApply, notify, onOpen }) {
  const [incidents, setIncidents] = useState([]), [session, setSession] = useState(null), [selectedId, setSelectedId] = useState('');
  const [candidateId, setCandidateId] = useState(''), [error, setError] = useState(''), [policy, setPolicy] = useState(null);
  const refs = useRef({});
  refs.current = { shift, onApply, notify, onOpen };
  const notified = useRef(new Set()), autoOpened = useRef(new Set()), initialized = useRef(''), clockPending = useRef(false);
  const [serverOffset, setServerOffset] = useState(0);
  useEffect(() => {
    if (!shift?.id || shift.regionId.includes(':scenario:') || initialized.current === shift.id) return;
    initialized.current = shift.id;
    let alive = true;
    const restore = async () => {
      try {
        const value = await api(`context?baseShiftId=${shift.id}`);
        if (!alive || !value) return;
        const marker = `beego-dispatch-session:${shift.id}`;
        if (!sessionStorage.getItem(marker)) {
          const fresh = await api('sessions', { baseShiftId: shift.id });
          sessionStorage.setItem(marker, 'active');
          setSession(fresh); refs.current.onApply(fresh.shift);
          shiftClock.set({ minute: fresh.clock.minute, playing: false, speed: fresh.clock.speed });
          return;
        }
        sessionStorage.setItem(marker, 'active');
        setSession(value); refs.current.onApply(value.shift);
        shiftClock.set({ minute: value.clock.minute, playing: false, speed: value.clock.speed });
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
        if (!alive) return;
        setServerOffset(value.serverNow-Date.now());
        setIncidents(value.incidents);
        if (value.clock && value.clock.speed !== shiftClock.getSnapshot().speed) shiftClock.set({ speed: value.clock.speed });
        for (const incident of value.incidents) {
          for (const notice of incident.notifications) {
            if (notified.current.has(notice.id)) continue;
            notified.current.add(notice.id);
            refs.current.notify(notice.message, { ...notice, id: notice.id, type: 'EMERGENCY_INCIDENT', incidentId: incident.id, shiftId: shift.id, title: notice.title, showToast: !notice.read, read: notice.read });
          }
          if (!terminal(incident) && !autoOpened.current.has(incident.id)) {
            autoOpened.current.add(incident.id);
            setSelectedId(incident.id);
            refs.current.onOpen(incident, refs.current.shift);
            requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('beego:incident-focus', { detail: { coords: incident.order.coords } })));
          }
          if (!terminal(incident) && shiftClock.getSnapshot().speed !== 1) shiftClock.set({ speed: 1 });
          if (incident.decision && incident.decision.revision > refs.current.shift.revision) {
            const response = await fetch(`/api/shifts/${shift.id}`);
            if (alive && response.ok) refs.current.onApply(await response.json());
          }
        }
        // A persisted decision is a historical snapshot. Reopen it at the
        // incident moment instead of leaving playback before 11:17.
        const latestAccepted = value.incidents.filter(incident => incident.status === 'ACCEPTED').at(-1);
        if (latestAccepted) {
          const incidentMinute = Number(latestAccepted.time.slice(0, 2)) * 60 + Number(latestAccepted.time.slice(3));
          if (shiftClock.getSnapshot().minute < incidentMinute) shiftClock.set({ minute: incidentMinute, playing: false });
        }
      } catch (e) { if (alive) setError(e.message); }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [shift?.id]);
  useEffect(() => shiftClock.subscribe(async () => {
    const current = refs.current.shift;
    if (!current?.regionId.includes(':scenario:') || clockPending.current) return;
    clockPending.current = true;
    try {
      const value = await api(`shifts/${current.id}/clock`, shiftClock.getSnapshot());
      setIncidents(value.incidents || []);
      const snapshot = shiftClock.getSnapshot();
      // While playing, the animation clock is the smooth visual source. The
      // server response can describe the request's older minute, so snapping
      // to it would make the timeline jump backwards on every slow response.
      const reanchor = !snapshot.playing || !value.clock.playing;
      shiftClock.set(reanchor
        ? { minute: value.clock.minute, playing: value.clock.playing, speed: value.clock.speed }
        : { speed: value.clock.speed });
    } catch (e) { setError(e.message); }
    finally { clockPending.current = false; }
  }), []);
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
      setSelectedId(id); setCandidateId(''); refs.current.onOpen(item,saved);
      window.dispatchEvent(new CustomEvent('beego:dispatch-clear'));
      requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('beego:incident-focus', { detail: { coords: item.order.coords } })));
    } catch (e) {setError(e.message);}
  };
  const preview = candidate => {
    setCandidateId(candidate.id);
    window.dispatchEvent(new CustomEvent('beego:dispatch-preview', { detail: { before: shift.plan, after: candidate.plan, ids: [candidate.engineer.id] } }));
  };
  const startSession = async () => {
    try {
      const value = await api('sessions', { baseShiftId: session?.baseShiftId || shift.id, speed: shiftClock.getSnapshot().speed });
      window.dispatchEvent(new CustomEvent('beego:dispatch-clear'));
      sessionStorage.setItem(`beego-dispatch-session:${session?.baseShiftId || shift.id}`, 'active');
      setSession(value); setSelectedId(''); setCandidateId(''); setIncidents([]); refs.current.onApply(value.shift);
      shiftClock.set({ minute:360, playing:false, speed:value.clock.speed, selectedEngineerId:'', follow:false });
      refs.current.onOpen();
    } catch (e) { setError(e.message); }
  };
  const accept = async (incident, candidate) => {
      try { setError(''); const result = await api(`incidents/${incident.id}/accept`, { candidateId:candidate.id, actor:'Диспетчер' }); setIncidents(current => current.map(item => item.id === result.id ? result : item)); if (result.playback) shiftClock.set({ speed: result.playback.speed, playing: result.playback.playing }); }
    catch (e) { setError(e.message); }
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
  return { incidents, selected:select, candidateId, open, preview, startSession, session, error, serverOffset, policy, accept, read,
    retry, cancel, savePolicy };
}

/** Full-shift alternatives use the same panel, cards and map as the shift. */
export function EmergencyDispatchPanel({ controller, onRoute }) {
  const { selected:item, candidateId, policy } = controller;
  const [now, setNow] = useState(Date.now());
  const [openedRouteId,setOpenedRouteId] = useState('');
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const candidate = item?.candidates.find(entry => entry.id === candidateId) || item?.candidates.find(entry => entry.id === item.decision?.candidateId);
  const engineerName = id => candidate?.team.find(engineer => engineer.id === id)?.name || '—';
  const visitLabel = id => id === item?.order.id ? 'Новая авария' : `№ ${candidate?.orders.find(order => order.id === id)?.sourceData?.source_job_id || id}`;
  const seconds = item ? Math.max(0, Math.ceil((item.deadlineAt-now-controller.serverOffset)/1000)) : 0;
  const searching = Boolean(item && !terminal(item) && (['QUEUED', 'SEARCHING'].includes(item.status) || item.search?.complete === false));
  const checkedEngineers = item?.progress ? Math.min(item.progress.completed, item.progress.total) : 0;
  const totalEngineers = item?.progress?.total || 0;
  const resultCount = item?.candidates?.length || 0;
  const deadlineLabel = item?.policy.enabled ? seconds ? `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}` : 'срок истёк' : 'вручную';
  return <section className='emergency-dispatch' aria-label='Решение аварии'>
    <div className='dispatch-heading'><div><small>ОПЕРАТИВНОЕ РЕШЕНИЕ</small><h3>Аварийный выезд</h3></div><AlertTriangle size={24}/></div>
    {item ? <div className='dispatch-flow' role='note'><b>Как принять решение</b><ol><li>Выберите карточку инженера.</li><li>Сравните последствия «до / после» на карте и в изменениях визитов.</li><li>Нажмите «Подтвердить этот вариант».</li></ol></div> : null}
    {!item ? <div className='dispatch-empty'><p>{controller.session ? 'Сценарная смена готова с начала дня. Нажмите «Воспроизвести» на шкале времени. Авария поступит в 11:17.' : 'При поступлении аварии здесь появятся проверенные варианты всей смены.'}</p><button type='button' className='primary' onClick={controller.startSession}>{controller.session ? 'Новая изолированная сессия' : 'Запустить сценарий с 06:00'}</button><small>17 августа · отдельная смена · событие в 11:17</small></div> : <>
      <div className='dispatch-incident'><b>{item.order.address}</b><span>{item.time} · {item.status === 'ACCEPTED' ? 'Решение принято' : item.status === 'CANCELLED' ? 'Отменена' : 'Требуется решение'}</span></div>
      {item.status === 'ACCEPTED' ? <div className='dispatch-saved-note'><span>Это сохранённый результат предыдущего прогона.</span><button type='button' onClick={controller.startSession}>Начать новую демонстрацию</button></div> : null}
      {!terminal(item) ? <div className={`dispatch-search-state ${searching ? 'is-searching' : 'is-ready'}`} role='status'>
        <div className='dispatch-search-copy'><span className='dispatch-search-icon'><Clock3 size={19}/></span><div><b>{searching ? 'Поиск вариантов продолжается' : resultCount ? 'Варианты готовы к сравнению' : 'Решение принимает диспетчер'}</b><span>{searching ? 'Показываем каждый вариант сразу после полной проверки.' : 'Выберите карточку и сравните её последствия с базовым планом.'}</span></div></div>
        <div className='dispatch-deadline'><small>{item.policy.enabled ? 'Автовыбор' : 'Режим решения'}</small><strong>{deadlineLabel}</strong></div>
      </div> : null}
      {item.progress && !terminal(item) ? <div className='dispatch-progress' role='status'><div><b>{checkedEngineers} из {totalEngineers}</b><span>инженеров проверено</span></div><div><b>{resultCount}</b><span>готовых вариантов</span></div>{item.progress.routeChecks != null ? <div><b>{item.progress.routeChecks}</b><span>проверок маршрута</span></div> : null}</div> : null}
      {item.error ? <p className='dispatch-error' role='alert'>{item.error}</p> : null}
      {item.status === 'ACCEPTED' ? <div className='dispatch-result'><Check/><b>{item.decision.actor === 'system' ? 'Система применила рекомендованный вариант' : 'Диспетчер подтвердил вариант'}</b><span>Версия {item.decision.revision} · {new Date(item.decision.at).toLocaleTimeString('ru-RU')}</span></div> : null}
      {item.candidates.length ? <div className='dispatch-compare-guide'><b>Сравните варианты</b><span>1. Прибытие и реакция — насколько быстро закрывается авария.</span><span>2. Изменения визитов и очередь — сколько работы придётся перестроить.</span></div> : null}
      <div className='dispatch-options' role='group' aria-label='Проверенные варианты'>{item.candidates.map((option, position) => <button type='button' key={option.id} aria-pressed={option.id === candidate?.id} className={`dispatch-option ${option.id === candidate?.id ? 'selected' : ''}`} onClick={() => controller.preview(option)}>
        <span className='dispatch-option-head'><span className='dispatch-option-kind'>{option.kind}</span>{position === 0 ? <strong>Рекомендуем</strong> : <em>Вариант {position + 1}</em>}</span>
        <b className='dispatch-option-engineer'>{option.engineer.name}</b>
        <div className='dispatch-option-kpis'><span><small>Прибытие</small><strong>{option.visit.arrival}</strong></span><span><small>Реакция</small><strong>{option.responseMinutes} мин</strong></span><span><small>Изменения</small><strong>{option.changes.filter(change => change.before).length}</strong></span></div>
        <div className='dispatch-option-summary'><span>Выезд {option.visit.departureAt} · дорога {option.visit.travelMinutes} мин</span><span>Резерв {option.reserve.length}</span><span>Назначено {option.coverage.after.assigned}/{option.coverage.after.total}</span></div>
        {option.coverage.after.unassigned > option.coverage.before.unassigned ? <span className='dispatch-error'>В очереди останется ещё {option.coverage.after.unassigned-option.coverage.before.unassigned} визита</span> : <span className='dispatch-option-ok'>Проверка пройдена · начать до {item.order.end}</span>}
      </button>)}</div>
      {candidate ? <div className='dispatch-details'>
        <div className='dispatch-selected-heading'><div><small>ВЫБРАННЫЙ ВАРИАНТ</small><h4>{candidate.engineer.name}</h4></div><strong>Прибытие {candidate.visit.arrival}</strong></div><p className='dispatch-route-summary'><b>Что смотреть на карте</b><span>Серый пунктир — полный маршрут этой бригады как было.</span><span>Фиолетовый — тот же день после назначения аварии.</span></p><details className='dispatch-tech-details'><summary>Допуск, транспорт и опыт</summary><p>{candidate.engineer.skills.map(filterLabel).join(', ')} · {filterLabel(candidate.engineer.transport)}</p><p>Оснащение: {(candidate.engineer.equipment || []).map(filterLabel).join(', ') || 'Не указано'}</p><p>{candidate.experience.count} завершённых аварийных визитов в архиве · Нет оценок</p></details>
        <button type='button' className='primary' disabled={item.status !== 'WAITING'} onClick={() => controller.accept(item, candidate)}>Подтвердить этот вариант</button>
        <h4 className='dispatch-section-title'>Изменения в маршрутах</h4>{candidate.loads.map(load => <div key={load.engineerId}><button className='dispatch-route' type='button' onClick={() => {setOpenedRouteId(current=>current===load.engineerId?'':load.engineerId);onRoute(candidate.plan.routes.find(route=>route.engineerId===load.engineerId), candidate);}}><Route size={17}/><span>{load.name}<small>Загрузка {load.before} → {load.after} мин</small></span></button>{openedRouteId===load.engineerId?<ol className='dispatch-route-visits'>{candidate.plan.routes.find(route=>route.engineerId===load.engineerId)?.assignments.map(visit=><li key={visit.orderId}><b>{candidate.orders.find(order=>order.id===visit.orderId)?.address || visit.orderId}</b><span>Выезд {visit.departureAt} · прибытие {visit.arrival}</span><span>Работа {visit.plannedStart}–{visit.plannedFinish}</span></li>)}</ol>:null}</div>)}
        <details><summary>Все изменения визитов · {candidate.changes.length}</summary>{candidate.changes.map(change => <div className='dispatch-change' key={change.orderId}><b>{visitLabel(change.orderId)} · {change.address}</b><span>{change.before?.plannedStart || 'Не назначена'} → {change.after?.plannedStart || 'В очереди'}</span><small>{engineerName(change.before?.engineerId)} → {engineerName(change.after?.engineerId)}</small></div>)}</details>
        <details><summary>Оставшийся резерв · {candidate.reserve.length}</summary>{candidate.reserve.map(crew => <p key={crew.engineerId}><b>{crew.name}</b><br/>{crew.availableAt}–{crew.until} · {crew.skills.map(filterLabel).join(', ')}</p>)}</details>
        <details><summary>Проверка и происхождение</summary><p>Вся смена проверена. Версия {candidate.baseRevision}, срез {candidate.scenarioTime}. Расчётное положение по дорожной геометрии.</p><code>{candidate.contentSha256}</code></details>
      </div> : item.candidates.length ? <p>Выберите вариант, чтобы сравнить маршруты на карте и последствия.</p> : null}
      {!terminal(item) && item.search?.complete === false ? <p>{item.search.stoppedReason ? 'Поиск завершён по лимиту. Показаны сохранённые проверенные варианты; оптимальность не доказана.' : 'Поиск продолжается. Уже проверенные варианты можно выбрать.'}</p> : null}
      {item.search?.rejected?.length ? <details><summary>Другие инженеры · {item.search.rejected.length}</summary>{item.search.rejected.map(entry => <p key={entry.engineerId}>{entry.engineerName}: {entry.reason}</p>)}</details> : null}
      {!terminal(item) ? <div className='dispatch-actions'><button type='button' onClick={() => controller.retry(item.id)} disabled={item.status === 'SEARCHING'}><RotateCcw size={16}/>Повторить расчёт</button><button type='button' onClick={() => controller.cancel(item.id)}><X size={16}/>Отменить аварию</button></div> : <button type='button' onClick={controller.startSession}>Новая изолированная сессия</button>}
    </>}
    {controller.error ? <p role='alert' className='dispatch-error'>{controller.error}</p> : null}
    {policy ? <details className='dispatch-policy'><summary>Настройка автовыбора</summary><label><input type='checkbox' checked={policy.enabled} onChange={e => controller.savePolicy({...policy,enabled:e.target.checked})}/>Автоматическое решение</label><BusinessSelect ariaLabel='Время ожидания решения' value={String(policy.waitSeconds)} options={[30,60,120,300,600,900].map(value => ({value:String(value), label:value < 60 ? `${value} секунд` : `${value/60} минут`}))} onChange={value => controller.savePolicy({...policy,waitSeconds:Number(value)})}/><small>Настройка действует для новых аварий. Покрытие аварий → остальных заявок → состав → прибытие → дорога.</small></details> : null}
    {candidate ? <div className='dispatch-map-key'><span>━━ После решения</span><span>┄┄ До решения</span></div> : null}
  </section>;
}
