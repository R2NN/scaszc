import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChartNoAxesCombined, Check, Info, LoaderCircle, X } from 'lucide-react';
import { filterLabel } from './filterPresentation.js';
import { groupStaffingNeeds } from './staffingInsights.js';
import './staffing-insights.css';

const number = value => value == null ? '—' : Number(value).toLocaleString('ru-RU',{maximumFractionDigits:2});
const date = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'}) : '';

function useStaffingContext(model, open) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();let live=true;
    setLoading(true);setData(null);setError('');
    fetch(`/api/ratings/staffing?${new URLSearchParams({regionId:model.regionId,date:model.date,pool:model.pool,qualityFloor:model.qualityFloor,qualityCeiling:model.qualityCeiling})}`,{signal:controller.signal})
      .then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось загрузить потребность.');return result;})
      .then(value=>{if(live)setData(value);}).catch(error=>{if(live&&error.name!=='AbortError')setError(error.message);}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;controller.abort();};
  },[open,model.regionId,model.date,model.pool,model.qualityFloor,model.qualityCeiling,model.version,model.scenario?.id,model.scenario?.status,retry]);
  return {data,error,loading,retry:()=>setRetry(value=>value+1)};
}

function InsightPopover({model,kind}) {
  const forecast=kind==='forecast',label=forecast?'Ожидаемая нагрузка':'Потребность и дефицит по районам';
  const [open,setOpen]=useState(false),[position,setPosition]=useState(null);
  const trigger=useRef(null),popover=useRef(null),openTimer=useRef(null),closeTimer=useRef(null),pinned=useRef(false);
  const identifier=useId();
  const clear=useCallback(()=>{clearTimeout(openTimer.current);clearTimeout(closeTimer.current);},[]);
  const close=useCallback(()=>{clear();pinned.current=false;setOpen(false);},[clear]);
  const show=event=>{if(event.pointerType==='touch')return;clear();openTimer.current=setTimeout(()=>setOpen(true),300);};
  const leave=()=>{clear();if(!pinned.current)closeTimer.current=setTimeout(()=>setOpen(false),180);};
  useEffect(()=>clear,[clear]);
  useEffect(()=>close(),[model.tab,model.regionId,model.date,model.active,close]);
  const updatePosition=useCallback(()=>{
    const rect=trigger.current?.getBoundingClientRect();if(!rect)return;
    const root=document.querySelector('.app-shell');const zoom=Number.parseFloat(getComputedStyle(root||document.body).zoom)||1;
    const width=Math.min(360*zoom,window.innerWidth-24),maxHeight=Math.min(520*zoom,window.innerHeight-24);
    const height=Math.min(popover.current?.getBoundingClientRect().height||360*zoom,maxHeight);
    // Keep the explanation anchored to the right edge of ⓘ. When the viewport
    // is narrow it stays on that side as far as possible and only clamps to
    // the viewport edge; it never jumps to the left of the trigger.
    const left=Math.min(rect.right+24,window.innerWidth-width-12);
    const top=Math.max(12,Math.min(rect.top,window.innerHeight-height-12));
    setPosition({left:left/zoom,top:top/zoom,width:width/zoom,maxHeight:maxHeight/zoom});
  },[]);
  useLayoutEffect(()=>{if(!open)return;updatePosition();const observer=new ResizeObserver(updatePosition);if(popover.current)observer.observe(popover.current);return()=>observer.disconnect();},[open,Boolean(position),updatePosition]);
  useEffect(()=>{
    if(!open)return;
    const dismiss=event=>{if(event.key==='Escape'){event.stopPropagation();close();trigger.current?.focus({preventScroll:true});}else if(event.type==='pointerdown'&&!trigger.current?.contains(event.target)&&!popover.current?.contains(event.target))close();};
    document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',dismiss);window.addEventListener('resize',updatePosition);window.addEventListener('scroll',updatePosition,true);
    return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',dismiss);window.removeEventListener('resize',updatePosition);window.removeEventListener('scroll',updatePosition,true);};
  },[open,close,updatePosition]);
  return <span className="staff-insight-anchor" onPointerEnter={show} onPointerLeave={leave}>
    <button ref={trigger} type="button" className={forecast?'staff-forecast-trigger':'staff-insight-trigger'} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?identifier:undefined} onFocus={event=>{if(popover.current?.contains(event.relatedTarget))return;clear();setOpen(true);}} onBlur={leave} onClick={()=>{if(pinned.current)close();else{clear();pinned.current=true;setOpen(true);}}}>{forecast?<><ChartNoAxesCombined size={16}/><span>Ожидаемая нагрузка</span></>:<Info size={19}/>}</button>
    {open&&position?createPortal(<section id={identifier} ref={popover} role="dialog" aria-modal="false" aria-label={label} className="staff-insight-popover" style={position} onPointerEnter={clear} onPointerLeave={leave} onFocusCapture={clear}><header><div><small>{forecast?'ПРОГНОЗ СПРОСА':'СОСТАВ И ПЛАН'}</small><h3>{label}</h3></div><button aria-label="Закрыть сводку" onClick={close}><X size={16}/></button></header><StaffingInsightContent model={model} open={open} forecast={forecast}/></section>,document.querySelector('.app-shell')||document.body):null}
  </span>;
}

function StaffingInsightContent({model,open,forecast}) {
  const {data,error,loading,retry}=useStaffingContext(model,open);
  if(loading||!data&&!error)return <p className="staff-insight-loading" role="status"><LoaderCircle size={17}/>Загружаем данные…</p>;
  if(error)return <div className="staff-insight-error" role="alert"><p>{error}</p><button onClick={retry}>Повторить</button></div>;
  const conditions=<span className="staff-insight-conditions">Рейтинг {number(model.qualityFloor)}–{number(model.qualityCeiling)} · {model.pool==='all'?'весь пул':'текущий состав'}</span>;
  if(forecast){
    const report=data.forecast;
    if(!report)return <p className="staff-insight-note">На выбранной территории пока нет данных для оценки будущей нагрузки.</p>;
    const uncovered=new Map();for(const zone of report.zones)for(const row of zone.uncovered||[])uncovered.set(row.skill,(uncovered.get(row.skill)||0)+row.demand);
    return <><div className="staff-insight-period">На {date(report.targetDate)}<small>Доступная дата прогноза модели</small></div>{conditions}<div className="staff-insight-forecast-total"><b>{number(report.demand.middle)} <span>заявок ожидается</span></b><small>Диапазон: {number(report.demand.low)}–{number(report.demand.high)}</small></div>
      <div className="staff-insight-zones">{report.zones.map(zone=><article key={zone.name}><div><b>{zone.name}</b><span>{number(zone.middle)} заявок</span></div><small>{zone.uncovered?.length?'От ':''}{number(zone.engineers)} специалистов{zone.reserve?` · резерв +${number(zone.reserve)}`:''}</small>{zone.engineers==null?<span className="staff-insight-gap">Нет данных для оценки состава</span>:zone.profiles.some(row=>row.shortage>0)?<span className="staff-insight-gap">Не хватает по известным профилям: {zone.profiles.reduce((sum,row)=>sum+row.shortage,0)}</span>:null}</article>)}</div>
      {uncovered.size?<p className="staff-insight-note warning">{[...uncovered].map(([skill,demand])=>`${filterLabel(skill)}: ${number(demand)} заявок`).join('; ')} — состав пока не оценён: нет данных о производительности.</p>:null}
      <p className="staff-insight-note">Состав оценён по навыкам и нагрузке. Резерв — сверх среднего спроса; маршруты проверяются отдельно.</p></>;
  }
  const scenario=model.scenario;
  const current=model.ready&&scenario.ratingVersion===model.version&&scenario.sourceHash===data.sourceHash&&scenario.sourceRevision===data.sourceRevision&&scenario.pool===model.pool&&scenario.settings?.qualityFloor===model.qualityFloor&&(scenario.settings?.qualityCeiling??5)===model.qualityCeiling;
  const profiles=current?scenario.staffing?.breakdown:data.breakdown;
  const zones=groupStaffingNeeds(profiles||[]);
  return <><div className="staff-insight-period">{date(model.date)}<small>{current?'По проверенному плану':'Предварительно по профилям дня'}</small></div>{conditions}
    {!zones.length?<p className="staff-insight-note">{data.orders?'Сначала постройте точный план дня в «Заявках».':'На этот день нет заявок — потребность пока не определена.'}</p>:<><div className="staff-insight-columns"><span>Район</span><span>Нужно / доступно</span></div><div className="staff-insight-zones">{zones.map(zone=><article key={zone.zone}><div><b>{zone.zone}</b><span>{zone.needed} / {zone.available}</span></div>{zone.shortage?<><span className="staff-insight-gap">Дефицит: {zone.shortage} специалистов</span><details className="staff-insight-gaps"><summary>Каких специалистов не хватает</summary>{zone.gaps.map((gap,index)=><small key={index}>{gap.skills.map(filterLabel).join(' · ')} — {gap.count}</small>)}</details></>:<span className="staff-insight-ok"><Check size={13}/>Дефицита нет</span>}</article>)}</div><p className="staff-insight-note">Сопоставляем навыки, домашний старт, транспорт и смену. Доступные люди другого профиля не закрывают местный дефицит.{!current?' Назначения ещё нужно проверить маршрутами.':''}</p></>}
  </>;
}

export function StaffingCoverageInfo({model}) {return <InsightPopover model={model} kind="coverage"/>;}
export function StaffingForecastButton({model}) {return <InsightPopover model={model} kind="forecast"/>;}
