import { EngineerPortrait } from './EngineerPortrait.jsx';
import { ratingName } from './engineerPresentation.js';
import { Fragment, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowUpDown, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Download, FileImage, Info, LoaderCircle, Maximize2, MessageSquare, Minimize2, Paperclip, RefreshCw, Search, Send, Star, X } from 'lucide-react';
import { WorkspaceFilters } from './WorkspaceFilters.jsx';
import { BusinessSelect } from './BusinessSelect.jsx';
import { useDropdownPresence } from './useDropdownPresence.js';
import { portraitForEngineer } from './engineerPortraits.js';
import { profileAvatarColor } from './profileAvatar.js';
import { filterLabel, matchesAnySelection, matchesSearch } from './filterPresentation.js';
import './ratings.css';
import { StaffingForecastButton } from './StaffingInsights.jsx';
import { StaffingPlanControls } from './StaffingPlanPanel.jsx';
import { ReviewCaseQueue } from './ReviewCaseQueue.jsx';

const number = (value, precision = 2) => Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: precision, maximumFractionDigits: precision });
const initials = name => String(name || '').split(/\s+/).map(part => part[0]).join('').slice(0, 2);
const dateText = value => value ? new Date(value).toLocaleDateString('ru-RU') : '';
const timeText = value => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const skillText = value => filterLabel(value);
const outcomeNames = { VALID: 'Отзыв обоснован', NOT_ENGINEER_FAULT: 'Претензия не к работе инженера', CLIENT_ERROR: 'Подтверждена ошибка клиента', CORRECTED: 'Оценка уточнена клиентом' };
const confirmationMethods = { phone: 'Телефон', written: 'Письменное подтверждение', visit: 'Во время визита' };
export async function ratingRequest(path, options = {}) {
  const response = await fetch(`/api/ratings/${path}`, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить действие.');
  return result;
}

export function useRatingWorkspace({ active, regionId, date, actor }) {
  const [tab, setTab] = useState('rating'), [full, setFull] = useState(false), [catalog, setCatalog] = useState([]), [version, setVersion] = useState(1);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState(null), [focus, setFocus] = useState(null);
  const [scenario, setScenario] = useState(null), [pool, setPool] = useState('all'), [scheduled, setScheduled] = useState(true), [saving, setSaving] = useState(false);
  const [qualityFloor, setQualityFloor] = useState(4.2), [posting, setPosting] = useState(false);
  const [calculationStartedAt,setCalculationStartedAt]=useState(0);
  const [planSettingsOpen,setPlanSettingsOpen]=useState(false), [proposalOpen,setProposalOpen]=useState(false);
  const [qualityCeiling,setQualityCeiling]=useState(5);
  const [planRouteId,setPlanRouteId] = useState(null), [planFitToken,setPlanFitToken] = useState(0);
  useEffect(()=>{if(scenario?.status==='READY'){setPlanRouteId(null);setPlanFitToken(Date.now());}},[scenario?.id,scenario?.status]);
  const [caseFocus, setCaseFocus] = useState(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => { if (active) setClosing(false); }, [active]);
  const selectedId = useRef(null), generation = useRef(0), catalogGeneration = useRef(0);
  const reloadCatalog = useCallback(async () => {
    const result = await ratingRequest(`engineers?regionId=${encodeURIComponent(regionId)}&date=${date}`);
    setCatalog(result.engineers); setVersion(result.version);
    if (selectedId.current) { const id = selectedId.current; const value = await ratingRequest(`engineers/${encodeURIComponent(id)}`); if (selectedId.current === id) setSelected(value); }
  }, [regionId, date]);
  useEffect(() => {
    let live = true; const token = ++catalogGeneration.current;
    if (!catalog.length) setLoading(true);
    ratingRequest(`engineers?regionId=${encodeURIComponent(regionId)}&date=${date}`).then(result => {
      if (!live || token !== catalogGeneration.current) return;
      setCatalog(result.engineers); setVersion(result.version);
    }).catch(error => { if (live) setError(error.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [regionId, date]);
  useEffect(() => {
    if (!active) return;
    let live = true; const token = ++generation.current; setError(''); setScenario(null);
    ratingRequest(`scenarios?regionId=${encodeURIComponent(regionId)}&date=${date}`).then(async scenarios => {
      if (!live || token !== generation.current) return;
      let identifier = scenarios[0]?.id;
      if (scenarios[0]?.status === 'FAILED' && scenarios[0].parentId) { setError(scenarios[0].error); identifier = scenarios[0].parentId; }
      const selectedScenario = identifier ? await ratingRequest(`scenarios/${identifier}`) : null;
      if (live && token === generation.current) { setScenario(selectedScenario); if (selectedScenario?.pool) setPool(selectedScenario.pool); if (selectedScenario?.settings) {setQualityFloor(selectedScenario.settings.qualityFloor);setQualityCeiling(selectedScenario.settings.qualityCeiling??5);} setProposalOpen(selectedScenario?.status==='AWAITING_CONFIRMATION'); }
    }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [active, regionId, date]);
  useEffect(() => { setSelected(null); selectedId.current = null; setFocus(null); }, [regionId, date]);
  useEffect(() => {
    if (!active || scenario?.status !== 'RUNNING') return;
    let live = true, timer;
    const poll = async () => {
      try { const value = await ratingRequest(`scenarios/${scenario.id}`); if (live) {
        if (value.status === 'FAILED' && value.parentId) { setError(value.error); const parent = await ratingRequest(`scenarios/${value.parentId}`); if (live) setScenario(parent); }
        else setScenario(value);
        if (value.status === 'RUNNING') timer = setTimeout(poll, 1000);
      } }
      catch (error) { if (live) { setError(error.message); timer = setTimeout(poll, 2500); } }
    };
    timer = setTimeout(poll, 600); return () => { live = false; clearTimeout(timer); };
  }, [active, scenario?.id, scenario?.status]);
  const select = useCallback(async (engineer, { focusMap = true } = {}) => {
    if (!engineer || selectedId.current === engineer.id) { selectedId.current = null; setSelected(null); return; }
    selectedId.current = engineer.id; setSelected(engineer); setError('');
    if (focusMap && engineer.startCoords?.length === 2) setFocus({ coords: engineer.startCoords, token: Date.now(), name: engineer.name });
    if (engineer.hypothetical) return;
    try { const value = await ratingRequest(`engineers/${encodeURIComponent(engineer.id)}`); if (selectedId.current === engineer.id) setSelected(value); }
    catch (error) { setError(error.message); }
  }, []);
  const calculate = async (options = {}) => {
    if (posting || scenario?.status === 'RUNNING') return;
    const token = generation.current; setCalculationStartedAt(Date.now());
    setError(''); setSelected(null); setFull(false); setTab('plan'); setScheduled(true); setPosting(true);
    try { const result = await ratingRequest('scenarios', { method: 'POST', body: JSON.stringify({ regionId, date, pool, kind: 'staffing', ...(options.addTemplateId && scenario?.kind === 'staffing' ? { baselineId: scenario.id } : {}), settings: { qualityFloor, qualityCeiling, addTemplateId: options.addTemplateId || null } }) }); if (token === generation.current) {setScenario(result);setProposalOpen(result.status==='AWAITING_CONFIRMATION');return true;} }
    catch (error) { if (token === generation.current) setError(error.message); } finally { setPosting(false); }
  };
  const confirm = async () => {
    if(posting || scenario?.status!=='AWAITING_CONFIRMATION')return;
    const token=generation.current;setPosting(true);setError('');setCalculationStartedAt(Date.now());
    try { const result=await ratingRequest(`scenarios/${scenario.id}/confirm`,{method:'POST',body:'{}'});if(token===generation.current){setScenario(result);setProposalOpen(false);setFull(false);setScheduled(true);} }
    catch(error){if(token===generation.current)setError(error.message);}finally{setPosting(false);}
  };
  const save = async () => {
    setError(''); setSaving(true);
    try { setScenario(await ratingRequest(`scenarios/${scenario.id}/save`, { method: 'POST', body: '{}' })); }
    catch (error) { setError(error.message); } finally { setSaving(false); }
  };
  const reassign = async (orderId, engineerId) => {
    if (!scenario || scenario.status !== 'READY') return;
    if (scenario.kind === 'staffing') { setPlanSettingsOpen(true); setError('Состав меняется через условия нового расчёта. Для ручных закреплений используйте рабочий план заявок до расчёта состава.'); return; }
    setError(''); setSelected(null);
    try { setScenario(await ratingRequest(`scenarios/${scenario.id}/reassign`, { method: 'POST', body: JSON.stringify({ orderId, engineerId }) })); }
    catch (error) { setError(error.message); }
  };
  return { tab, setTab, full, setFull, closing, setClosing, catalog, version, reloadCatalog, loading, error, setError, selected, select, focus, scenario, setScenario, pool, setPool, scheduled, setScheduled,
    calculationStartedAt, planSettingsOpen, setPlanSettingsOpen, proposalOpen, setProposalOpen, confirm, planRouteId, setPlanRouteId, planFitToken, setPlanFitToken, qualityFloor, setQualityFloor, qualityCeiling, setQualityCeiling, calculate, save, reassign, caseFocus, setCaseFocus, saving, actor, regionId, date, active, nameForEngineer:ratingName, ready: scenario?.status === 'READY', running: posting || scenario?.status === 'RUNNING' };
}

function Avatar({ name, id, profile }) {
  const portrait = profile?.avatar ? `/avatars/${profile.avatar}.png` : id ? portraitForEngineer(id) : null;
  return <span className={`rating-avatar${profile ? ' is-profile' : ''}`} style={profile ? { backgroundColor: profileAvatarColor(profile) } : undefined}>{portrait ? !profile ? <EngineerPortrait id={id}/> : <img key={portrait} src={portrait} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none'; }} /> : null}<span>{initials(name)}</span></span>;
}
function InfoPopover({ label = 'Как считается рейтинг', children, placement = 'side' }) {
  const [open, setOpen] = useState(false); const [position, setPosition] = useState(null); const root = useRef(null); const button = useRef(null); const popover = useRef(null);
  const id = useId();
  const openTimer = useRef(null), closeTimer = useRef(null), pinned = useRef(false);
  const clearTimers = useCallback(() => { window.clearTimeout(openTimer.current); window.clearTimeout(closeTimer.current); }, []);
  const closeNow = useCallback(() => { clearTimers(); pinned.current = false; setOpen(false); }, [clearTimers]);
  const hoverOpen = event => {
    if (event.pointerType === 'touch') return;
    clearTimers();
    openTimer.current = window.setTimeout(() => setOpen(true), 450);
  };
  const hoverClose = () => {
    clearTimers();
    if (!pinned.current) closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };
  useEffect(() => clearTimers, [clearTimers]);
  const updatePosition = useCallback(() => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const card = placement === 'card' ? button.current.closest('.rating-engineer-card')?.getBoundingClientRect() : null;
    const width = Math.min(280, window.innerWidth - 24, card ? card.width - 24 : Infinity);
    if (card) {
      const top = Math.min(rect.bottom + 8, window.innerHeight - 80);
      const left = Math.max(card.left + 12, Math.min(rect.left, card.right - width - 12));
      setPosition({ top, left, width, maxHeight: Math.max(60, Math.min(card.bottom - 12, window.innerHeight - 12) - top) });
      return;
    }
    const height = popover.current?.offsetHeight || 210;
    const left = rect.left - width - 12 >= 12 ? rect.left - width - 12 : Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    setPosition({ top: Math.max(12, Math.min(rect.top, window.innerHeight - height - 12)), left, width });
  }, [placement]);
  useLayoutEffect(() => { if (open) updatePosition(); }, [open, Boolean(position), updatePosition]);
  useEffect(() => { if (!open) return; const close = event => { if (event.key === 'Escape' || event.type === 'pointerdown' && !root.current?.contains(event.target) && !popover.current?.contains(event.target)) closeNow(); }; window.addEventListener('resize', updatePosition); window.addEventListener('scroll', updatePosition, true); document.addEventListener('pointerdown', close); document.addEventListener('keydown', close); return () => { window.removeEventListener('resize', updatePosition); window.removeEventListener('scroll', updatePosition, true); document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); }; }, [open, updatePosition, closeNow]);
  return <span className="rating-info" ref={root} onPointerEnter={hoverOpen} onPointerLeave={hoverClose}><button ref={button} type="button" className="rating-icon" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined} onFocus={() => { clearTimers(); setOpen(true); }} onBlur={hoverClose} onClick={() => { if (pinned.current) closeNow(); else { clearTimers(); pinned.current = true; setOpen(true); } }}><Info size={17}/></button>{open && position ? createPortal(<div id={id} ref={popover} role="tooltip" className={`rating-popover rating-popover-fixed ${placement === 'card' ? 'rating-score-explanation' : ''}`} style={position} onPointerEnter={clearTimers} onPointerLeave={hoverClose}>{children}</div>, document.body) : null}</span>;
}
export function RatingTabs({ model, showTitle = true, close }) {
  const tabIndex = model.tab === 'plan' ? 1 : model.tab === 'cases' ? 2 : 0;
  return <div className="rating-heading">{showTitle ? <header><h2>Рейтинг <small>{model.catalog.length.toLocaleString('ru-RU')}</small></h2>{model.tab !== 'cases' ? <div>{model.tab !== 'plan' ? <button type="button" className="rating-icon" aria-label={model.full ? 'Свернуть рейтинг' : 'Развернуть рейтинг'} onClick={() => { model.setTab('rating'); model.setFull(value => !value); }}>{model.full ? <Minimize2/> : <Maximize2/>}</button> : null}{close ? <button className="rating-icon" aria-label="Закрыть рейтинг" onClick={close}><X/></button> : null}</div> : null}</header> : null}<nav className="rating-tabs" style={{ '--rating-tab-index': tabIndex }} aria-label="Разделы рейтинга">{[['rating', 'Рейтинг'], ['plan', 'Состав и план'], ['cases', 'Отзывы и разборы']].map(([key, name]) => <button key={key} type="button" className={model.tab === key ? 'selected' : ''} aria-pressed={model.tab === key} onClick={() => { model.setTab(key); if (key === 'plan') { model.setFull(false); model.select(null); } }}>{name}</button>)}</nav></div>;
}

function RatingScoreInfo({ engineer }) {
  const { average, count, score, excluded } = engineer.rating;
  const total = Math.round((average || 0) * count);
  return <InfoPopover placement="card"><b>Как складывается оценка</b>
    <dl className="rating-score-facts"><div><dt>Средняя</dt><dd>{average == null ? '—' : number(average)}</dd></div><div><dt>Отзывов</dt><dd>{count}</dd></div><div><dt>Рейтинг</dt><dd>{number(score)}</dd></div></dl>
    <div className="rating-score-calculation"><span>Формула</span><code>({total} + 20 × 4,20) ÷ ({count} + 20)</code></div>
    <p className="rating-score-note">Поправка на <strong>20 отзывов</strong> с оценкой <strong>4,20</strong> сглаживает результат при небольшой истории.</p>
    <div className="rating-score-excluded">Исключено после разбора: <strong>{excluded}</strong></div>
  </InfoPopover>;
}

function ReviewCorrection({ review }) {
  return review.correction ? <small className="rating-review-correction">Уточнено клиентом: {review.originalScore} → {review.score} из 5. Исходная оценка сохранена.</small> : null;
}

function ReviewDialog({ review, onClose }) {
  const resolved = review.caseStatus === 'RESOLVED';
  const proceed = () => { onClose(); if (resolved) review.onHistory?.(); else review.onDecision?.(); };
  return <RatingDialog title="Отзыв о визите" onClose={onClose}><div className="rating-review-detail"><header><Avatar name={review.client}/><div><b>{review.client}</b><small>{dateText(review.date)} · <Star size={15}/>{review.score}</small></div></header><p>{review.comment}</p><ReviewCorrection review={review}/><dl><dt>Инженер</dt><dd>{review.engineerName || review.visit?.engineerId}</dd><dt>Визит</dt><dd>{review.visit?.orderId}</dd><dt>Адрес</dt><dd>{review.visit?.address}</dd><dt>Результат</dt><dd>Работа завершена · {review.visit?.finishedAt}</dd></dl>{!review.included ? <p className="rating-notice">Исключён из расчёта по результатам разбора. Исходная оценка сохранена.</p> : null}{review.preferred ? <p className="rating-notice"><Check/> Клиент хотел бы снова вызвать этого специалиста.</p> : null}<small>{review.provenance === 'OPERATIONAL_COMPLETED_FACT' ? 'Подтверждённый факт выполнения операционной смены.' : 'Учебная история качества · отдельный модельный визит.'}</small>{review.onDecision ? <div className="rating-review-action"><button type="button" className="primary" onClick={proceed}>{resolved ? 'Посмотреть решение' : 'Принять решение'}</button><small>{resolved ? 'Результат проверки и изменение рейтинга сохранены в разборе.' : 'Подтвердите отзыв или исключите его из рейтинга с указанием причины.'}</small></div> : null}</div></RatingDialog>;
}

const reviewVisit = review => review?.visit || {};
const reviewIdentity = review => review?.provenance === 'SYNTHETIC_RATING_HISTORY'
  ? [review?.client, String(review?.date || '').slice(0, 10)].map(value => String(value || '').trim().toLocaleLowerCase('ru-RU')).join('|')
  : review?.id;
const uniqueReviews = reviews => {
  const seen = new Set();
  return (reviews || []).filter(review => {
    const key = reviewIdentity(review);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function ReviewDetailPopover({ review, onClose, anchorRef }) {
  const visit = reviewVisit(review);
  const root = useRef(null);
  const [position, setPosition] = useState(null);
  const portalRoot = document.querySelector('.app-shell') || document.body;
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!anchor) return;
    // The app uses CSS zoom; DOM rectangles are viewport pixels, while a fixed
    // portal inside the app still takes coordinates in the app's CSS pixels.
    const zoom = Number.parseFloat(getComputedStyle(portalRoot).zoom) || 1;
    const available = anchor.left - 24;
    const beside = available >= 220 * zoom;
    const width = beside ? Math.min(360 * zoom, available) : Math.min(360 * zoom, window.innerWidth - 24);
    const left = beside ? anchor.left - width - 12 : 12;
    const height = root.current?.getBoundingClientRect().height || 500 * zoom;
    const top = Math.max(12, Math.min(anchor.top, window.innerHeight - height - 12));
    setPosition({ left: left / zoom, top: top / zoom, width: width / zoom, maxHeight: (window.innerHeight - 24) / zoom, right: 'auto', bottom: 'auto' });
  }, [anchorRef, portalRoot]);
  useLayoutEffect(() => {
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (anchorRef.current) observer.observe(anchorRef.current);
    if (root.current) observer.observe(root.current);
    window.addEventListener('resize', updatePosition);
    return () => { observer.disconnect(); window.removeEventListener('resize', updatePosition); };
  }, [updatePosition, review.id]);
  useEffect(() => {
    const close = event => { if (event.key === 'Escape' || event.type === 'pointerdown' && !root.current?.contains(event.target)) onClose(); };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); };
  }, [onClose]);
  const orderId = visit.orderId || review.orderId || 'Не указана';
  const address = visit.address || review.address || 'Адрес не указан';
  const work = visit.skill || review.skill;
  return createPortal(<section ref={root} className="rating-review-popover" style={position || { visibility: 'hidden' }} role="dialog" aria-modal="false" aria-label="Подробности отзыва">
    <header><div><span className="rating-review-popover-kicker">Отзыв о визите</span><h2>{review.client || 'Клиент'}</h2></div><button type="button" className="rating-icon" aria-label="Закрыть подробности отзыва" onClick={onClose}><X size={18}/></button></header>
    <div className="rating-review-popover-scroll">
      <div className="rating-review-popover-score"><Star/><strong>{review.score} из 5</strong><span>{dateText(review.date)}</span></div>
      <p className="rating-review-popover-comment">{review.comment || 'Комментарий не указан.'}</p>
      <ReviewCorrection review={review}/>
      <dl>
        <dt>Инженер</dt><dd>{review.engineerName || review.visit?.engineerName || review.visit?.engineerId || 'Не указан'}</dd>
        <dt>Заявка</dt><dd>{orderId}</dd>
        <dt>Адрес</dt><dd>{address}</dd>
        {work ? <><dt>Работа</dt><dd>{skillText(work)}</dd></> : null}
        {visit.arrivedAt ? <><dt>Прибытие</dt><dd>{visit.arrivedAt}</dd></> : null}
        {visit.startedAt ? <><dt>Начало работ</dt><dd>{visit.startedAt}</dd></> : null}
        {visit.finishedAt ? <><dt>Завершение</dt><dd>{visit.finishedAt}</dd></> : null}
      </dl>
      {!review.included ? <p className="rating-notice">Отзыв сохранён, но не учитывается в текущем расчёте рейтинга.</p> : null}
      <small className="rating-review-popover-source">{review.provenance === 'OPERATIONAL_COMPLETED_FACT' ? 'Подтверждённый факт выполнения операционной смены.' : 'Учебная история качества · отдельный модельный визит.'}</small>
    </div>
  </section>, portalRoot);
}

function AnimatedEngineerCard({ engineer, full = false, ...props }) {
  const [displayed, setDisplayed] = useState(engineer);
  const [visible, setVisible] = useState(Boolean(engineer));
  const latest = useRef(engineer);
  latest.current = engineer;
  const displayedId = displayed?.id;
  useEffect(() => {
    if (engineer?.id === displayedId) { setVisible(Boolean(engineer)); return undefined; }
    setVisible(false);
    const timer = window.setTimeout(() => {
      setDisplayed(latest.current);
      setVisible(Boolean(latest.current));
    }, displayedId ? (full && !engineer ? 460 : 200) : 0);
    return () => window.clearTimeout(timer);
  }, [engineer?.id, displayedId, full]);
  const current = engineer?.id === displayedId ? engineer : displayed;
  const card = current ? <EngineerCard key={current.id} engineer={current} full={full} motionClass={visible ? 'is-visible' : 'is-leaving'} {...props}/> : null;
  return full ? <div className={`rating-card-slot ${engineer ? 'is-expanded' : ''}`} inert={!engineer || undefined} aria-hidden={!engineer || undefined}>{card}</div> : card;
}

function EngineerCard({ engineer, onClose, onReview, onAllReviews, full = false, motionClass = '' }) {
  const displayName = ratingName(engineer);
  const cardRef = useRef(null);
  const [reviewFilter,setReviewFilter]=useState('all'),[reviewSort,setReviewSort]=useState('newest'),[reviewLimit,setReviewLimit]=useState(2),[reviewDetail,setReviewDetail]=useState(null);
  const reviewsRef=useRef(null);
  useEffect(()=>{setReviewDetail(null);reviewsRef.current?.scrollTo({top:0});},[reviewFilter,reviewSort]);
  const reviews = useMemo(() => uniqueReviews(engineer.reviews), [engineer.reviews]);
  const filteredReviews=useMemo(()=>reviews.filter(review=>reviewFilter==='all'||reviewFilter==='negative'&&Number(review.score)<=3||reviewFilter==='positive'&&Number(review.score)>=4).sort((a,b)=>{
    const newest=String(b.date||'').localeCompare(String(a.date||''));
    return reviewSort==='lowest'?Number(a.score)-Number(b.score)||newest:reviewSort==='highest'?Number(b.score)-Number(a.score)||newest:newest;
  }),[reviews,reviewFilter,reviewSort]);
  const changeFilter=value=>{setReviewFilter(value);setReviewLimit(value==='all'?2:6);};
  const changeSort=value=>{setReviewSort(value);setReviewLimit(6);};
  const openReview = review => setReviewDetail({ ...review, engineerName: displayName });
  return <aside ref={cardRef} className={`rating-engineer-card ${full ? 'embedded' : ''} ${motionClass}`} role="dialog" aria-label={`Рейтинг: ${displayName}`}>
    <header><Avatar name={displayName} id={engineer.id}/><div><h3>{displayName}</h3><span className="rating-kind">Инженер</span></div><button className="rating-icon" onClick={onClose} aria-label="Закрыть рейтинг инженера"><X/></button></header>
    <div className="rating-score-line"><Star/><strong>{number(engineer.rating.score)}</strong><RatingScoreInfo engineer={engineer}/><span>{engineer.rating.count} отзывов</span></div>
    {full ? <div className="rating-distribution"><b>Распределение оценок</b>{engineer.rating.distribution.map(item => <div key={item.stars}><span>{item.stars}<Star size={12}/></span><progress value={item.count} max={engineer.rating.count || 1}/><small>{item.count}</small></div>)}</div> : null}<div className="rating-card-reviews" ref={reviewsRef}><header><b>Отзывы <small>{filteredReviews.length}</small></b></header>
      <div className="rating-review-controls"><BusinessSelect portalMenu ariaLabel="Фильтр отзывов инженера" value={reviewFilter} onChange={changeFilter} options={[{value:'all',label:'Все оценки'},{value:'negative',label:'Негативные · 1–3 ★'},{value:'positive',label:'Хорошие · 4–5 ★'}]}/><BusinessSelect portalMenu ariaLabel="Порядок отзывов инженера" value={reviewSort} onChange={changeSort} options={[{value:'newest',label:'Сначала новые'},{value:'lowest',label:'Сначала низкая оценка'},{value:'highest',label:'Сначала высокая оценка'}]}/></div>
      {!engineer.reviews ? <div className="rating-loading"><LoaderCircle/>Загружаем отзывы…</div> : filteredReviews.length ? filteredReviews.slice(0,reviewLimit).map(review => <article key={review.id} data-review-id={review.id} data-review-score={review.score} data-review-date={review.date} role="button" tabIndex="0" className={reviewDetail?.id === review.id ? 'is-review-open' : ''} onClick={() => openReview(review)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openReview(review); } }}><div><b>{review.client}</b><span className="rating-stars">{review.score}<Star size={15}/></span></div><small>{dateText(review.date)} · {review.visit?.orderId}</small><p>{review.comment}</p><ReviewCorrection review={review}/>{!review.included ? <small className="rating-excluded">Не учитывается в рейтинге</small> : null}</article>) : <p className="rating-review-empty">{reviews.length?'Нет отзывов с выбранными оценками.':'Подтверждённых отзывов пока нет.'}</p>}
      {filteredReviews.length>reviewLimit?<button type="button" className="rating-reviews-more" onClick={()=>setReviewLimit(value=>value+10)}>Показать ещё <span>{filteredReviews.length-reviewLimit}</span><ChevronDown size={15}/></button>:null}
    </div><footer><span>Старт дня · {engineer.startAddress}</span></footer>{reviewDetail ? <ReviewDetailPopover review={reviewDetail} anchorRef={cardRef} onClose={() => setReviewDetail(null)} /> : null}
  </aside>;
}

export function RatingPlanControls(props) { return <StaffingPlanControls {...props}/>; }

function RatingDialog({ title, children, onClose, className = '', portal = true }) {
  const dialog = useRef(null);
  useEffect(() => { const previous = document.activeElement; dialog.current?.focus(); const key = event => { if (event.key === 'Escape') onClose(); if (event.key === 'Tab') { const items = [...dialog.current.querySelectorAll('button:not(:disabled),a[href],input,textarea,select,[tabindex="0"]')]; const first = items[0], last = items.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }; document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus?.(); }; }, []);
  const content = <div className={`rating-dialog-shade ${className}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="rating-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="rating-icon" aria-label="Закрыть окно" onClick={onClose}><X/></button></header>{children}</section></div>;
  return portal ? createPortal(content, document.querySelector('.app-shell') || document.body) : content;
}

function NewReviewForm({ engineer, onClose, onDone }) {
  const [visitId, setVisitId] = useState(engineer.pendingVisits?.[0]?.id || ''), [score, setScore] = useState('5'), [client, setClient] = useState(''), [comment, setComment] = useState(''), [preferred, setPreferred] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const visit = engineer.pendingVisits.find(item => item.id === visitId);
  const submit = async event => { event.preventDefault(); setBusy(true); try { const value = await ratingRequest('reviews', { method: 'POST', body: JSON.stringify({ visitId, score: Number(score), client, comment, preferred }) }); await onDone(value); onClose(); } catch (error) { setError(error.message); } finally { setBusy(false); } };
  return <RatingDialog title="Отзыв клиента после визита" onClose={onClose}><form className="rating-decision-form" onSubmit={submit}><p className="rating-notice">Оценка относится к специалисту, выполнившему выбранный визит: {engineer.name}.</p><label>Завершённый визит<select value={visitId} onChange={event => setVisitId(event.target.value)} required>{engineer.pendingVisits.map(item => <option key={item.id} value={item.id}>{dateText(item.date)} · {item.orderId}</option>)}</select></label><small>{visit?.address} · {visit?.provenance === 'SYNTHETIC_RATING_HISTORY' ? 'Учебный визит' : 'Подтверждённое завершение в смене'}</small><label>Оценка<select aria-label="Оценка клиента" value={score} onChange={event => setScore(event.target.value)}>{[5, 4, 3, 2, 1].map(item => <option key={item} value={item}>{item} из 5</option>)}</select></label><label>Клиент<input required maxLength={100} value={client} onChange={event => setClient(event.target.value)} placeholder="Имя клиента"/></label><label>Отзыв<textarea required minLength={3} maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} placeholder="Как прошла работа"/></label><label className="rating-checkbox"><input type="checkbox" checked={preferred} onChange={event => setPreferred(event.target.checked)}/>Клиент хотел бы снова вызвать этого специалиста</label>{error ? <p className="rating-error">{error}</p> : null}<footer><button type="button" onClick={onClose}>Отмена</button><button type="submit" className="primary" disabled={busy || !visitId || !client.trim() || comment.trim().length < 3}>{busy ? 'Сохраняем…' : 'Сохранить отзыв'}</button></footer></form></RatingDialog>;
}

function DecisionForm({ current, actor, onClose, onDone }) {
  const [outcome, setOutcome] = useState(''), [reason, setReason] = useState(''), [response, setResponse] = useState(''), [followUpRequired, setFollowUpRequired] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [correctedScore, setCorrectedScore] = useState(String(current.review.score)), [confirmationMethod, setConfirmationMethod] = useState(''), [confirmationDetails, setConfirmationDetails] = useState(''), [clientConfirmed, setClientConfirmed] = useState(false);
  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    if (!outcome) { setError('Выберите результат разбора.'); event.currentTarget.querySelector('.business-select-trigger')?.focus(); return; }
    if (reason.trim().length < 10) { setError('Опишите основание решения: не менее 10 символов.'); event.currentTarget.querySelector('[aria-label="Основание решения"]')?.focus(); return; }
    if (!response.trim()) { setError('Напишите ответ инженеру — он сохранится в переписке.'); event.currentTarget.querySelector('[aria-label="Ответ инженеру"]')?.focus(); return; }
    if (outcome === 'CORRECTED' && Number(correctedScore) === current.review.score) { setError('Выберите новую оценку, отличающуюся от текущей.'); return; }
    if (outcome === 'CORRECTED' && (!clientConfirmed || !confirmationMethod || confirmationDetails.trim().length < 10)) { setError('Укажите способ связи и подтверждение клиента (не менее 10 символов), затем отметьте его согласие с новой оценкой.'); return; }
    setError(''); setBusy(true);
    try { onDone(await ratingRequest(`cases/${current.id}/decision`, { method: 'POST', body: JSON.stringify({ expectedRevision: current.revision, outcome, reason, response, followUpRequired, actor, ...(outcome === 'CORRECTED' ? { correctedScore:Number(correctedScore), clientConfirmed, clientConfirmation:{method:confirmationMethod,details:confirmationDetails} } : {}) }) })); onClose(); }
    catch (error) { setError(error.message); } finally { setBusy(false); }
  };
  return <RatingDialog title="Принять решение по отзыву" onClose={onClose}><form className="rating-decision-form" onSubmit={submit} noValidate>
    <div className="rating-pinned-review"><b>{current.review.client} · {current.review.score} зв.</b><p>{current.review.comment}</p></div>
    <label>Результат разбора<BusinessSelect ariaLabel="Результат разбора" value={outcome} onChange={setOutcome} options={[{value:'',label:'Выберите решение'}, ...Object.entries(outcomeNames).filter(([value]) => value !== 'CORRECTED' || current.capabilities?.clientScoreCorrection).map(([value,label]) => ({value,label}))]} /></label>
    {outcome ? <small className="rating-notice">{outcome === 'CORRECTED' ? 'В расчёте будет новая оценка, подтверждённая клиентом. Исходные звёзды и история изменений сохранятся.' : outcome === 'VALID' ? 'Оценка будет учитываться в рейтинге инженера.' : 'Оценка будет исключена из расчёта. Первоначальные звёзды и отзыв клиента сохранятся.'}</small> : null}
    {outcome === 'CORRECTED' ? <fieldset className="rating-correction-fields"><legend>Подтверждение новой оценки</legend><label>Новая оценка<BusinessSelect ariaLabel="Новая оценка клиента" value={correctedScore} onChange={setCorrectedScore} options={[1,2,3,4,5].map(score => ({value:String(score),label:`${score} из 5`}))}/></label><label>Как подтвердил клиент<BusinessSelect ariaLabel="Способ подтверждения клиента" value={confirmationMethod} onChange={setConfirmationMethod} options={[{value:'',label:'Выберите способ'},...Object.entries(confirmationMethods).map(([value,label])=>({value,label}))]}/></label><label>Подтверждение клиента<textarea aria-label="Подтверждение клиента" value={confirmationDetails} onChange={event=>setConfirmationDetails(event.target.value)} maxLength={2000} placeholder="Когда и как клиент подтвердил новую оценку; ссылка или номер обращения, если есть"/></label><label className="rating-checkbox"><input type="checkbox" checked={clientConfirmed} onChange={event=>setClientConfirmed(event.target.checked)}/>Клиент подтвердил именно эту новую оценку</label></fieldset> : null}
    <label>Основание решения<textarea aria-label="Основание решения" required minLength={10} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Что проверили и почему принято это решение"/></label>
    <label>Ответ инженеру<textarea aria-label="Ответ инженеру" required maxLength={2000} value={response} onChange={event => setResponse(event.target.value)} placeholder="Этот ответ появится в переписке"/></label>
    <label className="rating-checkbox"><input type="checkbox" checked={followUpRequired} onChange={event => setFollowUpRequired(event.target.checked)}/>Нужно связаться с клиентом / организовать повторный выезд</label>
    <small>После сохранения разбор завершится, рейтинг пересчитается. Исходный отзыв, решение и автор останутся в истории.</small>{error ? <p className="rating-error" role="alert">{error}</p> : null}
    <footer><button type="button" onClick={onClose} disabled={busy}>Отмена</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить решение'}</button></footer>
  </form></RatingDialog>;
}

function DecisionImpact({ decision }) {
  return <><span>{decision.included ? 'Отзыв учитывается в рейтинге.' : 'Отзыв исключён из рейтинга.'} Исходная оценка: {decision.originalScore} из 5.{decision.correctedScore ? ` Подтверждённая клиентом: ${decision.correctedScore} из 5.` : ''}</span>{decision.ratingBefore && decision.ratingAfter ? <span className="rating-decision-impact">Рейтинг: <strong>{number(decision.ratingBefore.score, 4)} → {number(decision.ratingAfter.score, 4)}</strong> · Учтённых отзывов: {decision.ratingBefore.count} → {decision.ratingAfter.count}</span> : null}</>;
}

function CaseMessages({ messages, decisions, engineer, profile, onPhoto, scrollRef }) {
  const sameGroup = (first, second) => first && second && first.role === second.role && first.author === second.author && dateText(first.createdAt) === dateText(second.createdAt) && Math.abs(new Date(second.createdAt) - new Date(first.createdAt)) <= 300_000;
  return <div className="rating-messages" ref={scrollRef} role="log" aria-label="Переписка по отзыву" aria-relevant="additions">
    {messages.map((item, index) => {
      const previous = messages[index - 1], next = messages[index + 1];
      const groupStart = !sameGroup(previous, item), groupEnd = !sameGroup(item, next);
      const newDay = !previous || dateText(previous.createdAt) !== dateText(item.createdAt);
      const photos = item.attachments || [];
      const author = item.role === 'engineer' ? ratingName(engineer) : item.role === 'dispatcher' ? profile?.name || item.author : item.author;
      return <Fragment key={item.id}>
        {newDay ? <div className="rating-chat-day"><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</time></div> : null}
        <article className={`rating-message ${item.role === 'dispatcher' ? 'dispatcher' : ''} ${groupStart ? 'group-start' : 'group-continuation'} ${groupEnd ? 'group-end' : ''} ${photos.length ? 'has-photos' : ''} ${photos.length && !item.text ? 'photo-only' : ''}`} aria-label={`${author}, ${timeText(item.createdAt)}`}>
          {groupEnd ? <Avatar name={author} id={item.role === 'engineer' ? engineer.id : null} profile={item.role === 'dispatcher' ? profile : undefined}/> : null}
          {groupStart ? <b className="rating-message-author">{author}</b> : null}
          <div className="rating-message-content">
            {photos.length ? <div className={`rating-message-media ${photos.length > 1 ? 'is-album' : ''}`}>{photos.map((attachment, at) => <button type="button" className="rating-attachment" key={at} onClick={() => onPhoto(attachment)} aria-label={`Открыть фото: ${attachment.name}`} title={attachment.name}><img src={attachment.url} alt={attachment.name}/></button>)}</div> : null}
            {item.text ? <p>{item.text}</p> : null}
            <time className="rating-message-time" dateTime={item.createdAt} title={`${author} · ${dateText(item.createdAt)} ${timeText(item.createdAt)}`}>{timeText(item.createdAt)}</time>
          </div>
        </article>
      </Fragment>;
    })}
    {decisions.map(item => <div className={`rating-decision-log ${item.outcome === 'VALID' ? 'is-valid' : item.outcome === 'CORRECTED' ? 'is-corrected' : ''}`.trim()} key={item.id}><CheckCheck/><div><b>{outcomeNames[item.outcome]}</b><DecisionImpact decision={item}/><p>{item.reason}</p>{item.clientConfirmation ? <p>Подтверждение клиента · {confirmationMethods[item.clientConfirmation.method]}: {item.clientConfirmation.details}</p> : null}<small>{item.actor} · {dateText(item.createdAt)} {timeText(item.createdAt)}</small>{item.followUpRequired ? <p>Нужна связь с клиентом / повторный выезд.</p> : null}</div></div>)}
  </div>;
}

function ReviewCases({ model, profile, onRead, onBack, leaving = false }) {
  const [cases, setCases] = useState([]), [current, setCurrent] = useState(null), [query, setQuery] = useState(''), [status, setStatus] = useState('open');
  const [message, setMessage] = useState(''), [attachments, setAttachments] = useState([]), [role, setRole] = useState('dispatcher'), [decision, setDecision] = useState(false), [photo, setPhoto] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
  const [queueLoading,setQueueLoading]=useState(true);
  const [caseView,setCaseView]=useState('queue'),[caseLoading,setCaseLoading]=useState(false);
  const scroll = useRef(null), fileInput = useRef(null), messageInput = useRef(null), activeCase = useRef(null), scrolledCase = useRef(null);
  const openCase = useCallback(async id => {
    activeCase.current=id;setError('');setCaseLoading(true);setCurrent(null);
    try {let value=await ratingRequest(`cases/${id}`);
      if(value.capabilities?.caseTriage)value=await ratingRequest(`cases/${id}/triage`,{method:'PATCH',body:JSON.stringify({viewed:true,actor:model.actor})});
      if(activeCase.current===id){setCurrent(value);setCases(items=>items.map(item=>item.id===id?value:item));}
    }catch(error){if(activeCase.current===id)setError(error.message);}finally{if(activeCase.current===id)setCaseLoading(false);}
  },[model.actor]);
  useEffect(()=>{let live=true;
    const reload=()=>ratingRequest('cases').then(items=>{if(live)setCases(items);}).catch(error=>{if(live)setError(error.message);}).finally(()=>{if(live)setQueueLoading(false);});
    reload();if(model.caseFocus)openCase(model.caseFocus);
    const timer=setInterval(reload,5000);return()=>{live=false;clearInterval(timer);activeCase.current=null;};
  },[]);
  const markCase=async(id,patch)=>{try{const value=await ratingRequest(`cases/${id}/triage`,{method:'PATCH',body:JSON.stringify({...patch,actor:model.actor})});setCases(items=>items.map(item=>item.id===id?value:item));if(activeCase.current===id)setCurrent(value);}catch(error){setError(error.message);}};
  const closeCase=()=>{activeCase.current=null;setCurrent(null);setCaseLoading(false);};

  useEffect(() => { if (!current) return; const id = current.id; let live = true; const timer = setInterval(() => { ratingRequest(`cases/${id}`).then(value => { if (live) setCurrent(previous => previous?.revision > value.revision || (previous?.messages?.length || 0) > value.messages.length || JSON.stringify(previous) === JSON.stringify(value) ? previous : value); }).catch(() => {}); }, 5000); return () => { live = false; clearInterval(timer); }; }, [current?.id]);
  useLayoutEffect(() => {
    const container = scroll.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: scrolledCase.current === current.id ? 'smooth' : 'instant' });
    scrolledCase.current = current.id;
  }, [current?.messages?.length, current?.id,caseView]);
  useLayoutEffect(() => {
    const input = messageInput.current;
    if (!input) return;
    input.style.height = 'auto';
    const height = input.scrollHeight + 2;
    input.style.height = `${Math.min(height, 128)}px`;
    input.style.overflowY = height > 128 ? 'auto' : 'hidden';
  }, [message, current?.id,caseView]);
  useEffect(() => { setMessage(''); setAttachments([]); setPhoto(null); setError(''); setAttachmentError(''); }, [current?.id]);
  useEffect(() => { if (!attachmentError) return; const timer = window.setTimeout(() => setAttachmentError(''), 8000); return () => window.clearTimeout(timer); }, [attachmentError]);
  const changeCase = value => { setCurrent(value); setCases(items => items.map(item => item.id === value.id ? value : item)); setStatus(value.status === 'RESOLVED' ? 'closed' : 'open'); };
  const readCurrentReview = () => onRead({ ...current.review, engineerName: ratingName(current.engineer), caseStatus: current.status, onDecision: () => setDecision(true), onHistory: () => {setCaseView('chat');requestAnimationFrame(()=>scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }));} });
  const send = async event => { event.preventDefault(); if (busy || !current || !message.trim() && !attachments.length) return; setBusy(true); setError(''); setAttachmentError(''); try { changeCase(await ratingRequest(`cases/${current.id}/messages`, { method: 'POST', body: JSON.stringify({ text: message, attachments, role, author: model.actor }) })); setMessage(''); setAttachments([]); } catch (error) { setError(error.message); } finally { setBusy(false); } };
  const messageKeyDown = event => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) event.currentTarget.form?.requestSubmit();
  };
  const addFiles = async event => { setError(''); setAttachmentError(''); const files = [...event.target.files]; event.target.value = ''; try { if (attachments.length + files.length > 3) throw new Error('Можно прикрепить до трёх фотографий.'); const values = await Promise.all(files.map(file => new Promise((resolve, reject) => { if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2_000_000) return reject(new Error('Фотография должна быть PNG, JPEG или WebP до 2 МБ.')); const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, url: reader.result, type: file.type }); reader.onerror = () => reject(new Error('Не удалось прочитать файл.')); reader.readAsDataURL(file); }))); setAttachments(items => [...items, ...values]); } catch (error) { setAttachmentError(error.message); } };
  const visible = cases.filter(item => (status === 'open' ? item.status !== 'RESOLVED' : item.status === 'RESOLVED') && matchesSearch(query, [ratingName(item.engineer), item.review.client, item.review.comment, item.review.visit?.orderId]));
  return <section className={`rating-cases-workspace ${caseView==='queue'?`is-inbox ${current||caseLoading?'has-case-detail':''}`:'is-chat'} ${model.closing || leaving ? 'is-workspace-closing' : ''}`} inert={leaving || model.closing || undefined}><header className="rating-cases-title"><div className="rating-header-space"/><button className="rating-link rating-back-to-map" onClick={caseView==='chat'?()=>setCaseView('queue'):onBack}><ArrowLeft size={21}/>{caseView==='chat'?'К обращениям':'Назад к карте'}</button></header>{caseView==='queue'?<ReviewCaseQueue cases={cases} current={current} loading={caseLoading} listLoading={queueLoading} error={error} onOpen={openCase} onChat={()=>setCaseView('chat')} onDecision={()=>setDecision(true)} onMark={markCase} onReopen={async id=>{try{changeCase(await ratingRequest(`cases/${id}/reopen`,{method:'POST',body:'{}'}));}catch(error){setError(error.message);}}} onClose={closeCase} nameFor={ratingName} actor={model.actor}/>:<div className="rating-cases-layout">
    <aside className="rating-case-list"><div className="rating-search"><Search size={17}/><input aria-label="Поиск обращений" placeholder="Найти обращение…" value={query} onChange={event => setQuery(event.target.value)}/></div><div className="rating-kind-tabs"><button className={status === 'open' ? 'selected' : ''} onClick={() => setStatus('open')}>Открытые {cases.filter(item => item.status !== 'RESOLVED').length}</button><button className={status === 'closed' ? 'selected' : ''} onClick={() => setStatus('closed')}>Завершённые {cases.filter(item => item.status === 'RESOLVED').length}</button></div><div className="rating-case-rows">{visible.map(item => <button key={item.id} className={`rating-case-row ${current?.id === item.id ? 'selected' : ''}`} onClick={() => openCase(item.id)}><Avatar name={ratingName(item.engineer)} id={item.engineer.id}/><span><b>{ratingName(item.engineer)}</b><small>{item.review.comment}</small><small>{dateText(item.createdAt)} · {item.review.visit?.orderId}</small></span><ChevronRight size={15}/></button>)}{!visible.length ? <p className="rating-empty">Обращений не найдено.</p> : null}</div></aside>
    {current ? <section className="rating-conversation"><header className="rating-case-header"><Avatar name={ratingName(current.engineer)} id={current.engineer.id}/><div><h3>{ratingName(current.engineer)}</h3><small>Оспаривание оценки · {current.review.visit?.orderId}</small></div><span className={`rating-case-status ${current.status === 'RESOLVED' ? 'resolved' : ''}`}><i aria-hidden="true"/>{current.status === 'RESOLVED' ? 'Завершено' : 'В работе'}</span>{current.status !== 'RESOLVED' ? <button className="primary" onClick={() => setDecision(true)}>Принять решение</button> : <button onClick={async () => { try { changeCase(await ratingRequest(`cases/${current.id}/reopen`, { method: 'POST', body: '{}' })); } catch (error) { setError(error.message); } }}>Открыть повторно</button>}</header>
      <div className="rating-pinned-review is-review-link" role="button" tabIndex="0" onClick={readCurrentReview} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); readCurrentReview(); } }}><div><b>{current.review.client} · {current.review.score}<Star size={14}/></b><p>{current.review.comment}</p><ReviewCorrection review={current.review}/></div></div>
      {current.status === 'RESOLVED' && current.decisions.length ? <div className={`rating-case-result ${current.decisions.at(-1).outcome === 'VALID' ? 'is-valid' : current.decisions.at(-1).outcome === 'CORRECTED' ? 'is-corrected' : ''}`.trim()} role="status"><CheckCheck size={18}/><div><b>Решение сохранено · {outcomeNames[current.decisions.at(-1).outcome]}</b><DecisionImpact decision={current.decisions.at(-1)}/></div></div> : null}
      <CaseMessages messages={current.messages} decisions={current.decisions} engineer={current.engineer} profile={profile} onPhoto={setPhoto} scrollRef={scroll}/>
      {error || attachmentError ? <div className="rating-error rating-chat-error" role="alert"><span>{error || attachmentError}</span><button type="button" className="rating-icon" aria-label="Скрыть ошибку" onClick={() => { setError(''); setAttachmentError(''); }}><X size={16}/></button></div> : null}
      {current.status !== 'RESOLVED' ? <form className="rating-composer" onSubmit={send}><div className="rating-composer-role"><span>От имени</span><div className="rating-role-switch" role="group" aria-label="Участник переписки">{[['dispatcher','Диспетчера'],['engineer','Инженера']].map(([value,label]) => <button type="button" key={value} className={role === value ? 'selected' : ''} aria-pressed={role === value} onClick={() => setRole(value)}>{label}</button>)}</div>{attachments.map((item, index) => <button type="button" key={index} onClick={() => setAttachments(items => items.filter((_, at) => at !== index))}>{item.name}<X size={12}/></button>)}</div><div><input hidden type="file" ref={fileInput} accept="image/png,image/jpeg,image/webp" multiple onChange={addFiles}/><button type="button" className="rating-icon" aria-label="Прикрепить фотографии" onClick={() => fileInput.current.click()}><Paperclip/></button><textarea ref={messageInput} onKeyDown={messageKeyDown} aria-label="Сообщение инженеру" rows={1} value={message} maxLength={4000} onChange={event => setMessage(event.target.value)} placeholder={role === 'engineer' ? 'Ответ инженера…' : 'Сообщение инженеру…'}/><button className="primary" type="submit" disabled={busy || !message.trim() && !attachments.length} aria-label="Отправить сообщение"><Send size={19}/></button></div></form> : <p className="rating-resolved-note">Разбор завершён. Решение и переписка сохранены.</p>}
    </section> : <div className="rating-loading"><MessageSquare/>Выберите обращение</div>}
  </div>}{photo ? <RatingDialog title={photo.name} className="rating-photo-viewer" portal onClose={() => setPhoto(null)}><img className="rating-photo-full" src={photo.url} alt={photo.name}/><a className="rating-photo-download" href={photo.url} download={photo.name}><Download size={18}/>Скачать фотографию</a></RatingDialog> : null}{decision && current ? <DecisionForm current={current} actor={model.actor} onClose={() => setDecision(false)} onDone={value => { changeCase(value); model.reloadCatalog().catch(error => model.setError(error.message)); }}/> : null}</section>;
}

export function RatingWorkspace({ model, profile, onClose }) {
  const [query, setQuery] = useState(''), [sort, setSort] = useState('rating'), [filters, setFilters] = useState({ skill: [], zone: '', transport: '', count: '' }), [scrollTop, setScrollTop] = useState(0), [review, setReview] = useState(null), [entered, setEntered] = useState(false), listRef = useRef(null);
  const casePresence = useDropdownPresence(model.tab === 'cases', 240);
  const deferred = useDeferredValue(query);
  useEffect(() => { const frame = requestAnimationFrame(() => setEntered(true)); return () => cancelAnimationFrame(frame); }, []);
  const visible = useMemo(() => {
    const result = model.catalog.filter(item => matchesSearch(deferred, [ratingName(item), item.name, item.id, item.zone, item.skills, item.startAddress]) && matchesAnySelection(filters.skill, item.skills || []) && (!filters.zone || item.zone === filters.zone) && (!filters.transport || item.transport === filters.transport) && (!filters.count || item.rating.count >= Number(filters.count)));
    return result.sort((a, b) => sort === 'reviews' ? b.rating.count - a.rating.count : sort === 'name' ? a.name.localeCompare(b.name, 'ru') : b.rating.score - a.rating.score || b.rating.count - a.rating.count);
  }, [model.catalog, deferred, sort, filters]);
  useEffect(() => { setScrollTop(0); listRef.current?.scrollTo({ top: 0 }); }, [deferred, sort, filters, model.full]);
  const rowHeight = model.full ? 66 : 70;
  const tableHeadHeight = model.full ? 48 : 0;
  const firstRow = Math.max(0, Math.min(visible.length, Math.floor(Math.max(0, scrollTop - tableHeadHeight) / rowHeight) - 10));
  const windowSize = 42;
  const lastRow = Math.min(visible.length, firstRow + windowSize);
  const loaded = visible.slice(firstRow, lastRow);
  const loadMore = event => setScrollTop(event.currentTarget.scrollTop);
  const filterSections = useMemo(() => [['skill', 'Навыки', [...new Set(model.catalog.flatMap(item => item.skills || []))].map(value => [value, skillText(value)])], ['zone', 'Территория', [...new Set(model.catalog.map(item => item.zone).filter(Boolean))].map(value => [value, value])], ['transport', 'Транспорт', [...new Set(model.catalog.map(item => item.transport))].map(value => [value, filterLabel(value)])], ['count', 'Подтверждённые отзывы', [['', 'Любое количество'], ['20', 'От 20'], ['50', 'От 50'], ['100', 'От 100']]]], [model.catalog]);
  const list = <><div className="rating-list-tools"><div className="panel-search-row"><div className="rating-search"><Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Имя или навык…" aria-label="Поиск в рейтинге"/></div><WorkspaceFilters title="Фильтры рейтинга" value={filters} onChange={setFilters} multiKeys={['skill']} sections={filterSections}/></div><div className="rating-sort"><ArrowUpDown size={17}/><BusinessSelect ariaLabel="Сортировка рейтинга" value={sort} onChange={setSort} options={[{value:'rating',label:'Сначала высокий рейтинг'},{value:'reviews',label:'По количеству отзывов'},{value:'name',label:'По имени'}]} /></div></div>
    <div className="rating-engineer-list" ref={listRef} onScroll={loadMore}>
      {model.full ? <div className="rating-table-head" aria-hidden="true"><span>№</span><span>Инженер</span><span>Рейтинг</span><span>Отзывы</span><span className="rating-table-skills">Навыки</span><span className="rating-table-kind" aria-hidden="true"></span></div> : null}{model.loading && !model.catalog.length ? <p className="rating-loading"><LoaderCircle/>Загружаем рейтинг…</p> : <><div className="rating-list-spacer" style={{ height: `${firstRow * rowHeight}px` }} aria-hidden="true"/>{loaded.map((engineer, index) => <button key={engineer.id} className={`rating-engineer-row ${model.selected?.id === engineer.id ? 'selected' : ''}`} onClick={() => model.select(engineer)} data-rating-engineer={engineer.id}>{model.full ? <span className="rating-table-rank">{firstRow + index + 1}</span> : null}<Avatar name={ratingName(engineer)} id={engineer.id}/><span className="rating-row-copy"><b>{ratingName(engineer)}</b><small>{model.full ? engineer.zone : `${(engineer.skills || []).slice(0, 2).map(skillText).join(' · ')} · ${engineer.rating.count} отзывов`}</small></span><strong><Star size={19}/>{number(engineer.rating.score)}</strong>{model.full ? <><span className="rating-table-count">{engineer.rating.count}</span><span className="rating-table-skills">{(engineer.skills || []).slice(0, 2).map(skillText).join(' · ')}</span><span className={`rating-table-kind ${engineer.kind}`}>{engineer.kind === 'staff' ? 'Основной' : 'Резерв'}</span></> : <ChevronRight size={15}/>}</button>)}<div className="rating-list-spacer" style={{ height: `${Math.max(0, visible.length - lastRow) * rowHeight}px` }} aria-hidden="true"/></>}{!model.loading && !visible.length ? <p className="rating-empty">Инженеры не найдены. Измените поиск или фильтры.</p> : null}
    </div><footer className="rating-list-footer"><span>Найдено: {visible.length.toLocaleString('ru-RU')} инженеров</span><StaffingForecastButton model={model}/><InfoPopover label="Происхождение данных"><b>История качества</b><span>Оценка учитывает подтверждённые визиты и обращения. Решения диспетчера сохраняются отдельно от исходного отзыва.</span></InfoPopover></footer></>;
  return <>{casePresence.present ? <ReviewCases model={model} profile={profile} leaving={model.tab !== 'cases'} onRead={setReview} onBack={() => { model.setTab('rating'); model.setFull(false); }}/> : null}
    <section className={`rating-list-workspace rating-shared-workspace workspace-panel-enter ${entered ? 'is-open' : 'is-opening'} ${model.full && model.tab === 'rating' ? 'rating-expanded-view' : ''} is-${model.tab} ${model.closing ? 'is-workspace-closing' : ''}`}>
      <RatingTabs model={model} close={onClose}/>
      <div className="rating-roster-body" inert={model.tab !== 'rating' ? true : undefined} aria-hidden={model.tab !== 'rating' || undefined}>
        {model.error ? <p role="alert" className="rating-error">{model.error}</p> : null}<div className="rating-list-layout"><div className="rating-list-column">{list}</div>{model.full ? <AnimatedEngineerCard engineer={model.selected} full onClose={() => model.select(null)} onReview={setReview} onAllReviews={() => model.setTab('cases')}/> : null}</div>
      </div>
    </section>
    <AnimatedEngineerCard engineer={model.tab === 'rating' && !model.full && !model.closing ? model.selected : null} onClose={() => model.select(null)} onReview={setReview} onAllReviews={() => model.setTab('cases')}/>

    {review ? <ReviewDialog review={review} onClose={() => setReview(null)}/> : null}
  </>;
}
