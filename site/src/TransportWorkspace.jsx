import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ArrowRight, Car, Check, ChevronRight, Clock3, DoorOpen, ArrowLeftRight, Footprints, MapPin, Plus, Route, Search, TrainFront, Undo2, Users, X } from 'lucide-react';
import { transportMap } from './TransportMap.jsx';
import { transportStatus,transportFocusSegments,transportSelectedConsequences,transportCrewOrders } from './transportDomain.js';
import { transportPreviewReusable } from './transportImpactClock.js';
import { shiftClock } from './shiftClock.js';
import { transportPlaybackClock } from './transportPlaybackClock.js';
import { minuteOf, timeOf } from './shiftDomain.js';
import { ratingName } from './engineerPresentation.js';
import { EngineerPortrait } from './EngineerPortrait.jsx';
import { BusinessSelect } from './BusinessSelect.jsx';
import { DateTimePicker } from './DateTimePicker.jsx';
import './transport.css';

const sessions=new Map();
const kindLabel={road:'Автомобильная дорога',metro:'Участок метро',transfer:'Пересадка',entry:'Вход и выход станции'};
const endLabel=event=>event.endsAt?`${event.endsAt.slice(0,10)!==event.startsAt.slice(0,10)?event.endsAt.slice(0,10).split('-').reverse().join('.')+' · ':''}${event.endsAt.slice(11,16)}`:'окончание неизвестно';
const directionLabel=event=>event.kind==='entry'?'Вход и выход':event.kind==='road'&&event.segments.every(s=>!s.opposingEdgeId)?'Односторонний проезд':event.direction==='both'?'Все разрешённые направления':'По направлению стрелок';
const restrictionIcon=kind=>kind==='road'?<Car/>:kind==='entry'?<DoorOpen/>:kind==='transfer'?<ArrowLeftRight/>:<TrainFront/>;
const keepInputVisible=element=>{
  if(!element?.matches('input,select,textarea'))return;
  const scroller=element.closest('.transport-panel-content');if(!scroller)return;
  const bounds=scroller.getBoundingClientRect(),rect=(element.closest('label')||element).getBoundingClientRect(),scale=bounds.height/scroller.offsetHeight;
  const footer=scroller.querySelector('.transport-form-footer')?.getBoundingClientRect();
  const top=bounds.top+12,bottom=Math.min(bounds.bottom-12,footer?.top||bounds.bottom-12);
  if(rect.top<top)scroller.scrollTop+=(rect.top-top)/scale;
  else if(rect.bottom>bottom)scroller.scrollTop+=(rect.bottom-bottom)/scale;
};
const sectionCount=count=>`${count} ${count%100>=11&&count%100<=14?'участков':count%10===1?'участок':count%10>=2&&count%10<=4?'участка':'участков'}`;
const signed=value=>`${value>0?'+':''}${value}`;
const showResult=element=>{const target=window.innerWidth<=1100?element?.querySelector('.transport-affected-crews')||element:element;target?.scrollIntoView({block:'start',behavior:'instant'});};
const api=async(path,body,signal)=>{
  const response=await fetch(`/api/transport/${path}`,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal}:undefined);
  const value=await response.json();if(!response.ok){const error=new Error(value.error || 'Транспортный сервис недоступен');error.status=response.status;throw error;}return value;
};
const inputOf=(event,actor)=>({id:event.id,expectedRevision:event.revision,title:event.title,reason:event.reason,kind:event.kind,direction:event.direction,
  startsAt:event.startsAt,endsAt:event.endsAt,segmentIds:event.segments.map(s=>s.id),source:event.source,externalId:event.externalId,status:event.status,actor});

/** Shared planned/live transport workflow over one durable event API. */
export function TransportPanel({shift,live=false,active=true,actor='Диспетчер',onApply,onScenarioEvent}) {
  const [compact,setCompact]=useState(()=>typeof window!=='undefined'&&window.innerWidth<=1100);
  useEffect(()=>{const media=matchMedia('(max-width:1100px)'),update=()=>setCompact(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  const clock=useSyncExternalStore(shiftClock.subscribe,shiftClock.getSnapshot);
  const [catalog,setCatalog]=useState(null),[events,setEvents]=useState([]),[draft,setDraft]=useState(()=>sessions.get(`${shift?.id}:${live}`)?.draft || null);
  const [selected,setSelected]=useState(null),[preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[drawing,setDrawing]=useState(false),[showEnded,setShowEnded]=useState(false),[stationFrom,setStationFrom]=useState('');
  const [engineerId,setEngineerId]=useState(''),[orderId,setOrderId]=useState(''),[refreshNotice,setRefreshNotice]=useState(false);
  const [whenMode,setWhenMode]=useState(live?'now':'planned');
  const [browse,setBrowse]=useState(false);
  const generation=useRef(0),previewRef=useRef(null),refs=useRef({});
  const calculationRequest=useRef(0),retryRef=useRef(null),focusResult=useRef(null);
  const [comparison,setComparison]=useState('both');
  const [elapsed,setElapsed]=useState(0);
  const [waitingForPlanner,setWaitingForPlanner]=useState(false);
  const resultRef=useRef(null),groupRef=useRef(null);
  const [eventGroup,setEventGroup]=useState([]);
  const openGroup=items=>{setEventGroup(items);requestAnimationFrame(()=>groupRef.current?.scrollIntoView({block:'nearest'}));};
  useEffect(()=>{
    if(!active||!preview?.result)return;
    const frame=requestAnimationFrame(()=>{if(draft)keepInputVisible(document.activeElement);else showResult(resultRef.current);});
    return()=>cancelAnimationFrame(frame);
  },[active,preview?.id,Boolean(preview?.result),Boolean(draft)]);
  const date=shift?.date;
  const minute=live?Math.floor(clock.minute):360;
  const load=async()=>{if(!shift?.id)return;const id=shift.id,result=await api(`events?shiftId=${encodeURIComponent(id)}`);if(refs.current.shift?.id===id)setEvents(result.events);};
  useEffect(()=>{let active=true;(async()=>{try{const value=await api('catalog');if(active)setCatalog(value);}catch(e){if(active)setError(e.message);}})();return()=>{active=false;};},[]);
  useEffect(()=>{
    const own=++generation.current;calculationRequest.current++;clearTimeout(retryRef.current);focusResult.current=null;previewRef.current=null;setWaitingForPlanner(false);setEvents([]);setPreview(null);setSelected(null);setEventGroup([]);setDraft(sessions.get(`${shift?.id}:${live}`)?.draft || null);
    load().catch(e=>setError(e.message));
    if(shift?.id)(async()=>{try{const saved=await api(`previews/latest?shiftId=${shift.id}`);if(saved&&refs.current.shift?.id===shift.id&&own===generation.current){setPreview(saved);previewRef.current=saved;setEngineerId(saved.result?.consequences?.engineers[0]?.engineerId || '');if(!refs.current.draft){const event=[...(saved.events||[])].filter(event=>transportStatus(event,shift.date,Math.floor(shiftClock.getSnapshot().minute))==='Действует').sort((a,b)=>String(b.createdAt||b.startsAt).localeCompare(String(a.createdAt||a.startsAt)))[0];if(event)setSelected(current=>current||event);}}}catch(e){if(own===generation.current)setError(e.message);}})();
  },[shift?.id]);
  useEffect(()=>{if(shift?.id)sessions.set(`${shift.id}:${live}`,{draft});},[draft,shift?.id,live]);
  const begin=(kind='road')=>{
    if(!shift?.plan){setError('Выберите день с опубликованным планом');return;}
    roadRequest.current++;clearPreview();setSelected(null);setSearch('');setError('');setStationFrom('');setBusy(false);
    setDraft({id:crypto.randomUUID(),title:'',reason:'',kind,direction:'both',startsAt:`${date}T${live?timeOf(minute):'09:30'}:00+03:00`,endsAt:`${date}T${live?timeOf(Math.min(1439,minute+45)):'10:15'}:00+03:00`,segments:[],roadPoints:[],roadMode:'points',source:'Диспетчер',actor,status:'OPEN'});
    setWhenMode(live?'now':'planned');setDrawing(true);
  };
  const clearPreview=()=>{generation.current++;calculationRequest.current++;clearTimeout(retryRef.current);const old=previewRef.current;previewRef.current=null;setPreview(null);if(old&&['RUNNING','READY'].includes(old.status))api(`previews/${old.id}/cancel`,{}).catch(()=>{});};
  const change=patch=>{if(patch.kind){roadRequest.current++;setBusy(false);}clearPreview();setError('');setDraft(value=>({...value,...patch}));};
  const selectSegment=segment=>{
    if(!segment)return;
    const value=segment.kind?segment:{...segment,kind:'entry',fromId:segment.id,toId:null,geometry:[segment.coords]};
    setDraft(current=>current&&!current.segments.some(s=>s.id===value.id)?{...current,segments:[...current.segments,value]}:current);
    clearPreview();setError('');
  };
  const roadRequest=useRef(0),roadAbort=useRef(null);
  useEffect(()=>()=>{roadRequest.current++;roadAbort.current?.abort();},[draft?.id,draft?.kind]);
  const drawRoad=async(points,mode='points')=>{
    const form=refs.current.draft;if(!form||form.kind!=='road')return;
    const id=++roadRequest.current;roadAbort.current?.abort();const controller=new AbortController();roadAbort.current=controller;clearPreview();setError('');setBusy(points.length>1);
    const next={...form,roadPoints:points,roadMode:mode,segments:[],roadLengthM:0};
    refs.current.draft=next;setDraft(next);
    if(points.length<2)return;
    try{
      const selection=await api('draw',{points,mode},controller.signal);
      if(id===roadRequest.current)setDraft(current=>current?.id===form.id?{...current,segments:selection.segments,roadLengthM:selection.lengthM}:current);
    }catch(error){if(id===roadRequest.current&&error.name!=='AbortError')setError(error.message);}
    finally{if(id===roadRequest.current)setBusy(false);}
  };
  const selectRoad=coords=>drawRoad([...(refs.current.draft?.roadPoints||[]),coords]);
  const undoRoad=()=>{const form=refs.current.draft;if(form?.kind==='road'&&form.roadPoints?.length)drawRoad(form.roadPoints.slice(0,-1),form.roadMode);else change({segments:form?.segments.slice(0,-1)||[]});};
  const cancelDraft=()=>{roadRequest.current++;roadAbort.current?.abort();setDraft(null);setDrawing(false);clearPreview();setBusy(false);};
  const selectStation=id=>{
    if(!stationFrom){setStationFrom(id);return;}
    const segment=catalog?.segments.find(s=>s.kind===draft?.kind&&((s.fromId===stationFrom&&s.toId===id)||(s.bidirectional&&s.toId===stationFrom&&s.fromId===id)));
    if(segment){selectSegment(segment);setStationFrom('');}else{setError('Выберите соседнюю станцию: для длинного участка добавьте связи последовательно');setStationFrom(id);}
  };
  const selectEvent=event=>{if(!event||event.id==='draft')return;if(draft){setError('Сохраните ограничение или нажмите «Отмена», чтобы открыть другое событие');return;}setSelected(event);setDrawing(false);setSearch('');setBrowse(false);setComparison('both');focusResult.current={eventId:event.id};transportMap.focusProblem([event]);refs.current.calculate({selection:event.id});};
  const editEvent=event=>{setSelected(null);setDraft({...event,expectedRevision:event.revision});setDrawing(true);clearPreview();};
  const slowPlayback=async()=>{
    if(!live)return;
    let clock;
    if(shift.regionId.includes(':scenario:')){
      const response=await fetch(`/api/dispatch/shifts/${shift.id}/transport`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
      const result=await response.json();if(!response.ok)throw new Error(result.error || 'Не удалось изменить скорость');clock=result.clock;
    }
    if(refs.current.shift?.id===shift.id&&!shiftClock.getSnapshot().restartDay)transportPlaybackClock(shiftClock,shift.id,clock);
  };
  const calculate=async(options={})=>{
    if(!shift?.plan||shiftClock.getSnapshot().restartDay)return;
    const own=++calculationRequest.current;clearTimeout(retryRef.current);
    setError('');
    try {
      const earliest=Math.max(minuteOf(shift.versions?.at(-1)?.effectiveAt) || 0,minuteOf(shift.plan.createdAt?.slice(11,16)) || 0);
      let time=live?timeOf(Math.floor(shiftClock.getSnapshot().minute)):timeOf(Math.max(earliest,360));
      const currentEvents=draft?events:(await api(`events?shiftId=${shift.id}`)).events;
      if(!draft)setEvents(currentEvents);
      const previous=await api(`previews/latest?shiftId=${shift.id}`);
      if(own!==calculationRequest.current)return;
      if(!(options.selection&&previous?.status==='APPLIED'&&transportPreviewReusable(previous,shift,currentEvents,time,options)))await slowPlayback();
      if(live)time=timeOf(Math.floor(shiftClock.getSnapshot().minute));
      const reusable=!draft&&transportPreviewReusable(previous,shift,currentEvents,time,options);
      if(!reusable&&previous?.status==='RUNNING')await api(`previews/${previous.id}/cancel`,{});
      const value=reusable?previous:await api('previews',{shiftId:shift.id,expectedRevision:shift.revision,time,live,
        draft:draft?{...inputOf({...draft,revision:draft.expectedRevision},actor),expectedRevision:draft.expectedRevision}:null});
      if(own!==calculationRequest.current){if(!reusable)await api(`previews/${value.id}/cancel`,{});return;}
      setWaitingForPlanner(false);
      if(live&&value.clock)transportPlaybackClock(shiftClock,shift.id,value.clock);
      setPreview(value);previewRef.current=value;
    }catch(e){if(own!==calculationRequest.current)return;if(e.status===429){setWaitingForPlanner(true);retryRef.current=setTimeout(()=>refs.current.calculate(options),2000);}else setError(e.message);}
  };
  refs.current={calculate,shift,active,draft};
  const draftSignature=JSON.stringify(draft);
  useEffect(()=>{
    if(!draft?.title.trim()||!draft.segments.length||drawing||busy)return;
    const timer=setTimeout(()=>refs.current.calculate(),900);
    return()=>{clearTimeout(timer);generation.current++;if(previewRef.current?.status==='RUNNING')api(`previews/${previewRef.current.id}/cancel`,{}).catch(()=>{});};
  },[draftSignature,drawing,busy]);
  useEffect(()=>{
    if(preview?.status!=='RUNNING')return;
    setElapsed(Math.floor((Date.now()-preview.startedAt)/1000));
    let alive=true;const scope=shift?.id;
    const poll=async()=>{
      try{const value=await api(`previews/${preview.id}`);if(alive&&refs.current.shift?.id===scope&&previewRef.current?.id===preview.id){setPreview(value);previewRef.current=value;if(value.status==='READY'){setEngineerId(current=>value.result.consequences.engineers.some(e=>e.engineerId===current)?current:value.result.consequences.engineers[0]?.engineerId || '');}}}
      catch(e){if(alive)setError(e.message);}
    };
    const timer=setInterval(poll,1300),tick=setInterval(()=>setElapsed(Math.floor((Date.now()-preview.startedAt)/1000)),1000);
    poll();return()=>{alive=false;clearInterval(timer);clearInterval(tick);};
  },[preview?.id,preview?.status]);
  useEffect(()=>()=>{generation.current++;calculationRequest.current++;clearTimeout(retryRef.current);transportMap.set({enabled:false,onRoad:null,onSegment:null,onSelect:null,onGroup:null});},[]);
  useEffect(()=>{
    const scoped=transportSelectedConsequences(preview?.result?.consequences,preview?.result?.eventImpacts,selected?.id);
    transportMap.set({enabled:live||active,management:active,catalog,events,draft:active?draft:null,editingId:active&&draft?.expectedRevision?draft.id:null,preview:active?preview:null,date,minute,showEnded:active&&showEnded,engineerId,
      impactOrderIds:scoped?.orders.map(order=>order.orderId),comparison,
      drawing:active&&drawing,kind:draft?.kind,roadMode:draft?.roadMode||'points',roadBusy:busy,onRoad:selectRoad,onRoadStroke:points=>drawRoad(points,'brush'),onRoadPointMove:(index,coords)=>drawRoad(draft.roadPoints.map((point,i)=>i===index?coords:point)),onSegment:selectSegment,onStation:selectStation,onSelect:event=>{onScenarioEvent?.();selectEvent(event);},onGroup:items=>{onScenarioEvent?.();openGroup(items);},onOpen:onScenarioEvent,onNew:()=>begin(),
      onUndo:undoRoad,onFinish:()=>setDrawing(false),onRoadMode:roadMode=>change({roadMode}),onKind:kind=>{if(!draft)begin(kind);else{change({kind,segments:[],roadPoints:[]});setDrawing(true);}}});
  },[active,catalog,events,draft,preview,date,minute,drawing,busy,showEnded,engineerId,stationFrom,selected?.id,comparison]);
  const save=async()=>{
    setBusy(true);setError('');
    try{const event=await api('events',{shiftId:shift.id,event:{...inputOf({...draft,revision:draft.expectedRevision},actor),expectedRevision:draft.expectedRevision}});
      await load();focusResult.current={eventId:event.id};setSelected(event);setDraft(null);setDrawing(false);
      if(preview?.id){const refreshed=await api(`previews/${preview.id}`);setPreview(refreshed);previewRef.current=refreshed;}
    }catch(e){setError(e.message);}finally{setBusy(false);}
  };
  const endEvent=async(status)=>{
    setBusy(true);setError('');
    try{const event=await api('events',{shiftId:shift.id,event:{...inputOf(selected,actor),status,...(status==='ENDED'?{endsAt:`${date}T${timeOf(Math.max(minuteOf(selected.startsAt.slice(11,16))||0,Math.floor(shiftClock.getSnapshot().minute)))}:00+03:00`}:{})}});await load();setSelected(event);setPreview(null);}
    catch(e){setError(e.message);}finally{setBusy(false);}
  };
  const apply=async()=>{
    clearTimeout(retryRef.current);setBusy(true);setError('');
    const scope=shift.id,pendingId=preview.id;
    try{
      const result=await api(`previews/${preview.id}/apply`,{time:live?timeOf(Math.floor(shiftClock.getSnapshot().minute)):preview.time,actor,refresh:live});
      if(refs.current.shift?.id!==scope||shiftClock.getSnapshot().restartDay)return;
      setWaitingForPlanner(false);setPreview(result.preview);previewRef.current=result.preview;
      if(result.refresh){setRefreshNotice(true);if(result.preview.clock)transportPlaybackClock(shiftClock,scope,result.preview.clock);return;}
      setRefreshNotice(false);if(live)transportPlaybackClock(shiftClock,scope,result.clock,{finish:true});onApply?.(result.shift);
    }
    catch(e){if(refs.current.shift?.id===scope){if(e.status===429){setWaitingForPlanner(true);retryRef.current=setTimeout(()=>{if(refs.current.shift?.id===scope&&previewRef.current?.id===pendingId&&!shiftClock.getSnapshot().restartDay)refs.current.apply();},2000);}else setError(e.message);}}finally{if(refs.current.shift?.id===scope)setBusy(false);}
  };
  refs.current.apply=apply;
  useEffect(()=>{
    const receive=event=>{
      const result=event.detail;if(result?.shift?.id!==shift?.id)return;
      if(result.operational&&refs.current.draft)return;
      setWaitingForPlanner(Boolean(result.waitingForPlanner));
      if(result.waitingForPlanner)return;
      if(!result.preview&&!result.event)return;
      if(!result.opening)generation.current++;load().catch(error=>setError(error.message));
      if(result.event){focusResult.current={eventId:result.event.id};setSelected(result.event);setComparison('both');if(!result.opening||previewRef.current&&!previewRef.current.events?.some(event=>event.id===result.event.id&&event.revision===result.event.revision)){setPreview(null);previewRef.current=null;}}
      if(result.preview){setPreview(result.preview);previewRef.current=result.preview;setEngineerId('');setOrderId('');if(result.event&&refs.current.active)transportMap.focusProblem([result.event]);}
    };
    window.addEventListener('beego:transport-scenario',receive);
    const update=event=>{if(event.detail.shiftId===shift?.id)setEvents(event.detail.events);};
    window.addEventListener('beego:transport-events',update);
    return()=>{window.removeEventListener('beego:transport-scenario',receive);window.removeEventListener('beego:transport-events',update);};
  },[shift?.id]);
  const visible=events.filter(e=>(showEnded||!['Завершено','Отменено'].includes(transportStatus(e,date,minute)))&&(filter==='all'||(filter==='metro'?e.kind!=='road':e.kind===filter))&&`${e.title} ${e.reason}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')));
  const results=catalog&&draft&&draft.kind!=='road'&&search.trim()? [...(draft.kind==='entry'?catalog.stations:catalog.segments.filter(s=>s.kind===draft.kind))].filter(s=>s.name.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))).slice(0,12):[];
  const consequences=transportSelectedConsequences(preview?.result?.consequences,preview?.result?.eventImpacts,selected?.id),engineer=consequences?.engineers.find(e=>e.engineerId===engineerId)||consequences?.engineers[0];
  const focusEngineer=id=>{const person=consequences?.engineers.find(e=>e.engineerId===id);if(!person)return;setEngineerId(id);setOrderId('');const orders=transportCrewOrders(consequences.orders,id);transportMap.focus([...transportFocusSegments({orders,events,draft,selected,date,minute,transport:person.transport}),...orders.filter(o=>o.geometryBefore?.length).map(o=>({geometry:o.geometryBefore}))]);};
  refs.current.refit=()=>{if(!refs.current.active||refs.current.draft||!selected||!preview?.result)return;transportMap.focusProblem([selected]);showResult(resultRef.current);};
  useEffect(()=>{
    let timer,frame;
    const resize=()=>{clearTimeout(timer);timer=setTimeout(()=>{frame=requestAnimationFrame(()=>refs.current.refit?.());},300);};
    window.addEventListener('resize',resize);
    return()=>{window.removeEventListener('resize',resize);clearTimeout(timer);cancelAnimationFrame(frame);};
  },[]);
  useEffect(()=>{if(!active||!preview?.result||!focusResult.current)return;requestAnimationFrame(()=>showResult(resultRef.current));focusResult.current=null;},[active,preview?.id,preview?.status,selected?.id]);
  const firstOrder=consequences?.orders.find(o=>o.orderId===orderId&&o.engineerId===engineer?.engineerId&&!o.lost)||consequences?.orders.find(o=>o.engineerId===engineer?.engineerId&&!o.lost);
  const itinerary=(firstOrder?.stepsAfter || []).filter(s=>s.seconds>0).reduce((groups,step)=>{
    const last=groups.at(-1);if(last&&last.mode===step.mode&&last.lineId===step.lineId&&last.line===step.line){last.seconds+=step.seconds;last.to=step.to || last.to;}else groups.push({...step});return groups;
  },[]);
  const ready=preview?.status==='READY'&&!draft;
  const routeSummary=engineer?<div className='transport-route-summary'><label className='transport-engineer'>{engineer.transport==='CAR'?<Car size={18}/>:<TrainFront size={18}/>}<select aria-label='Затронутый инженер' value={engineer.engineerId} onChange={event=>focusEngineer(event.target.value)}>{consequences.engineers.map(person=><option key={person.engineerId} value={person.engineerId}>{ratingName(shift.team.find(member=>member.id===person.engineerId)||{name:person.name})}</option>)}</select><span>{engineer.transport==='CAR'?'Авто':'Общественный транспорт'}</span></label>{firstOrder?<div className='transport-eta'><div><small>Было прибытие</small><b>{firstOrder.before}</b></div><ArrowRight/><div><small>Новое прибытие</small><b>{firstOrder.after}</b></div><strong>{signed(firstOrder.delta)} мин</strong></div>:null}</div>:null;
  return <div className={`transport-panel-frame ${live?'live':''} ${ready?'has-decision':''}`}><div onFocusCapture={event=>{const element=event.target;requestAnimationFrame(()=>keepInputVisible(element));}} className={`transport-panel-content ${live?'live':''} ${consequences?'has-result':''} ${draft?'editing':''}`}>
    {selected&&!draft?<section className='transport-problem-context' aria-label='Влияние выбранной проблемы'><span className='transport-type-icon'>{restrictionIcon(selected.kind)}</span><div><small>ВЛИЯНИЕ НА БРИГАДЫ</small><b>{selected.title}</b><p>{preview?.status==='RUNNING'?'Вычисляем влияние и новый путь от текущего положения…':waitingForPlanner?'Ожидаем расчёт. Проблема остаётся видна на карте.':consequences?`Затронуто бригад: ${consequences.engineers.length}`:'Готовим сравнение исходного пути и объезда…'}</p></div></section>:null}
    {eventGroup.length&&!draft?<section ref={groupRef} className='transport-event-group'><div className='transport-section-title'><h3>Ограничения в точке ({eventGroup.length})</h3><button onClick={()=>setEventGroup([])} aria-label='Закрыть группу ограничений'><X size={18}/></button></div>{eventGroup.map(event=><button key={event.id} onClick={()=>{setEventGroup([]);selectEvent(event);}}>{restrictionIcon(event.kind)}<span><b>{event.title}</b><small>{kindLabel[event.kind]} · {event.startsAt.slice(11,16)}–{endLabel(event)}</small></span><ChevronRight size={16}/></button>)}</section>:null}
    {!draft?<div className='transport-intro'><div><b>{live?'Движение в течение смены':'Доступность дорог и метро'}</b><p>{live?'Закрытия, проверенные объезды и последствия для заявок':'Планируйте перекрытия на выбранный день'}</p></div>{consequences?<button className='transport-add transport-search-toggle' aria-label='Поиск ограничений' aria-pressed={browse} onClick={()=>setBrowse(value=>!value)}><Search size={18}/></button>:null}<button className='transport-add' onClick={()=>begin()} aria-label='Добавить транспортное ограничение'><Plus size={18}/></button></div>:null}
    {refreshNotice?<div className='transport-clock-notice' role='status'><Clock3 size={16}/><span>Время изменилось: обновляем решение из текущего положения. Проверьте обновлённый результат перед применением.</span></div>:null}
    {waitingForPlanner?<div className='transport-clock-notice' role='status'><Clock3 size={16}/><span>Событие уже на карте. Ожидаем свободный расчёт — проверка запустится автоматически.</span></div>:null}
    {error?<div className='transport-error' role='alert'><AlertTriangle size={18}/><span>{error}</span><button onClick={()=>setError('')} aria-label='Закрыть сообщение'><X size={15}/></button></div>:null}
    {!draft?<>
      <div className={`transport-search ${consequences&&!browse?'transport-collapsed':''}`}><Search size={17}/><input aria-label='Поиск транспортных ограничений' placeholder='Название, причина ограничения' value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <div className={`transport-filter ${consequences&&!browse?'transport-collapsed':''}`}><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>Все</button><button className={filter==='road'?'active':''} onClick={()=>setFilter('road')}><Car size={16}/>Авто</button><button className={filter==='metro'?'active':''} onClick={()=>setFilter('metro')}><TrainFront size={16}/>Метро</button><label><input type='checkbox' checked={showEnded} onChange={e=>setShowEnded(e.target.checked)}/>Завершённые</label></div>
      <div className='transport-event-list'>{visible.map(event=><button key={event.id} className={`transport-event ${event.id===selected?.id?'selected':''}`} onClick={()=>selectEvent(event)}><span className={`transport-type-icon ${event.kind}`}>{restrictionIcon(event.kind)}</span><span><small className={transportStatus(event,date,minute)==='Действует'?'active':''}>{transportStatus(event,date,minute)}</small><strong>{event.title}</strong><em>{event.startsAt.slice(11,16)}–{endLabel(event)} · {directionLabel(event)}</em></span><ChevronRight size={17}/></button>)}</div>
      {!visible.length?<div className='transport-empty'><Route size={36}/><h3>Дороги под контролем</h3><p>Добавьте участок дороги, закрытие метро или пересадки. Система проверит оставшиеся маршруты по сети.</p><button onClick={()=>begin()}><Plus size={17}/>Добавить ограничение</button></div>:null}
      {selected?<section className='transport-detail'><div className='transport-section-title'><h3>{kindLabel[selected.kind]}</h3><button onClick={()=>setSelected(null)} aria-label='Закрыть карточку ограничения'><X size={18}/></button></div><p>{selected.reason}</p><dl><div><dt>Участок</dt><dd>{selected.segments.map(s=>s.name).join(', ')}</dd></div><div><dt>Направление</dt><dd>{directionLabel(selected)}</dd></div><div><dt>Источник</dt><dd>{selected.source}</dd></div><div><dt>Действует</dt><dd>{selected.startsAt.slice(0,10)} · {selected.startsAt.slice(11,16)}–{endLabel(selected)}</dd></div><div><dt>Транспорт</dt><dd>{selected.kind==='road'?'Автомобили · пешеходам проход открыт':'Общественный транспорт'}</dd></div></dl><div className='transport-actions'><button onClick={()=>transportMap.focusProblem([selected])}><MapPin size={16}/>Приблизить проблему</button><button onClick={()=>editEvent(selected)}>Изменить / продлить</button></div><div className='transport-actions'><button disabled={busy||selected.status!=='OPEN'||transportStatus(selected,date,minute)==='Запланировано'} onClick={()=>endEvent('ENDED')}>Завершить событие</button><button disabled={busy||selected.status!=='OPEN'} onClick={()=>endEvent('CANCELLED')}>Отменить событие</button></div><button className='transport-primary full' onClick={()=>calculate({force:true})} disabled={preview?.status==='RUNNING'}><Route size={17}/>Проверить последствия</button></section>:null}
    </>:<>
      <div className='transport-modes'><button className={draft.kind==='road'?'active':''} onClick={()=>change({kind:'road',segments:[]})}><Car/>Авто</button><button className={draft.kind!=='road'?'active':''} onClick={()=>change({kind:'metro',segments:[]})}><b>M</b>Метро</button>{draft.kind==='road'?<span><Footprints size={20}/>Проход открыт</span>:null}</div>
      <section className='transport-form'><div className='transport-section-title'><h3>{draft.expectedRevision?'Изменить ограничение':'Новое перекрытие'}</h3><button onClick={cancelDraft} aria-label='Отменить ввод ограничения'><X size={18}/></button></div>
        <label>Название<input value={draft.title} placeholder={draft.kind==='road'?'Например, ремонт проезжей части':'Например, закрыт участок линии'} onChange={e=>change({title:e.target.value})} maxLength={160}/></label>
        {draft.kind!=='road'?<label>Что закрыто<BusinessSelect ariaLabel='Что закрыто' value={draft.kind} onChange={kind=>{change({kind,segments:[]});setSearch('');}} portalMenu options={[{value:'metro',label:'Движение между станциями'},{value:'transfer',label:'Пересадка между линиями'},{value:'entry',label:'Вход и выход станции'}]}/></label>:null}
        <div className='transport-when'><button className={whenMode==='planned'?'active':''} onClick={()=>{setWhenMode('planned');change({startsAt:`${date}T${live?timeOf(Math.min(1439,minute+30)):'09:30'}:00+03:00`,endsAt:live&&minute>=1350?null:`${date}T${live?timeOf(minute+90):'10:15'}:00+03:00`});}}><Clock3 size={17}/>Запланировано</button><button className={whenMode==='now'?'active':''} onClick={()=>{setWhenMode('now');change({startsAt:`${date}T${timeOf(Math.floor(clock.minute))}:00+03:00`,endsAt:null});}}>Сейчас</button></div>
        <div className='transport-time-grid'><DateTimePicker label='Начало ограничения' value={draft.startsAt} onChange={startsAt=>change({startsAt})}/><DateTimePicker label='Окончание ограничения' disabled={!draft.endsAt} value={draft.endsAt} onChange={endsAt=>change({endsAt})}/></div>
        <label className='transport-check'><input type='checkbox' checked={!draft.endsAt} onChange={e=>change({endsAt:e.target.checked?null:`${date}T${timeOf(Math.min(1439,(minuteOf(draft.startsAt.slice(11,16))||0)+60))}:00+03:00`})}/>Окончание неизвестно</label>
        {draft.kind!=='entry'?<label>Направление движения<BusinessSelect ariaLabel='Направление движения' value={draft.direction} onChange={direction=>change({direction})} portalMenu options={[{value:'both',label:'В обоих направлениях'},{value:'forward',label:'От начала к концу участка'},...(draft.kind==='road'?[{value:'reverse',label:'От конца к началу участка'}]:[])]}/></label>:null}
        <details className='transport-extra'><summary>Причина и источник</summary><label>Причина<input value={draft.reason} placeholder='Краткое пояснение для диспетчера' onChange={e=>change({reason:e.target.value})}/></label><label>Источник<input value={draft.source} maxLength={160} onChange={e=>change({source:e.target.value})}/></label></details>
        <div className='transport-mode-note'>{draft.kind==='road'?<Car size={18}/>:<TrainFront size={18}/>}<span>{draft.kind==='road'?'Автомобили · пешеходам проход открыт':draft.kind==='entry'?'Вход и выход закрыты · движение поездов сохраняется':draft.kind==='transfer'?'Закрыта только выбранная пересадка':'Закрыто движение на выбранных связях'}</span></div>
      </section>
      {draft.kind!=='road'?<><div className='transport-search'><Search size={17}/><input aria-label='Поиск станции или участка метро' placeholder='Название станции или пересадки' value={search} onChange={e=>setSearch(e.target.value)}/></div>{results.length?<div className='transport-station-results'>{results.map(s=><button key={s.id} onClick={()=>{selectSegment(s);setSearch('');}}><b>M</b><span>{s.name}<small>{catalog?.lines?.[s.lineId]?.name || ''}</small></span><Plus size={15}/></button>)}</div>:null}</>:null}
      <div className='transport-selection'><span><strong>{draft.segments.length?draft.kind==='road'?`${(draft.roadLengthM||draft.segments.reduce((sum,item)=>sum+item.lengthM,0)).toLocaleString('ru-RU')} м · ${sectionCount(draft.segments.length)}`:`Выбрано ${draft.segments.length} ${draft.kind==='entry'?'станций':'участков'}`:draft.roadPoints?.length?draft.roadPoints.length===1?'Отмечено начало участка':'Уточните линию на карте':'Участок ещё не выбран'}</strong>{busy||draft.segments.length?<small>{busy?'Привязываем линию к дороге…':[...new Set(draft.segments.map(s=>s.name))].join(' → ')}</small>:null}</span><button disabled={!draft.segments.length&&!draft.roadPoints?.length} onClick={undoRoad} aria-label='Отменить выбор последней точки'><Undo2 size={18}/></button><button disabled={busy||drawing&&!draft.segments.length} onClick={()=>setDrawing(value=>!value)}>{drawing?'Готово':'Изменить участок'}</button></div>
      {draft.kind==='road'&&(draft.roadPoints?.length||draft.segments.length)?<button className='transport-clear-selection' onClick={()=>{drawRoad([],draft.roadMode);setDrawing(true);}}>Очистить участок</button>:null}
      {stationFrom?<p className='transport-source-note'>Выбрана первая станция. Нажмите соседнюю станцию.</p>:null}
    </>}
    {preview?.status==='RUNNING'?<section className='transport-calculating' role='status'><i className='spinner'/><div><b>Рассчитываем новый маршрут</b><p>{preview.phase}</p><p>Факты и опубликованный план сохранены · {elapsed} с{preview.progress?.routeChecks>0?` · проверок маршрута: ${preview.progress.routeChecks}`:''}</p></div><button onClick={async()=>{await api(`previews/${preview.id}/cancel`,{});setPreview(null);}}>Отмена</button></section>:null}
    {preview?.status==='FAILED'?<div className='transport-error' role='alert'><AlertTriangle size={18}/><span>{preview.error}</span><button onClick={calculate}>Повторить</button></div>:null}
    {consequences?<section ref={resultRef} className='transport-result'><header><span className='transport-check-icon'><Check/></span><div><h3>{preview.status==='APPLIED'?'Изменения применены':'Пересчёт готов'}</h3>{preview.finishedAt&&preview.startedAt?<small>Расчёт занял {((preview.finishedAt-preview.startedAt)/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})} с</small>:null}{selected?<strong className='transport-result-problem'>{selected.title}</strong>:null}<p>{consequences.lost?'Часть заявок не имеет допустимого назначения — требуется решение':consequences.engineers.length?'Найден и независимо проверен допустимый путь':'На оставшихся маршрутах влияние не обнаружено'}</p></div></header>
      {consequences.engineers.length?<section className='transport-affected-crews' aria-label='Затронутые бригады'><h4>Затронутые бригады · {consequences.engineers.length}</h4>{consequences.engineers.map(person=>{const member=shift.team.find(e=>e.id===person.engineerId)||{id:person.engineerId,name:person.name},orders=consequences.orders.filter(o=>o.engineerId===person.engineerId),first=orders.find(o=>!o.lost);return <button key={person.engineerId} data-engineer-id={person.engineerId} aria-pressed={person.engineerId===engineer?.engineerId} onClick={()=>focusEngineer(person.engineerId)}><span className='engineer-portrait'><EngineerPortrait id={person.engineerId}/></span><span><b>{ratingName(member)}</b><small>{person.transport==='CAR'?'Авто':'Общественный транспорт'} · {orders.length} заявок</small></span><strong>{first?`${first.before} → ${first.after}`:'Изменение назначений'}<small>{first?`${signed(first.delta)} мин к прибытию`:'Проверьте очередь'}</small></strong></button>;})}</section>:null}
      {engineer?<div className='transport-comparison-switch' role='group' aria-label='Сравнение маршрутов'>{[['before','Как ехала бригада'],['both','Сравнить'],['after','Новый путь']].map(([value,label])=><button key={value} data-route={value} aria-pressed={comparison===value} onClick={()=>setComparison(value)}><i aria-hidden='true'/>{label}</button>)}</div>:null}
      <div className={`transport-outcome ${consequences.lost||consequences.late||consequences.overtime?'warning':''}`}><Check size={18}/><span>{consequences.lost?`${consequences.lost} назначений потеряно`:consequences.late?`${consequences.late} нарушений клиентского окна`:consequences.overtime?`${consequences.overtime} бригад выйдут за смену`:consequences.unknownWindows?'Назначения сохранены · часть клиентских окон неизвестна':'Назначения сохранены · клиентские окна соблюдены'}</span></div>
      {!(compact&&ready)?routeSummary:null}
      <div className='transport-metrics'><div><Users/><b>{consequences.engineers.length}</b><span>инженеров затронуто</span></div><div><Clock3/><b>{signed(consequences.addedTravelMinutes)} мин</b><span>сумма оставшегося движения</span></div></div>

      {engineer?<p className='transport-source-note'>Оставшийся путь: {engineer.beforeMinutes} → {engineer.afterMinutes} мин · {(engineer.beforeDistanceM/1000).toFixed(1)} → {(engineer.afterDistanceM/1000).toFixed(1)} км</p>:null}
      {engineer?<button className='transport-show-route' onClick={()=>focusEngineer(engineer.engineerId)}><Route size={16}/>Показать проверенный путь</button>:null}
      {itinerary.length?<details className='transport-itinerary'><summary>Как проходит путь</summary>{itinerary.map((step,index)=><div key={index}><span>{['walking','pedestrian','walking_transfer'].includes(step.mode)?<Footprints size={15}/>:step.mode==='metro'?<b>M</b>:<Clock3 size={15}/>}</span><span>{step.mode==='metro'?(catalog?.lines?.[step.lineId]?.name || 'Метро'):({metro_wait_model:'Ожидание поезда · модель',walking_transfer:'Пешая пересадка',walking:'Пешком',pedestrian:'Пешком',waiting:'Ожидание транспорта',station_entry:'Вход на станцию',station_exit:'Выход со станции',auto:'Автомобиль',bicycle:'Велосипед'})[step.mode] || step.line || 'Наземный транспорт'}{step.from||step.to?<small>{step.from} → {step.to}</small>:null}</span><strong>{Math.ceil(step.seconds/60)} мин</strong></div>)}</details>:null}
      {consequences.orders.length?<div className='transport-impacts'><h4>Затронутые заявки ({consequences.orders.length})</h4>{consequences.orders.map(o=><button key={o.orderId} aria-pressed={o.orderId===firstOrder?.orderId} onClick={()=>{setEngineerId(o.engineerId);setOrderId(o.orderId);if(o.geometryAfter)transportMap.focus(transportFocusSegments({orders:[o],events,draft,selected,date,minute,transport:shift.team.find(person=>person.id===o.engineerId)?.transport}));}}><span>{o.address || o.orderId}</span><b>{o.lost?'Нет назначения':`${signed(o.delta)} мин`}</b><small className={o.lost||o.lateMinutes>0?'warning':''}>{o.lost?'Нужно решение':o.lateMinutes==null?'Окно неизвестно':o.lateMinutes>0?`Опоздание ${o.lateMinutes} мин`:'В окне'}</small></button>)}</div>:null}

      {engineer&&(engineer.beforeWaitingMinutes||engineer.afterWaitingMinutes)?<p className='transport-source-note'>Ожидание транспорта отдельно: {engineer.beforeWaitingMinutes} → {engineer.afterWaitingMinutes} мин</p>:null}
    </section>:null}
    </div>
    {ready?<footer className='transport-decision-bar'>{compact?routeSummary:null}{preview.requiresSave?<span>Сохраните ограничение и повторите проверку</span>:null}<button className='transport-primary full' disabled={busy||preview.requiresSave} onClick={apply}>Применить изменения плана</button></footer>:null}
    {draft?<footer className='transport-form-footer'><button className='transport-primary' disabled={busy||drawing||!draft.title.trim()||!draft.segments.length} onClick={save}>Сохранить ограничение</button><button onClick={cancelDraft}>Отмена</button></footer>:null}
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
