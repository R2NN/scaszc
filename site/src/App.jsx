import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  BarChart3, BriefcaseBusiness, Building2, CalendarDays, Car, Check,
  ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  CircleHelp, Clock3, Download, FileSpreadsheet, FileUp, Filter, Gauge,
  HardHat, List, Map, MapPin, PackageCheck, Plus, RotateCcw,
  Route, Search, Settings2, SlidersHorizontal, Sparkles, Maximize2,
  MessageSquare, MessageSquareOff, Layers3, LocateFixed, Box,
  WandSparkles, X, ZoomIn, ZoomOut, Moon, Sun, House, Newspaper,
  ArrowRight, PlayCircle, GraduationCap, Rocket, ShieldCheck
  , AlertTriangle, Bike, Bus, Footprints, Wrench, Users, CircleAlert, RefreshCw,
  Database, ServerCog, Save, Activity, LockKeyhole, MapPinned, UserRoundPlus,
  Bell, CheckCheck, FileText
} from 'lucide-react';
import './styles.css';
import './calendar.css';
import './import-engineers.css';
import { ImportWorkspace, parseImportFile } from './ImportWorkspace.jsx';
import { useDropdownPresence } from './useDropdownPresence.js';
import { useWorkspacePresence } from './useWorkspacePresence.js';
import { displayOrderName, effectiveOrderSkill, isInformationalOrder, workPointType } from './workTypes.js';
import { ZONE_LABELS, normalizeTerritoryKey, zoneBoundaryName, zoneCode } from './territoryAliases.js';
import { captureMapCamera, restoredCameraOptions } from './locationPrivacy.js';
import { parseImportedDate, resolveImportedDate } from './importDate.js';
import { DEFAULT_REGION, regionCatalog } from './regions.js';
import depotMarkerPurple from './assets/depot-marker-purple.png';
import { MAP_SCALE, MAP_UI, routeModeForCount, shouldShowRouteNumbers, stableRouteColor } from './mapDesign.js';
import { AnalyticsWorkspace } from './AnalyticsWorkspace.jsx';
import { ManualEntryModal } from './ManualEntryModal.jsx';
import { geocodeManualOrder } from './manualGeocoding.js';
import { StaffRosterModal } from './StaffRosterModal.jsx';
import { staffActiveOn } from './staffRoster.js';
import { diagnoseOrderCandidates } from './dynamicReplanner.js';
import { ShiftPlaybackBar, ShiftWorkspace } from './ShiftWorkspace.jsx';
import { WorkspaceFilters } from './WorkspaceFilters.jsx';
import { filterLabel, matchesAnySelection, matchesSearch } from './filterPresentation.js';
import { completedFactOrderIds, crewOperationalSummary, minuteOf, playbackFrame, playbackRouteSegments, shiftDisplayAt, visitStatusLabel } from './shiftDomain.js';
import { shiftClock } from './shiftClock.js';
import { PROFILE_AVATAR_TONES, profileAvatarColor } from './profileAvatar.js';

maplibregl.setWorkerUrl(mapLibreWorkerUrl);
const MAP_WORKER_COUNT=Math.min(4,Math.max(2,Math.ceil((navigator.hardwareConcurrency||4)/2)));
maplibregl.setWorkerCount(MAP_WORKER_COUNT);
maplibregl.prewarm();

const ACCENT = '#FFD21F';
const DEFAULT_MAP_CENTER = [55.7558, 37.6173];
const DEFAULT_MAP_ZOOM = 10;
const MAP_MIN_ZOOM = 2;
const MAP_MAX_ZOOM = 19;
const EMPTY_ROUTES = Object.freeze([]);
const countForm=(value,one,few,many)=>{const absolute=Math.abs(Number(value)||0),lastTwo=absolute%100,last=absolute%10;return lastTwo>=11&&lastTwo<=14?many:last===1?one:last>=2&&last<=4?few:many};
const ROAD_LAYER_PATTERN=/(?:motorway|trunk|primary|secondary|tertiary|minor|service|track|link|road_pier)/;
const WORK_POINT_TYPES={emergency:{label:'Авария',color:'#F0523D'},connection:{label:'Подключение',color:'#FFD21F'},service:{label:'Обслуживание',color:'#4C8DFF'},upgrade:{label:'Оборудование',color:'#9B6BFF'},other:{label:'Прочие работы',color:'#35B56A'}};
const MAP_THEMES = {
  day:{name:'Дневная',land:'#f3f7ef',water:'#96d4f5',park:'#d9efc5',wood:'#add7a5',grass:'#e4f2d8',residential:'#fff9e9',commercial:'#fff1df',industrial:'#f2eee2',label:'#1e4863',halo:'#ffffff',boundary:'#7198b3'},
  night:{name:'Ночная',land:'#172522',water:'#162f43',park:'#203b2e',wood:'#315b43',grass:'#294839',residential:'#25302d',commercial:'#332d2a',industrial:'#303332',label:'#d6e5dd',halo:'#14201e',boundary:'#6b827b'},
  muted:{name:'Приглушённая',land:'#eef2e8',water:'#c9dfee',park:'#dce9ce',wood:'#91ae86',grass:'#e0ead7',residential:'#f2f2eb',commercial:'#f3eee8',industrial:'#ecece7',label:'#52655f',halo:'#fafbf7',boundary:'#a6b3ad'},
  gray:{name:'Оттенки серого',land:'#edf0ef',water:'#d8e0e2',park:'#e2e7e3',wood:'#aeb9b2',grass:'#e7ebe8',residential:'#f3f4f3',commercial:'#eeeeed',industrial:'#e7e8e7',label:'#4f5a5d',halo:'#fff',boundary:'#9ca8aa'},
};
const ENGINEERS = [];
// Legacy settings view keeps the current empty workspace; operational locations are derived from imports.
const REGIONS = [DEFAULT_REGION];
const navItems = [
  ['orders', BriefcaseBusiness, 'Заявки'], ['engineers', HardHat, 'Инженеры'],
  ['shift', PlayCircle, 'Ход смены'], ['analytics', BarChart3, 'Аналитика'],
  ['review', Database, 'Данные'], ['planning', Route, 'Планирование'],
  ['constraints', SlidersHorizontal, 'Ограничения'],
  ['report', FileText, 'Отчёт PDF'],
];
const OVERLAY_SCREENS=new Set(['analytics','planning','constraints','locations','shift','report']);
const PROFILE_ROLES = {
  dispatcher: 'Диспетчер',
  admin: 'Администратор',
  engineer: 'Инженер',
};
const PROFILE_AVATARS = [
  ['bee-static', 'Пчёлка-диспетчер'], ['robot-static', 'Робот-помощник'],
  ['cat-static', 'Кот-проводник'], ['panda-static', 'Панда-координатор'],
  ['bee-running', 'Пчёлка с маршрутом'], ['robot-routing', 'Робот с планшетом'],
  ['cat-scooter', 'Кот на самокате'], ['panda-delivery', 'Панда с посылкой'],
  ['dragon-flying', 'Дракон с меткой'], ['fox-map', 'Лис с картой'],
  ['owl-dispatcher', 'Сова-диспетчер'], ['dog-engineer', 'Пёс-инженер'],
  ['hamster-static', 'Хомяк-логист'], ['penguin-static', 'Пингвин-курьер'],
  ['bear-static', 'Медведь-мастер'], ['turtle-static', 'Черепаха-навигатор'],
].map(([id,label])=>({id,label,src:`/avatars/${id}.png`}));

const cleanDistrict=value=>String(value||'').replace(/^(?:район|муниципальный округ|городской округ|поселение)\s+/i,'').replace(/\s+(?:район|муниципальный округ|городской округ|поселение)$/i,'').trim();
const districtBoundaryName=value=>{
  const cleaned=cleanDistrict(value).replace(/^GPON\s+/i,'').trim();
  const aliases={'выхино':'Выхино-Жулебино'};
  return aliases[normalizeTerritoryKey(cleaned)]||cleaned;
};
const orderDistrict=order=>{
  const direct=cleanDistrict(order?.district);
  if(direct)return direct;
  const match=String(order?.geocodedAddress||order?.address||'').match(/район\s+([^,]+)/i);
  return cleanDistrict(match?.[1]);
};
const orderZone=order=>{const explicit=String(order?.zone||'').trim();if(explicit)return ZONE_LABELS[zoneCode(explicit)]||explicit;const id=String(order?.zoneId||'').trim();return ZONE_LABELS[zoneCode(id)]||id};
const territorySelection=value=>{const[kind,...parts]=String(value||'').split(':');return value&&['zone','district'].includes(kind)?{kind,name:parts.join(':')}:{kind:'',name:''}};
let territoryCatalogPromise;
const loadTerritoryCatalog=()=>{if(!territoryCatalogPromise)territoryCatalogPromise=Promise.all(['/data/moscow-administrative-areas.geojson','/data/moscow-oblast-operational-areas.geojson'].map(url=>fetch(url).then(response=>{if(!response.ok)throw new Error(`Local territory catalog is unavailable: ${url}`);return response.json()}))).then(catalogs=>({type:'FeatureCollection',features:catalogs.flatMap(catalog=>catalog?.features||[])})).catch(()=>null);return territoryCatalogPromise};
const findCatalogBoundary=(catalog,selected)=>{if(!catalog?.features?.length||!selected?.name)return null;const target=normalizeTerritoryKey(selected.kind==='zone'?(zoneBoundaryName(selected.name)||selected.name):districtBoundaryName(selected.name));return catalog.features.find(feature=>feature.properties?.scope===selected.kind&&normalizeTerritoryKey(feature.properties?.name)===target)||null};
const territoryBoundaryQueries=value=>{const selected=territorySelection(value);if(selected.kind!=='district'||!selected.name)return[];const district=districtBoundaryName(selected.name);return[`${district} район, Москва, Россия`,`район ${district}, Москва, Россия`,`${district}, Москва, Россия`,`городской округ ${district}, Московская область, Россия`,`${district}, Московская область, Россия`,`${district}, Россия`]};
function geometryBounds(geometry){
  const points=[];
  const visit=value=>{if(Array.isArray(value)&&typeof value[0]==='number'&&typeof value[1]==='number')points.push(value);else if(Array.isArray(value))value.forEach(visit)};
  visit(geometry?.coordinates);
  if(!points.length)return null;
  return points.reduce((bounds,[lon,lat])=>[[Math.min(bounds[0][0],lon),Math.min(bounds[0][1],lat)],[Math.max(bounds[1][0],lon),Math.max(bounds[1][1],lat)]],[[Infinity,Infinity],[-Infinity,-Infinity]]);
}
function positionsBounds(positions){return positions.length?positions.reduce((bounds,[lat,lon])=>[[Math.min(bounds[0][0],lon),Math.min(bounds[0][1],lat)],[Math.max(bounds[1][0],lon),Math.max(bounds[1][1],lat)]],[[Infinity,Infinity],[-Infinity,-Infinity]]):null}
function mergeBounds(...values){const bounds=values.filter(Boolean);return bounds.length?bounds.reduce((result,value)=>[[Math.min(result[0][0],value[0][0]),Math.min(result[0][1],value[0][1])],[Math.max(result[1][0],value[1][0]),Math.max(result[1][1],value[1][1])]],bounds[0]):null}
function pointInRing([x,y],ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const[xi,yi]=ring[i],[xj,yj]=ring[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside}return inside}
function pointInPolygon(point,polygon){return Boolean(polygon?.length)&&pointInRing(point,polygon[0])&&!polygon.slice(1).some(ring=>pointInRing(point,ring))}
function geometryContainsPoint(geometry,point){if(geometry?.type==='Polygon')return pointInPolygon(point,geometry.coordinates);if(geometry?.type==='MultiPolygon')return geometry.coordinates.some(polygon=>pointInPolygon(point,polygon));return false}

function parseCSV(text) {
  const rows=[]; let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i+=1){const c=text[i],next=text[i+1];if(c==='"'&&quoted&&next==='"'){cell+='"';i+=1}else if(c==='"')quoted=!quoted;else if(c===','&&!quoted){row.push(cell);cell=''}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&next==='\n')i+=1;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell=''}else cell+=c}
  if(cell||row.length){row.push(cell);rows.push(row)} if(rows.length<2)return [];
  const h=rows[0].map(x=>x.trim().toLowerCase()); const get=(r,names)=>{const idx=h.findIndex(x=>names.includes(x));return idx>=0?(r[idx]||'').trim():''};
  return rows.slice(1).filter(r=>r.some(Boolean)).map((r,i)=>{const lat=Number(get(r,['latitude','lat','широта']).replace(',','.')),lon=Number(get(r,['longitude','lon','lng','долгота']).replace(',','.'));const hasCoords=Number.isFinite(lat)&&Number.isFinite(lon)&&lat!==0&&lon!==0;return {id:i+1,name:get(r,['name','customer name','имя'])||`Заявка ${i+1}`,address:get(r,['address','адрес'])||'Адрес не указан',phone:get(r,['phone','телефон']),email:get(r,['email']),start:get(r,['time window start','window start']),end:get(r,['time window end','window end']),duration:Number(get(r,['duration','длительность']))||60,priority:i%9===0?'Авария':'Обычная',skill:['Локальные работы','Подключение','Дозаказ','Аварийные работы'][i%4],equipment:['Роутер','ТВ-приставка','Умная колонка','Аварийный комплект'][i%4],regionId:'moscow',status:'Новая',coords:hasCoords?[lat,lon]:null,geocodeStatus:hasCoords?'provided':'needs_geocoding'}});
}
const toMinutes=value=>{const[h,m]=String(value||'08:00').split(':').map(Number);return h*60+m};
const toTime=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
const durationLabel=value=>`${Math.floor(value/60)?`${Math.floor(value/60)} ч `:''}${value%60?`${value%60} мин`:''}`.trim();
const unassignedExplanation=(item,order,team=[])=>{
  if(item?.reasonCode==='STATIC_ELIGIBLE_BUT_UNSERVED'){
    const normalized=value=>String(value||'').toLocaleLowerCase('ru-RU');
    const required=normalized(effectiveOrderSkill(order));
    const eligible=team.filter(engineer=>normalized(orderZone(engineer))===normalized(orderZone(order))&&(engineer.skills||[]).some(skill=>normalized(skill)===required||(/подключ|install|connect/.test(normalized(skill))&&/подключ|install|connect/.test(required))));
    return{title:'Пока без назначения',summary:`По зоне и навыку предварительно подходят ${eligible.length} ${eligible.length===1?'бригада':'бригад'}. Готовый план не содержит точной причины. Ниже — отдельная проверка кандидатов; дорога в ней оценивается приближённо.`,action:'Сравните условия бригад и проверьте новый план.'};
  }
  if(item?.reasonCode==='NO_EXACT_FEASIBLE_INSERTION_IN_CURRENT_ROUTES')return{
    title:'Не поместилась в текущий план',
    summary:'Алгоритм не нашёл для заявки свободное место в уже рассчитанных маршрутах, которое одновременно соблюдает клиентское окно, длительность работы и смену инженера.',
    action:'Что делать: запустить полный пересчёт дня, расширить клиентское окно или добавить доступную бригаду.',
  };
  return{title:'Нужно решение диспетчера',summary:item?.reason||'Заявку не удалось безопасно включить в проверенный план.',action:'Откройте полный пересчёт, чтобы алгоритм заново проверил все маршруты.'};
};
async function requestPlan(orders,team,regionId,options={}){
  const response=await fetch('/api/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orders,engineers:team,regionId,planningDate:options.planningDate,options})});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'Планировщик временно недоступен');
  if(payload.status!=='EXACT_VALID'||payload.publicationAllowed!==true||payload.validation?.status!=='VALID'||payload.approximateTravel===true)throw new Error('Алгоритм не разрешил публикацию непроверенного плана');
  return payload;
}

function SiteSelect({value,options,onChange,disabled=false,placeholder='Выберите значение',ariaLabel}){
  const[open,setOpen]=useState(false),[menuStyle,setMenuStyle]=useState(null);
  const anchorRef=useRef(null),menuRef=useRef(null);
  const selected=options.find(([id])=>String(id)===String(value));
  const positionMenu=useCallback(()=>{const rect=anchorRef.current?.getBoundingClientRect();if(!rect)return;const menuHeight=Math.min(options.length*44+12,292);const top=rect.bottom+6+menuHeight>window.innerHeight?Math.max(8,rect.top-menuHeight-6):rect.bottom+6;setMenuStyle({top,left:Math.max(8,Math.min(rect.left,window.innerWidth-rect.width-8)),width:rect.width,maxHeight:menuHeight})},[options.length]);
  useLayoutEffect(()=>{if(open)positionMenu()},[open,positionMenu]);
  useEffect(()=>{if(!open)return;const outside=event=>{if(!anchorRef.current?.contains(event.target)&&!menuRef.current?.contains(event.target))setOpen(false)};const keydown=event=>{if(event.key==='Escape')setOpen(false)};const closeOnScroll=event=>{if(!menuRef.current?.contains(event.target))setOpen(false)};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',keydown);window.addEventListener('resize',positionMenu);document.addEventListener('scroll',closeOnScroll,true);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keydown);window.removeEventListener('resize',positionMenu);document.removeEventListener('scroll',closeOnScroll,true)}},[open,positionMenu]);
  return <div className={`site-select ${open?'is-open':''} ${disabled?'is-disabled':''}`} ref={anchorRef}>
    <button type="button" className="site-select-trigger" role="combobox" aria-label={ariaLabel||placeholder} aria-expanded={open} aria-haspopup="listbox" disabled={disabled} onClick={()=>setOpen(current=>!current)}><span className={selected?'':'placeholder'}>{selected?.[1]||placeholder}</span><ChevronDown/></button>
    {open&&menuStyle?createPortal(<div className="site-select-menu" ref={menuRef} role="listbox" aria-label={ariaLabel||placeholder} style={menuStyle}>{options.map(([id,label])=><button type="button" role="option" aria-selected={String(id)===String(value)} className={String(id)===String(value)?'selected':''} key={id} onClick={()=>{onChange(id);setOpen(false)}}><span>{label}</span>{String(id)===String(value)?<Check/>:null}</button>)}</div>,document.body):null}
  </div>
}

const GEOCODE_CACHE_KEY='beego-geoapify-cache-russia-v5';
const geocodeCacheId=address=>String(address||'').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru-RU');
const readGeocodeCache=()=>{try{return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY)||'{}')}catch{return{}}};
const writeGeocodeCache=cache=>{try{const entries=Object.entries(cache).slice(-3000);localStorage.setItem(GEOCODE_CACHE_KEY,JSON.stringify(Object.fromEntries(entries)))}catch{}};

const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function requestGeocodeBatch(batch){
  let lastError;
  for(let attempt=0;attempt<3;attempt+=1){
    try{
      const response=await fetch('/api/geocode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({addresses:batch,region:'moscow'})});
      const payload=await response.json().catch(()=>({}));
      if(response.ok)return payload;
      lastError=new Error(payload.error||'Не удалось подключиться к Geoapify');
    }catch(error){lastError=error}
    if(attempt<2)await wait(700*(attempt+1));
  }
  throw lastError||new Error('Не удалось подключиться к Geoapify');
}
async function geocodeImportedOrders(importedOrders,onProgress,onPartial){
  const cache=readGeocodeCache();
  const resolved=new globalThis.Map();
  const pending=[];
  importedOrders.forEach(order=>{
    if(Array.isArray(order.coords)&&order.coords.length===2&&order.coords.every(Number.isFinite))return;
    const rawAddress=String(order.address||'').trim(),city=String(order.city||order.regionName||'').trim();
    const address=city&&rawAddress&&!rawAddress.toLocaleLowerCase('ru-RU').includes(city.toLocaleLowerCase('ru-RU'))?`${city}, ${rawAddress}`:(rawAddress||city);
    const cacheId=geocodeCacheId(address);
    if(cache[cacheId])resolved.set(String(order.id),{...cache[cacheId],cached:true});
    else pending.push({id:order.id,address,district:order.district||orderDistrict(order)});
  });
  const total=resolved.size+pending.length;
  const materialize=()=>importedOrders.map(order=>{
    const result=resolved.get(String(order.id));
    if(!result)return order;
    return {...order,coords:Array.isArray(result.coords)?result.coords:null,geocodeStatus:result.status,geocodeConfidence:result.confidence??null,geocodedAddress:result.formattedAddress||'',geocodeProvider:'geoapify'};
  });
  onProgress({status:'active',active:true,done:resolved.size,total,failed:0});
  if(resolved.size)onPartial?.(materialize());
  let failed=0;
  for(let index=0;index<pending.length;index+=10){
    const batch=pending.slice(index,index+10);
    let payload;
    try{payload=await requestGeocodeBatch(batch)}catch{
      payload={results:batch.map(item=>({...item,status:'error',error:'Временная ошибка Geoapify'}))};
    }
    for(const result of payload.results||[]){
      resolved.set(String(result.id),result);
      if(result.coords)cache[geocodeCacheId(result.address)]=result;
      else failed+=1;
    }
    writeGeocodeCache(cache);
    onPartial?.(materialize());
    onProgress({status:'active',active:true,done:Math.min(total,resolved.size),total,failed});
  }
  writeGeocodeCache(cache);
  return materialize();
}
function Brand({onHome,staticMark=false,running=false,onAnimationEnd}){const mark=<img className={`beego-mark ${running?'running':''}`} src="/beego-mark.png" alt="" onAnimationEnd={onAnimationEnd}/>;return staticMark?<i className="bee-logo static-logo" aria-hidden="true">{mark}</i>:<button className="bee-logo" onClick={onHome} aria-label="BeeGo! — на главную" data-tooltip="BeeGo! — на главную">{mark}</button>}
function ProfileAvatar({profile,className=''}){const style={backgroundColor:profileAvatarColor(profile),color:'#2b2e32'};return profile.avatar?<img className={`profile-avatar ${className}`} style={style} src={`/avatars/${profile.avatar}.png`} alt=""/>:<span className={`profile-initials ${className}`} style={style}>{profile.name.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase()||'ЮК'}</span>}
function Sidebar({expanded,setExpanded,screen,setScreen,assistantOpen=false,workspacePanelOpen=true,orderCount,theme,setTheme,profile,onProfile,helpOpen,onHelp,region,notificationsOpen,onNotifications,unreadNotifications=0,hasReviewData=false,reviewOpen=false,onOpenReview}){const[logoRunning,setLogoRunning]=useState(false);const[sidebarAnimating,setSidebarAnimating]=useState(false);const[suppressSidebarTooltips,setSuppressSidebarTooltips]=useState(false);const sidebarAnimationTimerRef=useRef(null),tooltipSuppressTimerRef=useRef(null);useEffect(()=>()=>{clearTimeout(sidebarAnimationTimerRef.current);clearTimeout(tooltipSuppressTimerRef.current)},[]);const beginSidebarTransition=()=>{setSidebarAnimating(true);setSuppressSidebarTooltips(true)};const toggleSidebar=event=>{event.currentTarget.blur();setSidebarAnimating(true);setSuppressSidebarTooltips(true);setExpanded(value=>!value);clearTimeout(sidebarAnimationTimerRef.current);clearTimeout(tooltipSuppressTimerRef.current);sidebarAnimationTimerRef.current=setTimeout(()=>setSidebarAnimating(false),560);tooltipSuppressTimerRef.current=setTimeout(()=>setSuppressSidebarTooltips(false),1400)};return <aside className={`sidebar ${expanded?'expanded':''} ${notificationsOpen?'notifications-active':''} ${sidebarAnimating?'is-transitioning':''} ${suppressSidebarTooltips?'suppress-tooltips':''}`}>
  <button className="brand-row brand-home" onPointerEnter={()=>setLogoRunning(true)} onClick={()=>setScreen('orders')} aria-label="BeeGo! — на главную"><Brand staticMark running={logoRunning} onAnimationEnd={()=>setLogoRunning(false)}/><span className="brand-wordmark"><b>Bee</b><strong>Go!</strong></span></button>
  <nav><button className={`sidebar-location-button ${screen==='locations'&&!notificationsOpen&&!reviewOpen?'active':''}`} onClick={()=>setScreen('locations')} aria-label={`Локации: ${region.name}`} data-tooltip={`Локации: ${region.name}`}><MapPinned/><em>{region.name}</em></button>{navItems.filter(([id])=>id!=='review'||hasReviewData).map(([id,Icon,label])=><button key={id} className={(id==='assistant'?assistantOpen:reviewOpen ? id==='review' : screen===id&&!notificationsOpen&&(!['orders','engineers'].includes(id)||workspacePanelOpen))?'active':''} onClick={id==='review'?onOpenReview:()=>setScreen(id,{togglePanel:true})} aria-label={label} aria-pressed={id==='assistant'?assistantOpen:undefined} data-tooltip={label}><Icon/><em>{label}</em></button>)}<button className={`sidebar-notification-button ${notificationsOpen?'active':''}`} onClick={onNotifications} aria-label="Уведомления" data-tooltip="Уведомления"><Bell/><span className="notification-label"><em>Уведомления</em>{unreadNotifications?<small className="notification-nav-badge" aria-label="Есть новые уведомления"/>:null}</span></button></nav>
  <div className="sidebar-bottom"><button className={assistantOpen?'active':''} onClick={()=>setScreen('assistant')} aria-label="AI‑помощник" aria-pressed={assistantOpen} data-tooltip="AI‑помощник"><Sparkles/><em>AI‑помощник</em></button><button className={helpOpen?'active':''} onClick={onHelp} aria-label="Помощь" data-tooltip="Помощь"><CircleHelp/><em>Помощь</em></button><button className="profile-button" onClick={onProfile} aria-label="Открыть профиль" data-tooltip="Профиль"><ProfileAvatar profile={profile}/><span className="profile-copy"><em>Профиль</em><small>{profile.name}</small></span></button><label className="theme-switch" data-tooltip={theme==='dark'?'Светлая тема':'Тёмная тема'}><input type="checkbox" role="switch" checked={theme==='dark'} onChange={()=>setTheme(value=>value==='dark'?'light':'dark')} aria-label={theme==='dark'?'Включить светлую тему':'Включить тёмную тему'}/><span className="theme-switch-track" aria-hidden="true"><span className="theme-switch-thumb"><Sun className="theme-sun"/><Moon className="theme-moon"/></span></span><em>{theme==='dark'?'Тёмная тема':'Светлая тема'}</em></label><button onPointerDown={beginSidebarTransition} onClick={toggleSidebar} aria-label={expanded?'Свернуть меню':'Развернуть меню'} data-tooltip={expanded?'Свернуть меню':'Развернуть меню'}>{expanded?<ChevronsLeft/>:<ChevronsRight/>}<em>{expanded?'Свернуть меню':'Развернуть меню'}</em></button></div>
</aside>}
const MONTHS=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MONTHS_GENITIVE=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const MONTHS_SHORT=['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
const WEEKDAYS_SHORT=['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
const sameDay=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
const shiftDate=(date,days)=>new Date(date.getFullYear(),date.getMonth(),date.getDate()+days);
const startOfDay=date=>new Date(date.getFullYear(),date.getMonth(),date.getDate());
const isAfterDay=(date,limit)=>startOfDay(date).getTime()>startOfDay(limit).getTime();
const topDateLabel=date=>`${String(date.getDate()).padStart(2,'0')}.${String(date.getMonth()+1).padStart(2,'0')}.${date.getFullYear()}`;
const fullDateLabel=date=>`${WEEKDAYS_SHORT[date.getDay()]}, ${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]}`;

function DatePicker({value,onChange,onClose,className=''}){
  const[visibleMonth,setVisibleMonth]=useState(()=>new Date(value.getFullYear(),value.getMonth(),1));
  const[calendarMode,setCalendarMode]=useState('days');
  const today=startOfDay(new Date());
  const currentMonth=new Date(today.getFullYear(),today.getMonth(),1);
  const firstOffset=(visibleMonth.getDay()+6)%7;
  const gridStart=new Date(visibleMonth.getFullYear(),visibleMonth.getMonth(),1-firstOffset);
  const days=Array.from({length:42},(_,index)=>shiftDate(gridStart,index));
  const years=Array.from({length:12},(_,index)=>today.getFullYear()-11+index);
  const canMoveNextMonth=visibleMonth.getTime()<currentMonth.getTime();
  const moveMonth=direction=>setVisibleMonth(current=>{
    const next=new Date(current.getFullYear(),current.getMonth()+direction,1);
    return next.getTime()>currentMonth.getTime()?current:next;
  });
  const select=date=>{if(isAfterDay(date,today))return;onChange(startOfDay(date));onClose()};
  const selectMonth=index=>{
    if(visibleMonth.getFullYear()===today.getFullYear()&&index>today.getMonth())return;
    setVisibleMonth(current=>new Date(current.getFullYear(),index,1));
    setCalendarMode('days');
  };
  const selectYear=year=>{
    const month=year===today.getFullYear()?Math.min(visibleMonth.getMonth(),today.getMonth()):visibleMonth.getMonth();
    setVisibleMonth(new Date(year,month,1));
    setCalendarMode('days');
  };
  return <section className={`date-popover ${className}`.trim()} role="dialog" aria-label="Выбор даты">
    <div className="calendar-head">
      <button type="button" onClick={()=>moveMonth(-1)} aria-label="Предыдущий месяц" data-tooltip="Предыдущий месяц"><ChevronLeft/></button>
      <div className="calendar-selectors">
        <button type="button" className={calendarMode==='months'?'calendar-select active':'calendar-select'} onClick={()=>setCalendarMode(mode=>mode==='months'?'days':'months')} aria-expanded={calendarMode==='months'}>{MONTHS[visibleMonth.getMonth()]}<ChevronDown/></button>
        <button type="button" className={calendarMode==='years'?'calendar-select active':'calendar-select'} onClick={()=>setCalendarMode(mode=>mode==='years'?'days':'years')} aria-expanded={calendarMode==='years'}>{visibleMonth.getFullYear()}<ChevronDown/></button>
      </div>
      <button type="button" disabled={!canMoveNextMonth} onClick={()=>moveMonth(1)} aria-label={canMoveNextMonth?'Следующий месяц':'Будущие месяцы недоступны'} data-tooltip={canMoveNextMonth?'Следующий месяц':'Будущие месяцы недоступны'}><ChevronRight/></button>
    </div>
    {calendarMode==='months'?<div className="month-grid">{MONTHS.map((month,index)=>{const disabled=visibleMonth.getFullYear()===today.getFullYear()&&index>today.getMonth();return <button type="button" key={month} disabled={disabled} className={index===visibleMonth.getMonth()?'selected':''} onClick={()=>selectMonth(index)}>{month.slice(0,3)}</button>})}</div>:calendarMode==='years'?<div className="year-grid">{years.map(year=><button type="button" key={year} className={year===visibleMonth.getFullYear()?'selected':''} onClick={()=>selectYear(year)}>{year}</button>)}</div>:<>
      <div className="weekday-row">{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day=><span key={day}>{day}</span>)}</div>
      <div className="calendar-grid">{days.map(date=>{const outside=date.getMonth()!==visibleMonth.getMonth();const future=isAfterDay(date,today);const selected=sameDay(date,value);const showToday=selected&&sameDay(date,today);return <button type="button" key={date.toISOString()} disabled={future} className={`${outside?'outside ':''}${future?'future ':''}${showToday?'today ':''}${selected?'selected':''}`} onClick={()=>select(date)} aria-label={`${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]} ${date.getFullYear()}${future?', недоступно':''}`}>{date.getDate()}</button>})}</div>
    </>}
    <div className="calendar-footer"><button type="button" onClick={()=>select(today)}><CalendarDays/>Сегодня</button><span>{fullDateLabel(value)}</span></div>
  </section>;
}

function DateControl({value,onChange,className=''}){
  const[calendarOpen,setCalendarOpen]=useState(false);
  const dateControlRef=useRef(null);
  const calendarPresence=useDropdownPresence(calendarOpen,200);
  useEffect(()=>{if(!calendarOpen)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='mousedown'&&!dateControlRef.current?.contains(event.target)))setCalendarOpen(false)};document.addEventListener('mousedown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',close)}},[calendarOpen]);
  const today=startOfDay(new Date());
  const isToday=sameDay(value,today);
  return <div className={`date-control ${className}`.trim()} ref={dateControlRef}>
    <div className="date-switch"><button type="button" onClick={()=>onChange(date=>shiftDate(date,-1))} aria-label="Предыдущий день" data-tooltip="Предыдущий день"><ChevronLeft size={20}/></button><button type="button" className={calendarOpen?'active':''} onClick={()=>setCalendarOpen(open=>!open)} aria-label={`Выбрать дату: ${topDateLabel(value)}`} aria-expanded={calendarOpen}><CalendarDays size={20}/><strong>{topDateLabel(value)}</strong>{isToday?<span>Сегодня</span>:null}<ChevronDown className="date-chevron" size={16}/></button><button type="button" disabled={isToday} onClick={()=>onChange(date=>isAfterDay(shiftDate(date,1),today)?today:shiftDate(date,1))} aria-label={isToday?'Будущие даты недоступны':'Следующий день'} data-tooltip={isToday?'Будущие даты недоступны':'Следующий день'}><ChevronRight size={20}/></button></div>
    {calendarPresence.present?<DatePicker value={value} onChange={onChange} onClose={()=>setCalendarOpen(false)} className={`dropdown-transition ${calendarPresence.visible?'is-open':'is-closing'}`}/>:null}
  </div>;
}

function NotificationHub({items=[],open=false,onToggle=()=>{},onClose=()=>{},onClear=()=>{}}){
  const rootRef=useRef(null),presence=useDropdownPresence(open,210);
  useEffect(()=>{if(!open)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='pointerdown'&&!rootRef.current?.contains(event.target)))onClose()};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close)}},[open,onClose]);
  const unread=items.filter(item=>!item.read).length;
  return <div className="notification-hub" ref={rootRef}><button type="button" className={`icon notification-bell ${open?'active':''}`} onClick={onToggle} aria-label="Уведомления" data-tooltip="Уведомления"><Bell/>{unread?<i aria-label={`${unread} непрочитанных`}>{unread>9?'9+':unread}</i>:null}</button>{presence.present?<aside className={`notification-panel dropdown-transition ${presence.visible?'is-open':'is-closing'}`}><header><div><b>Уведомления</b><small>{unread?`${unread} новых`:'Всё просмотрено'}</small></div>{items.length?<button type="button" onClick={onClear}><CheckCheck/>Очистить</button>:null}</header><div className="notification-list">{items.length?items.map(item=><article className={item.read?'':'unread'} key={item.id}><span><Check/></span><div><b>{item.title||'BeeGo!'}</b><p>{item.message}</p><small>{item.time}</small></div></article>):<div className="notification-empty"><Bell/><b>Пока тихо</b><p>Здесь появятся результаты импорта, планирования и другие важные события.</p></div>}</div></aside>:null}</div>;
}
function NotificationGlyph({item}){
  const text=`${item?.title||''} ${item?.message||''}`.toLocaleLowerCase('ru-RU');
  const kind=/авари|ошиб|не выполн/.test(text)?'alert':/импорт|загруж|адрес/.test(text)?'import':/план|маршрут|распредел/.test(text)?'route':'success';
  if(kind==='alert')return <svg className={`notification-glyph ${kind}`} viewBox="0 0 32 32" aria-hidden="true"><path className="glyph-wash" d="M16 3.8 29 27H3z"/><path d="M16 5.5 28 26.5H4z"/><path d="M16 12v7"/><circle className="glyph-dot" cx="16" cy="23" r="1.35"/></svg>;
  if(kind==='import')return <svg className={`notification-glyph ${kind}`} viewBox="0 0 32 32" aria-hidden="true"><path className="glyph-wash" d="M7 3h13l6 6v20H7z"/><path d="M8 3.8h11.5L25 9.3V28H8z"/><path d="M19.5 4v5.5H25M12 14h9M12 18h9M12 22h5"/><path className="glyph-accent" d="m18.5 23.5 2.8 2.8 5.2-6"/></svg>;
  if(kind==='route')return <svg className={`notification-glyph ${kind}`} viewBox="0 0 32 32" aria-hidden="true"><circle className="glyph-wash" cx="8" cy="24" r="4.7"/><circle className="glyph-wash" cx="24" cy="8" r="4.7"/><circle cx="8" cy="24" r="3.4"/><circle cx="24" cy="8" r="3.4"/><path d="M11.5 23.5c7.5-.3 2.7-10.8 10-12.2"/><path className="glyph-accent" d="m18.8 8.8 3.2 2.6-2.7 3.1"/></svg>;
  return <svg className={`notification-glyph ${kind}`} viewBox="0 0 32 32" aria-hidden="true"><circle className="glyph-wash" cx="16" cy="16" r="13"/><circle cx="16" cy="16" r="11"/><path className="glyph-accent" d="m10.5 16.2 3.7 3.8 7.8-8"/></svg>;
}

const NOTIFICATION_ARTWORK={
  route:'/notifications/route.svg',
  import:'/notifications/import.svg',
  alert:'/notifications/alert.svg',
  assignment:'/notifications/assignment.svg',
  location:'/notifications/location.svg',
  profile:'/notifications/profile.svg',
  system:'/notifications/system.svg',
};

function NotificationArtwork({kind}){
  if(kind==='alert')return <svg className="notification-alert-artwork" viewBox="0 0 64 64" role="img" aria-label="Ошибка"><path className="alert-shadow" d="M32 7 58 53H6Z"/><path className="alert-body" d="M32 8.5 56.5 52H7.5Z"/><path className="alert-mark" d="M32 23v13"/><circle className="alert-dot" cx="32" cy="43" r="2.7"/><circle className="alert-badge" cx="50" cy="49" r="10"/><path className="alert-cross" d="m46.5 45.5 7 7m0-7-7 7"/></svg>;
  return <img src={NOTIFICATION_ARTWORK[kind]||NOTIFICATION_ARTWORK.system} alt=""/>;
}

function notificationPresentation(item){
  const suppliedTitle=(item?.title||'').trim();
  const text=`${suppliedTitle} ${item?.message||''}`.toLocaleLowerCase('ru-RU');
  if(/авари/.test(text))return{kind:'alert',title:/не выполн|ошиб|недоступ/.test(text)?'Аварийный план не построен':'Аварийный маршрут обновлён'};
  if(/ошиб|не выполн|не удалось|недоступ/.test(text))return{kind:'alert',title:suppliedTitle&&suppliedTitle!=='BeeGo!'?suppliedTitle:'Требуется внимание'};
  if(/участ|регион|адресам файла/.test(text))return{kind:'location',title:'Рабочий участок определён'};
  if(/импорт|загруж|файл|геокод/.test(text))return{kind:'import',title:/ошиб|не найден/.test(text)?'Проверьте адреса':'Данные успешно загружены'};
  if(/настройки планирования/.test(text))return{kind:'system',title:'Планирование сохранено'};
  if(/настройки ограничений/.test(text))return{kind:'system',title:'Ограничения сохранены'};
  if(/переплан/.test(text))return{kind:'route',title:'Маршруты перестроены'};
  if(/план|маршрут|распредел/.test(text))return{kind:'route',title:'Маршруты построены'};
  if(/назначен|инженер|команд/.test(text))return{kind:'assignment',title:/сохран/.test(text)?'Назначение сохранено':'Команда обновлена'};
  if(/профил|настрой/.test(text))return{kind:'profile',title:'Профиль обновлён'};
  return{kind:'system',title:suppliedTitle&&suppliedTitle!=='BeeGo!'?suppliedTitle:'Системное событие'};
}

function NotificationCenter({items=[],open=false,expanded=false,onClose=()=>{},onClear=()=>{},onRead=()=>{}}){
  const[filter,setFilter]=useState('unread');
  const presence=useDropdownPresence(open,230);
  const motionClass=presence.visible?'is-open':open?'is-opening':'is-closing';
  const visible=items.filter(item=>filter==='unread'?!item.read:item.read);
  if(!presence.present)return null;
  return <div className={`notification-center-layer ${expanded?'sidebar-wide':''} ${motionClass}`}><button className="notification-center-scrim" type="button" onClick={onClose} aria-label="Закрыть уведомления"/><aside className="notification-center" role="dialog" aria-label="Уведомления"><header><div><button type="button" onClick={onClose} aria-label="Закрыть"><X/></button><h2>Уведомления</h2></div>{visible.length?<button type="button" className="notification-clear" onClick={()=>onClear(filter)} aria-label={filter==='unread'?'Очистить непрочитанные уведомления':'Очистить прочитанные уведомления'}><CheckCheck/>Очистить</button>:null}</header><div className="notification-tabs"><button type="button" className={filter==='unread'?'active':''} onClick={()=>setFilter('unread')}>Непрочитанные</button><button type="button" className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>Все</button></div><div className="notification-center-list">{visible.length?visible.map(item=>{const presentation=notificationPresentation(item);return <article className={item.read?'':'unread'} data-notification-id={item.id} data-read={item.read?'true':'false'} data-notification-kind={presentation.kind} key={item.id}><span className="notification-artwork"><NotificationArtwork kind={presentation.kind}/></span><div><b>{presentation.title}</b><p>{item.message}</p><small>{item.time}</small>{!item.read?<button type="button" className="notification-mark-read" onClick={()=>onRead(item.id)} aria-label="Отметить уведомление прочитанным"><Check/><span>Прочитано</span></button>:<em className="notification-read-state"><Check/>Прочитано</em>}</div></article>}):<div className="notification-center-empty"><img src="/notification-empty.svg" alt="Пустой центр уведомлений"/><b>{filter==='unread'?'Новых уведомлений нет':'Прочитанных уведомлений пока нет'}</b><p>Здесь появятся результаты импорта, расчёта маршрутов и важные события смены.</p></div>}</div></aside></div>;
}
function CityArtwork({region}){
  const seed=[...region.name].reduce((sum,character)=>sum+character.charCodeAt(0),0);
  const buildings=Array.from({length:7},(_,index)=>({x:18+index*19,y:50-((seed+index*13)%24),w:13+((seed+index*7)%7),h:44+((seed+index*11)%28)}));
  return <svg className="city-artwork" viewBox="0 0 170 112" role="img" aria-label={`Иллюстрация города ${region.name}`}><defs><linearGradient id={`sky-${region.id}`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff7bd"/><stop offset="1" stopColor="#ffd21f"/></linearGradient></defs><rect width="170" height="112" rx="22" fill={`url(#sky-${region.id})`}/><circle cx="137" cy="24" r="11" fill="#fff6cf"/><path d="M0 82c27-13 46-12 68-2 28 12 54 9 102-8v40H0Z" fill="#f2c100" opacity=".55"/><path d="M0 91c35-8 61-3 87 6 27 9 55 6 83-3v18H0Z" fill="#fffbe6"/>{buildings.map((building,index)=><g key={index}><rect x={building.x} y={building.y} width={building.w} height={building.h} rx="2" fill={index%2?'#fffdf2':'#30343a'}/>{Array.from({length:3},(_,windowIndex)=><rect key={windowIndex} x={building.x+4+(windowIndex%2)*6} y={building.y+7+Math.floor(windowIndex/2)*9} width="3" height="4" rx="1" fill={index%2?'#ffd21f':'#fff4ac'}/>)}</g>)}{region.artwork==='river'||region.artwork==='bridge'?<path d="M4 96c35-18 63-18 88 0 23 16 49 16 74 0M28 89c29-25 83-25 112 0" fill="none" stroke="#288f9b" strokeWidth="4" strokeLinecap="round"/>:null}{region.artwork==='capital'?<path d="M82 65V29m-8 12 8-17 8 17" fill="none" stroke="#ef3e32" strokeWidth="5" strokeLinejoin="round"/>:null}{region.artwork==='spire'?<path d="M86 66V23m-9 22 9-25 9 25" fill="#fffdf2" stroke="#30343a" strokeWidth="3" strokeLinejoin="round"/>:null}<circle cx="32" cy="24" r="6" fill="#30343a"/><path d="M32 30v15" stroke="#30343a" strokeWidth="3" strokeLinecap="round"/></svg>;
}
function LocationsPage({regions=[],region,onSelect=()=>{},onOpenOrders=()=>{},onClose=()=>{},motionClass=''}){
  const[query,setQuery]=useState('');
  const hasLocations=regions.some(item=>item.hasData);
  const normalizedQuery=query.trim().toLocaleLowerCase('ru-RU');
  const visibleRegions=normalizedQuery?regions.filter(item=>item.name.toLocaleLowerCase('ru-RU').includes(normalizedQuery)):regions;
  return <PageShell floating className="locations-workspace workspace-panel-enter" title="Локации" motionClass={motionClass} action={<button type="button" className="panel-close" onClick={onClose} aria-label="Закрыть локации" data-tooltip="Закрыть"><X/></button>}>
    {hasLocations?<div className="locations-results">
      <div className="locations-search"><Search/><input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Найти локацию по названию" aria-label="Поиск локации по названию"/><span>{visibleRegions.length}</span>{query?<button type="button" onClick={()=>setQuery('')} aria-label="Очистить поиск"><X/></button>:null}</div>
      {visibleRegions.length?<div className="location-card-grid" role="listbox" aria-label="Города из загруженных данных">
        {visibleRegions.map(item=><button type="button" role="option" aria-selected={item.id===region.id} className={item.id===region.id?'selected':''} key={item.id} onClick={()=>onSelect(item)}><CityArtwork region={item}/><span><b>{item.name}</b>{item.hasData?<small>Данные загружены</small>:<small>Данные не загружены</small>}</span>{item.id===region.id?<i><Check/></i>:<ChevronRight/>}</button>)}
      </div>:<div className="locations-search-empty"><Search/><h2>Локация не найдена</h2><p>Проверьте название или очистите строку поиска.</p><button type="button" onClick={()=>setQuery('')}>Сбросить поиск</button></div>}
    </div>:<div className="locations-page-empty"><img src="/locations-empty.svg" alt=""/><h2>Данные не загружены</h2><button type="button" className="primary" onClick={onOpenOrders}><Download/>Загрузить данные</button></div>}
  </PageShell>;
}
function Topbar({selectedDate,setSelectedDate}){
  return <header className="topbar minimal-topbar"><DateControl value={selectedDate} onChange={setSelectedDate}/></header>;
}
function Metrics({orders,plan}){const metrics=plan?.metrics;const planMode=plan?.status==='EXACT_VALID'?['Точный план','Независимо проверенный расчёт']:null;return <div className="metrics">{planMode?<span className="plan-mode-metric" title={planMode[1]}><ShieldCheck/> {planMode[0]}</span>:null}<span title="Маршруты"><Route/> {metrics?.activeEngineers||0}</span><span title="Распределено"><BriefcaseBusiness/> {metrics?.assigned||0}</span><span title="Пробег"><MapPin/> {metrics?`${metrics.distanceKm} км`:'0 км'}</span><span title="В дороге"><Clock3/> {metrics?durationLabel(metrics.travelMinutes):'0 мин'}</span><span title="Не назначено"><PackageCheck/> {metrics?.unassigned??orders.length}</span></div>}
function fitMapToContent(map,positions,animate=true){
  if(!map)return;
  map.stop();
  if(positions.length){
    const bounds=new maplibregl.LngLatBounds();
    positions.forEach(([lat,lon])=>bounds.extend([lon,lat]));
    optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding:64,maxZoom:13,duration:animate?900:0,essential:true}),animate);
  }else optimizedCameraMove(map,()=>map.flyTo({center:[DEFAULT_MAP_CENTER[1],DEFAULT_MAP_CENTER[0]],zoom:DEFAULT_MAP_ZOOM,duration:animate?900:0,essential:true}),animate);
}

function NorthSouthNeedle(){
  return <svg className="north-south-needle" viewBox="0 0 24 24" aria-hidden="true">
    <path className="needle-north" d="M12 2.5 7.2 11H12Z"/>
    <path className="needle-north" d="M12 2.5 16.8 11H12Z"/>
    <path className="needle-south" d="M12 21.5 7.2 13H12Z"/>
    <path className="needle-south" d="M12 21.5 16.8 13H12Z"/>
  </svg>;
}

function MapControls({map,positions,popupsEnabled,onTogglePopups,onToggleThemes,themesOpen,onLocate,onResetOrientation,locating,locationVisible,is3D,onToggle3D,legendOpen,onToggleLegend,legendContent,legendDark}){
  const run=(action)=>(event)=>{event.preventDefault();event.stopPropagation();action()};
  const smoothZoom=(delta)=>{if(map)map.easeTo({zoom:Math.max(MAP_MIN_ZOOM,Math.min(MAP_MAX_ZOOM,map.getZoom()+delta)),duration:520,easing:t=>1-(1-t)**3,essential:true})};
  const stopEvents={onMouseDown:event=>event.stopPropagation(),onDoubleClick:event=>event.stopPropagation(),onWheel:event=>event.stopPropagation()};
  const compassRef=useRef(null);
  const stackRef=useRef(null);
  const legendButtonRef=useRef(null),legendPopupRef=useRef(null);
  const [legendBottom,setLegendBottom]=useState(12);
  useLayoutEffect(()=>{if(!legendOpen)return undefined;const measure=()=>{const rect=legendButtonRef.current?.getBoundingClientRect();if(rect)setLegendBottom(Math.max(12,window.innerHeight-rect.bottom))};measure();window.addEventListener('resize',measure);return()=>window.removeEventListener('resize',measure)},[legendOpen]);
  useEffect(()=>{if(!legendOpen)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='pointerdown'&&!stackRef.current?.contains(event.target)&&!legendPopupRef.current?.contains(event.target)))onToggleLegend(false)};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close)}},[legendOpen,onToggleLegend]);
  useEffect(()=>{
    if(!map)return undefined;
    const syncCompass=()=>{if(compassRef.current)compassRef.current.style.transform=`rotate(${-map.getBearing()}deg)`};
    syncCompass();
    map.on('rotate',syncCompass);
    return()=>map.off('rotate',syncCompass);
  },[map]);
  return <>
    <div ref={stackRef} className="map-control-stack" role="toolbar" aria-label="Управление картой" {...stopEvents}>
      <div className="map-control-group zoom-controls">
        <button type="button" onClick={run(()=>smoothZoom(1))} disabled={!map} aria-label="Увеличить масштаб" data-tooltip="Увеличить масштаб"><ZoomIn/></button>
        <button type="button" onClick={run(()=>smoothZoom(-1))} disabled={!map} aria-label="Уменьшить масштаб" data-tooltip="Уменьшить масштаб"><ZoomOut/></button>
      </div>
      <div className="map-control-group location-controls">
        <button type="button" onClick={run(()=>fitMapToContent(map,positions))} disabled={!map} aria-label="Показать все точки" data-tooltip="Показать все точки"><Maximize2/></button>
        <button type="button" onClick={run(onLocate)} disabled={!map||locating} className={`${locating?'loading ':''}${locationVisible?'enabled':''}`} aria-pressed={locationVisible} aria-label={locationVisible?'Скрыть моё местоположение':'Показать моё местоположение'} data-tooltip={locationVisible?'Скрыть моё местоположение':'Показать моё местоположение'}><LocateFixed/></button>
        <button type="button" onClick={run(onResetOrientation)} disabled={!map} aria-label="Вернуть север наверх" data-tooltip="Вернуть север наверх"><span ref={compassRef} className="compass-glyph"><NorthSouthNeedle/></span></button>
        <button type="button" className={popupsEnabled?'enabled':''} onClick={run(onTogglePopups)} aria-pressed={popupsEnabled} aria-label={popupsEnabled?'Выключить подсказки на карте':'Включить подсказки на карте'} data-tooltip={popupsEnabled?'Выключить подсказки':'Включить подсказки'}>{popupsEnabled?<MessageSquare/>:<MessageSquareOff/>}</button>
      </div>
      <div className="map-control-group three-d-controls">
        <button type="button" onClick={run(onToggle3D)} disabled={!map} className={is3D?'enabled':''} aria-pressed={is3D} aria-label="Переключить 3D-режим" data-tooltip="3D-здания"><Box/><span>3D</span></button>
      </div>
      {legendContent?<div className="map-control-group legend-controls"><button ref={legendButtonRef} type="button" className={legendOpen?'enabled':''} onClick={run(onToggleLegend)} aria-expanded={legendOpen} aria-controls="map-legend-popover" aria-label={legendOpen?'Закрыть легенду карты':'Открыть легенду карты'} data-tooltip="Легенда карты"><List size={21}/></button></div>:null}
    </div>
    {legendOpen&&legendContent?createPortal(<div ref={legendPopupRef} className={`map-legend-portal${legendDark?' dark':''}`} style={{bottom:legendBottom}}>{legendContent}</div>,document.body):null}
    <button type="button" className={`map-layers-control ${themesOpen?'enabled':''}`} onClick={run(onToggleThemes)} aria-pressed={themesOpen} aria-expanded={themesOpen} aria-label={themesOpen?'Закрыть выбор темы карты':'Выбрать тему карты'} data-tooltip={themesOpen?'Закрыть темы карты':'Выбрать тему карты'} {...stopEvents}><Layers3/></button>
  </>
}

function MapThemePicker({value,onChange,onClose,className='',pickerRef=null}){
  return <section ref={pickerRef} className={`map-theme-picker ${className}`.trim()} role="dialog" aria-label="Тема карты">
    <header><h3>Тема карты</h3><button type="button" onClick={onClose} aria-label="Закрыть" data-tooltip="Закрыть"><X/></button></header>
    <div>{Object.entries(MAP_THEMES).map(([id,theme])=><button type="button" key={id} className={value===id?'selected':''} onClick={()=>{onChange(id);onClose()}}><span className={`theme-preview theme-${id}`} aria-hidden="true"><img src={id==='night'?'/map-theme-night.jpg':'/map-theme-day.jpg'} alt=""/></span><strong>{theme.name}</strong><i>{value===id?<Check/>:null}</i></button>)}</div>
  </section>;
}

function LocationConsentArtwork({blocked=false}){
  return <div className={`location-artwork ${blocked?'is-blocked':''}`} aria-hidden="true">
    <img className="location-artwork-map" src="/map-theme-day.jpg" alt=""/>
    <span className="location-artwork-shade"/>
    <img className="location-artwork-character" src={blocked?'/avatars/dragon-flying.png':'/avatars/fox-map.png'} alt=""/>
    <span className="location-artwork-badge">{blocked?<LockKeyhole/>:<LocateFixed/>}</span>
  </div>;
}

function prepareMapStyle(map){
  const paint=(id,property,value)=>{if(map.getLayer(id))map.setPaintProperty(id,property,value)};
  const zoomRange=(id,min,max=24)=>{if(map.getLayer(id))map.setLayerZoomRange(id,min,max)};
  const russianName=['coalesce',['get','name:ru'],['get','name'],['get','name:nonlatin'],['get','name:latin']];
  map.getStyle().layers.forEach(layer=>{
    if(layer.type==='symbol'&&layer.layout?.['text-field']&&!layer.id.includes('shield'))map.setLayoutProperty(layer.id,'text-field',russianName);
    if(layer.type==='symbol'&&layer['source-layer']==='poi'){
      map.setLayoutProperty(layer.id,'visibility','none');
    }
  });
  const overviewRoads=[
    ['highway-motorway-casing',1.35,2.15,'#d39c61'],
    ['highway-motorway',.8,1.5,'#f2b85e'],
    ['highway-trunk-casing',1.2,1.95,'#d4a56b'],
    ['highway-trunk',.7,1.3,'#f2c577'],
    ['highway-primary-casing',.95,1.65,'#d9b37b'],
    ['highway-primary',.5,1.05,'#f4d596'],
  ];
  overviewRoads.forEach(([id,atZoom4,atZoom7,color])=>{
    zoomRange(id,4);
    paint(id,'line-color',color);
    paint(id,'line-opacity',['interpolate',['linear'],['zoom'],3.8,0,4.25,1]);
    paint(id,'line-width',['interpolate',['linear'],['zoom'],4,atZoom4,7,atZoom7,11,4.2,16,10]);
  });
  ['highway-secondary-tertiary-casing','highway-secondary-tertiary'].forEach((id,index)=>{
    zoomRange(id,5);
    paint(id,'line-color',index===0?'#d8bf98':'#f7e6bd');
    paint(id,'line-opacity',['interpolate',['linear'],['zoom'],5,0,5.7,.8,7,1]);
    paint(id,'line-width',['interpolate',['linear'],['zoom'],5,index===0?.55:.3,7,index===0?1.05:.65,11,index===0?3.2:2.2,16,index===0?8:6]);
  });
}

function applyMapTheme(map,themeId='day'){
  const theme=MAP_THEMES[themeId]||MAP_THEMES.day;
  const paint=(id,property,value)=>{try{if(map.getLayer(id))map.setPaintProperty(id,property,value)}catch(error){console.warn(`Не удалось применить ${property} к слою ${id}:`,error?.message||error)}};
  map.getStyle().layers.forEach(layer=>{
    if(/^(?:planned-route|selected-district)/.test(layer.id))return;
    const key=`${layer.id} ${layer['source-layer']||''}`.toLowerCase();
    const isWater=/(?:water|waterway|ocean|river|lake)/.test(key);
    const isPark=/(?:park|grass|wood|forest|cemetery|pitch)/.test(key);
    const isBuilding=/(?:building)/.test(key);
    const isCommercial=/(?:commercial|retail)/.test(key);
    const isIndustrial=/(?:industrial)/.test(key);
    const isResidential=/(?:residential|suburb|landuse)/.test(key);
    const isRoad=ROAD_LAYER_PATTERN.test(key)||/(?:highway|road|street|transportation)/.test(key);
    const isBoundary=/(?:boundary|admin)/.test(key);
    if(layer.type==='background')paint(layer.id,'background-color',theme.land);
    if(layer.type==='fill'){
      const fill=isWater?theme.water:isPark?(key.includes('wood')||key.includes('forest')?theme.wood:theme.park):isBuilding?(themeId==='night'?'#2B373D':themeId==='gray'?'#D6D9D8':'#E5DFD2'):isCommercial?theme.commercial:isIndustrial?theme.industrial:isResidential?theme.residential:theme.land;
      paint(layer.id,'fill-color',fill);
      if(!isBuilding)paint(layer.id,'fill-opacity',themeId==='night'?.92:themeId==='muted'?.78:.88);
    }
    if(layer.type==='line'){
      if(isWater)paint(layer.id,'line-color',themeId==='night'?'#315D78':'#73B9DC');
      else if(isBoundary)paint(layer.id,'line-color',theme.boundary);
      else if(isRoad){
        const casing=/(?:casing|outline)/.test(key);
        const roadColor=themeId==='night'?(casing?'#0B1117':'#47627B'):themeId==='gray'?(casing?'#C4C9C8':'#FFFFFF'):themeId==='muted'?(casing?'#CBBFA8':'#F5EFE1'):(casing?'#D6AB70':'#F3C46F');
        paint(layer.id,'line-color',roadColor);
      }
    }
    if(layer.type==='symbol'&&layer.layout?.['text-field']&&!layer.id.includes('shield')){
      const labelColor=themeId==='night'?(isWater?'#86BEFF':isRoad?'#D4E6F4':'#E7F0F4'):(isWater?'#4D7EA4':isRoad?'#59666A':theme.label);
      paint(layer.id,'text-color',labelColor);
      paint(layer.id,'text-halo-color',themeId==='night'?'#0B151D':theme.halo);
      paint(layer.id,'text-halo-width',isRoad?1.1:1.35);
      paint(layer.id,'text-halo-blur',themeId==='night'?.25:.45);
    }
  });
  map.getContainer().dataset.mapTheme=themeId;
  map.triggerRepaint();
}

function optimizedCameraMove(map,move,shouldOptimize=true){
  if(!map||!shouldOptimize)return move();
  const previous=map.cancelPendingTileRequestsWhileZooming;
  map.cancelPendingTileRequestsWhileZooming=true;
  let fallback;
  const restore=()=>{
    clearTimeout(fallback);
    map.off('moveend',restore);
    map.cancelPendingTileRequestsWhileZooming=previous;
  };
  map.once('moveend',restore);
  fallback=setTimeout(restore,2400);
  return move();
}

function ensure3DBuildingLayer(map){
  if(map.getLayer('buildings-3d')||!map.getSource('openmaptiles'))return;
  const firstSymbol=map.getStyle().layers.find(layer=>layer.type==='symbol')?.id;
  map.addLayer({id:'buildings-3d',type:'fill-extrusion',source:'openmaptiles','source-layer':'building',minzoom:13,filter:['!=',['get','hide_3d'],true],layout:{visibility:'none'},paint:{'fill-extrusion-color':['interpolate',['linear'],['zoom'],13,'#e5d79b',17,'#c8a83d'],'fill-extrusion-height':['coalesce',['get','render_height'],8],'fill-extrusion-base':['coalesce',['get','render_min_height'],0],'fill-extrusion-opacity':.92,'fill-extrusion-vertical-gradient':true}},firstSymbol);
}

function setMap3D(map,enabled){
  if(!map)return;
  const apply=()=>{
    ensure3DBuildingLayer(map);
    if(map.getLayer('buildings-3d'))map.setLayoutProperty('buildings-3d','visibility',enabled?'visible':'none');
    ['building','building-top'].forEach(id=>{if(map.getLayer(id))map.setLayoutProperty(id,'visibility',enabled?'none':'visible')});
    const targetZoom=enabled?Math.max(map.getZoom(),15.5):map.getZoom();
    const longZoom=enabled&&targetZoom-map.getZoom()>2;
    optimizedCameraMove(map,()=>map.easeTo({zoom:targetZoom,pitch:enabled?52:0,bearing:enabled?-17:0,duration:850,easing:t=>1-(1-t)**3,essential:true}),longZoom);
  };
  if(map.isStyleLoaded())apply();else map.once('style.load',apply);
}

function TerritoryFilter({zones,districts,value,onChange,total}){
  const[open,setOpen]=useState(false),rootRef=useRef(null),presence=useDropdownPresence(open,260);
  useEffect(()=>{if(!open)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='pointerdown'&&!rootRef.current?.contains(event.target)))setOpen(false)};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close)}},[open]);
  const choose=next=>{onChange(next);setOpen(false)};
  const selected=territorySelection(value);
  const selectionType=selected.kind==='zone'?'Зона из таблицы':selected.kind==='district'?'Район Москвы':'Выбор территории';
  return <div className="district-filter" ref={rootRef}><button type="button" className={value?'active':'empty'} onClick={()=>setOpen(current=>!current)} aria-haspopup="listbox" aria-expanded={open}><MapPinned/><span className="district-filter-copy"><small>{value?`Выбрано · ${selectionType}`:selectionType}</small><b>{selected.name||'Все территории'}</b></span><span className="district-filter-action" aria-hidden="true"><ChevronDown/></span></button>{presence.present?<div className={`district-filter-menu dropdown-transition ${presence.visible?'is-open':'is-closing'}`} role="listbox" aria-label="Выбор территории"><button type="button" className={!value?'selected':''} role="option" aria-selected={!value} onClick={()=>choose('')}><span className="district-all-icon"><Map/></span><div><b>Все территории</b><small>Все районы и зоны · показать все заявки</small></div><em>{total}</em>{!value?<Check/>:null}</button>{zones.length?<><div className="district-filter-section-title"><Layers3/>Зоны из таблицы</div>{zones.map(item=>{const key=`zone:${item.name}`;return <button type="button" className={value===key?'selected':''} role="option" aria-selected={value===key} key={key} onClick={()=>choose(key)}><span className="district-zone-icon"><Layers3/></span><div><b>{item.name}</b><small>{item.count} {item.count===1?'заявка':'заявок'}</small></div><em>{item.count}</em>{value===key?<Check/>:null}</button>})}</>:null}{districts.length?<><div className="district-filter-section-title"><MapPinned/>Районы Москвы</div>{districts.map(item=>{const key=`district:${item.name}`;return <button type="button" className={value===key?'selected':''} role="option" aria-selected={value===key} key={key} onClick={()=>choose(key)}><span className="district-dot"/><div><b>{item.name}</b><small>{item.count} {item.count===1?'заявка':'заявок'}</small></div><em>{item.count}</em>{value===key?<Check/>:null}</button>})}</>:null}</div>:null}</div>;
}

function MapHierarchyPanel({onClose,mode,onModeChange,routeCount,activeRoute,orders,plan,playback=false}){
  const urgentCount=orders.filter(order=>order.priority==='Авария'||workPointType(order)==='emergency').length;
  const reviewCount=orders.filter(order=>order.geocodeStatus==='review').length;
  const unassignedCount=plan?.unassigned?.length||0;
  const color=activeRoute?MAP_UI.routeSelected:MAP_UI.routeNeutral;
  const colorsAvailable=routeCount<=8;
  return <aside id="map-legend-popover" className="map-legend-popover" role="dialog" aria-label="Легенда карты" onClick={event=>event.stopPropagation()}>
    <div className="map-legend-popup-head"><div><small>ОБОЗНАЧЕНИЯ НА КАРТЕ</small><h3>Легенда</h3></div><button type="button" onClick={onClose} aria-label="Закрыть легенду"><X size={18}/></button></div>
    <div className="map-legend-popup-body">
      {!playback?<div className="map-mode-switch" role="group" aria-label="Режим отображения маршрутов"><button type="button" className={mode==='focus'?'selected':''} aria-label="Фокус маршрутов" title="Фокус маршрутов" onClick={()=>onModeChange('focus')}><LocateFixed/><span>Фокус</span></button><button type="button" className={mode==='brigades'?'selected':''} aria-label="Цвета бригад" disabled={!colorsAvailable} title={colorsAvailable?'Цвет закреплён за бригадой':'Доступно, когда на карте не более 8 маршрутов'} onClick={()=>onModeChange('brigades')}><Route/><span>Бригады</span></button></div>:null}
      <div className="map-legend-popup-items">
        <div><i className="legend-route" style={{'--legend-color':color}}/><span><b>Маршрут</b><small>{activeRoute?`Выделен маршрут: ${activeRoute.engineerName}`:'Серая линия — общий план; выделенная — выбранная бригада'}</small></span></div>
        {playback?<div><i className="legend-crew"/><span><b>Бригада</b><small>Положение в ходе смены</small></span></div>:null}
        <div><i className="legend-point"/><span><b>Назначенная заявка</b><small>Светлая точка с контуром входит в маршрут</small></span></div>
        {playback?<div><i className="legend-completed"/><span><b>Выполнена</b><small>Зелёная точка — есть фактическая отметка диспетчера</small></span></div>:null}
        {urgentCount?<div><i className="legend-urgent">⚡</i><span><b>Срочная заявка · {urgentCount}</b><small>Красный ромб — аварийный приоритет</small></span></div>:null}
        {unassignedCount?<div><i className="legend-unassigned">!</i><span><b>В очереди · {unassignedCount}</b><small>Пунктирный круг — не вошла в план</small></span></div>:null}
        {reviewCount?<div><i className="legend-review">?</i><span><b>Проверить адрес · {reviewCount}</b><small>Координаты требуют уточнения</small></span></div>:null}
        <div><i className="legend-start"><House/></i><span><b>Старт бригады</b><small>Общая исходная точка маршрута</small></span></div>
      </div>
    </div>
  </aside>;
}

function MapCanvas({orders,team=[],scheduled,onOrder,onRoute,onOpenPlanning,onOrderHover,onRouteHover,hoveredOrderId,hoveredRouteId,uiTheme,region,geocodeProgress,onClearGeocodeProgress,selectedOrder,selectedTerritory,routes=EMPTY_ROUTES,plan=null,activeRoute=null,engineerPopup=null,crewPlayback=null,shiftMapTab='',onCrewSelect,onOpenEngineerDetails}){
  const storedMapTheme=()=>{try{return localStorage.getItem('beego-map-theme')||''}catch{return''}};
  const[popupsEnabled,setPopupsEnabled]=useState(true),[map,setMap]=useState(null),[mapTheme,setMapTheme]=useState(()=>storedMapTheme()||(uiTheme==='dark'?'night':'day')),[themePickerOpen,setThemePickerOpen]=useState(false),[legendOpen,setLegendOpen]=useState(false),[is3D,setIs3D]=useState(false),[locating,setLocating]=useState(false),[locationVisible,setLocationVisible]=useState(false),[locationMessage,setLocationMessage]=useState(''),[locationPrompt,setLocationPrompt]=useState(null),[routeDisplayMode,setRouteDisplayMode]=useState('focus'),[mapHoveredRouteId,setMapHoveredRouteId]=useState(null);
  const lightMapThemeRef=useRef((()=>{try{return localStorage.getItem('beego-light-map-theme')||((storedMapTheme()||'day')==='night'?'day':storedMapTheme())||'day'}catch{return 'day'}})());
  const containerRef=useRef(null),markersRef=useRef([]),startMarkersRef=useRef([]),crewMarkersRef=useRef(new globalThis.Map()),crewPopupRef=useRef(null),activePopupRef=useRef(null),hoverInfoTimerRef=useRef(null),hoverInfoPopupRef=useRef(null),selectedPopupRequestRef=useRef(0),locationMarkerRef=useRef(null),locationCameraRef=useRef(null),themePickerRef=useRef(null),districtRequestRef=useRef(null),lastLocationPromptRef=useRef('request'),previousScheduledRef=useRef(scheduled),lastFittedRouteRef=useRef(''),routeDataRef=useRef(null),markerPresentationRef=useRef(()=>{}),selectedOrderRef=useRef(selectedOrder),activeRouteRef=useRef(activeRoute),activeOrderIdsRef=useRef(new Set()),onOrderRef=useRef(onOrder),onRouteRef=useRef(onRoute),onOpenPlanningRef=useRef(onOpenPlanning),onOrderHoverRef=useRef(onOrderHover),onRouteHoverRef=useRef(onRouteHover),onCrewSelectRef=useRef(onCrewSelect),onOpenEngineerDetailsRef=useRef(onOpenEngineerDetails),crewPlaybackRef=useRef(crewPlayback),lastCrewFocusRef=useRef(''),routesRef=useRef(routes);
  const clearShiftHoverInfo=useCallback(()=>{clearTimeout(hoverInfoTimerRef.current);hoverInfoTimerRef.current=null;hoverInfoPopupRef.current?.remove();hoverInfoPopupRef.current=null},[]);
  const scheduleShiftHoverInfo=useCallback((coords,buildCard,{delay=1800,shiftOnly=true}={})=>{
    clearShiftHoverInfo();
    if((shiftOnly&&!crewPlaybackRef.current)||!Array.isArray(coords)||coords.length!==2||!map)return;
    hoverInfoTimerRef.current=setTimeout(()=>{
      if(shiftOnly&&!crewPlaybackRef.current)return;
      const popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,focusAfterOpen:false,anchor:'bottom',offset:18,maxWidth:'280px',className:'shift-hover-info'}).setDOMContent(buildCard());
      popup.setLngLat([coords[1],coords[0]]).addTo(map);
      hoverInfoPopupRef.current=popup;
      hoverInfoTimerRef.current=null;
    },delay);
  },[map,clearShiftHoverInfo]);
  const hoverCard=useCallback((title,rows)=>{const card=document.createElement('div');card.className='shift-hover-card';const heading=document.createElement('strong');heading.textContent=title;card.append(heading);rows.forEach(([label,value])=>{if(!value)return;const row=document.createElement('div'),key=document.createElement('span'),valueNode=document.createElement('b');key.textContent=label;valueNode.textContent=value;row.append(key,valueNode);card.append(row)});return card},[]);
  const[hiddenCrewPopupId,setHiddenCrewPopupId]=useState('');
  useEffect(()=>{setHiddenCrewPopupId('')},[crewPlayback?.selectedEngineerId]);
  const restorePopupOrderIdRef=useRef('');
  onOrderRef.current=onOrder;
  onRouteRef.current=onRoute;
  onOpenPlanningRef.current=onOpenPlanning;
  onOrderHoverRef.current=onOrderHover;
  onRouteHoverRef.current=onRouteHover;
  onCrewSelectRef.current=onCrewSelect;
  onOpenEngineerDetailsRef.current=onOpenEngineerDetails;
  crewPlaybackRef.current=crewPlayback;
  routesRef.current=routes;
  useEffect(()=>{if(!crewPlayback)clearShiftHoverInfo()},[Boolean(crewPlayback),clearShiftHoverInfo]);
  const[districtBoundaryStatus,setDistrictBoundaryStatus]=useState('');
  const themePickerPresence=useDropdownPresence(themePickerOpen,200);
  const locationPromptPresence=useDropdownPresence(Boolean(locationPrompt),280);
  if(locationPrompt)lastLocationPromptRef.current=locationPrompt;
  const renderedLocationPrompt=locationPrompt||lastLocationPromptRef.current;
  const locationPromptMotionClass=locationPromptPresence.visible?'is-open':locationPrompt?'is-opening':'is-closing';
  const geocodedOrders=useMemo(()=>orders.filter(order=>Array.isArray(order.coords)&&order.coords.length===2&&order.coords.every(Number.isFinite)),[orders]);
  const mapOrders=geocodedOrders;
  const ungeocodedCount=orders.length-geocodedOrders.length;
  const positions=useMemo(()=>mapOrders.map(order=>order.coords),[mapOrders]);
  const signature=positions.map(([lat,lon])=>`${lat}:${lon}`).join('|');
  const activeOrderIds=useMemo(()=>new Set((activeRoute?.assignments||[]).map(item=>String(item.orderId))),[activeRoute]);
  const assignmentMeta=useMemo(()=>{const result=new globalThis.Map();routes.forEach(route=>route.assignments?.forEach((assignment,index)=>result.set(String(assignment.orderId),{route,assignment,position:assignment.position||index+1})));return result},[routes]);
  const visibleRouteCount=useMemo(()=>routes.filter(route=>route.assignments?.length).length,[routes]);
  const effectiveRouteMode=crewPlayback?'focus':routeModeForCount(routeDisplayMode,visibleRouteCount);
  const shiftMapEmphasis=crewPlayback?(shiftMapTab==='crews'?'crews':shiftMapTab==='orders'?'orders':'overview'):'';
  const effectiveHoveredRouteId=String(hoveredRouteId??mapHoveredRouteId??'');
  selectedOrderRef.current=selectedOrder;
  activeRouteRef.current=activeRoute;
  activeOrderIdsRef.current=activeOrderIds;

  const clearUserLocation=useCallback((restoreCamera=true)=>{
    const previousCamera=locationCameraRef.current;
    locationMarkerRef.current?.remove();
    locationMarkerRef.current=null;
    setLocationVisible(false);
    setLocating(false);
    setLocationMessage('');
    setLocationPrompt(null);
    const restoreOptions=restoredCameraOptions(previousCamera);
    if(restoreCamera&&map&&restoreOptions){
      map.stop();
      optimizedCameraMove(map,()=>map.easeTo(restoreOptions));
    }
    locationCameraRef.current=null;
  },[map]);

  useEffect(()=>{
    if(!locationVisible||!navigator.permissions?.query)return undefined;
    let active=true,permissionStatus=null;
    const forgetLocation=()=>{
      if(permissionStatus?.state==='granted')return;
      clearUserLocation(true);
    };
    const syncPermission=async()=>{
      try{
        const next=await navigator.permissions.query({name:'geolocation'});
        if(!active)return;
        if(permissionStatus&&permissionStatus!==next)permissionStatus.removeEventListener?.('change',forgetLocation);
        permissionStatus=next;
        permissionStatus.addEventListener?.('change',forgetLocation);
        permissionStatus.onchange=forgetLocation;
        forgetLocation();
      }catch{/* Permissions API is optional; geolocation still reports denial itself. */}
    };
    const checkWhenVisible=()=>{if(document.visibilityState==='visible')syncPermission()};
    syncPermission();
    const permissionAudit=setInterval(syncPermission,900);
    window.addEventListener('focus',syncPermission);
    document.addEventListener('visibilitychange',checkWhenVisible);
    return()=>{
      active=false;
      permissionStatus?.removeEventListener?.('change',forgetLocation);
      if(permissionStatus)permissionStatus.onchange=null;
      clearInterval(permissionAudit);
      window.removeEventListener('focus',syncPermission);
      document.removeEventListener('visibilitychange',checkWhenVisible);
    };
  },[locationVisible,clearUserLocation]);
  const routeStarts=useMemo(()=>{
    if(!scheduled)return[];
    const visibleRoutes=routes.filter(route=>route.assignments?.length&&(!crewPlayback?.selectedEngineerId||String(route.engineerId)===String(crewPlayback.selectedEngineerId)));
    const starts=visibleRoutes.map(route=>{const engineer=team.find(item=>String(item.id)===String(route.engineerId));return engineer&&Array.isArray(engineer.startCoords)&&engineer.startCoords.length===2?{route,engineer,coords:engineer.startCoords}:null}).filter(Boolean);
    const grouped=new globalThis.Map();
    starts.forEach(item=>{const key=item.coords.join(':');const current=grouped.get(key)||{...item,names:[],entries:[]};current.names.push(item.engineer.name);current.entries.push(item);grouped.set(key,current)});
    return[...grouped.values()];
  },[scheduled,routes,team,crewPlayback?.selectedEngineerId]);
  const routeGeoJson=useMemo(()=>{
    const visibleRoutes=routes.filter(route=>route.assignments?.length&&(!crewPlayback?.selectedEngineerId||String(route.engineerId)===String(crewPlayback.selectedEngineerId)));
    return{type:'FeatureCollection',features:visibleRoutes.flatMap((route,routeIndex)=>{
      const engineerId=String(route.engineerId);
      const routeColor=stableRouteColor(engineerId);
      const routeGeometry=(route.geometry||[]).filter(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite));
      if(routeGeometry.length>=2)return[{type:'Feature',id:`${engineerId}-route`,properties:{engineerId,routeColor,routeIndex,roadGeometry:true},geometry:{type:'LineString',coordinates:routeGeometry.map(([lat,lon])=>[lon,lat])}}];
      return route.assignments.flatMap((assignment,legIndex)=>{
        const geometry=(assignment.geometry||[]).filter(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite));
        if(geometry.length<2)return[];
        return[{type:'Feature',id:`${engineerId}-leg-${legIndex}`,properties:{engineerId,routeColor,routeIndex,legIndex,roadGeometry:true},geometry:{type:'LineString',coordinates:geometry.map(([lat,lon])=>[lon,lat])}}];
      });
    })};
  },[routes,crewPlayback?.selectedEngineerId]);

  useEffect(()=>{
    const nextTheme=uiTheme==='dark'?'night':lightMapThemeRef.current;
    if(uiTheme==='dark'&&mapTheme!=='night')lightMapThemeRef.current=mapTheme;
    setMapTheme(nextTheme);
    try{localStorage.setItem('beego-map-theme',nextTheme);if(uiTheme==='dark')localStorage.setItem('beego-light-map-theme',lightMapThemeRef.current)}catch{}
  },[uiTheme]);
  const chooseMapTheme=next=>{setMapTheme(next);if(uiTheme!=='dark')lightMapThemeRef.current=next;try{localStorage.setItem('beego-map-theme',next);if(uiTheme!=='dark')localStorage.setItem('beego-light-map-theme',next)}catch{}};
  useEffect(()=>{if(!map||positions.length||!region?.coords)return;const[lat,lon]=region.coords;map.stop();optimizedCameraMove(map,()=>map.flyTo({center:[lon,lat],zoom:10.8,duration:720,speed:1.55,curve:1.1,essential:true}))},[map,region?.id,positions.length]);
  useEffect(()=>{if(!themePickerOpen)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='pointerdown'&&!themePickerRef.current?.contains(event.target)&&!event.target.closest?.('.map-layers-control')))setThemePickerOpen(false)};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close)}},[themePickerOpen]);

  useEffect(()=>{
    if(!containerRef.current)return undefined;
    const host=containerRef.current;
    host.dataset.mapTheme=mapTheme;
    const instance=new maplibregl.Map({
      container:host,
      style:'https://tiles.openfreemap.org/styles/bright',
        center:[region?.coords?.[1]??DEFAULT_MAP_CENTER[1],region?.coords?.[0]??DEFAULT_MAP_CENTER[0]],
      zoom:DEFAULT_MAP_ZOOM,
      minZoom:MAP_MIN_ZOOM,
      maxZoom:MAP_MAX_ZOOM,
      renderWorldCopies:true,
      attributionControl:false,
      fadeDuration:0,
      maxTileCacheZoomLevels:6,
      refreshExpiredTiles:false,
      cancelPendingTileRequestsWhileZooming:false,
      dragRotate:true,
      pitchWithRotate:true,
      aroundCenter:false,
      rotateSpeed:.34,
      pitchSpeed:-.24,
    });
    instance.addControl(new maplibregl.AttributionControl({
      compact:true,
      customAttribution:'<a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geocoding by Geoapify</a>',
    }),'bottom-left');
    requestAnimationFrame(()=>{
      const attribution=host.querySelector('.maplibregl-ctrl-attrib');
      const attributionButton=host.querySelector('.maplibregl-ctrl-attrib-button');
      attribution?.classList.remove('maplibregl-compact-show');
      attributionButton?.setAttribute('aria-expanded','false');
    });
    instance.touchZoomRotate.disableRotation();
    instance.scrollZoom.setWheelZoomRate(1/520);
    instance.scrollZoom.setZoomRate(1/110);
    instance.on('style.load',()=>{prepareMapStyle(instance);ensure3DBuildingLayer(instance);applyMapTheme(instance,host.dataset.mapTheme||'day')});
    instance.on('load',()=>{host.dataset.mapLoaded='true'});
    instance.on('movestart',()=>{host.dataset.mapReady='false';host.dataset.moveStartedAt=String(performance.now())});
    instance.on('idle',()=>{host.dataset.mapReady='true';host.dataset.renderedFeatures=String(instance.queryRenderedFeatures().length);if(host.dataset.moveStartedAt)host.dataset.lastRenderMs=String(Math.round(performance.now()-Number(host.dataset.moveStartedAt)))});
    instance.on('error',event=>console.error('Ошибка загрузки карты:',event.error?.message||event));
    let resizeTimer,resizeFrame,lastResize=0;
    const resizeMap=()=>{lastResize=performance.now();instance.resize();instance.triggerRepaint()};
    const observer=new ResizeObserver(()=>{
      clearTimeout(resizeTimer);
      cancelAnimationFrame(resizeFrame);
      const remaining=Math.max(0,64-(performance.now()-lastResize));
      resizeTimer=setTimeout(()=>{resizeFrame=requestAnimationFrame(resizeMap)},remaining);
    });
    observer.observe(host);
    setMap(instance);
    return()=>{
      observer.disconnect();
      clearTimeout(resizeTimer);
      cancelAnimationFrame(resizeFrame);
      activePopupRef.current?.remove();
      activePopupRef.current=null;
      markersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      markersRef.current=[];
      startMarkersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      startMarkersRef.current=[];
      locationMarkerRef.current?.remove();
      setMap(null);
      instance.remove();
    };
  },[]);

  useEffect(()=>{
    if(!map)return undefined;
    const markerScale=()=>{const zoom=map.getZoom();return zoom<9.5?.82:zoom<11?.92:zoom<12.5?1.02:zoom<14?1.12:zoom<15.5?1.22:1.32};
    const closeActivePopup=()=>{activePopupRef.current?.remove();activePopupRef.current=null};
    const showRoute=route=>{
      if(!route)return;
      const inShift=Boolean(crewPlaybackRef.current);
      if(inShift){shiftClock.set({selectedEngineerId:String(route.engineerId),follow:false});onOrderRef.current?.(null)}
      else{onRouteRef.current?.(route);return}
      const valid=point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite);
      const roadPoints=(route.geometry||[]).filter(valid);
      const points=(roadPoints.length>=2?roadPoints:(route.assignments||[]).flatMap(assignment=>(assignment.geometry||[]).filter(valid))).map(([lat,lon])=>[lon,lat]);
      const engineer=team.find(item=>String(item.id)===String(route.engineerId));
      if(valid(engineer?.startCoords))points.push([engineer.startCoords[1],engineer.startCoords[0]]);
      const assignedIds=new Set((route.assignments||[]).map(item=>String(item.orderId)));
      orders.forEach(order=>{if(assignedIds.has(String(order.id))&&valid(order.coords))points.push([order.coords[1],order.coords[0]])});
      if(!points.length)return;
      const mapRect=map.getContainer().getBoundingClientRect();
      const panelRect=document.querySelector('.shift-layer:not(.report-layer) .shift-panel')?.getBoundingClientRect();
      const timelineRect=document.querySelector('.shift-layer:not(.report-layer) .shift-timeline')?.getBoundingClientRect();
      const padding={top:Math.min(90,mapRect.height*.15),bottom:Math.min(mapRect.height*.35,Math.max(90,timelineRect?mapRect.bottom-timelineRect.top+35:90)),left:Math.min(mapRect.width*.55,Math.max(85,panelRect?panelRect.right-mapRect.left+55:85)),right:Math.min(85,mapRect.width*.12)};
      map.stop();
      if(points.length===1){optimizedCameraMove(map,()=>map.easeTo({center:points[0],zoom:12.5,offset:[(padding.left-padding.right)/2,(padding.top-padding.bottom)/2],duration:850,essential:true}));return}
      const bounds=points.reduce((result,point)=>result.extend(point),new maplibregl.LngLatBounds(points[0],points[0]));
      optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding,maxZoom:12.6,duration:850,essential:true}));
    };
    const updateMarkerPresentation=()=>{
      const focusedRoute=activeRouteRef.current,currentActiveIds=activeOrderIdsRef.current,zoom=map.getZoom(),showNumbers=shouldShowRouteNumbers(zoom,Boolean(focusedRoute));
      markersRef.current.forEach(item=>{
        const selected=String(selectedOrderRef.current?.id??'')===item.orderId,isActive=currentActiveIds.has(item.orderId);
        item.isActive=isActive;
        item.element.style.display='';
        item.element.style.setProperty('--marker-scale',String(markerScale()));
        item.element.style.setProperty('--engineer-route-color',focusedRoute&&isActive?MAP_UI.routeSelected:item.routeColor);
        item.element.classList.toggle('is-selected',selected);
        item.element.classList.toggle('is-route-overview',scheduled&&Boolean(plan)&&!focusedRoute&&!item.isUnassigned);
        item.element.classList.toggle('is-route-active',Boolean(focusedRoute)&&isActive);
        item.element.classList.toggle('is-route-muted',Boolean(focusedRoute)&&!isActive&&!item.isUnassigned);
        item.element.classList.toggle('is-sequence-visible',showNumbers&&isActive);
        item.element.classList.toggle('is-list-hovered',String(hoveredOrderId??'')===item.orderId);
        item.pin.textContent=item.isUnassigned?'!':item.isInvalid?'!':item.manualReview?'?':showNumbers&&isActive?String(item.position||''):item.isUrgent?'⚡':'';
      });
    };
    markerPresentationRef.current=updateMarkerPresentation;
    const sync=()=>{
      const selectedId=String(selectedOrderRef.current?.id??'');
      const restoreSelectedPopup=Boolean(selectedId&&(activePopupRef.current?.isOpen()||restorePopupOrderIdRef.current===selectedId));
      restorePopupOrderIdRef.current='';
      closeActivePopup();
      markersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      const coordinateKey=order=>order.coords.map(value=>Number(value).toFixed(5)).join(':');
      const coordinateGroups=new globalThis.Map();
      mapOrders.forEach(order=>{const key=coordinateKey(order),group=coordinateGroups.get(key)||[];group.push(order);coordinateGroups.set(key,group)});
      markersRef.current=mapOrders.map((order,i)=>{
        const element=document.createElement('button');
        element.type='button';
        const pointType=workPointType(order);
        const isActive=activeOrderIdsRef.current.has(String(order.id));
        const meta=assignmentMeta.get(String(order.id)),isUnassigned=Boolean(plan)&&!meta;
        const isRouteOverview=scheduled&&Boolean(plan)&&!activeRoute&&!isUnassigned;
        const isUrgent=order.priority==='Авария'||pointType==='emergency',manualReview=order.geocodeStatus==='review',isInvalid=order.geocodeStatus==='invalid'||Boolean(order.validationErrors?.length),isEngineerPoint=Boolean(order.suppressPopup);
        const groupKey=coordinateKey(order),coordinateGroup=coordinateGroups.get(groupKey)||[order];
        element.className=`map-order-marker point-type-${pointType}${isUnassigned?' is-unassigned':''}${isUrgent?' is-urgent':''}${manualReview?' is-manual-review':''}${isInvalid?' is-invalid':''}${isEngineerPoint?' is-engineer-point':''}${isRouteOverview?' is-route-overview':''}${activeRoute?(isActive?' is-route-active':isUnassigned?'':' is-route-muted'):''}`;
        const routeColor=meta?stableRouteColor(meta.route.engineerId):MAP_UI.routeNeutral;
        element.style.setProperty('--engineer-route-color',activeRouteRef.current&&isActive?MAP_UI.routeSelected:routeColor);
        const requestWord=countForm(coordinateGroup.length,'заявка','заявки','заявок');
        const baseLabel=`${isUnassigned?'Не вошла в план: ':scheduled?`Остановка ${meta?.position||i+1}: `:''}${displayOrderName(order)}${coordinateGroup.length>1?`. В этой точке ${coordinateGroup.length} ${requestWord}`:''}`;
        element.setAttribute('aria-label',baseLabel);
        const pin=document.createElement('span');
        pin.className=`map-order-pin ${scheduled||isUnassigned?'is-scheduled':''}`;
        pin.textContent=isUnassigned||isInvalid?'!':manualReview?'?':isUrgent?'⚡':'';
        element.append(pin);
        element.addEventListener('mouseenter',()=>{
          onOrderHoverRef.current?.(order);
          if(String(selectedOrderRef.current?.id??'')===String(order.id))return;
          scheduleShiftHoverInfo(order.coords,()=>hoverCard(displayOrderName(order),[
            ['Адрес',order.address||'Адрес не указан'],
            ['Состояние',visitStatusLabel(element.dataset.visitStatus||'planned',crewPlaybackRef.current?.mode)],
            ['Окно',order.start&&order.end?`${order.start}–${order.end}`:'Гибкое'],
          ]));
        });
        element.addEventListener('mouseleave',()=>{onOrderHoverRef.current?.(null);clearShiftHoverInfo()});
        element.addEventListener('click',event=>{
          event.preventDefault();
          event.stopPropagation();
          clearShiftHoverInfo();
          const closingSelected=(isUnassigned||Boolean(crewPlaybackRef.current))&&String(selectedOrderRef.current?.id??'')===String(order.id);
          startMarkersRef.current.forEach(item=>item.popup?.remove());
          markersRef.current.forEach(item=>item.popup?.remove());
          closeActivePopup();
          onOrderRef.current?.(closingSelected?null:order);
          if(!closingSelected&&!isUnassigned&&popupsEnabled&&!order.suppressPopup&&popup){popup.setLngLat([order.coords[1],order.coords[0]]).addTo(map);activePopupRef.current=popup}
        });
        let popup=null,statusBadge=null;
        if(popupsEnabled&&!order.suppressPopup){
          const issue=plan?.unassigned?.find(item=>String(item.orderId)===String(order.id));
          const content=document.createElement('div');
          content.className='map-popup-content map-popup-detail';
          const header=document.createElement('div');
          header.className='map-popup-heading';
          const heading=document.createElement('strong');
          heading.textContent=String(order.sourceId||order.id||'Заявка');
          const state=document.createElement('span');
          state.className=`map-popup-state ${issue?'needs-attention':meta?'assigned':'awaiting-plan'}`;
          state.textContent=issue?'Не поместилась':meta?'Назначена':'К планированию';
          statusBadge=state;
          header.append(heading,state);
          const title=document.createElement('p');
          title.className='map-popup-title';
          title.textContent=displayOrderName(order);
          content.append(header,title);
          const addRow=(label,value)=>{const row=document.createElement('div'),name=document.createElement('span'),leader=document.createElement('i'),text=document.createElement('b');row.className='map-popup-row';name.textContent=label;text.textContent=value;row.append(name,leader,text);content.append(row);return{row,text}};
          addRow(issue?'Адрес':'Местоположение',order.address||'Не указано');
          addRow('Окно клиента',order.start&&order.end?`${order.start}–${order.end}`:'Гибкое');
          if(order.workType||order.skill||isInformationalOrder(order))addRow('Вид работ',isInformationalOrder(order)?'Информационная заявка':order.workType||order.skill);
          if(!issue)addRow('Норматив работ',durationLabel(order.duration));
          if(!issue)addRow('Оборудование',order.equipment||'Не требуется');
          if(order.priority&&order.priority!=='Обычная')addRow('Приоритет',filterLabel(order.priority));
          if(meta?.assignment?.arrival)addRow('Прибытие',meta.assignment.arrival);
          if(meta?.assignment?.plannedStart)addRow('Начало работ',meta.assignment.plannedStart);
          if(meta?.route?.engineerName)addRow('Бригада',meta.route.engineerName);
          if(coordinateGroup.length>1)addRow('В этой точке',`${coordinateGroup.length} ${requestWord} по одному адресу`);
          if(meta?.route){const routeAction=document.createElement('button'),icon=document.createElementNS('http://www.w3.org/2000/svg','svg'),iconPath=document.createElementNS('http://www.w3.org/2000/svg','path'),label=document.createElement('span');routeAction.type='button';routeAction.className='map-popup-route-action';icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','2');icon.setAttribute('stroke-linecap','round');icon.setAttribute('stroke-linejoin','round');icon.setAttribute('aria-hidden','true');iconPath.setAttribute('d','M15 3h6v6m0-6-10 10m9 0v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6');icon.append(iconPath);label.textContent='Показать маршрут бригады';routeAction.append(icon,label);routeAction.addEventListener('click',event=>{event.stopPropagation();popup?.remove();showRoute(meta.route)});content.append(routeAction)}
          if(issue){
            const copy=unassignedExplanation(issue,order,team),note=document.createElement('div'),noteTitle=document.createElement('b'),noteText=document.createElement('p');
            note.className='map-popup-issue';noteTitle.textContent=copy.title;noteText.textContent=copy.summary;note.append(noteTitle,noteText);content.append(note);
            const diagnostics=diagnoseOrderCandidates(order,team,orders,plan).sort((left,right)=>({estimated:0,busy:1,window:2,coordinates:3,unavailable:4,skill:5,zone:6}[left.state]??7)-({estimated:0,busy:1,window:2,coordinates:3,unavailable:4,skill:5,zone:6}[right.state]??7));
            if(diagnostics.length){
              const list=document.createElement('section');list.className='map-popup-candidates';
              const heading=document.createElement('div');heading.className='map-popup-candidates-heading';const headingTitle=document.createElement('strong');headingTitle.textContent=`Проверка бригад · ${diagnostics.length}`;const headingHint=document.createElement('span');headingHint.textContent='Нажмите на бригаду для подробностей';heading.append(headingTitle,headingHint);list.append(heading);
              const createCandidate=item=>{const card=document.createElement('details'),summary=document.createElement('summary'),name=document.createElement('b'),result=document.createElement('span'),overview=document.createElement('div'),checks=document.createElement('div');card.className=`map-popup-candidate ${item.state}`;name.textContent=item.name;result.textContent=item.label;summary.append(name,result);overview.className='map-popup-candidate-overview';(item.checks||[]).slice(0,5).forEach(check=>{const flag=document.createElement('span');flag.className=check.ok?'pass':'fail';flag.textContent=`${check.ok?'✓':'×'} ${check.label}`;overview.append(flag)});checks.className='map-popup-candidate-checks';(item.checks||[]).forEach(check=>{const chip=document.createElement('span');chip.className=check.ok?'pass':'fail';chip.textContent=`${check.label}: ${check.detail}`;checks.append(chip)});card.append(summary,overview,checks);card.addEventListener('toggle',()=>{if(!card.open||!list.classList.contains('is-scrolling'))return;requestAnimationFrame(()=>{const viewport=list.getBoundingClientRect(),expanded=card.getBoundingClientRect();if(expanded.height<=viewport.height-46&&expanded.bottom>viewport.bottom-8)list.scrollTop+=expanded.bottom-viewport.bottom+8})});return card};
              diagnostics.slice(0,2).forEach(item=>list.append(createCandidate(item)));
              if(diagnostics.length>2){
                const more=document.createElement('details'),moreSummary=document.createElement('summary');
                more.className='map-popup-candidates-more';
                moreSummary.textContent=`Остальные бригады · ${diagnostics.length-2}`;
                moreSummary.addEventListener('click',()=>{
                  if(!more.open){
                    // Use the space above the marker without pushing the popup off-screen.
                    const popupTop=popup?.getElement()?.getBoundingClientRect().top??0;
                    const visualScale=list.getBoundingClientRect().height/(list.offsetHeight||1);
                    const availableGrowth=Math.max(0,(popupTop-18)/(visualScale||1));
                    list.style.height=`${Math.min(520,list.offsetHeight+availableGrowth)}px`;
                    list.classList.add('is-scrolling');
                  }
                });
                more.addEventListener('toggle',()=>{
                  if(more.open){
                    list.style.height=`${Math.min(parseFloat(list.style.height)||list.offsetHeight,list.scrollHeight)}px`;
                    list.scrollTop=more.offsetTop-list.offsetTop;
                  }else{
                    list.classList.remove('is-scrolling');
                    list.style.height='';
                    list.scrollTop=0;
                  }
                });
                more.append(moreSummary);
                diagnostics.slice(2).forEach(item=>more.append(createCandidate(item)));
                list.append(more);
              }
              content.append(list);
            }
            const actions=document.createElement('div'),recalculate=document.createElement('button');actions.className='map-popup-decision-actions';recalculate.type='button';recalculate.textContent='Пересчитать план · В разработке';recalculate.addEventListener('click',event=>{event.stopPropagation();popup?.remove();onOpenPlanningRef.current?.()});actions.append(recalculate);content.append(actions);
          }
          popup=new maplibregl.Popup({closeButton:true,closeOnClick:false,focusAfterOpen:false,offset:28,maxWidth:'440px',className:'order-popup order-detail-popup',...(issue?{anchor:'bottom'}:{})}).setDOMContent(content);
          popup.on('close',()=>{if(activePopupRef.current===popup)activePopupRef.current=null});
        }
        const duplicateIndex=coordinateGroup.indexOf(order),duplicateAngle=coordinateGroup.length>1?-Math.PI/2+(Math.PI*2*duplicateIndex/coordinateGroup.length):0,duplicateOffset=coordinateGroup.length>1?[Math.round(Math.cos(duplicateAngle)*14),Math.round(Math.sin(duplicateAngle)*14)]:[0,0];
        const marker=new maplibregl.Marker({element,anchor:'center',offset:duplicateOffset}).setLngLat([order.coords[1],order.coords[0]]).addTo(map);
        return{marker,popup,statusBadge,element,pin,order,orderId:String(order.id),coords:order.coords,baseLabel,isActive,isUnassigned,isUrgent,manualReview,isInvalid,isEngineerPoint,position:meta?.position,routeColor};
      });
      startMarkersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      startMarkersRef.current=routeStarts.map(item=>{
        const entries=item.entries||[{route:item.route,engineer:item.engineer}],brigadeCount=entries.length;
        const brigadeWord=countForm(brigadeCount,'бригада','бригады','бригад');
        const element=document.createElement('button');element.type='button';element.className='route-start-marker';element.setAttribute('aria-label',`Открыть стартовую точку: ${brigadeCount} ${brigadeWord}`);element.innerHTML=`<span class="route-start-orb" aria-hidden="true"><img src="${depotMarkerPurple}" alt="" draggable="false"></span>`;
        const content=document.createElement('div');content.className='map-popup-detail start-popup-detail';
        const header=document.createElement('div'),heading=document.createElement('strong'),state=document.createElement('span');header.className='map-popup-heading';heading.textContent='Стартовая точка';state.className='map-popup-state start';state.textContent=`${brigadeCount} ${brigadeWord}`;header.append(heading,state);
        const subtitle=document.createElement('p');subtitle.className='map-popup-title';subtitle.textContent='База выездных бригад';content.append(header,subtitle);
        const addStartRow=(label,value)=>{const row=document.createElement('div'),name=document.createElement('span'),leader=document.createElement('i'),text=document.createElement('b');row.className='map-popup-row';name.textContent=label;text.textContent=value;row.append(name,leader,text);content.append(row)};
        const shifts=entries.map(({route})=>[route.shiftStart,route.shiftEnd]).filter(([start,end])=>start&&end),shiftStart=shifts.map(([start])=>start).sort()[0]||'—',shiftEnd=shifts.map(([,end])=>end).sort().at(-1)||'—';
        addStartRow('Адрес',item.engineer.startAddress||'Адрес не указан');
        addStartRow('Рабочее время',shiftStart==='—'?'Не указано':`${shiftStart}–${shiftEnd}`);
        if(brigadeCount>1)addStartRow('Состав',`${brigadeCount} ${brigadeWord} с общей базой`);
        const routeList=document.createElement('div');routeList.className='start-popup-routes';
        entries.forEach(({route,engineer})=>{const button=document.createElement('button'),avatar=document.createElement('span'),copy=document.createElement('span'),name=document.createElement('b'),metaText=document.createElement('small'),stopCount=route.assignments.length;button.type='button';button.setAttribute('aria-label',`Показать маршрут бригады ${engineer.name} на карте`);avatar.textContent=engineer.name.split(' ').map(part=>part[0]).join('').slice(0,2);name.textContent=engineer.name;metaText.textContent=`${stopCount} ${countForm(stopCount,'остановка','остановки','остановок')} · ${route.shiftStart}–${route.shiftEnd}`;copy.append(name,metaText);button.append(avatar,copy);button.addEventListener('click',event=>{event.stopPropagation();popup.remove();showRoute(route)});routeList.append(button)});
        if(entries.length)content.append(routeList);
        const popup=new maplibregl.Popup({closeButton:true,closeOnClick:false,anchor:'right',offset:31,maxWidth:'380px',className:'order-popup start-detail-popup'}).setDOMContent(content);
        popup.on('close',()=>{if(activePopupRef.current===popup)activePopupRef.current=null});
        element.addEventListener('mouseenter',()=>scheduleShiftHoverInfo(item.coords,()=>hoverCard('Стартовая точка',[
          ['Адрес',item.engineer.startAddress||'Адрес не указан'],
          ['Бригады',entries.map(({engineer})=>engineer.name).join(', ')],
          ['Рабочее время',shiftStart==='—'?'Не указано':`${shiftStart}–${shiftEnd}`],
        ]),{delay:700,shiftOnly:false}));
        element.addEventListener('mouseleave',clearShiftHoverInfo);
        element.addEventListener('click',()=>{clearShiftHoverInfo();closeActivePopup();markersRef.current.forEach(marker=>marker.popup?.remove());startMarkersRef.current.forEach(marker=>marker.popup?.remove());const mapRect=map.getContainer().getBoundingClientRect(),panelRect=document.querySelector('.route-list-panel')?.getBoundingClientRect(),desktopPanelOffset=window.matchMedia('(min-width:761px)').matches&&panelRect?Math.max(0,Math.min(mapRect.width,panelRect.right-mapRect.left))/2:0;optimizedCameraMove(map,()=>map.easeTo({center:[item.coords[1],item.coords[0]],offset:[desktopPanelOffset,0],duration:520,easing:t=>1-(1-t)**3,essential:true}));popup.setLngLat([item.coords[1],item.coords[0]]).addTo(map);activePopupRef.current=popup});
        const marker=new maplibregl.Marker({element,anchor:'center'}).setLngLat([item.coords[1],item.coords[0]]).addTo(map);return{marker,popup,element};
      });
      updateMarkerPresentation();
      if(restoreSelectedPopup){const selectedMarker=markersRef.current.find(item=>item.orderId===selectedId);if(selectedMarker?.popup){selectedMarker.popup.setLngLat([selectedMarker.order.coords[1],selectedMarker.order.coords[0]]).addTo(map);activePopupRef.current=selectedMarker.popup}}
    };
    map.on('zoomend',updateMarkerPresentation);
    // DOM markers do not depend on the vector style being fully loaded. Waiting
    // for style.load here could permanently remove them during an ordinary pan.
    sync();
    return()=>{
      map.off('zoomend',updateMarkerPresentation);
      markerPresentationRef.current=()=>{};
      if(activePopupRef.current?.isOpen()&&selectedOrderRef.current)restorePopupOrderIdRef.current=String(selectedOrderRef.current.id);
      closeActivePopup();
      markersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      markersRef.current=[];
      startMarkersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      startMarkersRef.current=[];
      clearShiftHoverInfo();
    };
  },[map,mapOrders,scheduled,popupsEnabled,assignmentMeta,routeStarts,plan,clearShiftHoverInfo,scheduleShiftHoverInfo,hoverCard]);

  useEffect(()=>{markerPresentationRef.current?.()},[activeRoute,selectedOrder]);

  useEffect(()=>{
    if(!map)return;
    const live=new Set();
    (crewPlayback?.crews||[]).filter(crew=>!crewPlayback?.selectedEngineerId||String(crew.engineerId)===String(crewPlayback.selectedEngineerId)).forEach(crew=>{
      if(!crew.positionKnown||!Array.isArray(crew.coords)||crew.coords.length!==2)return;
      const id=String(crew.engineerId);live.add(id);
      let marker=crewMarkersRef.current.get(id);
      if(!marker){const element=document.createElement('div'),point=document.createElement('button');element.className='shift-map-crew-marker';point.type='button';point.className='shift-map-crew';const crewName=team.find(item=>String(item.id)===id)?.name||id;point.textContent=crewName.split(/\s+/).map(part=>part[0]).join('').slice(0,2).toLocaleUpperCase('ru-RU');point.setAttribute('aria-label',`Показать бригаду ${crewName}`);
        point.addEventListener('mouseenter',()=>{
          const current=crewPlaybackRef.current?.crews?.find(item=>String(item.engineerId)===id);
          if(!current?.positionKnown)return;
          scheduleShiftHoverInfo(current.coords,()=>{
            const latest=crewPlaybackRef.current?.crews?.find(item=>String(item.engineerId)===id);
            const route=routesRef.current.find(item=>String(item.engineerId)===id);
            const status=latest?.status==='travelling'?'В пути':latest?.status==='working'?'На объекте':latest?.status==='waiting'?'Ожидание':latest?.status==='idle'?'Свободна':latest?.status==='completed'?'Выполнена':latest?.status==='started'?'Начата':'Нет текущей отметки';
            return hoverCard(crewName,[['Сейчас',status],['Маршрут',route?`${route.assignments?.length||0} заявок · ${Number(route.distanceKm||0).toFixed(1)} км`:'Нет маршрута']]);
          });
        });
        point.addEventListener('mouseleave',clearShiftHoverInfo);
        point.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();clearShiftHoverInfo();setHiddenCrewPopupId('');onCrewSelectRef.current?.(id)});element.append(point);marker=new maplibregl.Marker({element,anchor:'center'}).setLngLat([crew.coords[1],crew.coords[0]]).addTo(map);crewMarkersRef.current.set(id,marker)}
      marker.setLngLat([crew.coords[1],crew.coords[0]]);
      marker.getElement().firstElementChild.dataset.status=crew.status;
      marker.getElement().firstElementChild.classList.toggle('is-focused',String(crewPlayback.selectedEngineerId||'')===id);
    });
    crewMarkersRef.current.forEach((marker,id)=>{if(!live.has(id)){marker.remove();crewMarkersRef.current.delete(id)}});
    const visits=new globalThis.Map((crewPlayback?.orderStatuses||[]).map(item=>[String(item.orderId),item.status]));
    const completedFacts=new Set(crewPlayback?.completedFactOrderIds||[]);
    markersRef.current.forEach(item=>{
      const status=visits.get(item.orderId)||'';
      item.element.dataset.visitStatus=status;
      item.element.dataset.factCompleted=String(completedFacts.has(item.orderId));
      const badge=item.statusBadge;
      if(badge&&status){badge.textContent=visitStatusLabel(status,crewPlayback.mode);badge.dataset.visitStatus=status}
    });
    const selected=crewPlayback?.selectedEngineerId ? (crewPlayback.crews||[]).find(item=>String(item.engineerId)===String(crewPlayback.selectedEngineerId)) : null;
    const selectedCrewId=String(crewPlayback?.selectedEngineerId||'');
    const selectedEngineer=team.find(item=>String(item.id)===String(selected?.engineerId));
    const popupCoords=selected?.positionKnown&&Array.isArray(selected.coords)?selected.coords:selectedEngineer?.startCoords;
    if(!selected||selectedOrder||hiddenCrewPopupId===selectedCrewId||!Array.isArray(popupCoords)||popupCoords.length!==2){crewPopupRef.current?.remove();crewPopupRef.current=null}
    else {
      const route=routes.find(item=>String(item.engineerId)===String(selected.engineerId));
      const engineer=selectedEngineer;
      const summary=crewOperationalSummary({plan:{routes},orders,team},crewPlayback,selected.engineerId,crewPlayback.minute,crewPlayback.mode);
      const card=document.createElement('div');card.className='shift-map-crew-card';
      const heading=document.createElement('div');heading.className='shift-map-crew-heading';const title=document.createElement('strong');title.textContent=engineer?.name||route?.engineerName||'Бригада';const close=document.createElement('button');close.type='button';close.setAttribute('aria-label','Закрыть карточку бригады');close.textContent='×';close.addEventListener('click',event=>{event.stopPropagation();setHiddenCrewPopupId(selectedCrewId);crewPopupRef.current?.remove();crewPopupRef.current=null});heading.append(title,close);card.append(heading);
      const add=(label,value)=>{const row=document.createElement('div');const key=document.createElement('span');const data=document.createElement('b');key.textContent=label;data.textContent=value;row.append(key,data);card.append(row)};
      const status=selected.status==='travelling'?'В пути':selected.status==='working'?'На объекте':selected.status==='waiting'?'Ожидание':selected.status==='off_shift'?(crewPlayback.minute>=(minuteOf(route?.shiftEnd)??1440)?'Смена завершена':'Ещё не на смене'):selected.status==='unavailable'?'Недоступна':crewPlayback.mode==='fact'?'Положение по отметке':'Свободна';
      add('Сейчас',status);if(summary?.phaseMinutes!=null)add(selected.status==='travelling'?'В пути':'Работает',`${summary.phaseMinutes} мин`);
      add('Следующая',summary?.upcomingOrder?`${summary.upcomingOrder.sourceId||summary.upcomingOrder.id} · ${summary.upcoming?.plannedStart||'—'}`:'Нет');
      add('Маршрут',`${route?.assignments?.length||0} заявок · ${Number(route?.distanceKm||0).toFixed(1)} км`);
      const details=document.createElement('button');details.type='button';details.className='shift-map-crew-details-link';const detailsIcon=document.createElementNS('http://www.w3.org/2000/svg','svg');const detailsPath=document.createElementNS('http://www.w3.org/2000/svg','path');detailsIcon.setAttribute('viewBox','0 0 24 24');detailsIcon.setAttribute('fill','none');detailsIcon.setAttribute('stroke','currentColor');detailsIcon.setAttribute('stroke-width','2');detailsIcon.setAttribute('stroke-linecap','round');detailsIcon.setAttribute('stroke-linejoin','round');detailsIcon.setAttribute('aria-hidden','true');detailsPath.setAttribute('d','M15 3h6v6m0-6-10 10m9 0v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6');detailsIcon.append(detailsPath);details.append(detailsIcon,document.createTextNode('Подробнее об инженере'));details.addEventListener('click',event=>{event.stopPropagation();crewPopupRef.current?.remove();onOpenEngineerDetailsRef.current?.(selected.engineerId)});card.append(details);
      if(!crewPopupRef.current)crewPopupRef.current=new maplibregl.Popup({closeButton:false,closeOnClick:false,anchor:'left',offset:window.innerWidth<=1100?-20:22,maxWidth:'300px',className:'shift-crew-popup'});
      crewPopupRef.current.setDOMContent(card).setLngLat([popupCoords[1],popupCoords[0]]).addTo(map);
    }
    if(selected&&Array.isArray(popupCoords)&&!selectedOrder){const focusKey=`${selected.engineerId}:${crewPlayback.focusToken||0}`;const freshFocus=lastCrewFocusRef.current!==focusKey;lastCrewFocusRef.current=focusKey;const targetCoords=[popupCoords[1],popupCoords[0]],target=map.project(targetCoords),width=map.getContainer().clientWidth,height=map.getContainer().clientHeight;const outside=target.x<width*.68||target.x>width*.83||target.y<height*.15||target.y>height*.74;if(freshFocus||(crewPlayback.follow&&selected.positionKnown&&outside))map.easeTo({center:targetCoords,offset:[Math.min(260,width*.25),-Math.min(65,height*.08)],...(freshFocus?{zoom:Math.max(map.getZoom(),13.2)}:{}),duration:freshFocus?650:420,essential:true})}
  },[map,crewPlayback,team,routes,orders,selectedOrder,hiddenCrewPopupId,Boolean(engineerPopup),scheduleShiftHoverInfo,hoverCard,clearShiftHoverInfo]);
  useEffect(()=>()=>{crewPopupRef.current?.remove();crewPopupRef.current=null},[]);

  useEffect(()=>{
    if(!map)return undefined;
    const sync=()=>{
      if(!map.getStyle()?.layers?.length)return;
      const route=routes.find(item=>String(item.engineerId)===String(crewPlayback?.selectedEngineerId||''));
      const segments=crewPlayback?.mode==='plan'&&route?playbackRouteSegments(route,crewPlayback.minute):{travelled:[],remaining:[]};
      const features=[...segments.remaining.map((points,index)=>({type:'Feature',properties:{phase:'remaining',index},geometry:{type:'LineString',coordinates:points.map(([lat,lon])=>[lon,lat])}})),...segments.travelled.map((points,index)=>({type:'Feature',properties:{phase:'travelled',index},geometry:{type:'LineString',coordinates:points.map(([lat,lon])=>[lon,lat])}}))];
      const data={type:'FeatureCollection',features};
      const before=map.getStyle().layers.find(layer=>layer.type==='symbol')?.id;
      if(!map.getSource('shift-route-progress'))map.addSource('shift-route-progress',{type:'geojson',data});else map.getSource('shift-route-progress').setData(data);
      if(!map.getLayer('shift-route-remaining'))map.addLayer({id:'shift-route-remaining',type:'line',source:'shift-route-progress',filter:['==',['get','phase'],'remaining'],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':mapTheme==='night'?'#b3a7cf':'#746b86','line-width':5,'line-opacity':.88}},before);
      if(!map.getLayer('shift-route-travelled'))map.addLayer({id:'shift-route-travelled',type:'line',source:'shift-route-progress',filter:['==',['get','phase'],'travelled'],layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#7125c8','line-width':6,'line-opacity':1}},before);
      map.setPaintProperty('shift-route-remaining','line-color',mapTheme==='night'?'#b3a7cf':'#746b86');
      map.setPaintProperty('shift-route-travelled','line-color',mapTheme==='night'?'#a974f4':'#7125c8');
    };
    map.on('style.load',sync);sync();return()=>map.off('style.load',sync);
  },[map,routes,crewPlayback,mapTheme]);

  useEffect(()=>{markersRef.current.forEach(item=>item.element?.classList.toggle('is-list-hovered',String(hoveredOrderId??'')===item.orderId))},[hoveredOrderId]);

  useEffect(()=>{
    const modeChanged=previousScheduledRef.current!==scheduled;
    previousScheduledRef.current=scheduled;
    if(!map||!modeChanged||selectedOrder||activeRoute||selectedTerritory||!positions.length)return undefined;
    const frame=requestAnimationFrame(()=>{
      const bounds=positionsBounds(positions);if(!bounds)return;
      const mapRect=map.getContainer().getBoundingClientRect(),panelRect=document.querySelector('.route-list-panel')?.getBoundingClientRect();
      const panelInset=window.matchMedia('(min-width:761px)').matches&&panelRect?Math.max(0,Math.min(mapRect.width*.58,panelRect.right-mapRect.left)):0;
      map.stop();optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding:{top:90,bottom:80,left:Math.max(70,panelInset+42),right:90},maxZoom:13,duration:820,essential:true}));
    });
    return()=>cancelAnimationFrame(frame);
  },[map,scheduled,signature,selectedOrder,activeRoute,selectedTerritory,positions]);

  useEffect(()=>{
    if(!map)return undefined;
    districtRequestRef.current?.abort();
    const controller=new AbortController();districtRequestRef.current=controller;
    const removeBoundary=()=>{['selected-district-line','selected-district-halo','selected-district-fill'].forEach(id=>{if(map.getLayer(id))map.removeLayer(id)});if(map.getSource('selected-district'))map.removeSource('selected-district')};
    const territoryPadding=()=>{const mapRect=map.getContainer().getBoundingClientRect(),panel=map.getContainer().closest('.workspace-grid')?.querySelector('.route-list-panel'),panelRect=panel&&getComputedStyle(panel).visibility!=='hidden'?panel.getBoundingClientRect():null;return{top:105,bottom:80,left:panelRect?Math.max(70,Math.min(mapRect.width*.58,panelRect.right-mapRect.left)+36):70,right:80}};
    const fitFilteredPoints=()=>{if(!positions.length)return;const bounds=positionsBounds(positions),padding=territoryPadding();if(positions.length===1){const[lat,lon]=positions[0];optimizedCameraMove(map,()=>map.flyTo({center:[lon,lat],zoom:14.3,offset:[(padding.left-padding.right)/2,0],duration:760,speed:1.55,curve:1.1,essential:true}));return}optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding,maxZoom:14.3,duration:820,essential:true}))};
    const renderBoundary=feature=>{
      if(controller.signal.aborted||!feature?.geometry)return false;
      removeBoundary();
      if(feature.properties?.type!=='administrative'&&feature.properties?.category!=='boundary')return false;
      // A territory chosen from the order data remains authoritative even when
      // an imported point falls just outside the administrative polygon.
      map.addSource('selected-district',{type:'geojson',data:{type:'FeatureCollection',features:[feature]}});
      const firstSymbol=map.getStyle().layers.find(layer=>layer.type==='symbol')?.id;
      map.addLayer({id:'selected-district-fill',type:'fill',source:'selected-district',paint:{'fill-color':'#FFD21F','fill-opacity':mapTheme==='night'?.24:.30}},firstSymbol);
      map.addLayer({id:'selected-district-halo',type:'line',source:'selected-district',paint:{'line-color':mapTheme==='night'?'#8B5CF6':'#6D28D9','line-width':7,'line-opacity':.92}},firstSymbol);
      map.addLayer({id:'selected-district-line',type:'line',source:'selected-district',paint:{'line-color':'#FFC800','line-width':3,'line-opacity':1,'line-dasharray':[2,1]}},firstSymbol);
      const polygonBounds=feature.bbox?.length===4?[[feature.bbox[0],feature.bbox[1]],[feature.bbox[2],feature.bbox[3]]]:geometryBounds(feature.geometry);
      const inside=positions.filter(([lat,lon])=>geometryContainsPoint(feature.geometry,[lon,lat])).length;
      const bounds=positions.length&&inside<Math.ceil(positions.length*.55)?positionsBounds(positions):mergeBounds(polygonBounds,positionsBounds(positions));
      if(bounds)optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding:territoryPadding(),maxZoom:13.3,duration:850,essential:true}));
      return true;
    };
    const load=async()=>{
      removeBoundary();
      if(!selectedTerritory){setDistrictBoundaryStatus('');return}
      fitFilteredPoints();
      if(territorySelection(selectedTerritory).kind==='zone'){setDistrictBoundaryStatus('points');return}
      const boundaryQueries=territoryBoundaryQueries(selectedTerritory);
      if(!boundaryQueries.length){setDistrictBoundaryStatus('points');fitFilteredPoints();return}
      setDistrictBoundaryStatus('loading');
      const cacheKey=`beego-territory-boundary:${selectedTerritory.toLocaleLowerCase('ru-RU')}`;
      const selected=territorySelection(selectedTerritory);
      const catalogFeature=findCatalogBoundary(await loadTerritoryCatalog(),selected);
      if(catalogFeature){
        const rendered=renderBoundary(catalogFeature);
        if(rendered)setDistrictBoundaryStatus('ready');
        return;
      }
      try{
        const cached=localStorage.getItem(cacheKey);
        if(cached){const rendered=renderBoundary(JSON.parse(cached));if(rendered){setDistrictBoundaryStatus('ready');return}localStorage.removeItem(cacheKey)}
      }catch{}
      try{
        const selectedName=selected.name.toLocaleLowerCase('ru-RU');
        let feature=null;
        for(let index=0;index<boundaryQueries.length&&!feature;index+=1){
          if(index)await wait(1050);
          const query=encodeURIComponent(boundaryQueries[index]);
          const response=await fetch(`https://nominatim.openstreetmap.org/search?format=geojson&polygon_geojson=1&polygon_threshold=0.00025&limit=4&countrycodes=ru&accept-language=ru&q=${query}`,{signal:controller.signal,headers:{Accept:'application/geo+json'}});
          if(!response.ok)continue;
          const collection=await response.json();
          feature=collection.features?.filter(item=>['Polygon','MultiPolygon'].includes(item.geometry?.type)&&/Москв/i.test(item.properties?.display_name||'')&&(item.properties?.type==='administrative'||item.properties?.category==='boundary')&&String(item.properties?.display_name||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').includes(selectedName.replace(/ё/g,'е'))).sort((a,b)=>{const score=item=>(item.properties?.type==='administrative'?8:0)+(item.properties?.category==='boundary'?5:0);return score(b)-score(a)})[0]||null;
        }
        if(!feature)throw new Error('District boundary not found');
        const rendered=renderBoundary(feature);if(rendered)setDistrictBoundaryStatus('ready');
        try{localStorage.setItem(cacheKey,JSON.stringify(feature))}catch{}
      }catch(error){if(error?.name!=='AbortError'){setDistrictBoundaryStatus('points');fitFilteredPoints()}}
    };
    // isStyleLoaded() can remain false while raster/vector tiles are still
    // pending, even though the style already accepts custom sources/layers.
    if(map.getStyle()?.layers?.length)load();else map.once('style.load',load);
    return()=>{controller.abort();map.off('style.load',load);removeBoundary()};
  },[map,selectedTerritory,mapTheme,signature]);

  useEffect(()=>{
    if(!map)return;
    const requestId=++selectedPopupRequestRef.current;
    const selectedId=selectedOrder?String(selectedOrder.id):'';
    let selectedMarker=null;
    markersRef.current.forEach(item=>{
      const{element,orderId,popup}=item;
      const isSelected=Boolean(selectedId)&&orderId===selectedId;
      element?.classList.toggle('is-selected',isSelected);
      if(element)element.style.zIndex=isSelected?'900':'';
      if(isSelected)selectedMarker=item;else popup?.remove();
    });
    if(!selectedOrder||!Array.isArray(selectedOrder.coords)||selectedOrder.coords.length!==2){activePopupRef.current?.remove();activePopupRef.current=null;markersRef.current.forEach(item=>item.popup?.remove());return}
    if(selectedOrder.suppressPopup)return;
    const isUnassigned=plan?.unassigned?.some(item=>String(item.orderId)===selectedId);
    const showSelectedPopup=()=>{
      if(requestId!==selectedPopupRequestRef.current||String(selectedOrderRef.current?.id??'')!==selectedId||!popupsEnabled||!selectedMarker?.popup)return;
      if(activePopupRef.current===selectedMarker.popup&&selectedMarker.popup.isOpen())return;
      activePopupRef.current?.remove();
      selectedMarker.popup.setLngLat([selectedOrder.coords[1],selectedOrder.coords[0]]).addTo(map);
      if(isUnassigned){const body=selectedMarker.popup.getElement()?.querySelector('.maplibregl-popup-content');if(body)body.scrollTop=0}
      activePopupRef.current=selectedMarker.popup;
    };
    const[lat,lon]=selectedOrder.coords;
    const mapBounds=map.getContainer().getBoundingClientRect();
    const panel=map.getContainer().closest('.workspace-grid')?.querySelector('.route-list-panel');
    const shiftPanel=crewPlayback?document.querySelector('.shift-layer:not(.report-layer) .shift-panel'):null;
    const panelBounds=shiftPanel?.getBoundingClientRect()||(panel&&getComputedStyle(panel).visibility!=='hidden'?panel.getBoundingClientRect():null);
    const detailBounds=document.querySelector('.point-detail-panel')?.getBoundingClientRect();
    const visibleLeft=panelBounds?Math.min(mapBounds.right,Math.max(mapBounds.left,panelBounds.right)):mapBounds.left;
    const visibleRight=detailBounds?Math.max(visibleLeft+120,Math.min(mapBounds.right,detailBounds.left)):mapBounds.right;
    const centerOffset=(visibleLeft+visibleRight-mapBounds.left-mapBounds.right)/2;
    // Keep the unassigned-order popup above its marker, within the visible map area.
    const verticalOffset=isUnassigned?Math.min(380,Math.max(190,mapBounds.height/2-100)):0;
    map.stop();
    const targetZoom=crewPlayback?Math.max(map.getZoom(),13.4):selectedOrder.suppressPopup?Math.min(map.getZoom(),12.6):Math.max(11.5,Math.min(map.getZoom(),13.2));
    showSelectedPopup();
    map.once('moveend',showSelectedPopup);
    optimizedCameraMove(map,()=>map.flyTo({center:[lon,lat],zoom:targetZoom,offset:[centerOffset,verticalOffset],duration:isUnassigned?760:620,speed:1.4,curve:1.1,essential:true}));
    return()=>{selectedPopupRequestRef.current++;map.off('moveend',showSelectedPopup)};
  },[map,selectedOrder,popupsEnabled,Boolean(crewPlayback)]);

  useLayoutEffect(()=>{
    if(!map)return undefined;
    const syncRoute=()=>{
      // Existing route layers can be restyled while base-map tiles are still
      // loading. Waiting for the entire style here made markers appear first.
      if(!map.getLayer('planned-route')&&!map.isStyleLoaded())return;
      const night=mapTheme==='night',activeEngineerId=String(activeRoute?.engineerId??''),hoveredEngineerId=String(effectiveHoveredRouteId??''),activeTest=['==',['get','engineerId'],activeEngineerId],hoveredTest=['==',['get','engineerId'],hoveredEngineerId],attentionTest=['any',activeTest,hoveredTest],brigadeMode=effectiveRouteMode==='brigades';
      const baseRoad=brigadeMode?['get','routeColor']:(night?MAP_UI.routeNeutralDark:MAP_UI.routeNeutral);
      const selectedRoad=night?MAP_UI.routeSelectedDark:MAP_UI.routeSelected;
      const road=['case',attentionTest,selectedRoad,baseRoad];
      const casing=['case',attentionTest,MAP_UI.routeSelectedCasing,night?'#12171D':'#FFFFFF'];
      // Keep zoom out of nested `case` expressions: MapLibre only accepts it as
      // the input of a top-level step/interpolate expression. A restrained
      // constant is also cheaper to evaluate while the dispatcher pans a map
      // with dozens of routes.
      const shiftOverview=Boolean(crewPlayback);
      const overviewOpacity=shiftOverview?(shiftMapTab==='orders'?.035:.075):brigadeMode?.78:.27;
      const roadOpacity=scheduled?['case',activeTest,1,hoveredTest,.94,overviewOpacity]:0;
      const casingOpacity=scheduled?['case',activeTest,.98,hoveredTest,.92,shiftOverview?.035:brigadeMode?.72:.26]:0;
      const roadWidth=['case',activeTest,6,hoveredTest,4.75,shiftOverview?1.6:brigadeMode?3:2.25];
      const casingWidth=['case',activeTest,8.5,hoveredTest,7,shiftOverview?2.5:brigadeMode?5.2:4];
      const beforeLayer=map.getStyle().layers.find(layer=>layer.type==='symbol')?.id;
      const source=map.getSource('planned-route');
      if(source){if(routeDataRef.current?.source!==source||routeDataRef.current?.data!==routeGeoJson){source.setData(routeGeoJson);routeDataRef.current={source,data:routeGeoJson}}}else{map.addSource('planned-route',{type:'geojson',data:routeGeoJson});routeDataRef.current={source:map.getSource('planned-route'),data:routeGeoJson}}
      if(!map.getLayer('planned-route-casing'))map.addLayer({id:'planned-route-casing',type:'line',source:'planned-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':casing,'line-width':casingWidth,'line-opacity':casingOpacity}},beforeLayer);
      if(!map.getLayer('planned-route'))map.addLayer({id:'planned-route',type:'line',source:'planned-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':road,'line-width':roadWidth,'line-opacity':roadOpacity}},beforeLayer);
      if(!map.getLayer('planned-route-arrows'))map.addLayer({id:'planned-route-arrows',type:'symbol',source:'planned-route',minzoom:MAP_SCALE.directionArrowsMinZoom,filter:['==',['get','engineerId'],''],layout:{'symbol-placement':'line','symbol-spacing':120,'text-field':'➤','text-size':13,'text-rotation-alignment':'map','text-pitch-alignment':'viewport','text-keep-upright':false,'text-allow-overlap':false,'text-ignore-placement':false},paint:{'text-color':MAP_UI.routeDirection,'text-halo-color':selectedRoad,'text-halo-width':1.25,'text-opacity':['interpolate',['linear'],['zoom'],MAP_SCALE.directionArrowsMinZoom,0,10.9,1]}},beforeLayer);
      if(!map.getLayer('planned-route-hit'))map.addLayer({id:'planned-route-hit',type:'line',source:'planned-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#000000','line-width':16,'line-opacity':0}},beforeLayer);
      // Playback colours must remain above the ordinary route stroke.
      if(map.getLayer('shift-route-remaining'))map.moveLayer('shift-route-remaining','planned-route-arrows');
      if(map.getLayer('shift-route-travelled'))map.moveLayer('shift-route-travelled','planned-route-arrows');
      map.setPaintProperty('planned-route-casing','line-color',casing);map.setPaintProperty('planned-route-casing','line-width',casingWidth);map.setPaintProperty('planned-route-casing','line-opacity',casingOpacity);
      map.setPaintProperty('planned-route','line-color',road);map.setPaintProperty('planned-route','line-width',roadWidth);map.setPaintProperty('planned-route','line-opacity',roadOpacity);
      map.setFilter('planned-route-arrows',scheduled?['any',activeTest,hoveredTest]:['==',['get','engineerId'],'']);
      map.setPaintProperty('planned-route-arrows','text-color',MAP_UI.routeDirection);map.setPaintProperty('planned-route-arrows','text-halo-color',selectedRoad);
    };
    // A route may be selected while the map is still loading tiles or changing
    // style. Retry when the style becomes ready so the road line is not lost.
    const syncWhenReady=()=>{
      if(!map.getLayer('planned-route')&&!map.isStyleLoaded())return;
      map.off('idle',syncWhenReady);
      map.off('style.load',syncWhenReady);
      syncRoute();
    };
    map.on('idle',syncWhenReady);
    map.on('style.load',syncWhenReady);
    syncWhenReady();
    return()=>{map.off('idle',syncWhenReady);map.off('style.load',syncWhenReady)};
  },[map,routeGeoJson,scheduled,mapTheme,activeRoute,effectiveHoveredRouteId,effectiveRouteMode,Boolean(crewPlayback),shiftMapTab]);

  useEffect(()=>{
    if(!map)return undefined;
    let hoverTimer=null,pendingEngineerId='',visibleEngineerId='';
    const resetPreview=()=>{clearTimeout(hoverTimer);hoverTimer=null;pendingEngineerId='';visibleEngineerId='';setMapHoveredRouteId(null);onRouteHoverRef.current?.(null)};
    const move=event=>{
      const engineerId=String(event.features?.[0]?.properties?.engineerId??'');
      if(!engineerId)return;
      map.getCanvas().style.cursor='pointer';
      if(engineerId===pendingEngineerId||engineerId===visibleEngineerId)return;
      clearTimeout(hoverTimer);
      if(visibleEngineerId){visibleEngineerId='';setMapHoveredRouteId(null);onRouteHoverRef.current?.(null)}
      pendingEngineerId=engineerId;
      hoverTimer=setTimeout(()=>{visibleEngineerId=engineerId;pendingEngineerId='';setMapHoveredRouteId(engineerId);onRouteHoverRef.current?.(engineerId)},3000);
    };
    const leave=()=>{map.getCanvas().style.cursor='';resetPreview()};
    const click=event=>{const engineerId=String(event.features?.[0]?.properties?.engineerId??'');const route=routesRef.current.find(item=>String(item.engineerId)===engineerId);if(route)onRouteRef.current?.(route)};
    const attach=()=>{if(!map.getLayer('planned-route-hit'))return;map.on('mousemove','planned-route-hit',move);map.on('mouseleave','planned-route-hit',leave);map.on('click','planned-route-hit',click)};
    const detach=()=>{if(!map.getLayer('planned-route-hit'))return;map.off('mousemove','planned-route-hit',move);map.off('mouseleave','planned-route-hit',leave);map.off('click','planned-route-hit',click)};
    if(map.getLayer('planned-route-hit'))attach();else map.once('idle',attach);
    return()=>{clearTimeout(hoverTimer);map.off('idle',attach);detach()};
  },[map,scheduled]);

  useEffect(()=>{
    if(!map)return undefined;
    const clearSelection=event=>{
      const target=event.originalEvent?.target;
      if(target?.closest?.('.map-order-marker,.shift-map-crew-marker,.route-start-marker,.maplibregl-popup,.maplibregl-ctrl,.map-hierarchy-panel,.map-theme-picker'))return;
      if(map.getLayer('planned-route-hit')&&map.queryRenderedFeatures(event.point,{layers:['planned-route-hit']}).length)return;
      clearShiftHoverInfo();
      markersRef.current.forEach(item=>item.popup?.remove());
      startMarkersRef.current.forEach(item=>item.popup?.remove());
      setMapHoveredRouteId(null);
      onOrderHoverRef.current?.(null);
      onRouteHoverRef.current?.(null);
      onOrderRef.current?.(null);
      onRouteRef.current?.(null);
      if(crewPlaybackRef.current?.selectedEngineerId)shiftClock.set({selectedEngineerId:'',follow:false});
    };
    map.on('click',clearSelection);
    return()=>map.off('click',clearSelection);
  },[map,clearShiftHoverInfo]);

  useEffect(()=>{
    if(!map||!activeRoute||crewPlayback){lastFittedRouteRef.current='';return}
    const routeId=String(activeRoute.engineerId??'');
    if(!routeId||lastFittedRouteRef.current===routeId)return;
    const coordinates=routeGeoJson.features.filter(feature=>String(feature.properties?.engineerId??'')===routeId).flatMap(feature=>feature.geometry?.coordinates||[]);
    const assignedOrderIds=new Set((activeRoute.assignments||[]).map(item=>String(item.orderId)));
    orders.forEach(order=>{if(assignedOrderIds.has(String(order.id))&&Array.isArray(order.coords)&&order.coords.length===2&&order.coords.every(Number.isFinite))coordinates.push([order.coords[1],order.coords[0]])});
    const activeStart=routeStarts.find(item=>(item.entries||[]).some(entry=>String(entry.route?.engineerId??'')===routeId));
    const start=activeStart?.coords;
    if(start)coordinates.push([start[1],start[0]]);
    if(!coordinates.length)return;
    const bounds=coordinates.reduce((result,[lon,lat])=>result.extend([lon,lat]),new maplibregl.LngLatBounds(coordinates[0],coordinates[0]));
    lastFittedRouteRef.current=routeId;
    const fitRoute=duration=>{
      const mapRect=map.getContainer().getBoundingClientRect(),leftPanel=map.getContainer().closest('.workspace-grid')?.querySelector('.route-list-panel'),rightPanel=document.querySelector('.point-detail-panel, .route-detail-drawer'),leftRect=leftPanel&&getComputedStyle(leftPanel).visibility!=='hidden'?leftPanel.getBoundingClientRect():null,rightRect=rightPanel&&getComputedStyle(rightPanel).visibility!=='hidden'?rightPanel.getBoundingClientRect():null;
      const padding={top:104,bottom:92,left:leftRect?Math.max(72,Math.min(mapRect.width-150,leftRect.right-mapRect.left+88)):84,right:rightRect?Math.max(84,Math.min(mapRect.width-150,mapRect.right-rightRect.left+24)):80};
      optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding,maxZoom:13.4,duration,essential:true}));
    };
    fitRoute(880);
  },[map,activeRoute,routeGeoJson,routeStarts,orders,Boolean(crewPlayback)]);

  useLayoutEffect(()=>{
    if(!map)return undefined;
    map.getContainer().dataset.mapTheme=mapTheme;
    const apply=()=>{if(map.getStyle()?.layers?.length)applyMapTheme(map,mapTheme)};
    apply();
    if(!map.getStyle()?.layers?.length)map.once('style.load',apply);
    return()=>map.off('style.load',apply);
  },[map,mapTheme]);

  const locateUser=()=>{
    if(!map||!navigator.geolocation)return setLocationMessage('Геолокация недоступна в этом браузере');
    locationCameraRef.current=captureMapCamera(map);
    setLocating(true);setLocationMessage('Определяем местоположение…');
    navigator.geolocation.getCurrentPosition(({coords})=>{
      locationMarkerRef.current?.remove();
      const element=document.createElement('span');element.className='user-location-marker';element.setAttribute('aria-label','Моё местоположение');
      locationMarkerRef.current=new maplibregl.Marker({element}).setLngLat([coords.longitude,coords.latitude]).addTo(map);
      optimizedCameraMove(map,()=>map.flyTo({center:[coords.longitude,coords.latitude],zoom:14,duration:1000,speed:1.65,curve:1.15,essential:true}));
      setLocating(false);setLocationVisible(true);setLocationPrompt(null);setLocationMessage('Вы здесь');setTimeout(()=>setLocationMessage(''),2200);
    },error=>{
      locationCameraRef.current=null;
      setLocating(false);setLocationMessage('');
      if(error.code===error.PERMISSION_DENIED)setLocationPrompt('blocked');
      else{setLocationMessage('Не удалось определить местоположение');setTimeout(()=>setLocationMessage(''),3200)}
    },{enableHighAccuracy:false,timeout:8000,maximumAge:300000});
  };

  const requestLocationAccess=async()=>{
    if(!map||!navigator.geolocation){setLocationMessage('Геолокация недоступна в этом браузере');return}
    if(locationVisible){
      clearUserLocation(true);return;
    }
    setLocationPrompt('request');
  };

  const confirmLocationAccess=()=>{
    if(!map||!navigator.geolocation){setLocationPrompt(null);setLocationMessage('Геолокация недоступна в этом браузере');return}
    setLocationPrompt(null);
    locateUser();
  };

  const toggle3D=()=>setIs3D(enabled=>{const next=!enabled;setMap3D(map,next);return next});
  const resetOrientation=()=>{
    if(!map)return;
    map.easeTo({bearing:0,duration:620,easing:t=>1-(1-t)**3,essential:true});
  };

  return <section className={`map-canvas real-map${shiftMapEmphasis?` shift-map-${shiftMapEmphasis}`:''}`}>
    <div ref={containerRef} className="maplibre-host"/>
    {engineerPopup?.engineer?<EngineerMapPopup map={map} {...engineerPopup}/>:null}
    {selectedTerritory?<div className={`district-map-badge ${districtBoundaryStatus}`}><MapPinned/><span><small>{territorySelection(selectedTerritory).kind==='zone'?'Зона из таблицы · показаны её заявки':districtBoundaryStatus==='points'?'Граница района не найдена · показаны заявки':'Сценарий района'}</small><b>{territorySelection(selectedTerritory).name}</b></span>{districtBoundaryStatus==='loading'?<i className="spinner"/>:districtBoundaryStatus==='unavailable'?<AlertTriangle/>:<Check/>}</div>:null}
    {geocodeProgress?<div className={`map-geocode-notice ${geocodeProgress.status||'active'} ${geocodeProgress.closing?'is-closing':''}`} role="status" aria-live="polite"><span className="geocode-notice-icon">{geocodeProgress.active?<span className="spinner"/>:geocodeProgress.status==='warning'?<AlertTriangle/>:<Check/>}</span><div className="geocode-notice-copy"><b>{geocodeProgress.active?`Определяем адреса: ${geocodeProgress.done} из ${geocodeProgress.total}`:geocodeProgress.status==='warning'?'Геокодирование завершено с замечаниями':`${geocodeProgress.found} адресов нанесено на карту`}</b><span>{geocodeProgress.active?`Готовые точки появляются на карте сразу · осталось около ${Math.ceil(Math.max(0,geocodeProgress.total-geocodeProgress.done)/5)} сек${geocodeProgress.failed?` · проверить: ${geocodeProgress.failed}`:''}`:geocodeProgress.message}</span>{geocodeProgress.active?<i className="geocode-progress-track"><i style={{width:`${geocodeProgress.total?Math.round(geocodeProgress.done/geocodeProgress.total*100):0}%`}}/></i>:null}</div>{geocodeProgress.active?<em>{geocodeProgress.total?Math.round(geocodeProgress.done/geocodeProgress.total*100):0}%</em>:<button type="button" className="geocode-notice-close" onClick={onClearGeocodeProgress} aria-label="Закрыть"><X/></button>}</div>:null}
    <MapControls map={map} positions={positions} popupsEnabled={popupsEnabled} onTogglePopups={()=>setPopupsEnabled(value=>!value)} onToggleThemes={()=>{setLegendOpen(false);setThemePickerOpen(open=>!open)}} themesOpen={themePickerOpen} onLocate={requestLocationAccess} onResetOrientation={resetOrientation} locating={locating} locationVisible={locationVisible} is3D={is3D} onToggle3D={toggle3D} legendOpen={legendOpen&&Boolean(scheduled&&plan)} onToggleLegend={value=>{setThemePickerOpen(false);setLegendOpen(current=>typeof value==='boolean'?value:!current)}} legendContent={scheduled&&plan?<MapHierarchyPanel onClose={()=>setLegendOpen(false)} mode={effectiveRouteMode} onModeChange={setRouteDisplayMode} routeCount={visibleRouteCount} activeRoute={activeRoute} orders={orders} plan={plan} playback={Boolean(crewPlayback)}/>:null} legendDark={uiTheme==='dark'}/>
    {themePickerPresence.present?createPortal(<MapThemePicker pickerRef={themePickerRef} value={mapTheme} onChange={chooseMapTheme} onClose={()=>setThemePickerOpen(false)} className={`map-theme-picker-portal dropdown-transition ${themePickerPresence.visible?'is-open':'is-closing'}`}/>,document.body):null}
    {locationPromptPresence.present?createPortal(<div className={`location-consent-backdrop ${uiTheme==='dark'?'dark':''} ${locationPromptMotionClass}`} onMouseDown={event=>event.target===event.currentTarget&&setLocationPrompt(null)}><section className={`location-consent ${renderedLocationPrompt==='blocked'?'is-blocked':''}`} role="dialog" aria-modal="true" aria-label="Доступ к местоположению"><button type="button" className="location-close" onClick={()=>setLocationPrompt(null)} aria-label="Закрыть" data-tooltip="Закрыть"><X/></button><LocationConsentArtwork blocked={renderedLocationPrompt==='blocked'}/><div className="location-consent-copy"><span className="location-consent-kicker">ВАША ПОЗИЦИЯ НА КАРТЕ</span><h3>{renderedLocationPrompt==='blocked'?'Доступ к геолокации заблокирован':'Показать ваше местоположение?'}</h3><p>{renderedLocationPrompt==='blocked'?'Разрешите доступ к местоположению в настройках этого сайта, затем нажмите «Проверить снова».':'Координаты нужны только для показа вашей позиции на карте и не отправляются на сервер.'}</p>{renderedLocationPrompt==='blocked'?<div className="location-hint"><Settings2/><span>Нажмите значок настроек сайта слева от адреса, выберите «Местоположение», затем — «Разрешить».</span></div>:null}</div><footer><button type="button" className="location-secondary" onClick={()=>setLocationPrompt(null)}>Не сейчас</button><button type="button" className="primary location-primary" onClick={confirmLocationAccess}><LocateFixed/><span>{renderedLocationPrompt==='blocked'?'Проверить снова':'Разрешить доступ'}</span></button></footer></section></div>,document.body):null}
    {locationMessage?<div className="map-status">{locating?<span className="spinner"/>:<LocateFixed/>}{locationMessage}</div>:null}
  </section>;
}
function UploadEmpty({onFile,inputRef}){const[dragging,setDragging]=useState(false);const choose=()=>inputRef.current?.click();const takeFile=file=>{if(file)onFile(file)};return <div className={`upload-empty ${dragging?'dragging':''}`} onClick={choose} onDragEnter={event=>{event.preventDefault();setDragging(true)}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(event.currentTarget===event.target)setDragging(false)}} onDrop={event=>{event.preventDefault();setDragging(false);takeFile(event.dataTransfer.files?.[0])}}><input ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{takeFile(event.target.files?.[0]);event.target.value=''}}/><span className="upload-mascot-shell"><img className="empty-mascot upload-mascot" src="/mascot-empty-upload.png" alt="Робот BeeGo с таблицей"/></span><span className="upload-kicker">Импорт заявок</span><div className="upload-copy"><h2>Выберите CSV, JSON, XLS или XLSX</h2><p>или перетащите файл сюда</p></div><button type="button" onClick={event=>{event.stopPropagation();choose()}}><FileUp size={18}/> Выбрать файл</button><a href="/beego-orders-template.xlsx" download="Шаблон заявок BeeGo.xlsx" aria-label="Скачать отдельный шаблон для заявок" onClick={event=>event.stopPropagation()}>Не знаете структуру? <u>Скачать шаблон заявок</u></a></div>}
function RoutesEmpty(){return <div className="panel-empty"><img className="empty-mascot routes-mascot" src="/mascot-empty-routes.png" alt=""/><h2>Маршрутов пока нет</h2><p>Загрузите заявки, чтобы построить первый маршрут</p></div>}
function revealOrderInList(list, selectedId){
  if(!list||selectedId==null)return;
  const row=[...list.querySelectorAll('[data-order-id]')].find(item=>String(item.dataset.orderId)===String(selectedId));
  if(!row)return;
  const rowBounds=row.getBoundingClientRect(),listBounds=list.getBoundingClientRect();
  const target=list.scrollTop+rowBounds.top-listBounds.top-(listBounds.height-rowBounds.height)/2;
  list.scrollTo({top:target,behavior:'smooth'});
}
function OrderList({orders,onOrder,onHover,plan,selectedId}){
  const listRef=useRef(null);
  useEffect(()=>{revealOrderInList(listRef.current,selectedId)},[selectedId]);
  return <div ref={listRef} className={`order-list${plan?' unassigned-order-list':''}`}><div className="table-head"><span>ЗАЯВКА</span><span>ОКНО</span></div>{orders.map(order=>{const selected=String(selectedId??'')===String(order.id);return <button data-order-id={order.id} className={selected?'is-selected':''} aria-pressed={selected} key={order.id} onMouseEnter={()=>onHover?.(order)} onMouseLeave={()=>onHover?.(null)} onFocus={()=>onHover?.(order)} onBlur={()=>onHover?.(null)} onClick={()=>onOrder(order)}><span className={`check-dot point-type-${workPointType(order)} ${workPointType(order)==='emergency'?'urgent':''}`}/><span className="order-main"><b>{displayOrderName(order)}</b><small>{order.address}</small></span><span className="order-window">{order.start?`${order.start}–${order.end}`:'Гибкое'}{order.priority!=='Обычная'?<em className={workPointType(order)==='emergency'?'danger':''}>{filterLabel(order.priority)}</em>:null}</span><ChevronRight size={16}/></button>})}</div>
}
function AssignmentBoard({orders,plan,team,onOrder,onRoute,onOrderHover,onRouteHover,onReassign,activeRoute,selectedOrder}){
  const[dragged,setDragged]=useState(null),[expandedRouteId,setExpandedRouteId]=useState(null);const boardRef=useRef(null),activeRoutes=plan?.routes?.filter(route=>route.assignments.length)||[];
  useEffect(()=>{if(selectedOrder?.id!=null){const owner=activeRoutes.find(route=>route.assignments.some(item=>String(item.orderId)===String(selectedOrder.id)));if(owner){setExpandedRouteId(owner.engineerId);return}}if(activeRoute?.engineerId!=null)setExpandedRouteId(activeRoute.engineerId)},[activeRoute?.engineerId,selectedOrder?.id,plan]);
  useEffect(()=>{if(selectedOrder?.id==null)return;const frame=requestAnimationFrame(()=>revealOrderInList(boardRef.current,selectedOrder.id));return()=>cancelAnimationFrame(frame)},[selectedOrder?.id,expandedRouteId]);
  const drop=engineerId=>{if(dragged){onReassign(dragged,engineerId);setDragged(null)}};
  if(!activeRoutes.length)return <RoutesEmpty/>;
  const toggleRoute=route=>setExpandedRouteId(current=>{const opening=current!==route.engineerId;onRoute(opening?route:null);return opening?route.engineerId:null});
  const planMode=plan?.provenance?.dataKind==='SYNTHETIC_INPUT_EXACT_PLAN'
    ?['Модельный день · точный план','Исходный архив: синтетический вход дня и независимо проверенные маршруты; фактическое выполнение не подтверждено']
    :['Точный план','Маршруты рассчитаны и независимо проверены'];
  return <div ref={boardRef} className="assignment-board"><div className="board-summary"><div><b>{activeRoutes.length} бригад в плане</b><span>{plan.metrics.assigned} задач распределено</span><small className="plan-quality-badge" title={planMode[1]}><ShieldCheck/>{planMode[0]}</small></div>{plan.metrics.unassigned?<em><CircleAlert/>{plan.metrics.unassigned} требуют решения</em>:<em className="ok"><Check/>План без конфликтов</em>}</div>{activeRoutes.map(route=>{const engineer=team.find(item=>item.id===route.engineerId);const expanded=expandedRouteId===route.engineerId,focused=String(activeRoute?.engineerId??'')===String(route.engineerId);return <article data-engineer-id={route.engineerId} className={`route-board-card ${expanded?'is-expanded':''} ${focused?'is-map-focused':''}`} key={route.engineerId} onDragOver={event=>event.preventDefault()} onDrop={()=>drop(route.engineerId)}><div className="route-card-top"><button className="route-card-head" type="button" aria-expanded={expanded} onClick={()=>toggleRoute(route)}><span className="person-avatar" style={{'--engineer-route-color':MAP_UI.routeSelectedCasing}}>{route.engineerName.split(' ').map(part=>part[0]).join('').slice(0,2)}</span><div><b>{route.engineerName}</b><small>{durationLabel(route.workloadMinutes)} · {route.distanceKm} км</small></div><span className="route-task-count">{route.assignments.length}</span><ChevronDown className={expanded?'expanded':''}/></button></div>{expanded?<div className="route-card-details"><div className="route-expanded-stats"><span><small>Заявок</small><b>{route.assignments.length}</b></span><span><small>Время маршрута</small><b>{durationLabel(route.workloadMinutes)}</b></span><span><small>Пробег</small><b>{route.distanceKm} км</b></span></div><div className="assignment-chips">{route.assignments.map((item,index)=>{const order=orders.find(candidate=>candidate.id===item.orderId);if(!order)return null;const selected=String(selectedOrder?.id??'')===String(order.id);return <button draggable data-order-id={order.id} className={selected?'is-selected':''} aria-pressed={selected} onMouseEnter={()=>onOrderHover?.(order)} onMouseLeave={()=>onOrderHover?.(null)} onDragStart={()=>setDragged(order.id)} onClick={()=>onOrder(order)} key={order.id}><span className="route-stop-number" aria-hidden="true">{index+1}</span><span className="route-stop-copy"><b>{displayOrderName(order)}</b><small>{item.manual?<LockKeyhole aria-label="Закреплено вручную"/>:null}{item.plannedStart}–{item.plannedFinish}</small></span><ChevronRight/></button>})}</div>{engineer?.skills?.length?<div className="route-tags" aria-label="Навыки бригады"><small>Навыки бригады</small>{engineer.skills.map(skill=><span key={skill}>{filterLabel(skill)}</span>)}</div>:null}</div>:null}</article>})}</div>
}
function BottomRoutes({view,setView,orders,onRoute,onOrder,onRecalculate,scheduled,plan,activeRoute}){const route=activeRoute?.assignments?.length?activeRoute:plan?.routes?.find(item=>item.assignments.length);if(!scheduled||!route)return null;const shiftStart=toMinutes(route.shiftStart),shiftEnd=toMinutes(route.shiftEnd),shiftLength=Math.max(1,shiftEnd-shiftStart),qualityText=plan.status==='EXACT_VALID'?'Порядок остановок рассчитан и независимо проверен':'Ограничения проверены; новые участки дороги оценочные';return <section className="bottom-routes"><div className="route-title"><span className="route-timeline-icon"><Gauge/></span><span><b>Расписание бригады</b><small>Нажмите на интервал, чтобы открыть заявку</small></span><div className="view-toggle"><button className={view==='timeline'?'active':''} onClick={()=>setView('timeline')}><Gauge/> Таймлайн</button><button className={view==='list'?'active':''} onClick={()=>setView('list')}><List/></button></div></div><button className="route-row" onClick={()=>onRoute(route)}><span className="route-color"/><strong>{route.engineerName}</strong><small><BriefcaseBusiness/> {route.assignments.length}</small><small><MapPin/> {route.distanceKm} км</small><small><Clock3/> {durationLabel(route.workloadMinutes)}</small><ChevronRight/></button>{view==='timeline'?<div className="timeline"><div className="times">{[0,.25,.5,.75,1].map(fraction=><span key={fraction}>{toTime(Math.round(shiftStart+shiftLength*fraction))}</span>)}</div><div className="timeline-track"><span className="timeline-start" title={`Старт смены ${route.shiftStart}`}>Старт</span>{route.assignments.map((item,index)=>{const order=orders.find(candidate=>candidate.id===item.orderId),start=toMinutes(item.plannedStart),finish=toMinutes(item.plannedFinish),left=Math.max(0,(start-shiftStart)/shiftLength*100),width=Math.max(2.4,(finish-start)/shiftLength*100);return <button type="button" key={item.orderId} className={order?.priority==='Авария'?'urgent':''} style={{left:`${left}%`,width:`${Math.min(width,100-left)}%`}} title={`${index+1}. ${displayOrderName(order)} · ${item.plannedStart}–${item.plannedFinish}`} onClick={()=>order&&onOrder(order)}><b>{index+1}</b><span>{item.plannedStart}</span></button>})}</div></div>:<div className="list-summary"><Check/> {qualityText} · {plan.metrics.unassigned} заявок требуют решения</div>}<button className="recalculate-timeline" onClick={onRecalculate}><RefreshCw/>Пересчитать</button><button className="publish">Опубликовать план</button></section>}
function RouteWorkspace({orders,team,plan,scheduled,setScheduled,view,setView,openPlan,onOrder,onRoute,onReassign,onEmergency,mapping,onUploadError,selectedDate,setSelectedDate,uiTheme}){const inputRef=useRef(null);const handleFile=async file=>{if(!file)return;try{mapping(await parseImportFile(file))}catch(error){onUploadError(error?.message||'Не удалось прочитать файл')}};const unassignedOrders=plan?plan.unassigned.map(item=>orders.find(order=>order.id===item.orderId)).filter(Boolean):orders;const assignedOrders=plan?plan.routes.flatMap(route=>route.assignments.map(item=>orders.find(order=>order.id===item.orderId))).filter(Boolean):[];const visibleOrders=scheduled?assignedOrders:unassignedOrders;return <main className="route-workspace"><Topbar scheduled={scheduled} setScheduled={setScheduled} orders={orders} plan={plan} openPlan={openPlan} openUpload={()=>inputRef.current?.click()} addEmergency={onEmergency} selectedDate={selectedDate} setSelectedDate={setSelectedDate}/><input className="workspace-file-input" ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleFile(event.target.files?.[0]);event.target.value=''}}/><Metrics orders={orders} plan={plan}/><div className={`workspace-grid ${scheduled&&plan?.metrics?.assigned?'with-bottom':''}`}><section className="orders-panel"><div className="panel-heading"><div><span className="fake-check"/><h3>{scheduled?'Маршруты':'Не назначены'}</h3></div><div className="segmented"><button className="active"><List/> Список</button><button aria-label="Показать на карте" data-tooltip="Показать на карте"><Map/></button></div></div>{!orders.length?(scheduled?<RoutesEmpty/>:<UploadEmpty onFile={handleFile} inputRef={inputRef}/>):scheduled&&plan?<AssignmentBoard orders={orders} plan={plan} team={team} onOrder={onOrder} onRoute={onRoute} onReassign={onReassign}/>:visibleOrders.length?<OrderList orders={visibleOrders} onOrder={onOrder} plan={plan}/>:<div className="resolved-empty"><Check/><h3>Все заявки распределены</h3><p>Конфликтов и заявок для ручной обработки нет.</p></div>}</section><MapCanvas orders={scheduled?assignedOrders:visibleOrders} scheduled={scheduled} onOrder={onOrder} uiTheme={uiTheme}/><BottomRoutes view={view} setView={setView} orders={orders} onRoute={onRoute} scheduled={scheduled} plan={plan}/></div></main>}
function Modal({children,onClose,wide=false,className='',backdropClassName=''}){return <div className={`modal-backdrop ${backdropClassName}`.trim()} onMouseDown={e=>e.target===e.currentTarget&&onClose()}><section className={`modal ${wide?'wide':''} ${className}`.trim()}>{children}</section></div>}
function ImportDecisionModal({summary,onCancel,onChoose}){
  const duplicateFile=summary.conflicts>0&&!summary.newIds&&!summary.differentDate;
  return <Modal onClose={onCancel} className="import-decision-modal" backdropClassName="import-decision-backdrop">
    <div className="modal-head import-decision-head"><span className="import-decision-mark"><FileSpreadsheet/></span><div><small>ПОВТОРНАЯ ЗАГРУЗКА</small><h2>{summary.differentDate?'Создать смену на другую дату?':duplicateFile?'Эти данные уже загружены':'Как применить данные файла?'}</h2><p>Проверьте совпадения и выберите, что изменить в текущей смене.</p></div><button type="button" onClick={onCancel} aria-label="Закрыть"><X/></button></div>
    <div className="import-decision-body">
      <div className="import-decision-file"><span><FileSpreadsheet/></span><div><b>{summary.fileName||'Новый файл'}</b><small>{summary.differentDate?'Файл относится к другой рабочей дате':'Файл относится к открытому периоду'}</small></div><Check/></div>
      <div className="import-decision-stats"><span><small>Заявки</small><b>{summary.orders}</b></span><span><small>Инженеры</small><b>{summary.engineers}</b></span><span><small>Новые ID</small><b>{summary.newIds}</b></span><span className={summary.conflicts?'attention':''}><small>Совпадения</small><b>{summary.conflicts}</b></span></div>
      {summary.conflictIds?.length?<div className="import-conflict-preview"><small>БУДУТ ОБНОВЛЕНЫ ПО ID</small><p>{summary.conflictIds.slice(0,8).join(', ')}{summary.conflictIds.length>8?'…':''}</p></div>:null}
      {summary.duplicateIds?<div className="import-decision-error"><AlertTriangle/><span>Внутри файла повторяются {summary.duplicateIds} ID. Исправьте файл и загрузите его снова.</span></div>:null}
      <div className="import-decision-impact"><b>{summary.differentDate?'Текущая смена останется без изменений':'Перед применением ничего не изменяется автоматически'}</b><p>{summary.differentDate?'Будет создан самостоятельный набор на дату файла, а после импорта откроется новая смена.':`При полной замене будет удалено ${summary.replaceRemovals||0} записей выбранного типа. Добавление по ID сохранит остальные данные.`}</p></div>
      <div className="import-decision-options"><button type="button" disabled={Boolean(summary.duplicateIds)} onClick={()=>onChoose(summary.differentDate?'separate':'merge')}><span className="import-decision-option-icon"><Plus/></span><span><b>{summary.differentDate?'Создать отдельную смену':'Добавить или обновить по ID'}</b><small>{summary.differentDate?'Сохранить текущий период и открыть данные на новой дате.':'Добавить новые записи и обновить только найденные совпадения.'}</small></span><ChevronRight/></button>{!summary.differentDate?<button type="button" disabled={Boolean(summary.duplicateIds)} onClick={()=>onChoose('replace')}><span className="import-decision-option-icon"><RotateCcw/></span><span><b>Полностью заменить данные смены</b><small>Удалить текущий набор этого типа за день и использовать файл вместо него.</small></span><ChevronRight/></button>:null}</div>
    </div>
    <footer className="modal-footer import-decision-footer"><small>Рабочие данные изменятся только после выбора действия.</small><button type="button" onClick={onCancel}>Отмена</button></footer>
  </Modal>;
}
function HelpCenter({profile,onClose}){
  const[tab,setTab]=useState('home'),[activeTopic,setActiveTopic]=useState(null),[helpQuery,setHelpQuery]=useState('');
  const firstName=profile.name.trim().split(/\s+/)[0]||'коллега';
  const tabs=[['home',House,'Главная'],['learn',GraduationCap,'Обучение'],['help',CircleHelp,'Помощь']];
  const topics=[
    ['routes',Route,'Планирование маршрутов','Загрузка заявок, оптимизация и публикация готового плана.'],
    ['orders',BriefcaseBusiness,'Заявки и объекты','Импорт данных, временные окна и карточки клиентов.'],
    ['engineers',HardHat,'Инженеры и смены','Навыки, транспорт, рабочее время и загрузка команды.'],
    ['settings',Settings2,'Настройки пространства','Профиль, тема интерфейса и параметры оптимизации.'],
  ];
  const guidance={routes:'Выберите дату и проверьте список заявок и состав команды. Нажмите «Построить план». Сохранение доступно только после статуса EXACT_VALID и независимой проверки маршрутов.',orders:'Загрузите CSV, JSON, XLS или XLSX либо добавьте заявку вручную. Перед сохранением проверьте адрес, координаты, клиентское окно, тип работ и территорию.',engineers:'Во вкладке «Инженеры» проверьте территорию, навыки, транспорт, оборудование и границы смены. Изменения состава применяются к выбранному дню.',settings:'В настройках можно выбрать регион и изменить локальный профиль. В разделе «Ограничения» доступны нормативы длительности работ для следующего точного расчёта.'};
  return <aside className="help-center" role="dialog" aria-label="Центр помощи BeeGo!"><header><div className="help-brand"><img src="/beego-mark.png" alt=""/><span><b>BeeGo!</b><small>Центр поддержки</small></span></div><button onClick={onClose} aria-label="Закрыть помощь" data-tooltip="Закрыть"><X/></button></header><div className="help-center-body">
    {tab==='home'?<section className="help-view help-home"><div className="help-welcome"><img src="/mascot-empty-routes.png" alt=""/><div><small>Всегда рядом</small><h2>Привет, {firstName}!</h2><p>Разберёмся с маршрутами, настройками и работой команды.</p></div></div><div className="help-quick-grid"><button onClick={()=>setTab('learn')}><span><GraduationCap/></span><div><b>Начать обучение</b><small>Короткий путь от импорта до готового маршрута</small></div><ArrowRight/></button><button onClick={()=>setTab('help')}><span><ShieldCheck/></span><div><b>Проверить данные</b><small>Как убедиться, что план готов к работе</small></div><ArrowRight/></button><button onClick={()=>setTab('help')}><span><CircleHelp/></span><div><b>Найти ответ</b><small>Инструкции по основным разделам</small></div><ArrowRight/></button></div><div className="help-tip"><ShieldCheck/><p><b>Совет дня</b>Загрузите рабочую таблицу заявок и проверьте сопоставление столбцов перед планированием.</p></div></section>:null}
    {tab==='learn'?<section className="help-view"><div className="help-page-title"><span><GraduationCap/></span><div><small>Быстрый старт</small><h2>Освойте BeeGo!</h2><p>Пять шагов от заявки до проверенного маршрута.</p></div></div><div className="lesson-list">{[['1','Выберите дату','Список дней и планы из исходного архива доступны через календарь.'],['2','Проверьте заявки','Уточните адреса, координаты, окна и типы работ до расчёта.'],['3','Проверьте инженеров','Убедитесь, что навыки, транспорт, территория и смена заданы верно.'],['4','Постройте маршрут','Запустите точный расчёт. Если дороги или данные недоступны, появится ошибка без приблизительного плана.'],['5','Проверьте итог','План со статусом EXACT_VALID можно сохранить; фактическое выполнение отмечается отдельно.']].map(([n,title,description])=><article key={n}><span>{n}</span><div><b>{title}</b><small>{description}</small></div></article>)}</div></section>:null}
    {tab==='help'?<section className="help-view"><div className="help-page-title compact"><span><CircleHelp/></span><div><small>База знаний</small><h2>Чем помочь?</h2></div></div><label className="help-search"><Search/><input value={helpQuery} onChange={event=>setHelpQuery(event.target.value)} placeholder="Найти инструкцию…"/></label><div className="help-topics">{topics.filter(([id,,title,text])=>`${title} ${text} ${guidance[id]}`.toLocaleLowerCase('ru-RU').includes(helpQuery.toLocaleLowerCase('ru-RU'))).map(([id,Icon,title,text])=><button key={id} className={activeTopic===id?'open':''} onClick={()=>setActiveTopic(current=>current===id?null:id)}><span><Icon/></span><div><b>{title}</b><small>{text}</small>{activeTopic===id?<p>{guidance[id]}</p>:null}</div><ChevronRight/></button>)}</div></section>:null}
  </div><nav className="help-tabs">{tabs.map(([id,Icon,label])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}><Icon/><span>{label}</span></button>)}</nav></aside>
}
function ProfileModal({profile,onClose,onSave}){
  const[draft,setDraft]=useState(profile),[roleOpen,setRoleOpen]=useState(false);const roleRef=useRef(null);
  const rolePresence=useDropdownPresence(roleOpen);
  const valid=draft.name.trim()&&draft.email.trim();
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}));
  useEffect(()=>{if(!roleOpen)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='mousedown'&&!roleRef.current?.contains(event.target)))setRoleOpen(false)};document.addEventListener('mousedown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',close)}},[roleOpen]);
  return <Modal onClose={onClose} wide><div className="modal-head profile-modal-head"><div><h2>Профиль</h2><p>Настройте данные, которые будут видеть участники команды</p></div><button onClick={onClose} aria-label="Закрыть" data-tooltip="Закрыть"><X/></button></div><div className="profile-editor"><aside className="profile-preview"><ProfileAvatar profile={draft}/><div className="profile-avatar-tones" role="group" aria-label="Фон аватара">{PROFILE_AVATAR_TONES.map(tone=>{const selected=draft.avatarTone===tone.id||(!draft.avatarTone&&tone.id==='honey');return <button type="button" key={tone.id} className={selected?'selected':''} style={{'--avatar-tone':tone.color}} onClick={()=>update('avatarTone',tone.id)} aria-label={`Фон: ${tone.label}`} aria-pressed={selected} title={tone.label}/>})}</div><h3>{draft.name||'Ваше имя'}</h3><p>{PROFILE_ROLES[draft.role]}</p><small>{draft.email||'email@example.ru'}</small></aside><section><div className="profile-fields"><label>Отображаемое имя<input value={draft.name} onChange={event=>update('name',event.target.value)} placeholder="Имя и фамилия"/></label><div className="form-row"><div className="profile-field" ref={roleRef}><span>Роль</span><button type="button" className={`role-select ${roleOpen?'open':''}`} onClick={()=>setRoleOpen(open=>!open)} aria-haspopup="listbox" aria-expanded={roleOpen}><span>{PROFILE_ROLES[draft.role]}</span><ChevronDown/></button>{rolePresence.present?<div className={`role-menu dropdown-transition ${rolePresence.visible?'is-open':'is-closing'}`} role="listbox" aria-label="Роль пользователя">{Object.entries(PROFILE_ROLES).map(([value,label])=><button type="button" role="option" aria-selected={draft.role===value} className={draft.role===value?'selected':''} key={value} onClick={()=>{update('role',value);setRoleOpen(false)}}><span>{label}</span>{draft.role===value?<Check/>:null}</button>)}</div>:null}</div><label>Email<input type="email" value={draft.email} onChange={event=>update('email',event.target.value)} placeholder="name@company.ru"/></label></div></div><div className="avatar-picker-head"><div><h3>Выберите аватар</h3><p>Загрузка своих изображений отключена</p></div><span>{PROFILE_AVATARS.length} вариантов</span></div><div className="avatar-grid">{PROFILE_AVATARS.map(avatar=><button type="button" key={avatar.id} className={draft.avatar===avatar.id?'selected':''} onClick={()=>update('avatar',avatar.id)} aria-label={avatar.label} aria-pressed={draft.avatar===avatar.id}><img src={avatar.src} alt=""/><span>{avatar.label}</span>{draft.avatar===avatar.id?<i><Check/></i>:null}</button>)}</div></section></div><footer className="modal-footer profile-actions"><button onClick={onClose}>Отмена</button><button className="primary" disabled={!valid} onClick={()=>onSave({...draft,name:draft.name.trim(),email:draft.email.trim()})}>Сохранить профиль</button></footer></Modal>
}
function MappingModal({rows,fileName,onClose,onImport}){const columns=['Имя клиента','Адрес','Телефон','Email','Начало окна','Конец окна','Длительность','Загрузка','Не импортировать','Штрихкод'];return <Modal onClose={onClose} wide><div className="modal-head"><div><h2>Загрузка заявок</h2><p>{fileName} · найдено {rows.length} строк</p></div><button onClick={onClose}><X/></button></div><div className="mapping-groups"><b>Данные адреса</b><span>Адрес · Город · Координаты</span><b>Параметры заявки</b><span>Окно · Длительность · Навык · Приоритет</span></div><div className="mapping-note"><Check/> 9 из 11 колонок выбраны для импорта</div><div className="mapping-table"><div className="mapping-selects">{columns.map(c=><button key={c}>{c}<ChevronDown/></button>)}</div>{[['NAME','ADDRESS','PHONE','EMAIL','START','END','DURATION','LOAD','NOTES','BARCODE'],...rows.slice(0,5).map(o=>[o.name,o.address,o.phone,o.email,o.start,o.end,o.duration,'1','Тестовая заявка',`46000010${String(o.id).padStart(4,'0')}`])].map((r,i)=><div className={i===0?'headers':''} key={i}>{r.map((c,j)=><span key={j}>{c||'—'}</span>)}</div>)}</div><footer className="modal-footer"><button onClick={onClose}>Отмена</button><button className="primary" onClick={onImport}>Загрузить {rows.length} заявок</button></footer></Modal>}
function DevelopmentModal({onClose}){return <div className="modal-backdrop development-modal-backdrop" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><section className="development-modal" role="dialog" aria-modal="true" aria-label="Пересчёт плана в разработке"><button type="button" className="development-modal-close" onClick={onClose} aria-label="Закрыть"><X/></button><span className="development-modal-art"><LockKeyhole/></span><small>ФУНКЦИЯ В РАЗРАБОТКЕ</small><h2>Пересчёт плана пока недоступен</h2><p>Опубликованный план остаётся без изменений. Когда функция будет готова, здесь можно будет проверить новый точный маршрут перед публикацией.</p><button type="button" className="primary" onClick={onClose}>Понятно</button></section></div>}
function PlanDrawer({orders,team,onClose,onOptimize,optimizing,selectedDate}){return <div className="drawer-backdrop plan-modal-backdrop"><aside className="plan-drawer"><div className="modal-head"><div><h2>Спланировать маршруты</h2><p>{fullDateLabel(selectedDate)}</p></div><button className="plan-modal-close" type="button" onClick={onClose} aria-label="Закрыть окно планирования"><X/></button></div><div className="plan-drawer-content"><div className="plan-step done"><span>1</span><div><b>Заявки</b><small>{orders.length} готовы к распределению</small></div><Check/></div><div className={`plan-step ${team.length?'done':'warning'}`}><span>2</span><div><b>Команда участка</b><small>{team.length?`${team.length} исполнителей · навыки и транспорт проверены`:'Сначала загрузите инженеров во вкладке «Инженеры»'}</small></div>{team.length?<Check/>:<AlertTriangle/>}</div><section className="plan-options-section"><div className="plan-options-heading"><small>ТОЧНЫЙ РАСЧЁТ</small><h4>Ограничения и маршруты будут проверены перед сохранением</h4></div><p>Планировщик учитывает квалификацию, территории, клиентские окна, смены и дороги. Параметры раздела «Ограничения» пока находятся в разработке.</p></section></div><footer><button type="button" onClick={onClose}>Отмена</button><button type="button" className="primary" onClick={onOptimize} disabled={optimizing||!team.length}>{optimizing?<><span className="spinner"/>Оптимизируем…</>:'Построить план'}</button></footer></aside></div>}
function PageShell({title,children,action,onClose,floating=false,motionClass='',className=''}){return <main className={`page ${floating?'map-overlay-page':''} ${className} ${motionClass}`.trim()}><header><div><h1>{title}</h1><p>Управление выездной службой в одном рабочем пространстве</p></div>{onClose?<div className="page-header-actions">{action}<button type="button" className="panel-close page-close" onClick={onClose} aria-label={`Закрыть: ${title}`} data-tooltip="Закрыть"><X/></button></div>:action}</header>{children}</main>}
const TransportIcon=({type})=>{const normalized=String(type||'').toLocaleLowerCase('ru-RU');if(/велосип|bike|bicycle/.test(normalized))return <Bike/>;if(/обществен|автобус|public|bus|transit/.test(normalized))return <Bus/>;if(/пеш|walk|foot/.test(normalized))return <Footprints/>;return <Car/>};
function EngineerUploadPanel({inputRef,onFile}){const[dragging,setDragging]=useState(false);const choose=()=>inputRef.current?.click();const takeFile=file=>{if(file)onFile(file)};return <section className="engineer-upload-stage"><div className={`engineer-upload-card ${dragging?'dragging':''}`} onClick={choose} onDragEnter={event=>{event.preventDefault();setDragging(true)}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(event.currentTarget===event.target)setDragging(false)}} onDrop={event=>{event.preventDefault();setDragging(false);takeFile(event.dataTransfer.files?.[0])}}><input className="workspace-file-input" ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{takeFile(event.target.files?.[0]);event.target.value=''}}/><span className="engineer-mascot-shell"><img src="/avatars/dog-engineer.png" alt="Инженер BeeGo"/></span><span className="engineer-upload-kicker">Импорт инженеров</span><h2>Выберите CSV, JSON, XLS или XLSX</h2><p>или перетащите файл сюда</p><button type="button" onClick={event=>{event.stopPropagation();choose()}}><Download/>Выбрать файл</button><a href="/beego-engineers-template.xlsx" download="Шаблон инженеров BeeGo.xlsx" aria-label="Скачать отдельный шаблон для инженеров" onClick={event=>event.stopPropagation()}>Не знаете структуру? <u>Скачать шаблон инженеров</u></a><small>После выбора откроется большая редактируемая таблица</small></div></section>}
function PanelSearch({value,onChange,placeholder,label}){return <label className="panel-search"><Search aria-hidden="true"/><input type="search" value={value} onChange={event=>onChange(event.target.value)} placeholder={placeholder} aria-label={label}/>{value?<button type="button" onClick={()=>onChange('')} aria-label="Очистить поиск"><X/></button>:null}</label>}
const engineerFilterValues=value=>(Array.isArray(value)?value:String(value||'').split(/[|,;]+/)).map(item=>String(item||'').trim()).filter(Boolean);
const engineerFilterOptions=(values,allLabel)=>[['',allLabel],...[...new Set(values)].sort((left,right)=>filterLabel(left).localeCompare(filterLabel(right),'ru-RU')).map(value=>[value,filterLabel(value)])];
const filterSelectionValues=value=>Array.isArray(value)?value.filter(Boolean):value?[value]:[];
function EngineerFilters({team,value,onChange}){
  const options=useMemo(()=>({skill:engineerFilterOptions(team.flatMap(engineer=>engineerFilterValues(engineer.skills)),'Все навыки'),equipment:engineerFilterOptions(team.flatMap(engineer=>engineerFilterValues(engineer.equipment)),'Любое оборудование'),location:engineerFilterOptions(team.flatMap(engineer=>[engineer.zone,engineer.district,engineer.regionName].filter(Boolean)),'Все локации'),transport:engineerFilterOptions(team.map(engineer=>engineer.transport).filter(Boolean),'Любой транспорт'),status:engineerFilterOptions(team.map(engineer=>engineer.status).filter(Boolean),'Любая доступность')}),[team]);
  const sections=[['skill','Навыки',options.skill],['equipment','Оборудование',options.equipment],['location','Локация',options.location],['transport','Транспорт',options.transport],['status','Доступность',options.status]];
  return <WorkspaceFilters title="Отобрать инженеров" sections={sections} value={value} onChange={onChange} multiKeys={['skill','equipment']}/>;
}
function OrderFilters({orders,value,onChange}){
  const options=useMemo(()=>({skill:engineerFilterOptions(orders.flatMap(order=>engineerFilterValues(effectiveOrderSkill(order))),'Все навыки и виды работ'),equipment:engineerFilterOptions(orders.flatMap(order=>engineerFilterValues(order.equipment)),'Любое оборудование'),priority:engineerFilterOptions(orders.map(order=>order.priority).filter(Boolean),'Любой приоритет'),status:engineerFilterOptions(orders.map(order=>order.status).filter(Boolean),'Любой статус')}),[orders]);
  const sections=[['skill','Навык или вид работ',options.skill],['equipment','Оборудование',options.equipment],['priority','Приоритет',options.priority],['status','Статус',options.status]];
  return <WorkspaceFilters title="Отобрать заявки" sections={sections} value={value} onChange={onChange} multiKeys={['skill','equipment']}/>;
}
function EngineerList({team,onSelect,selectedId,routesByEngineer=new globalThis.Map(),hasPlan=false,shiftTeamIds=null}){
  return <div className="engineer-list">{team.length?<>{team.map(engineer=>{
    const routes=routesByEngineer.get(String(engineer.id))||[],stops=routes.reduce((total,route)=>total+route.assignments.length,0);
    const released=/снят со смены/i.test(engineer.status||'');
    const outsideShift=Boolean(shiftTeamIds&&!shiftTeamIds.has(String(engineer.id)));
    return <button type="button" className={`engineer-list-row ${String(selectedId||'')===String(engineer.id)?'selected':''} ${released?'is-released':''}`} data-engineer-id={engineer.id} key={engineer.id} onClick={()=>onSelect?.(engineer)} aria-pressed={String(selectedId||'')===String(engineer.id)}>
      <span className="person-avatar">{engineer.name.split(' ').map(part=>part[0]).join('').slice(0,2)}</span>
      <span className="engineer-list-main"><b>{engineer.name}</b><span className="engineer-list-skills">{engineer.skills?.length?engineer.skills.map(skill=><small key={skill}>{filterLabel(skill)}</small>):<small>Навыки не указаны</small>}</span><span className="engineer-list-transport"><TransportIcon type={engineer.transport}/>{engineer.transport?filterLabel(engineer.transport):'Транспорт не указан'}</span><span className="engineer-list-load">{outsideShift?'Не включена в смену':hasPlan?routes.length?`${routes.length} ${countForm(routes.length,'маршрут','маршрута','маршрутов')} · ${stops} ${countForm(stops,'остановка','остановки','остановок')}`:'Без маршрута':'План ещё не построен'}</span></span>
      <span className="engineer-list-shift"><b>{engineer.shiftStart}–{engineer.shiftEnd}</b><small className={released?'released-status':''}>{outsideShift?'В составе · вне плана':engineer.status||'Доступность не указана'}</small></span><ChevronRight className="engineer-list-open"/>
    </button>
  })}</>:<div className="panel-filter-empty"><Search/><b>Инженеры не найдены</b><span>Измените поиск или фильтр загрузки.</span></div>}</div>;
}

function EngineerDetailPanel({engineer,routes=[],hasPlan,onClose,onOpenRoute,motionClass=''}){
  if(!engineer)return null;
  const initials=engineer.name.split(' ').map(part=>part[0]).join('').slice(0,2),stops=routes.reduce((total,route)=>total+route.assignments.length,0);
  const skills=engineer.skills?.length?engineer.skills:['Навыки не указаны'];
  const equipment=engineer.equipment?.length?engineer.equipment:['Оборудование не указано'];
  const unavailable=/(недоступ|снят со смены|отпуск|выходн|боле|отсутств|unavailable|leave)/i.test(engineer.status||'');
  const availabilityUnknown=!engineer.status||/(не указ|unknown)/i.test(engineer.status);
  const primaryRoute=routes.find(route=>route.assignments?.length)||null;
  const distance=routes.reduce((total,route)=>total+(Number(route.distanceKm)||0),0);
  return <aside className={`engineer-map-card ${motionClass}`} role="dialog" aria-label={`Инженер ${engineer.name}`} onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()}>
    <header><div className="engineer-detail-heading"><span className="engineer-detail-avatar">{initials}</span><div><small>Карточка инженера</small><h2>{engineer.name}</h2></div></div><button type="button" onClick={onClose} aria-label="Закрыть карточку инженера" data-tooltip="Закрыть"><X/></button></header>
    <div className="engineer-map-card-body detail-content-switch" key={engineer.id}>
      <section className={`engineer-detail-status ${unavailable?'is-unavailable':availabilityUnknown?'is-unknown':''}`}><span>{unavailable?<CircleAlert/>:availabilityUnknown?<CircleHelp/>:<Check/>}</span><div><small>Доступность сегодня</small><b>{engineer.status||'Не указана'}</b></div><em>{hasPlan?routes.length?`${routes.length} ${countForm(routes.length,'маршрут','маршрута','маршрутов')}`:'Без маршрута':'План не построен'}</em></section>
      <div className="engineer-detail-metrics"><article><Clock3/><span><small>Смена</small><b>{engineer.shiftStart||'08:00'}–{engineer.shiftEnd||'18:00'}</b></span></article><article><TransportIcon type={engineer.transport}/><span><small>Транспорт</small><b>{engineer.transport?filterLabel(engineer.transport):'Не указан'}</b></span></article><article><MapPinned/><span><small>Территория</small><b>{[engineer.zone,engineer.district,engineer.regionName].filter(Boolean).join(' · ')||'Не указана'}</b></span></article><article><Route/><span><small>Маршрут</small><b>{hasPlan?`${stops} ${countForm(stops,'остановка','остановки','остановок')} · ${distance.toFixed(1)} км`:'—'}</b></span></article></div>
      <section className="engineer-detail-section"><div className="engineer-detail-section-title"><MapPin/><b>Стартовая точка</b></div><p>{engineer.startAddress||'Адрес старта не указан'}</p></section>
      <section className="engineer-detail-section engineer-competencies"><div className="engineer-detail-section-title"><Wrench/><b>Навыки и оборудование</b></div><div className="engineer-detail-tags">{skills.map(skill=><span key={`skill-${skill}`}>{filterLabel(skill)}</span>)}</div><div className="engineer-detail-tags equipment">{equipment.map(item=><span key={`equipment-${item}`}>{filterLabel(item)}</span>)}</div></section>
      <button className="engineer-route-summary" type="button" disabled={!primaryRoute} onClick={()=>primaryRoute&&onOpenRoute?.(primaryRoute)} aria-label={primaryRoute?`Открыть маршрут ${engineer.name} на карте`:'Маршрута нет'}><Route/><span className="engineer-route-copy"><b>{primaryRoute?'Открыть маршрут':'Маршрута нет'}</b><small>{primaryRoute?`${stops} ${countForm(stops,'остановка','остановки','остановок')} · показать на карте`:hasPlan?'Инженер свободен на сегодня':'Постройте план, чтобы появился маршрут'}</small></span><span className="engineer-route-arrow" aria-hidden="true"><ChevronRight/></span></button>
    </div>
  </aside>;
}
function EngineerMapPopup({map,engineer,routes=[],hasPlan,onClose,onOpenRoute,motionClass='',autoFocus=true}){
  const[portalHost,setPortalHost]=useState(null);
  const coords=engineer?.startCoords;
  const popupRef=useRef(null),coordsRef=useRef(coords);
  coordsRef.current=coords;
  useEffect(()=>{
    const initialCoords=coordsRef.current;
    if(!map||!Array.isArray(initialCoords)||initialCoords.length!==2)return undefined;
    const host=document.createElement('div');
    const popup=new maplibregl.Popup({anchor:'bottom',closeButton:false,closeOnClick:false,focusAfterOpen:false,offset:[0,-22],maxWidth:'548px',className:'engineer-map-popup'}).setLngLat([initialCoords[1],initialCoords[0]]).setDOMContent(host).addTo(map);
    popupRef.current=popup;
    setPortalHost(host);
    if(autoFocus){const targetZoom=Math.max(map.getZoom(),12.2);
    const mapRect=map.getContainer().getBoundingClientRect();
    const panelRect=map.getContainer().closest('.workspace-grid')?.querySelector('.engineer-panel')?.getBoundingClientRect();
    const horizontalOffset=window.matchMedia('(min-width:761px)').matches&&panelRect?Math.max(0,Math.min(mapRect.width*.42,panelRect.right-mapRect.left))/2:0;
    map.stop();
    optimizedCameraMove(map,()=>map.easeTo({center:[initialCoords[1],initialCoords[0]],zoom:targetZoom,offset:[horizontalOffset,Math.min(210,mapRect.height*.27)],duration:620,essential:true}));
    const keepCardVisible=()=>requestAnimationFrame(()=>{
      const card=host.querySelector('.engineer-map-card');
      if(!card)return;
      const overflowTop=70-card.getBoundingClientRect().top;
      if(overflowTop>0)optimizedCameraMove(map,()=>map.panBy([0,-overflowTop],{duration:360,essential:true}));
    });
    map.once('moveend',keepCardVisible);
    return()=>{map.off('moveend',keepCardVisible);popupRef.current=null;setPortalHost(null);popup.remove()}}
    return()=>{popupRef.current=null;setPortalHost(null);popup.remove()};
  },[map,engineer?.id,autoFocus]);
  useEffect(()=>{if(Array.isArray(coords)&&coords.length===2)popupRef.current?.setLngLat([coords[1],coords[0]])},[coords?.[0],coords?.[1]]);
  return portalHost?createPortal(<EngineerDetailPanel engineer={engineer} routes={routes} hasPlan={hasPlan} onClose={onClose} onOpenRoute={onOpenRoute} motionClass={motionClass}/>,portalHost):null;
}
function EngineersPage({team,region,onImportFile,onUploadError,uiTheme,selectedDate,setSelectedDate}){const inputRef=useRef(null);const handleFile=async file=>{if(!file)return;try{onImportFile(await parseImportFile(file,'engineers'))}catch(error){onUploadError(error?.message||'Не удалось прочитать файл инженеров')}};const engineerMarkers=useMemo(()=>team.map(engineer=>({id:`engineer-${engineer.id}`,name:engineer.name,address:engineer.startAddress||region.office,coords:engineer.startCoords})).filter(engineer=>Array.isArray(engineer.coords)&&engineer.coords.length===2),[team,region.office]);return <main className="route-workspace engineer-workspace"><header className="topbar engineer-topbar"><div className="engineer-topbar-title"><HardHat/><strong>Инженеры</strong>{team.length?<b>{team.length}</b>:null}</div><DateControl value={selectedDate} onChange={setSelectedDate}/><div className="top-actions"><a className="icon engineer-template-action" href="/beego-engineers-template.xlsx" download="Шаблон инженеров BeeGo.xlsx" aria-label="Скачать шаблон" data-tooltip="Скачать шаблон"><Download/></a><button type="button" className="primary" onClick={()=>inputRef.current?.click()}><Plus/>Загрузить инженеров</button></div></header><div className="engineer-workspace-grid"><section className="orders-panel engineer-panel"><div className="panel-heading"><div><h3>Инженеры</h3>{team.length?<b className="engineer-count">{team.length}</b>:null}</div>{team.length?<button type="button" className="engineer-reupload" onClick={()=>inputRef.current?.click()} aria-label="Загрузить другой файл" data-tooltip="Загрузить другой файл"><Download/></button>:null}</div>{team.length?<><input className="workspace-file-input" ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleFile(event.target.files?.[0]);event.target.value=''}}/><EngineerList team={team}/></>:<EngineerUploadPanel inputRef={inputRef} onFile={handleFile}/>}</section><MapCanvas orders={engineerMarkers} scheduled={false} onOrder={()=>{}} uiTheme={uiTheme}/></div></main>}

function OperationalMapWorkspace({mode,panelKey,backgroundOnly=false,calendarOverOverlay=false,panelOpen=true,onClosePanel,orders,team,region,plan,scheduled,setScheduled,view,setView,openPlan,onManualAdd,onManageRoster,staffDialog,staffRoster,staffShift,onCloseStaffDialog,onArchiveStaff,onRestoreStaff,onIncludeStaff,pendingManualDraft,onOpenPendingDraft,onOrder,onRoute,onOrderHover,onRouteHover,hoveredOrderId,hoveredRouteId,onReassign,onEmergency,onOpenEngineerRoute,onOpenEngineerDetails,mapping,onUploadError,selectedDate,setSelectedDate,uiTheme,geocodeProgress,onClearGeocodeProgress,selectedOrder,activeRoute,crewPlayback,shiftMapTab,engineerFocusRequest}){
  const ordersInputRef=useRef(null),engineersInputRef=useRef(null);
  const[selectedTerritory,setSelectedTerritory]=useState('');
  const[ordersQuery,setOrdersQuery]=useState(''),[engineersQuery,setEngineersQuery]=useState(''),[engineerLoadFilter,setEngineerLoadFilter]=useState('all');
  const[orderFilters,setOrderFilters]=useState({skill:[],equipment:[],priority:'',status:''});
  const[engineerFilters,setEngineerFilters]=useState({skill:[],equipment:[],location:'',transport:'',status:''});
  const[selectedEngineer,setSelectedEngineer]=useState(null),lastSelectedEngineerRef=useRef(null);
  const handledEngineerFocusRef=useRef(null);
  const panelPresence=useDropdownPresence(panelOpen,280);
  const panelMotionClass=panelPresence.visible?'is-open':panelOpen?'is-opening':'is-closing';
  const engineersMode=mode==='engineers';
  const engineerDetailPresence=useDropdownPresence(Boolean(selectedEngineer)&&engineersMode,260);
  if(selectedEngineer)lastSelectedEngineerRef.current=selectedEngineer;
  const renderedEngineer=selectedEngineer||lastSelectedEngineerRef.current;
  const engineerDetailMotionClass=engineerDetailPresence.visible?'is-open':'is-closing';
  const handleOrdersFile=async file=>{if(!file)return;try{mapping(await parseImportFile(file))}catch(error){onUploadError(error?.message||'Не удалось прочитать файл')}};
  const handleEngineersFile=async file=>{if(!file)return;try{mapping(await parseImportFile(file,'engineers'))}catch(error){onUploadError(error?.message||'Не удалось прочитать файл инженеров')}};
  const unassignedOrders=useMemo(()=>plan?plan.unassigned.map(item=>orders.find(order=>order.id===item.orderId)).filter(Boolean):[],[plan,orders]);
  const assignedOrders=useMemo(()=>plan?plan.routes.flatMap(route=>route.assignments.map(item=>orders.find(order=>order.id===item.orderId))).filter(Boolean):[],[plan,orders]);
  const zones=useMemo(()=>{const counts=new globalThis.Map();orders.forEach(order=>{const name=orderZone(order);if(name)counts.set(name,(counts.get(name)||0)+1)});return[...counts].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'ru'))},[orders]);
  const districts=useMemo(()=>{const counts=new globalThis.Map();orders.forEach(order=>{const name=orderDistrict(order);if(name)counts.set(name,(counts.get(name)||0)+1)});return[...counts].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'ru'))},[orders]);
  useEffect(()=>{if(!selectedTerritory)return;const selected=territorySelection(selectedTerritory),items=selected.kind==='zone'?zones:districts;if(!items.some(item=>item.name===selected.name))setSelectedTerritory('')},[zones,districts,selectedTerritory]);
  const inSelectedTerritory=order=>{if(!selectedTerritory)return true;const selected=territorySelection(selectedTerritory),actual=selected.kind==='zone'?orderZone(order):orderDistrict(order);return actual.toLocaleLowerCase('ru-RU')===selected.name.toLocaleLowerCase('ru-RU')};
  const filteredOrders=useMemo(()=>orders.filter(inSelectedTerritory),[orders,selectedTerritory]);
  const visibleOrders=useMemo(()=>(plan?(scheduled?assignedOrders:unassignedOrders):orders).filter(inSelectedTerritory),[plan,scheduled,assignedOrders,unassignedOrders,orders,selectedTerritory]);
  const displayPlan=useMemo(()=>{if(!plan||!selectedTerritory)return plan;const allowed=new Set(filteredOrders.map(order=>String(order.id)));const routes=plan.routes.map(route=>({...route,assignments:route.assignments.filter(item=>allowed.has(String(item.orderId)))}));const unassigned=plan.unassigned.filter(item=>allowed.has(String(item.orderId)));const assigned=routes.reduce((total,route)=>total+route.assignments.length,0);return{...plan,routes,unassigned,metrics:{...plan.metrics,total:filteredOrders.length,assigned,unassigned:unassigned.length,activeEngineers:routes.filter(route=>route.assignments.length).length}}},[plan,selectedTerritory,filteredOrders]);
  const searchActive=Boolean(ordersQuery.trim());
  const orderFilteredOrders=useMemo(()=>(searchActive?orders:visibleOrders).filter(order=>{const orderSkills=engineerFilterValues(effectiveOrderSkill(order)),orderEquipment=engineerFilterValues(order.equipment);if(!matchesAnySelection(orderFilters.skill,orderSkills))return false;if(!matchesAnySelection(orderFilters.equipment,orderEquipment))return false;if(orderFilters.priority&&order.priority!==orderFilters.priority)return false;if(orderFilters.status&&order.status!==orderFilters.status)return false;return true}),[orders,visibleOrders,searchActive,orderFilters]);
  const searchedOrders=useMemo(()=>searchActive?orderFilteredOrders.filter(order=>matchesSearch(ordersQuery,[order.id,order.sourceId,displayOrderName(order),order.name,order.address,order.skill,order.workType,order.priority,order.equipment,order.zone])):orderFilteredOrders,[orderFilteredOrders,ordersQuery,searchActive]);
  const hasOrderFilters=Object.values(orderFilters).some(value=>Array.isArray(value)?value.length:Boolean(value));
  const searchedDisplayPlan=useMemo(()=>{const base=searchActive?plan:displayPlan;if(!base||(!searchActive&&!hasOrderFilters))return base;const allowed=new Set(searchedOrders.map(order=>String(order.id))),routes=base.routes.map(route=>({...route,assignments:route.assignments.filter(item=>allowed.has(String(item.orderId)))})),unassigned=base.unassigned.filter(item=>allowed.has(String(item.orderId)));return{...base,routes,unassigned,metrics:{...base.metrics,total:searchedOrders.length,assigned:routes.reduce((total,route)=>total+route.assignments.length,0),unassigned:unassigned.length}}},[plan,displayPlan,searchActive,hasOrderFilters,searchedOrders]);
  const routesByEngineer=useMemo(()=>{const index=new globalThis.Map();plan?.routes?.forEach(route=>{if(!route.assignments?.length)return;const id=String(route.engineerId),routes=index.get(id)||[];routes.push(route);index.set(id,routes)});return index},[plan]);
  const shiftTeamIds=useMemo(()=>staffShift?.plan?new Set((staffShift.team||[]).map(engineer=>String(engineer.id))):null,[staffShift?.plan,staffShift?.team]);
  const engineerFilterCounts=useMemo(()=>{let idle=0,light=0;team.forEach(engineer=>{const routes=routesByEngineer.get(String(engineer.id))||[],stops=routes.reduce((total,route)=>total+route.assignments.length,0);if(!routes.length)idle++;else if(stops<=3)light++});return{idle,light}},[team,routesByEngineer]);
  const visibleEngineers=useMemo(()=>team.filter(engineer=>{const routes=routesByEngineer.get(String(engineer.id))||[],stops=routes.reduce((total,route)=>total+route.assignments.length,0);if(plan&&engineerLoadFilter==='idle'&&routes.length)return false;if(plan&&engineerLoadFilter==='light'&&(!routes.length||stops>3))return false;const skills=engineerFilterValues(engineer.skills),equipment=engineerFilterValues(engineer.equipment),locations=[engineer.zone,engineer.district,engineer.regionName].filter(Boolean);if(!matchesAnySelection(engineerFilters.skill,skills))return false;if(!matchesAnySelection(engineerFilters.equipment,equipment))return false;if(engineerFilters.location&&!locations.includes(engineerFilters.location))return false;if(engineerFilters.transport&&engineer.transport!==engineerFilters.transport)return false;if(engineerFilters.status&&engineer.status!==engineerFilters.status)return false;return matchesSearch(engineersQuery,[engineer.name,engineer.sourceId,engineer.transport,engineer.zone,engineer.district,engineer.regionName,engineer.startAddress,engineer.status,skills,equipment])}),[team,routesByEngineer,plan,engineerLoadFilter,engineersQuery,engineerFilters]);
  useEffect(()=>{if(!plan)setEngineerLoadFilter('all')},[plan]);
  useEffect(()=>{if(!engineersMode)return;setSelectedEngineer(current=>{if(!current)return null;const latest=team.find(engineer=>String(engineer.id)===String(current.id));return latest||null})},[engineersMode,team]);
  useEffect(()=>{if(!engineersMode||!engineerFocusRequest||handledEngineerFocusRef.current===engineerFocusRequest.token)return;const engineer=team.find(item=>String(item.id)===String(engineerFocusRequest.id));if(!engineer)return;handledEngineerFocusRef.current=engineerFocusRequest.token;setEngineerLoadFilter('all');setEngineersQuery('');setEngineerFilters({skill:[],equipment:[],location:'',transport:'',status:''});setSelectedEngineer(engineer)},[engineersMode,engineerFocusRequest,team]);
  useEffect(()=>{if(!engineersMode||!selectedEngineer)return undefined;const dismiss=event=>{if(event.target instanceof Element&&!event.target.closest('.engineer-detail-panel'))setSelectedEngineer(null)};document.addEventListener('pointerdown',dismiss);return()=>document.removeEventListener('pointerdown',dismiss)},[engineersMode,selectedEngineer]);
  const revealPanelRow=selector=>{
    const row=document.querySelector(selector),list=row?.closest('.order-list, .assignment-board');
    if(!row||!list)return;
    const rowBounds=row.getBoundingClientRect(),listBounds=list.getBoundingClientRect();
    const target=list.scrollTop+rowBounds.top-listBounds.top-(listBounds.height-rowBounds.height)/2;
    list.scrollTo({top:target,behavior:'smooth'});
  };
  useEffect(()=>{if(!engineersMode||!engineerFocusRequest||!selectedEngineer||String(selectedEngineer.id)!==String(engineerFocusRequest.id))return undefined;const frame=requestAnimationFrame(()=>revealPanelRow(`.engineer-panel .engineer-list-row[data-engineer-id="${CSS.escape(String(engineerFocusRequest.id))}"]`));return()=>cancelAnimationFrame(frame)},[engineersMode,engineerFocusRequest,selectedEngineer,visibleEngineers]);
  useEffect(()=>{if(engineersMode||!activeRoute)return undefined;const frame=requestAnimationFrame(()=>revealPanelRow(`.route-list-panel [data-engineer-id="${CSS.escape(String(activeRoute.engineerId))}"]`));return()=>cancelAnimationFrame(frame)},[engineersMode,activeRoute]);
  const engineerMarkers=useMemo(()=>team.map(engineer=>({id:`engineer-${engineer.id}`,engineerId:engineer.id,name:engineer.name,address:engineer.startAddress||region.office,coords:engineer.startCoords,suppressPopup:true})).filter(engineer=>Array.isArray(engineer.coords)&&engineer.coords.length===2),[team,region.office]);
  const followedRoute=useMemo(()=>crewPlayback?.selectedEngineerId?plan?.routes?.find(route=>String(route.engineerId)===String(crewPlayback.selectedEngineerId)):null,[crewPlayback?.selectedEngineerId,plan]);
  const followedOrderIds=useMemo(()=>followedRoute?new Set(followedRoute.assignments.map(assignment=>String(assignment.orderId))):null,[followedRoute]);
  // Keep DOM markers stable while the playback clock advances. Recreating this
  // filtered array on every frame used to tear down an open hover card.
  const mapItems=useMemo(()=>engineersMode?(crewPlayback?EMPTY_ROUTES:engineerMarkers):crewPlayback?(shiftMapTab==='crews'&&followedOrderIds?orders.filter(order=>followedOrderIds.has(String(order.id))||String(order.id)===String(selectedOrder?.id)):orders):searchedOrders,[engineersMode,Boolean(crewPlayback),engineerMarkers,shiftMapTab,followedOrderIds,orders,selectedOrder?.id,searchedOrders]);
  const changeTerritory=next=>{setSelectedTerritory(next);onOrder(null);onRoute(null)};
  const selectEngineer=engineer=>{if(!engineer)return;setSelectedEngineer(engineer);if(!crewPlayback)return;onOrder?.(null);const current=shiftClock.getSnapshot();const known=crewPlayback.crews.some(item=>String(item.engineerId)===String(engineer.id)&&item.positionKnown);const start=minuteOf(engineer.shiftStart);const minute=current.mode==='plan'&&!known&&start!=null?start:current.minute;shiftClock.set({minute,selectedEngineerId:String(engineer.id),follow:false,focusToken:Date.now()})};
  const selectEngineerMarker=marker=>{const engineer=team.find(item=>String(item.id)===String(marker?.engineerId));selectEngineer(engineer)};
  const selectedEngineerRoutes=renderedEngineer?routesByEngineer.get(String(renderedEngineer.id))||[]:[];
  const selectedCrew=crewPlayback?.crews.find(item=>String(item.engineerId)===String(renderedEngineer?.id)&&item.positionKnown);
  const displayedEngineer=selectedCrew?{...renderedEngineer,startCoords:selectedCrew.coords}:renderedEngineer;

  return <main className={`route-workspace ${engineersMode?'engineer-workspace':''} ${backgroundOnly?'workspace-background-only':''} ${calendarOverOverlay?'calendar-over-overlay':''}`}>
    {engineersMode?<Topbar selectedDate={selectedDate} setSelectedDate={setSelectedDate}/>:<><Topbar selectedDate={selectedDate} setSelectedDate={setSelectedDate}/><input id="beego-orders-file" className="workspace-file-input orders-file-input" ref={ordersInputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleOrdersFile(event.target.files?.[0]);event.target.value=''}}/></>}
    <div className={`workspace-grid ${engineersMode?'engineer-workspace-grid':''} ${panelPresence.present?'':'panel-collapsed'}`}>
      {panelPresence.present?(engineersMode?
        <section key={panelKey||'engineers'} className={`orders-panel engineer-panel workspace-panel-enter ${panelMotionClass}`}>
          <div className="panel-heading"><div><h3>Инженеры</h3>{team.length?<b className="engineer-count">{team.length}</b>:null}</div><div className="panel-heading-actions"><button type="button" className="staff-manager-trigger" onClick={onManageRoster} aria-label="Управлять постоянным составом" title="Постоянный состав и архив"><Users size={17}/><span>Состав</span></button>{!team.length?<button type="button" className="manual-add-trigger" onClick={()=>onManualAdd?.('engineers')} aria-label="Добавить инженера вручную" data-tooltip="Добавить инженера вручную"><Plus/></button>:null}<button type="button" className="panel-close" onClick={onClosePanel} aria-label="Скрыть панель инженеров" data-tooltip="Скрыть панель"><X/></button></div></div>
          {team.length?<><input className="workspace-file-input" ref={engineersInputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleEngineersFile(event.target.files?.[0]);event.target.value=''}}/><div className="engineer-tools"><div className="engineer-load-row"><div className="engineer-load-filters" role="group" aria-label="Фильтр загрузки инженеров">{[['all','Все',team.length],['idle','Без маршрута',engineerFilterCounts.idle],['light','1–3 остановки',engineerFilterCounts.light]].map(([key,label,count])=><button type="button" key={key} className={engineerLoadFilter===key?'selected':''} aria-pressed={engineerLoadFilter===key} disabled={!plan&&key!=='all'} onClick={()=>setEngineerLoadFilter(current=>current===key&&key!=='all'?'all':key)}>{label}{plan||key==='all'?<b>{count}</b>:null}</button>)}</div><button type="button" className="manual-add-trigger" onClick={()=>onManualAdd?.('engineers')} aria-label="Добавить инженера в состав" title="Добавить инженера в состав"><Plus/></button><button type="button" className="orders-import-action engineer-import-action" onClick={()=>engineersInputRef.current?.click()} aria-label="Загрузить другой файл инженеров" data-tooltip="Загрузить другой файл"><FileUp/></button></div>{!plan?<small>Загрузка появится после построения плана</small>:null}<div className="panel-search-row"><PanelSearch value={engineersQuery} onChange={setEngineersQuery} placeholder="Имя, навык, оборудование…" label="Поиск инженеров"/><EngineerFilters team={team} value={engineerFilters} onChange={setEngineerFilters}/></div></div>{pendingManualDraft?.engineer||pendingManualDraft?.replacement?<div className="shift-manual-draft main-manual-draft"><b>{pendingManualDraft.engineer?.name||pendingManualDraft.replacement?.name}</b><span>В составе · ещё не включена в опубликованный план смены</span><button type="button" onClick={onOpenPendingDraft}>Рассчитать и опубликовать</button></div>:null}<EngineerList team={visibleEngineers} onSelect={selectEngineer} selectedId={selectedEngineer?.id||crewPlayback?.selectedEngineerId} routesByEngineer={routesByEngineer} hasPlan={Boolean(plan)} shiftTeamIds={shiftTeamIds}/></>:<EngineerUploadPanel inputRef={engineersInputRef}/>}
        </section>:
        <section key={panelKey||'orders'} className={`orders-panel route-list-panel workspace-panel-enter ${panelMotionClass} ${zones.length||districts.length?'has-district-filter':''}`}>
          <div className="panel-heading"><div><h3>Заявки</h3>{orders.length?<b className="engineer-count">{orders.length}</b>:null}</div><div className="panel-heading-actions">{!orders.length?<button type="button" className="manual-add-trigger" onClick={()=>onManualAdd?.('orders')} aria-label="Добавить заявку вручную" data-tooltip="Добавить заявку вручную"><Plus/></button>:null}<button type="button" className="panel-close" onClick={onClosePanel} aria-label="Скрыть панель заявок" data-tooltip="Скрыть панель"><X/></button></div></div>
          <div className="panel-status-row"><div className="status-tabs"><button className={plan&&scheduled?'selected':''} disabled={!plan} onClick={()=>setScheduled(true)}>Назначены{plan?<b>{plan.metrics.assigned}</b>:null}</button><button className={plan&&!scheduled?'selected':''} disabled={!plan} onClick={()=>setScheduled(false)}>Не назначены{plan?<b>{plan.metrics.unassigned}</b>:null}</button></div>{orders.length?<button type="button" className="manual-add-trigger" onClick={()=>onManualAdd?.('orders')} aria-label="Добавить заявку вручную" title="Добавить заявку вручную"><Plus/></button>:null}{orders.length?<label className="orders-import-action" htmlFor="beego-orders-file" role="button" tabIndex={0} onKeyDown={event=>{if(event.key==='Enter'||event.key===' ')ordersInputRef.current?.click()}} aria-label="Загрузить другой файл заявок" data-tooltip="Загрузить другой файл"><FileUp/></label>:null}</div>
          {zones.length||districts.length?<TerritoryFilter zones={zones} districts={districts} value={selectedTerritory} onChange={changeTerritory} total={orders.length}/>:null}
          {orders.length?<div className="orders-search-wrap"><div className="panel-search-row"><PanelSearch value={ordersQuery} onChange={setOrdersQuery} placeholder="Номер, тип работ или адрес…" label="Поиск заявок"/><OrderFilters orders={orders} value={orderFilters} onChange={setOrderFilters}/></div>{ordersQuery||hasOrderFilters?<small>{searchActive?`Поиск по всем заявкам: ${searchedOrders.length}`:`Найдено: ${searchedOrders.length}`}</small>:null}</div>:null}
          {pendingManualDraft?.order?<div className="shift-manual-draft main-manual-draft"><b>{pendingManualDraft.order.name}</b><span>Черновик заявки · ещё не в опубликованном плане</span><button type="button" onClick={onOpenPendingDraft}>Рассчитать и опубликовать</button></div>:null}
          {!orders.length?<UploadEmpty onFile={handleOrdersFile} inputRef={ordersInputRef}/>:((ordersQuery.trim()||hasOrderFilters)&&!searchedOrders.length)?<div className="panel-filter-empty"><Search/><b>Заявки не найдены</b><span>Измените поиск или сбросьте выбранные фильтры.</span></div>:searchActive?<OrderList orders={searchedOrders} onOrder={onOrder} onHover={onOrderHover} selectedId={selectedOrder?.id} plan={searchedDisplayPlan}/>:scheduled&&searchedDisplayPlan?<AssignmentBoard orders={searchedOrders} plan={searchedDisplayPlan} team={team} onOrder={onOrder} onRoute={onRoute} onOrderHover={onOrderHover} onRouteHover={onRouteHover} activeRoute={activeRoute} selectedOrder={selectedOrder} onReassign={onReassign}/>:searchedOrders.length?<OrderList orders={searchedOrders} onOrder={onOrder} onHover={onOrderHover} selectedId={selectedOrder?.id} plan={searchedDisplayPlan}/>:<div className="resolved-empty"><MapPinned/><h3>{selectedTerritory?'В выбранной территории нет заявок':'Все заявки распределены'}</h3><p>{selectedTerritory?'Выберите другую зону, район или сбросьте фильтр.':'Конфликтов и заявок для ручной обработки нет.'}</p></div>}
        </section>):null}
      <MapCanvas key="persistent-map" orders={mapItems} team={team} scheduled={!engineersMode&&scheduled} plan={engineersMode?null:searchActive?searchedDisplayPlan:displayPlan} onOrder={engineersMode?selectEngineerMarker:onOrder} onCrewSelect={id=>selectEngineer(team.find(item=>String(item.id)===String(id)))} onOpenEngineerDetails={onOpenEngineerDetails} onRoute={onRoute} onOpenPlanning={openPlan} onOrderHover={onOrderHover} onRouteHover={onRouteHover} hoveredOrderId={hoveredOrderId} hoveredRouteId={hoveredRouteId} uiTheme={uiTheme} region={region} geocodeProgress={geocodeProgress} onClearGeocodeProgress={onClearGeocodeProgress} selectedOrder={engineersMode?(selectedEngineer?engineerMarkers.find(item=>String(item.engineerId)===String(selectedEngineer.id)):null):selectedOrder} selectedTerritory={engineersMode||searchActive?'':selectedTerritory} routes={(searchActive?searchedDisplayPlan:displayPlan)?.routes||EMPTY_ROUTES} activeRoute={engineersMode?null:activeRoute} engineerPopup={engineersMode&&engineerDetailPresence.present&&displayedEngineer?{engineer:displayedEngineer,routes:selectedEngineerRoutes,hasPlan:Boolean(plan),onClose:()=>setSelectedEngineer(null),onOpenRoute:onOpenEngineerRoute,motionClass:engineerDetailMotionClass,autoFocus:!crewPlayback||!crewPlayback.follow}:null} crewPlayback={crewPlayback} shiftMapTab={shiftMapTab}/>
      {engineersMode&&crewPlayback?<ShiftPlaybackBar compact/>:null}
    </div>
    {staffDialog ? createPortal(<StaffRosterModal mode={staffDialog} roster={staffRoster} shift={staffShift} date={selectedDate.toLocaleDateString('sv-SE')} onClose={onCloseStaffDialog} onAddNew={()=>{onCloseStaffDialog();onManualAdd?.('engineers')}} onArchive={(member,effectiveDate)=>onArchiveStaff(member,'archive',effectiveDate)} onRestore={(member,effectiveDate)=>onRestoreStaff(member,'restore',effectiveDate)} onInclude={onIncludeStaff}/>,document.body) : null}
  </main>;
}
function AnalyticsPage({orders,team,plan,analyticsDate,setAnalyticsDate,onUploadData,onOpenUnassigned,onOpenRoutes,onOpenOrder,onPreviewReplan,onApplyReplan,onRollbackReplan,onStartLiveReplan,motionClass=''}){return <PageShell floating title="Аналитика" className="analytics-page" motionClass={motionClass}><AnalyticsWorkspace orders={orders} team={team} plan={plan} date={analyticsDate} onDateChange={setAnalyticsDate} dateControl={<DateControl className="analytics-date-control" value={analyticsDate} onChange={setAnalyticsDate}/>} onUploadData={onUploadData} onOpenUnassigned={onOpenUnassigned} onOpenRoutes={onOpenRoutes} onOpenOrder={onOpenOrder} onPreviewReplan={onPreviewReplan} onApplyReplan={onApplyReplan} onRollbackReplan={onRollbackReplan} onStartLiveReplan={onStartLiveReplan}/></PageShell>}
const ROUTE_POLICY_DEFAULTS={strategy:'maximum',urgentFirst:true,balance:true,minimizeTravel:true,preserveManual:true,allowOvertime:false,overtimeLimit:'30',allowLate:false,lateLimit:'15',flexibleStart:false,breakEnabled:true,breakDuration:'45',maxStops:'8',shiftReserve:'15',respectTransport:true,requireCertificates:true,keepTerritories:true,trafficModel:'typical',tollPolicy:'benefit',parkingBuffer:'10',freezeHorizon:'45',stability:'balanced',useCurrentPosition:true,autoEmergency:false,manualNorms:false,normLocal:'60',normAdditional:'60',normConnection:'90',normEmergency:'90'};
const ROUTE_STRATEGIES=[['maximum','Выполнить максимум','Распределить как можно больше заявок за смену.','/planning-capacity-v2.png','Схема максимальной загрузки'],['windows','Без опозданий','Соблюдать клиентские окна даже ценой части заявок.','/planning-windows-v2.png','Схема соблюдения временных окон'],['compact','Меньше в пути','Собирать компактные маршруты и сокращать пробег.','/planning-compact-v2.png','Схема компактного маршрута'],['emergency','Аварийный режим','Ставить аварии первыми и перестраивать обычные работы.','/planning-emergency-v2.png','Схема приоритетного аварийного выезда']];
const STABILITY_LEVELS=[['stable','Стабильный','Менять только необходимое'],['balanced','Сбалансированный','Разумный компромисс'],['optimal','Оптимальный','Можно сильно перестроить']];
const POLICY_NORM_TYPES=[['normLocal','Локальные работы','Диагностика, ремонт и обслуживание'],['normAdditional','Дозаказ','Установка дополнительного оборудования'],['normConnection','Подключение','Новое подключение и первичный монтаж'],['normEmergency','Аварийные работы','Срочный выезд и восстановление услуги']];
const policyNormKey=order=>{const value=`${order?.skill||''} ${order?.workType||''} ${order?.priority||''}`.toLocaleLowerCase('ru-RU');if(/авар|emerg|urgent|critical/.test(value))return'normEmergency';if(/дозаказ|upsell|additional/.test(value))return'normAdditional';if(/подключ|install|connect|монтаж/.test(value))return'normConnection';return'normLocal'};
const filePolicyNorms=orders=>{const fallback={normLocal:60,normAdditional:60,normConnection:90,normEmergency:90},groups=Object.fromEntries(Object.keys(fallback).map(key=>[key,[]]));(orders||[]).forEach(order=>{const duration=Number(order.duration);if(Number.isFinite(duration)&&duration>0)groups[policyNormKey(order)].push(duration)});const values={},counts={};Object.entries(groups).forEach(([key,list])=>{const sorted=[...list].sort((a,b)=>a-b);values[key]=sorted.length?Math.round(sorted[Math.floor(sorted.length/2)]):fallback[key];counts[key]=sorted.length});return{values,counts,total:(orders||[]).length}};
const applyPolicyNorms=(orders,policy)=>policy?.manualNorms?(orders||[]).map(order=>({...order,duration:Number(policy[policyNormKey(order)])||Number(order.duration)||60})):(orders||[]);
const loadRoutePolicy=()=>{try{return{...ROUTE_POLICY_DEFAULTS,...JSON.parse(localStorage.getItem('beego-route-policy')||'{}'),useCurrentPosition:true}}catch{return{...ROUTE_POLICY_DEFAULTS,useCurrentPosition:true}}};
function PolicySwitch({checked,onChange,label,disabled=false}){return <button type="button" className={`policy-switch ${checked?'on':''}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={()=>!disabled&&onChange(!checked)}><i/></button>}
function PolicyRow({title,description,checked,onChange,children,locked=false,badge=''}){return <div className={`route-policy-row ${locked?'locked':''}`}><div><b>{title}</b>{description?<small>{description}</small>:null}{badge?<em>{badge}</em>:null}</div>{children||<PolicySwitch checked={checked} onChange={onChange} label={title} disabled={locked}/>}</div>}
function PreferencesPage({section='planning',motionClass='',policy=ROUTE_POLICY_DEFAULTS,onPolicySave,onToast,orders=[],onClose}){
  const tab=section;
  const[saved,setSaved]=useState(policy);
  const[draft,setDraft]=useState(saved);
  const dirty=JSON.stringify(saved)!==JSON.stringify(draft);
  const stabilityIndex=Math.max(0,STABILITY_LEVELS.findIndex(([id])=>id===draft.stability));
  const importedNorms=useMemo(()=>filePolicyNorms(orders),[orders]);
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}));
  const toggleManualNorms=value=>setDraft(current=>value?{...current,manualNorms:true,...Object.fromEntries(Object.entries(importedNorms.values).map(([key,norm])=>[key,String(norm)]))}:{...current,manualNorms:false});
  const save=()=>{const next={...draft,useCurrentPosition:true};setDraft(next);setSaved(next);onPolicySave?.(next);onToast?.('Настройки сохранены в браузере. На точный расчёт сейчас влияют только нормативы длительности работ.',{title:'Раздел в разработке'});try{localStorage.setItem('beego-route-policy',JSON.stringify(next))}catch{}};
  const reset=()=>setDraft({...ROUTE_POLICY_DEFAULTS});
  const select=(key,value,options,disabled=false)=><SiteSelect value={value} options={options} disabled={disabled} ariaLabel={options.find(([id])=>String(id)===String(value))?.[1]||'Выберите значение'} onChange={next=>update(key,next)}/>;
  const action=<div className="route-policy-actions"><button type="button" className="route-policy-reset" disabled><RotateCcw/>Сбросить</button><button type="button" className="primary" disabled><Save/>Сохранить</button></div>;
  return <PageShell floating className={`route-policy-page ${section}-policy-page workspace-panel-enter`} title={section==='planning'?'Планирование':'Ограничения'} motionClass={motionClass} action={action} onClose={onClose}>
    <div className="development-banner" role="status"><span className="development-banner-icon"><LockKeyhole/></span><div><small>ПРЕДПРОСМОТР РАЗДЕЛА</small><strong>В разработке · пока недоступно</strong><p>Настройки показаны для ознакомления. Сохранять и применять их к маршрутам пока нельзя. Точный план строится по данным и обязательным ограничениям исходного алгоритма.</p></div><em>Скоро</em></div>
    <div className="route-policy-layout standalone-policy-layout development-preview" inert>
      <section className={`route-policy-content ${tab==='constraints'?'constraints-content':''}`}>
        {tab==='planning'?<>
          <div className="route-policy-section-title planning-modes-title"><Gauge/><div><h3>Режим расчёта</h3></div></div>
          <div className="strategy-grid">{ROUTE_STRATEGIES.map(([id,title,description,image,alt])=><button type="button" className={draft.strategy===id?'selected':''} onClick={()=>update('strategy',id)} key={id}><span className="strategy-artwork"><img src={image} alt={alt}/></span><div className="strategy-copy"><b>{title}</b><p>{description}</p></div>{draft.strategy===id?<i><Check/></i>:null}</button>)}</div>
          <div className="route-policy-heading replanning-heading"><span><RefreshCw/></span><div><small>ИЗМЕНЕНИЯ В ТЕЧЕНИЕ ДНЯ</small><h2>Перепланирование</h2><p>Настройте, насколько сильно алгоритм может менять уже опубликованный рабочий день.</p></div></div>
          <div className="stability-slider" style={{'--stability-progress':`${stabilityIndex*50}%`}}>
            <div className="stability-slider-control">
              <div className="stability-slider-track"><i/></div>
              <div className="stability-slider-stops" aria-hidden="true">{STABILITY_LEVELS.map(([id],index)=><i className={index<=stabilityIndex?'reached':''} key={id}/>)}</div>
              <input type="range" min="0" max="2" step="1" value={stabilityIndex} aria-label="Уровень перепланирования" aria-valuetext={STABILITY_LEVELS[stabilityIndex][1]} onChange={event=>update('stability',STABILITY_LEVELS[Number(event.target.value)][0])}/>
            </div>
            <div className="stability-slider-labels">{STABILITY_LEVELS.map(([id,title,description])=><button type="button" className={draft.stability===id?'selected':''} onClick={()=>update('stability',id)} aria-pressed={draft.stability===id} key={id}><b>{title}</b><small>{description}</small></button>)}</div>
          </div>
          <div className="route-policy-card"><PolicyRow title="Не менять ближайшие задания" description="Задания, которые начнутся в течение выбранного времени, останутся у текущих инженеров и сохранят своё расписание.">{select('freezeHorizon',draft.freezeHorizon,[['15','15 минут'],['30','30 минут'],['45','45 минут'],['60','1 час'],['90','1,5 часа']])}</PolicyRow><PolicyRow title="Добавлять аварийные заявки без подтверждения" description="При поступлении аварии система сразу пересчитает маршруты и при необходимости перенесёт обычные заявки." checked={draft.autoEmergency} onChange={value=>update('autoEmergency',value)}/></div>
        </>:null}
        {tab==='constraints'?<>
          <div className="route-policy-section-title"><img className="route-policy-section-art" src="/route-policy/shifts.png" alt=""/><div><h3>Время и смены</h3></div></div>
          <div className="route-policy-card ios-settings-group">
            <PolicyRow title="Сверхурочные">{<div className="policy-row-control"><PolicySwitch checked={draft.allowOvertime} onChange={value=>update('allowOvertime',value)} label="Сверхурочные"/>{select('overtimeLimit',draft.overtimeLimit,[['15','до 15 мин'],['30','до 30 мин'],['60','до 1 часа'],['90','до 1,5 часа']],!draft.allowOvertime)}</div>}</PolicyRow>
            <PolicyRow title="Опоздания">{<div className="policy-row-control"><PolicySwitch checked={draft.allowLate} onChange={value=>update('allowLate',value)} label="Опоздания"/>{select('lateLimit',draft.lateLimit,[['10','до 10 мин'],['15','до 15 мин'],['30','до 30 мин']],!draft.allowLate)}</div>}</PolicyRow>
            <PolicyRow title="Гибкое начало смены" checked={draft.flexibleStart} onChange={value=>update('flexibleStart',value)}/>
            <PolicyRow title="Перерыв">{<div className="policy-row-control"><PolicySwitch checked={draft.breakEnabled} onChange={value=>update('breakEnabled',value)} label="Перерыв"/>{select('breakDuration',draft.breakDuration,[['30','30 минут'],['45','45 минут'],['60','60 минут']],!draft.breakEnabled)}</div>}</PolicyRow>
            <PolicyRow title="Максимум заявок">{select('maxStops',draft.maxStops,[['6','6 заявок'],['8','8 заявок'],['10','10 заявок'],['12','12 заявок']])}</PolicyRow>
            <PolicyRow title="Резерв смены">{select('shiftReserve',draft.shiftReserve,[['0','Без резерва'],['15','15 минут'],['30','30 минут'],['45','45 минут']])}</PolicyRow>
          </div>

          <div className="route-policy-section-title"><img className="route-policy-section-art" src="/route-policy/norms.png" alt=""/><div><h3>Нормативы времени</h3></div></div>
          <div className="route-policy-card ios-settings-group norm-settings-group">
            <PolicyRow title="Задать вручную" checked={draft.manualNorms} onChange={toggleManualNorms}/>
            {POLICY_NORM_TYPES.map(([key,title])=><PolicyRow title={title} locked={!draft.manualNorms} key={key}><div className="norm-inline-control"><input type="number" min="5" max="480" step="5" disabled={!draft.manualNorms} value={draft.manualNorms?draft[key]:String(importedNorms.values[key])} onChange={event=>update(key,event.target.value)}/><span>мин</span></div></PolicyRow>)}
          </div>

          <div className="route-policy-section-title"><img className="route-policy-section-art" src="/route-policy/assignment.png" alt=""/><div><h3>Назначение</h3></div></div>
          <div className="route-policy-card ios-settings-group">
            <PolicyRow title="Тип транспорта" checked={draft.respectTransport} onChange={value=>update('respectTransport',value)}/>
            <PolicyRow title="Сертификаты и допуски" checked={draft.requireCertificates} onChange={value=>update('requireCertificates',value)}/>
            <PolicyRow title="Территориальные бригады" checked={draft.keepTerritories} onChange={value=>update('keepTerritories',value)}/>
          </div>

          <div className="route-policy-section-title"><img className="route-policy-section-art" src="/route-policy/roads.png" alt=""/><div><h3>Дороги и транспорт</h3></div></div>
          <div className="route-policy-card ios-settings-group">
            <PolicyRow title="Пробки">{select('trafficModel',draft.trafficModel,[['none','Не учитывать'],['typical','Типичные'],['peak','Час пик'],['live','Актуальные']])}</PolicyRow>
            <PolicyRow title="Платные дороги">{select('tollPolicy',draft.tollPolicy,[['allow','Разрешать'],['benefit','Экономия от 20 мин'],['avoid','Не использовать']])}</PolicyRow>
            <PolicyRow title="Парковка и подход">{select('parkingBuffer',draft.parkingBuffer,[['0','Не учитывать'],['5','5 минут'],['10','10 минут'],['15','15 минут']])}</PolicyRow>
          </div>
        </>:null}
      </section>
    </div>
  </PageShell>
}
function SettingsPage({settings,setSettings,region,setRegion,regions=[],onToast}){
  const[tab,setTab]=useState('company');
  const[baseStatus,setBaseStatus]=useState(null);
  useEffect(()=>{let active=true;fetch('/api/base-data/status').then(async response=>{if(!response.ok)throw new Error('Сервер недоступен');return response.json()}).then(value=>{if(active)setBaseStatus(value)}).catch(()=>{if(active)setBaseStatus({error:'Нет связи с сервером'})});return()=>{active=false}},[]);
  const update=(key,value)=>setSettings(current=>({...current,[key]:value}));
  const save=()=>{try{localStorage.setItem('beego-settings',JSON.stringify(settings));onToast('Профиль рабочего пространства сохранён в этом браузере.')}catch{onToast('Не удалось сохранить профиль рабочего пространства.')}};
  const navigation=[['company','Компания',Building2],['regions','Рабочие пространства',MapPinned],['data','Исходные данные',Database],['integrations','Сервер',ServerCog]];
  return <PageShell title="Настройки" action={<button className="primary" onClick={save}><Save/>Сохранить профиль</button>}><div className="settings-overview"><div><span className="settings-brand"><Activity/></span><div><b>BeeGo! Operations</b><p>Профиль, рабочие пространства и проверенная база</p></div></div><span className="backend-status"><i/> {baseStatus?.error||'Операционный сервер'}</span></div><div className="settings-layout settings-modern"><aside>{navigation.map(([id,label,Icon])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}><Icon/><span>{label}</span><ChevronRight/></button>)}</aside><section>
    {tab==='company'?<><div className="settings-heading"><small>ОРГАНИЗАЦИЯ</small><h2>Профиль компании</h2><p>Эти поля сохраняются локально в браузере диспетчера.</p></div><div className="form-card settings-card"><label>Название компании<input value={settings.company} onChange={event=>update('company',event.target.value)}/></label><div className="form-row"><label>Рабочий email<input value={settings.email} onChange={event=>update('email',event.target.value)}/></label><label>Телефон<input value={settings.phone} onChange={event=>update('phone',event.target.value)}/></label></div></div></>:null}
    {tab==='regions'?<><div className="settings-heading"><small>РАБОЧИЕ ПРОСТРАНСТВА</small><h2>Регионы</h2><p>Выберите регион из загруженных и сохранённых данных.</p></div><div className="region-settings-grid">{regions.map(item=><button key={item.id} className={region.id===item.id?'selected':''} onClick={()=>setRegion(item)}><span>{item.code||item.name.slice(0,2)}</span><div><b>{item.name}</b><small>{item.office||'Офис не задан'}</small><em>{item.engineerCount??0} инженеров</em></div>{region.id===item.id?<Check/>:null}</button>)}</div></>:null}
    {tab==='data'?<><div className="settings-heading"><small>ИСТОЧНИК</small><h2>Основная база</h2><p>Заявки, инженеры, маршруты и история загружены из первого архива проекта.</p></div><div className="schema-list"><div><Check/><span>Дней в базе</span><em>{baseStatus?.days??'—'}</em></div><div><Check/><span>Дней в операционном хранилище</span><em>{baseStatus?.storedDays??'—'}</em></div><div><Check/><span>Период</span><em>{baseStatus?.firstDate||'—'} — {baseStatus?.lastDate||'—'}</em></div></div></>:null}
    {tab==='integrations'?<><div className="settings-heading"><small>СЕРВЕР</small><h2>Готовность расчёта</h2><p>Планы публикуются только со статусом EXACT_VALID после независимой проверки.</p></div><div className="integration-list"><article><span className="integration-icon connected"><ServerCog/></span><div><b>Операционная база</b><p>{baseStatus?.error||`${baseStatus?.storedDays??'—'} из ${baseStatus?.days??'—'} дней доступны`}</p></div></article><article><span className="integration-icon connected"><Route/></span><div><b>Точный планировщик</b><p>Новые данные и события проверяются локальным алгоритмом и маршрутизатором перед публикацией.</p></div></article></div></>:null}
  </section></div></PageShell>;
}
function SettingsModal({onClose,...props}){return <div className="modal-backdrop settings-modal-layer" role="dialog" aria-modal="true" aria-label="Настройки BeeGo!" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><section className="modal wide settings-modal-dialog"><button className="settings-modal-close" onClick={onClose} aria-label="Закрыть настройки" data-tooltip="Закрыть"><X/></button><SettingsPage {...props}/></section></div>}
const MemoImportWorkspace=memo(ImportWorkspace);
export function App(){
  const[settingsOpen,setSettingsOpen]=useState(false);
  const[recalculateNoticeOpen,setRecalculateNoticeOpen]=useState(false);
  const deepLinkOrderRef=useRef(new URLSearchParams(window.location.search).get('order'));
  const lastMapScreenRef=useRef('orders');
  const analyticsUploadRef=useRef(null);
  const appShellRef=useRef(null),previousExpandedRef=useRef(true),railAnimationsRef=useRef([]),toastSwipeRef=useRef(null);
  const[expanded,setExpanded]=useState(true),[screen,setScreen]=useState('orders'),[workspacePanelOpen,setWorkspacePanelOpen]=useState(true),[assistantOpen,setAssistantOpen]=useState(false);const[theme,setTheme]=useState(()=>{try{return localStorage.getItem('beego-theme')==='dark'?'dark':'light'}catch{return'light'}});const[profile,setProfile]=useState(()=>{try{return {...{name:'Юлия Кузнецова',role:'dispatcher',email:'y.kuznetsova@beego.ru',avatar:'',avatarTone:'honey'},...JSON.parse(localStorage.getItem('beego-profile')||'{}')}}catch{return{name:'Юлия Кузнецова',role:'dispatcher',email:'y.kuznetsova@beego.ru',avatar:'',avatarTone:'honey'}}}),[profileOpen,setProfileOpen]=useState(false),[helpOpen,setHelpOpen]=useState(false);const[region,setRegion]=useState(DEFAULT_REGION);const[orders,setOrders]=useState([]),[engineers,setEngineers]=useState([]),[importSession,setImportSession]=useState(null),[reviewSession,setReviewSession]=useState(null);const[plan,setPlan]=useState(null),[planOpen,setPlanOpen]=useState(false);const[scheduled,setScheduled]=useState(false),[view,setView]=useState('timeline');const[selectedDate,setSelectedDate]=useState(()=>{const date=new URLSearchParams(window.location.search).get('date');return /^\d{4}-\d{2}-\d{2}$/.test(date||'')?startOfDay(new Date(`${date}T12:00:00`)):startOfDay(new Date('2026-08-17T12:00:00'))}),[analyticsDate,setAnalyticsDate]=useState(()=>startOfDay(new Date()));const[selectedOrder,setSelectedOrder]=useState(null),[focusedRoute,setFocusedRoute]=useState(null),[hoveredOrder,setHoveredOrder]=useState(null),[hoveredRouteId,setHoveredRouteId]=useState(null);const[optimizing,setOptimizing]=useState(false),[toast,setToast]=useState(null),[geocodeProgress,setGeocodeProgress]=useState(null);const[routePolicy,setRoutePolicy]=useState(loadRoutePolicy);const[notifications,setNotifications]=useState(()=>{try{const stored=JSON.parse(localStorage.getItem('beego-notifications')||'[]');return Array.isArray(stored)?stored:[]}catch{return[]}}),[notificationsOpen,setNotificationsOpen]=useState(false);const toastTimersRef=useRef([]);const[settings,setSettings]=useState(()=>{const defaults={company:'Билайн Бизнес',email:'team@beego.ru',phone:'+7 999 000-00-00',balance:true,prioritizeUrgent:true,lockManual:true,allowLate:false};try{return{...defaults,...JSON.parse(localStorage.getItem('beego-settings')||'{}')}}catch{return defaults}});
  const[replanSnapshot,setReplanSnapshot]=useState(null);
  const[manualEntryType,setManualEntryType]=useState('');
  const[staffRoster,setStaffRoster]=useState([]),[staffDialog,setStaffDialog]=useState('');
  const[shift,setShift]=useState(null),[pendingShiftEvent,setPendingShiftEvent]=useState(null),[replacementFor,setReplacementFor]=useState('');
  const[shiftInitialTab,setShiftInitialTab]=useState('crews');
  const[engineerFocusRequest,setEngineerFocusRequest]=useState(null);
  const shiftTime=useSyncExternalStore(shiftClock.subscribe,shiftClock.getSnapshot);
  const[pendingImport,setPendingImport]=useState(null);
  const[reviewFiles,setReviewFiles]=useState([]);
  const[reviewClosing,setReviewClosing]=useState(false);
  const reviewCloseTimerRef=useRef(null);
  useEffect(()=>()=>clearTimeout(reviewCloseTimerRef.current),[]);
  useEffect(()=>{try{localStorage.setItem('beego-theme',theme)}catch{}document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;const themeMeta=document.querySelector('meta[name="theme-color"]');if(themeMeta)themeMeta.setAttribute('content',theme==='dark'?'#17191D':'#FFD21F')},[theme]);
  useEffect(()=>{try{localStorage.setItem('beego-profile',JSON.stringify(profile))}catch{}},[profile]);
  useEffect(()=>{try{localStorage.setItem('beego-region',region.id)}catch{}},[region.id]);
  useEffect(()=>{try{localStorage.setItem('beego-notifications',JSON.stringify(notifications.slice(0,40)))}catch{}},[notifications]);
  useEffect(()=>()=>toastTimersRef.current.forEach(clearTimeout),[]);
  useEffect(()=>{if(selectedOrder){setHelpOpen(false);setNotificationsOpen(false)}},[selectedOrder]);
  const notify=(message,{title='BeeGo!',showToast=true}={})=>{const item={id:`notification-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,title,message,time:new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),read:false};setNotifications(current=>[item,...current].slice(0,40));if(!showToast)return;toastTimersRef.current.forEach(clearTimeout);setToast({...item,closing:false});toastTimersRef.current=[setTimeout(()=>setToast(current=>current?{...current,closing:true}:current),6000),setTimeout(()=>setToast(null),6360)]};
  const markNotificationRead=id=>setNotifications(current=>current.map(item=>item.id===id?{...item,read:true}:item));
  const clearNotificationGroup=filter=>setNotifications(current=>current.filter(item=>filter==='unread'?item.read:!item.read));
  const dismissToastAsRead=(id,exitDirection=1)=>{if(id)markNotificationRead(id);toastTimersRef.current.forEach(clearTimeout);setToast(current=>current?{...current,closing:true,exitDirection}:current);toastTimersRef.current=[setTimeout(()=>setToast(null),260)]};
  const toggleNotifications=()=>setNotificationsOpen(open=>{const next=!open;if(next){setHelpOpen(false);setSelectedOrder(null);}return next});
  const regions=useMemo(()=>regionCatalog(orders,engineers,region),[orders,engineers]);
  const selectedDayKey=selectedDate.toLocaleDateString('sv-SE');
  useEffect(()=>setAnalyticsDate(selectedDate),[selectedDayKey]);
  useEffect(()=>{let live=true;fetch(`/api/staff/engineers?regionId=${encodeURIComponent(region.id)}`).then(async response=>{if(!response.ok)throw new Error('Не удалось загрузить состав');return response.json()}).then(items=>{if(live)setStaffRoster(items)}).catch(()=>{if(live)setStaffRoster([])});return()=>{live=false}},[region.id]);
  const regionOrders=useMemo(()=>orders.filter(order=>order.regionId===region.id&&(!order.serviceDate||parseImportedDate(order.serviceDate)?.toLocaleDateString('sv-SE')===selectedDayKey)),[orders,region.id,selectedDayKey]);
  useEffect(()=>{const id=deepLinkOrderRef.current;if(!id)return;const target=regionOrders.find(order=>String(order.id)===id||String(order.sourceId)===id);if(target){deepLinkOrderRef.current=null;setScreen('orders');setWorkspacePanelOpen(true);setSelectedOrder(target)}},[regionOrders]);
  const team=useMemo(()=>{const rosterBySource=new globalThis.Map(staffRoster.filter(member=>member.regionId===region.id).map(member=>[String(member.sourceId||member.id),member]));const scoped=engineers.filter(engineer=>engineer.regionId===region.id&&(!engineer.serviceDate||parseImportedDate(engineer.serviceDate)?.toLocaleDateString('sv-SE')===selectedDayKey)&&(engineer.serviceDate||!rosterBySource.has(String(engineer.sourceId||engineer.id))||staffActiveOn(rosterBySource.get(String(engineer.sourceId||engineer.id)),selectedDayKey)));const bySource=new globalThis.Map();staffRoster.filter(member=>member.regionId===region.id&&staffActiveOn(member,selectedDayKey)).forEach(member=>bySource.set(String(member.sourceId||member.id),member));scoped.forEach(engineer=>{const key=String(engineer.sourceId||engineer.id);const prior=bySource.get(key);if(!prior||engineer.serviceDate)bySource.set(key,engineer)});return[...bySource.values()]},[engineers,staffRoster,region.id,selectedDayKey]);
  useEffect(()=>{let live=true;fetch(`/api/shifts?regionId=${encodeURIComponent(region.id)}&date=${selectedDayKey}`).then(async response=>response.ok?response.json():null).then(saved=>{if(!live)return;setShift(saved);if(!saved?.plan)return;setPlan(saved.plan);setScheduled(true);const sameDay=item=>item.regionId===region.id&&(!item.serviceDate||parseImportedDate(item.serviceDate)?.toLocaleDateString('sv-SE')===selectedDayKey);setOrders(current=>[...current.filter(item=>!sameDay(item)),...saved.orders.map(item=>({...item,regionId:region.id,serviceDate:selectedDayKey}))]);setEngineers(current=>[...current.filter(item=>!sameDay(item)),...saved.team.map(item=>({...item,regionId:region.id,serviceDate:selectedDayKey}))])}).catch(()=>{if(live)setShift(null)});return()=>{live=false}},[region.id,selectedDayKey]);
  useEffect(()=>{if(screen!=='shift'&&screen!=='engineers')shiftClock.set({playing:false})},[screen]);
  useEffect(()=>{setPlan(null);setScheduled(false);setSelectedOrder(null);setFocusedRoute(null)},[region.id]);
  useEffect(()=>{setPlan(null);setScheduled(false);setSelectedOrder(null);setFocusedRoute(null)},[selectedDayKey]);
  const showMapping=session=>{clearTimeout(reviewCloseTimerRef.current);setReviewClosing(false);setImportSession(session);setProfileOpen(false);setSettingsOpen(false)};
  const closeReview=()=>{if(reviewClosing)return;setReviewClosing(true);clearTimeout(reviewCloseTimerRef.current);reviewCloseTimerRef.current=setTimeout(()=>{setImportSession(null);setReviewClosing(false)},240)};
  const selectReviewFile=file=>{clearTimeout(reviewCloseTimerRef.current);setReviewClosing(false);setImportSession({...file,mode:'review',reviewFiles,onSelectFile:selectReviewFile,onAddFile:showMapping,onFileError:message=>notify(message,{title:'Не удалось добавить файл'})})};
  const openReview=()=>{if(!reviewSession)return;if(importSession?.mode==='review'&&!reviewClosing){closeReview();return}selectReviewFile(reviewSession);setWorkspacePanelOpen(false);setScreen(lastMapScreenRef.current);setSelectedOrder(null);setPlanOpen(false);setProfileOpen(false);setSettingsOpen(false);setHelpOpen(false);setNotificationsOpen(false)};
  const saveManualEntry=async form=>{
    const id=`${region.id}:${form.sourceId}`;
    const exists=[...orders,...engineers,...staffRoster].some(item=>String(item.id).toLocaleLowerCase('ru-RU')===id.toLocaleLowerCase('ru-RU')||String(item.sourceId||'').toLocaleLowerCase('ru-RU')===form.sourceId.toLocaleLowerCase('ru-RU'));
    if(exists)return 'Такой ID уже есть среди данных региона.';
    if(shift?.plan&&pendingShiftEvent&&(manualEntryType==='orders'||replacementFor))return 'Сначала рассчитайте и опубликуйте уже созданный черновик изменения плана либо уберите его во вкладке «Изменить план».';
    if(shift?.plan&&(manualEntryType==='orders'||replacementFor)){
      try{
        const response=await fetch(`/api/shifts/${shift.id}/preview`);
        if(response.ok){const saved=await response.json();if(saved.baseRevision===shift.revision&&['READY','RUNNING'].includes(saved.status))return 'У этой смены уже есть неопубликованный расчёт. Откройте «Ход смены» → «Изменить план» и опубликуйте или отмените его перед добавлением новой записи.'}
        else if(response.status!==404)return 'Не удалось проверить черновики смены. Повторите попытку.';
      }catch{return 'Не удалось проверить черновики смены. Убедитесь, что сервер работает, и повторите попытку.'}
    }
    let coords=null;
    let draftEvent=null;
    if(manualEntryType==='orders'){
      let geocoded;
      try{geocoded=await geocodeManualOrder(form.address,region.id);coords=geocoded.coords}
      catch(error){return error.message||'Не удалось подтвердить адрес заявки.'}
      const serviceDate=(resolveImportedDate(regionOrders)||selectedDate).toLocaleDateString('sv-SE');
      const order={id,sourceId:form.sourceId,name:form.name.trim(),address:form.address.trim(),formattedAddress:geocoded.formattedAddress,city:region.name,regionName:region.name,regionId:region.id,zone:form.zone,skill:form.skill,workType:form.skill,equipment:form.equipment.trim(),start:form.start,end:form.end,duration:Number(form.duration),priority:form.skill==='Аварийные работы'?'Авария':form.priority,serviceDate,status:'Черновик',coords,geocodeStatus:'ready',geocodeProvider:geocoded.geocodeProvider};
      if(!shift?.plan)setOrders(current=>[...current,order]);
      if(shift?.plan)draftEvent={type:'NEW_ORDER',order};
      notify(shift?.plan?'Черновик заявки готов. Проверьте пересчёт и опубликуйте новый план.':coords?'Заявка добавлена. Пересчитайте план.':'Заявка добавлена в очередь проверки адреса. Для расчёта подтвердите точку.',{title:shift?.plan?'Черновик заявки':'Новая заявка'});
    }else{
      try{coords=(await geocodeManualOrder(form.address,region.id,fetch,'Инженер')).coords}
      catch(error){return error.message||'Не удалось подтвердить адрес старта инженера.'}
      const engineer={id,sourceId:form.sourceId,name:form.name.trim(),city:region.name,regionName:region.name,regionId:region.id,zone:form.zone,skills:form.skills,equipment:form.equipment.split(/[;,|]/).map(item=>item.trim()).filter(Boolean),transport:form.transport,shiftStart:form.shiftStart,shiftEnd:form.shiftEnd,startAddress:form.address.trim(),startCoords:coords,status:'Доступен'};
      let saved;
      try{const response=await fetch('/api/staff/engineers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({engineer,activeFrom:form.activeFrom})});const body=await response.json();if(!response.ok)return body.error||'Не удалось добавить инженера в состав.';saved=body}catch{return 'Не удалось связаться с сервером состава.'}
      setStaffRoster(current=>[...current,saved]);
      if(replacementFor&&shift?.plan){draftEvent={type:'ENGINEER_REPLACED',engineerId:replacementFor,replacement:saved};notify('Инженер добавлен в состав. Проверьте замену в текущей смене.',{title:'Новая бригада'})}
      else{setManualEntryType('');setReplacementFor('');setStaffDialog('');setSelectedDate(new Date(`${form.activeFrom}T12:00:00`));setEngineerFocusRequest({id:saved.id,token:Date.now()});setScreen('engineers');setWorkspacePanelOpen(true);notify(`${saved.name} добавлена в состав с ${form.activeFrom.split('-').reverse().join('.')}. План смены не изменён.`,{title:'Инженер в составе'});return ''}
    }
    if(draftEvent){setPendingShiftEvent(draftEvent);setShiftInitialTab('event');setScreen('shift');setWorkspacePanelOpen(false)}else{setPlan(null);setScheduled(false)}
    setSelectedOrder(null);setFocusedRoute(null);setManualEntryType('');setReplacementFor('');
    return '';
  };
  const importRows=async({orders:nextOrders=[],engineers:nextEngineers=[]},reviewSnapshot,mode='merge')=>{
    if(reviewSnapshot){
      const normalizedSnapshot={...reviewSnapshot,fileId:reviewSnapshot.fileId||`${reviewSnapshot.fileName||'file'}:${Date.now()}`,importedAt:reviewSnapshot.importedAt||Date.now()};
      setReviewFiles(current=>[...current.filter(file=>file.fileId!==normalizedSnapshot.fileId&&file.fileName!==normalizedSnapshot.fileName),normalizedSnapshot]);
      setReviewSession(current=>({
        ...normalizedSnapshot,
        datasets:{...(current?.datasets||{}),...normalizedSnapshot.datasets},
      }));
    }
    const importedItems=[...nextOrders,...nextEngineers];
    const importedDate=importedItems.map(item=>parseImportedDate(item.serviceDate)).find(Boolean)||resolveImportedDate(importedItems)||selectedDate;
    const dateKey=importedDate.toLocaleDateString('sv-SE');
    const importedRegionIds=new Set([...nextOrders,...nextEngineers].map(item=>item.regionId).filter(Boolean));
    const preparedOrders=nextOrders.map(order=>{
      const serviceDate=parseImportedDate(order.serviceDate)?.toLocaleDateString('sv-SE')||dateKey;
      const collision=orders.some(existing=>String(existing.id)===String(order.id)&&parseImportedDate(existing.serviceDate)?.toLocaleDateString('sv-SE')!==serviceDate);
      return{...order,serviceDate,id:collision?`${order.id}@${serviceDate}`:order.id};
    });
    const keyOf=item=>`${item.regionId}:${parseImportedDate(item.serviceDate)?.toLocaleDateString('sv-SE')||dateKey}:${item.sourceId||item.id}`;
    const upsertOrders=next=>setOrders(current=>{
      const base=mode==='replace'?current.filter(order=>!importedRegionIds.has(order.regionId)||parseImportedDate(order.serviceDate)?.toLocaleDateString('sv-SE')!==dateKey):current;
      const updates=new globalThis.Map(next.map(order=>[keyOf(order),order]));
      return[...base.filter(order=>!updates.has(keyOf(order))),...updates.values()];
    });
    if(preparedOrders.length)upsertOrders(preparedOrders);
    if(nextEngineers.length){
      const prepared=nextEngineers.map(engineer=>mode==='separate'?{...engineer,id:`${engineer.id}@${dateKey}`,serviceDate:dateKey}:engineer);
      setEngineers(current=>{
        const base=mode==='replace'?current.filter(engineer=>!importedRegionIds.has(engineer.regionId)||engineer.serviceDate&&engineer.serviceDate!==dateKey):current;
        const updates=new globalThis.Map(prepared.map(engineer=>[`${engineer.regionId}:${engineer.serviceDate||''}:${engineer.sourceId||engineer.id}`,engineer]));
        return[...base.filter(engineer=>!updates.has(`${engineer.regionId}:${engineer.serviceDate||''}:${engineer.sourceId||engineer.id}`)),...updates.values()];
      });
    }
    const firstImported=nextOrders[0]||nextEngineers[0];
    if(firstImported){const nextRegion=regionCatalog(nextOrders,nextEngineers,region).find(item=>item.id===firstImported.regionId);if(nextRegion)setRegion(nextRegion)}
    if(importedItems.length){setSelectedDate(importedDate);setAnalyticsDate(importedDate)}
    setPlan(null);setImportSession(null);setScheduled(false);setSelectedOrder(null);
    const parts=[nextOrders.length?`${nextOrders.length} заявок`:'',nextEngineers.length?`${nextEngineers.length} инженеров`:''].filter(Boolean);
    const missing=preparedOrders.filter(order=>!Array.isArray(order.coords)||order.coords.length!==2||!order.coords.every(Number.isFinite));
    if(!missing.length){const cityCount=new Set([...nextOrders,...nextEngineers].map(item=>item.regionId)).size;notify(`${parts.join(' и ')} загружено · ${cityCount} ${cityCount===1?'город':'города'}`);return}
    try{
      const geocoded=await geocodeImportedOrders(preparedOrders,setGeocodeProgress,upsertOrders);
      upsertOrders(geocoded);
      const found=geocoded.filter(order=>Array.isArray(order.coords)&&order.coords.length===2).length;
      const review=geocoded.filter(order=>order.geocodeStatus==='review').length;
      const failed=geocoded.filter(order=>!Array.isArray(order.coords)||order.coords.length!==2).length;
      const message=failed?`${found} адресов нанесено · проверить: ${Math.max(review,failed)}`:`Все ${found} адресов успешно обработаны`;
      setGeocodeProgress({status:failed?'warning':'success',active:false,found,total:nextOrders.length,failed,message});
      notify(message,{title:'Импорт завершён',showToast:false});
      setTimeout(()=>setGeocodeProgress(current=>current?{...current,closing:true}:current),4700);setTimeout(()=>setGeocodeProgress(null),5100);
    }catch(error){
      console.error('Ошибка геокодирования Geoapify:',error?.message||error);
      const message='Сервис временно недоступен. Уже найденные метки сохранены — повторите импорт позже.';
      setGeocodeProgress({status:'warning',active:false,found:0,total:missing.length,failed:missing.length,message});
      notify(message,{title:'Ошибка геокодирования',showToast:false});
      setTimeout(()=>setGeocodeProgress(current=>current?{...current,closing:true}:current),5700);setTimeout(()=>setGeocodeProgress(null),6100);
    }
  };
  const requestImportRows=(payload,reviewSnapshot)=>{
    // Editing the already-open data review is a save, not a second file import.
    // The conflict preview is reserved for a genuinely newly selected file.
    if(importSession?.mode==='review'){
      importRows(payload,reviewSnapshot,'merge');
      return;
    }
    const incoming=[...(payload.orders||[]),...(payload.engineers||[])];
    const importedDate=incoming.map(item=>parseImportedDate(item.serviceDate)).find(Boolean)||resolveImportedDate(incoming)||selectedDate;
    const dateKey=importedDate.toLocaleDateString('sv-SE');
    const incomingKeys=incoming.map(item=>`${item.regionId}:${dateKey}:${item.sourceId||item.id}`);
    const duplicateIds=incomingKeys.length-new Set(incomingKeys).size;
    const existingItems=[...orders,...engineers];
    const existingKeys=new Set(existingItems.map(item=>`${item.regionId}:${parseImportedDate(item.serviceDate)?.toLocaleDateString('sv-SE')||dateKey}:${item.sourceId||item.id}`));
    const conflictingItems=incoming.filter((item,index)=>existingKeys.has(incomingKeys[index]));
    const conflicts=conflictingItems.length;
    const importedRegionIds=new Set(incoming.map(item=>item.regionId).filter(Boolean));
    const replacesOrders=(payload.orders||[]).length?orders.filter(item=>importedRegionIds.has(item.regionId)&&(parseImportedDate(item.serviceDate)?.toLocaleDateString('sv-SE')||dateKey)===dateKey).length:0;
    const replacesEngineers=(payload.engineers||[]).length?engineers.filter(item=>importedRegionIds.has(item.regionId)&&(parseImportedDate(item.serviceDate)?.toLocaleDateString('sv-SE')||dateKey)===dateKey).length:0;
    if(!orders.length&&!engineers.length){importRows(payload,reviewSnapshot,'merge');return}
    setImportSession(null);
    setReviewClosing(false);
    setPendingImport({payload,reviewSnapshot,summary:{fileName:reviewSnapshot?.fileName,orders:payload.orders?.length||0,engineers:payload.engineers?.length||0,newIds:incoming.length-conflicts,conflicts,conflictIds:conflictingItems.map(item=>String(item.sourceId||item.id)),replaceRemovals:replacesOrders+replacesEngineers,duplicateIds,differentDate:dateKey!==selectedDate.toLocaleDateString('sv-SE')}});
  };
  // A sidebar toggle must not re-render the entire editable 205×28-cell table.
  // Stable event wrappers preserve fresh import logic without invalidating memo.
  const importRowsRef=useRef(requestImportRows),importCancelRef=useRef(null);
  importRowsRef.current=requestImportRows;
  importCancelRef.current=()=>importSession?.mode==='review'?closeReview():setImportSession(null);
  const stableImportRows=useCallback((...args)=>importRowsRef.current(...args),[]);
  const stableImportCancel=useCallback(()=>importCancelRef.current?.(),[]);
  const optimize=async()=>{setOptimizing(true);try{const planningOrders=regionOrders.map(order=>isInformationalOrder(order)?{...order,skill:effectiveOrderSkill(order),priority:'Обычная'}:order);const next=await requestPlan(planningOrders,team,region.id,{planningDate:selectedDayKey});const response=await fetch('/api/shifts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({regionId:region.id,date:selectedDayKey,orders:planningOrders,team,plan:next})});const saved=await response.json().catch(()=>({}));if(!response.ok)throw new Error(saved.error||'Не удалось сохранить смену');setShift(saved);setPlan(next);setPlanOpen(false);setScheduled(true);setFocusedRoute(null);setView('timeline');notify(`Точный план сохранён: распределено ${next.metrics.assigned} из ${next.metrics.total}. Для ручного решения: ${next.metrics.unassigned}.`,{title:'Точный план готов'})}catch(error){notify(error?.message||'Не удалось построить план',{title:'Планирование не выполнено'})}finally{setOptimizing(false)}};
  const previewReplan=async(model,basePlan)=>{if(!basePlan)throw new Error('Нет опубликованного плана для пересчёта');return requestPlan(model.orders,model.team,region.id,{planningDate:selectedDayKey})};
  const applyReplan=model=>{
    const event=model?.event;
    if(!shift?.plan||!event?.type){notify('Для изменения нужен сохранённый план смены.',{title:'План не изменён'});return}
    const supported=['NEW_ORDER','ORDER_CANCELLED','VISIT_CANCELLED','ENGINEER_UNAVAILABLE','ENGINEER_REPLACED','CAPACITY_ADDED','MANUAL_ASSIGN','SHIFT_BOUNDARY_CHANGED','SHIFT_EXTENDED','CLIENT_WINDOW_SHIFT'];
    if(!supported.includes(event.type)){notify('Этот сценарий пока нельзя подтвердить дорожной проверкой. Опубликованный план не изменён.',{title:'Публикация заблокирована'});return}
    const newEngineer=model.team?.find(item=>!shift.team.some(old=>String(old.id)===String(item.id)));
    const lastPublished=toMinutes(shift.versions?.at(-1)?.effectiveAt||'00:00');
    const pending={...event,time:event.time||toTime(Math.max(lastPublished,Math.floor(shiftTime.minute))),...(newEngineer?{engineer:newEngineer}:{}),reason:event.reason||'Оперативное изменение диспетчера'};
    setPendingShiftEvent(pending);setScreen('shift');setWorkspacePanelOpen(false);
    notify('Откройте черновик в «Ходе смены»: там выполняется точная проверка дороги и только затем публикация.',{title:'Черновик передан диспетчеру'});
  };
  const rollbackReplan=()=>{if(!replanSnapshot)return;const sameSelectedShift=item=>item.regionId===region.id&&(!item.serviceDate||parseImportedDate(item.serviceDate)?.toLocaleDateString('sv-SE')===selectedDayKey);setOrders(current=>[...current.filter(order=>!sameSelectedShift(order)),...replanSnapshot.orders]);setEngineers(current=>[...current.filter(engineer=>!(engineer.regionId===region.id&&engineer.serviceDate&&parseImportedDate(engineer.serviceDate)?.toLocaleDateString('sv-SE')===selectedDayKey)),...replanSnapshot.team.map(item=>({...item,serviceDate:item.serviceDate||selectedDayKey}))]);setPlan(replanSnapshot.plan);setScheduled(replanSnapshot.scheduled);setReplanSnapshot(null);notify('Предыдущий опубликованный план восстановлен.',{title:'Изменения отменены'})};
  const reassign=async(orderId,engineerId)=>{const order=regionOrders.find(item=>String(item.id)===String(orderId));const engineer=team.find(item=>String(item.id)===String(engineerId));if(!order||!engineer||!shift?.plan)return;setPendingShiftEvent({type:'MANUAL_ASSIGN',orderId,engineerId,time:'00:00',reason:'Ручное назначение диспетчера'});setScreen('shift');setWorkspacePanelOpen(false);notify(`${order.name}: проверьте вставку в маршрут ${engineer.name}.`,{title:'Черновик назначения'})};
  const addEmergency=async()=>{if(!shift?.plan){notify('Сначала постройте и сохраните исходный план.',{title:'Смена не готова'});return}try{const response=await fetch('/api/scenario/event');const payload=await response.json().catch(()=>({}));if(!response.ok||!payload.order)throw new Error(payload.error||'Контрольное событие недоступно');const emergency={...payload.order,id:`${region.id}:event:${Date.now()}`,regionId:region.id,serviceDate:selectedDayKey};setPendingShiftEvent({type:'NEW_ORDER',order:emergency,time:'00:00',reason:'Срочная заявка'});setScreen('shift');setWorkspacePanelOpen(false);notify('Срочная заявка подготовлена. Проверьте маршруты и опубликуйте только после точной проверки.',{title:'Черновик события'})}catch(error){notify(error?.message||'Не удалось создать черновик события',{title:'Событие не добавлено'})}};
  const applyShift=saved=>{if(!saved)return;const sameDay=item=>item.regionId===region.id&&(!item.serviceDate||parseImportedDate(item.serviceDate)?.toLocaleDateString('sv-SE')===selectedDayKey);setShift(saved);setPlan(saved.plan);setScheduled(Boolean(saved.plan));setOrders(current=>[...current.filter(item=>!sameDay(item)),...saved.orders.map(item=>({...item,regionId:region.id,serviceDate:selectedDayKey}))]);setEngineers(current=>[...current.filter(item=>!sameDay(item)),...saved.team.map(item=>({...item,regionId:region.id,serviceDate:selectedDayKey}))]);setSelectedOrder(null);setFocusedRoute(null)};
  const refreshShift=async()=>{const response=await fetch(`/api/shifts?regionId=${encodeURIComponent(region.id)}&date=${selectedDayKey}`);if(response.ok)applyShift(await response.json())};
  const changeStaff=async(member,action,effectiveDate)=>{const response=await fetch(`/api/staff/engineers/${encodeURIComponent(member.id)}/${action}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({regionId:region.id,date:effectiveDate})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'Не удалось изменить состав.');setStaffRoster(current=>current.map(item=>item.id===result.id?result:item));notify(action==='archive'?`${member.name} исключён из постоянного состава с ${effectiveDate}. Текущий план смены не изменён.`:`${member.name} возвращён в состав с ${effectiveDate}.`,{title:'Состав обновлён'});return result};
  const includeStaffInShift=async(member,time,availableFrom)=>{if(!shift?.plan)throw new Error('Сначала сохраните исходный план смены.');if(pendingShiftEvent)throw new Error('Сначала завершите или отмените текущий черновик изменения плана.');const rosterMember=staffRoster.find(item=>String(item.id)===String(member.id));if(!staffActiveOn(rosterMember,selectedDayKey))throw new Error('Бригада не в постоянном составе на выбранную дату. Сначала верните её из архива.');const alreadyInShift=shift.team.find(item=>String(item.id)===String(member.id));if(alreadyInShift&&!/недоступ|снят со смены|unavailable/i.test(alreadyInShift.status||''))throw new Error('Бригада уже включена в план смены.');const existing=await fetch(`/api/shifts/${shift.id}/preview`);if(existing.ok){const draft=await existing.json();if(draft.baseRevision===shift.revision&&['READY','RUNNING'].includes(draft.status))throw new Error('Сначала опубликуйте или отмените сохранённый черновик плана.')}else if(existing.status!==404)throw new Error('Не удалось проверить черновик смены.');const lastTime=shift.versions?.at(-1)?.effectiveAt||'00:00';if((minuteOf(time)??-1)<(minuteOf(lastTime)??0))throw new Error(`Включение не может быть раньше последнего изменения плана (${lastTime}).`);const{rosterPeriods,rosterArchived,...engineer}=rosterMember;setPendingShiftEvent({type:'CAPACITY_ADDED',...(alreadyInShift?{engineerId:member.id}:{engineer:{...engineer,shiftStart:availableFrom||engineer.shiftStart,serviceDate:selectedDayKey,status:'Доступен'}}),time,reason:alreadyInShift?`Бригада возвращена в смену: ${member.name}`:`Бригада включена в смену: ${member.name}`});setStaffDialog('');setShiftInitialTab('event');setWorkspacePanelOpen(false);setScreen('shift');notify(`${member.name}: проверьте расчёт и опубликуйте план, чтобы ${alreadyInShift?'вернуть':'включить'} бригаду в смену.`,{title:'Черновик плана'})};
  const shiftPoint=screen==='shift'&&shift?shiftDisplayAt(shift,Math.floor(shiftTime.minute)):null;
  const crewPlayback=shiftPoint?.plan?{...playbackFrame(shiftPoint,shiftTime.minute,shiftTime.mode),completedFactOrderIds:completedFactOrderIds(shiftPoint,shiftTime.minute),minute:shiftTime.minute,mode:shiftTime.mode,selectedEngineerId:shiftTime.selectedEngineerId,follow:shiftTime.follow,focusToken:shiftTime.focusToken}:null;
  const unreadNotifications=notifications.filter(item=>!item.read).length;
  if(screen==='orders'||screen==='engineers')lastMapScreenRef.current=screen;
  const overlayScreen=OVERLAY_SCREENS.has(screen)?screen:null;
  const overlayPresence=useWorkspacePresence(overlayScreen);
  const planActionVisible=Boolean(regionOrders.length&&((screen==='orders'&&workspacePanelOpen)||screen==='locations'));
  const planActionPresence=useDropdownPresence(planActionVisible,280);
  const planActionMotionClass=planActionPresence.visible?'is-open':planActionVisible?'is-opening':'is-closing';
  const renderedOverlayScreen=overlayPresence.renderedKey;
  const overlayMotionClass=overlayPresence.motionClass;
  const page=useMemo(()=>{
    const selectOrder=order=>{if(order&&screen==='shift')shiftClock.set({follow:false});setSelectedOrder(current=>order&&plan?.unassigned?.some(item=>String(item.orderId)===String(order.id))&&String(current?.id??'')===String(order.id)?null:order||null)};
    const focusRoute=route=>{setSelectedOrder(null);setFocusedRoute(route||null)};
    const openEngineerRoute=route=>{if(!route)return;setSelectedOrder(null);setFocusedRoute(route);setScheduled(true);setWorkspacePanelOpen(true);setScreen('orders')};
    const mapScreen=screen==='orders'||screen==='engineers';
    const retainedMapScreen=mapScreen?screen:lastMapScreenRef.current;
    const shiftRoute=screen==='shift'&&shiftTime.selectedEngineerId?shiftPoint?.plan?.routes?.find(route=>String(route.engineerId)===String(shiftTime.selectedEngineerId)):null;
    const workspaceProps={mode:screen==='shift'?'orders':retainedMapScreen==='engineers'?'engineers':'orders',panelKey:retainedMapScreen,backgroundOnly:Boolean(overlayScreen)||(overlayPresence.present&&!workspacePanelOpen),calendarOverOverlay:Boolean(overlayScreen)||overlayPresence.present,panelOpen:screen==='shift'?false:workspacePanelOpen,onClosePanel:()=>setWorkspacePanelOpen(false),orders:screen==='shift'?(shiftPoint?.orders||regionOrders):regionOrders,team:screen==='shift'?(shiftPoint?.team||team):team,region,plan:screen==='shift'?(shiftPoint?.plan||plan):plan,scheduled:screen==='shift'?Boolean(shiftPoint?.plan):scheduled,setScheduled,view,setView,openPlan:()=>plan?setRecalculateNoticeOpen(true):setPlanOpen(true),onManualAdd:setManualEntryType,pendingManualDraft:pendingShiftEvent,onOpenPendingDraft:()=>{setShiftInitialTab('event');setWorkspacePanelOpen(false);setScreen('shift')},onOrder:selectOrder,onRoute:focusRoute,onOrderHover:setHoveredOrder,onRouteHover:setHoveredRouteId,hoveredOrderId:hoveredOrder?.id,hoveredRouteId,onReassign:reassign,onEmergency:addEmergency,onOpenEngineerRoute:openEngineerRoute,mapping:showMapping,onUploadError:notify,selectedDate,setSelectedDate,uiTheme:theme,geocodeProgress,onClearGeocodeProgress:()=>setGeocodeProgress(null),selectedOrder,activeRoute:screen==='shift'&&!selectedOrder?shiftRoute||null:screen==='shift'?null:focusedRoute,crewPlayback:screen==='shift'?crewPlayback:null,shiftMapTab:screen==='shift'?shiftInitialTab:'',engineerFocusRequest};
    Object.assign(workspaceProps,{onManageRoster:()=>setStaffDialog('manage'),staffDialog,staffRoster,staffShift:shift,onCloseStaffDialog:()=>setStaffDialog(''),onArchiveStaff:changeStaff,onRestoreStaff:changeStaff,onIncludeStaff:includeStaffInShift});
    const openEngineerDetails=engineerId=>{setEngineerFocusRequest({id:String(engineerId),token:Date.now()});setSelectedOrder(null);setWorkspacePanelOpen(true);setScreen('engineers')};
    workspaceProps.onOpenEngineerDetails=openEngineerDetails;
    let overlay=null;
    if(overlayPresence.present&&renderedOverlayScreen==='analytics')overlay=<AnalyticsPage orders={regionOrders} team={team} plan={plan} analyticsDate={analyticsDate} setAnalyticsDate={setAnalyticsDate} motionClass={overlayMotionClass} onUploadData={()=>{setWorkspacePanelOpen(true);setScreen('orders');analyticsUploadRef.current?.click()}} onOpenUnassigned={orderId=>{const first=regionOrders.find(item=>String(item.id)===String(orderId)&&plan?.unassigned?.some(entry=>String(entry.orderId)===String(item.id)))||regionOrders.find(item=>plan?.unassigned?.some(entry=>String(entry.orderId)===String(item.id)))||null;setFocusedRoute(null);setSelectedOrder(first);setScheduled(false);setWorkspacePanelOpen(true);setScreen('orders')}} onOpenRoutes={engineerId=>{const route=plan?.routes?.find(item=>String(item.engineerId)===String(engineerId))||null;if(!route)return;setSelectedOrder(null);setFocusedRoute(null);setScheduled(Boolean(plan));setView('timeline');setWorkspacePanelOpen(true);setScreen('orders');requestAnimationFrame(()=>setFocusedRoute(route))}} onOpenOrder={orderId=>{const order=regionOrders.find(item=>String(item.id)===String(orderId))||null;if(!order)return;setFocusedRoute(null);setSelectedOrder(order);setScheduled(Boolean(plan));setView('timeline');setWorkspacePanelOpen(true);setScreen('orders')}} onPreviewReplan={previewReplan} onApplyReplan={applyReplan} onRollbackReplan={rollbackReplan} onStartLiveReplan={()=>{setWorkspacePanelOpen(true);setScreen('shift')}} onOpenReport={()=>setScreen('report')}/>;
    else if(overlayPresence.present&&renderedOverlayScreen==='shift')overlay=<ShiftWorkspace key="shift" shift={shift} selectedDate={selectedDate} initialTab={shiftInitialTab} onTabChange={setShiftInitialTab} motionClass={overlayMotionClass} pendingEvent={pendingShiftEvent} onClearPending={()=>setPendingShiftEvent(null)} onAddReplacement={engineerId=>{setReplacementFor(engineerId);setManualEntryType('engineers')}} onOpenManualAdd={setManualEntryType} onOpenIncludeCrew={()=>setStaffDialog('include')} onReturnCrew={includeStaffInShift} onApply={applyShift} onRefresh={refreshShift} onOpenOrders={()=>{setWorkspacePanelOpen(true);setScreen('orders')}} selectedOrderId={selectedOrder?.id} onSelectOrder={order=>{setFocusedRoute(null);setSelectedOrder(order)}} actor={profile.name} profile={profile}/>;
    else if(overlayPresence.present&&renderedOverlayScreen==='report')overlay=<ShiftWorkspace key="report" shift={shift?.date===selectedDayKey?shift:null} selectedDate={selectedDate} regionId={region.id} reportDateControl={<DateControl className="report-date-control" value={selectedDate} onChange={setSelectedDate}/>} onReportDateSelect={setSelectedDate} initialTab="report" reportOnly motionClass={overlayMotionClass} onRefresh={refreshShift} onOpenOrders={()=>{setWorkspacePanelOpen(true);setScreen('orders')}} actor={profile.name} profile={profile}/>;
    else if(overlayPresence.present&&(renderedOverlayScreen==='planning'||renderedOverlayScreen==='constraints'))overlay=<PreferencesPage key={renderedOverlayScreen} section={renderedOverlayScreen} policy={routePolicy} onPolicySave={setRoutePolicy} onToast={notify} orders={regionOrders} motionClass={overlayMotionClass} onClose={()=>{setWorkspacePanelOpen(false);setScreen(lastMapScreenRef.current)}}/>;
    else if(overlayPresence.present&&renderedOverlayScreen==='locations')overlay=<LocationsPage regions={regions} region={region} onSelect={setRegion} onOpenOrders={()=>{setWorkspacePanelOpen(true);setScreen('orders')}} onClose={()=>{setWorkspacePanelOpen(false);setScreen(lastMapScreenRef.current)}} motionClass={overlayMotionClass}/>;
    return <><OperationalMapWorkspace {...workspaceProps}/>{overlay}{assistantOpen?createPortal(<ShiftWorkspace key="assistant" shift={shift?.date===selectedDayKey?shift:null} selectedDate={selectedDate} initialTab="report" reportOnly assistantOnly onClose={()=>setAssistantOpen(false)} onOpenOrders={()=>{setWorkspacePanelOpen(true);setScreen('orders')}} actor={profile.name} profile={profile}/>,appShellRef.current||document.body):null}{manualEntryType?<ManualEntryModal type={manualEntryType} zones={[...new Set([...regionOrders,...team].map(item=>orderZone(item)).filter(Boolean))]} region={region} date={selectedDate} existingIds={(manualEntryType==='orders'?regionOrders:team).map(item=>item.sourceId||String(item.id).split(':').at(-1))} onClose={()=>{setManualEntryType('');setReplacementFor('')}} onSave={saveManualEntry}/>:null}{pendingImport?<ImportDecisionModal summary={pendingImport.summary} onCancel={()=>setPendingImport(null)} onChoose={mode=>{const request=pendingImport;setPendingImport(null);importRows(request.payload,request.reviewSnapshot,mode)}}/>:null}</>;
  },[screen,assistantOpen,workspacePanelOpen,regionOrders,team,plan,scheduled,view,selectedDate,analyticsDate,theme,settings,routePolicy,region,regions,geocodeProgress,selectedOrder,focusedRoute,hoveredOrder,hoveredRouteId,overlayScreen,overlayPresence.present,renderedOverlayScreen,overlayMotionClass,replanSnapshot,manualEntryType,pendingImport,shift,pendingShiftEvent,shiftPoint,crewPlayback,profile,replacementFor,shiftInitialTab,engineerFocusRequest,staffDialog,staffRoster]);
  const hasMapOverlay=overlayPresence.present;
  useLayoutEffect(()=>{
    const previousExpanded=previousExpandedRef.current;
    previousExpandedRef.current=expanded;
    const running=railAnimationsRef.current.some(animation=>animation.playState==='running');
    if(previousExpanded===expanded||!hasMapOverlay)return;
    const shell=appShellRef.current;
    const sidebar=shell?.querySelector('.sidebar');
    const overlay=shell?.querySelector('.map-overlay-page');
    if(!shell||!sidebar||!overlay)return;
    const shellStyle=getComputedStyle(shell);
    const expandedSidebarWidth=parseFloat(shellStyle.getPropertyValue('--sidebar-expanded-width'))||220;
    const expandedOverlayLeft=parseFloat(shellStyle.getPropertyValue('--sidebar-floating-left'))||232;
    const collapsedSidebarWidth=72;
    const collapsedOverlayLeft=84;
    const liveSidebarWidth=sidebar.getBoundingClientRect().width;
    const liveOverlayLeft=overlay.getBoundingClientRect().left;
    const fromSidebarWidth=running?liveSidebarWidth:(previousExpanded?expandedSidebarWidth:collapsedSidebarWidth);
    const fromOverlayLeft=running?liveOverlayLeft:(previousExpanded?expandedOverlayLeft:collapsedOverlayLeft);
    railAnimationsRef.current.forEach(animation=>animation.cancel());
    const timing={duration:420,easing:'cubic-bezier(.4,0,.2,1)',fill:'both'};
    const animations=[
      sidebar.animate([{width:`${fromSidebarWidth}px`},{width:`${expanded?expandedSidebarWidth:collapsedSidebarWidth}px`}],timing),
      overlay.animate([{left:`${fromOverlayLeft}px`},{left:`${expanded?expandedOverlayLeft:collapsedOverlayLeft}px`}],timing),
    ];
    const sharedStart=document.timeline.currentTime;
    animations.forEach(animation=>{animation.startTime=sharedStart});
    railAnimationsRef.current=animations;
    Promise.allSettled(animations.map(animation=>animation.finished)).then(()=>{
      if(railAnimationsRef.current!==animations)return;
      animations.forEach(animation=>animation.cancel());
      railAnimationsRef.current=[];
    });
  },[expanded,hasMapOverlay,importSession?.mode]);
  const toastPresentation=toast?notificationPresentation(toast):null;
  const navigateScreen=(next,{togglePanel=false}={})=>{if(next==='assistant'){setAssistantOpen(open=>!open);setHelpOpen(false);return}if(importSession?.mode==='review')closeReview();if(next==='engineers')setFocusedRoute(null);if(OVERLAY_SCREENS.has(next)&&screen===next){setWorkspacePanelOpen(false);setScreen(lastMapScreenRef.current)}else{if(next==='orders'||next==='engineers')setWorkspacePanelOpen(open=>togglePanel&&screen===next?!open:true);setScreen(next)}setSettingsOpen(false);setNotificationsOpen(false);setHelpOpen(false)};
  return <div ref={appShellRef} className={`app-shell ${theme==='dark'?'dark':''} ${expanded?'sidebar-expanded':''} ${hasMapOverlay?'has-map-overlay':''} ${overlayScreen?`overlay-${overlayScreen}`:''}`} style={{'--accent':ACCENT,'--operational-panel-left':expanded?'232px':'84px'}}><input className="workspace-file-input" ref={analyticsUploadRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={async event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;try{showMapping(await parseImportFile(file))}catch(error){notify(error?.message||'Не удалось прочитать файл')}}}/><Sidebar expanded={expanded} setExpanded={setExpanded} screen={screen} assistantOpen={assistantOpen} workspacePanelOpen={workspacePanelOpen} setScreen={navigateScreen} orderCount={regionOrders.length} theme={theme} setTheme={setTheme} profile={profile} onProfile={()=>{setSettingsOpen(false);setNotificationsOpen(false);setProfileOpen(true)}} helpOpen={helpOpen} onHelp={()=>{setProfileOpen(false);setSettingsOpen(false);setNotificationsOpen(false);setSelectedOrder(null);setAssistantOpen(false);setHelpOpen(open=>!open)}} settingsOpen={settingsOpen} onSettings={()=>{setProfileOpen(false);setNotificationsOpen(false);setSettingsOpen(open=>!open)}} region={region} notificationsOpen={notificationsOpen} onNotifications={toggleNotifications} unreadNotifications={unreadNotifications} hasReviewData={Boolean(reviewSession)} reviewOpen={Boolean(importSession?.mode==='review'&&!reviewClosing)} onOpenReview={openReview}/>{page}{planActionPresence.present?<button type="button" className={`map-plan-action ${planActionMotionClass}`} onClick={()=>plan?setRecalculateNoticeOpen(true):setPlanOpen(true)} aria-hidden={!planActionPresence.visible} tabIndex={planActionPresence.visible?0:-1}><WandSparkles/><span>{plan?'Пересчитать план':'Построить план'}</span>{plan?<em className="map-plan-development">В разработке</em>:null}</button>:null}<NotificationCenter items={notifications} open={notificationsOpen} expanded={expanded} onClose={()=>setNotificationsOpen(false)} onClear={clearNotificationGroup} onRead={markNotificationRead}/>{settingsOpen?<SettingsModal settings={settings} setSettings={setSettings} region={region} regions={regions} setRegion={setRegion} onToast={notify} onClose={()=>setSettingsOpen(false)}/>:null}{helpOpen?<HelpCenter profile={profile} onClose={()=>setHelpOpen(false)}/>:null}{profileOpen?<ProfileModal profile={profile} onClose={()=>{setProfileOpen(false)}} onSave={next=>{setProfile(next);setProfileOpen(false);notify('Профиль сохранён')}}/>:null}{importSession?<MemoImportWorkspace session={importSession} region={importSession.reviewRegion||region} closing={reviewClosing} onCancel={stableImportCancel} onImport={stableImportRows}/>:null}{recalculateNoticeOpen?<DevelopmentModal onClose={()=>setRecalculateNoticeOpen(false)}/>:null}{planOpen?<PlanDrawer orders={regionOrders} team={team} policy={routePolicy} onClose={()=>setPlanOpen(false)} onOptimize={optimize} optimizing={optimizing} selectedDate={selectedDate}/>:null}{toast?<div className={`toast ${toast.closing?'is-closing':''}`} style={{'--toast-exit-x':`${(toast.exitDirection||1)*42}px`}} data-notification-id={toast.id} data-notification-kind={toastPresentation.kind} onPointerDown={event=>{if(event.target.closest('button'))return;event.currentTarget.setPointerCapture?.(event.pointerId);toastSwipeRef.current={id:toast.id,x:event.clientX,y:event.clientY}}} onPointerMove={event=>{const swipe=toastSwipeRef.current;if(!swipe||swipe.id!==toast.id)return;const dx=event.clientX-swipe.x;if(Math.abs(dx)>Math.abs(event.clientY-swipe.y))event.currentTarget.style.transform=`translateX(${dx}px)`}} onPointerUp={event=>{const swipe=toastSwipeRef.current;toastSwipeRef.current=null;if(!swipe)return;const dx=event.clientX-swipe.x;event.currentTarget.style.transform='';if(Math.abs(dx)>=72)dismissToastAsRead(toast.id,dx<0?-1:1)}} onPointerCancel={event=>{toastSwipeRef.current=null;event.currentTarget.style.transform=''}}><span className="toast-artwork"><NotificationArtwork kind={toastPresentation.kind}/></span><div className="toast-copy"><div className="toast-heading"><b>{toastPresentation.title}</b><time>{toast.time}</time></div><p>{toast.message}</p><button type="button" className="toast-mark-read" onClick={()=>dismissToastAsRead(toast.id,1)}><Check/><span>Прочитано</span></button></div></div>:null}</div>
}
