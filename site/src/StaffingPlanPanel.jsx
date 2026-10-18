import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, LoaderCircle, MapPin, Route, Settings2, Star, Users, X } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { portraitForEngineer } from './engineerPortraits.js';
import { filterLabel } from './filterPresentation.js';
import './staffing-plan.css';
import { StaffingCoverageInfo } from './StaffingInsights.jsx';

const number = value => Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const api = async url => { const response = await fetch(`/api/ratings/${url}`); const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Не удалось загрузить данные.'); return value; };
const phaseNames = { SELECTING_RATINGS:'Подбираем состав', PREPARING_INPUTS:'Подготавливаем данные', LOADING_TRANSIT:'Проверяем дороги и транспорт', COMPACTING_TEAM:'Проверяем маршруты', SELECTING_ENGINEERS:'Назначаем подтверждённых инженеров', VALIDATING_PLAN:'Проверяем готовый план' };
const phaseSteps = [
  ['SELECTING_RATINGS', 'Подбор инженеров'],
  ['PREPARING_INPUTS', 'Подготовка данных'],
  ['LOADING_TRANSIT', 'Дороги и окна'],
  ['COMPACTING_TEAM', 'Проверка маршрутов'],
  ['SELECTING_ENGINEERS', 'Назначение заявок'],
  ['VALIDATING_PLAN', 'Финальная проверка'],
];
export const validRatingRange = model => Number.isFinite(model.qualityFloor) && Number.isFinite(model.qualityCeiling) && model.qualityFloor >= 1 && model.qualityCeiling <= 5 && model.qualityFloor <= model.qualityCeiling;

function BeePlanningLoader({ phase, compact = false }) {
  const current = Math.max(0, phaseSteps.findIndex(([key]) => key === phase));
  return <div className={`bee-planning-loader ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
    <div className="bee-loader-scene"><span className="bee-loader-glow"/><img src="/beego-mark.png" alt=""/><span className="bee-loader-trail"/></div>
    <div className="bee-loader-copy"><b>{phaseNames[phase] || 'Подбираем состав'}</b><span>{compact ? 'Проверяем данные без изменения рабочей смены' : 'Пчёлка проверяет заявки, навыки, окна и дороги'}</span></div>
    {!compact ? <div className="bee-loader-steps" aria-label="Этапы расчёта">{phaseSteps.map(([key, label], index) => <span key={key} className={index < current ? 'done' : index === current ? 'active' : ''}><i>{index < current ? '✓' : index + 1}</i>{label}</span>)}</div> : null}
  </div>;
}

export function StaffingRatingRange({model}) {
  return <fieldset className="staff-rating-range"><legend>Диапазон рейтинга <small>из 5</small></legend><div>{[['От','qualityFloor','setQualityFloor'],['До','qualityCeiling','setQualityCeiling']].map(([label,key,set])=><label key={key}><span>{label}</span><input type="number" min="1" max="5" step="0.01" aria-label={`${label} рейтинга`} value={model[key]} onChange={event=>model[set](event.target.value===''?'':Number(event.target.value))}/><input type="range" min="1" max="5" step="0.01" aria-label={`${label} рейтинга, ползунок`} value={model[key]||1} onChange={event=>{const value=Number(event.target.value);model[set](key==='qualityFloor'?Math.min(value,model.qualityCeiling||5):Math.max(value,model.qualityFloor||1));}}/></label>)}</div>{!validRatingRange(model)?<small role="alert">Задайте диапазон от 1 до 5: нижняя граница не должна превышать верхнюю.</small>:null}</fieldset>;
}

export function StaffingPlanControls({ model, footer = false }) {
  const [context,setContext]=useState(null), [error,setError]=useState(''), [history,setHistory]=useState([]), [clock,setClock]=useState(Date.now());
  const dialog=useRef(null), scenario=model.scenario;
  const settingsOpen=model.planSettingsOpen, proposalOpen=model.proposalOpen&&scenario?.status==='AWAITING_CONFIRMATION';
  const visible=!footer&&model.active&&model.tab==='plan'&&(settingsOpen||proposalOpen);
  const close=()=>{model.setPlanSettingsOpen(false);model.setProposalOpen(false);};
  useEffect(()=>{
    if(footer||!validRatingRange(model))return;
    let live=true;
    api(`staffing?${new URLSearchParams({regionId:model.regionId,date:model.date,pool:model.pool,qualityFloor:model.qualityFloor,qualityCeiling:model.qualityCeiling})}`).then(value=>{if(live){setContext(value);setError('');}}).catch(error=>{if(live)setError(error.message);});
    api(`scenarios?${new URLSearchParams({regionId:model.regionId,date:model.date})}`).then(value=>{if(live)setHistory(value.filter(item=>item.kind==='staffing'&&item.status==='READY'));}).catch(()=>{});
    return()=>{live=false;};
  },[footer,model.regionId,model.date,model.pool,model.qualityFloor,model.qualityCeiling,scenario?.id,scenario?.status,scenario?.saved]);
  useEffect(()=>{if(!model.running)return;setClock(Date.now());const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[model.running]);
  useEffect(()=>{
    if(!visible)return;const previous=document.activeElement;dialog.current?.focus();
    const key=event=>{if(event.key==='Escape'&&!dialog.current.querySelector('.business-select.open')){event.stopPropagation();close();}if(event.key==='Tab'){const items=[...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]')];if(event.shiftKey&&(document.activeElement===items[0]||document.activeElement===dialog.current)){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0]?.focus();}}};
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);if(previous?.isConnected)previous.focus();};
  },[visible,settingsOpen,proposalOpen]);
  const report=model.ready?scenario.staffing:null, proposal=scenario?.proposal;
  const stale=scenario&&(scenario.ratingVersion!==model.version||scenario.settings?.qualityFloor!==model.qualityFloor||(scenario.settings?.qualityCeiling??5)!==model.qualityCeiling||scenario.pool!==model.pool||context?.sourceHash&&(scenario.sourceHash!==context.sourceHash||scenario.sourceRevision!==context.sourceRevision));
  const elapsed=Math.max(0,Math.floor((clock-(model.calculationStartedAt||Date.parse(scenario?.confirmedAt||scenario?.createdAt)||clock))/1000));
  const canBuild=context?.hasPlan&&!context.started&&!model.running&&validRatingRange(model);
  const build=async()=>{if(await model.calculate())model.setPlanSettingsOpen(false);};
  if(footer)return <footer className="staff-plan-footer">{model.ready?<button onClick={()=>{model.setPlanRouteId(null);model.setScheduled(true);model.setPlanFitToken(Date.now());}}><MapPin size={15}/>Все маршруты</button>:<span>Отдельный план · рабочая смена сохраняется</span>}</footer>;
  return <div className="staff-plan-controls">
    <div className="staff-plan-toolbar"><button className="staff-plan-settings-button" onClick={()=>model.setPlanSettingsOpen(true)} disabled={model.running} aria-label="Настройки расчёта состава"><Settings2 size={18}/><b>Условия расчёта</b><span>{number(model.qualityFloor)}–{number(model.qualityCeiling)} <Star size={13}/></span><ChevronRight size={16}/></button><StaffingCoverageInfo model={model}/></div>
    {model.ready&&stale?<small className="staff-plan-warning">Условия изменены. Для нового расчёта откройте настройки.</small>:null}
    {model.ready&&!report?.complete?<small className="staff-plan-warning">Не все заявки назначены. Откройте «Не назначены» или измените условия.</small>:null}
    {model.ready&&report?.hypothetical?<small className="staff-plan-warning">Сценарий с условным специалистом · сохранение недоступно</small>:null}
    {error||model.error||scenario?.status==='FAILED'?<p className="rating-error" role="alert">{error||model.error||scenario.error}</p>:null}
    {context?.started?<small className="staff-plan-warning">Смена уже началась. Новый состав рассчитывается до начала работ.</small>:null}
    {!context?.hasPlan&&context&&!context.started?<small className="staff-plan-warning">{context.orders?'Сначала нужен точный план дня в «Заявках».':'На выбранный день нет заявок.'}</small>:null}
    {visible?createPortal(<div className="rating-dialog-shade staff-plan-dialog-shade" onMouseDown={event=>{if(event.target===event.currentTarget)close();}}><section className={`rating-dialog staff-plan-settings-dialog ${!settingsOpen?'is-proposal':''}`} ref={dialog} role="dialog" aria-modal="true" aria-label={settingsOpen?'Условия расчёта состава':'Подтверждение состава'} tabIndex={-1}>
      <header><div><small className="staff-plan-step">{settingsOpen?'1 · УСЛОВИЯ РАСЧЁТА':'2 · ПРОВЕРКА СОСТАВА'}</small><h2>{settingsOpen?'Кого включить в план':'Подтвердите инженеров'}</h2></div><button className="rating-icon" aria-label="Закрыть настройки плана" onClick={close}><X/></button></header>
      {settingsOpen?<><p>{new Date(`${model.date}T12:00:00`).toLocaleDateString('ru-RU',{day:'numeric',month:'long'})} · {context?.orders??'—'} заявок. Сначала покажем подходящих людей, затем построим маршруты.</p><StaffingRatingRange model={model}/><label>Кого рассматриваем<BusinessSelect ariaLabel="Пул инженеров плана" value={model.pool} onChange={model.setPool} options={[{value:'all',label:`Весь пул специалистов${context?` · ${number(context.catalog)}`:''}`},{value:'staff',label:`Текущий состав${context?` · ${context.staff}`:''}`} ]}/></label>
        {history.length?<details className="staff-plan-history"><summary>Предыдущие планы <span>Необязательно</span></summary><BusinessSelect ariaLabel="Версия плана по рейтингу" value="" options={[{value:'',label:'Открыть предыдущий план'},...history.map((item,index)=>({value:item.id,label:`${item.saved?'Сохранён':'Расчёт'} · ${new Date(item.createdAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})} · №${history.length-index}`}))]} onChange={async value=>{if(!value)return;try{const result=await api(`scenarios/${value}`);model.setScenario(result);model.setPool(result.pool);model.setQualityFloor(result.settings.qualityFloor);model.setQualityCeiling(result.settings.qualityCeiling??5);model.setPlanRouteId(null);model.setScheduled(true);model.setPlanFitToken(Date.now());close();}catch(error){setError(error.message);}}}/></details>:null}

        {model.error?<p className="rating-error" role="alert">{model.error}</p>:null}<footer><button onClick={close}>Отмена</button><button className="primary" disabled={!canBuild} onClick={build}>{model.running?'Подбираем…':'Подобрать состав'}<ChevronRight size={16}/></button></footer>
      </>:<><p>Предлагаем исполнителей под навыки, домашние точки старта и смены проверенного дня. Маршруты рассчитаем после подтверждения.</p><div className="staff-proposal-totals"><div><b>{proposal.team.length}</b><span>предложено</span></div><div><b>{number(proposal.available)}</b><span>подходят по рейтингу</span></div><div><b>{proposal.jobs}</b><span>заявок дня</span></div></div>
        {proposal.missing.length?<div className="staff-proposal-shortage"><b>Не хватает {proposal.missing.length} специалистов нужного профиля</b><span>Часть заявок останется без назначения.</span>{proposal.missing.map((item,index)=><small key={index}>{item.zone} · {item.skills.map(filterLabel).join(' · ')} · {item.jobs} заявок</small>)}</div>:null}
        {proposal.qualityExceptions?.length?<p className="staff-plan-warning">Ручные закрепления сохранены: {proposal.qualityExceptions.length} инженеров вне диапазона.</p>:null}
        <div className="staff-proposal-list" aria-label="Предложенные инженеры">{!proposal.team.length?<p className="rating-empty">Нет подходящих инженеров. Расширьте диапазон рейтинга или выберите весь пул.</p>:null}{proposal.team.map(person=><article key={person.id}><span className="staff-proposal-avatar">{portraitForEngineer(person.id)?<img src={portraitForEngineer(person.id)} alt=""/>:model.nameForEngineer(person).split(/\s+/).map(p=>p[0]).join('').slice(0,2)}</span><div><b>{model.nameForEngineer(person)}</b><small>{person.zone} · {person.shiftStart}–{person.shiftEnd}{person.locked?' · Закреплён вручную':''}</small><small>{person.skills.map(filterLabel).join(' · ')}</small></div><span className="staff-proposal-score"><Star size={14}/>{number(person.rating.score)}</span></article>)}</div>
        <small className="staff-proposal-note">Проверка маршрутов может освободить часть состава. Других инженеров без нового подбора не добавляем.</small>
        {model.error?<p className="rating-error" role="alert">{model.error}</p>:null}<footer><button onClick={()=>{model.setProposalOpen(false);model.setPlanSettingsOpen(true);}}>Изменить условия</button><button className="primary" disabled={model.running||stale||!proposal.team.length} onClick={model.confirm}>{model.running?'Запускаем…':proposal.missing.length?'Построить частичный план':'Подтвердить и построить маршруты'}<Route size={17}/></button></footer>
      </>}
    </section></div>,document.querySelector('.app-shell')||document.body):null}
  </div>;
}

export function StaffingPlanBody({model}) {
  if (model.running) return <div className="staff-plan-empty staff-plan-loading-state"><BeePlanningLoader phase={model.scenario?.progress?.phase}/></div>;
  return <div className="staff-plan-empty"><Route size={35}/><h3>{model.scenario?.status==='AWAITING_CONFIRMATION'?'Состав готов к проверке':'Состав → маршруты → карта'}</h3><p>{model.scenario?.status==='AWAITING_CONFIRMATION'?'Проверьте предложенных инженеров и подтвердите построение маршрутов.':'Нажмите «Построить план» на карте. Выберите диапазон рейтинга и подтвердите подходящих специалистов.'}</p>{model.scenario?.status==='AWAITING_CONFIRMATION'?<button className="staff-plan-review" onClick={()=>model.setProposalOpen(true)}>Проверить состав<ChevronRight size={17}/></button>:null}</div>;
}
