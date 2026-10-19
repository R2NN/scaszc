import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ArrowRight, Car, Check, ChevronRight, Clock3, DoorOpen, ArrowLeftRight, Footprints, MapPin, Plus, Route, Search, TrainFront, Undo2, Users, X } from 'lucide-react';
import { transportMap } from './TransportMap.jsx';
import { transportStatus,transportFocusSegments } from './transportDomain.js';
import { shiftClock } from './shiftClock.js';
import { adoptDispatchClock } from './dispatchClockSync.js';
import { minuteOf, timeOf } from './shiftDomain.js';
import { ratingName } from './engineerPresentation.js';
import './transport.css';

const sessions=new Map();
const kindLabel={road:'Автомобильная дорога',metro:'Участок метро',transfer:'Пересадка',entry:'Вход и выход станции'};
const endLabel=event=>event.endsAt?`${event.endsAt.slice(0,10)!==event.startsAt.slice(0,10)?event.endsAt.slice(0,10).split('-').reverse().join('.')+' · ':''}${event.endsAt.slice(11,16)}`:'окончание неизвестно';
const directionLabel=event=>event.kind==='entry'?'Вход и выход':event.kind==='road'&&event.segments.every(s=>!s.opposingEdgeId)?'Односторонний проезд':event.direction==='both'?'Все разрешённые направления':'По направлению стрелок';
const restrictionIcon=kind=>kind==='road'?<Car/>:kind==='entry'?<DoorOpen/>:kind==='transfer'?<ArrowLeftRight/>:<TrainFront/>;
const keepInputVisible=element=>{
  if(!element?.matches('input,select,textarea'))return;
  const scroller=element.closest('.shift-panel-body,.transport-workspace-scroll');if(!scroller)return;
  const bounds=scroller.getBoundingClientRect(),rect=(element.closest('label')||element).getBoundingClientRect(),scale=bounds.height/scroller.offsetHeight;
  const footer=scroller.querySelector('.transport-form-footer')?.getBoundingClientRect();
  const top=bounds.top+12,bottom=Math.min(bounds.bottom-12,footer?.top||bounds.bottom-12);
  if(rect.top<top)scroller.scrollTop+=(rect.top-top)/scale;
  else if(rect.bottom>bottom)scroller.scrollTop+=(rect.bottom-bottom)/scale;
};
const signed=value=>`${value>0?'+':''}${value}`;
const api=async(path,body)=>{
  const response=await fetch(`/api/transport/${path}`,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);
  const value=await response.json();if(!response.ok)throw new Error(value.error || 'Транспортный сервис недоступен');return value;
};
const inputOf=(event,actor)=>({id:event.id,expectedRevision:event.revision,title:event.title,reason:event.reason,kind:event.kind,direction:event.direction,
  startsAt:event.startsAt,endsAt:event.endsAt,segmentIds:event.segments.map(s=>s.id),source:event.source,externalId:event.externalId,status:event.status,actor});

/** Shared planned/live transport workflow over one durable event API. */
export function TransportPanel({shift,live=false,active=true,actor='Диспетчер',onApply,onScenarioEvent}) {
  const clock=useSyncExternalStore(shiftClock.subscribe,shiftClock.getSnapshot);
  const [catalog,setCatalog]=useState(null),[events,setEvents]=useState([]),[draft,setDraft]=useState(()=>sessions.get(`${shift?.id}:${live}`)?.draft || null);
  const [selected,setSelected]=useState(null),[preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[drawing,setDrawing]=useState(false),[showEnded,setShowEnded]=useState(false),[stationFrom,setStationFrom]=useState('');
  const [engineerId,setEngineerId]=useState(''),[orderId,setOrderId]=useState(''),[pauseNotice,setPauseNotice]=useState(false);
  const [whenMode,setWhenMode]=useState(live?'now':'planned');
  const [browse,setBrowse]=useState(false);
  const generation=useRef(0),previewRef=useRef(null),resumeRef=useRef(null),refs=useRef({});
  const [elapsed,setElapsed]=useState(0);
  const [scenario,setScenario]=useState(null),[scenarioBusy,setScenarioBusy]=useState(false);
  const resultRef=useRef(null),groupRef=useRef(null);
  const [eventGroup,setEventGroup]=useState([]);
  const openGroup=items=>{setEventGroup(items);requestAnimationFrame(()=>groupRef.current?.scrollIntoView({block:'nearest'}));};
  useEffect(()=>{
    if(!active||!preview?.result)return;
    const frame=requestAnimationFrame(()=>{if(draft)keepInputVisible(document.activeElement);else resultRef.current?.scrollIntoView({block:'start',behavior:'instant'});});
    return()=>cancelAnimationFrame(frame);
  },[active,preview?.id,Boolean(preview?.result),Boolean(draft)]);
  const date=shift?.date;
  const minute=live?Math.floor(clock.minute):360;
  const load=async()=>{if(!shift?.id)return;const id=shift.id,result=await api(`events?shiftId=${encodeURIComponent(id)}`);if(refs.current.shift?.id===id)setEvents(result.events);};
  useEffect(()=>{let active=true;(async()=>{try{const value=await api('catalog');if(active)setCatalog(value);}catch(e){if(active)setError(e.message);}})();return()=>{active=false;};},[]);
  useEffect(()=>{
    const own=++generation.current;setEvents([]);setPreview(null);setSelected(null);setScenario(null);setEventGroup([]);setDraft(sessions.get(`${shift?.id}:${live}`)?.draft || null);
    load().catch(e=>setError(e.message));
    if(shift?.id)(async()=>{try{const saved=await api(`previews/latest?shiftId=${shift.id}`);if(saved&&refs.current.shift?.id===shift.id&&own===generation.current){setPreview(saved);previewRef.current=saved;setEngineerId(saved.result?.consequences?.engineers[0]?.engineerId || '');}}catch(e){if(own===generation.current)setError(e.message);}})();
    if(live&&shift?.id)(async()=>{try{const value=await api(`scenario?shiftId=${shift.id}`);if(refs.current.shift?.id===shift.id)setScenario(value);}catch(e){setError(e.message);}})();
  },[shift?.id]);
  useEffect(()=>{if(shift?.id)sessions.set(`${shift.id}:${live}`,{draft});},[draft,shift?.id,live]);
  const begin=(kind='road')=>{
    if(!shift?.plan){setError('Выберите день с опубликованным планом');return;}
    roadRequest.current++;clearPreview();setSelected(null);setSearch('');setError('');setStationFrom('');
    setDraft({id:crypto.randomUUID(),title:'',reason:'',kind,direction:'both',startsAt:`${date}T${live?timeOf(minute):'09:30'}:00+03:00`,endsAt:`${date}T${live?timeOf(Math.min(1439,minute+45)):'10:15'}:00+03:00`,segments:[],source:'Диспетчер',actor,status:'OPEN'});
    setWhenMode(live?'now':'planned');setDrawing(true);
  };
  const clearPreview=()=>{generation.current++;const old=previewRef.current;previewRef.current=null;setPreview(null);if(old&&['RUNNING','READY'].includes(old.status))api(`previews/${old.id}/cancel`,{}).catch(()=>{});};
  const change=patch=>{if(patch.kind)roadRequest.current++;clearPreview();setError('');setDraft(value=>({...value,...patch}));};
  const selectSegment=segment=>{
    if(!segment)return;
    const value=segment.kind?segment:{...segment,kind:'entry',fromId:segment.id,toId:null,geometry:[segment.coords]};
    setDraft(current=>current&&!current.segments.some(s=>s.id===value.id)?{...current,segments:[...current.segments,value]}:current);
    clearPreview();setError('');
  };
  const roadRequest=useRef(0),roadSequence=useRef(0),roadPending=useRef(0);
  const selectRoad=async coords=>{
    const id=roadRequest.current,formId=draft?.id,sequence=roadSequence.current++;roadPending.current++;setBusy(true);setError('');setPreview(null);
    try{const segment=await api('snap',{coords});if(id===roadRequest.current)setDraft(current=>current?.id===formId&&current.kind==='road'&&!current.segments.some(s=>s.id===segment.id)?{...current,segments:[...current.segments,{...segment,selectionOrder:sequence}].sort((a,b)=>(a.selectionOrder||0)-(b.selectionOrder||0))}:current);}
    catch(e){if(id===roadRequest.current)setError(e.message);}
    finally{roadPending.current--;if(!roadPending.current)setBusy(false);}
  };
  const selectStation=id=>{
    if(!stationFrom){setStationFrom(id);return;}
    const segment=catalog?.segments.find(s=>s.kind===draft?.kind&&((s.fromId===stationFrom&&s.toId===id)||(s.bidirectional&&s.toId===stationFrom&&s.fromId===id)));
    if(segment){selectSegment(segment);setStationFrom('');}else{setError('Выберите соседнюю станцию: для длинного участка добавьте связи последовательно');setStationFrom(id);}
  };
  const selectEvent=event=>{if(!event||event.id==='draft')return;if(draft){setError('Сохраните ограничение или нажмите «Отмена», чтобы открыть другое событие');return;}setSelected(event);setDrawing(false);clearPreview();setSearch('');transportMap.focus(event.segments);};
  const editEvent=event=>{setSelected(null);setDraft({...event,expectedRevision:event.revision});setDrawing(true);clearPreview();};
  const pause=async()=>{
    if(!live)return;
    const current=shiftClock.getSnapshot();
    if(current.playing){resumeRef.current={playing:current.playing,speed:current.speed};shiftClock.set({playing:false});setPauseNotice(true);}
    if(shift.regionId.includes(':scenario:'))await fetch(`/api/dispatch/shifts/${shift.id}/clock`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...shiftClock.getSnapshot(),playing:false})});
  };
  const restorePlayback=async()=>{
    const saved=resumeRef.current;if(!saved)return;
    try{
      let patch=saved;
      if(shift.regionId.includes(':scenario:')){
        const response=await fetch(`/api/dispatch/shifts/${shift.id}/clock`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...shiftClock.getSnapshot(),...saved})});
        const result=await response.json();if(!response.ok)throw new Error(result.error || 'Не удалось восстановить воспроизведение');patch=result.clock || saved;
      }
      shiftClock.set(patch);resumeRef.current=null;setPauseNotice(false);
    }catch(e){setError(`План сохранён. ${e.message}; продолжить воспроизведение можно кнопкой на шкале времени.`);}
  };
  const calculate=async()=>{
    if(!shift?.plan)return;
    const own=++generation.current;
    if(previewRef.current?.status==='RUNNING')await api(`previews/${previewRef.current.id}/cancel`,{}).catch(()=>{});
    setError('');
    try {
      await pause();
      const earliest=Math.max(minuteOf(shift.versions?.at(-1)?.effectiveAt) || 0,minuteOf(shift.plan.createdAt?.slice(11,16)) || 0);
      const time=live?timeOf(Math.floor(shiftClock.getSnapshot().minute)):timeOf(Math.max(earliest,360));
      const value=await api('previews',{shiftId:shift.id,expectedRevision:shift.revision,time,live,
        draft:draft?{...inputOf({...draft,revision:draft.expectedRevision},actor),expectedRevision:draft.expectedRevision}:null});
      if(own!==generation.current){await api(`previews/${value.id}/cancel`,{});return;}
      setPreview(value);previewRef.current=value;
    }catch(e){if(own===generation.current)setError(e.message);}
  };
  refs.current={calculate,shift};
  const draftSignature=JSON.stringify(draft);
  useEffect(()=>{
    if(!draft?.title.trim()||!draft.segments.length)return;
    const timer=setTimeout(()=>refs.current.calculate(),900);
    return()=>{clearTimeout(timer);generation.current++;if(previewRef.current?.status==='RUNNING')api(`previews/${previewRef.current.id}/cancel`,{}).catch(()=>{});};
  },[draftSignature]);
  useEffect(()=>{
    if(preview?.status!=='RUNNING')return;
    let alive=true;const own=generation.current;
    const poll=async()=>{
      try{const value=await api(`previews/${preview.id}`);if(alive&&own===generation.current){setPreview(value);previewRef.current=value;if(value.status==='READY'){setSelected(null);setEngineerId(value.result.consequences.engineers[0]?.engineerId || '');}}}
      catch(e){if(alive)setError(e.message);}
    };
    const timer=setInterval(poll,1300),tick=setInterval(()=>setElapsed(Math.floor((Date.now()-preview.startedAt)/1000)),1000);
    poll();return()=>{alive=false;clearInterval(timer);clearInterval(tick);};
  },[preview?.id,preview?.status]);
  useEffect(()=>()=>{generation.current++;transportMap.set({enabled:false,onRoad:null,onSegment:null,onSelect:null,onGroup:null});},[]);
  useEffect(()=>{
    transportMap.set({enabled:active,catalog,events,draft,editingId:draft?.expectedRevision?draft.id:null,preview,date,minute,showEnded,engineerId,
      drawing,kind:draft?.kind,onRoad:selectRoad,onSegment:selectSegment,onStation:selectStation,onSelect:selectEvent,onGroup:openGroup,onNew:()=>begin(),
      onUndo:()=>change({segments:draft?.segments.slice(0,-1)||[]}),onKind:kind=>{if(!draft)begin(kind);else{change({kind,segments:[]});setDrawing(true);}}});
  },[active,catalog,events,draft,preview,date,minute,drawing,showEnded,engineerId,stationFrom]);
  const save=async()=>{
    setBusy(true);setError('');
    try{const event=await api('events',{shiftId:shift.id,event:{...inputOf({...draft,revision:draft.expectedRevision},actor),expectedRevision:draft.expectedRevision}});
      await load();setSelected(event);setDraft(null);setDrawing(false);
      if(preview?.id){const refreshed=await api(`previews/${preview.id}`);setPreview(refreshed);previewRef.current=refreshed;}
    }catch(e){setError(e.message);}finally{setBusy(false);}
  };
  const endEvent=async(status)=>{
    setBusy(true);setError('');
    try{const event=await api('events',{shiftId:shift.id,event:{...inputOf(selected,actor),status,...(status==='ENDED'?{endsAt:`${date}T${timeOf(Math.max(minuteOf(selected.startsAt.slice(11,16))||0,Math.floor(shiftClock.getSnapshot().minute)))}:00+03:00`}:{})}});await load();setSelected(event);setPreview(null);}
    catch(e){setError(e.message);}finally{setBusy(false);}
  };
  const apply=async()=>{
    setBusy(true);setError('');
    try{const result=await api(`previews/${preview.id}/apply`,{time:live?timeOf(Math.floor(shiftClock.getSnapshot().minute)):preview.time,actor});setPreview(result.preview);if(result.state)setScenario(result.state);onApply?.(result.shift);
      if(resumeRef.current)await restorePlayback();}
    catch(e){setError(e.message);}finally{setBusy(false);}
  };
  const startScenario=async(variant='sequential')=>{
    setScenarioBusy(true);setError('');
    try{const result=await api(variant==='simultaneous'?'scenario/dual':'scenario/start',{baseShiftId:shift.id});setScenario(result.state);onApply?.(result.shift);if(!adoptDispatchClock(result.shift.id,{...result.clock,playing:false}))shiftClock.set({...result.clock,playing:false});
      if(result.events?.length){const value=await api('previews',{shiftId:result.shift.id,expectedRevision:result.shift.revision,time:timeOf(result.clock.minute),live:true});setPreview(value);previewRef.current=value;transportMap.focus(result.events.flatMap(e=>e.segments));}}
    catch(e){setError(e.message);}finally{setScenarioBusy(false);}
  };
  const nextWave=async(automatic=false)=>{
    setScenarioBusy(true);setError('');
    try{
      const result=await api(automatic?'scenario/tick':'scenario/next',{shiftId:shift.id,minute:Math.floor(shiftClock.getSnapshot().minute)});
      setScenario(result.state);if(!result.event)return;
      onScenarioEvent?.();
      if(!adoptDispatchClock(result.shift.id,{...result.clock,playing:false}))shiftClock.set({...result.clock,playing:false});onApply?.(result.shift);await load();setSelected(result.event);setDraft(null);setDrawing(false);transportMap.focus(result.event.segments);
      const value=await api('previews',{shiftId:shift.id,expectedRevision:result.shift.revision,time:timeOf(Math.floor(result.clock.minute)),live:true});
      setPreview(value);previewRef.current=value;
    }catch(e){setError(e.message);}finally{setScenarioBusy(false);}
  };
  useEffect(()=>{
    const receive=event=>{
      const result=event.detail;if(result?.shift?.id!==shift?.id)return;
      generation.current++;setScenario(result.state);load().catch(error=>setError(error.message));
      if(result.preview){setPreview(result.preview);previewRef.current=result.preview;setEngineerId('');setOrderId('');setSelected(result.event);transportMap.focus(result.event.segments);}
      onScenarioEvent?.();
    };
    window.addEventListener('beego:transport-scenario',receive);
    return()=>window.removeEventListener('beego:transport-scenario',receive);
  },[shift?.id]);
  const visible=events.filter(e=>(showEnded||!['Завершено','Отменено'].includes(transportStatus(e,date,minute)))&&(filter==='all'||(filter==='metro'?e.kind!=='road':e.kind===filter))&&`${e.title} ${e.reason}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')));
  const results=catalog&&draft&&draft.kind!=='road'&&search.trim()? [...(draft.kind==='entry'?catalog.stations:catalog.segments.filter(s=>s.kind===draft.kind))].filter(s=>s.name.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))).slice(0,12):[];
  const consequences=preview?.result?.consequences,engineer=consequences?.engineers.find(e=>e.engineerId===engineerId)||consequences?.engineers[0];
  const firstOrder=consequences?.orders.find(o=>o.orderId===orderId&&o.engineerId===engineer?.engineerId&&!o.lost)||consequences?.orders.find(o=>o.engineerId===engineer?.engineerId&&!o.lost);
  const itinerary=(firstOrder?.stepsAfter || []).filter(s=>s.seconds>0).reduce((groups,step)=>{
    const last=groups.at(-1);if(last&&last.mode===step.mode&&last.lineId===step.lineId&&last.line===step.line){last.seconds+=step.seconds;last.to=step.to || last.to;}else groups.push({...step});return groups;
  },[]);
  return <div onFocusCapture={event=>{const element=event.target;requestAnimationFrame(()=>keepInputVisible(element));}} className={`transport-panel-content ${live?'live':''} ${consequences?'has-result':''} ${draft?'editing':''}`}>
    {live&&date==='2026-08-17'?<section className='transport-scenario'><div className='transport-section-title'><div><small>ИЗОЛИРОВАННЫЙ ПОКАЗ · 17 АВГУСТА</small><h3>{scenario?.variant==='simultaneous'?'Дорога и метро одновременно':'Пять событий одного дня'}</h3></div><Route size={21}/></div>{scenario?<><details><summary>{scenario.index<0?'Список пяти событий':`Событие ${scenario.index+1} из ${scenario.waves.length} · ${scenario.waves[scenario.index].time}`}</summary><div className='transport-timeline'>{scenario.waves.map(w=><button key={w.index} className={w.index===scenario.index?'current':''} disabled={!w.eventId} onClick={()=>{const event=events.find(e=>e.id===w.eventId);if(event)selectEvent(event);}}><time>{w.time}</time><span>{w.title}</span><small>{w.status==='APPLIED'?'Применено':w.eventId?'К событию':'Впереди'}</small></button>)}</div></details><button disabled={scenarioBusy||preview?.status==='RUNNING'} onClick={()=>nextWave(false)}>{scenarioBusy?'Готовим событие по текущим маршрутам…':scenario.index>=scenario.waves.length-1?'Завершить показ':'Следующее событие'}<ChevronRight size={16}/></button></>:<><p>Последовательные перекрытия дороги, метро и пересадки. Каждое выбирается по реальному оставшемуся пути.</p><button disabled={scenarioBusy} onClick={startScenario}>{scenarioBusy?'Подготавливаем смену…':'Запустить транспортный показ'}</button></>}</section>:null}
    {live&&date==='2026-08-17'?<details className='transport-scenario-alternatives'><summary>Другие варианты показа</summary><button disabled={scenarioBusy||preview?.status==='RUNNING'} onClick={()=>startScenario('simultaneous')}>Одновременное перекрытие дороги и метро</button><button disabled={scenarioBusy||preview?.status==='RUNNING'} onClick={()=>startScenario('sequential')}>Новая сессия из пяти событий</button><small>Текущая история сохранится. Создаётся отдельная демонстрационная смена.</small></details>:null}
    {eventGroup.length&&!draft?<section ref={groupRef} className='transport-event-group'><div className='transport-section-title'><h3>Ограничения в точке ({eventGroup.length})</h3><button onClick={()=>setEventGroup([])} aria-label='Закрыть группу ограничений'><X size={18}/></button></div>{eventGroup.map(event=><button key={event.id} onClick={()=>{setEventGroup([]);selectEvent(event);}}>{restrictionIcon(event.kind)}<span><b>{event.title}</b><small>{kindLabel[event.kind]} · {event.startsAt.slice(11,16)}–{endLabel(event)}</small></span><ChevronRight size={16}/></button>)}</section>:null}
    {consequences&&!draft?<button className='transport-browse' onClick={()=>setBrowse(value=>!value)}>{browse?'Скрыть поиск':'Найти или добавить ограничение'}</button>:null}
    {!draft&&(!consequences||browse)?<div className='transport-intro'><div><b>{live?'Движение в течение смены':'Доступность дорог и метро'}</b><p>{live?'Закрытия, проверенные объезды и последствия для заявок':'Планируйте перекрытия на выбранный день'}</p></div><button className='transport-add' onClick={()=>begin()} aria-label='Добавить транспортное ограничение'><Plus size={18}/></button></div>:null}
    {pauseNotice?<div className='transport-clock-notice'><Clock3 size={16}/><span>Сценарий на паузе: фиксируем положение для проверки.</span><button onClick={restorePlayback}>Продолжить</button></div>:null}
    {error?<div className='transport-error' role='alert'><AlertTriangle size={18}/><span>{error}</span><button onClick={()=>setError('')} aria-label='Закрыть сообщение'><X size={15}/></button></div>:null}
    {!draft?<>
      <div className={`transport-search ${consequences&&!browse?'transport-collapsed':''}`}><Search size={17}/><input aria-label='Поиск транспортных ограничений' placeholder='Название, причина ограничения' value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <div className={`transport-filter ${consequences&&!browse?'transport-collapsed':''}`}><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>Все</button><button className={filter==='road'?'active':''} onClick={()=>setFilter('road')}><Car size={16}/>Авто</button><button className={filter==='metro'?'active':''} onClick={()=>setFilter('metro')}><TrainFront size={16}/>Метро</button><label><input type='checkbox' checked={showEnded} onChange={e=>setShowEnded(e.target.checked)}/>Завершённые</label></div>
      <div className='transport-event-list'>{visible.map(event=><button key={event.id} className={`transport-event ${event.id===selected?.id?'selected':''}`} onClick={()=>selectEvent(event)}><span className={`transport-type-icon ${event.kind}`}>{restrictionIcon(event.kind)}</span><span><small className={transportStatus(event,date,minute)==='Действует'?'active':''}>{transportStatus(event,date,minute)}</small><strong>{event.title}</strong><em>{event.startsAt.slice(11,16)}–{endLabel(event)} · {directionLabel(event)}</em></span><ChevronRight size={17}/></button>)}</div>
      {!visible.length?<div className='transport-empty'><Route size={36}/><h3>Дороги под контролем</h3><p>Добавьте участок дороги, закрытие метро или пересадки. Система проверит оставшиеся маршруты по сети.</p><button onClick={()=>begin()}><Plus size={17}/>Добавить ограничение</button></div>:null}
      {selected?<section className='transport-detail'><div className='transport-section-title'><h3>{kindLabel[selected.kind]}</h3><button onClick={()=>setSelected(null)} aria-label='Закрыть карточку ограничения'><X size={18}/></button></div><p>{selected.reason}</p><dl><div><dt>Участок</dt><dd>{selected.segments.map(s=>s.name).join(', ')}</dd></div><div><dt>Направление</dt><dd>{directionLabel(selected)}</dd></div><div><dt>Источник</dt><dd>{selected.source}</dd></div><div><dt>Действует</dt><dd>{selected.startsAt.slice(0,10)} · {selected.startsAt.slice(11,16)}–{endLabel(selected)}</dd></div><div><dt>Транспорт</dt><dd>{selected.kind==='road'?'Автомобили · пешеходам проход открыт':'Общественный транспорт'}</dd></div></dl><div className='transport-actions'><button onClick={()=>transportMap.focus(selected.segments)}><MapPin size={16}/>На карте</button><button onClick={()=>editEvent(selected)}>Изменить / продлить</button></div><div className='transport-actions'><button disabled={busy||selected.status!=='OPEN'||transportStatus(selected,date,minute)==='Запланировано'} onClick={()=>endEvent('ENDED')}>Завершить событие</button><button disabled={busy||selected.status!=='OPEN'} onClick={()=>endEvent('CANCELLED')}>Отменить событие</button></div><button className='transport-primary full' onClick={calculate} disabled={preview?.status==='RUNNING'}><Route size={17}/>Проверить последствия</button></section>:null}
    </>:<>
      <div className='transport-modes'><button className={draft.kind==='road'?'active':''} onClick={()=>change({kind:'road',segments:[]})}><Car/>Авто</button><button className={draft.kind!=='road'?'active':''} onClick={()=>change({kind:'metro',segments:[]})}><b>M</b>Метро</button>{draft.kind==='road'?<span><Footprints size={20}/>Проход открыт</span>:null}</div>
      <section className='transport-form'><div className='transport-section-title'><h3>{draft.expectedRevision?'Изменить ограничение':'Новое перекрытие'}</h3><button onClick={()=>{roadRequest.current++;setDraft(null);setDrawing(false);clearPreview();}} aria-label='Отменить ввод ограничения'><X size={18}/></button></div>
        <label>Название<input value={draft.title} placeholder={draft.kind==='road'?'Например, ремонт проезжей части':'Например, закрыт участок линии'} onChange={e=>change({title:e.target.value})} maxLength={160}/></label>
        {draft.kind!=='road'?<label>Что закрыто<select value={draft.kind} onChange={e=>{change({kind:e.target.value,segments:[]});setSearch('');}}><option value='metro'>Движение между станциями</option><option value='transfer'>Пересадка между линиями</option><option value='entry'>Вход и выход станции</option></select></label>:null}
        <div className='transport-when'><button className={whenMode==='planned'?'active':''} onClick={()=>{setWhenMode('planned');change({startsAt:`${date}T${live?timeOf(Math.min(1439,minute+30)):'09:30'}:00+03:00`,endsAt:live&&minute>=1350?null:`${date}T${live?timeOf(minute+90):'10:15'}:00+03:00`});}}><Clock3 size={17}/>Запланировано</button><button className={whenMode==='now'?'active':''} onClick={()=>{setWhenMode('now');change({startsAt:`${date}T${timeOf(Math.floor(clock.minute))}:00+03:00`,endsAt:null});}}>Сейчас</button></div>
        <div className='transport-time-grid'><label>Начало<input aria-label='Начало ограничения' type='datetime-local' value={draft.startsAt.slice(0,16)} onChange={e=>change({startsAt:`${e.target.value}:00+03:00`})}/></label><label>Окончание<input aria-label='Окончание ограничения' disabled={!draft.endsAt} type='datetime-local' value={draft.endsAt?.slice(0,16)||''} onChange={e=>change({endsAt:`${e.target.value}:00+03:00`})}/></label></div>
        <label className='transport-check'><input type='checkbox' checked={!draft.endsAt} onChange={e=>change({endsAt:e.target.checked?null:`${date}T${timeOf(Math.min(1439,(minuteOf(draft.startsAt.slice(11,16))||0)+60))}:00+03:00`})}/>Окончание неизвестно</label>
        {draft.kind!=='entry'?<label>Направление движения<select value={draft.direction} onChange={e=>change({direction:e.target.value})}><option value='both'>↕ В обоих направлениях</option><option value='forward'>→ По выбранному направлению</option>{draft.kind==='road'?<option value='reverse'>← В обратном направлении</option>:null}</select></label>:null}
        <details className='transport-extra'><summary>Причина и источник</summary><label>Причина<input value={draft.reason} placeholder='Краткое пояснение для диспетчера' onChange={e=>change({reason:e.target.value})}/></label><label>Источник<input value={draft.source} maxLength={160} onChange={e=>change({source:e.target.value})}/></label></details>
        <div className='transport-mode-note'>{draft.kind==='road'?<Car size={18}/>:<TrainFront size={18}/>}<span>{draft.kind==='road'?'Автомобили · пешеходам проход открыт':draft.kind==='entry'?'Вход и выход закрыты · движение поездов сохраняется':draft.kind==='transfer'?'Закрыта только выбранная пересадка':'Закрыто движение на выбранных связях'}</span></div>
      </section>
      {draft.kind!=='road'?<><div className='transport-search'><Search size={17}/><input aria-label='Поиск станции или участка метро' placeholder='Название станции или пересадки' value={search} onChange={e=>setSearch(e.target.value)}/></div>{results.length?<div className='transport-station-results'>{results.map(s=><button key={s.id} onClick={()=>{selectSegment(s);setSearch('');}}><b>M</b><span>{s.name}<small>{catalog?.lines?.[s.lineId]?.name || ''}</small></span><Plus size={15}/></button>)}</div>:null}</>:null}
      <div className='transport-selection'><span><strong>{draft.segments.length?`Выбрано ${draft.segments.length} ${draft.kind==='entry'?'станций':'участков'}`:'Участок ещё не выбран'}</strong><small>{busy?'Привязываем к дорожной сети…':draft.segments.map(s=>s.name).join(' → ')||'Выберите на карте; координаты вводить не нужно'}</small></span><button disabled={!draft.segments.length} onClick={()=>change({segments:draft.segments.slice(0,-1)})} aria-label='Отменить выбор последнего участка'><Undo2 size={18}/></button><button onClick={()=>setDrawing(v=>!v)}>{drawing?'Готово':'Изменить участок'}</button></div>
      {stationFrom?<p className='transport-source-note'>Выбрана первая станция. Нажмите соседнюю станцию.</p>:null}
    </>}
    {preview?.status==='RUNNING'?<section className='transport-calculating' role='status'><i className='spinner'/><div><b>{preview.phase}</b><p>Факты и опубликованный план сохранены · {elapsed} с</p></div><button onClick={async()=>{await api(`previews/${preview.id}/cancel`,{});setPreview(null);}}>Отмена</button></section>:null}
    {preview?.status==='FAILED'?<div className='transport-error' role='alert'><AlertTriangle size={18}/><span>{preview.error}</span><button onClick={calculate}>Повторить</button></div>:null}
    {consequences?<section ref={resultRef} className='transport-result'><header><span className='transport-check-icon'><Check/></span><div><h3>{preview.status==='APPLIED'?'Изменения применены':'Пересчёт готов'}</h3><p>{consequences.lost?'Часть заявок не имеет допустимого назначения — требуется решение':consequences.engineers.length?'Найден и независимо проверен допустимый путь':'Текущий план проверен: изменения пути не требуются'}</p></div></header>
      <div className={`transport-outcome ${consequences.lost||consequences.late||consequences.overtime?'warning':''}`}><Check size={18}/><span>{consequences.lost?`${consequences.lost} назначений потеряно`:consequences.late?`${consequences.late} нарушений клиентского окна`:consequences.overtime?`${consequences.overtime} бригад выйдут за смену`:consequences.unknownWindows?'Назначения сохранены · часть клиентских окон неизвестна':'Назначения сохранены · клиентские окна соблюдены'}</span></div>
      {engineer?<><label className='transport-engineer'>{engineer.transport==='CAR'?<Car size={18}/>:<TrainFront size={18}/>}<select aria-label='Затронутый инженер' value={engineer.engineerId} onChange={e=>{setEngineerId(e.target.value);setOrderId('');}}>{consequences.engineers.map(e=><option key={e.engineerId} value={e.engineerId}>{ratingName(shift.team.find(t=>t.id===e.engineerId)||{name:e.name})}</option>)}</select><span>{engineer.transport==='CAR'?'Авто':'Общественный транспорт'}</span></label>{firstOrder?<div className='transport-eta'><div><small>Было прибытие</small><b>{firstOrder.before}</b></div><ArrowRight/><div><small>Новое прибытие</small><b>{firstOrder.after}</b></div><strong>{signed(firstOrder.delta)} мин</strong></div>:null}</>:null}
      <div className='transport-metrics'><div><Users/><b>{consequences.engineers.length}</b><span>инженеров затронуто</span></div><div><Clock3/><b>{signed(consequences.addedTravelMinutes)} мин</b><span>сумма оставшегося движения</span></div></div>

      {engineer?<p className='transport-source-note'>Оставшийся путь: {engineer.beforeMinutes} → {engineer.afterMinutes} мин · {(engineer.beforeDistanceM/1000).toFixed(1)} → {(engineer.afterDistanceM/1000).toFixed(1)} км</p>:null}
      {engineer?<button className='transport-show-route' onClick={()=>transportMap.focus(transportFocusSegments({orders:consequences.orders.filter(o=>o.engineerId===engineer.engineerId),events,draft,selected,date,minute,transport:engineer.transport}))}><Route size={16}/>Показать проверенный путь</button>:null}
      {itinerary.length?<details className='transport-itinerary'><summary>Как проходит путь</summary>{itinerary.map((step,index)=><div key={index}><span>{['walking','pedestrian','walking_transfer'].includes(step.mode)?<Footprints size={15}/>:step.mode==='metro'?<b>M</b>:<Clock3 size={15}/>}</span><span>{step.mode==='metro'?(catalog?.lines?.[step.lineId]?.name || 'Метро'):({metro_wait_model:'Ожидание поезда · модель',walking_transfer:'Пешая пересадка',walking:'Пешком',pedestrian:'Пешком',waiting:'Ожидание транспорта',station_entry:'Вход на станцию',station_exit:'Выход со станции',auto:'Автомобиль',bicycle:'Велосипед'})[step.mode] || step.line || 'Наземный транспорт'}{step.from||step.to?<small>{step.from} → {step.to}</small>:null}</span><strong>{Math.ceil(step.seconds/60)} мин</strong></div>)}</details>:null}
      {consequences.orders.length?<div className='transport-impacts'><h4>Затронутые заявки ({consequences.orders.length})</h4>{consequences.orders.map(o=><button key={o.orderId} aria-pressed={o.orderId===firstOrder?.orderId} onClick={()=>{setEngineerId(o.engineerId);setOrderId(o.orderId);if(o.geometryAfter)transportMap.focus(transportFocusSegments({orders:[o],events,draft,selected,date,minute,transport:shift.team.find(person=>person.id===o.engineerId)?.transport}));}}><span>{o.address || o.orderId}</span><b>{o.lost?'Нет назначения':`${signed(o.delta)} мин`}</b><small className={o.lost||o.lateMinutes>0?'warning':''}>{o.lost?'Нужно решение':o.lateMinutes==null?'Окно неизвестно':o.lateMinutes>0?`Опоздание ${o.lateMinutes} мин`:'В окне'}</small></button>)}</div>:null}

      {engineer&&(engineer.beforeWaitingMinutes||engineer.afterWaitingMinutes)?<p className='transport-source-note'>Ожидание транспорта отдельно: {engineer.beforeWaitingMinutes} → {engineer.afterWaitingMinutes} мин</p>:null}
      <details><summary>Что проверено</summary><p>Независимый валидатор плана: {preview.result.plan.validation.status}. Запреты сети: {preview.result.audit.status}. Территории, навыки, оснащение, транспорт и история визитов сохраняются. Метро использует модель ожидания поезда из локального индекса.</p></details>
    </section>:null}
    {!draft&&preview?.status==='READY'?<footer className='transport-decision-bar'><span>{preview.requiresSave?'Сохраните ограничение и повторите проверку':`Проверено на ${preview.time} · версия ${preview.baseRevision}`}</span><button className='transport-primary full' disabled={busy||preview.requiresSave} onClick={apply}>Применить изменения плана</button></footer>:null}
    {draft?<footer className='transport-form-footer'><button className='transport-primary' disabled={busy||!draft.title.trim()||!draft.segments.length} onClick={save}>Сохранить ограничение</button><button onClick={()=>{setDraft(null);clearPreview();setDrawing(false);}}>Отмена</button></footer>:null}
    <p className='transport-source-note'>Europe/Moscow · дата {date?.split('-').reverse().join('.')} · источник сети: OpenStreetMap / Московский метрополитен</p>
  </div>;
}

/** Dedicated preparation workspace; the original planning Constraints screen is preserved. */
export function TransportWorkspace({shift,actor,onApply,onClose,motionClass=''}) {
  const [base,setBase]=useState(null),[loadError,setLoadError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{
    let active=true;setBase(null);setLoadError('');setLoading(true);
    (async()=>{try{const response=await fetch(`/api/shifts?regionId=${encodeURIComponent(shift?.regionId?.split(':')[0] || 'moscow')}&date=${shift?.date || ''}`);const value=await response.json();if(!response.ok)throw new Error(value.error);if(active)setBase(value);}catch(error){if(active)setLoadError(error.message);}finally{if(active)setLoading(false);}})();
    return()=>{active=false;};
  },[shift?.date,shift?.regionId?.split(':')[0]]);
  return <div className={`transport-workspace ${motionClass}`}><section className='transport-workspace-panel'><header><div><small>ПОДГОТОВКА СМЕНЫ</small><h2>Транспортные ограничения</h2><p>{shift?.date?.split('-').reverse().join('.')} · дороги и метро</p></div><button onClick={onClose} aria-label='Закрыть транспортные ограничения'><X size={20}/></button></header><div className='transport-workspace-scroll'>{base?<TransportPanel shift={base} actor={actor} onApply={next=>{setBase(next);onApply?.(next);}}/>:<div className='transport-panel-content'>{loadError||(loading?'Загружаем выбранную смену…':'На этот день нет опубликованного плана. Сначала подготовьте смену.')}</div>}</div></section></div>;
}
