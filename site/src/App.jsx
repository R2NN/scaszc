import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  BarChart3, BriefcaseBusiness, Building2, CalendarDays, Car, Check,
  ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  CircleHelp, Clock3, Download, FileSpreadsheet, Filter, Gauge,
  HardHat, List, Map, MapPin, MoreHorizontal, PackageCheck, Plus, RotateCcw,
  Route, Search, Settings2, SlidersHorizontal, Sparkles, Maximize2,
  MessageSquare, MessageSquareOff, Layers3, LocateFixed, Box,
  WandSparkles, X, ZoomIn, ZoomOut, Moon, Sun, House, Newspaper,
  ArrowRight, PlayCircle, GraduationCap, Rocket, ShieldCheck
  , AlertTriangle, Bus, Footprints, Wrench, Users, CircleAlert, RefreshCw,
  Database, ServerCog, Save, Activity, LockKeyhole, MapPinned, UserRoundPlus,
  Bell, CheckCheck
} from 'lucide-react';
import './styles.css';
import './calendar.css';
import './import-engineers.css';
import { ImportWorkspace, parseImportFile } from './ImportWorkspace.jsx';
import { useDropdownPresence } from './useDropdownPresence.js';
import { displayOrderName, workPointType } from './workTypes.js';
import { ZONE_LABELS, normalizeTerritoryKey, zoneBoundaryName, zoneCode } from './territoryAliases.js';
import { AnalyticsWorkspace } from './AnalyticsWorkspace.jsx';
import { BusinessSelect } from './BusinessSelect.jsx';
import { buildDynamicReplan } from './dynamicReplanner.js';

maplibregl.setWorkerUrl(mapLibreWorkerUrl);
const MAP_WORKER_COUNT=Math.min(4,Math.max(2,Math.ceil((navigator.hardwareConcurrency||4)/2)));
maplibregl.setWorkerCount(MAP_WORKER_COUNT);
maplibregl.prewarm();

const ACCENT = '#FFD21F';
const DEFAULT_MAP_CENTER = [55.7558, 37.6173];
const DEFAULT_MAP_ZOOM = 10;
const MAP_MIN_ZOOM = 2;
const MAP_MAX_ZOOM = 19;
const ROAD_LAYER_PATTERN=/(?:motorway|trunk|primary|secondary|tertiary|minor|service|track|link|road_pier)/;
const WORK_POINT_TYPES={emergency:{label:'Авария',color:'#F0523D'},connection:{label:'Подключение',color:'#FFD21F'},service:{label:'Обслуживание',color:'#4C8DFF'},upgrade:{label:'Оборудование',color:'#9B6BFF'},other:{label:'Прочие работы',color:'#35B56A'}};
const MAP_THEMES = {
  day:{name:'Дневная',land:'#f3f7ef',water:'#96d4f5',park:'#d9efc5',wood:'#add7a5',grass:'#e4f2d8',residential:'#fff9e9',commercial:'#fff1df',industrial:'#f2eee2',label:'#1e4863',halo:'#ffffff',boundary:'#7198b3'},
  night:{name:'Ночная',land:'#172522',water:'#162f43',park:'#203b2e',wood:'#315b43',grass:'#294839',residential:'#25302d',commercial:'#332d2a',industrial:'#303332',label:'#d6e5dd',halo:'#14201e',boundary:'#6b827b'},
  muted:{name:'Приглушённая',land:'#eef2e8',water:'#c9dfee',park:'#dce9ce',wood:'#91ae86',grass:'#e0ead7',residential:'#f2f2eb',commercial:'#f3eee8',industrial:'#ecece7',label:'#52655f',halo:'#fafbf7',boundary:'#a6b3ad'},
  gray:{name:'Оттенки серого',land:'#edf0ef',water:'#d8e0e2',park:'#e2e7e3',wood:'#aeb9b2',grass:'#e7ebe8',residential:'#f3f4f3',commercial:'#eeeeed',industrial:'#e7e8e7',label:'#4f5a5d',halo:'#fff',boundary:'#9ca8aa'},
};
const REGIONS = [
  {id:'moscow',code:'МК',name:'Москва',office:'улица 8 Марта, 10',timezone:'Europe/Moscow',coords:[55.7558,37.6173]},
];
const ENGINEERS = [];
const navItems = [
  ['orders', BriefcaseBusiness, 'Заявки'], ['objects', Building2, 'Объекты'],
  ['routes', Route, 'Маршруты'], ['engineers', HardHat, 'Инженеры'],
  ['analytics', BarChart3, 'Аналитика'], ['preferences', SlidersHorizontal, 'Ограничения'],
];
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
const territoryBoundaryQueries=value=>{const selected=territorySelection(value);if(!selected.name)return[];if(selected.kind==='district'){const district=districtBoundaryName(selected.name);return[`${district} район, Москва, Россия`,`район ${district}, Москва, Россия`,`${district}, Москва, Россия`,`городской округ ${district}, Московская область, Россия`,`${district}, Московская область, Россия`,`${district}, Россия`]}const boundary=zoneBoundaryName(selected.name);return boundary?[`${boundary}, Москва, Россия`]:[]};
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
const unassignedExplanation=item=>{
  if(item?.reasonCode==='NO_EXACT_FEASIBLE_INSERTION_IN_CURRENT_ROUTES')return{
    title:'Не поместилась в текущий план',
    summary:'Алгоритм не нашёл для заявки свободное место в уже рассчитанных маршрутах, которое одновременно соблюдает клиентское окно, длительность работы и смену инженера.',
    action:'Что делать: запустить полный пересчёт дня, расширить клиентское окно или добавить доступную бригаду.',
  };
  return{title:'Нужно решение диспетчера',summary:item?.reason||'Заявку не удалось безопасно включить в проверенный план.',action:'Откройте полный пересчёт, чтобы алгоритм заново проверил все маршруты.'};
};
async function requestPlan(orders,team,regionId,options={}){
  const response=await fetch('/api/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orders,engineers:team,regionId,options})});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(payload.error||'Точный планировщик временно недоступен');error.code=payload.code||'';throw error}
  if(payload.status!=='EXACT_VALID'||payload.publicationAllowed!==true||payload.validation?.status!=='VALID')throw new Error('Алгоритм не разрешил публикацию непроверенного плана');
  return payload;
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
    const cacheId=geocodeCacheId(order.address);
    if(cache[cacheId])resolved.set(String(order.id),{...cache[cacheId],cached:true});
    else pending.push({id:order.id,address:order.address,district:order.district||orderDistrict(order)});
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
function ProfileAvatar({profile,className=''}){return profile.avatar?<img className={`profile-avatar ${className}`} src={`/avatars/${profile.avatar}.png`} alt=""/>:<span className={`profile-initials ${className}`}>{profile.name.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase()||'ЮК'}</span>}
function Sidebar({expanded,setExpanded,screen,setScreen,orderCount,theme,setTheme,profile,onProfile,helpOpen,onHelp,settingsOpen,onSettings,region,setRegion,notificationsOpen,onNotifications,unreadNotifications=0}){const[logoRunning,setLogoRunning]=useState(false);const[regionsOpen,setRegionsOpen]=useState(false);const[sidebarAnimating,setSidebarAnimating]=useState(false);const[suppressSidebarTooltips,setSuppressSidebarTooltips]=useState(false);const workspaceRef=useRef(null),sidebarAnimationTimerRef=useRef(null),tooltipSuppressTimerRef=useRef(null);const regionsPresence=useDropdownPresence(regionsOpen);useEffect(()=>{if(!regionsOpen)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='pointerdown'&&!workspaceRef.current?.contains(event.target)))setRegionsOpen(false)};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close)}},[regionsOpen]);useEffect(()=>()=>{clearTimeout(sidebarAnimationTimerRef.current);clearTimeout(tooltipSuppressTimerRef.current)},[]);const beginSidebarTransition=()=>{setSidebarAnimating(true);setSuppressSidebarTooltips(true)};const toggleSidebar=event=>{event.currentTarget.blur();setSidebarAnimating(true);setSuppressSidebarTooltips(true);setExpanded(value=>!value);clearTimeout(sidebarAnimationTimerRef.current);clearTimeout(tooltipSuppressTimerRef.current);sidebarAnimationTimerRef.current=setTimeout(()=>setSidebarAnimating(false),560);tooltipSuppressTimerRef.current=setTimeout(()=>setSuppressSidebarTooltips(false),1400)};return <aside className={`sidebar ${expanded?'expanded':''} ${notificationsOpen?'notifications-active':''} ${sidebarAnimating?'is-transitioning':''} ${suppressSidebarTooltips?'suppress-tooltips':''}`}>
  <button className="brand-row brand-home" onPointerEnter={()=>setLogoRunning(true)} onClick={()=>setScreen('routes')} aria-label="BeeGo! — на главную"><Brand staticMark running={logoRunning} onAnimationEnd={()=>setLogoRunning(false)}/><span className="brand-wordmark"><b>Bee</b><strong>Go!</strong></span></button>
  <div className="workspace-picker" ref={workspaceRef}><button className="workspace" onClick={()=>setRegionsOpen(open=>!open)} aria-expanded={regionsOpen}><span>{region.code}</span><strong>{region.name}</strong><ChevronDown size={15}/></button>{regionsPresence.present?<div className={`workspace-menu dropdown-transition ${regionsPresence.visible?'is-open':'is-closing'}`}>{REGIONS.map(item=><button key={item.id} className={item.id===region.id?'selected':''} onClick={()=>{setRegion(item);setRegionsOpen(false)}}><span>{item.code}</span><div><b>{item.name}</b><small>{item.office}</small></div>{item.id===region.id?<Check/>:null}</button>)}</div>:null}</div>
  <nav>{navItems.map(([id,Icon,label])=><button key={id} className={screen===id&&!notificationsOpen?'active':''} onClick={()=>setScreen(id)} aria-label={label} data-tooltip={label}><Icon/><em>{label}</em>{id==='orders'&&orderCount?<small>{orderCount}</small>:null}</button>)}<button className={notificationsOpen?'active sidebar-notification-button':''} onClick={onNotifications} aria-label="Уведомления" data-tooltip="Уведомления"><Bell/><em>Уведомления</em>{unreadNotifications?<small className="notification-nav-badge">{unreadNotifications>99?'99+':unreadNotifications}</small>:null}</button></nav>
  <div className="sidebar-bottom"><button className={helpOpen?'active':''} onClick={onHelp} aria-label="Помощь" data-tooltip="Помощь"><CircleHelp/><em>Помощь</em></button><button className={settingsOpen?'active':''} onClick={onSettings} aria-label={settingsOpen?'Закрыть настройки':'Открыть настройки'} data-tooltip="Настройки"><Settings2/><em>Настройки</em></button><button className="profile-button" onClick={onProfile} aria-label="Открыть профиль" data-tooltip="Профиль"><ProfileAvatar profile={profile}/><span className="profile-copy"><em>Профиль</em><small>{profile.name}</small></span></button><label className="theme-switch" data-tooltip={theme==='dark'?'Светлая тема':'Тёмная тема'}><input type="checkbox" role="switch" checked={theme==='dark'} onChange={()=>setTheme(value=>value==='dark'?'light':'dark')} aria-label={theme==='dark'?'Включить светлую тему':'Включить тёмную тему'}/><span className="theme-switch-track" aria-hidden="true"><span className="theme-switch-thumb"><Sun className="theme-sun"/><Moon className="theme-moon"/></span></span><em>{theme==='dark'?'Тёмная тема':'Светлая тема'}</em></label><button onPointerDown={beginSidebarTransition} onClick={toggleSidebar} aria-label={expanded?'Свернуть меню':'Развернуть меню'} data-tooltip={expanded?'Свернуть меню':'Развернуть меню'}>{expanded?<ChevronsLeft/>:<ChevronsRight/>}<em>{expanded?'Свернуть меню':'Развернуть меню'}</em></button></div>
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
      <div className="calendar-grid">{days.map(date=>{const outside=date.getMonth()!==visibleMonth.getMonth();const future=isAfterDay(date,today);return <button type="button" key={date.toISOString()} disabled={future} className={`${outside?'outside ':''}${future?'future ':''}${sameDay(date,today)?'today ':''}${sameDay(date,value)?'selected':''}`} onClick={()=>select(date)} aria-label={`${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]} ${date.getFullYear()}${future?', недоступно':''}`}>{date.getDate()}</button>})}</div>
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
  if(/авари|ошиб|не выполн/.test(text))return <AlertTriangle/>;
  if(/импорт|загруж|адрес/.test(text))return <FileSpreadsheet/>;
  if(/план|маршрут|распредел/.test(text))return <Route/>;
  return <Check/>;
}
function NotificationCenter({items=[],open=false,expanded=false,onClose=()=>{},onClear=()=>{}}){
  const[filter,setFilter]=useState('all');
  const visible=filter==='unread'?items.filter(item=>!item.read):items;
  if(!open)return null;
  return <div className={`notification-center-layer ${expanded?'sidebar-wide':''}`}><button className="notification-center-scrim" type="button" onClick={onClose} aria-label="Закрыть уведомления"/><aside className="notification-center" role="dialog" aria-label="Уведомления"><header><div><button type="button" onClick={onClose} aria-label="Закрыть"><X/></button><h2>Уведомления</h2></div>{items.length?<button type="button" className="notification-clear" onClick={onClear}><CheckCheck/>Очистить</button>:null}</header><div className="notification-tabs"><button type="button" className={filter==='unread'?'active':''} onClick={()=>setFilter('unread')}>Непрочитанные</button><button type="button" className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>Все</button></div><div className="notification-center-list">{visible.length?visible.map(item=><article className={item.read?'':'unread'} key={item.id}><span><NotificationGlyph item={item}/></span><div><b>{item.title||'BeeGo!'}</b><p>{item.message}</p><small>{item.time}</small></div></article>):<div className="notification-center-empty"><img src="/notification-empty.svg" alt="Пустой центр уведомлений"/><b>{filter==='unread'?'Новых уведомлений нет':'Уведомлений пока нет'}</b><p>Здесь появятся результаты импорта, расчёта маршрутов и важные события смены.</p></div>}</div></aside></div>;
}
function Topbar({selectedDate,setSelectedDate}){
  return <header className="topbar minimal-topbar"><DateControl value={selectedDate} onChange={setSelectedDate}/></header>;
}
function Metrics({orders,plan}){const metrics=plan?.metrics;return <div className="metrics"><span title="Маршруты"><Route/> {metrics?.activeEngineers||0}</span><span title="Распределено"><BriefcaseBusiness/> {metrics?.assigned||0}</span><span title="Пробег"><MapPin/> {metrics?`${metrics.distanceKm} км`:'0 км'}</span><span title="В дороге"><Clock3/> {metrics?durationLabel(metrics.travelMinutes):'0 мин'}</span><span title="Не назначено"><PackageCheck/> {metrics?.unassigned??orders.length}</span></div>}
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

function MapControls({map,positions,popupsEnabled,onTogglePopups,onToggleThemes,themesOpen,onLocate,onResetOrientation,locating,locationVisible,is3D,onToggle3D}){
  const run=(action)=>(event)=>{event.preventDefault();event.stopPropagation();action()};
  const smoothZoom=(delta)=>{if(map)map.easeTo({zoom:Math.max(MAP_MIN_ZOOM,Math.min(MAP_MAX_ZOOM,map.getZoom()+delta)),duration:520,easing:t=>1-(1-t)**3,essential:true})};
  const stopEvents={onMouseDown:event=>event.stopPropagation(),onDoubleClick:event=>event.stopPropagation(),onWheel:event=>event.stopPropagation()};
  const compassRef=useRef(null);
  useEffect(()=>{
    if(!map)return undefined;
    const syncCompass=()=>{if(compassRef.current)compassRef.current.style.transform=`rotate(${-map.getBearing()}deg)`};
    syncCompass();
    map.on('rotate',syncCompass);
    return()=>map.off('rotate',syncCompass);
  },[map]);
  return <>
    <div className="map-control-stack" role="toolbar" aria-label="Управление картой" {...stopEvents}>
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
    </div>
    <button type="button" className={`map-layers-control ${themesOpen?'enabled':''}`} onClick={run(onToggleThemes)} aria-pressed={themesOpen} aria-expanded={themesOpen} aria-label={themesOpen?'Закрыть выбор темы карты':'Выбрать тему карты'} data-tooltip={themesOpen?'Закрыть темы карты':'Выбрать тему карты'} {...stopEvents}><Layers3/></button>
  </>
}

function MapThemePicker({value,onChange,onClose,className=''}){
  return <section className={`map-theme-picker ${className}`.trim()} role="dialog" aria-label="Тема карты">
    <header><h3>Тема карты</h3><button type="button" onClick={onClose} aria-label="Закрыть" data-tooltip="Закрыть"><X/></button></header>
    <div>{Object.entries(MAP_THEMES).map(([id,theme])=><button type="button" key={id} className={value===id?'selected':''} onClick={()=>{onChange(id);onClose()}}><span className={`theme-preview theme-${id}`} aria-hidden="true"><img src={id==='night'?'/map-theme-night.jpg':'/map-theme-day.jpg'} alt=""/></span><strong>{theme.name}</strong><i>{value===id?<Check/>:null}</i></button>)}</div>
  </section>;
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
  const[open,setOpen]=useState(false),rootRef=useRef(null),presence=useDropdownPresence(open,190);
  useEffect(()=>{if(!open)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='pointerdown'&&!rootRef.current?.contains(event.target)))setOpen(false)};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close)}},[open]);
  const choose=next=>{onChange(next);setOpen(false)};
  const selected=territorySelection(value),selectedItem=(selected.kind==='zone'?zones:districts).find(item=>item.name===selected.name);
  return <div className="district-filter" ref={rootRef}><button type="button" className={value?'active':''} onClick={()=>setOpen(current=>!current)} aria-haspopup="listbox" aria-expanded={open}><MapPinned/><span><small>{selected.kind==='zone'?'Зона из таблицы':selected.kind==='district'?'Район Москвы':'Территория'}</small><b>{selected.name||'Все районы и зоны'}</b></span><em>{value?selectedItem?.count||0:total}</em><ChevronDown/></button>{presence.present?<div className={`district-filter-menu dropdown-transition ${presence.visible?'is-open':'is-closing'}`} role="listbox" aria-label="Фильтр по территориям"><button type="button" className={!value?'selected':''} role="option" aria-selected={!value} onClick={()=>choose('')}><span className="district-all-icon"><Map/></span><div><b>Все районы и зоны</b><small>Показать все заявки</small></div><em>{total}</em>{!value?<Check/>:null}</button>{zones.length?<><div className="district-filter-section-title"><Layers3/>Зоны из таблицы</div>{zones.map(item=>{const key=`zone:${item.name}`;return <button type="button" className={value===key?'selected':''} role="option" aria-selected={value===key} key={key} onClick={()=>choose(key)}><span className="district-zone-icon"><Layers3/></span><div><b>{item.name}</b><small>{item.count} {item.count===1?'заявка':'заявок'}</small></div><em>{item.count}</em>{value===key?<Check/>:null}</button>})}</>:null}{districts.length?<><div className="district-filter-section-title"><MapPinned/>Районы Москвы</div>{districts.map(item=>{const key=`district:${item.name}`;return <button type="button" className={value===key?'selected':''} role="option" aria-selected={value===key} key={key} onClick={()=>choose(key)}><span className="district-dot"/><div><b>{item.name}</b><small>{item.count} {item.count===1?'заявка':'заявок'}</small></div><em>{item.count}</em>{value===key?<Check/>:null}</button>})}</>:null}</div>:null}</div>;
}

function MapCanvas({orders,team=[],scheduled,onOrder,onRoute,uiTheme,geocodeProgress,onClearGeocodeProgress,selectedOrder,selectedTerritory,routes=[],activeRoute=null}){
  const[popupsEnabled,setPopupsEnabled]=useState(true),[map,setMap]=useState(null),[mapTheme,setMapTheme]=useState(uiTheme==='dark'?'night':'day'),[themePickerOpen,setThemePickerOpen]=useState(false),[is3D,setIs3D]=useState(false),[locating,setLocating]=useState(false),[locationVisible,setLocationVisible]=useState(false),[locationMessage,setLocationMessage]=useState(''),[locationPrompt,setLocationPrompt]=useState(null),[selectedStart,setSelectedStart]=useState(null);
  const containerRef=useRef(null),markersRef=useRef([]),startMarkersRef=useRef([]),locationMarkerRef=useRef(null),themePickerRef=useRef(null),districtRequestRef=useRef(null);
  const[districtBoundaryStatus,setDistrictBoundaryStatus]=useState('');
  const themePickerPresence=useDropdownPresence(themePickerOpen,200);
  const geocodedOrders=useMemo(()=>orders.filter(order=>Array.isArray(order.coords)&&order.coords.length===2&&order.coords.every(Number.isFinite)),[orders]);
  const mapOrders=geocodedOrders;
  const ungeocodedCount=orders.length-geocodedOrders.length;
  const positions=useMemo(()=>mapOrders.map(order=>order.coords),[mapOrders]);
  const signature=positions.map(([lat,lon])=>`${lat}:${lon}`).join('|');
  const activeOrderIds=useMemo(()=>new Set((activeRoute?.assignments||[]).map(item=>String(item.orderId))),[activeRoute]);
  const assignmentMeta=useMemo(()=>{const result=new globalThis.Map();routes.forEach(route=>route.assignments?.forEach((assignment,index)=>result.set(String(assignment.orderId),{route,assignment,position:assignment.position||index+1})));return result},[routes]);
  const routeStarts=useMemo(()=>{
    if(!scheduled)return[];
    const visibleRoutes=activeRoute?[activeRoute]:routes.filter(route=>route.assignments?.length);
    const starts=visibleRoutes.map(route=>{const engineer=team.find(item=>String(item.id)===String(route.engineerId));return engineer&&Array.isArray(engineer.startCoords)&&engineer.startCoords.length===2?{route,engineer,coords:engineer.startCoords}:null}).filter(Boolean);
    if(activeRoute)return starts.map(item=>({...item,entries:[item]}));
    const grouped=new globalThis.Map();
    starts.forEach(item=>{const key=item.coords.join(':');const current=grouped.get(key)||{...item,names:[],entries:[]};current.names.push(item.engineer.name);current.entries.push(item);grouped.set(key,current)});
    return[...grouped.values()];
  },[scheduled,routes,activeRoute,team]);
  const routeGeoJson=useMemo(()=>{
    if(!scheduled)return{type:'FeatureCollection',features:[]};
    const visibleRoutes=activeRoute?.assignments?.length?[activeRoute]:routes.filter(route=>route.assignments?.length);
    return{type:'FeatureCollection',features:visibleRoutes.flatMap((route,routeIndex)=>route.assignments.flatMap((assignment,legIndex)=>{
      const geometry=(assignment.geometry||[]).filter(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite));
      if(geometry.length<2)return[];
      return[{type:'Feature',properties:{engineerId:route.engineerId,active:Boolean(activeRoute),routeIndex,legIndex},geometry:{type:'LineString',coordinates:geometry.map(([lat,lon])=>[lon,lat])}}];
    }))};
  },[scheduled,routes,activeRoute]);

  useEffect(()=>{setMapTheme(uiTheme==='dark'?'night':'day')},[uiTheme]);
  useEffect(()=>{if(selectedOrder)setSelectedStart(null)},[selectedOrder]);
  useEffect(()=>{if(!themePickerOpen)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='pointerdown'&&!themePickerRef.current?.contains(event.target)&&!event.target.closest?.('.map-layers-control')))setThemePickerOpen(false)};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close)}},[themePickerOpen]);

  useEffect(()=>{
    if(!containerRef.current)return undefined;
    const host=containerRef.current;
    host.dataset.mapTheme=mapTheme;
    const instance=new maplibregl.Map({
      container:host,
      style:'https://tiles.openfreemap.org/styles/bright',
      center:[DEFAULT_MAP_CENTER[1],DEFAULT_MAP_CENTER[0]],
      zoom:DEFAULT_MAP_ZOOM,
      minZoom:MAP_MIN_ZOOM,
      maxZoom:MAP_MAX_ZOOM,
      renderWorldCopies:true,
      attributionControl:false,
      fadeDuration:110,
      maxTileCacheZoomLevels:6,
      refreshExpiredTiles:false,
      cancelPendingTileRequestsWhileZooming:false,
      dragRotate:true,
      pitchWithRotate:true,
      aroundCenter:false,
      rotateSpeed:.34,
      pitchSpeed:-.24,
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
    const updateMarkerScale=()=>markersRef.current.forEach(({element})=>element?.style.setProperty('--marker-scale',String(markerScale())));
    const sync=()=>{
      markersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      markersRef.current=mapOrders.map((order,i)=>{
        const element=document.createElement('button');
        element.type='button';
        const pointType=workPointType(order);
        const isActive=activeOrderIds.has(String(order.id));
        const meta=assignmentMeta.get(String(order.id)),isUnassigned=scheduled&&!meta;
        element.className=`map-order-marker point-type-${pointType}${isUnassigned?' is-unassigned':''}${activeRoute?(isActive?' is-route-active':isUnassigned?'':' is-route-muted'):''}`;
        element.setAttribute('aria-label',`${isUnassigned?'Не вошла в план: ':scheduled?`Остановка ${meta?.position||i+1}: `:''}${displayOrderName(order)}`);
        const pin=document.createElement('span');
        pin.className=`map-order-pin ${scheduled?'is-scheduled':''}`;
        pin.textContent=scheduled?(isUnassigned?'!':String(meta?.position||i+1)):'';
        element.append(pin);
        element.addEventListener('click',()=>onOrder(order));
        let popup=null;
        if(popupsEnabled){
          const content=document.createElement('div'),title=document.createElement('b'),address=document.createElement('span');
          title.textContent=`${isUnassigned?'Не вошла в план · ':scheduled?`${meta?.position||i+1}. `:''}${displayOrderName(order)}`;
          address.textContent=order.address;
          content.className='map-popup-content';
          content.append(title,address);
          popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:22,className:'order-popup'}).setDOMContent(content);
          element.addEventListener('mouseenter',()=>popup.setLngLat([order.coords[1],order.coords[0]]).addTo(map));
          element.addEventListener('mouseleave',()=>popup.remove());
        }
        const marker=new maplibregl.Marker({element,anchor:'center'}).setLngLat([order.coords[1],order.coords[0]]).addTo(map);
        return{marker,popup,element,orderId:String(order.id)};
      });
      startMarkersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      startMarkersRef.current=routeStarts.map(item=>{
        const element=document.createElement('button');element.type='button';element.className='route-start-marker';element.setAttribute('aria-label',`Открыть стартовую точку: ${item.names?.length>1?`${item.names.length} бригад`:item.engineer.name}`);element.innerHTML='<span>С</span>';
        const content=document.createElement('div'),title=document.createElement('b'),address=document.createElement('span');content.className='map-popup-content';title.textContent=item.names?.length>1?`Общая точка старта · ${item.names.length} бригад`:`Старт · ${item.engineer.name}`;address.textContent=item.engineer.startAddress||'Адрес старта не указан';content.append(title,address);
        const popup=new maplibregl.Popup({closeButton:false,closeOnClick:false,offset:22,className:'order-popup'}).setDOMContent(content);
        element.addEventListener('mouseenter',()=>popup.setLngLat([item.coords[1],item.coords[0]]).addTo(map));element.addEventListener('mouseleave',()=>popup.remove());element.addEventListener('click',()=>{popup.remove();setSelectedStart(item)});
        const marker=new maplibregl.Marker({element,anchor:'center'}).setLngLat([item.coords[1],item.coords[0]]).addTo(map);return{marker,popup,element};
      });
      updateMarkerScale();
    };
    map.on('zoom',updateMarkerScale);
    if(map.isStyleLoaded())sync();else map.once('style.load',sync);
    return()=>{
      map.off('zoom',updateMarkerScale);
      map.off('style.load',sync);
      markersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      markersRef.current=[];
      startMarkersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      startMarkersRef.current=[];
    };
  },[map,mapOrders,scheduled,popupsEnabled,onOrder,activeRoute,activeOrderIds,assignmentMeta,routeStarts]);

  useEffect(()=>{
    if(!map)return undefined;
    districtRequestRef.current?.abort();
    const controller=new AbortController();districtRequestRef.current=controller;
    const removeBoundary=()=>{['selected-district-line','selected-district-halo','selected-district-fill'].forEach(id=>{if(map.getLayer(id))map.removeLayer(id)});if(map.getSource('selected-district'))map.removeSource('selected-district')};
    const fitFilteredPoints=()=>{if(!positions.length)return;const bounds=positionsBounds(positions);if(positions.length===1){const[lat,lon]=positions[0];optimizedCameraMove(map,()=>map.flyTo({center:[lon,lat],zoom:14.3,duration:760,speed:1.55,curve:1.1,essential:true}));return}optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding:{top:105,bottom:80,left:70,right:110},maxZoom:14.3,duration:820,essential:true}))};
    const renderBoundary=feature=>{
      if(controller.signal.aborted||!feature?.geometry)return false;
      removeBoundary();
      if(feature.properties?.type!=='administrative'&&feature.properties?.category!=='boundary')return false;
      if(positions.length){const inside=positions.filter(([lat,lon])=>geometryContainsPoint(feature.geometry,[lon,lat])).length;const required=Math.max(1,Math.ceil(positions.length*.55));if(inside<required){setDistrictBoundaryStatus('points');fitFilteredPoints();return false}}
      map.addSource('selected-district',{type:'geojson',data:{type:'FeatureCollection',features:[feature]}});
      const firstSymbol=map.getStyle().layers.find(layer=>layer.type==='symbol')?.id;
      map.addLayer({id:'selected-district-fill',type:'fill',source:'selected-district',paint:{'fill-color':'#FFD21F','fill-opacity':mapTheme==='night'?.16:.13}},firstSymbol);
      map.addLayer({id:'selected-district-halo',type:'line',source:'selected-district',paint:{'line-color':mapTheme==='night'?'#FFE76B':'#FFF3A4','line-width':8,'line-opacity':.46}},firstSymbol);
      map.addLayer({id:'selected-district-line',type:'line',source:'selected-district',paint:{'line-color':mapTheme==='night'?'#FFD21F':'#8A6700','line-width':3,'line-opacity':.96,'line-dasharray':[2,1]}},firstSymbol);
      const polygonBounds=feature.bbox?.length===4?[[feature.bbox[0],feature.bbox[1]],[feature.bbox[2],feature.bbox[3]]]:geometryBounds(feature.geometry),bounds=mergeBounds(polygonBounds,positionsBounds(positions));
      if(bounds)optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding:{top:105,bottom:80,left:70,right:110},maxZoom:13.3,duration:850,essential:true}));
      return true;
    };
    const load=async()=>{
      removeBoundary();
      if(!selectedTerritory){setDistrictBoundaryStatus('');return}
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
    if(map.isStyleLoaded())load();else map.once('style.load',load);
    return()=>{controller.abort();map.off('style.load',load);removeBoundary()};
  },[map,selectedTerritory,mapTheme,signature]);

  useEffect(()=>{
    if(!map)return;
    const selectedId=selectedOrder?String(selectedOrder.id):'';
    markersRef.current.forEach(({element,orderId})=>{
      const isSelected=Boolean(selectedId)&&orderId===selectedId;
      element?.classList.toggle('is-selected',isSelected);
      if(element)element.style.zIndex=isSelected?'900':'';
    });
    if(!selectedOrder||!Array.isArray(selectedOrder.coords)||selectedOrder.coords.length!==2)return;
    const[lat,lon]=selectedOrder.coords;
    optimizedCameraMove(map,()=>map.flyTo({center:[lon,lat],zoom:Math.max(15.6,map.getZoom()),offset:[-150,0],duration:920,speed:1.45,curve:1.15,essential:true}));
  },[map,selectedOrder]);

  useEffect(()=>{
    if(!map)return undefined;
    const syncRoute=()=>{
      if(map.getLayer('planned-route-casing'))map.removeLayer('planned-route-casing');
      if(map.getLayer('planned-route'))map.removeLayer('planned-route');
      if(map.getSource('planned-route'))map.removeSource('planned-route');
      if(routeGeoJson.features.length){
        map.addSource('planned-route',{type:'geojson',data:routeGeoJson});
        map.addLayer({id:'planned-route-casing',type:'line',source:'planned-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':activeRoute?(mapTheme==='night'?'#0B2528':'#0D5550'):(mapTheme==='night'?'#171A1F':'#FFFFFF'),'line-width':activeRoute?7:5.2,'line-opacity':activeRoute?.94:.72}});
        map.addLayer({id:'planned-route',type:'line',source:'planned-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':activeRoute?(mapTheme==='night'?'#64D9CE':'#1C9B91'):(mapTheme==='night'?'#7F8790':'#737B84'),'line-width':activeRoute?4.2:3,'line-opacity':activeRoute?1:.82}});
      }
    };
    if(map.isStyleLoaded())syncRoute();else map.once('style.load',syncRoute);
    return()=>map.off('style.load',syncRoute);
  },[map,routeGeoJson,scheduled,mapTheme,activeRoute]);

  useEffect(()=>{
    if(!map||!activeRoute||!routeGeoJson.features.length)return;
    const coordinates=routeGeoJson.features.flatMap(feature=>feature.geometry?.coordinates||[]);
    const start=routeStarts[0]?.coords;
    if(start)coordinates.push([start[1],start[0]]);
    if(!coordinates.length)return;
    const bounds=coordinates.reduce((result,[lon,lat])=>result.extend([lon,lat]),new maplibregl.LngLatBounds(coordinates[0],coordinates[0]));
    optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding:{top:90,bottom:90,left:85,right:430},maxZoom:15.5,duration:880,essential:true}));
  },[map,activeRoute,routeGeoJson,routeStarts]);

  useEffect(()=>{
    if(!map)return undefined;
    const apply=()=>{if(!map.isStyleLoaded())return;applyMapTheme(map,mapTheme)};
    const delayedApply=()=>requestAnimationFrame(apply);
    map.getContainer().dataset.mapTheme=mapTheme;
    if(map.isStyleLoaded())apply();else map.once('style.load',apply);
    map.once('idle',delayedApply);
    const timer=setTimeout(delayedApply,120);
    return()=>{clearTimeout(timer);map.off('style.load',apply);map.off('idle',delayedApply)};
  },[map,mapTheme,scheduled,routeGeoJson,activeRoute]);

  const locateUser=()=>{
    if(!map||!navigator.geolocation)return setLocationMessage('Геолокация недоступна в этом браузере');
    setLocating(true);setLocationMessage('Определяем местоположение…');
    navigator.geolocation.getCurrentPosition(({coords})=>{
      locationMarkerRef.current?.remove();
      const element=document.createElement('span');element.className='user-location-marker';element.setAttribute('aria-label','Моё местоположение');
      locationMarkerRef.current=new maplibregl.Marker({element}).setLngLat([coords.longitude,coords.latitude]).addTo(map);
      optimizedCameraMove(map,()=>map.flyTo({center:[coords.longitude,coords.latitude],zoom:14,duration:1000,speed:1.65,curve:1.15,essential:true}));
      setLocating(false);setLocationVisible(true);setLocationPrompt(null);setLocationMessage('Вы здесь');setTimeout(()=>setLocationMessage(''),2200);
    },error=>{
      setLocating(false);setLocationMessage('');
      if(error.code===error.PERMISSION_DENIED)setLocationPrompt('blocked');
      else{setLocationMessage('Не удалось определить местоположение');setTimeout(()=>setLocationMessage(''),3200)}
    },{enableHighAccuracy:false,timeout:8000,maximumAge:300000});
  };

  const requestLocationAccess=async()=>{
    if(!map||!navigator.geolocation){setLocationMessage('Геолокация недоступна в этом браузере');return}
    if(locationVisible){
      locationMarkerRef.current?.remove();locationMarkerRef.current=null;
      setLocationVisible(false);setLocationMessage('');setLocationPrompt(null);return;
    }
    try{
      const permission=await navigator.permissions?.query({name:'geolocation'});
      if(permission?.state==='granted'){locateUser();return}
      setLocationPrompt(permission?.state==='denied'?'blocked':'request');
    }catch{setLocationPrompt('request')}
  };

  const toggle3D=()=>setIs3D(enabled=>{const next=!enabled;setMap3D(map,next);return next});
  const resetOrientation=()=>{
    if(!map)return;
    map.easeTo({bearing:0,duration:620,easing:t=>1-(1-t)**3,essential:true});
  };

  return <section className="map-canvas real-map">
    <div ref={containerRef} className="maplibre-host"/>
    {selectedTerritory?<div className={`district-map-badge ${districtBoundaryStatus}`}><MapPinned/><span><small>{districtBoundaryStatus==='points'?'Область не задана · показаны все точки':territorySelection(selectedTerritory).kind==='zone'?'Зона из таблицы':'Сценарий района'}</small><b>{territorySelection(selectedTerritory).name}</b></span>{districtBoundaryStatus==='loading'?<i className="spinner"/>:districtBoundaryStatus==='unavailable'?<AlertTriangle/>:<Check/>}</div>:null}
    {mapOrders.length?<div className="map-work-legend">{Object.entries(WORK_POINT_TYPES).filter(([key])=>mapOrders.some(order=>workPointType(order)===key)).map(([key,item])=><span key={key}><i style={{background:item.color}}/>{item.label}</span>)}</div>:null}
    {geocodeProgress?<div className={`map-geocode-notice ${geocodeProgress.status||'active'} ${geocodeProgress.closing?'is-closing':''}`} role="status" aria-live="polite"><span className="geocode-notice-icon">{geocodeProgress.active?<span className="spinner"/>:geocodeProgress.status==='warning'?<AlertTriangle/>:<Check/>}</span><div className="geocode-notice-copy"><b>{geocodeProgress.active?`Определяем адреса: ${geocodeProgress.done} из ${geocodeProgress.total}`:geocodeProgress.status==='warning'?'Геокодирование завершено с замечаниями':`${geocodeProgress.found} адресов нанесено на карту`}</b><span>{geocodeProgress.active?`Метки появляются по мере обработки · осталось около ${Math.ceil(Math.max(0,geocodeProgress.total-geocodeProgress.done)/5)} сек${geocodeProgress.failed?` · проверить: ${geocodeProgress.failed}`:''}`:geocodeProgress.message}</span>{geocodeProgress.active?<i className="geocode-progress-track"><i style={{width:`${geocodeProgress.total?Math.round(geocodeProgress.done/geocodeProgress.total*100):0}%`}}/></i>:null}</div>{geocodeProgress.active?<em>{geocodeProgress.total?Math.round(geocodeProgress.done/geocodeProgress.total*100):0}%</em>:<button type="button" className="geocode-notice-close" onClick={onClearGeocodeProgress} aria-label="Закрыть"><X/></button>}</div>:null}
    <MapControls map={map} positions={positions} popupsEnabled={popupsEnabled} onTogglePopups={()=>setPopupsEnabled(value=>!value)} onToggleThemes={()=>setThemePickerOpen(open=>!open)} themesOpen={themePickerOpen} onLocate={requestLocationAccess} onResetOrientation={resetOrientation} locating={locating} locationVisible={locationVisible} is3D={is3D} onToggle3D={toggle3D}/>
    {themePickerPresence.present?<div ref={themePickerRef}><MapThemePicker value={mapTheme} onChange={setMapTheme} onClose={()=>setThemePickerOpen(false)} className={`dropdown-transition ${themePickerPresence.visible?'is-open':'is-closing'}`}/></div>:null}
    {locationPrompt?<div className="location-consent-backdrop" onMouseDown={event=>event.target===event.currentTarget&&setLocationPrompt(null)}><section className="location-consent" role="dialog" aria-modal="true" aria-label="Доступ к местоположению"><button type="button" className="location-close" onClick={()=>setLocationPrompt(null)} aria-label="Закрыть" data-tooltip="Закрыть"><X/></button><span className="location-icon"><LocateFixed/></span><h3>{locationPrompt==='blocked'?'Доступ к геолокации заблокирован':'Показать ваше местоположение?'}</h3><p>{locationPrompt==='blocked'?'Разрешите доступ к местоположению в настройках этого сайта, затем нажмите «Проверить снова».':'Координаты нужны только для показа вашей позиции на карте и не отправляются на сервер.'}</p>{locationPrompt==='blocked'?<div className="location-hint">Нажмите значок настроек сайта слева от адреса → «Местоположение» → «Разрешить».</div>:null}<footer><button type="button" onClick={()=>setLocationPrompt(null)}>Не сейчас</button><button type="button" className="primary" onClick={()=>{setLocationPrompt(null);locateUser()}}><LocateFixed/>{locationPrompt==='blocked'?'Проверить снова':'Разрешить доступ'}</button></footer></section></div>:null}
    {locationMessage?<div className="map-status">{locating?<span className="spinner"/>:<LocateFixed/>}{locationMessage}</div>:null}
    {selectedStart?<aside className="route-start-panel" role="dialog" aria-label="Стартовая точка"><header><span><MapPin/></span><div><small>Начало маршрута</small><b>{selectedStart.entries?.length>1?`Общая точка · ${selectedStart.entries.length} бригад`:`Старт · ${selectedStart.engineer.name}`}</b></div><button type="button" onClick={()=>setSelectedStart(null)} aria-label="Закрыть"><X/></button></header><p>{selectedStart.engineer.startAddress||'Адрес старта не указан'}</p><div className="route-start-list">{(selectedStart.entries||[{route:selectedStart.route,engineer:selectedStart.engineer}]).map(({route,engineer})=><button type="button" key={route.engineerId} onClick={()=>{setSelectedStart(null);onRoute?.(route)}}><span className="person-avatar">{engineer.name.split(' ').map(part=>part[0]).join('').slice(0,2)}</span><span><b>{engineer.name}</b><small>Смена {route.shiftStart}–{route.shiftEnd} · {route.assignments.length} остановок</small></span><ChevronRight/></button>)}</div><small className="route-start-hint">Нажмите на бригаду, чтобы открыть весь её маршрут</small></aside>:null}
    <div className="map-source-badge"><a href="https://openfreemap.org/" target="_blank" rel="noreferrer">© OpenFreeMap</a><span>·</span><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a><span>·</span><a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geocoding by Geoapify</a></div>
  </section>;
}
function UploadEmpty({onFile,inputRef}){const[dragging,setDragging]=useState(false);const choose=()=>inputRef.current?.click();const takeFile=file=>{if(file)onFile(file)};return <div className={`upload-empty ${dragging?'dragging':''}`} onClick={choose} onDragEnter={event=>{event.preventDefault();setDragging(true)}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(event.currentTarget===event.target)setDragging(false)}} onDrop={event=>{event.preventDefault();setDragging(false);takeFile(event.dataTransfer.files?.[0])}}><input ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{takeFile(event.target.files?.[0]);event.target.value=''}}/><span className="upload-mascot-shell"><img className="empty-mascot upload-mascot" src="/mascot-empty-upload.png" alt="Робот BeeGo с таблицей"/></span><span className="upload-kicker">Импорт заявок</span><div className="upload-copy"><h2>Выберите CSV, JSON, XLS или XLSX</h2><p>или перетащите файл сюда</p></div><button type="button" onClick={event=>{event.stopPropagation();choose()}}><Download size={18}/> Выбрать файл</button><a href="/beego-orders-template.xlsx" download="Шаблон заявок BeeGo.xlsx" onClick={event=>event.stopPropagation()}>Не знаете структуру? <u>Скачать шаблон</u></a></div>}
function RoutesEmpty(){return <div className="panel-empty"><img className="empty-mascot routes-mascot" src="/mascot-empty-routes.png" alt=""/><h2>Маршрутов пока нет</h2><p>Загрузите заявки, чтобы построить первый маршрут</p></div>}
function OrderList({orders,onOrder,plan}){return <div className="order-list"><div className="table-head"><span>КЛИЕНТ</span><span>ОКНО</span></div>{orders.map(o=>{const issue=plan?.unassigned?.find(item=>item.orderId===o.id);return <button key={o.id} onClick={()=>onOrder(o)}><span className={`check-dot point-type-${workPointType(o)} ${o.priority==='Авария'?'urgent':''}`}/><span className="order-main"><b>{displayOrderName(o)}</b><small>{o.address}</small>{issue?<em className="unassigned-reason">{issue.reason}</em>:null}</span><span className="order-window">{o.start?`${o.start}–${o.end}`:'Гибкое'}{o.priority!=='Обычная'?<em className={o.priority==='Авария'?'danger':''}>{o.priority}</em>:null}</span><ChevronRight size={16}/></button>})}</div>}
function AssignmentBoard({orders,plan,team,onOrder,onRoute,onRouteDetails,onReassign,onRecalculate}){
  const[dragged,setDragged]=useState(null),[expandedRoutes,setExpandedRoutes]=useState(()=>new Set());const activeRoutes=plan?.routes?.filter(route=>route.assignments.length)||[];
  const drop=engineerId=>{if(dragged){onReassign(dragged,engineerId);setDragged(null)}};
  if(!activeRoutes.length)return <RoutesEmpty/>;
  const toggleRoute=route=>setExpandedRoutes(current=>{const next=new Set(current),opening=!next.has(route.engineerId);opening?next.add(route.engineerId):next.delete(route.engineerId);onRoute(opening?route:null);return next});
  return <div className="assignment-board"><div className="board-summary"><div><b>{activeRoutes.length} бригад в плане</b><span>{plan.metrics.assigned} задач распределено</span></div>{plan.metrics.unassigned?<em><CircleAlert/>{plan.metrics.unassigned} требуют решения</em>:<em className="ok"><Check/>План без конфликтов</em>}</div>{activeRoutes.map(route=>{const engineer=team.find(item=>item.id===route.engineerId);const capacity=toMinutes(route.shiftEnd)-toMinutes(route.shiftStart);const load=Math.min(100,Math.round(route.workloadMinutes/capacity*100));const expanded=expandedRoutes.has(route.engineerId);return <article className={`route-board-card ${expanded?'is-expanded':''}`} key={route.engineerId} onDragOver={event=>event.preventDefault()} onDrop={()=>drop(route.engineerId)}><div className="route-card-top"><button className="route-card-head" type="button" aria-expanded={expanded} onClick={()=>toggleRoute(route)}><span className="person-avatar">{route.engineerName.split(' ').map(part=>part[0]).join('').slice(0,2)}</span><div><b>{route.engineerName}</b><small>{durationLabel(route.workloadMinutes)} · {route.distanceKm} км</small></div><span className="route-task-count">{route.assignments.length}</span><ChevronDown className={expanded?'expanded':''}/></button><button type="button" className="route-open-map" onClick={()=>onRoute(route)} aria-label={`Показать маршрут: ${route.engineerName}`} data-tooltip="Показать на карте"><MapPinned/></button></div>{expanded?<div className="route-card-details"><div className="route-expanded-stats"><span><small>Задачи</small><b>{route.assignments.length}</b></span><span><small>Время</small><b>{durationLabel(route.workloadMinutes)}</b></span><span><small>Пробег</small><b>{route.distanceKm} км</b></span><span className={plan.metrics.unassigned?'attention':''}><small>Не вошли</small><b>{plan.metrics.unassigned}</b></span></div><div className="route-detail-actions"><button type="button" onClick={()=>onRouteDetails(route)}><List/>Открыть весь маршрут<ChevronRight/></button></div><div className="assignment-chips">{route.assignments.map(item=>{const order=orders.find(candidate=>candidate.id===item.orderId);return order?<button draggable onDragStart={()=>setDragged(order.id)} onClick={()=>onOrder(order)} key={order.id}><span>{item.plannedStart}</span><b>{displayOrderName(order)}</b>{item.manual?<LockKeyhole/>:<ChevronRight/>}</button>:null})}</div>{engineer?.skills?.length?<div className="route-tags">{engineer.skills.slice(0,2).map(skill=><span key={skill}>{skill}</span>)}</div>:null}</div>:null}</article>})}{plan.unassigned.length?<article className="unassigned-board"><div><CircleAlert/><b>Не вошли в текущий план</b><span>{plan.unassigned.length}</span></div><p className="unassigned-intro">Для этих заявок не найдено безопасного места в текущем расписании.</p>{plan.unassigned.map(item=>{const order=orders.find(candidate=>candidate.id===item.orderId),copy=unassignedExplanation(item);return order?<button draggable onDragStart={()=>setDragged(order.id)} onClick={()=>onOrder(order)} key={order.id}><b>{displayOrderName(order)}</b><strong>{copy.title}</strong><small>{copy.summary}</small><em>Открыть подробности <ChevronRight/></em></button>:null})}<button type="button" className="recalculate-unassigned" onClick={onRecalculate}><RefreshCw/>Полностью пересчитать день</button></article>:null}</div>
}
function BottomRoutes({view,setView,orders,onRoute,onOrder,onRecalculate,scheduled,plan,activeRoute}){const route=activeRoute?.assignments?.length?activeRoute:plan?.routes?.find(item=>item.assignments.length);if(!scheduled||!route)return null;const shiftStart=toMinutes(route.shiftStart),shiftEnd=toMinutes(route.shiftEnd),shiftLength=Math.max(1,shiftEnd-shiftStart);return <section className="bottom-routes"><div className="route-title"><span className="route-timeline-icon"><Gauge/></span><span><b>Расписание бригады</b><small>Нажмите на интервал, чтобы открыть заявку</small></span><div className="view-toggle"><button className={view==='timeline'?'active':''} onClick={()=>setView('timeline')}><Gauge/> Таймлайн</button><button className={view==='list'?'active':''} onClick={()=>setView('list')}><List/></button></div></div><button className="route-row" onClick={()=>onRoute(route)}><span className="route-color"/><strong>{route.engineerName}</strong><small><BriefcaseBusiness/> {route.assignments.length}</small><small><MapPin/> {route.distanceKm} км</small><small><Clock3/> {durationLabel(route.workloadMinutes)}</small><ChevronRight/></button>{view==='timeline'?<div className="timeline"><div className="times">{[0,.25,.5,.75,1].map(fraction=><span key={fraction}>{toTime(Math.round(shiftStart+shiftLength*fraction))}</span>)}</div><div className="timeline-track"><span className="timeline-start" title={`Старт смены ${route.shiftStart}`}>Старт</span>{route.assignments.map((item,index)=>{const order=orders.find(candidate=>candidate.id===item.orderId),start=toMinutes(item.plannedStart),finish=toMinutes(item.plannedFinish),left=Math.max(0,(start-shiftStart)/shiftLength*100),width=Math.max(2.4,(finish-start)/shiftLength*100);return <button type="button" key={item.orderId} className={order?.priority==='Авария'?'urgent':''} style={{left:`${left}%`,width:`${Math.min(width,100-left)}%`}} title={`${index+1}. ${displayOrderName(order)} · ${item.plannedStart}–${item.plannedFinish}`} onClick={()=>order&&onOrder(order)}><b>{index+1}</b><span>{item.plannedStart}</span></button>})}</div></div>:<div className="list-summary"><Check/> Порядок остановок рассчитан и независимо проверен · {plan.metrics.unassigned} заявок требуют решения</div>}<button className="recalculate-timeline" onClick={onRecalculate}><RefreshCw/>Пересчитать</button><button className="publish">Опубликовать план</button></section>}
function RouteWorkspace({orders,team,plan,scheduled,setScheduled,view,setView,openPlan,onOrder,onRoute,onReassign,onEmergency,mapping,onUploadError,selectedDate,setSelectedDate,uiTheme}){const inputRef=useRef(null);const handleFile=async file=>{if(!file)return;try{mapping(await parseImportFile(file))}catch(error){onUploadError(error?.message||'Не удалось прочитать файл')}};const unassignedOrders=plan?plan.unassigned.map(item=>orders.find(order=>order.id===item.orderId)).filter(Boolean):orders;const assignedOrders=plan?plan.routes.flatMap(route=>route.assignments.map(item=>orders.find(order=>order.id===item.orderId))).filter(Boolean):[];const visibleOrders=scheduled?assignedOrders:unassignedOrders;return <main className="route-workspace"><Topbar scheduled={scheduled} setScheduled={setScheduled} orders={orders} plan={plan} openPlan={openPlan} openUpload={()=>inputRef.current?.click()} addEmergency={onEmergency} selectedDate={selectedDate} setSelectedDate={setSelectedDate}/><input className="workspace-file-input" ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleFile(event.target.files?.[0]);event.target.value=''}}/><Metrics orders={orders} plan={plan}/><div className={`workspace-grid ${scheduled&&plan?.metrics?.assigned?'with-bottom':''}`}><section className="orders-panel"><div className="panel-heading"><div><span className="fake-check"/><h3>{scheduled?'Маршруты':'Не назначены'}</h3></div><div className="segmented"><button className="active"><List/> Список</button><button aria-label="Показать на карте" data-tooltip="Показать на карте"><Map/></button></div></div>{!orders.length?(scheduled?<RoutesEmpty/>:<UploadEmpty onFile={handleFile} inputRef={inputRef}/>):scheduled&&plan?<AssignmentBoard orders={orders} plan={plan} team={team} onOrder={onOrder} onRoute={onRoute} onReassign={onReassign}/>:visibleOrders.length?<OrderList orders={visibleOrders} onOrder={onOrder} plan={plan}/>:<div className="resolved-empty"><Check/><h3>Все заявки распределены</h3><p>Конфликтов и заявок для ручной обработки нет.</p></div>}</section><MapCanvas orders={scheduled?assignedOrders:visibleOrders} scheduled={scheduled} onOrder={onOrder} uiTheme={uiTheme}/><BottomRoutes view={view} setView={setView} orders={orders} onRoute={onRoute} scheduled={scheduled} plan={plan}/></div></main>}
function Modal({children,onClose,wide=false}){return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><section className={`modal ${wide?'wide':''}`}>{children}</section></div>}
function HelpCenter({profile,onClose}){
  const[tab,setTab]=useState('home'),[activeTopic,setActiveTopic]=useState(null);
  const firstName=profile.name.trim().split(/\s+/)[0]||'коллега';
  const tabs=[['home',House,'Главная'],['learn',GraduationCap,'Обучение'],['news',Newspaper,'Новости'],['help',CircleHelp,'Помощь']];
  const topics=[
    ['routes',Route,'Планирование маршрутов','Загрузка заявок, оптимизация и публикация готового плана.'],
    ['orders',BriefcaseBusiness,'Заявки и объекты','Импорт данных, временные окна и карточки клиентов.'],
    ['engineers',HardHat,'Инженеры и смены','Навыки, транспорт, рабочее время и загрузка команды.'],
    ['settings',Settings2,'Настройки пространства','Профиль, тема интерфейса и параметры оптимизации.'],
  ];
  return <aside className="help-center" role="dialog" aria-label="Центр помощи BeeGo!"><header><div className="help-brand"><img src="/beego-mark.png" alt=""/><span><b>BeeGo!</b><small>Центр поддержки</small></span></div><button onClick={onClose} aria-label="Закрыть помощь" data-tooltip="Закрыть"><X/></button></header><div className="help-center-body">
    {tab==='home'?<section className="help-view help-home"><div className="help-welcome"><img src="/mascot-empty-routes.png" alt=""/><div><small>Всегда рядом</small><h2>Привет, {firstName}!</h2><p>Разберёмся с маршрутами, настройками и работой команды.</p></div></div><div className="help-quick-grid"><button onClick={()=>setTab('learn')}><span><GraduationCap/></span><div><b>Начать обучение</b><small>Короткий путь от импорта до готового маршрута</small></div><ArrowRight/></button><button onClick={()=>setTab('news')}><span><Rocket/></span><div><b>Что нового</b><small>Последние улучшения BeeGo!</small></div><ArrowRight/></button><button onClick={()=>setTab('help')}><span><CircleHelp/></span><div><b>Найти ответ</b><small>Инструкции по основным разделам</small></div><ArrowRight/></button></div><div className="help-tip"><ShieldCheck/><p><b>Совет дня</b>Загрузите рабочую таблицу заявок и проверьте сопоставление столбцов перед планированием.</p></div></section>:null}
    {tab==='learn'?<section className="help-view"><div className="help-page-title"><span><GraduationCap/></span><div><small>Быстрый старт</small><h2>Освойте BeeGo!</h2><p>Пять коротких шагов от первой заявки до рабочего маршрута.</p></div></div><div className="learning-progress"><span><i style={{width:'20%'}}/></span><small>1 из 5 шагов · около 12 минут</small></div><div className="lesson-list">{[['1','Знакомство с рабочим пространством','2 мин',true],['2','Загрузка и проверка заявок','3 мин',false],['3','Настройка инженеров и ограничений','3 мин',false],['4','Оптимизация и проверка маршрута','2 мин',false],['5','Публикация плана на день','2 мин',false]].map(([n,title,time,done])=><button key={n} className={done?'done':''}><span>{done?<Check/>:n}</span><div><b>{title}</b><small>{time}</small></div><PlayCircle/></button>)}</div></section>:null}
    {tab==='news'?<section className="help-view"><div className="help-page-title compact"><span><Newspaper/></span><div><small>Обновления продукта</small><h2>Новости BeeGo!</h2></div></div><div className="news-list"><article><div className="news-visual routes"><Route/></div><small>Сегодня · Маршруты</small><h3>Ночная карта стала частью тёмной темы</h3><p>Переключайте интерфейс — карта автоматически подберёт подходящий стиль с контрастными дорогами.</p><button>Подробнее <ArrowRight/></button></article><article><div className="news-visual profile"><img src="/avatars/bee-running.png" alt=""/></div><small>15 сентября · Профиль</small><h3>Персональные маскоты команды</h3><p>Выбирайте героя BeeGo!, роль и отображаемое имя прямо в профиле.</p><button>Подробнее <ArrowRight/></button></article></div></section>:null}
    {tab==='help'?<section className="help-view"><div className="help-page-title compact"><span><CircleHelp/></span><div><small>База знаний</small><h2>Чем помочь?</h2></div></div><label className="help-search"><Search/><input placeholder="Найти инструкцию…"/></label><div className="help-topics">{topics.map(([id,Icon,title,text])=><button key={id} className={activeTopic===id?'open':''} onClick={()=>setActiveTopic(current=>current===id?null:id)}><span><Icon/></span><div><b>{title}</b><small>{text}</small>{activeTopic===id?<p>Подробные статьи и пошаговые инструкции появятся здесь в следующей версии центра помощи.</p>:null}</div><ChevronRight/></button>)}</div></section>:null}
  </div><nav className="help-tabs">{tabs.map(([id,Icon,label])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}><Icon/><span>{label}</span></button>)}</nav></aside>
}
function ProfileModal({profile,onClose,onSave}){
  const[draft,setDraft]=useState(profile),[roleOpen,setRoleOpen]=useState(false);const roleRef=useRef(null);
  const rolePresence=useDropdownPresence(roleOpen);
  const valid=draft.name.trim()&&draft.email.trim();
  const update=(key,value)=>setDraft(current=>({...current,[key]:value}));
  useEffect(()=>{if(!roleOpen)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='mousedown'&&!roleRef.current?.contains(event.target)))setRoleOpen(false)};document.addEventListener('mousedown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',close)}},[roleOpen]);
  return <Modal onClose={onClose} wide><div className="modal-head profile-modal-head"><div><h2>Профиль</h2><p>Настройте данные, которые будут видеть участники команды</p></div><button onClick={onClose} aria-label="Закрыть" data-tooltip="Закрыть"><X/></button></div><div className="profile-editor"><aside className="profile-preview"><ProfileAvatar profile={draft}/><h3>{draft.name||'Ваше имя'}</h3><p>{PROFILE_ROLES[draft.role]}</p><small>{draft.email||'email@example.ru'}</small></aside><section><div className="profile-fields"><label>Отображаемое имя<input value={draft.name} onChange={event=>update('name',event.target.value)} placeholder="Имя и фамилия"/></label><div className="form-row"><div className="profile-field" ref={roleRef}><span>Роль</span><button type="button" className={`role-select ${roleOpen?'open':''}`} onClick={()=>setRoleOpen(open=>!open)} aria-haspopup="listbox" aria-expanded={roleOpen}><span>{PROFILE_ROLES[draft.role]}</span><ChevronDown/></button>{rolePresence.present?<div className={`role-menu dropdown-transition ${rolePresence.visible?'is-open':'is-closing'}`} role="listbox" aria-label="Роль пользователя">{Object.entries(PROFILE_ROLES).map(([value,label])=><button type="button" role="option" aria-selected={draft.role===value} className={draft.role===value?'selected':''} key={value} onClick={()=>{update('role',value);setRoleOpen(false)}}><span>{label}</span>{draft.role===value?<Check/>:null}</button>)}</div>:null}</div><label>Email<input type="email" value={draft.email} onChange={event=>update('email',event.target.value)} placeholder="name@company.ru"/></label></div></div><div className="avatar-picker-head"><div><h3>Выберите аватар</h3><p>Загрузка своих изображений отключена</p></div><span>{PROFILE_AVATARS.length} вариантов</span></div><div className="avatar-grid">{PROFILE_AVATARS.map(avatar=><button type="button" key={avatar.id} className={draft.avatar===avatar.id?'selected':''} onClick={()=>update('avatar',avatar.id)} aria-label={avatar.label} aria-pressed={draft.avatar===avatar.id}><img src={avatar.src} alt=""/><span>{avatar.label}</span>{draft.avatar===avatar.id?<i><Check/></i>:null}</button>)}</div></section></div><footer className="modal-footer profile-actions"><button onClick={onClose}>Отмена</button><button className="primary" disabled={!valid} onClick={()=>onSave({...draft,name:draft.name.trim(),email:draft.email.trim()})}>Сохранить профиль</button></footer></Modal>
}
function MappingModal({rows,fileName,onClose,onImport}){const columns=['Имя клиента','Адрес','Телефон','Email','Начало окна','Конец окна','Длительность','Загрузка','Не импортировать','Штрихкод'];return <Modal onClose={onClose} wide><div className="modal-head"><div><h2>Загрузка заявок</h2><p>{fileName} · найдено {rows.length} строк</p></div><button onClick={onClose}><X/></button></div><div className="mapping-groups"><b>Данные адреса</b><span>Адрес · Город · Координаты</span><b>Параметры заявки</b><span>Окно · Длительность · Навык · Приоритет</span></div><div className="mapping-note"><Check/> 9 из 11 колонок выбраны для импорта</div><div className="mapping-table"><div className="mapping-selects">{columns.map(c=><button key={c}>{c}<ChevronDown/></button>)}</div>{[['NAME','ADDRESS','PHONE','EMAIL','START','END','DURATION','LOAD','NOTES','BARCODE'],...rows.slice(0,5).map(o=>[o.name,o.address,o.phone,o.email,o.start,o.end,o.duration,'1','Комментарий к заявке',`46000010${String(o.id).padStart(4,'0')}`])].map((r,i)=><div className={i===0?'headers':''} key={i}>{r.map((c,j)=><span key={j}>{c||'—'}</span>)}</div>)}</div><footer className="modal-footer"><button onClick={onClose}>Отмена</button><button className="primary" onClick={onImport}>Загрузить {rows.length} заявок</button></footer></Modal>}
function PlanDrawer({orders,team,onClose,onOptimize,optimizing,selectedDate}){const[options,setOptions]=useState({balance:true,traffic:true,overtime:false,late:false,lockManual:true});const rows=[['balance','Балансировать загрузку','Равномерно распределять рабочее время.'],['traffic','Учитывать время в пути','Использовать тип транспорта и дорожную сеть.'],['overtime','Разрешить сверхурочные','Допускать работу за пределами смены.'],['late','Разрешить опоздания','Допускать старт позже клиентского окна.'],['lockManual','Сохранять ручные назначения','Не перемещать закреплённые заявки.']];return <div className="drawer-backdrop"><aside className="plan-drawer"><div className="modal-head"><div><h2>Спланировать маршруты</h2><p>{fullDateLabel(selectedDate)}</p></div><button onClick={onClose}><X/></button></div><div className="plan-step done"><span>1</span><div><b>Заявки</b><small>{orders.length} готовы к распределению</small></div><Check/></div><div className={`plan-step ${team.length?'done':'warning'}`}><span>2</span><div><b>Команда участка</b><small>{team.length?`${team.length} исполнителей · навыки и транспорт проверены`:'Сначала загрузите инженеров во вкладке «Инженеры»'}</small></div>{team.length?<Check/>:<AlertTriangle/>}</div><h4>Параметры расчёта</h4>{rows.map(([key,title,description])=><button type="button" className="setting-line interactive" key={key} onClick={()=>setOptions(current=>({...current,[key]:!current[key]}))}><span><b>{title}</b><small>{description}</small></span><i className={options[key]?'on':''}><b/></i></button>)}<div className="plan-info"><Sparkles/> При расчёте учитываются районы, навыки, транспорт, оборудование, клиентские окна и продолжительность смен.</div><footer><button onClick={onClose}>Отмена</button><button className="primary" onClick={()=>onOptimize(options)} disabled={optimizing||!team.length}>{optimizing?<><span className="spinner"/>Оптимизируем…</>:<><WandSparkles/>Построить план</>}</button></footer></aside></div>}
function DetailDrawer({order,route,orders,team,plan,onReassign,onRecalculate,onOpenRoute,onClose}){
  if(!order&&!route)return null;
  if(route)return <aside className="detail-drawer"><div className="drawer-head"><h2>{route.engineerName}</h2><button aria-label="Другие действия"><MoreHorizontal/></button><button onClick={onClose} aria-label="Закрыть"><X/></button></div><div className="drawer-stats"><span><BriefcaseBusiness/>{route.assignments.length}</span><span><Clock3/>{durationLabel(route.workloadMinutes)}</span><span><Activity/>{Math.round(route.workloadMinutes/(toMinutes(route.shiftEnd)-toMinutes(route.shiftStart))*100)}%</span></div><div className="stop-list">{route.assignments.map((item,i)=>{const current=orders.find(candidate=>candidate.id===item.orderId);return current?<div key={current.id}><b>{i+1}</b><section><small>Прибытие: {item.arrival} · начало: {item.plannedStart}</small><strong>{current.name}</strong><span>{current.address}</span><em><Clock3/>{current.start||'08:00'}–{current.end||'18:00'} · до {item.plannedFinish}</em>{item.manual?<i className="manual-badge"><LockKeyhole/> Закреплено диспетчером</i>:null}</section></div>:null})}</div><button className="primary drawer-action">Опубликовать маршрут</button></aside>;
  const assignedRoute=plan?.routes?.find(item=>item.assignments.some(assignment=>String(assignment.orderId)===String(order.id)));
  const assignmentIndex=assignedRoute?.assignments.findIndex(item=>String(item.orderId)===String(order.id))??-1;
  const assignment=assignmentIndex>=0?assignedRoute.assignments[assignmentIndex]:null;
  const previousAssignment=assignmentIndex>0?assignedRoute.assignments[assignmentIndex-1]:null;
  const previousOrder=previousAssignment?orders.find(item=>String(item.id)===String(previousAssignment.orderId)):null;
  const issue=plan?.unassigned?.find(item=>item.orderId===order.id);
  const assignedEngineer=assignment?team.find(item=>item.id===assignment.engineerId):null;
  const originTitle=previousOrder?displayOrderName(previousOrder):assignedEngineer?'Стартовая точка бригады':'—';
  const originAddress=previousOrder?.address||assignedEngineer?.startAddress||'Адрес старта не указан';
  const exact=['exact','provided','ready'].includes(order.geocodeStatus),issueCopy=issue?unassignedExplanation(issue):null;
  return <aside className="point-detail-panel" role="dialog" aria-label={`Заявка ${order.name}`}>
    <header><div className="point-detail-brand"><span><MapPin/></span><div><b>Карточка заявки</b><small>{order.id||order.name} · точка на карте</small></div></div><button onClick={onClose} aria-label="Закрыть карточку" data-tooltip="Закрыть"><X/></button></header>
    <div className="point-detail-body">
      <section className={`point-detail-hero ${order.priority==='Авария'?'urgent':''}`}><span>{order.priority==='Авария'?<AlertTriangle/>:<BriefcaseBusiness/>}</span><div><small>{order.status||'Новая заявка'}</small><h2>{displayOrderName(order)}</h2><p>{order.address}</p></div><em>{order.priority||'Обычная'}</em></section>
      <div className="point-detail-grid"><article><Clock3/><div><small>Клиентское окно</small><b>{order.start?`${order.start}–${order.end}`:'Гибкое'}</b></div></article><article><Activity/><div><small>Норматив</small><b>{durationLabel(order.duration)}</b></div></article><article><Wrench/><div><small>Навык</small><b>{order.skill||'Не указан'}</b></div></article><article><PackageCheck/><div><small>Оборудование</small><b>{order.equipment||'Не требуется'}</b></div></article></div>
      <section className="point-location-card"><div><MapPinned/><span><small>Координаты</small><b>{exact?'Точный адрес подтверждён':'Нужна проверка адреса'}</b></span><em className={exact?'exact':'review'}>{exact?<><Check/>Точно</>:<><AlertTriangle/>Проверить</>}</em></div>{order.geocodedAddress&&order.geocodedAddress!==order.address?<p>{order.geocodedAddress}</p>:null}</section>
      <section className="point-plan-card"><div><Sparkles/><span><small>Назначение</small><b>{assignedEngineer?.name||'Пока не назначена'}</b></span></div><dl><dt>Плановое начало</dt><dd>{assignment?.plannedStart||'—'}</dd><dt>Завершение</dt><dd>{assignment?.plannedFinish||'—'}</dd></dl>{assignedRoute?<button type="button" className="open-assigned-route" onClick={()=>onOpenRoute?.(assignedRoute)}><Route/><span><b>Открыть маршрут бригады</b><small>{assignedRoute.assignments.length} остановок · смена {assignedRoute.shiftStart}–{assignedRoute.shiftEnd}</small></span><ChevronRight/></button>:null}</section>
      {assignment?<section className="point-travel-card"><div className="point-travel-title"><Route/><span><small>Откуда едет инженер</small><b>{originTitle}</b></span></div><p>{originAddress}</p><div className="point-travel-metrics"><span><Clock3/><b>{assignment.travelMinutes||0} мин</b><small>в пути</small></span><span><MapPin/><b>{assignment.distanceM?`${(assignment.distanceM/1000).toFixed(1)} км`:'—'}</b><small>до заявки</small></span><span><ChevronRight/><b>{assignment.departureAt||previousAssignment?.plannedFinish||assignedRoute.shiftStart}</b><small>выезд</small></span></div></section>:null}
      {issue?<div className="point-detail-alert"><CircleAlert/><p><b>{issueCopy.title}</b>{issueCopy.summary}<em>{issueCopy.action}</em></p></div>:assignment?<div className={`point-detail-alert success ${assignment.manual?'manual':''}`}>{assignment.manual?<LockKeyhole/>:<Check/>}<p><b>{assignment.manual?'Закреплено вручную':'Почему назначено этой бригаде'}</b>{assignment.explanation||`${assignedEngineer?.name} подходит по навыкам, оборудованию и времени.`}</p></div>:null}
      <div className="manual-assign point-manual-assign">{issue?<><b>Пересчитать расписание</b><p>Алгоритм заново проверит порядок всех остановок. Уже опубликованные маршруты могут измениться.</p><button type="button" className="primary recalculate-order" onClick={onRecalculate}><RefreshCw/>Полностью пересчитать день</button></>:<><div className="manual-assign-select"><span>Запросить переназначение</span><BusinessSelect ariaLabel="Выберите другую бригаду" value="" onChange={engineerId=>engineerId&&onReassign(order.id,engineerId)} options={[{value:'',label:'Выберите другую бригаду',disabled:true},...team.filter(engineer=>engineer.id!==assignment?.engineerId).map(engineer=>({value:engineer.id,label:`${engineer.name} · ${engineer.transport}`}))]}/></div><small><LockKeyhole/> Изменение вступит в силу только после повторного точного расчёта</small></>}</div>
    </div>
  </aside>;
}
function PageShell({title,children,action}){return <main className="page"><header><div><h1>{title}</h1></div>{action}</header>{children}</main>}
const TransportIcon=({type})=>type==='Автомобиль'?<Car/>:type==='Пешком'?<Footprints/>:<Bus/>;
function EngineerUploadPanel({inputRef,onFile}){const[dragging,setDragging]=useState(false);const choose=()=>inputRef.current?.click();const takeFile=file=>{if(file)onFile(file)};return <section className="engineer-upload-stage"><div className={`engineer-upload-card ${dragging?'dragging':''}`} onClick={choose} onDragEnter={event=>{event.preventDefault();setDragging(true)}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(event.currentTarget===event.target)setDragging(false)}} onDrop={event=>{event.preventDefault();setDragging(false);takeFile(event.dataTransfer.files?.[0])}}><input className="workspace-file-input" ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{takeFile(event.target.files?.[0]);event.target.value=''}}/><span className="engineer-mascot-shell"><img src="/avatars/dog-engineer.png" alt="Инженер BeeGo"/></span><span className="engineer-upload-kicker">Импорт инженеров</span><h2>Выберите CSV, JSON, XLS или XLSX</h2><p>или перетащите файл сюда</p><button type="button" onClick={event=>{event.stopPropagation();choose()}}><Download/>Выбрать файл</button><a href="/beego-engineers-template.xlsx" download="Шаблон инженеров BeeGo.xlsx" onClick={event=>event.stopPropagation()}>Не знаете структуру? <u>Скачать шаблон</u></a><small>После выбора откроется большая редактируемая таблица</small></div></section>}
function EngineerList({team}){return <div className="engineer-list"><div className="engineer-list-head"><span>ИНЖЕНЕР</span><span>СМЕНА</span></div>{team.map(engineer=><article className="engineer-list-row" key={engineer.id}><span className="person-avatar">{engineer.name.split(' ').map(part=>part[0]).join('').slice(0,2)}</span><div className="engineer-list-main"><b>{engineer.name}</b><small>{engineer.skills.length?engineer.skills.join(' · '):'Навыки не указаны'}</small><em><TransportIcon type={engineer.transport}/>{engineer.transport||'Транспорт не указан'}</em></div><div className="engineer-list-shift"><b>{engineer.shiftStart}–{engineer.shiftEnd}</b><small>{engineer.status||'Доступен сегодня'}</small></div></article>)}</div>}
function EngineersPage({team,region,onImportFile,onUploadError,uiTheme,selectedDate,setSelectedDate}){const inputRef=useRef(null);const handleFile=async file=>{if(!file)return;try{onImportFile(await parseImportFile(file,'engineers'))}catch(error){onUploadError(error?.message||'Не удалось прочитать файл инженеров')}};const engineerMarkers=useMemo(()=>team.map(engineer=>({id:`engineer-${engineer.id}`,name:engineer.name,address:engineer.startAddress||region.office,coords:engineer.startCoords})).filter(engineer=>Array.isArray(engineer.coords)&&engineer.coords.length===2),[team,region.office]);return <main className="route-workspace engineer-workspace"><header className="topbar engineer-topbar"><div className="engineer-topbar-title"><HardHat/><strong>Инженеры</strong>{team.length?<b>{team.length}</b>:null}</div><DateControl value={selectedDate} onChange={setSelectedDate}/><div className="top-actions"><a className="icon engineer-template-action" href="/beego-engineers-template.xlsx" download="Шаблон инженеров BeeGo.xlsx" aria-label="Скачать шаблон" data-tooltip="Скачать шаблон"><Download/></a><button type="button" className="primary" onClick={()=>inputRef.current?.click()}><Plus/>Загрузить инженеров</button></div></header><div className="engineer-workspace-grid"><section className="orders-panel engineer-panel"><div className="panel-heading"><div><span className="fake-check"/><h3>Инженеры</h3>{team.length?<b className="engineer-count">{team.length}</b>:null}</div>{team.length?<button type="button" className="engineer-reupload" onClick={()=>inputRef.current?.click()} aria-label="Загрузить другой файл" data-tooltip="Загрузить другой файл"><Download/></button>:null}</div>{team.length?<><input className="workspace-file-input" ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleFile(event.target.files?.[0]);event.target.value=''}}/><EngineerList team={team}/></>:<EngineerUploadPanel inputRef={inputRef} onFile={handleFile}/>}</section><MapCanvas orders={engineerMarkers} scheduled={false} onOrder={()=>{}} uiTheme={uiTheme}/></div></main>}

function OperationalMapWorkspace({mode,orders,team,region,plan,scheduled,setScheduled,view,setView,openPlan,onOrder,onRoute,onRouteDetails,onReassign,onEmergency,mapping,onUploadError,selectedDate,setSelectedDate,uiTheme,geocodeProgress,onClearGeocodeProgress,selectedOrder,activeRoute}){
  const ordersInputRef=useRef(null),engineersInputRef=useRef(null);
  const[selectedTerritory,setSelectedTerritory]=useState('');
  const engineersMode=mode==='engineers';
  const handleOrdersFile=async file=>{if(!file)return;try{mapping(await parseImportFile(file))}catch(error){onUploadError(error?.message||'Не удалось прочитать файл')}};
  const handleEngineersFile=async file=>{if(!file)return;try{mapping(await parseImportFile(file,'engineers'))}catch(error){onUploadError(error?.message||'Не удалось прочитать файл инженеров')}};
  const unassignedOrders=plan?plan.unassigned.map(item=>orders.find(order=>order.id===item.orderId)).filter(Boolean):orders;
  const assignedOrders=plan?plan.routes.flatMap(route=>route.assignments.map(item=>orders.find(order=>order.id===item.orderId))).filter(Boolean):[];
  const zones=useMemo(()=>{const counts=new globalThis.Map();orders.forEach(order=>{const name=orderZone(order);if(name)counts.set(name,(counts.get(name)||0)+1)});return[...counts].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'ru'))},[orders]);
  const districts=useMemo(()=>{const counts=new globalThis.Map();orders.forEach(order=>{const name=orderDistrict(order);if(name)counts.set(name,(counts.get(name)||0)+1)});return[...counts].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'ru'))},[orders]);
  useEffect(()=>{if(!selectedTerritory)return;const selected=territorySelection(selectedTerritory),items=selected.kind==='zone'?zones:districts;if(!items.some(item=>item.name===selected.name))setSelectedTerritory('')},[zones,districts,selectedTerritory]);
  const inSelectedTerritory=order=>{if(!selectedTerritory)return true;const selected=territorySelection(selectedTerritory),actual=selected.kind==='zone'?orderZone(order):orderDistrict(order);return actual.toLocaleLowerCase('ru-RU')===selected.name.toLocaleLowerCase('ru-RU')};
  const filteredOrders=useMemo(()=>orders.filter(inSelectedTerritory),[orders,selectedTerritory]);
  const visibleOrders=(scheduled?assignedOrders:unassignedOrders).filter(inSelectedTerritory);
  const displayPlan=useMemo(()=>{if(!plan||!selectedTerritory)return plan;const allowed=new Set(filteredOrders.map(order=>String(order.id)));const routes=plan.routes.map(route=>({...route,assignments:route.assignments.filter(item=>allowed.has(String(item.orderId)))}));const unassigned=plan.unassigned.filter(item=>allowed.has(String(item.orderId)));const assigned=routes.reduce((total,route)=>total+route.assignments.length,0);return{...plan,routes,unassigned,metrics:{...plan.metrics,total:filteredOrders.length,assigned,unassigned:unassigned.length,activeEngineers:routes.filter(route=>route.assignments.length).length}}},[plan,selectedTerritory,filteredOrders]);
  const engineerMarkers=useMemo(()=>team.map(engineer=>({id:`engineer-${engineer.id}`,name:engineer.name,address:engineer.startAddress||region.office,coords:engineer.startCoords})).filter(engineer=>Array.isArray(engineer.coords)&&engineer.coords.length===2),[team,region.office]);
  const mapItems=engineersMode?engineerMarkers:(scheduled?filteredOrders:visibleOrders);
  const changeTerritory=next=>{setSelectedTerritory(next);onOrder(null);onRoute(null)};

  return <main className={`route-workspace ${engineersMode?'engineer-workspace':''}`}>
    {engineersMode?<Topbar selectedDate={selectedDate} setSelectedDate={setSelectedDate}/>:<><Topbar selectedDate={selectedDate} setSelectedDate={setSelectedDate}/><input className="workspace-file-input" ref={ordersInputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleOrdersFile(event.target.files?.[0]);event.target.value=''}}/></>}
    <div className={`workspace-grid ${engineersMode?'engineer-workspace-grid':''}`}>
      {engineersMode?<section className="orders-panel engineer-panel"><div className="panel-heading"><div><span className="fake-check"/><h3>Инженеры</h3>{team.length?<b className="engineer-count">{team.length}</b>:null}</div>{team.length?<button type="button" className="engineer-reupload" onClick={()=>engineersInputRef.current?.click()} aria-label="Загрузить другой файл" data-tooltip="Загрузить другой файл"><Download/></button>:null}</div>{team.length?<><input className="workspace-file-input" ref={engineersInputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleEngineersFile(event.target.files?.[0]);event.target.value=''}}/><EngineerList team={team}/></>:<EngineerUploadPanel inputRef={engineersInputRef} onFile={handleEngineersFile}/>}</section>:<section className={`orders-panel route-list-panel ${zones.length||districts.length?'has-district-filter':''}`}><div className="panel-status-row"><div className="status-tabs"><button className={!scheduled?'selected':''} onClick={()=>setScheduled(false)}>Не назначены{orders.length?<b>{plan?.metrics?.unassigned??orders.length}</b>:null}</button><button className={scheduled?'selected':''} onClick={()=>setScheduled(true)}>Назначены{plan?.metrics?.assigned?<b>{plan.metrics.assigned}</b>:null}</button></div><button type="button" className="panel-upload" onClick={()=>ordersInputRef.current?.click()} aria-label="Загрузить заявки" data-tooltip="Загрузить заявки"><Plus/></button></div><div className="panel-heading"><div><h3>{scheduled?'Маршруты':'Заявки'}</h3></div><div className="panel-heading-actions">{orders.length?<button type="button" className="panel-emergency" onClick={onEmergency} aria-label="Новая авария" data-tooltip="Новая авария"><AlertTriangle/></button>:null}<button type="button" className="panel-plan-action" disabled={!orders.length} onClick={openPlan}><WandSparkles/>{plan?'Пересчитать':'Построить план'}</button></div></div>{zones.length||districts.length?<TerritoryFilter zones={zones} districts={districts} value={selectedTerritory} onChange={changeTerritory} total={orders.length}/>:null}{!orders.length?(scheduled?<RoutesEmpty/>:<UploadEmpty onFile={handleOrdersFile} inputRef={ordersInputRef}/>):scheduled&&displayPlan?<AssignmentBoard orders={filteredOrders} plan={displayPlan} team={team} onOrder={onOrder} onRoute={onRoute} onRouteDetails={onRouteDetails} onReassign={onReassign} onRecalculate={openPlan}/>:visibleOrders.length?<OrderList orders={visibleOrders} onOrder={onOrder} plan={displayPlan}/>:<div className="resolved-empty"><MapPinned/><h3>{selectedTerritory?'В выбранной территории нет заявок':'Все заявки распределены'}</h3><p>{selectedTerritory?'Выберите другую зону, район или сбросьте фильтр.':'Конфликтов и заявок для ручной обработки нет.'}</p></div>}</section>}
      <MapCanvas orders={mapItems} team={team} scheduled={!engineersMode&&scheduled} onOrder={engineersMode?()=>{}:onOrder} onRoute={onRoute} uiTheme={uiTheme} geocodeProgress={geocodeProgress} onClearGeocodeProgress={onClearGeocodeProgress} selectedOrder={engineersMode?null:selectedOrder} selectedTerritory={engineersMode?'':selectedTerritory} routes={engineersMode?[]:(displayPlan?.routes||[])} activeRoute={engineersMode?null:activeRoute}/>
    </div>
  </main>;
}
function ObjectsPage({orders}){const data=orders.slice(0,8);return <PageShell title="Объекты" action={<button className="primary"><Plus/>Добавить объект</button>}>{data.length?<div className="object-grid">{data.map(o=><article key={o.id}><div><Building2/><span className="ok"><Check/></span></div><h3>{o.name}</h3><p>{o.address}</p><small>{o.phone}</small></article>)}</div>:<div className="big-empty"><img className="empty-mascot objects-mascot" src="/mascot-empty-objects.png" alt=""/><h2>Объектов пока нет</h2><p>Они появятся после сохранения клиентов из заявок</p><button className="primary"><Plus/>Добавить объект</button></div>}</PageShell>}
function AnalyticsPage({orders,team,plan,analyticsDate,setAnalyticsDate,onOpenUnassigned,onOpenRoutes,onPreviewReplan,onApplyReplan,onRollbackReplan,onStartLiveReplan}){return <PageShell title="Аналитика"><AnalyticsWorkspace orders={orders} team={team} plan={plan} date={analyticsDate} onDateChange={setAnalyticsDate} dateControl={<DateControl className="analytics-date-control" value={analyticsDate} onChange={setAnalyticsDate}/>} onOpenUnassigned={onOpenUnassigned} onOpenRoutes={onOpenRoutes} onPreviewReplan={onPreviewReplan} onApplyReplan={onApplyReplan} onRollbackReplan={onRollbackReplan} onStartLiveReplan={onStartLiveReplan}/></PageShell>}
function PreferencesPage(){const[tab,setTab]=useState('limits');return <PageShell title="Настройки маршрутов"><div className="prefs"><aside><button className={tab==='templates'?'active':''} onClick={()=>setTab('templates')}>Шаблоны маршрутов</button><button className={tab==='limits'?'active':''} onClick={()=>setTab('limits')}>Параметры оптимизации</button><button>Матрица совместимости</button><button>Модель пробок</button></aside><section><h2>{tab==='limits'?'Параметры оптимизации':'Шаблоны маршрутов'}</h2><p>Изменения применятся при следующем расчёте или перепланировании.</p>{tab==='limits'?<>{[['Балансировать маршруты','Равномерно распределять рабочее время.',true],['Гибкое начало смены','Сдвигать старт ради меньшего времени в пути.',true],['Учитывать прогноз пробок','Использовать коэффициенты по времени суток.',true],['Разрешить сверхурочные','Допускать работу за пределами смены.',false],['Разрешить опоздания','Допускать выход за временное окно.',false],['Исключить платные дороги','Не строить путь через платные участки.',true]].map(x=><div className="pref-row" key={x[0]}><div><b>{x[0]}</b><small>{x[1]}</small></div><i className={x[2]?'on':''}><b/></i></div>)}</>:<div className="template-card"><div><Route/><b>Стандартная смена</b><em>Активен</em></div><p>08:00–18:00 · старт со склада · до 8 заявок</p><button>Редактировать</button></div>}</section></div></PageShell>}
function SettingsPage({settings,setSettings,region,setRegion,onToast}){const[tab,setTab]=useState('company');const update=(key,value)=>setSettings(current=>({...current,[key]:value}));const save=()=>{onToast('Настройки рабочего пространства сохранены');try{localStorage.setItem('beego-settings',JSON.stringify(settings))}catch{}};const navigation=[['company','Компания',Building2],['regions','Рабочие пространства',MapPinned],['planning','Планирование',SlidersHorizontal],['norms','Нормативы',Clock3],['data','Импорт данных',Database],['integrations','Интеграции',ServerCog]];return <PageShell title="Настройки" action={<button className="primary" onClick={save}><Save/>Сохранить изменения</button>}><div className="settings-overview"><div><span className="settings-brand"><Activity/></span><div><b>BeeGo! Operations</b><p>Конфигурация диспетчерского пространства и точного планировщика</p></div></div><span className="backend-status"><i/> Backend доступен · Exact v2.1</span></div><div className="settings-layout settings-modern"><aside>{navigation.map(([id,label,Icon])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}><Icon/><span>{label}</span><ChevronRight/></button>)}</aside><section>{tab==='company'?<><div className="settings-heading"><div><small>ОРГАНИЗАЦИЯ</small><h2>Профиль компании</h2><p>Общие данные, которые видит команда диспетчеров.</p></div></div><div className="form-card settings-card"><div className="card-title"><Building2/><div><h3>Основные данные</h3><p>Название и контакты рабочего пространства</p></div></div><label>Название компании<input value={settings.company} onChange={event=>update('company',event.target.value)}/></label><div className="form-row"><label>Рабочий email<input value={settings.email} onChange={event=>update('email',event.target.value)}/></label><label>Телефон<input value={settings.phone} onChange={event=>update('phone',event.target.value)}/></label></div></div><div className="form-card settings-card"><div className="card-title"><Clock3/><div><h3>Локализация</h3><p>Единые правила отображения времени и расстояний</p></div></div><div className="choice-row"><button className="selected">Километры <Check/></button><button className="selected">24-часовой формат <Check/></button><button className="selected">Москва, UTC+3 <Check/></button></div></div></>:null}{tab==='regions'?<><div className="settings-heading"><small>РАБОЧИЕ ПРОСТРАНСТВА</small><h2>Независимые регионы</h2><p>У каждого региона свой офис, заявки и команда. Данные между участками не смешиваются.</p></div><div className="region-settings-grid">{REGIONS.map(item=><button key={item.id} className={region.id===item.id?'selected':''} onClick={()=>setRegion(item)}><span>{item.code}</span><div><b>{item.name}</b><small>{item.office}</small><em>{ENGINEERS.filter(engineer=>engineer.regionId===item.id).length} инженеров</em></div>{region.id===item.id?<Check/>:null}</button>)}</div><div className="form-card settings-card"><div className="card-title"><MapPin/><div><h3>Стартовая точка участка</h3><p>Все исполнители начинают день из одного офиса</p></div></div><label>Адрес офиса<input value={region.office} readOnly/></label><div className="read-only-note"><LockKeyhole/> Офис связан с регионом и передаётся в планировщик как depot.</div></div></>:null}{tab==='planning'?<><div className="settings-heading"><small>АЛГОРИТМ</small><h2>Правила планирования</h2><p>Эти параметры передаются в backend при каждом расчёте.</p></div>{[['balance','Балансировать загрузку','Распределять рабочее время между инженерами равномернее.'],['prioritizeUrgent','Аварии всегда первыми','Срочные заявки могут вытеснять обычные работы.'],['lockManual','Сохранять ручные назначения','Закреплённые диспетчером заявки не перестраиваются.'],['allowLate','Разрешать опоздания','Допускать начало позже конца клиентского окна.']].map(([key,title,description])=><button className="pref-row settings-toggle" key={key} onClick={()=>update(key,!settings[key])}><div><b>{title}</b><small>{description}</small></div><i className={settings[key]?'on':''}><b/></i></button>)}</>:null}{tab==='norms'?<><div className="settings-heading"><small>НОРМАТИВЫ</small><h2>Продолжительность работ</h2><p>Значения сверяются с таблицей нормативов набора данных.</p></div><div className="norm-grid">{[['Локальные работы','60','мин'],['Дозаказ','60','мин'],['Подключение','90','мин'],['Аварийные работы','90','мин']].map(([label,value,unit])=><label key={label}><span>{label}</span><div><input defaultValue={value}/><em>{unit}</em></div></label>)}</div><div className="read-only-note"><Clock3/> Клиентское окно ограничивает время начала работы; завершение может выйти за его пределы.</div></>:null}{tab==='data'?<><div className="settings-heading"><small>ДАННЫЕ</small><h2>Импорт заявок</h2><p>Проверка обязательных полей и повторное сопоставление колонок.</p></div><div className="schema-list">{[['Адрес и координаты','Обязательно'],['Клиентское окно','Обязательно'],['Тип работ и норматив','Обязательно'],['Приоритет и оборудование','Опционально']].map(([name,status])=><div key={name}><Check/><span>{name}</span><em>{status}</em></div>)}</div><button className="secondary-action"><RefreshCw/>Сбросить сопоставление колонок</button></>:null}{tab==='integrations'?<><div className="settings-heading"><small>ИНТЕГРАЦИИ</small><h2>Готовность backend</h2><p>Интерфейс отображает только план EXACT_VALID с независимой проверкой VALID.</p></div><div className="integration-list"><article><span className="integration-icon connected"><ServerCog/></span><div><b>Planning API</b><p>POST /api/plan · OR-Tools CP-SAT и жёсткие ограничения</p></div><em>Подключено</em></article><article><span className="integration-icon connected"><RefreshCw/></span><div><b>Manual override API</b><p>POST /api/reassign · ручные назначения и блокировки</p></div><em>Подключено</em></article><article><span className="integration-icon connected"><Map/></span><div><b>Матрица маршрутов</b><p>Локальная Valhalla и расписания московского транспорта</p></div><em>Подключено</em></article></div></>:null}</section></div></PageShell>}
function Onboarding({onClose}){return <Modal onClose={onClose}><div className="onboarding"><Brand staticMark/><h1>Добро пожаловать в BeeGo!</h1><p>Настроим рабочий день выездной команды</p><label>Откуда начинают работу?<div className="input-like"><MapPin/>Выберите стартовую точку<ChevronDown/></div></label><div className="shift-row"><label>Начало<input value="08:00" readOnly/></label><label>Конец<input value="18:00" readOnly/></label></div><div className="onboarding-note"><Sparkles/>Затем загрузите заявки — мы автоматически распределим их по навыкам, времени и транспорту.</div><footer><button onClick={onClose}>Пропустить</button><button className="primary" onClick={onClose}>Начать планирование</button></footer></div></Modal>}
function SettingsModal({onClose,...props}){return <div className="modal-backdrop settings-modal-layer" role="dialog" aria-modal="true" aria-label="Настройки BeeGo!" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><section className="modal wide settings-modal-dialog"><button className="settings-modal-close" onClick={onClose} aria-label="Закрыть настройки" data-tooltip="Закрыть"><X/></button><SettingsPage {...props}/></section></div>}
export function App(){
  const[settingsOpen,setSettingsOpen]=useState(false);
  const[expanded,setExpanded]=useState(true),[screen,setScreen]=useState('routes');const[theme,setTheme]=useState(()=>{try{return localStorage.getItem('beego-theme')==='dark'?'dark':'light'}catch{return'light'}});const[profile,setProfile]=useState(()=>{try{return {...{name:'Юлия Кузнецова',role:'dispatcher',email:'y.kuznetsova@beego.ru',avatar:''},...JSON.parse(localStorage.getItem('beego-profile')||'{}')}}catch{return{name:'Юлия Кузнецова',role:'dispatcher',email:'y.kuznetsova@beego.ru',avatar:''}}}),[profileOpen,setProfileOpen]=useState(false),[helpOpen,setHelpOpen]=useState(false);const[region,setRegion]=useState(REGIONS[0]);const[orders,setOrders]=useState([]),[engineers,setEngineers]=useState([]),[importSession,setImportSession]=useState(null);const[plan,setPlan]=useState(null),[planOpen,setPlanOpen]=useState(false);const[scheduled,setScheduled]=useState(false),[view,setView]=useState('timeline');const[selectedDate,setSelectedDate]=useState(()=>startOfDay(new Date())),[analyticsDate,setAnalyticsDate]=useState(()=>startOfDay(new Date()));const[selectedOrder,setSelectedOrder]=useState(null),[routeDetail,setRouteDetail]=useState(null),[focusedRoute,setFocusedRoute]=useState(null);const[optimizing,setOptimizing]=useState(false),[toast,setToast]=useState(null),[geocodeProgress,setGeocodeProgress]=useState(null),[replanSnapshot,setReplanSnapshot]=useState(null);const[notifications,setNotifications]=useState(()=>{try{const stored=JSON.parse(localStorage.getItem('beego-notifications')||'[]');return Array.isArray(stored)?stored:[]}catch{return[]}}),[notificationsOpen,setNotificationsOpen]=useState(false);const toastTimersRef=useRef([]);const[onboarding,setOnboarding]=useState(true);const[settings,setSettings]=useState(()=>{const defaults={company:'Билайн Бизнес',email:'team@beego.ru',phone:'+7 999 000-00-00',balance:true,prioritizeUrgent:true,lockManual:true,allowLate:false};try{return{...defaults,...JSON.parse(localStorage.getItem('beego-settings')||'{}')}}catch{return defaults}});
  useEffect(()=>{setSelectedDate(startOfDay(new Date()))},[]);
  useEffect(()=>{try{localStorage.setItem('beego-theme',theme)}catch{}document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;const themeMeta=document.querySelector('meta[name="theme-color"]');if(themeMeta)themeMeta.setAttribute('content',theme==='dark'?'#17191D':'#FFD21F')},[theme]);
  useEffect(()=>{try{localStorage.setItem('beego-profile',JSON.stringify(profile))}catch{}},[profile]);
  useEffect(()=>{try{localStorage.setItem('beego-notifications',JSON.stringify(notifications.slice(0,40)))}catch{}},[notifications]);
  useEffect(()=>()=>toastTimersRef.current.forEach(clearTimeout),[]);
  useEffect(()=>{if(selectedOrder){setHelpOpen(false);setNotificationsOpen(false)}},[selectedOrder]);
  const notify=(message,{title='BeeGo!',showToast=true}={})=>{const item={id:`notification-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,title,message,time:new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),read:false};setNotifications(current=>[item,...current].slice(0,40));if(!showToast)return;toastTimersRef.current.forEach(clearTimeout);setToast({...item,closing:false});toastTimersRef.current=[setTimeout(()=>setToast(current=>current?{...current,closing:true}:current),3800),setTimeout(()=>setToast(null),4200)]};
  const toggleNotifications=()=>setNotificationsOpen(open=>{const next=!open;if(next){setHelpOpen(false);setSelectedOrder(null);setRouteDetail(null);setNotifications(current=>current.map(item=>({...item,read:true})))}return next});
  const regionOrders=useMemo(()=>orders.filter(order=>order.regionId===region.id),[orders,region.id]);const team=useMemo(()=>engineers.filter(engineer=>engineer.regionId===region.id),[engineers,region.id]);
  useEffect(()=>{setPlan(null);setScheduled(false);setSelectedOrder(null);setRouteDetail(null);setFocusedRoute(null);setReplanSnapshot(null)},[region.id]);
  const showMapping=session=>{const suggestedRegion=REGIONS.find(item=>item.id===session.suggestedRegionId);if(suggestedRegion&&suggestedRegion.id!==region.id){setRegion(suggestedRegion);notify(`По адресам файла выбран участок «${suggestedRegion.name}»`)}setImportSession(session);setProfileOpen(false);setSettingsOpen(false)};
  const importRows=async({orders:nextOrders=[],engineers:nextEngineers=[]})=>{
    const replaceRegionOrders=next=>setOrders(current=>[...current.filter(order=>order.regionId!==region.id),...next]);
    if(nextOrders.length)replaceRegionOrders(nextOrders);
    if(nextEngineers.length)setEngineers(current=>[...current.filter(engineer=>engineer.regionId!==region.id),...nextEngineers]);
    setPlan(null);setImportSession(null);setScheduled(false);setSelectedOrder(null);
    const parts=[nextOrders.length?`${nextOrders.length} заявок`:'',nextEngineers.length?`${nextEngineers.length} инженеров`:''].filter(Boolean);
    const missing=nextOrders.filter(order=>!Array.isArray(order.coords)||order.coords.length!==2||!order.coords.every(Number.isFinite));
    if(!missing.length){notify(`${parts.join(' и ')} загружено в участок «Москва»`);return}
    try{
      const geocoded=await geocodeImportedOrders(nextOrders,setGeocodeProgress,replaceRegionOrders);
      replaceRegionOrders(geocoded);
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
  const optimize=async options=>{setOptimizing(true);try{const next=await requestPlan(regionOrders,engineers,region.id,{...settings,...options});setPlan(next);setPlanOpen(false);setScheduled(true);setFocusedRoute(null);setView('timeline');notify(`Точный план проверен: распределено ${next.metrics.assigned} из ${next.metrics.total}. Для ручного решения: ${next.metrics.unassigned}`,{title:'План готов'})}catch(error){notify(error?.message||'Не удалось построить точный план',{title:'Планирование не выполнено'})}finally{setOptimizing(false)}};
  const previewReplan=async(model,basePlan)=>{if(model.event?.type==='ENGINEER_UNAVAILABLE')return buildDynamicReplan(model.orders,model.team,basePlan,model.event);try{return await requestPlan(model.orders,model.team,region.id,settings)}catch(error){if(error?.code!=='UNSEALED_DATASET'||!basePlan)throw error;return buildDynamicReplan(model.orders,model.team,basePlan,model.event)}};
  const applyReplan=({orders:nextOrders,team:nextTeam,plan:nextPlan})=>{setReplanSnapshot({orders:regionOrders,team,plan,scheduled});setOrders(current=>[...current.filter(order=>order.regionId!==region.id),...nextOrders]);setEngineers(current=>[...current.filter(engineer=>engineer.regionId!==region.id),...nextTeam]);setPlan(nextPlan);setScheduled(true);setSelectedOrder(null);setRouteDetail(null);setFocusedRoute(null);notify(`Проверенный план принят: распределено ${nextPlan.metrics.assigned} из ${nextPlan.metrics.total}.`,{title:'Перепланирование применено'});};
  const rollbackReplan=()=>{if(!replanSnapshot)return;setOrders(current=>[...current.filter(order=>order.regionId!==region.id),...replanSnapshot.orders]);setEngineers(current=>[...current.filter(engineer=>engineer.regionId!==region.id),...replanSnapshot.team]);setPlan(replanSnapshot.plan);setScheduled(replanSnapshot.scheduled);setReplanSnapshot(null);notify('Предыдущий опубликованный план восстановлен.',{title:'Изменения отменены'});};
  const reassign=async(orderId,engineerId)=>{const order=regionOrders.find(item=>item.id===orderId);const engineer=team.find(item=>item.id===engineerId);if(!order||!engineer||!plan)return;try{const response=await fetch('/api/reassign',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({planId:plan.id,orderId,engineerId})});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error||'Ручное назначение не прошло проверку');notify(`${order.name}: ${engineer.name}`,{title:'Назначение сохранено'})}catch(error){notify(error?.message||'Для ручного назначения нужен повторный точный расчёт',{title:'План не изменён'})}};
  const addEmergency=async()=>{if(regionOrders.some(order=>order.sourceId==='EAST-EVENT-001')){notify('Контрольная аварийная заявка уже загружена',{title:'Событие уже учтено'});return}setOptimizing(true);try{const response=await fetch('/api/scenario/event');const payload=await response.json().catch(()=>({}));if(!response.ok||!payload.order)throw new Error(payload.error||'Контрольное событие недоступно');const nextId=Math.max(0,...orders.map(order=>Number(order.id)||0))+1;const emergency={...payload.order,id:nextId};const nextOrders=[...regionOrders,emergency];const nextPlan=await requestPlan(nextOrders,engineers,region.id,settings);setOrders(current=>[...current,emergency]);setSelectedOrder(emergency);setPlan(nextPlan);setScheduled(true);notify('Аварийная заявка добавлена — точный событийный план проверен и опубликован',{title:'Перепланирование завершено'})}catch(error){notify(error?.message||'Не удалось перестроить точный план',{title:'Перепланирование не выполнено'})}finally{setOptimizing(false)}};
  const unreadNotifications=notifications.filter(item=>!item.read).length;
  const page=useMemo(()=>{const selectOrder=order=>{setRouteDetail(null);setSelectedOrder(order)};const focusRoute=route=>{setSelectedOrder(null);setFocusedRoute(route)};const openRouteDetails=route=>{setSelectedOrder(null);setFocusedRoute(route);setRouteDetail(route)};const workspaceProps={mode:screen==='engineers'?'engineers':'orders',orders:regionOrders,team,region,plan,scheduled,setScheduled,view,setView,openPlan:()=>setPlanOpen(true),onOrder:selectOrder,onRoute:focusRoute,onRouteDetails:openRouteDetails,onReassign:reassign,onEmergency:addEmergency,mapping:showMapping,onUploadError:notify,selectedDate,setSelectedDate,uiTheme:theme,geocodeProgress,onClearGeocodeProgress:()=>setGeocodeProgress(null),selectedOrder,activeRoute:focusedRoute};if(screen==='routes'||screen==='orders'||screen==='engineers')return <OperationalMapWorkspace {...workspaceProps}/>;if(screen==='objects')return <ObjectsPage orders={regionOrders}/>;if(screen==='analytics')return <AnalyticsPage orders={regionOrders} team={team} plan={plan} analyticsDate={analyticsDate} setAnalyticsDate={setAnalyticsDate} onOpenUnassigned={()=>{setScheduled(false);setScreen('routes')}} onOpenRoutes={engineerId=>{const route=plan?.routes?.find(item=>String(item.engineerId)===String(engineerId))||null;setSelectedOrder(null);setRouteDetail(null);setFocusedRoute(route);setScheduled(Boolean(plan));setView('timeline');setScreen('routes')}} onPreviewReplan={previewReplan} onApplyReplan={applyReplan} onRollbackReplan={rollbackReplan} onStartLiveReplan={()=>{setScheduled(false);setScreen('routes')}}/>;if(screen==='preferences')return <PreferencesPage/>;return <OperationalMapWorkspace {...workspaceProps} mode="orders"/>},[screen,regionOrders,team,plan,scheduled,view,selectedDate,analyticsDate,theme,settings,region,geocodeProgress,selectedOrder,focusedRoute,replanSnapshot]);
  return <div className={`app-shell ${theme==='dark'?'dark':''}`} style={{'--accent':ACCENT}}><Sidebar expanded={expanded} setExpanded={setExpanded} screen={screen} setScreen={next=>{setScreen(next);setSettingsOpen(false);setNotificationsOpen(false)}} orderCount={regionOrders.length} theme={theme} setTheme={setTheme} profile={profile} onProfile={()=>{setSettingsOpen(false);setNotificationsOpen(false);setProfileOpen(true)}} helpOpen={helpOpen} onHelp={()=>{setProfileOpen(false);setSettingsOpen(false);setNotificationsOpen(false);setSelectedOrder(null);setRouteDetail(null);setHelpOpen(open=>!open)}} settingsOpen={settingsOpen} onSettings={()=>{setProfileOpen(false);setNotificationsOpen(false);setSettingsOpen(open=>!open)}} region={region} setRegion={setRegion} notificationsOpen={notificationsOpen} onNotifications={toggleNotifications} unreadNotifications={unreadNotifications}/>{page}<NotificationCenter items={notifications} open={notificationsOpen} expanded={expanded} onClose={()=>setNotificationsOpen(false)} onClear={()=>setNotifications([])}/>{settingsOpen?<SettingsModal settings={settings} setSettings={setSettings} region={region} setRegion={setRegion} onToast={notify} onClose={()=>setSettingsOpen(false)}/>:null}{onboarding?<Onboarding onClose={()=>setOnboarding(false)}/>:null}{helpOpen?<HelpCenter profile={profile} onClose={()=>setHelpOpen(false)}/>:null}{profileOpen?<ProfileModal profile={profile} onClose={()=>setProfileOpen(false)} onSave={next=>{setProfile(next);setProfileOpen(false);notify('Профиль сохранён')}}/>:null}{importSession?<ImportWorkspace session={importSession} region={region} onCancel={()=>setImportSession(null)} onImport={importRows}/>:null}{planOpen?<PlanDrawer orders={regionOrders} team={team} onClose={()=>setPlanOpen(false)} onOptimize={optimize} optimizing={optimizing} selectedDate={selectedDate}/>:null}<DetailDrawer order={selectedOrder} route={routeDetail} orders={regionOrders} team={team} plan={plan} onReassign={reassign} onRecalculate={()=>{setSelectedOrder(null);setRouteDetail(null);setPlanOpen(true)}} onOpenRoute={nextRoute=>{setSelectedOrder(null);setFocusedRoute(nextRoute);setRouteDetail(nextRoute)}} onClose={()=>{setSelectedOrder(null);setRouteDetail(null)}}/>{toast?<div className={`toast ${toast.closing?'is-closing':''}`}><Check/><span><b>{toast.title}</b>{toast.message}</span><button onClick={()=>{setToast(current=>current?{...current,closing:true}:current);setTimeout(()=>setToast(null),340)}}><X/></button></div>:null}</div>
}
