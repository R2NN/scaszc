import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  BarChart3, BriefcaseBusiness, Building2, CalendarDays, Car, Check,
  ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  CircleHelp, Clock3, Download, FileSpreadsheet, FileUp, Filter, Gauge,
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
import { useWorkspacePresence } from './useWorkspacePresence.js';
import { displayOrderName, workPointType } from './workTypes.js';
import { ZONE_LABELS, normalizeTerritoryKey, zoneBoundaryName, zoneCode } from './territoryAliases.js';
import { captureMapCamera, restoredCameraOptions } from './locationPrivacy.js';
import { resolveImportedDate } from './importDate.js';
import { parseSharedStockCsv, sharedStockRequirements, SHARED_STOCK_LABELS, stockOverrides } from './sharedInventory.js';
import sharedStockCsv from '../data/dataset/core/shared_inventory.csv?raw';
import { DEFAULT_REGION, regionCatalog } from './regions.js';
import depotMarkerPurple from './assets/depot-marker-purple.png';
import { MAP_SCALE, MAP_UI, groupGeographicMarkers, routeModeForCount, shouldClusterOrders, shouldShowRouteNumbers, stableRouteColor } from './mapDesign.js';
import { AnalyticsWorkspace } from './AnalyticsWorkspace.jsx';

maplibregl.setWorkerUrl(mapLibreWorkerUrl);
const MAP_WORKER_COUNT=Math.min(4,Math.max(2,Math.ceil((navigator.hardwareConcurrency||4)/2)));
maplibregl.setWorkerCount(MAP_WORKER_COUNT);
maplibregl.prewarm();

const ACCENT = '#FFD21F';
const DEFAULT_MAP_CENTER = [55.7558, 37.6173];
const DEFAULT_MAP_ZOOM = 10;
const MAP_MIN_ZOOM = 2;
const MAP_MAX_ZOOM = 19;
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
  ['review', Database, 'Данные'],
  ['analytics', BarChart3, 'Аналитика'],
];
const OVERLAY_SCREENS=new Set(['analytics','locations']);
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
const PROFILE_AVATAR_TONES = [
  {id:'honey',label:'Медовый',color:'#FFF1A8'},
  {id:'mint',label:'Мятный',color:'#DDF5E9'},
  {id:'sky',label:'Небесный',color:'#DDEBFF'},
  {id:'lilac',label:'Сиреневый',color:'#E9E0FF'},
  {id:'peach',label:'Персиковый',color:'#FFE2D6'},
  {id:'rose',label:'Розовый',color:'#FFE0EA'},
  {id:'silver',label:'Серебристый',color:'#E7EAEE'},
];

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

const toMinutes=value=>{const[h,m]=String(value||'08:00').split(':').map(Number);return h*60+m};
const durationLabel=value=>`${Math.floor(value/60)?`${Math.floor(value/60)} ч `:''}${value%60?`${value%60} мин`:''}`.trim();
const unassignedExplanation=item=>{
  if(item?.reasonCode==='NO_EXACT_FEASIBLE_INSERTION_IN_CURRENT_ROUTES')return{
    title:'Не поместилась в текущий план',
    summary:'Алгоритм не нашёл для заявки свободное место в уже рассчитанных маршрутах, которое одновременно соблюдает клиентское окно, длительность работы и смену инженера.',
    action:'Что делать: запустить полный пересчёт дня, расширить клиентское окно или добавить доступную бригаду.',
  };
  return{title:'Нужно решение диспетчера',summary:item?.reason||'Заявку не удалось безопасно включить в проверенный план.',action:'Откройте полный пересчёт, чтобы алгоритм заново проверил все маршруты.'};
};
async function requestPlan(orders,team,regionId,planningDate,sharedInventory=[]){
  const response=await fetch('/api/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orders,engineers:team,regionId,planningDate,sharedInventory})});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'Точный планировщик временно недоступен');
  if(payload.status!=='EXACT_VALID'||payload.publicationAllowed!==true||payload.validation?.status!=='VALID')throw new Error('Алгоритм не разрешил публикацию непроверенного плана');
  return payload;
}
async function requestReplan(model,basePlan){
  const response=await fetch('/api/replan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orders:model.orders,team:model.team,event:model.event,basePlanContentSha256:basePlan.contentSha256})});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'Точный сервис перепланирования недоступен');
  if(payload.status!=='EXACT_VALID'||payload.publicationAllowed!==true||payload.validation?.status!=='VALID')throw new Error('Перепланирование не прошло независимую точную проверку');
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
function ProfileAvatar({profile,className=''}){const tone=PROFILE_AVATAR_TONES.find(item=>item.id===(profile.avatarTone||'honey'))||PROFILE_AVATAR_TONES[0];const style={backgroundColor:tone.color,color:'#2b2e32'};return profile.avatar?<img className={`profile-avatar ${className}`} style={style} src={`/avatars/${profile.avatar}.png`} alt=""/>:<span className={`profile-initials ${className}`} style={style}>{profile.name.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase()||'ЮК'}</span>}
function Sidebar({expanded,setExpanded,screen,setScreen,workspacePanelOpen=true,orderCount,theme,setTheme,profile,onProfile,helpOpen,onHelp,settingsOpen,onSettings,region,notificationsOpen,onNotifications,unreadNotifications=0,hasReviewData=false,onOpenReview}){const[logoRunning,setLogoRunning]=useState(false);const[sidebarAnimating,setSidebarAnimating]=useState(false);const[suppressSidebarTooltips,setSuppressSidebarTooltips]=useState(false);const sidebarAnimationTimerRef=useRef(null),tooltipSuppressTimerRef=useRef(null);useEffect(()=>()=>{clearTimeout(sidebarAnimationTimerRef.current);clearTimeout(tooltipSuppressTimerRef.current)},[]);const beginSidebarTransition=()=>{setSidebarAnimating(true);setSuppressSidebarTooltips(true)};const toggleSidebar=event=>{event.currentTarget.blur();setSidebarAnimating(true);setSuppressSidebarTooltips(true);setExpanded(value=>!value);clearTimeout(sidebarAnimationTimerRef.current);clearTimeout(tooltipSuppressTimerRef.current);sidebarAnimationTimerRef.current=setTimeout(()=>setSidebarAnimating(false),560);tooltipSuppressTimerRef.current=setTimeout(()=>setSuppressSidebarTooltips(false),1400)};return <aside className={`sidebar ${expanded?'expanded':''} ${notificationsOpen?'notifications-active':''} ${sidebarAnimating?'is-transitioning':''} ${suppressSidebarTooltips?'suppress-tooltips':''}`}>
  <button className="brand-row brand-home" onPointerEnter={()=>setLogoRunning(true)} onClick={()=>setScreen('orders')} aria-label="BeeGo! — на главную"><Brand staticMark running={logoRunning} onAnimationEnd={()=>setLogoRunning(false)}/><span className="brand-wordmark"><b>Bee</b><strong>Go!</strong></span></button>
  <nav><button className={`sidebar-location-button ${screen==='locations'&&!notificationsOpen?'active':''}`} onClick={()=>setScreen('locations')} aria-label={`Локации: ${region.name}`} data-tooltip={`Локации: ${region.name}`}><MapPinned/><em>{region.name}</em></button>{navItems.filter(([id])=>id!=='review'||hasReviewData).map(([id,Icon,label])=><button key={id} className={screen===id&&!notificationsOpen&&(!['orders','engineers'].includes(id)||workspacePanelOpen)?'active':''} onClick={id==='review'?onOpenReview:()=>setScreen(id,{togglePanel:true})} aria-label={label} data-tooltip={label}><Icon/><em>{label}</em></button>)}<button className={`sidebar-notification-button ${notificationsOpen?'active':''}`} onClick={onNotifications} aria-label="Уведомления" data-tooltip="Уведомления"><Bell/><span className="notification-label"><em>Уведомления</em>{unreadNotifications?<small className="notification-nav-badge" aria-label="Есть новые уведомления"/>:null}</span></button></nav>
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
  let safetyTimer;
  const restore=()=>{
    clearTimeout(safetyTimer);
    map.off('moveend',restore);
    map.cancelPendingTileRequestsWhileZooming=previous;
  };
  map.once('moveend',restore);
  safetyTimer=setTimeout(restore,2400);
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
  const selected=territorySelection(value),selectedItem=(selected.kind==='zone'?zones:districts).find(item=>item.name===selected.name);
  const selectionType=selected.kind==='zone'?'Зона из таблицы':selected.kind==='district'?'Район Москвы':'Выбор территории';
  return <div className="district-filter" ref={rootRef}><button type="button" className={value?'active':''} onClick={()=>setOpen(current=>!current)} aria-haspopup="listbox" aria-expanded={open}><MapPinned/><span className="district-filter-copy"><small>{value?`Выбрано · ${selectionType}`:selectionType}</small><b>{selected.name||'Все территории'}</b></span><em>{value?selectedItem?.count||0:total}</em><span className="district-filter-action"><span>{open?'Закрыть':value?'Изменить':'Выбрать'}</span><ChevronRight/></span></button>{presence.present?<div className={`district-filter-menu dropdown-transition ${presence.visible?'is-open':'is-closing'}`} role="listbox" aria-label="Выбор территории"><button type="button" className={!value?'selected':''} role="option" aria-selected={!value} onClick={()=>choose('')}><span className="district-all-icon"><Map/></span><div><b>Все территории</b><small>Все районы и зоны · показать все заявки</small></div><em>{total}</em>{!value?<Check/>:null}</button>{zones.length?<><div className="district-filter-section-title"><Layers3/>Зоны из таблицы</div>{zones.map(item=>{const key=`zone:${item.name}`;return <button type="button" className={value===key?'selected':''} role="option" aria-selected={value===key} key={key} onClick={()=>choose(key)}><span className="district-zone-icon"><Layers3/></span><div><b>{item.name}</b><small>{item.count} {item.count===1?'заявка':'заявок'}</small></div><em>{item.count}</em>{value===key?<Check/>:null}</button>})}</>:null}{districts.length?<><div className="district-filter-section-title"><MapPinned/>Районы Москвы</div>{districts.map(item=>{const key=`district:${item.name}`;return <button type="button" className={value===key?'selected':''} role="option" aria-selected={value===key} key={key} onClick={()=>choose(key)}><span className="district-dot"/><div><b>{item.name}</b><small>{item.count} {item.count===1?'заявка':'заявок'}</small></div><em>{item.count}</em>{value===key?<Check/>:null}</button>})}</>:null}</div>:null}</div>;
}

function MapHierarchyPanel({open,onToggle,mode,onModeChange,routeCount,activeRoute,orders,plan}){
  const urgentCount=orders.filter(order=>order.priority==='Авария'||workPointType(order)==='emergency').length;
  const reviewCount=orders.filter(order=>order.geocodeStatus==='review').length;
  const unassignedCount=plan?.unassigned?.length||0;
  const color=activeRoute?MAP_UI.routeSelected:MAP_UI.routeNeutral;
  const colorsAvailable=routeCount<=8;
  return <aside className={`map-hierarchy-panel ${open?'is-open':'is-compact'}`} aria-label="Обозначения карты">
    <button type="button" className="map-legend-toggle" onClick={onToggle} aria-expanded={open}><Layers3/><span>Легенда</span><ChevronDown/></button>
    {open?<div className="map-hierarchy-body">
      <div className="map-mode-switch" role="group" aria-label="Режим отображения маршрутов"><button type="button" className={mode==='focus'?'selected':''} onClick={()=>onModeChange('focus')}><LocateFixed/>Фокус</button><button type="button" className={mode==='brigades'?'selected':''} disabled={!colorsAvailable} title={colorsAvailable?'Цвет закреплён за бригадой':'Доступно, когда на карте не более 8 маршрутов'} onClick={()=>onModeChange('brigades')}><Route/>Цвета</button></div>
      {!colorsAvailable?<p className="map-mode-note">Для {routeCount} маршрутов включён спокойный режим фокуса.</p>:null}
      <div className="map-legend-items">
        <span><i className="legend-route" style={{'--legend-color':color}}/>{activeRoute?activeRoute.engineerName:'Все маршруты · нейтрально'}</span>
        <span><i className="legend-point"/>Назначена</span>
        {urgentCount?<span><i className="legend-urgent">⚡</i>Срочные · {urgentCount}</span>:null}
        {unassignedCount?<span><i className="legend-unassigned">!</i>Не вошли · {unassignedCount}</span>:null}
        {reviewCount?<span><i className="legend-review">?</i>Проверить адрес · {reviewCount}</span>:null}
        <span><i className="legend-start"><House/></i>Старт бригады</span>
      </div>
    </div>:null}
  </aside>;
}

function MapCanvas({orders,team=[],scheduled,onOrder,onRoute,onRouteDetails,onOrderHover,onRouteHover,hoveredOrderId,hoveredRouteId,uiTheme,region,geocodeProgress,onClearGeocodeProgress,selectedOrder,selectedTerritory,routes=[],plan=null,activeRoute=null,engineerPopup=null}){
  const storedMapTheme=()=>{try{return localStorage.getItem('beego-map-theme')||''}catch{return''}};
  const[popupsEnabled,setPopupsEnabled]=useState(true),[map,setMap]=useState(null),[mapTheme,setMapTheme]=useState(()=>storedMapTheme()||(uiTheme==='dark'?'night':'day')),[themePickerOpen,setThemePickerOpen]=useState(false),[is3D,setIs3D]=useState(false),[locating,setLocating]=useState(false),[locationVisible,setLocationVisible]=useState(false),[locationMessage,setLocationMessage]=useState(''),[locationPrompt,setLocationPrompt]=useState(null),[routeDisplayMode,setRouteDisplayMode]=useState('focus'),[legendOpen,setLegendOpen]=useState(true),[mapHoveredRouteId,setMapHoveredRouteId]=useState(null);
  const containerRef=useRef(null),markersRef=useRef([]),clusterMarkersRef=useRef([]),startMarkersRef=useRef([]),locationMarkerRef=useRef(null),locationCameraRef=useRef(null),themePickerRef=useRef(null),districtRequestRef=useRef(null),lastLocationPromptRef=useRef('request'),previousScheduledRef=useRef(scheduled),lastFittedRouteRef=useRef(''),manualMapThemeRef=useRef(Boolean(storedMapTheme())),markerPresentationRef=useRef(()=>{}),selectedOrderRef=useRef(selectedOrder),activeRouteRef=useRef(activeRoute),activeOrderIdsRef=useRef(new Set()),onOrderRef=useRef(onOrder),onRouteRef=useRef(onRoute),onRouteDetailsRef=useRef(onRouteDetails),onOrderHoverRef=useRef(onOrderHover),onRouteHoverRef=useRef(onRouteHover),routesRef=useRef(routes);
  onOrderRef.current=onOrder;
  onRouteRef.current=onRoute;
  onRouteDetailsRef.current=onRouteDetails;
  onOrderHoverRef.current=onOrderHover;
  onRouteHoverRef.current=onRouteHover;
  routesRef.current=routes;
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
  const effectiveRouteMode=routeModeForCount(routeDisplayMode,visibleRouteCount);
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
    const visibleRoutes=routes.filter(route=>route.assignments?.length);
    const starts=visibleRoutes.map(route=>{const engineer=team.find(item=>String(item.id)===String(route.engineerId));return engineer&&Array.isArray(engineer.startCoords)&&engineer.startCoords.length===2?{route,engineer,coords:engineer.startCoords}:null}).filter(Boolean);
    const grouped=new globalThis.Map();
    starts.forEach(item=>{const key=item.coords.join(':');const current=grouped.get(key)||{...item,names:[],entries:[]};current.names.push(item.engineer.name);current.entries.push(item);grouped.set(key,current)});
    return[...grouped.values()];
  },[scheduled,routes,team]);
  const routeGeoJson=useMemo(()=>{
    if(!scheduled)return{type:'FeatureCollection',features:[]};
    const activeEngineerId=String(activeRoute?.engineerId??'');
    const visibleRoutes=routes.filter(route=>route.assignments?.length).sort((left,right)=>Number(String(left.engineerId)===activeEngineerId)-Number(String(right.engineerId)===activeEngineerId));
    return{type:'FeatureCollection',features:visibleRoutes.flatMap((route,routeIndex)=>{
      const engineerId=String(route.engineerId),isFocused=Boolean(activeEngineerId)&&engineerId===activeEngineerId,isHovered=Boolean(effectiveHoveredRouteId)&&engineerId===effectiveHoveredRouteId;
      const routeColor=stableRouteColor(engineerId);
      const routeGeometry=(route.geometry||[]).filter(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite));
      if(routeGeometry.length>=2)return[{type:'Feature',id:`${engineerId}-route`,properties:{engineerId:route.engineerId,active:isFocused,hovered:isHovered,routeColor,routeIndex,roadGeometry:true},geometry:{type:'LineString',coordinates:routeGeometry.map(([lat,lon])=>[lon,lat])}}];
      return route.assignments.flatMap((assignment,legIndex)=>{
        const geometry=(assignment.geometry||[]).filter(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite));
        if(geometry.length<2)return[];
        return[{type:'Feature',id:`${engineerId}-leg-${legIndex}`,properties:{engineerId:route.engineerId,active:isFocused,hovered:isHovered,routeColor,routeIndex,legIndex,roadGeometry:true},geometry:{type:'LineString',coordinates:geometry.map(([lat,lon])=>[lon,lat])}}];
      });
    })};
  },[scheduled,routes,activeRoute,effectiveHoveredRouteId]);

  useEffect(()=>{if(!manualMapThemeRef.current)setMapTheme(uiTheme==='dark'?'night':plan?'muted':'day')},[uiTheme,plan]);
  const chooseMapTheme=next=>{manualMapThemeRef.current=true;setMapTheme(next);try{localStorage.setItem('beego-map-theme',next)}catch{}};
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
    const clearClusters=()=>{clusterMarkersRef.current.forEach(item=>item.marker.remove());clusterMarkersRef.current=[]};
    const updateMarkerScale=()=>markersRef.current.forEach(({element})=>element?.style.setProperty('--marker-scale',String(markerScale())));
    const updateMarkerPresentation=()=>{
      const focusedRoute=activeRouteRef.current,currentActiveIds=activeOrderIdsRef.current,zoom=map.getZoom(),showNumbers=shouldShowRouteNumbers(zoom,Boolean(focusedRoute));
      clearClusters();
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
      const operational=markersRef.current.filter(item=>!item.isEngineerPoint);
      if(!operational.length||!shouldClusterOrders(zoom,Boolean(focusedRoute)))return;
      const selectedId=String(selectedOrderRef.current?.id??'');
      const candidates=operational.filter(item=>item.orderId!==selectedId);
      groupGeographicMarkers(candidates,item=>item.coords,zoom).forEach(group=>{
        if(group.length<2)return;
        group.forEach(item=>{item.element.style.display='none';item.popup?.remove()});
        const coords=group.reduce((result,item)=>[result[0]+item.coords[0]/group.length,result[1]+item.coords[1]/group.length],[0,0]);
        const urgent=group.some(item=>item.isUrgent),unassigned=group.some(item=>item.isUnassigned),manual=group.some(item=>item.manualReview);
        const element=document.createElement('button');element.type='button';element.className=`map-order-cluster${urgent?' has-urgent':''}${unassigned?' has-unassigned':''}${manual?' has-review':''}`;element.setAttribute('aria-label',`Группа: ${group.length} ${countForm(group.length,'заявка','заявки','заявок')}`);element.innerHTML=`<b>${group.length}</b><span aria-hidden="true"></span>`;
        element.addEventListener('click',()=>{const bounds=group.reduce((result,item)=>result.extend([item.coords[1],item.coords[0]]),new maplibregl.LngLatBounds([group[0].coords[1],group[0].coords[0]],[group[0].coords[1],group[0].coords[0]]));optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding:110,maxZoom:Math.min(12.2,zoom+2.2),duration:620,essential:true}))});
        const marker=new maplibregl.Marker({element,anchor:'center',subpixelPositioning:true}).setLngLat([coords[1],coords[0]]).addTo(map);clusterMarkersRef.current.push({marker,element});
      });
    };
    markerPresentationRef.current=updateMarkerPresentation;
    const sync=()=>{
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
        element.addEventListener('mouseenter',()=>onOrderHoverRef.current?.(order));
        element.addEventListener('mouseleave',()=>onOrderHoverRef.current?.(null));
        element.addEventListener('click',event=>{
          event.preventDefault();
          event.stopPropagation();
          const closingCurrentPopup=String(selectedOrderRef.current?.id??'')===String(order.id);
          startMarkersRef.current.forEach(item=>item.popup?.remove());
          markersRef.current.forEach(item=>item.popup?.remove());
          if(closingCurrentPopup){
            onOrderRef.current?.(null);
            return;
          }
          onOrderRef.current?.(order);
          if(popupsEnabled&&!order.suppressPopup)popup?.setLngLat([order.coords[1],order.coords[0]]).addTo(map);
        });
        let popup=null;
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
          header.append(heading,state);
          const title=document.createElement('p');
          title.className='map-popup-title';
          title.textContent=displayOrderName(order);
          content.append(header,title);
          const addRow=(label,value)=>{const row=document.createElement('div'),name=document.createElement('span'),leader=document.createElement('i'),text=document.createElement('b');row.className='map-popup-row';name.textContent=label;text.textContent=value;row.append(name,leader,text);content.append(row);return{row,text}};
          addRow('Местоположение',order.address||'Не указано');
          addRow('Окно клиента',order.start&&order.end?`${order.start}–${order.end}`:'Гибкое');
          if(order.workType||order.skill)addRow('Вид работ',order.workType||order.skill);
          addRow('Норматив работ',durationLabel(order.duration));
          if(order.priority&&order.priority!=='Обычная')addRow('Приоритет',order.priority);
          if(meta?.assignment?.arrival)addRow('Прибытие',meta.assignment.arrival);
          if(meta?.assignment?.plannedStart)addRow('Начало работ',meta.assignment.plannedStart);
          if(meta?.route?.engineerName)addRow('Бригада',meta.route.engineerName);
          if(coordinateGroup.length>1)addRow('В этой точке',`${coordinateGroup.length} ${requestWord} по одному адресу`);
          if(!plan){const note=document.createElement('p');note.className='map-popup-plan-note';note.textContent='Маршрут ещё не построен. Серый контур означает, что заявка ожидает распределения по бригаде.';content.append(note)}
          if(meta?.route){const routeAction=document.createElement('button'),copy=document.createElement('span'),title=document.createElement('b'),caption=document.createElement('small');routeAction.type='button';routeAction.className='map-popup-route-action';title.textContent='Показать маршрут бригады';caption.textContent=`${meta.route.engineerName} · ${meta.route.assignments.length} ${countForm(meta.route.assignments.length,'остановка','остановки','остановок')}`;copy.append(title,caption);routeAction.append(copy);routeAction.addEventListener('click',event=>{event.stopPropagation();popup?.remove();onRouteRef.current?.(meta.route)});content.append(routeAction)}
          if(issue){const copy=unassignedExplanation(issue),note=document.createElement('div'),noteTitle=document.createElement('b'),noteText=document.createElement('p');note.className='map-popup-issue';noteTitle.textContent=copy.title;noteText.textContent=copy.summary;note.append(noteTitle,noteText);content.append(note)}
          popup=new maplibregl.Popup({closeButton:true,closeOnClick:false,offset:28,maxWidth:'440px',className:'order-popup order-detail-popup'}).setDOMContent(content);
        }
        const duplicateIndex=coordinateGroup.indexOf(order),duplicateAngle=coordinateGroup.length>1?-Math.PI/2+(Math.PI*2*duplicateIndex/coordinateGroup.length):0,duplicateOffset=coordinateGroup.length>1?[Math.round(Math.cos(duplicateAngle)*14),Math.round(Math.sin(duplicateAngle)*14)]:[0,0];
        const marker=new maplibregl.Marker({element,anchor:'center',offset:duplicateOffset}).setLngLat([order.coords[1],order.coords[0]]).addTo(map);
        return{marker,popup,element,pin,order,orderId:String(order.id),coords:order.coords,baseLabel,isActive,isUnassigned,isUrgent,manualReview,isInvalid,isEngineerPoint,position:meta?.position,routeColor};
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
        entries.forEach(({route,engineer})=>{const button=document.createElement('button'),avatar=document.createElement('span'),copy=document.createElement('span'),name=document.createElement('b'),metaText=document.createElement('small'),stopCount=route.assignments.length;button.type='button';button.setAttribute('aria-label',`Открыть маршрут бригады ${engineer.name}`);avatar.textContent=engineer.name.split(' ').map(part=>part[0]).join('').slice(0,2);name.textContent=engineer.name;metaText.textContent=`${stopCount} ${countForm(stopCount,'остановка','остановки','остановок')} · ${route.shiftStart}–${route.shiftEnd}`;copy.append(name,metaText);button.append(avatar,copy);button.addEventListener('click',event=>{event.stopPropagation();popup.remove();if(onRouteDetailsRef.current)onRouteDetailsRef.current(route);else onRouteRef.current?.(route)});routeList.append(button)});
        if(entries.length)content.append(routeList);
        const popup=new maplibregl.Popup({closeButton:true,closeOnClick:false,anchor:'right',offset:31,maxWidth:'380px',className:'order-popup start-detail-popup'}).setDOMContent(content);
        element.addEventListener('click',()=>{markersRef.current.forEach(marker=>marker.popup?.remove());startMarkersRef.current.forEach(marker=>marker.popup?.remove());const mapRect=map.getContainer().getBoundingClientRect(),panelRect=document.querySelector('.route-list-panel')?.getBoundingClientRect(),desktopPanelOffset=window.matchMedia('(min-width:761px)').matches&&panelRect?Math.max(0,Math.min(mapRect.width,panelRect.right-mapRect.left))/2:0;optimizedCameraMove(map,()=>map.easeTo({center:[item.coords[1],item.coords[0]],offset:[desktopPanelOffset,0],duration:520,easing:t=>1-(1-t)**3,essential:true}));popup.setLngLat([item.coords[1],item.coords[0]]).addTo(map)});
        const marker=new maplibregl.Marker({element,anchor:'center'}).setLngLat([item.coords[1],item.coords[0]]).addTo(map);return{marker,popup,element};
      });
      updateMarkerPresentation();
    };
    map.on('zoom',updateMarkerScale);
    map.on('zoomend',updateMarkerPresentation);
    // DOM markers do not depend on the vector style being fully loaded. Waiting
    // for style.load here could permanently remove them during an ordinary pan.
    sync();
    return()=>{
      map.off('zoom',updateMarkerScale);
      map.off('zoomend',updateMarkerPresentation);
      markerPresentationRef.current=()=>{};
      clearClusters();
      markersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      markersRef.current=[];
      clusterMarkersRef.current.forEach(item=>item.marker.remove());
      clusterMarkersRef.current=[];
      startMarkersRef.current.forEach(item=>{item.popup?.remove();item.marker.remove()});
      startMarkersRef.current=[];
    };
  },[map,mapOrders,scheduled,popupsEnabled,assignmentMeta,routeStarts,plan]);

  useEffect(()=>{markerPresentationRef.current?.()},[activeRoute,selectedOrder]);

  useEffect(()=>{markersRef.current.forEach(item=>item.element?.classList.toggle('is-list-hovered',String(hoveredOrderId??'')===item.orderId))},[hoveredOrderId]);

  useEffect(()=>{
    const modeChanged=previousScheduledRef.current!==scheduled;
    previousScheduledRef.current=scheduled;
    if(!map||!modeChanged||selectedOrder||selectedTerritory||!positions.length)return undefined;
    const frame=requestAnimationFrame(()=>{
      const bounds=positionsBounds(positions);if(!bounds)return;
      const mapRect=map.getContainer().getBoundingClientRect(),panelRect=document.querySelector('.route-list-panel')?.getBoundingClientRect();
      const panelInset=window.matchMedia('(min-width:761px)').matches&&panelRect?Math.max(0,Math.min(mapRect.width*.58,panelRect.right-mapRect.left)):0;
      map.stop();optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding:{top:90,bottom:80,left:Math.max(70,panelInset+42),right:90},maxZoom:13,duration:820,essential:true}));
    });
    return()=>cancelAnimationFrame(frame);
  },[map,scheduled,signature,selectedOrder,selectedTerritory,positions]);

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
      map.addLayer({id:'selected-district-fill',type:'fill',source:'selected-district',paint:{'fill-color':'#FFD21F','fill-opacity':mapTheme==='night'?.16:.12}},firstSymbol);
      map.addLayer({id:'selected-district-halo',type:'line',source:'selected-district',paint:{'line-color':mapTheme==='night'?'#8B5CF6':'#6D28D9','line-width':7,'line-opacity':.92}},firstSymbol);
      map.addLayer({id:'selected-district-line',type:'line',source:'selected-district',paint:{'line-color':'#FFC800','line-width':3,'line-opacity':1,'line-dasharray':[2,1]}},firstSymbol);
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
    let selectedMarker=null;
    markersRef.current.forEach(item=>{
      const{element,orderId,popup}=item;
      const isSelected=Boolean(selectedId)&&orderId===selectedId;
      element?.classList.toggle('is-selected',isSelected);
      if(element)element.style.zIndex=isSelected?'900':'';
      if(isSelected)selectedMarker=item;else popup?.remove();
    });
    if(!selectedOrder||!Array.isArray(selectedOrder.coords)||selectedOrder.coords.length!==2){markersRef.current.forEach(item=>item.popup?.remove());return}
    const showSelectedPopup=()=>{if(popupsEnabled&&selectedMarker?.popup)selectedMarker.popup.setLngLat([selectedOrder.coords[1],selectedOrder.coords[0]]).addTo(map)};
    showSelectedPopup();
    const[lat,lon]=selectedOrder.coords;
    const mapBounds=map.getContainer().getBoundingClientRect();
    const panel=map.getContainer().closest('.workspace-grid')?.querySelector('.route-list-panel');
    const panelBounds=panel&&getComputedStyle(panel).visibility!=='hidden'?panel.getBoundingClientRect():null;
    const detailBounds=document.querySelector('.point-detail-panel')?.getBoundingClientRect();
    const visibleLeft=panelBounds?Math.min(mapBounds.right,Math.max(mapBounds.left,panelBounds.right)):mapBounds.left;
    const visibleRight=detailBounds?Math.max(visibleLeft+120,Math.min(mapBounds.right,detailBounds.left)):mapBounds.right;
    const centerOffset=(visibleLeft+visibleRight-mapBounds.left-mapBounds.right)/2;
    // Cluster recalculation runs at zoomend. Re-assert the selected popup at
    // moveend so an unplanned point cannot lose its explanation during flyTo.
    map.once('moveend',showSelectedPopup);
    optimizedCameraMove(map,()=>map.flyTo({center:[lon,lat],zoom:Math.max(14.8,Math.min(map.getZoom(),16)),offset:[centerOffset,0],duration:760,speed:1.25,curve:1.1,essential:true}));
    return()=>map.off('moveend',showSelectedPopup);
  },[map,selectedOrder,popupsEnabled]);

  useEffect(()=>{
    if(!map)return undefined;
    const syncRoute=()=>{
      if(!map.isStyleLoaded())return;
      const night=mapTheme==='night',activeTest=['boolean',['get','active'],false],hoveredTest=['boolean',['get','hovered'],false],attentionTest=['any',activeTest,hoveredTest],brigadeMode=effectiveRouteMode==='brigades';
      const baseRoad=brigadeMode?['get','routeColor']:(night?MAP_UI.routeNeutralDark:MAP_UI.routeNeutral);
      const selectedRoad=night?MAP_UI.routeSelectedDark:MAP_UI.routeSelected;
      const road=['case',attentionTest,selectedRoad,baseRoad];
      const casing=['case',attentionTest,MAP_UI.routeSelectedCasing,night?'#12171D':'#FFFFFF'];
      // Keep zoom out of nested `case` expressions: MapLibre only accepts it as
      // the input of a top-level step/interpolate expression. A restrained
      // constant is also cheaper to evaluate while the dispatcher pans a map
      // with dozens of routes.
      const overviewOpacity=brigadeMode?.78:.27;
      const roadOpacity=['case',activeTest,1,hoveredTest,.94,overviewOpacity];
      const casingOpacity=['case',activeTest,.98,hoveredTest,.92,brigadeMode?.72:.26];
      const roadWidth=['case',activeTest,6,hoveredTest,4.75,brigadeMode?3:2.25];
      const casingWidth=['case',activeTest,8.5,hoveredTest,7,brigadeMode?5.2:4];
      const beforeLayer=map.getStyle().layers.find(layer=>layer.type==='symbol')?.id;
      const source=map.getSource('planned-route');
      if(source)source.setData(routeGeoJson);else map.addSource('planned-route',{type:'geojson',data:routeGeoJson});
      if(!map.getLayer('planned-route-casing'))map.addLayer({id:'planned-route-casing',type:'line',source:'planned-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':casing,'line-width':casingWidth,'line-opacity':casingOpacity}},beforeLayer);
      if(!map.getLayer('planned-route'))map.addLayer({id:'planned-route',type:'line',source:'planned-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':road,'line-width':roadWidth,'line-opacity':roadOpacity}},beforeLayer);
      if(!map.getLayer('planned-route-arrows'))map.addLayer({id:'planned-route-arrows',type:'symbol',source:'planned-route',minzoom:MAP_SCALE.directionArrowsMinZoom,filter:['any',['==',['get','active'],true],['==',['get','hovered'],true]],layout:{'symbol-placement':'line','symbol-spacing':120,'text-field':'➤','text-size':13,'text-rotation-alignment':'map','text-pitch-alignment':'viewport','text-keep-upright':false,'text-allow-overlap':false,'text-ignore-placement':false},paint:{'text-color':MAP_UI.routeDirection,'text-halo-color':selectedRoad,'text-halo-width':1.25,'text-opacity':['interpolate',['linear'],['zoom'],MAP_SCALE.directionArrowsMinZoom,0,10.9,1]}},beforeLayer);
      if(!map.getLayer('planned-route-hit'))map.addLayer({id:'planned-route-hit',type:'line',source:'planned-route',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#000000','line-width':16,'line-opacity':0}},beforeLayer);
      map.setPaintProperty('planned-route-casing','line-color',casing);map.setPaintProperty('planned-route-casing','line-width',casingWidth);map.setPaintProperty('planned-route-casing','line-opacity',casingOpacity);
      map.setPaintProperty('planned-route','line-color',road);map.setPaintProperty('planned-route','line-width',roadWidth);map.setPaintProperty('planned-route','line-opacity',roadOpacity);
      map.setPaintProperty('planned-route-arrows','text-color',MAP_UI.routeDirection);map.setPaintProperty('planned-route-arrows','text-halo-color',selectedRoad);
    };
    // After the one-time map load, route layers can be refreshed even while map
    // tiles are still loading. isStyleLoaded() may temporarily be false during
    // camera movement and style.load will not fire again for that movement.
    const host=map.getContainer();
    if(host.dataset.mapLoaded==='true')syncRoute();else map.once('load',syncRoute);
    return()=>map.off('load',syncRoute);
  },[map,routeGeoJson,scheduled,mapTheme,activeRoute,effectiveRouteMode]);

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
      if(target?.closest?.('.map-order-marker,.map-order-cluster,.route-start-marker,.maplibregl-ctrl,.map-hierarchy-panel,.map-theme-picker'))return;
      if(map.getLayer('planned-route-hit')&&map.queryRenderedFeatures(event.point,{layers:['planned-route-hit']}).length)return;
      markersRef.current.forEach(item=>item.popup?.remove());
      startMarkersRef.current.forEach(item=>item.popup?.remove());
      setMapHoveredRouteId(null);
      onOrderHoverRef.current?.(null);
      onRouteHoverRef.current?.(null);
      onOrderRef.current?.(null);
      onRouteRef.current?.(null);
    };
    map.on('click',clearSelection);
    return()=>map.off('click',clearSelection);
  },[map]);

  useEffect(()=>{
    if(!map||!activeRoute){lastFittedRouteRef.current='';return}
    const routeId=String(activeRoute.engineerId??'');
    if(!routeId||lastFittedRouteRef.current===routeId||!routeGeoJson.features.length)return;
    const coordinates=routeGeoJson.features.filter(feature=>feature.properties?.active).flatMap(feature=>feature.geometry?.coordinates||[]);
    const activeStart=routeStarts.find(item=>(item.entries||[]).some(entry=>String(entry.route?.engineerId??'')===routeId));
    const start=activeStart?.coords;
    if(start)coordinates.push([start[1],start[0]]);
    if(!coordinates.length)return;
    const bounds=coordinates.reduce((result,[lon,lat])=>result.extend([lon,lat]),new maplibregl.LngLatBounds(coordinates[0],coordinates[0]));
    const mapRect=map.getContainer().getBoundingClientRect(),leftPanel=map.getContainer().closest('.workspace-grid')?.querySelector('.route-list-panel, .engineer-panel'),rightPanel=document.querySelector('.point-detail-panel, .engineer-detail-panel, .route-detail-drawer'),leftRect=leftPanel&&getComputedStyle(leftPanel).visibility!=='hidden'?leftPanel.getBoundingClientRect():null,rightRect=rightPanel&&getComputedStyle(rightPanel).visibility!=='hidden'?rightPanel.getBoundingClientRect():null;
    const padding={top:104,bottom:92,left:leftRect?Math.max(72,Math.min(mapRect.width*.48,leftRect.right-mapRect.left+34)):84,right:rightRect?Math.max(84,Math.min(mapRect.width*.48,mapRect.right-rightRect.left+34)):92};
    lastFittedRouteRef.current=routeId;
    optimizedCameraMove(map,()=>map.fitBounds(bounds,{padding,maxZoom:13.4,duration:880,essential:true}));
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

  return <section className="map-canvas real-map">
    <div ref={containerRef} className="maplibre-host"/>
    {engineerPopup?.engineer?<EngineerMapPopup map={map} {...engineerPopup}/>:null}
    {selectedTerritory?<div className={`district-map-badge ${districtBoundaryStatus}`}><MapPinned/><span><small>{districtBoundaryStatus==='points'?'Область не задана · показаны все точки':territorySelection(selectedTerritory).kind==='zone'?'Зона из таблицы':'Сценарий района'}</small><b>{territorySelection(selectedTerritory).name}</b></span>{districtBoundaryStatus==='loading'?<i className="spinner"/>:districtBoundaryStatus==='unavailable'?<AlertTriangle/>:<Check/>}</div>:null}
    {geocodeProgress?<div className={`map-geocode-notice ${geocodeProgress.status||'active'} ${geocodeProgress.closing?'is-closing':''}`} role="status" aria-live="polite"><span className="geocode-notice-icon">{geocodeProgress.active?<span className="spinner"/>:geocodeProgress.status==='warning'?<AlertTriangle/>:<Check/>}</span><div className="geocode-notice-copy"><b>{geocodeProgress.active?`Определяем адреса: ${geocodeProgress.done} из ${geocodeProgress.total}`:geocodeProgress.status==='warning'?'Геокодирование завершено с замечаниями':`${geocodeProgress.found} адресов нанесено на карту`}</b><span>{geocodeProgress.active?`Метки появляются по мере обработки · осталось около ${Math.ceil(Math.max(0,geocodeProgress.total-geocodeProgress.done)/5)} сек${geocodeProgress.failed?` · проверить: ${geocodeProgress.failed}`:''}`:geocodeProgress.message}</span>{geocodeProgress.active?<i className="geocode-progress-track"><i style={{width:`${geocodeProgress.total?Math.round(geocodeProgress.done/geocodeProgress.total*100):0}%`}}/></i>:null}</div>{geocodeProgress.active?<em>{geocodeProgress.total?Math.round(geocodeProgress.done/geocodeProgress.total*100):0}%</em>:<button type="button" className="geocode-notice-close" onClick={onClearGeocodeProgress} aria-label="Закрыть"><X/></button>}</div>:null}
    <MapControls map={map} positions={positions} popupsEnabled={popupsEnabled} onTogglePopups={()=>setPopupsEnabled(value=>!value)} onToggleThemes={()=>setThemePickerOpen(open=>!open)} themesOpen={themePickerOpen} onLocate={requestLocationAccess} onResetOrientation={resetOrientation} locating={locating} locationVisible={locationVisible} is3D={is3D} onToggle3D={toggle3D}/>
    {scheduled&&plan?<MapHierarchyPanel open={legendOpen} onToggle={()=>setLegendOpen(value=>!value)} mode={effectiveRouteMode} onModeChange={setRouteDisplayMode} routeCount={visibleRouteCount} activeRoute={activeRoute} orders={orders} plan={plan}/>:null}
    {themePickerPresence.present?createPortal(<MapThemePicker pickerRef={themePickerRef} value={mapTheme} onChange={chooseMapTheme} onClose={()=>setThemePickerOpen(false)} className={`map-theme-picker-portal dropdown-transition ${themePickerPresence.visible?'is-open':'is-closing'}`}/>,document.body):null}
    {locationPromptPresence.present?createPortal(<div className={`location-consent-backdrop ${uiTheme==='dark'?'dark':''} ${locationPromptMotionClass}`} onMouseDown={event=>event.target===event.currentTarget&&setLocationPrompt(null)}><section className={`location-consent ${renderedLocationPrompt==='blocked'?'is-blocked':''}`} role="dialog" aria-modal="true" aria-label="Доступ к местоположению"><button type="button" className="location-close" onClick={()=>setLocationPrompt(null)} aria-label="Закрыть" data-tooltip="Закрыть"><X/></button><LocationConsentArtwork blocked={renderedLocationPrompt==='blocked'}/><div className="location-consent-copy"><span className="location-consent-kicker">ВАША ПОЗИЦИЯ НА КАРТЕ</span><h3>{renderedLocationPrompt==='blocked'?'Доступ к геолокации заблокирован':'Показать ваше местоположение?'}</h3><p>{renderedLocationPrompt==='blocked'?'Разрешите доступ к местоположению в настройках этого сайта, затем нажмите «Проверить снова».':'Координаты нужны только для показа вашей позиции на карте и не отправляются на сервер.'}</p>{renderedLocationPrompt==='blocked'?<div className="location-hint"><Settings2/><span>Нажмите значок настроек сайта слева от адреса, выберите «Местоположение», затем — «Разрешить».</span></div>:null}</div><footer><button type="button" className="location-secondary" onClick={()=>setLocationPrompt(null)}>Не сейчас</button><button type="button" className="primary location-primary" onClick={confirmLocationAccess}><LocateFixed/><span>{renderedLocationPrompt==='blocked'?'Проверить снова':'Разрешить доступ'}</span></button></footer></section></div>,document.body):null}
    {locationMessage?<div className="map-status">{locating?<span className="spinner"/>:<LocateFixed/>}{locationMessage}</div>:null}
  </section>;
}
function UploadEmpty({onFile,inputRef}){const[dragging,setDragging]=useState(false);const choose=()=>inputRef.current?.click();const takeFile=file=>{if(file)onFile(file)};return <div className={`upload-empty ${dragging?'dragging':''}`} onClick={choose} onDragEnter={event=>{event.preventDefault();setDragging(true)}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(event.currentTarget===event.target)setDragging(false)}} onDrop={event=>{event.preventDefault();setDragging(false);takeFile(event.dataTransfer.files?.[0])}}><input ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{takeFile(event.target.files?.[0]);event.target.value=''}}/><span className="upload-mascot-shell"><img className="empty-mascot upload-mascot" src="/mascot-empty-upload.png" alt="Робот BeeGo с таблицей"/></span><span className="upload-kicker">Импорт заявок</span><div className="upload-copy"><h2>Выберите CSV, JSON, XLS или XLSX</h2><p>или перетащите файл сюда</p></div><button type="button" onClick={event=>{event.stopPropagation();choose()}}><FileUp size={18}/> Выбрать файл</button><a href="/beego-orders-template.xlsx" download="Шаблон заявок BeeGo.xlsx" onClick={event=>event.stopPropagation()}>Не знаете структуру? <u>Скачать шаблон</u></a></div>}
function RoutesEmpty(){return <div className="panel-empty"><img className="empty-mascot routes-mascot" src="/mascot-empty-routes.png" alt=""/><h2>Маршрутов пока нет</h2><p>Загрузите заявки, чтобы построить первый маршрут</p></div>}
function OrderList({orders,onOrder,onHover,plan,selectedId}){return <div className="order-list"><div className="table-head"><span>КЛИЕНТ</span><span>ОКНО</span></div>{orders.map(o=>{const issue=plan?.unassigned?.find(item=>item.orderId===o.id);return <button data-order-id={o.id} className={String(selectedId??'')===String(o.id)?'is-selected':''} key={o.id} onMouseEnter={()=>onHover?.(o)} onMouseLeave={()=>onHover?.(null)} onFocus={()=>onHover?.(o)} onBlur={()=>onHover?.(null)} onClick={()=>onOrder(o)}><span className={`check-dot point-type-${workPointType(o)} ${o.priority==='Авария'?'urgent':''}`}/><span className="order-main"><b>{displayOrderName(o)}</b><small>{o.address}</small>{issue?<em className="unassigned-reason">{issue.reason}</em>:null}</span><span className="order-window">{o.start?`${o.start}–${o.end}`:'Гибкое'}{o.priority!=='Обычная'?<em className={o.priority==='Авария'?'danger':''}>{o.priority}</em>:null}</span><ChevronRight size={16}/></button>})}</div>}
function AssignmentBoard({orders,plan,team,onOrder,onRoute,onRouteDetails,onOrderHover,onRouteHover,onRecalculate,activeRoute,selectedOrder}){
  const[expandedRouteId,setExpandedRouteId]=useState(null);const activeRoutes=plan?.routes?.filter(route=>route.assignments.length)||[];
  useEffect(()=>{if(activeRoute?.engineerId!=null){setExpandedRouteId(activeRoute.engineerId);return}if(selectedOrder?.id!=null){const owner=activeRoutes.find(route=>route.assignments.some(item=>String(item.orderId)===String(selectedOrder.id)));if(owner)setExpandedRouteId(owner.engineerId)}},[activeRoute?.engineerId,selectedOrder?.id,plan]);
  if(!activeRoutes.length)return <RoutesEmpty/>;
  const toggleRoute=route=>setExpandedRouteId(current=>{const opening=current!==route.engineerId;onRoute(opening?route:null);return opening?route.engineerId:null});
  return <div className="assignment-board"><div className="board-summary"><div><b>{activeRoutes.length} бригад в плане</b><span>{plan.metrics.assigned} задач распределено</span></div>{plan.metrics.unassigned?<em><CircleAlert/>{plan.metrics.unassigned} требуют решения</em>:<em className="ok"><Check/>План без конфликтов</em>}</div>{activeRoutes.map(route=>{const engineer=team.find(item=>item.id===route.engineerId);const expanded=expandedRouteId===route.engineerId,focused=String(activeRoute?.engineerId??'')===String(route.engineerId);return <article data-engineer-id={route.engineerId} className={`route-board-card ${expanded?'is-expanded':''} ${focused?'is-map-focused':''}`} key={route.engineerId}><div className="route-card-top"><button className="route-card-head" type="button" aria-expanded={expanded} onClick={()=>toggleRoute(route)}><span className="person-avatar" style={{'--engineer-route-color':MAP_UI.routeSelectedCasing}}>{route.engineerName.split(' ').map(part=>part[0]).join('').slice(0,2)}</span><div><b>{route.engineerName}</b><small>{durationLabel(route.workloadMinutes)} · {route.distanceKm} км</small></div><span className="route-task-count">{route.assignments.length}</span><ChevronDown className={expanded?'expanded':''}/></button><button type="button" className="route-open-map" onClick={()=>onRoute(route)} aria-label={`Показать маршрут: ${route.engineerName}`} data-tooltip="Показать на карте"><MapPinned/></button></div>{expanded?<div className="route-card-details"><div className="route-expanded-stats"><span><small>Задачи</small><b>{route.assignments.length}</b></span><span><small>Время</small><b>{durationLabel(route.workloadMinutes)}</b></span><span><small>Пробег</small><b>{route.distanceKm} км</b></span><span className={plan.metrics.unassigned?'attention':''}><small>Не вошли</small><b>{plan.metrics.unassigned}</b></span></div><div className="route-detail-actions"><button type="button" onClick={()=>onRouteDetails(route)}><List/>Открыть весь маршрут<ChevronRight/></button></div><div className="assignment-chips">{route.assignments.map(item=>{const order=orders.find(candidate=>candidate.id===item.orderId);return order?<button data-order-id={order.id} onMouseEnter={()=>onOrderHover?.(order)} onMouseLeave={()=>onOrderHover?.(null)} onClick={()=>onOrder(order)} key={order.id}><span>{item.plannedStart}</span><b>{displayOrderName(order)}</b><ChevronRight/></button>:null})}</div>{engineer?.skills?.length?<div className="route-tags">{engineer.skills.slice(0,2).map(skill=><span key={skill}>{skill}</span>)}</div>:null}</div>:null}</article>})}{plan.unassigned.length?<article className="unassigned-board"><div><CircleAlert/><b>Не вошли в текущий план</b><span>{plan.unassigned.length}</span></div><p className="unassigned-intro">Для этих заявок не найдено безопасного места в текущем расписании.</p>{plan.unassigned.map(item=>{const order=orders.find(candidate=>candidate.id===item.orderId),copy=unassignedExplanation(item);return order?<button data-order-id={order.id} onMouseEnter={()=>onOrderHover?.(order)} onMouseLeave={()=>onOrderHover?.(null)} onClick={()=>onOrder(order)} key={order.id}><b>{displayOrderName(order)}</b><strong>{copy.title}</strong><small>{copy.summary}</small><em>Открыть подробности <ChevronRight/></em></button>:null})}<button type="button" className="recalculate-unassigned" onClick={onRecalculate}><RefreshCw/>Полностью пересчитать день</button></article>:null}</div>
}
function Modal({children,onClose,wide=false}){return <div className="modal-backdrop" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><section className={`modal ${wide?'wide':''}`}>{children}</section></div>}
function HelpCenter({profile,onClose}){
  const[tab,setTab]=useState('home'),[activeTopic,setActiveTopic]=useState(null),[activeLesson,setActiveLesson]=useState('1'),[expandedNews,setExpandedNews]=useState(''),[helpQuery,setHelpQuery]=useState('');
  const firstName=profile.name.trim().split(/\s+/)[0]||'коллега';
  const tabs=[['home',House,'Главная'],['learn',GraduationCap,'Обучение'],['news',Newspaper,'Новости'],['help',CircleHelp,'Помощь']];
  const topics=[
    ['routes',Route,'Планирование маршрутов','Загрузка заявок, оптимизация и публикация готового плана.','Загрузите заявки и инженеров, нажмите «Построить план» и дождитесь статуса EXACT_VALID. После расчёта откройте маршрут бригады на карте или в таймлайне.'],
    ['orders',BriefcaseBusiness,'Заявки и объекты','Импорт данных, временные окна и карточки клиентов.','В импорте сопоставьте обязательные поля, проверьте адреса и координаты. Строки с ошибками нужно исправить до передачи в планировщик.'],
    ['engineers',HardHat,'Инженеры и смены','Навыки, транспорт, рабочее время и загрузка команды.','Для каждого инженера проверьте участок, смену, навыки, транспорт и оборудование — эти ограничения участвуют в точном расчёте.'],
    ['settings',Settings2,'Настройки пространства','Профиль, тема интерфейса и параметры оптимизации.','В настройках доступны данные компании, регионы, нормативы и фактический статус подключений.'],
  ];
  const lessons=[['1','Знакомство с рабочим пространством','2 мин','Выберите регион и дату, затем откройте раздел заявок или инженеров. Карта сохраняет положение между разделами.'],['2','Загрузка и проверка заявок','3 мин','Загрузите CSV, JSON или XLSX, сопоставьте столбцы и исправьте ошибки, отмеченные импортом.'],['3','Настройка инженеров и ограничений','3 мин','Проверьте смены, участки, навыки, транспорт и оборудование исполнителей.'],['4','Оптимизация и проверка маршрута','2 мин','Запустите точный расчёт и проверьте окна, последовательность остановок и объяснения назначения.'],['5','Публикация плана на день','2 мин','План считается готовым только после статусов EXACT_VALID и VALID. Операционные события пересчитываются в Центре решений.']];
  const visibleTopics=topics.filter(([, ,title,text,detail])=>`${title} ${text} ${detail}`.toLocaleLowerCase('ru-RU').includes(helpQuery.trim().toLocaleLowerCase('ru-RU')));
  return <aside className="help-center" role="dialog" aria-label="Центр помощи BeeGo!"><header><div className="help-brand"><img src="/beego-mark.png" alt=""/><span><b>BeeGo!</b><small>Центр поддержки</small></span></div><button onClick={onClose} aria-label="Закрыть помощь" data-tooltip="Закрыть"><X/></button></header><div className="help-center-body">
    {tab==='home'?<section className="help-view help-home"><div className="help-welcome"><img src="/mascot-empty-routes.png" alt=""/><div><small>Всегда рядом</small><h2>Привет, {firstName}!</h2><p>Разберёмся с маршрутами, настройками и работой команды.</p></div></div><div className="help-quick-grid"><button onClick={()=>setTab('learn')}><span><GraduationCap/></span><div><b>Начать обучение</b><small>Короткий путь от импорта до готового маршрута</small></div><ArrowRight/></button><button onClick={()=>setTab('news')}><span><Rocket/></span><div><b>Что нового</b><small>Последние улучшения BeeGo!</small></div><ArrowRight/></button><button onClick={()=>setTab('help')}><span><CircleHelp/></span><div><b>Найти ответ</b><small>Инструкции по основным разделам</small></div><ArrowRight/></button></div><div className="help-tip"><ShieldCheck/><p><b>Совет дня</b>Загрузите рабочую таблицу заявок и проверьте сопоставление столбцов перед планированием.</p></div></section>:null}
    {tab==='learn'?<section className="help-view"><div className="help-page-title"><span><GraduationCap/></span><div><small>Быстрый старт</small><h2>Освойте BeeGo!</h2><p>Пять коротких шагов от первой заявки до рабочего маршрута.</p></div></div><div className="learning-progress"><span><i style={{width:`${Number(activeLesson)*20}%`}}/></span><small>{activeLesson} из 5 шагов · около 12 минут</small></div><div className="lesson-list">{lessons.map(([n,title,time,detail])=><button key={n} className={activeLesson===n?'done':''} onClick={()=>setActiveLesson(n)}><span>{activeLesson===n?<Check/>:n}</span><div><b>{title}</b><small>{time}</small>{activeLesson===n?<p>{detail}</p>:null}</div><PlayCircle/></button>)}</div></section>:null}
    {tab==='news'?<section className="help-view"><div className="help-page-title compact"><span><Newspaper/></span><div><small>Обновления продукта</small><h2>Новости BeeGo!</h2></div></div><div className="news-list"><article><div className="news-visual routes"><Route/></div><small>Сегодня · Маршруты</small><h3>Ночная карта стала частью тёмной темы</h3><p>Переключайте интерфейс — карта автоматически подберёт подходящий стиль с контрастными дорогами.</p>{expandedNews==='routes'?<p>Маршруты, остановки и подписи автоматически получают контрастную палитру; положение и масштаб карты сохраняются.</p>:null}<button onClick={()=>setExpandedNews(current=>current==='routes'?'':'routes')}>{expandedNews==='routes'?'Свернуть':'Подробнее'} <ArrowRight/></button></article><article><div className="news-visual profile"><img src="/avatars/bee-running.png" alt=""/></div><small>15 сентября · Профиль</small><h3>Персональные маскоты команды</h3><p>Выбирайте героя BeeGo!, роль и отображаемое имя прямо в профиле.</p>{expandedNews==='profile'?<p>Настройки профиля сохраняются в браузере и применяются к аватару и подписи пользователя в интерфейсе.</p>:null}<button onClick={()=>setExpandedNews(current=>current==='profile'?'':'profile')}>{expandedNews==='profile'?'Свернуть':'Подробнее'} <ArrowRight/></button></article></div></section>:null}
    {tab==='help'?<section className="help-view"><div className="help-page-title compact"><span><CircleHelp/></span><div><small>База знаний</small><h2>Чем помочь?</h2></div></div><label className="help-search"><Search/><input value={helpQuery} onChange={event=>setHelpQuery(event.target.value)} placeholder="Найти инструкцию…"/></label><div className="help-topics">{visibleTopics.map(([id,Icon,title,text,detail])=><button key={id} className={activeTopic===id?'open':''} onClick={()=>setActiveTopic(current=>current===id?null:id)}><span><Icon/></span><div><b>{title}</b><small>{text}</small>{activeTopic===id?<p>{detail}</p>:null}</div><ChevronRight/></button>)}{!visibleTopics.length?<p>По этому запросу инструкции не найдены.</p>:null}</div></section>:null}
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
const VERIFIED_SHARED_STOCK=parseSharedStockCsv(sharedStockCsv);
function PlanDrawer({orders,team,onClose,onOptimize,optimizing,selectedDate}){
  const [stockValues,setStockValues]=useState({});
  const rows=[['Максимум выполненных заявок','Первая цель точного оптимизатора.'],['Минимум активных бригад','Вторая лексикографическая цель без потери покрытия.'],['Реальная дорожная сеть','Valhalla и локальное расписание общественного транспорта.'],['Жёсткие ограничения','Окна, смены, навыки, транспорт и оборудование нельзя нарушать.']];
  const stockRows=sharedStockRequirements(orders,VERIFIED_SHARED_STOCK);
  const incompleteStock=stockRows.some(row=>row.required&&stockValues[row.key]===undefined||stockValues[row.key]!==undefined&&(!Number.isSafeInteger(Number(stockValues[row.key]))||Number(stockValues[row.key])<0));
  const start=()=>onOptimize(stockOverrides(stockRows,stockValues));
  return <div className="drawer-backdrop"><aside className="plan-drawer"><div className="modal-head"><div><h2>Спланировать маршруты</h2><p>{fullDateLabel(selectedDate)}</p></div><button onClick={onClose}><X/></button></div><div className="plan-step done"><span>1</span><div><b>Заявки</b><small>{orders.length} готовы к распределению</small></div><Check/></div><div className={`plan-step ${team.length?'done':'warning'}`}><span>2</span><div><b>Команда участка</b><small>{team.length?`${team.length} исполнителей · навыки и транспорт проверены`:'Сначала загрузите инженеров во вкладке «Инженеры»'}</small></div>{team.length?<Check/>:<AlertTriangle/>}</div>{stockRows.length?<section className="plan-stock"><h4>Остатки общего оборудования</h4><p>Показаны только материалы из выбранных заявок. Для известных участков подставлены подтверждённые остатки; изменение числа отправит новое значение в расчёт. Для нового участка введите фактический остаток, в том числе ноль.</p><div>{stockRows.map(row=><label key={row.key}><span>{row.zoneId} · {SHARED_STOCK_LABELS[row.equipmentId]}<small>{row.required?'Укажите фактический остаток':stockValues[row.key]!==undefined?'Изменено для этого расчёта':'Из проверенного набора'}</small></span><input type="number" min="0" step="1" value={stockValues[row.key]??row.defaultQuantity??''} placeholder={row.required?'Обязательно':''} onChange={event=>{const value=event.target.value;setStockValues(current=>{const next={...current};if(value===''||value===String(row.defaultQuantity))delete next[row.key];else next[row.key]=value;return next})}}/></label>)}</div>{incompleteStock?<small className="plan-stock-error">Заполните обязательные остатки целыми неотрицательными числами.</small>:null}</section>:null}<h4>Неизменяемые правила точного расчёта</h4>{rows.map(([title,description])=><div className="setting-line" key={title}><span><b>{title}</b><small>{description}</small></span><Check/></div>)}<div className="plan-info"><ShieldCheck/> Публикация возможна только для EXACT_VALID после независимой проверки.</div><footer><button onClick={onClose}>Отмена</button><button className="primary" onClick={start} disabled={optimizing||!team.length||incompleteStock}>{optimizing?<><span className="spinner"/>Оптимизируем…</>:<><WandSparkles/>Построить план</>}</button></footer></aside></div>;
}
function DetailDrawer({order,route,orders,team,plan,onRecalculate,onOpenRoute,onClose}){
  if(!order&&!route)return null;
  if(route)return <aside className="detail-drawer"><div className="drawer-head"><h2>{route.engineerName}</h2><button aria-label="Другие действия"><MoreHorizontal/></button><button onClick={onClose} aria-label="Закрыть"><X/></button></div><div className="drawer-stats"><span><BriefcaseBusiness/>{route.assignments.length}</span><span><Clock3/>{durationLabel(route.workloadMinutes)}</span><span><Activity/>{Math.round(route.workloadMinutes/(toMinutes(route.shiftEnd)-toMinutes(route.shiftStart))*100)}%</span></div><div className="stop-list">{route.assignments.map((item,i)=>{const current=orders.find(candidate=>candidate.id===item.orderId);return current?<div key={current.id}><b>{i+1}</b><section><small>Прибытие: {item.arrival} · начало: {item.plannedStart}</small><strong>{current.name}</strong><span>{current.address}</span><em><Clock3/>{current.start||'08:00'}–{current.end||'18:00'} · до {item.plannedFinish}</em>{item.manual?<i className="manual-badge"><LockKeyhole/> Закреплено диспетчером</i>:null}</section></div>:null})}</div><div className="published-plan-status"><ShieldCheck/>Маршрут входит в опубликованный точный план</div></aside>;
  const assignedRoute=plan?.routes?.find(item=>item.assignments.some(assignment=>String(assignment.orderId)===String(order.id)));
  const assignmentIndex=assignedRoute?.assignments.findIndex(item=>String(item.orderId)===String(order.id))??-1;
  const assignment=assignmentIndex>=0?assignedRoute.assignments[assignmentIndex]:null;
  const previousAssignment=assignmentIndex>0?assignedRoute.assignments[assignmentIndex-1]:null;
  const previousOrder=previousAssignment?orders.find(item=>String(item.id)===String(previousAssignment.orderId)):null;
  const issue=plan?.unassigned?.find(item=>item.orderId===order.id);
  const assignedEngineer=assignedRoute?team.find(item=>String(item.id)===String(assignedRoute.engineerId)):null;
  const originTitle=previousOrder?displayOrderName(previousOrder):assignedEngineer?'Стартовая точка бригады':'—';
  const originAddress=previousOrder?.address||assignedEngineer?.startAddress||'Адрес старта не указан';
  const exact=['exact','provided','ready','VERIFIED_BUILDING'].includes(order.geocodeStatus),issueCopy=issue?unassignedExplanation(issue):null;
  const objectContext=order.detailContext==='object';
  return <aside className="point-detail-panel" role="dialog" aria-label={`${objectContext?'Объект':'Заявка'} ${order.name}`}>
    <header><div className="point-detail-brand"><span>{objectContext?<Building2/>:<MapPin/>}</span><div><b>{objectContext?'Карточка объекта':'Карточка заявки'}</b><small>{order.id||order.name} · {objectContext?'данные объекта':'точка на карте'}</small></div></div><button onClick={onClose} aria-label="Закрыть карточку" data-tooltip="Закрыть"><X/></button></header>
    <div className="point-detail-body">
      <section className={`point-detail-hero ${order.priority==='Авария'?'urgent':''}`}><span>{order.priority==='Авария'?<AlertTriangle/>:<BriefcaseBusiness/>}</span><div><small>{order.status||'Новая заявка'}</small><h2>{displayOrderName(order)}</h2><p>{order.address}</p></div><em>{order.priority||'Обычная'}</em></section>
      <div className="point-detail-grid"><article><Clock3/><div><small>Клиентское окно</small><b>{order.start?`${order.start}–${order.end}`:'Гибкое'}</b></div></article><article><Activity/><div><small>Норматив</small><b>{durationLabel(order.duration)}</b></div></article><article><Wrench/><div><small>Навык</small><b>{order.skill||'Не указан'}</b></div></article><article><PackageCheck/><div><small>Оборудование</small><b>{order.equipment||'Не требуется'}</b></div></article></div>
      <section className="point-location-card"><div><MapPinned/><span><small>Координаты</small><b>{exact?'Точный адрес подтверждён':'Нужна проверка адреса'}</b></span><em className={exact?'exact':'review'}>{exact?<><Check/>Точно</>:<><AlertTriangle/>Проверить</>}</em></div>{order.geocodedAddress&&order.geocodedAddress!==order.address?<p>{order.geocodedAddress}</p>:null}</section>
      <section className="point-plan-card"><div><Sparkles/><span><small>Назначение</small><b>{assignedEngineer?.name||(plan?'Не вошла в план':'План ещё не построен')}</b></span></div><dl><dt>Плановое начало</dt><dd>{assignment?.plannedStart||'—'}</dd><dt>Завершение</dt><dd>{assignment?.plannedFinish||'—'}</dd></dl>{assignedRoute?<button type="button" className="open-assigned-route" onClick={()=>onOpenRoute?.(assignedRoute)}><Route/><span><b>Открыть маршрут бригады</b><small>{assignedRoute.assignments.length} остановок · смена {assignedRoute.shiftStart}–{assignedRoute.shiftEnd}</small></span><ChevronRight/></button>:null}</section>
      {!plan?<div className="point-detail-alert planning"><CircleAlert/><p><b>Заявка ожидает планирования</b>Серый контур означает, что точка ещё не распределена. После построения плана здесь появятся бригада, порядок остановки и расчётное время.</p></div>:null}
      {assignment?<section className="point-travel-card"><div className="point-travel-title"><Route/><span><small>Откуда едет инженер</small><b>{originTitle}</b></span></div><p>{originAddress}</p><div className="point-travel-metrics"><span><Clock3/><b>{assignment.travelMinutes||0} мин</b><small>в пути</small></span><span><MapPin/><b>{assignment.distanceM?`${(assignment.distanceM/1000).toFixed(1)} км`:'—'}</b><small>до заявки</small></span><span><ChevronRight/><b>{assignment.departureAt||previousAssignment?.plannedFinish||assignedRoute.shiftStart}</b><small>выезд</small></span></div></section>:null}
      {issue?<div className="point-detail-alert"><CircleAlert/><p><b>{issueCopy.title}</b>{issueCopy.summary}<em>{issueCopy.action}</em></p></div>:assignment?<div className={`point-detail-alert success ${assignment.manual?'manual':''}`}>{assignment.manual?<LockKeyhole/>:<Check/>}<p><b>{assignment.manual?'Закреплено вручную':'Почему назначено этой бригаде'}</b>{assignment.explanation||`${assignedEngineer?.name} подходит по навыкам, оборудованию и времени.`}</p></div>:null}
      {issue?<div className="manual-assign point-manual-assign"><b>Пересчитать расписание</b><p>Алгоритм заново проверит порядок всех остановок. Уже опубликованные маршруты могут измениться.</p><button type="button" className="primary recalculate-order" onClick={onRecalculate}><RefreshCw/>Полностью пересчитать день</button></div>:null}
    </div>
  </aside>;
}
function PageShell({title,children,action,onClose,floating=false,motionClass='',className=''}){return <main className={`page ${floating?'map-overlay-page':''} ${className} ${motionClass}`.trim()}><header><div><h1>{title}</h1><p>Управление выездной службой в одном рабочем пространстве</p></div>{onClose?<div className="page-header-actions">{action}<button type="button" className="panel-close page-close" onClick={onClose} aria-label={`Закрыть: ${title}`} data-tooltip="Закрыть"><X/></button></div>:action}</header>{children}</main>}
const TransportIcon=({type})=>type==='Автомобиль'?<Car/>:type==='Пешком'?<Footprints/>:<Bus/>;
function EngineerUploadPanel({inputRef,onFile}){const[dragging,setDragging]=useState(false);const choose=()=>inputRef.current?.click();const takeFile=file=>{if(file)onFile(file)};return <section className="engineer-upload-stage"><div className={`engineer-upload-card ${dragging?'dragging':''}`} onClick={choose} onDragEnter={event=>{event.preventDefault();setDragging(true)}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(event.currentTarget===event.target)setDragging(false)}} onDrop={event=>{event.preventDefault();setDragging(false);takeFile(event.dataTransfer.files?.[0])}}><input className="workspace-file-input" ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{takeFile(event.target.files?.[0]);event.target.value=''}}/><span className="engineer-mascot-shell"><img src="/avatars/dog-engineer.png" alt="Инженер BeeGo"/></span><span className="engineer-upload-kicker">Импорт инженеров</span><h2>Выберите CSV, JSON, XLS или XLSX</h2><p>или перетащите файл сюда</p><button type="button" onClick={event=>{event.stopPropagation();choose()}}><Download/>Выбрать файл</button><a href="/beego-engineers-template.xlsx" download="Шаблон инженеров BeeGo.xlsx" onClick={event=>event.stopPropagation()}>Не знаете структуру? <u>Скачать шаблон</u></a><small>После выбора откроется большая редактируемая таблица</small></div></section>}
function PanelSearch({value,onChange,placeholder,label}){return <label className="panel-search"><Search aria-hidden="true"/><input type="search" value={value} onChange={event=>onChange(event.target.value)} placeholder={placeholder} aria-label={label}/>{value?<button type="button" onClick={()=>onChange('')} aria-label="Очистить поиск"><X/></button>:null}</label>}
const engineerFilterValues=value=>(Array.isArray(value)?value:String(value||'').split(/[|,;]+/)).map(item=>String(item||'').trim()).filter(Boolean);
const engineerFilterOptions=(values,allLabel)=>[['',allLabel],...[...new Set(values)].sort((left,right)=>left.localeCompare(right,'ru-RU')).map(value=>[value,value])];
function EngineerFilters({team,value,onChange}){
  const[open,setOpen]=useState(false),[menuStyle,setMenuStyle]=useState(null),rootRef=useRef(null),triggerRef=useRef(null),menuRef=useRef(null),presence=useDropdownPresence(open,220);
  const options=useMemo(()=>({
    skill:engineerFilterOptions(team.flatMap(engineer=>engineerFilterValues(engineer.skills)),'Все навыки'),
    equipment:engineerFilterOptions(team.flatMap(engineer=>engineerFilterValues(engineer.equipment)),'Любое оборудование'),
    location:engineerFilterOptions(team.flatMap(engineer=>[engineer.zone,engineer.district,engineer.regionName].filter(Boolean)),'Все локации'),
    transport:engineerFilterOptions(team.map(engineer=>engineer.transport).filter(Boolean),'Любой транспорт'),
    status:engineerFilterOptions(team.map(engineer=>engineer.status).filter(Boolean),'Любая доступность'),
  }),[team]);
  const activeCount=Object.values(value).filter(Boolean).length;
  const setFilter=(key,next)=>onChange(current=>({...current,[key]:next}));
  const reset=()=>onChange({skill:'',equipment:'',location:'',transport:'',status:''});
  const positionMenu=useCallback(()=>{const rect=triggerRef.current?.getBoundingClientRect();if(!rect)return;const spaceBelow=window.innerHeight-rect.bottom-12,maxHeight=Math.max(280,Math.min(520,spaceBelow));setMenuStyle({top:rect.bottom+6,left:rect.left,width:rect.width,maxHeight})},[]);
  useLayoutEffect(()=>{if(open)positionMenu()},[open,positionMenu]);
  useEffect(()=>{if(!open)return undefined;const close=event=>{if(event.key==='Escape'||(event.type==='pointerdown'&&!rootRef.current?.contains(event.target)&&!menuRef.current?.contains(event.target)))setOpen(false)};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);window.addEventListener('resize',positionMenu);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close);window.removeEventListener('resize',positionMenu)}},[open,positionMenu]);
  const sections=[['skill','Навыки',options.skill],['equipment','Оборудование',options.equipment],['location','Локация',options.location],['transport','Транспорт',options.transport],['status','Доступность',options.status]];
  return <section className="engineer-advanced-filters" ref={rootRef} aria-label="Фильтры инженеров">
    <button ref={triggerRef} type="button" className={`engineer-filter-trigger ${activeCount?'active':''}`} onClick={()=>setOpen(current=>!current)} aria-haspopup="dialog" aria-expanded={open}><span><Filter/><b>Фильтры</b>{activeCount?<em>{activeCount}</em>:null}</span><ChevronDown/></button>
    {presence.present&&menuStyle?createPortal(<div ref={menuRef} className={`engineer-filter-menu dropdown-transition ${presence.visible?'is-open':'is-closing'}`} role="dialog" aria-label="Параметры фильтра" style={menuStyle}>
      <div className="engineer-filter-menu-head"><span><Filter/><b>Отобрать инженеров</b></span>{activeCount?<button type="button" onClick={reset}>Сбросить</button>:null}</div>
      <div className="engineer-filter-menu-scroll">{sections.map(([key,label,items])=><section className="engineer-filter-section" key={key}><b>{label}</b><div role="radiogroup" aria-label={label}>{items.map(([id,title])=><button type="button" role="radio" aria-checked={String(value[key])===String(id)} className={String(value[key])===String(id)?'selected':''} key={`${key}-${id||'all'}`} onClick={()=>setFilter(key,id)}><span>{title}</span>{String(value[key])===String(id)?<Check/>:null}</button>)}</div></section>)}</div>
      <footer><button type="button" onClick={()=>setOpen(false)}>Готово</button></footer>
    </div>,document.body):null}
  </section>;
}
function EngineerList({team,onSelect,selectedId,routesByEngineer=new globalThis.Map(),hasPlan=false}){
  return <div className="engineer-list">{team.length?<>{team.map(engineer=>{
    const routes=routesByEngineer.get(String(engineer.id))||[],stops=routes.reduce((total,route)=>total+route.assignments.length,0);
    return <button type="button" className={`engineer-list-row ${selectedId===engineer.id?'selected':''}`} key={engineer.id} onClick={()=>onSelect?.(engineer)} aria-pressed={selectedId===engineer.id}>
      <span className="person-avatar">{engineer.name.split(' ').map(part=>part[0]).join('').slice(0,2)}</span>
      <span className="engineer-list-main"><b>{engineer.name}</b><span className="engineer-list-skills">{engineer.skills?.length?engineer.skills.map(skill=><small key={skill}>{skill}</small>):<small>Навыки не указаны</small>}</span><span className="engineer-list-transport"><TransportIcon type={engineer.transport}/>{engineer.transport||'Транспорт не указан'}</span><span className="engineer-list-load">{hasPlan?routes.length?`${routes.length} ${countForm(routes.length,'маршрут','маршрута','маршрутов')} · ${stops} ${countForm(stops,'остановка','остановки','остановок')}`:'Без маршрута':'План ещё не построен'}</span></span>
      <span className="engineer-list-shift"><b>{engineer.shiftStart}–{engineer.shiftEnd}</b><small>{engineer.status||'Доступность не указана'}</small></span><ChevronRight className="engineer-list-open"/>
    </button>
  })}</>:<div className="panel-filter-empty"><Search/><b>Инженеры не найдены</b><span>Измените поиск или фильтр загрузки.</span></div>}</div>;
}

function EngineerDetailPanel({engineer,routes=[],hasPlan,onClose,onOpenRoute,motionClass=''}){
  if(!engineer)return null;
  const initials=engineer.name.split(' ').map(part=>part[0]).join('').slice(0,2),stops=routes.reduce((total,route)=>total+route.assignments.length,0);
  const skills=engineer.skills?.length?engineer.skills:['Навыки не указаны'];
  const equipment=engineer.equipment?.length?engineer.equipment:['Оборудование не указано'];
  const unavailable=/(недоступ|отпуск|выходн|боле|отсутств|unavailable|leave)/i.test(engineer.status||'');
  const availabilityUnknown=!engineer.status||/(не указ|unknown)/i.test(engineer.status);
  const primaryRoute=routes.find(route=>route.assignments?.length)||null;
  const distance=routes.reduce((total,route)=>total+(Number(route.distanceKm)||0),0);
  return <aside className={`engineer-map-card ${motionClass}`} role="dialog" aria-label={`Инженер ${engineer.name}`} onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()}>
    <header><div className="engineer-detail-heading"><span className="engineer-detail-avatar">{initials}</span><div><small>Карточка инженера</small><h2>{engineer.name}</h2></div></div><button type="button" onClick={onClose} aria-label="Закрыть карточку инженера" data-tooltip="Закрыть"><X/></button></header>
    <div className="engineer-map-card-body" key={engineer.id}>
      <section className={`engineer-detail-status ${unavailable?'is-unavailable':availabilityUnknown?'is-unknown':''}`}><span>{unavailable?<CircleAlert/>:availabilityUnknown?<CircleHelp/>:<Check/>}</span><div><small>Доступность сегодня</small><b>{engineer.status||'Не указана'}</b></div><em>{hasPlan?routes.length?`${routes.length} ${countForm(routes.length,'маршрут','маршрута','маршрутов')}`:'Без маршрута':'План не построен'}</em></section>
      <div className="engineer-detail-metrics"><article><Clock3/><span><small>Смена</small><b>{engineer.shiftStart||'08:00'}–{engineer.shiftEnd||'18:00'}</b></span></article><article><TransportIcon type={engineer.transport}/><span><small>Транспорт</small><b>{engineer.transport||'Не указан'}</b></span></article><article><MapPinned/><span><small>Территория</small><b>{[engineer.zone,engineer.district,engineer.regionName].filter(Boolean).join(' · ')||'Не указана'}</b></span></article><article><Route/><span><small>Маршрут</small><b>{hasPlan?`${stops} ${countForm(stops,'остановка','остановки','остановок')} · ${distance.toFixed(1)} км`:'—'}</b></span></article></div>
      <section className="engineer-detail-section"><div className="engineer-detail-section-title"><MapPin/><b>Стартовая точка</b></div><p>{engineer.startAddress||'Адрес старта не указан'}</p></section>
      <section className="engineer-detail-section engineer-competencies"><div className="engineer-detail-section-title"><Wrench/><b>Навыки и оборудование</b></div><div className="engineer-detail-tags">{skills.map(skill=><span key={`skill-${skill}`}>{skill}</span>)}</div><div className="engineer-detail-tags equipment">{equipment.map(item=><span key={`equipment-${item}`}>{item}</span>)}</div></section>
      <section className="engineer-route-summary"><Route/><div><b>{primaryRoute?'Открыть маршрут':'Маршрута нет'}</b><small>{primaryRoute?`${stops} ${countForm(stops,'остановка','остановки','остановок')} · показать на карте`:hasPlan?'Инженер свободен на сегодня':'Постройте план, чтобы появился маршрут'}</small></div><button type="button" disabled={!primaryRoute} onClick={()=>primaryRoute&&onOpenRoute?.(primaryRoute)} aria-label="Перейти к маршруту инженера"><ChevronRight/></button></section>
    </div>
  </aside>;
}
function EngineerMapPopup({map,engineer,routes=[],hasPlan,onClose,onOpenRoute,motionClass=''}){
  const[portalHost,setPortalHost]=useState(null);
  const coords=engineer?.startCoords;
  useEffect(()=>{
    if(!map||!Array.isArray(coords)||coords.length!==2)return undefined;
    const host=document.createElement('div');
    const popup=new maplibregl.Popup({anchor:'bottom',closeButton:false,closeOnClick:false,focusAfterOpen:false,offset:[0,-22],maxWidth:'520px',className:'engineer-map-popup'}).setLngLat([coords[1],coords[0]]).setDOMContent(host).addTo(map);
    setPortalHost(host);
    const targetZoom=Math.max(map.getZoom(),12.2);
    const mapRect=map.getContainer().getBoundingClientRect();
    const panelRect=map.getContainer().closest('.workspace-grid')?.querySelector('.engineer-panel')?.getBoundingClientRect();
    const horizontalOffset=window.matchMedia('(min-width:761px)').matches&&panelRect?Math.max(0,Math.min(mapRect.width*.42,panelRect.right-mapRect.left))/2:0;
    map.stop();
    optimizedCameraMove(map,()=>map.easeTo({center:[coords[1],coords[0]],zoom:targetZoom,offset:[horizontalOffset,Math.min(210,mapRect.height*.27)],duration:620,essential:true}));
    return()=>{setPortalHost(null);popup.remove()};
  },[map,engineer?.id,coords?.[0],coords?.[1]]);
  return portalHost?createPortal(<EngineerDetailPanel engineer={engineer} routes={routes} hasPlan={hasPlan} onClose={onClose} onOpenRoute={onOpenRoute} motionClass={motionClass}/>,portalHost):null;
}
function EngineersPage({team,region,onImportFile,onUploadError,uiTheme,selectedDate,setSelectedDate}){const inputRef=useRef(null);const handleFile=async file=>{if(!file)return;try{onImportFile(await parseImportFile(file,'engineers'))}catch(error){onUploadError(error?.message||'Не удалось прочитать файл инженеров')}};const engineerMarkers=useMemo(()=>team.map(engineer=>({id:`engineer-${engineer.id}`,name:engineer.name,address:engineer.startAddress||region.office,coords:engineer.startCoords})).filter(engineer=>Array.isArray(engineer.coords)&&engineer.coords.length===2),[team,region.office]);return <main className="route-workspace engineer-workspace"><header className="topbar engineer-topbar"><div className="engineer-topbar-title"><HardHat/><strong>Инженеры</strong>{team.length?<b>{team.length}</b>:null}</div><DateControl value={selectedDate} onChange={setSelectedDate}/><div className="top-actions"><a className="icon engineer-template-action" href="/beego-engineers-template.xlsx" download="Шаблон инженеров BeeGo.xlsx" aria-label="Скачать шаблон" data-tooltip="Скачать шаблон"><Download/></a><button type="button" className="primary" onClick={()=>inputRef.current?.click()}><Plus/>Загрузить инженеров</button></div></header><div className="engineer-workspace-grid"><section className="orders-panel engineer-panel"><div className="panel-heading"><div><h3>Инженеры</h3>{team.length?<b className="engineer-count">{team.length}</b>:null}</div>{team.length?<button type="button" className="engineer-reupload" onClick={()=>inputRef.current?.click()} aria-label="Загрузить другой файл" data-tooltip="Загрузить другой файл"><Download/></button>:null}</div>{team.length?<><input className="workspace-file-input" ref={inputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleFile(event.target.files?.[0]);event.target.value=''}}/><EngineerList team={team}/></>:<EngineerUploadPanel inputRef={inputRef} onFile={handleFile}/>}</section><MapCanvas orders={engineerMarkers} scheduled={false} onOrder={()=>{}} uiTheme={uiTheme}/></div></main>}

function OperationalMapWorkspace({mode,panelKey,backgroundOnly=false,calendarOverOverlay=false,panelOpen=true,onClosePanel,orders,team,region,plan,scheduled,setScheduled,view,setView,openPlan,onOrder,onRoute,onRouteDetails,onOrderHover,onRouteHover,hoveredOrderId,hoveredRouteId,onEmergency,onOpenEngineerRoute,mapping,onUploadError,selectedDate,setSelectedDate,uiTheme,geocodeProgress,onClearGeocodeProgress,selectedOrder,activeRoute}){
  const ordersInputRef=useRef(null),engineersInputRef=useRef(null);
  const[selectedTerritory,setSelectedTerritory]=useState('');
  const[ordersQuery,setOrdersQuery]=useState(''),[engineersQuery,setEngineersQuery]=useState(''),[engineerLoadFilter,setEngineerLoadFilter]=useState('all');
  const[engineerFilters,setEngineerFilters]=useState({skill:'',equipment:'',location:'',transport:'',status:''});
  const[selectedEngineer,setSelectedEngineer]=useState(null),lastSelectedEngineerRef=useRef(null);
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
  const searchedOrders=useMemo(()=>{const query=ordersQuery.trim().toLocaleLowerCase('ru-RU');return query?visibleOrders.filter(order=>[order.id,order.sourceId,displayOrderName(order),order.address,order.skill,order.workType].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(query))):visibleOrders},[visibleOrders,ordersQuery]);
  const searchedDisplayPlan=useMemo(()=>{if(!displayPlan||!ordersQuery.trim())return displayPlan;const allowed=new Set(searchedOrders.map(order=>String(order.id))),routes=displayPlan.routes.map(route=>({...route,assignments:route.assignments.filter(item=>allowed.has(String(item.orderId)))})),unassigned=displayPlan.unassigned.filter(item=>allowed.has(String(item.orderId)));return{...displayPlan,routes,unassigned,metrics:{...displayPlan.metrics,total:searchedOrders.length,assigned:routes.reduce((total,route)=>total+route.assignments.length,0),unassigned:unassigned.length}}},[displayPlan,ordersQuery,searchedOrders]);
  const routesByEngineer=useMemo(()=>{const index=new globalThis.Map();plan?.routes?.forEach(route=>{if(!route.assignments?.length)return;const id=String(route.engineerId),routes=index.get(id)||[];routes.push(route);index.set(id,routes)});return index},[plan]);
  const engineerFilterCounts=useMemo(()=>{let idle=0,light=0;team.forEach(engineer=>{const routes=routesByEngineer.get(String(engineer.id))||[],stops=routes.reduce((total,route)=>total+route.assignments.length,0);if(!routes.length)idle++;else if(stops<=3)light++});return{idle,light}},[team,routesByEngineer]);
  const visibleEngineers=useMemo(()=>{const query=engineersQuery.trim().toLocaleLowerCase('ru-RU');return team.filter(engineer=>{const routes=routesByEngineer.get(String(engineer.id))||[],stops=routes.reduce((total,route)=>total+route.assignments.length,0);if(plan&&engineerLoadFilter==='idle'&&routes.length)return false;if(plan&&engineerLoadFilter==='light'&&(!routes.length||stops>3))return false;const skills=engineerFilterValues(engineer.skills),equipment=engineerFilterValues(engineer.equipment),locations=[engineer.zone,engineer.district,engineer.regionName].filter(Boolean);if(engineerFilters.skill&&!skills.includes(engineerFilters.skill))return false;if(engineerFilters.equipment&&!equipment.includes(engineerFilters.equipment))return false;if(engineerFilters.location&&!locations.includes(engineerFilters.location))return false;if(engineerFilters.transport&&engineer.transport!==engineerFilters.transport)return false;if(engineerFilters.status&&engineer.status!==engineerFilters.status)return false;return !query||[engineer.name,engineer.sourceId,engineer.transport,engineer.zone,engineer.district,engineer.regionName,engineer.startAddress,engineer.status,...skills,...equipment].some(value=>String(value||'').toLocaleLowerCase('ru-RU').includes(query))})},[team,routesByEngineer,plan,engineerLoadFilter,engineersQuery,engineerFilters]);
  useEffect(()=>{if(!plan)setEngineerLoadFilter('all')},[plan]);
  useEffect(()=>{if(!engineersMode){setSelectedEngineer(null);return}if(selectedEngineer&&!team.some(engineer=>engineer.id===selectedEngineer.id))setSelectedEngineer(null)},[engineersMode,team,selectedEngineer]);
  useEffect(()=>{if(engineersMode||!selectedOrder)return undefined;const reveal=()=>document.querySelector(`.route-list-panel [data-order-id="${CSS.escape(String(selectedOrder.id))}"]`)?.scrollIntoView({block:'center',behavior:'smooth'});const frame=requestAnimationFrame(reveal),timer=setTimeout(reveal,320);return()=>{cancelAnimationFrame(frame);clearTimeout(timer)}},[engineersMode,selectedOrder]);
  useEffect(()=>{if(engineersMode||!activeRoute)return undefined;const reveal=()=>document.querySelector(`.route-list-panel [data-engineer-id="${CSS.escape(String(activeRoute.engineerId))}"]`)?.scrollIntoView({block:'center',behavior:'smooth'});const frame=requestAnimationFrame(reveal),timer=setTimeout(reveal,320);return()=>{cancelAnimationFrame(frame);clearTimeout(timer)}},[engineersMode,activeRoute]);
  const engineerMarkers=useMemo(()=>team.map(engineer=>({id:`engineer-${engineer.id}`,engineerId:engineer.id,name:engineer.name,address:engineer.startAddress||region.office,coords:engineer.startCoords,suppressPopup:true})).filter(engineer=>Array.isArray(engineer.coords)&&engineer.coords.length===2),[team,region.office]);
  const mapItems=engineersMode?engineerMarkers:visibleOrders;
  const changeTerritory=next=>{setSelectedTerritory(next);onOrder(null);onRoute(null)};
  const selectEngineerMarker=marker=>{const engineer=team.find(item=>item.id===marker?.engineerId);if(engineer)setSelectedEngineer(engineer)};
  const selectedEngineerRoutes=renderedEngineer?routesByEngineer.get(String(renderedEngineer.id))||[]:[];

  return <main className={`route-workspace ${engineersMode?'engineer-workspace':''} ${backgroundOnly?'workspace-background-only':''} ${calendarOverOverlay?'calendar-over-overlay':''}`}>
    {engineersMode?<Topbar selectedDate={selectedDate} setSelectedDate={setSelectedDate}/>:<><Topbar selectedDate={selectedDate} setSelectedDate={setSelectedDate}/><input className="workspace-file-input" ref={ordersInputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleOrdersFile(event.target.files?.[0]);event.target.value=''}}/></>}
    <div className={`workspace-grid ${engineersMode?'engineer-workspace-grid':''} ${panelPresence.present?'':'panel-collapsed'}`}>
      {panelPresence.present?(engineersMode?
        <section key={panelKey||'engineers'} className={`orders-panel engineer-panel workspace-panel-enter ${panelMotionClass}`}>
          <div className="panel-heading"><div><h3>Инженеры</h3>{team.length?<b className="engineer-count">{team.length}</b>:null}</div><div className="panel-heading-actions">{team.length?<button type="button" className="engineer-reupload" onClick={()=>engineersInputRef.current?.click()} aria-label="Загрузить другой файл" data-tooltip="Загрузить другой файл"><FileUp/></button>:null}<button type="button" className="panel-close" onClick={onClosePanel} aria-label="Скрыть панель инженеров" data-tooltip="Скрыть панель"><X/></button></div></div>
          {team.length?<><input className="workspace-file-input" ref={engineersInputRef} type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event=>{handleEngineersFile(event.target.files?.[0]);event.target.value=''}}/><div className="engineer-tools"><div className="engineer-load-filters" role="group" aria-label="Фильтр загрузки инженеров">{[['all','Все',team.length],['idle','Без маршрута',engineerFilterCounts.idle],['light','1–3 остановки',engineerFilterCounts.light]].map(([key,label,count])=><button type="button" key={key} className={engineerLoadFilter===key?'selected':''} aria-pressed={engineerLoadFilter===key} disabled={!plan&&key!=='all'} onClick={()=>setEngineerLoadFilter(key)}>{label}{plan||key==='all'?<b>{count}</b>:null}</button>)}</div>{!plan?<small>Загрузка появится после построения плана</small>:null}<EngineerFilters team={team} value={engineerFilters} onChange={setEngineerFilters}/><PanelSearch value={engineersQuery} onChange={setEngineersQuery} placeholder="Имя, навык, оборудование…" label="Поиск инженеров"/></div><EngineerList team={visibleEngineers} onSelect={setSelectedEngineer} selectedId={selectedEngineer?.id} routesByEngineer={routesByEngineer} hasPlan={Boolean(plan)}/></>:<EngineerUploadPanel inputRef={engineersInputRef} onFile={handleEngineersFile}/>}
        </section>:
        <section key={panelKey||'orders'} className={`orders-panel route-list-panel workspace-panel-enter ${panelMotionClass} ${zones.length||districts.length?'has-district-filter':''}`}>
          <div className="panel-heading"><div><h3>Заявки</h3>{orders.length?<b className="engineer-count">{orders.length}</b>:null}</div><div className="panel-heading-actions"><button type="button" className="panel-close" onClick={onClosePanel} aria-label="Скрыть панель заявок" data-tooltip="Скрыть панель"><X/></button></div></div>
          <div className="panel-status-row"><div className="status-tabs"><button className={plan&&scheduled?'selected':''} disabled={!plan} onClick={()=>setScheduled(true)}>Назначены{plan?<b>{plan.metrics.assigned}</b>:null}</button><button className={plan&&!scheduled?'selected':''} disabled={!plan} onClick={()=>setScheduled(false)}>Не назначены{plan?<b>{plan.metrics.unassigned}</b>:null}</button></div>{orders.length?<button type="button" className="orders-import-action" onClick={()=>ordersInputRef.current?.click()} aria-label="Загрузить другой файл заявок" data-tooltip="Загрузить другой файл"><FileUp/></button>:null}</div>
          {zones.length||districts.length?<TerritoryFilter zones={zones} districts={districts} value={selectedTerritory} onChange={changeTerritory} total={orders.length}/>:null}
          {orders.length?<div className="orders-search-wrap"><PanelSearch value={ordersQuery} onChange={setOrdersQuery} placeholder="Номер, тип работ или адрес…" label="Поиск заявок"/>{ordersQuery?<small>Найдено: {searchedOrders.length}</small>:null}</div>:null}
          {!orders.length?<UploadEmpty onFile={handleOrdersFile} inputRef={ordersInputRef}/>:ordersQuery.trim()&&!searchedOrders.length?<div className="panel-filter-empty"><Search/><b>Заявки не найдены</b><span>Попробуйте другой номер, адрес или тип работ.</span></div>:scheduled&&searchedDisplayPlan?<AssignmentBoard orders={searchedOrders} plan={searchedDisplayPlan} team={team} onOrder={onOrder} onRoute={onRoute} onRouteDetails={onRouteDetails} onOrderHover={onOrderHover} onRouteHover={onRouteHover} activeRoute={activeRoute} selectedOrder={selectedOrder} onRecalculate={openPlan}/>:searchedOrders.length?<OrderList orders={searchedOrders} onOrder={onOrder} onHover={onOrderHover} selectedId={selectedOrder?.id} plan={searchedDisplayPlan}/>:<div className="resolved-empty"><MapPinned/><h3>{selectedTerritory?'В выбранной территории нет заявок':'Все заявки распределены'}</h3><p>{selectedTerritory?'Выберите другую зону, район или сбросьте фильтр.':'Конфликтов и заявок для ручной обработки нет.'}</p></div>}
        </section>):null}
      <MapCanvas key="persistent-map" orders={mapItems} team={team} scheduled={!engineersMode&&scheduled} plan={engineersMode?null:displayPlan} onOrder={engineersMode?selectEngineerMarker:onOrder} onRoute={onRoute} onRouteDetails={onRouteDetails} onOrderHover={onOrderHover} onRouteHover={onRouteHover} hoveredOrderId={hoveredOrderId} hoveredRouteId={hoveredRouteId} uiTheme={uiTheme} region={region} geocodeProgress={geocodeProgress} onClearGeocodeProgress={onClearGeocodeProgress} selectedOrder={engineersMode?(selectedEngineer?engineerMarkers.find(item=>String(item.engineerId)===String(selectedEngineer.id)):null):selectedOrder} selectedTerritory={engineersMode?'':selectedTerritory} routes={engineersMode?[]:(displayPlan?.routes||[])} activeRoute={engineersMode?null:activeRoute} engineerPopup={engineersMode&&engineerDetailPresence.present&&renderedEngineer?{engineer:renderedEngineer,routes:selectedEngineerRoutes,hasPlan:Boolean(plan),onClose:()=>setSelectedEngineer(null),onOpenRoute:onOpenEngineerRoute,motionClass:engineerDetailMotionClass}:null}/>
      {!engineersMode&&orders.length&&panelPresence.present?<button type="button" className="map-plan-action" onClick={openPlan}><WandSparkles/><span>{plan?'Пересчитать план':'Построить план'}</span></button>:null}
    </div>
  </main>;
}
function AnalyticsPage({orders,team,plan,analyticsDate,setAnalyticsDate,onOpenUnassigned,onOpenRoutes,onOpenOrder,onPreviewReplan,onApplyReplan,onRollbackReplan,onStartLiveReplan,onForceAssignment,motionClass=''}){return <PageShell floating title="Аналитика" motionClass={motionClass}><AnalyticsWorkspace orders={orders} team={team} plan={plan} date={analyticsDate} onDateChange={setAnalyticsDate} dateControl={<DateControl className="analytics-date-control" value={analyticsDate} onChange={setAnalyticsDate}/>} onOpenUnassigned={onOpenUnassigned} onOpenRoutes={onOpenRoutes} onOpenOrder={onOpenOrder} onPreviewReplan={onPreviewReplan} onApplyReplan={onApplyReplan} onRollbackReplan={onRollbackReplan} onStartLiveReplan={onStartLiveReplan} onForceAssignment={onForceAssignment}/></PageShell>}
function SettingsPage({ settings, setSettings, region, setRegion, onToast }) {
  const [tab, setTab] = useState('company');
  const [health, setHealth] = useState({ status: 'loading' });
  const update = (key, value) => setSettings(current => ({ ...current, [key]: value }));
  const save = () => {
    onToast('Настройки рабочего пространства сохранены');
    try { localStorage.setItem('beego-settings', JSON.stringify(settings)); } catch {}
  };
  useEffect(() => {
    let active = true;
    fetch('/api/health')
      .then(response => response.json().then(payload => ({ ok: response.ok, payload })))
      .then(({ ok, payload }) => { if (active) setHealth(ok ? payload : { status: 'error' }); })
      .catch(() => { if (active) setHealth({ status: 'error' }); });
    return () => { active = false; };
  }, []);
  const navigation = [
    ['company', 'Компания', Building2],
    ['regions', 'Рабочие пространства', MapPinned],
    ['norms', 'Нормативы', Clock3],
    ['integrations', 'Интеграции', ServerCog],
  ];
  const connected = health.status === 'ok';
  return <PageShell title="Настройки" action={<button className="primary" onClick={save}><Save/>Сохранить изменения</button>}>
    <div className="settings-overview">
      <div><span className="settings-brand"><Activity/></span><div><b>BeeGo! Operations</b><p>Конфигурация диспетчерского пространства и точного планировщика</p></div></div>
      <span className={`backend-status ${connected ? '' : 'offline'}`}><i/>{connected ? 'Backend доступен · Exact v2.1' : health.status === 'loading' ? 'Проверяем backend…' : 'Exact backend недоступен'}</span>
    </div>
    <div className="settings-layout settings-modern">
      <aside>{navigation.map(([id, label, Icon]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon/><span>{label}</span><ChevronRight/></button>)}</aside>
      <section>
        {tab === 'company' ? <>
          <div className="settings-heading"><div><small>ОРГАНИЗАЦИЯ</small><h2>Профиль компании</h2><p>Общие данные рабочего пространства.</p></div></div>
          <div className="form-card settings-card">
            <div className="card-title"><Building2/><div><h3>Основные данные</h3><p>Название и контакты диспетчерской команды</p></div></div>
            <label>Название компании<input value={settings.company} onChange={event => update('company', event.target.value)}/></label>
            <div className="form-row"><label>Рабочий email<input value={settings.email} onChange={event => update('email', event.target.value)}/></label><label>Телефон<input value={settings.phone} onChange={event => update('phone', event.target.value)}/></label></div>
          </div>
          <div className="form-card settings-card"><div className="card-title"><Clock3/><div><h3>Локализация</h3><p>Фиксированные параметры текущего набора</p></div></div><div className="choice-row"><span className="selected">Километры <Check/></span><span className="selected">24-часовой формат <Check/></span><span className="selected">Москва, UTC+3 <Check/></span></div></div>
        </> : null}
        {tab === 'regions' ? <>
          <div className="settings-heading"><small>РАБОЧИЕ ПРОСТРАНСТВА</small><h2>Независимые регионы</h2><p>У каждого региона свой офис, заявки и команда. Данные между участками не смешиваются.</p></div>
          <div className="region-settings-grid">{REGIONS.map(item => <button key={item.id} className={region.id === item.id ? 'selected' : ''} onClick={() => setRegion(item)}><span>{item.code}</span><div><b>{item.name}</b><small>{item.office}</small><em>Исполнители загружаются из набора данных</em></div>{region.id === item.id ? <Check/> : null}</button>)}</div>
          <div className="form-card settings-card"><div className="card-title"><MapPin/><div><h3>Стартовая точка участка</h3><p>Все исполнители начинают день из указанного офиса</p></div></div><label>Адрес офиса<input value={region.office} readOnly/></label><div className="read-only-note"><LockKeyhole/> Офис передаётся в точный планировщик как depot.</div></div>
        </> : null}
        {tab === 'norms' ? <>
          <div className="settings-heading"><small>НОРМАТИВЫ</small><h2>Продолжительность работ</h2><p>Нормативы читаются из запечатанного набора данных и не редактируются после публикации плана.</p></div>
          <div className="norm-grid">{[['Локальные работы', '60'], ['Дозаказ', '60'], ['Подключение', '90'], ['Аварийные работы', '90']].map(([label, value]) => <div className="norm-readonly" key={label}><span>{label}</span><b>{value} мин</b></div>)}</div>
          <div className="read-only-note"><Clock3/> Клиентское окно ограничивает начало работы; завершение может выйти за его пределы.</div>
        </> : null}
        {tab === 'integrations' ? <>
          <div className="settings-heading"><small>ИНТЕГРАЦИИ</small><h2>Фактическая готовность backend</h2><p>Статусы получены из API, а не заданы в интерфейсе.</p></div>
          <div className="integration-list">
            <article><span className={`integration-icon ${connected ? 'connected' : ''}`}><ServerCog/></span><div><b>Planning API</b><p>Единственный опубликованный план: 205/205, 28 бригад</p></div><em>{connected ? 'Подключено' : 'Недоступно'}</em></article>
            <article><span className={`integration-icon ${health.dynamicReplanning === 'connected' ? 'connected' : ''}`}><RefreshCw/></span><div><b>Exact Replanning API</b><p>OR-Tools, Valhalla и независимая проверка после события</p></div><em>{health.dynamicReplanning === 'connected' ? 'Подключено' : 'Требуется backend'}</em></article>
            <article><span className="integration-icon connected"><Map/></span><div><b>Маршрутный oracle</b><p>Кэш Valhalla и локальное расписание московского транспорта</p></div><em>Проверяется при расчёте</em></article>
          </div>
        </> : null}
      </section>
    </div>
  </PageShell>;
}
function SettingsModal({onClose,...props}){return <div className="modal-backdrop settings-modal-layer" role="dialog" aria-modal="true" aria-label="Настройки BeeGo!" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><section className="modal wide settings-modal-dialog"><button className="settings-modal-close" onClick={onClose} aria-label="Закрыть настройки" data-tooltip="Закрыть"><X/></button><SettingsPage {...props}/></section></div>}
export function App(){
  const[settingsOpen,setSettingsOpen]=useState(false);
  const lastMapScreenRef=useRef('orders');
  const appShellRef=useRef(null),previousExpandedRef=useRef(true),railAnimationsRef=useRef([]),toastSwipeRef=useRef(null);
  const[expanded,setExpanded]=useState(true),[screen,setScreen]=useState('orders'),[workspacePanelOpen,setWorkspacePanelOpen]=useState(true);const[theme,setTheme]=useState(()=>{try{return localStorage.getItem('beego-theme')==='dark'?'dark':'light'}catch{return'light'}});const[profile,setProfile]=useState(()=>{try{return {...{name:'Юлия Кузнецова',role:'dispatcher',email:'y.kuznetsova@beego.ru',avatar:'',avatarTone:'honey'},...JSON.parse(localStorage.getItem('beego-profile')||'{}')}}catch{return{name:'Юлия Кузнецова',role:'dispatcher',email:'y.kuznetsova@beego.ru',avatar:'',avatarTone:'honey'}}}),[profileOpen,setProfileOpen]=useState(false),[helpOpen,setHelpOpen]=useState(false);const[region,setRegion]=useState(DEFAULT_REGION);const[orders,setOrders]=useState([]),[engineers,setEngineers]=useState([]),[importSession,setImportSession]=useState(null),[reviewSession,setReviewSession]=useState(null);const[plan,setPlan]=useState(null),[planOpen,setPlanOpen]=useState(false);const[scheduled,setScheduled]=useState(false),[view,setView]=useState('timeline');const[selectedDate,setSelectedDate]=useState(()=>startOfDay(new Date())),[analyticsDate,setAnalyticsDate]=useState(()=>startOfDay(new Date()));const[selectedOrder,setSelectedOrder]=useState(null),[routeDetail,setRouteDetail]=useState(null),[focusedRoute,setFocusedRoute]=useState(null),[hoveredOrder,setHoveredOrder]=useState(null),[hoveredRouteId,setHoveredRouteId]=useState(null);const[optimizing,setOptimizing]=useState(false),[toast,setToast]=useState(null),[geocodeProgress,setGeocodeProgress]=useState(null);const[notifications,setNotifications]=useState(()=>{try{const stored=JSON.parse(localStorage.getItem('beego-notifications')||'[]');return Array.isArray(stored)?stored:[]}catch{return[]}}),[notificationsOpen,setNotificationsOpen]=useState(false);const toastTimersRef=useRef([]);const[settings,setSettings]=useState(()=>{const defaults={company:'Билайн Бизнес',email:'team@beego.ru',phone:'+7 999 000-00-00',balance:true,prioritizeUrgent:true,lockManual:true,allowLate:false};try{return{...defaults,...JSON.parse(localStorage.getItem('beego-settings')||'{}')}}catch{return defaults}});
  const[replanSnapshot,setReplanSnapshot]=useState(null);
  const[reviewFiles,setReviewFiles]=useState([]);
  useEffect(()=>{setSelectedDate(startOfDay(new Date()))},[]);
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
  const toggleNotifications=()=>setNotificationsOpen(open=>{const next=!open;if(next){setHelpOpen(false);setSelectedOrder(null);setRouteDetail(null)}return next});
  const regions=useMemo(()=>regionCatalog(orders,engineers,region),[orders,engineers]);
  const regionOrders=useMemo(()=>orders.filter(order=>order.regionId===region.id),[orders,region.id]);const team=useMemo(()=>engineers.filter(engineer=>engineer.regionId===region.id),[engineers,region.id]);
  useEffect(()=>{setPlan(null);setScheduled(false);setSelectedOrder(null);setRouteDetail(null);setFocusedRoute(null)},[region.id]);
  const showMapping=session=>{setImportSession(session);setProfileOpen(false);setSettingsOpen(false)};
  const selectReviewFile=file=>setImportSession({...file,mode:'review',reviewFiles,onSelectFile:selectReviewFile,onAddFile:showMapping,onFileError:message=>notify(message,{title:'Не удалось добавить файл'})});
  const openReview=()=>{if(!reviewSession)return;selectReviewFile(reviewSession);setProfileOpen(false);setSettingsOpen(false);setHelpOpen(false);setNotificationsOpen(false)};
  const importRows=async({orders:nextOrders=[],engineers:nextEngineers=[]},reviewSnapshot)=>{
    if(reviewSnapshot){
      const normalizedSnapshot={...reviewSnapshot,fileId:reviewSnapshot.fileId||`${reviewSnapshot.fileName||'file'}:${Date.now()}`,importedAt:reviewSnapshot.importedAt||Date.now()};
      setReviewFiles(current=>[...current.filter(file=>file.fileId!==normalizedSnapshot.fileId&&file.fileName!==normalizedSnapshot.fileName),normalizedSnapshot]);
      setReviewSession(current=>({
        ...normalizedSnapshot,
        datasets:{...(current?.datasets||{}),...normalizedSnapshot.datasets},
      }));
    }
    const importedRegionIds=new Set([...nextOrders,...nextEngineers].map(item=>item.regionId).filter(Boolean));
    const replaceImportedOrders=next=>setOrders(current=>[...current.filter(order=>!importedRegionIds.has(order.regionId)),...next]);
    if(nextOrders.length)replaceImportedOrders(nextOrders);
    if(nextEngineers.length)setEngineers(current=>[...current.filter(engineer=>!importedRegionIds.has(engineer.regionId)),...nextEngineers]);
    const firstImported=nextOrders[0]||nextEngineers[0];
    if(firstImported){const nextRegion=regionCatalog(nextOrders,nextEngineers,region).find(item=>item.id===firstImported.regionId);if(nextRegion)setRegion(nextRegion)}
    const importedDate=resolveImportedDate(nextOrders);
    if(importedDate){setSelectedDate(importedDate);setAnalyticsDate(importedDate)}
    setPlan(null);setImportSession(null);setScheduled(false);setSelectedOrder(null);
    const parts=[nextOrders.length?`${nextOrders.length} заявок`:'',nextEngineers.length?`${nextEngineers.length} инженеров`:''].filter(Boolean);
    const missing=nextOrders.filter(order=>!Array.isArray(order.coords)||order.coords.length!==2||!order.coords.every(Number.isFinite));
    if(!missing.length){const cityCount=new Set([...nextOrders,...nextEngineers].map(item=>item.regionId)).size;notify(`${parts.join(' и ')} загружено · ${cityCount} ${cityCount===1?'город':'города'}`);return}
    try{
      const geocoded=await geocodeImportedOrders(nextOrders,setGeocodeProgress,replaceImportedOrders);
      replaceImportedOrders(geocoded);
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
  const optimize=async(sharedInventory=[])=>{setOptimizing(true);try{const planningDate=selectedDate instanceof Date?`${selectedDate.getFullYear()}-${String(selectedDate.getMonth()+1).padStart(2,'0')}-${String(selectedDate.getDate()).padStart(2,'0')}`:String(selectedDate||'').slice(0,10);const next=await requestPlan(regionOrders,team,region.id,planningDate,sharedInventory);setPlan(next);setPlanOpen(false);setScheduled(true);setFocusedRoute(null);setView('timeline');notify(`План проверен: распределено ${next.metrics.assigned} из ${next.metrics.total}. Для ручного решения: ${next.metrics.unassigned}`,{title:'План готов'})}catch(error){notify(error?.message||'Не удалось построить план',{title:'Планирование не выполнено'})}finally{setOptimizing(false)}};
  const previewReplan=async(model,basePlan)=>{if(!basePlan)throw new Error('Нет опубликованного плана для пересчёта');return requestReplan(model,basePlan)};
  const forceAssignment=async(orderId,engineerId)=>{
    if(!plan)throw new Error('Сначала постройте точный план');
    const order=regionOrders.find(item=>String(item.id)===String(orderId));
    const engineer=team.find(item=>String(item.id)===String(engineerId));
    if(!order||!engineer)throw new Error('Заявка или инженер не найдены в текущем регионе');
    const planningTime=String(plan.createdAt||'').match(/T(\d{2}:\d{2})/)?.[1];
    if(!planningTime)throw new Error('В точном плане отсутствует время расчёта');
    const nextPlan=await requestReplan({orders:regionOrders,team,event:{type:'FORCED_ASSIGNMENT',time:planningTime,orderId:order.id,sourceOrderId:order.sourceId,engineerId:engineer.id,sourceEngineerId:engineer.sourceId}},plan);
    const assigned=nextPlan.routes.some(route=>String(route.engineerId)===String(engineer.id)&&route.assignments.some(item=>String(item.orderId)===String(order.id)));
    if(!assigned)throw new Error('Точный планировщик не подтвердил выбранное назначение');
    setReplanSnapshot({orders:regionOrders,team,plan,scheduled});
    setPlan(nextPlan);setScheduled(true);
    notify(`Заявка ${order.sourceId||order.id} закреплена за ${engineer.name}; маршрут пересчитан и проверен.`,{title:'Назначение опубликовано'});
    return nextPlan;
  };
  const applyReplan=({orders:nextOrders,team:nextTeam,plan:nextPlan})=>{setReplanSnapshot({orders:regionOrders,team,plan,scheduled});setOrders(current=>[...current.filter(order=>order.regionId!==region.id),...nextOrders]);setEngineers(current=>[...current.filter(engineer=>engineer.regionId!==region.id),...nextTeam]);setPlan(nextPlan);setScheduled(true);setSelectedOrder(null);setRouteDetail(null);setFocusedRoute(null);notify(`План принят: распределено ${nextPlan.metrics.assigned} из ${nextPlan.metrics.total}.`,{title:'Перепланирование применено'})};
  const rollbackReplan=()=>{if(!replanSnapshot)return;setOrders(current=>[...current.filter(order=>order.regionId!==region.id),...replanSnapshot.orders]);setEngineers(current=>[...current.filter(engineer=>engineer.regionId!==region.id),...replanSnapshot.team]);setPlan(replanSnapshot.plan);setScheduled(replanSnapshot.scheduled);setReplanSnapshot(null);notify('Предыдущий опубликованный план восстановлен.',{title:'Изменения отменены'})};
  const addEmergency=async()=>{if(regionOrders.some(order=>order.sourceId==='EAST-EVENT-001')){notify('Контрольная аварийная заявка уже загружена',{title:'Событие уже учтено'});return}if(!plan){notify('Сначала постройте исходный точный план',{title:'Нет исходного плана'});return}setOptimizing(true);try{const response=await fetch('/api/scenario/event');const payload=await response.json().catch(()=>({}));if(!response.ok||!payload.order)throw new Error(payload.error||'Контрольное событие недоступно');const nextId=Math.max(0,...orders.map(order=>Number(order.id)||0))+1;const emergency={...payload.order,id:nextId};const nextOrders=[...regionOrders,emergency];const model={orders:nextOrders,team,event:{type:'NEW_ORDER',time:String(payload.order.createdAt||'').match(/T(\d{2}:\d{2})/)?.[1]||'13:30',orderId:emergency.id}};const nextPlan=await requestReplan(model,plan);setOrders(current=>[...current,emergency]);setSelectedOrder(emergency);setPlan(nextPlan);setScheduled(true);notify('Аварийная заявка добавлена — точный событийный план проверен и опубликован',{title:'Перепланирование завершено'})}catch(error){notify(error?.message||'Не удалось перестроить точный план',{title:'Перепланирование не выполнено'})}finally{setOptimizing(false)}};
  const unreadNotifications=notifications.filter(item=>!item.read).length;
  if(screen==='orders'||screen==='engineers')lastMapScreenRef.current=screen;
  const overlayScreen=OVERLAY_SCREENS.has(screen)?screen:null;
  const overlayPresence=useWorkspacePresence(overlayScreen);
  const renderedOverlayScreen=overlayPresence.renderedKey;
  const overlayMotionClass=overlayPresence.motionClass;
  const page=useMemo(()=>{
    const selectOrder=order=>{setRouteDetail(null);setSelectedOrder(order||null)};
    const focusRoute=route=>{setSelectedOrder(null);setRouteDetail(null);setFocusedRoute(route||null)};
    const openRouteDetails=route=>{setSelectedOrder(null);setFocusedRoute(route);setRouteDetail(route)};
    const openEngineerRoute=route=>{if(!route)return;setSelectedOrder(null);setRouteDetail(null);setFocusedRoute(null);setScheduled(true);setWorkspacePanelOpen(true);setScreen('orders');requestAnimationFrame(()=>setFocusedRoute(route))};
    const mapScreen=screen==='orders'||screen==='engineers';
    const retainedMapScreen=mapScreen?screen:lastMapScreenRef.current;
    const workspaceProps={mode:retainedMapScreen==='engineers'?'engineers':'orders',panelKey:retainedMapScreen,backgroundOnly:Boolean(overlayScreen)||(overlayPresence.present&&!workspacePanelOpen),calendarOverOverlay:Boolean(overlayScreen)||overlayPresence.present,panelOpen:workspacePanelOpen,onClosePanel:()=>setWorkspacePanelOpen(false),orders:regionOrders,team,region,plan,scheduled,setScheduled,view,setView,openPlan:()=>setPlanOpen(true),onOrder:selectOrder,onRoute:focusRoute,onRouteDetails:openRouteDetails,onOrderHover:setHoveredOrder,onRouteHover:setHoveredRouteId,hoveredOrderId:hoveredOrder?.id,hoveredRouteId,onEmergency:addEmergency,onOpenEngineerRoute:openEngineerRoute,mapping:showMapping,onUploadError:notify,selectedDate,setSelectedDate,uiTheme:theme,geocodeProgress,onClearGeocodeProgress:()=>setGeocodeProgress(null),selectedOrder,activeRoute:focusedRoute};
    let overlay=null;
    if(overlayPresence.present&&renderedOverlayScreen==='analytics')overlay=<AnalyticsPage orders={regionOrders} team={team} plan={plan} analyticsDate={analyticsDate} setAnalyticsDate={setAnalyticsDate} motionClass={overlayMotionClass} onOpenUnassigned={()=>{setScheduled(false);setWorkspacePanelOpen(true);setScreen('orders')}} onOpenRoutes={engineerId=>{const route=plan?.routes?.find(item=>String(item.engineerId)===String(engineerId))||null;if(!route)return;setSelectedOrder(null);setRouteDetail(null);setFocusedRoute(null);setScheduled(Boolean(plan));setView('timeline');setWorkspacePanelOpen(true);setScreen('orders');requestAnimationFrame(()=>setFocusedRoute(route))}} onOpenOrder={orderId=>{const order=regionOrders.find(item=>String(item.id)===String(orderId))||null;if(!order)return;setRouteDetail(null);setFocusedRoute(null);setSelectedOrder(order);setScheduled(Boolean(plan));setView('timeline');setWorkspacePanelOpen(true);setScreen('orders')}} onPreviewReplan={previewReplan} onApplyReplan={applyReplan} onRollbackReplan={rollbackReplan} onForceAssignment={forceAssignment} onStartLiveReplan={()=>{setScheduled(false);setWorkspacePanelOpen(true);setScreen('orders')}}/>;
    else if(overlayPresence.present&&renderedOverlayScreen==='locations')overlay=<LocationsPage regions={regions} region={region} onSelect={setRegion} onOpenOrders={()=>{setWorkspacePanelOpen(true);setScreen('orders')}} onClose={()=>{setWorkspacePanelOpen(false);setScreen(lastMapScreenRef.current)}} motionClass={overlayMotionClass}/>;
    return <><OperationalMapWorkspace {...workspaceProps}/>{overlay}</>;
  },[screen,workspacePanelOpen,regionOrders,team,plan,scheduled,view,selectedDate,analyticsDate,theme,settings,region,regions,geocodeProgress,selectedOrder,focusedRoute,hoveredOrder,hoveredRouteId,overlayScreen,overlayPresence.present,renderedOverlayScreen,overlayMotionClass,replanSnapshot]);
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
  },[expanded,hasMapOverlay]);
  const toastPresentation=toast?notificationPresentation(toast):null;
  const navigateScreen=(next,{togglePanel=false}={})=>{if(next!==screen){setSelectedOrder(null);setRouteDetail(null)}if(next==='engineers')setFocusedRoute(null);if(OVERLAY_SCREENS.has(next)&&screen===next){setWorkspacePanelOpen(false);setScreen(lastMapScreenRef.current)}else{if(next==='orders'||next==='engineers')setWorkspacePanelOpen(open=>togglePanel&&screen===next?!open:true);setScreen(next)}setSettingsOpen(false);setNotificationsOpen(false)};
  return <div ref={appShellRef} className={`app-shell ${theme==='dark'?'dark':''} ${expanded?'sidebar-expanded':''} ${hasMapOverlay?'has-map-overlay':''} ${overlayScreen?`overlay-${overlayScreen}`:''}`} style={{'--accent':ACCENT}}><Sidebar expanded={expanded} setExpanded={setExpanded} screen={screen} workspacePanelOpen={workspacePanelOpen} setScreen={navigateScreen} orderCount={regionOrders.length} theme={theme} setTheme={setTheme} profile={profile} onProfile={()=>{setSettingsOpen(false);setNotificationsOpen(false);setProfileOpen(true)}} helpOpen={helpOpen} onHelp={()=>{setProfileOpen(false);setSettingsOpen(false);setNotificationsOpen(false);setSelectedOrder(null);setRouteDetail(null);setHelpOpen(open=>!open)}} settingsOpen={settingsOpen} onSettings={()=>{setProfileOpen(false);setNotificationsOpen(false);setSettingsOpen(open=>!open)}} region={region} notificationsOpen={notificationsOpen} onNotifications={toggleNotifications} unreadNotifications={unreadNotifications} hasReviewData={Boolean(reviewSession)} onOpenReview={openReview}/>{page}<NotificationCenter items={notifications} open={notificationsOpen} expanded={expanded} onClose={()=>setNotificationsOpen(false)} onClear={clearNotificationGroup} onRead={markNotificationRead}/>{settingsOpen?<SettingsModal settings={settings} setSettings={setSettings} region={region} regions={regions} setRegion={setRegion} onToast={notify} onClose={()=>setSettingsOpen(false)}/>:null}{helpOpen?<HelpCenter profile={profile} onClose={()=>setHelpOpen(false)}/>:null}{profileOpen?<ProfileModal profile={profile} onClose={()=>setProfileOpen(false)} onSave={next=>{setProfile(next);setProfileOpen(false);notify('Профиль сохранён')}}/>:null}{importSession?<ImportWorkspace session={importSession} region={importSession.reviewRegion||region} onCancel={()=>setImportSession(null)} onImport={importRows}/>:null}{planOpen?<PlanDrawer orders={regionOrders} team={team} onClose={()=>setPlanOpen(false)} onOptimize={optimize} optimizing={optimizing} selectedDate={selectedDate}/>:null}<DetailDrawer order={selectedOrder} route={routeDetail} orders={regionOrders} team={team} plan={plan} onRecalculate={()=>{setSelectedOrder(null);setRouteDetail(null);setPlanOpen(true)}} onOpenRoute={nextRoute=>{setSelectedOrder(null);setFocusedRoute(nextRoute);setRouteDetail(nextRoute)}} onClose={()=>{setSelectedOrder(null);setRouteDetail(null)}}/>{toast?<div className={`toast ${toast.closing?'is-closing':''}`} style={{'--toast-exit-x':`${(toast.exitDirection||1)*42}px`}} data-notification-id={toast.id} data-notification-kind={toastPresentation.kind} onPointerDown={event=>{if(event.target.closest('button'))return;event.currentTarget.setPointerCapture?.(event.pointerId);toastSwipeRef.current={id:toast.id,x:event.clientX,y:event.clientY}}} onPointerMove={event=>{const swipe=toastSwipeRef.current;if(!swipe||swipe.id!==toast.id)return;const dx=event.clientX-swipe.x;if(Math.abs(dx)>Math.abs(event.clientY-swipe.y))event.currentTarget.style.transform=`translateX(${dx}px)`}} onPointerUp={event=>{const swipe=toastSwipeRef.current;toastSwipeRef.current=null;if(!swipe)return;const dx=event.clientX-swipe.x;event.currentTarget.style.transform='';if(Math.abs(dx)>=72)dismissToastAsRead(toast.id,dx<0?-1:1)}} onPointerCancel={event=>{toastSwipeRef.current=null;event.currentTarget.style.transform=''}}><span className="toast-artwork"><NotificationArtwork kind={toastPresentation.kind}/></span><div className="toast-copy"><div className="toast-heading"><b>{toastPresentation.title}</b><time>{toast.time}</time></div><p>{toast.message}</p><button type="button" className="toast-mark-read" onClick={()=>dismissToastAsRead(toast.id,1)}><Check/><span>Прочитано</span></button></div></div>:null}</div>
}
