import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Check, ChevronLeft, ChevronRight, Clock3, MapPin, Search, X } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { cachedObjectPassport, clearObjectPassports, loadObjectPassport } from './objectPassport.js';
import { objectTimeCategory, visitTimeRows } from './objectPresentation.js';
import './complexity.css';

const KINDS = { connection: 'Подключение', local: 'Ремонт и диагностика', equipment: 'Работы с оборудованием', emergency: 'Аварийные работы', information: 'Информационная заявка' };
const SCOPES = { object: 'Объект', entrance: 'Подъезд', node: 'Технический узел', line: 'Линия', operation: 'Такие же работы' };
const REASONS = { access: 'Доступ', extra: 'Дополнительные работы', diagnosis: 'Диагностика', customer: 'Ожидание клиента', simpler: 'Более простой объём', unknown: 'Причина неизвестна', other: 'Другое' };
const options = dictionary => Object.entries(dictionary).map(([value, label]) => ({ value, label }));
const day = value => typeof value === 'string' ? value.slice(0, 10) : value?.toLocaleDateString('sv-SE') || '2026-08-17';
const asOf = value => `${day(value)}T23:59:00+03:00`;
const number = value => Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : '—';
const dateLabel = value => value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : 'Не установлен';
const requestJson = async (url, init) => {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Не удалось сохранить изменение.');
  return payload;
};
const send = (url, input, method = 'POST') => requestJson(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
const changed = () => { clearObjectPassports(); window.dispatchEvent(new Event('beego:complexity-changed')); };
const deltaLabel = value => value === 0 ? 'По нормативу' : `${Math.abs(value)} мин ${value > 0 ? 'дольше' : 'быстрее'} норматива`;
const passportTarget = (object, kind, volume) => ({ objectId: object.id, address: object.address, passportKind: object.kind || kind, passportVolume: volume, passportSummary: { object, estimate: object.estimate } });
const visitScope = visit => visit?.forecast?.factors?.requiresNode && visit.entities?.node ? 'node' : visit?.entities?.line ? 'line' : visit?.entities?.entrance ? 'entrance' : 'object';

/** Open the same object passport from orders, routes, map or analytics. */
export function openObjectPassport(orderOrObject, tab = 'overview') {
  window.dispatchEvent(new CustomEvent('beego:passport', { detail: { target: orderOrObject, tab } }));
}

/** Render the immutable forecast attached to the published order. */
export function DurationBreakdown({ snapshot, compact = false, expanded = false }) {
  if (!snapshot) return <p className='cx-muted'>Расчёт времени недоступен.</p>;
  return <section className={`cx-breakdown ${compact ? 'compact' : ''}`} aria-label='Расчёт длительности'>
    <div className='cx-duration-hero'><Clock3 size={20}/><strong>{snapshot.total} <small>мин</small></strong><span>Время визита</span></div>
    <dl><div><dt>Работа на объекте</dt><dd>{snapshot.technical} мин</dd></div>{snapshot.access > 0 ? <div><dt>Дополнительное время на доступ</dt><dd>{snapshot.access} мин</dd></div> : null}{snapshot.documents > 0 ? <div><dt>Оформление</dt><dd>{snapshot.documents} мин</dd></div> : null}</dl>
    {snapshot.override ? <p className='cx-note'>Ручная корректировка: {snapshot.override.minutes} мин. {snapshot.override.reason}. Автоматический расчёт: {snapshot.calculatedTotal} мин.</p> : null}
    <details open={expanded || undefined}><summary>Из чего складывается время работы</summary><dl>{snapshot.components.map((component, index) => <div key={`${component.key}-${index}`}><dt>{component.key === 'base' ? 'Норматив работы' : component.label}</dt><dd>{component.minutes > 0 && index ? '+' : ''}{component.minutes} мин</dd></div>)}{snapshot.historyMinutes ? <div><dt>Поправка по прошлым визитам</dt><dd>{snapshot.historyMinutes > 0 ? '+' : ''}{snapshot.historyMinutes} мин</dd></div> : null}</dl>{snapshot.histories.map(item => <p key={item.conditionId}>{REASONS[item.reason]} · {SCOPES[item.scope]} · {item.count} визитов · {item.minutes > 0 ? '+' : ''}{item.minutes} мин</p>)}</details>
  </section>;
}

/** Conditional questions and a server-calculated preview shared by creation paths. */
export function DurationFields({ form, onChange, date }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [places, setPlaces] = useState([]);
  const [infrastructure, setInfrastructure] = useState([]);
  const kind = /Подключ/.test(form.skill) ? 'connection' : /Дозаказ/.test(form.skill) ? 'equipment' : /Авар/.test(form.skill) ? 'emergency' : 'local';
  const factors = form.durationFactors || {};
  const setFactor = (key, value) => onChange('durationFactors', { ...factors, [key]: value });
  useEffect(() => {
    let live = true;
    setPreview(null);
    const timer = setTimeout(async () => {
      try {
        const result = await send('/api/complexity/estimate', { persist: false, order: { id: form.sourceId || 'preview', objectId: form.objectId, serviceEntities: form.serviceEntities, workType: form.skill, durationFactors: factors, durationOverride: form.durationOverride }, asOf: `${day(date)}T07:00:00+03:00` });
        if (live) { setPreview(result.snapshot); onChange('duration', String(result.snapshot.total)); setError(''); }
      } catch (issue) { if (live) { setError(issue.message); setPreview(null); } }
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [form.skill, form.objectId, JSON.stringify(form.serviceEntities), JSON.stringify(factors), JSON.stringify(form.durationOverride), day(date)]);
  useEffect(() => { let live = true; const load = async () => { try { const items = await requestJson(`/api/complexity/objects?at=${encodeURIComponent(asOf(date))}`); if (live) setPlaces(items); } catch (issue) { if (live) setError(issue.message); } }; load(); return () => { live = false; }; }, [day(date)]);
  useEffect(() => { if (!form.objectId) { setInfrastructure([]); return; } let live = true; const load = async () => { try { const result = await requestJson(`/api/complexity/objects/${encodeURIComponent(form.objectId)}?at=${encodeURIComponent(asOf(date))}`); if (live) setInfrastructure(result.entities); } catch (issue) { if (live) setError(issue.message); } }; load(); return () => { live = false; }; }, [form.objectId, day(date)]);
  const select = (key, label, choices, fallback) => <label key={key}>{label}<BusinessSelect ariaLabel={label} value={factors[key] ?? fallback} onChange={value => setFactor(key, value)} options={choices.map(([value, text]) => ({ value, label: text }))}/></label>;
  const count = (key, label, max = 100) => <label key={key}>{label}<input type='number' min='1' max={max} value={factors[key] ?? 1} onChange={event => setFactor(key, event.target.value)}/></label>;
  const flag = (key, label) => <label className='cx-check' key={key}><input type='checkbox' checked={Boolean(factors[key])} onChange={event => setFactor(key, event.target.checked)}/>{label}</label>;
  return <section className='cx-fields wide'><div className='cx-section-heading'><Clock3 size={18}/><h3>Расчёт длительности</h3><span>Автоматически</span></div><label>Объект из реестра<BusinessSelect ariaLabel='Объект для новой заявки' searchable value={form.objectId || ''} onChange={value => { onChange('objectId', value || undefined); onChange('serviceEntities', value ? { object: value } : undefined); const place = places.find(item => item.id === value); if (place) { onChange('address', place.address); onChange('coords', place.coords); onChange('locationSource', 'file'); } }} options={[{ value: '', label: 'Новый объект или точка обслуживания' }, ...places.map(place => ({ value: place.id, label: places.filter(item => item.address === place.address).length > 1 ? `${place.address} · ${place.id.slice(-6)}` : place.address }))]}/></label>{form.objectId ? <div className='cx-field-grid'>{['entrance', 'node', 'line'].map(scope => <label key={scope}>{SCOPES[scope]}<BusinessSelect ariaLabel={`Связь новой заявки: ${SCOPES[scope]}`} value={form.serviceEntities?.[scope] || ''} onChange={value => { const links = { ...form.serviceEntities }; if (value) links[scope] = value; else delete links[scope]; onChange('serviceEntities', links); }} options={[{ value: '', label: 'Связь не установлена' }, ...infrastructure.filter(entity => entity.kind === scope).map(entity => ({ value: entity.id, label: entity.label }))]}/></label>)}</div> : null}<div className='cx-field-grid'>
    {kind === 'connection' ? <>{select('line', 'Линия до квартиры', [['unknown', 'Не уточнено'], ['existing', 'Есть пригодная линия'], ['new', 'Новая прокладка']], 'unknown')}{count('points', 'Согласованные точки')}</> : null}
    {kind === 'local' ? <>{select('diagnosis', 'Проявление неисправности', [['unknown', 'Нужна диагностика'], ['known', 'Место неисправности известно'], ['intermittent', 'Периодические сбои']], 'unknown')}{count('segments', 'Проверяемые сегменты')}{flag('replaceDevice', 'Замена и восстановление настройки')}</> : null}
    {kind === 'equipment' ? <>{select('action', 'Состав дозаказа', [['add', 'Добавление'], ['replace', 'Замена'], ['move', 'Перенос']], 'add')}{flag('firmwareRequired', 'Подтверждено обязательное обновление устройства')}</> : null}
    {['connection', 'equipment'].includes(kind) ? count('devices', 'Количество устройств') : null}
    {kind === 'emergency' ? <>{select('damage', 'Подтверждённое повреждение', [['unknown', 'Состав ещё не установлен'], ['cable', 'Кабельная линия'], ['equipment', 'Замена оборудования'], ['multiple', 'Несколько элементов']], 'unknown')}{flag('nodeSearch', 'Узел аварии нужно локализовать')}{flag('readyConfig', 'Есть готовая пригодная конфигурация')}</> : null}
    {factors.line !== 'existing' ? select('cable', 'Объём прокладки или замены', [['none', 'Без кабельных работ'], ['short', 'Малый'], ['standard', 'Стандартный'], ['large', 'Значительный']], 'none') : null}
    {count('sites', 'Технические площадки', 50)}{flag('requiresNode', 'Требуется посещение узла')}
  </div>{error ? <p role='alert' className='cx-error'>{error}</p> : preview ? <DurationBreakdown snapshot={preview} compact/> : <p>Считаем длительность…</p>}<details><summary>Изменить время вручную</summary><label>Длительность визита, мин<input type='number' min='1' max='10080' value={form.durationOverride?.minutes ?? ''} onChange={event => onChange('durationOverride', event.target.value ? { minutes: Number(event.target.value), reason: form.durationOverride?.reason || '' } : undefined)}/></label><label>Причина изменения<input value={form.durationOverride?.reason || ''} onChange={event => onChange('durationOverride', { minutes: form.durationOverride?.minutes || Number(form.duration), reason: event.target.value })}/></label></details></section>;
}

/** Display individual service objects without moving the map when opening a passport. */
export function ComplexityMapLayer({ map, enabled, date, territory = '', territoryControl, regionId = 'moscow', routeOrderIds = [] }) {
  const [kind, setKind] = useState('all');
  const [volume, setVolume] = useState('order');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [objects, setObjects] = useState([]);
  const [visibleIds, setVisibleIds] = useState(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!map) return;
    const focus = event => {
      const coords = event.detail?.coords;
      if (Array.isArray(coords) && coords.length === 2 && coords.every(Number.isFinite)) map.easeTo({ center: [coords[1], coords[0]], zoom: Math.max(map.getZoom(), 14), duration: 500 });
    };
    window.addEventListener('beego:focus-object', focus);
    return () => window.removeEventListener('beego:focus-object', focus);
  }, [map]);
  useEffect(() => { const refresh = () => setVersion(value => value + 1); window.addEventListener('beego:complexity-changed', refresh); return () => window.removeEventListener('beego:complexity-changed', refresh); }, []);
  const zone = territory.split(':').slice(1).join(':') || territory;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    setObjects([]);
    const load = async () => { try { const result = await requestJson(`/api/complexity/objects?kind=${kind}&volume=${volume}&at=${encodeURIComponent(asOf(date))}&regionId=${encodeURIComponent(regionId)}&zone=${encodeURIComponent(zone)}&q=${encodeURIComponent(query)}`); if (live) { setObjects(result); setError(''); } } catch (issue) { if (live) setError(issue.message); } finally { if (live) setLoading(false); } };
    const timer = setTimeout(load, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, kind, volume, day(date), zone, regionId, query, version]);
  const routeIds = new Set(routeOrderIds.map(String));
  const filtered = objects.filter(object => filter === 'review' ? object.state === 'review' : filter === 'route' ? object.orderIds.some(id => routeIds.has(String(id))) : filter === 'repeat' ? object.observations >= 3 && ['faster', 'slower'].includes(objectTimeCategory(object)) : true);
  const visible = query.trim() ? filtered : filtered.filter(object => !visibleIds || visibleIds.has(object.id));
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const timer = setTimeout(async () => {
      for (const object of visible.slice(0, 6)) {
        if (!live) break;
        try { await loadObjectPassport(object.id, asOf(date), object.kind, volume); } catch { continue; }
      }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, visible.slice(0, 6).map(object => object.id).join(','), kind, volume, day(date), version]);
  const data = useMemo(() => ({ type: 'FeatureCollection', features: filtered.filter(object => Array.isArray(object.coords)).map(object => ({ type: 'Feature', id: object.id, properties: { id: object.id, label: `${object.total} мин` }, geometry: { type: 'Point', coordinates: [object.coords[1], object.coords[0]] } })) }), [JSON.stringify(filtered)]);
  useEffect(() => {
    if (!map) return;
    const container = map.getContainer();
    container.classList.toggle('cx-map-active', enabled);
    const render = () => {
      if (!map.isStyleLoaded()) return;
      if (!map.getSource('cx-objects')) {
        map.addSource('cx-objects', { type: 'geojson', data });
        map.addLayer({ id: 'cx-points', type: 'circle', source: 'cx-objects', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 16, 9], 'circle-color': '#FFD21F', 'circle-stroke-color': '#343a40', 'circle-stroke-width': 1.5 } });
        map.addLayer({ id: 'cx-point-label', type: 'symbol', source: 'cx-objects', minzoom: 10, layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.6], 'text-font': ['Noto Sans Regular'], 'text-allow-overlap': false }, paint: { 'text-color': '#18242b', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
      }
      map.getSource('cx-objects')?.setData(data);
      for (const id of ['cx-points', 'cx-point-label']) map.setLayoutProperty(id, 'visibility', enabled ? 'visible' : 'none');
    };
    render(); map.on('style.load', render);
    return () => { map.off('style.load', render); container.classList.remove('cx-map-active'); };
  }, [map, enabled, data]);
  useEffect(() => {
    if (!map || !enabled) return;
    const bounds = () => { const box = map.getBounds(); setVisibleIds(new Set(objects.filter(object => object.coords && box.contains([object.coords[1], object.coords[0]])).map(object => object.id))); };
    const hover = event => {
      map.getCanvas().style.cursor = 'pointer';
      const object = objects.find(item => item.id === event.features?.[0]?.properties.id);
      if (object) loadObjectPassport(object.id, asOf(date), object.kind, volume).catch(() => {});
    };
    const leave = () => { map.getCanvas().style.cursor = ''; };
    const click = event => {
      if (!map.getLayer('cx-points')) return;
      const features = map.queryRenderedFeatures(event.point, { layers: ['cx-points', 'cx-point-label'] });
      const feature = features[0];
      if (!feature) return;
      const object = objects.find(item => item.id === feature.properties.id);
      if (object) openObjectPassport(passportTarget(object, kind, volume));
    };
    bounds(); map.on('moveend', bounds); map.on('click', click); map.on('mousemove', 'cx-points', hover); map.on('mouseleave', 'cx-points', leave);
    return () => { map.off('moveend', bounds); map.off('click', click); map.off('mousemove', 'cx-points', hover); map.off('mouseleave', 'cx-points', leave); leave(); };
  }, [map, enabled, objects, kind, volume]);
  if (!enabled) return null;
  if (collapsed) return <aside className='cx-map-panel cx-map-panel-collapsed' aria-label='Время на объектах'><button type='button' aria-label='Развернуть панель времени на объектах' aria-expanded='false' onClick={() => setCollapsed(false)}><Clock3 size={19}/><span>Время на объектах</span><b>{visible.length}</b><ChevronRight size={18}/></button></aside>;
  return <aside className='cx-map-panel' aria-label='Время на объектах'>
    <header><Clock3 size={19}/><div><h3>Время на объектах</h3><small>Планируемая длительность визита</small></div><b aria-label='Объектов на карте'>{visible.length}</b><button type='button' className='cx-panel-collapse' aria-label='Свернуть панель времени на объектах' aria-expanded='true' title='Свернуть панель' onClick={() => setCollapsed(true)}><ChevronLeft size={18}/></button></header>
    {territoryControl}
    <label className='cx-filter-label'>Вид работ<BusinessSelect ariaLabel='Вид работ на карте' value={kind} onChange={setKind} options={[{ value: 'all', label: 'Все виды работ' }, ...options(KINDS)]}/></label>
    <label className='cx-search'><Search size={16}/><input type='search' aria-label='Поиск обслуживаемого объекта' placeholder='Найти адрес' value={query} onChange={event => setQuery(event.target.value)}/></label>
    <details className='cx-map-options'><summary>Дополнительные фильтры{filter !== 'all' || volume !== 'order' ? ' · включены' : ''}</summary>
    <label className='cx-filter-label'>Объём работ<BusinessSelect ariaLabel='Объём сравнения на карте' value={volume} onChange={setVolume} options={[{value:'order',label:'Как в заявках'},{value:'standard',label:'Стандартный: 1 устройство, 1 точка'}]}/></label>
    <label className='cx-filter-label'>Показать<BusinessSelect ariaLabel='Показать объекты' value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Все объекты на карте' }, { value: 'repeat', label: 'Отклонение от норматива от 10 мин' }, { value: 'review', label: 'Нужно проверить время' }, { value: 'route', label: 'Объекты выбранного маршрута' }]}/></label>
    </details>
    {error ? <p role='alert' className='cx-error'>{error}</p> : null}
    <div className='cx-object-list' aria-busy={loading}>{loading ? <p role='status'>Загружаем объекты…</p> : visible.length ? visible.map(object => <button type='button' key={object.id} onMouseEnter={() => { loadObjectPassport(object.id, asOf(date), object.kind, volume).catch(() => {}); }} onFocus={() => { loadObjectPassport(object.id, asOf(date), object.kind, volume).catch(() => {}); }} onClick={() => openObjectPassport(passportTarget(object, kind, volume))}><Building2 size={17}/><span><strong>{object.address}</strong><small>{KINDS[object.kind]}</small>{object.insufficient || object.delta !== 0 ? <small>{object.insufficient ? 'Предварительное время' : deltaLabel(object.delta)}</small> : null}</span><b>{object.total} мин</b></button>) : <p className='cx-empty'>Объектов не найдено. Измените фильтры или найдите адрес.</p>}</div>
  </aside>;
}

function VisitTiming({ visit }) {
  const minutes = value => Number.isFinite(value) ? `${value} мин` : 'Не измерено';
  return <table className='cx-visit-timing' aria-label='План и факт времени визита'>
    <thead><tr><th scope='col'>Этап визита</th><th scope='col'>План</th><th scope='col'>Факт</th></tr></thead>
    <tbody>{visitTimeRows(visit).map(row => <tr key={row.key}><th scope='row'>{row.label}</th><td>{Number.isFinite(row.plan) ? minutes(row.plan) : '—'}</td><td>{minutes(row.actual)}</td></tr>)}</tbody>
    <tfoot><tr><th scope='row'>Всего на объекте</th><td>{Number.isFinite(visit.forecast?.total) ? minutes(visit.forecast.total) : '—'}</td><td>{minutes(visit.total)}</td></tr></tfoot>
  </table>;
}

/** One passport drawer bound to stable object and infrastructure IDs. */
export function ComplexityPassport({ date, onOpen }) {
  const [target, setTarget] = useState(null);
  const [data, setData] = useState(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const [tab, setTab] = useState('overview');
  const [calculationOpen, setCalculationOpen] = useState(false);
  const [visitLimit, setVisitLimit] = useState(5);
  const [kind, setKind] = useState('local');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [scope, setScope] = useState('line');
  const [until, setUntil] = useState('');
  const [version, setVersion] = useState(0);
  const [visitId, setVisitId] = useState('');
  const [editingCondition, setEditingCondition] = useState('');
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;
  useEffect(() => { setVisitId(''); setEditingCondition(''); setReason(''); setUntil(''); }, [kind]);
  useEffect(() => { const open = event => { const next = event.detail.target; setTarget(next); setTab(event.detail.tab === 'calculation' ? 'overview' : event.detail.tab === 'audit' ? 'conditions' : event.detail.tab || 'overview'); setCalculationOpen(event.detail.tab === 'calculation'); setVisitLimit(5); setKind(next?.passportKind || next?.durationSnapshot?.kind || 'local'); setError(''); setData(next?.passportSummary || (next?.durationSnapshot ? { object: { address: next.address }, estimate: next.durationSnapshot, fromOrder: true } : null)); setDetailsLoaded(false); setVisitId(''); setEditingCondition(''); setReason(''); setUntil(''); onOpenRef.current?.(); }; window.addEventListener('beego:passport', open); return () => window.removeEventListener('beego:passport', open); }, []);
  useEffect(() => { if (!target) return; const key = event => { if (event.key === 'Escape') setTarget(null); }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [target]);
  useEffect(() => {
    if (!target) return;
    let live = true;
    const knownId = typeof target === 'string' ? target : target.objectId || target.serviceEntities?.object;
    const cached = knownId && cachedObjectPassport(knownId, asOf(date), kind, target.passportVolume || 'order');
    if (cached) { setData(cached); setDetailsLoaded(true); return; }
    setDetailsLoaded(false);
    setData(current => (current?.fromOrder || current?.estimate?.asOf === asOf(date)) && current?.estimate?.kind === kind ? current : null);
    const load = async () => {
      try {
        let id = typeof target === 'string' ? target : target.objectId || target.serviceEntities?.object;
        if (!id) { const result = await send('/api/complexity/estimate', { order: target, asOf: asOf(date) }); id = result.snapshot.entities.object; }
        if (!id) throw new Error('У заявки ещё нет связи с реестром объектов. Сохраните подтверждённый объект при импорте.');
        const result = await loadObjectPassport(id, asOf(date), kind, target.passportVolume || 'order');
        if (live) { setData(result); setDetailsLoaded(true); setError(''); }
      } catch (issue) { if (live) setError(issue.message); }
    };
    load(); return () => { live = false; };
  }, [target, kind, day(date), version]);
  const act = async action => { setBusy(true); setError(''); try { await action(); setVersion(value => value + 1); changed(); setReason(''); } catch (issue) { setError(issue.message); } finally { setBusy(false); } };
  if (!target) return null;
  const visit = data?.visits?.find(item => item.id === visitId);
  const kindVisits = (data?.visits || []).filter(item => item.kind === kind);
  const kindConditions = (data?.conditions || []).filter(condition => condition.kind === kind);
  const activeConditions = kindConditions.filter(condition => !condition.closedAt && (!condition.validUntil || Date.parse(condition.validUntil) > Date.parse(asOf(date))));
  const provisional = data?.object.insufficient ?? (!data?.object.examples?.some(example => example.id === data?.example?.id) || kindVisits.filter(item => item.eligible && !item.excluded && item.operation === data?.estimate.operation).length < 3);
  const moment = `${day(date)}T23:58:00+03:00`;
  return <aside className='cx-passport' role='dialog' aria-label='Паспорт объекта'><header><Building2 size={23}/><div><small>ОБЪЕКТ</small><h2>{data?.object.address || target.address || 'Объект'}</h2></div><button type='button' onClick={() => setTarget(null)} aria-label='Закрыть паспорт объекта'><X size={20}/></button></header><nav aria-label='Разделы паспорта'>{[['overview', 'Обзор'], ['visits', 'Визиты'], ['conditions', 'Особенности']].map(([key, label]) => <button type='button' key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav><div className='cx-passport-body'><label className='cx-filter-label'>Вид работ<BusinessSelect ariaLabel='Вид работ в паспорте' value={kind} onChange={value => { setKind(value); setData(null); setDetailsLoaded(false); }} options={options(KINDS)}/></label>{error ? <div className='cx-error' role='alert'>{error}<button type='button' className='cx-action' onClick={() => setVersion(value => value + 1)}>Повторить загрузку</button></div> : null}{data ? <>
    {tab === 'overview' ? <>
      <p className='cx-context-label'>{data.fromOrder ? 'Время в сохранённой заявке' : target.passportVolume === 'standard' ? 'Стандартный объём работ' : (detailsLoaded && !data.object.examples?.some(example => example.id === data.example?.id) ? 'Стандартный визит' : 'Объём работ по заявке')}{!data.fromOrder && provisional ? ' · предварительная оценка' : ''}</p>
      <DurationBreakdown snapshot={data.estimate} compact expanded={calculationOpen}/>
      {Array.isArray(data.object.coords) ? <button type='button' className='cx-action cx-locate' onClick={() => window.dispatchEvent(new CustomEvent('beego:focus-object', { detail: { coords: data.object.coords } }))}><MapPin size={16}/>Показать на карте<ChevronRight size={16}/></button> : null}
      <div className='cx-overview-stats'><button type='button' onClick={() => setTab('visits')}><strong>{detailsLoaded ? kindVisits.length : data.object.visitCount ?? '—'}</strong><span>Визитов этого типа</span><ChevronRight size={15}/></button><button type='button' onClick={() => setTab('conditions')}><strong>{detailsLoaded ? activeConditions.length : '—'}</strong><span>Действующих особенностей</span><ChevronRight size={15}/></button></div>
      {detailsLoaded ? <><h3>Что учесть при визите</h3>{activeConditions.length ? <ul className='cx-condition-summary'>{activeConditions.map(condition => <li key={condition.id}><b>{REASONS[condition.reason]}{data.estimate.histories.find(item => item.conditionId === condition.id)?.minutes ? ` · ${data.estimate.histories.find(item => item.conditionId === condition.id).minutes > 0 ? '+' : ''}${data.estimate.histories.find(item => item.conditionId === condition.id).minutes} мин` : ''}</b><span>{SCOPES[condition.scope]}{condition.validUntil ? ` · до ${dateLabel(condition.validUntil)}` : ''}</span></li>)}</ul> : <p className='cx-muted'>Особенности обслуживания не отмечены.</p>}{kindVisits[0] ? <button type='button' className='cx-action' onClick={() => setTab('visits')}><span>Последний визит · {dateLabel(kindVisits[0].endedAt)}<strong>План {kindVisits[0].forecast?.total ?? '—'} мин · {Number.isFinite(kindVisits[0].total) ? `факт ${kindVisits[0].total} мин` : 'время не измерено'}</strong></span><ChevronRight size={16}/></button> : null}{typeof target === 'object' && target.durationSnapshot ? <details><summary>Время в сохранённой заявке</summary><DurationBreakdown snapshot={target.durationSnapshot}/></details> : null}<details><summary>Оборудование и точки обслуживания · {data.entities.length}</summary><ul className='cx-entities'>{data.entities.map(entity => <li key={entity.id}><b>{entity.label}</b>{entity.location ? <small>{entity.location}</small> : null}</li>)}</ul></details></> : !error ? <p role='status' className='cx-muted'>Загружаем историю визитов…</p> : null}
    </> : null}
    {tab === 'visits' && detailsLoaded ? <><h3>История посещений · {kindVisits.length}</h3>{kindVisits.length ? kindVisits.slice(0, visitLimit).map(item => <article className='cx-visit' key={item.id}><header><strong>{dateLabel(item.endedAt)}</strong><span>{KINDS[item.kind]}</span></header><VisitTiming visit={item}/>{item.excluded ? <p className='cx-muted'>Исключён из расчёта времени</p> : null}<small>{REASONS[item.reason]}</small><button type='button' onClick={() => { setVisitId(item.id); setEditingCondition(''); setTab('conditions'); setScope(visitScope(item)); }}>Проверить причину отклонения</button><details><summary>Изменить учёт визита</summary><label>Причина изменения<input value={reason} onChange={event => setReason(event.target.value)}/></label><button type='button' className='cx-action' disabled={busy || !reason.trim()} onClick={() => act(() => send(`/api/complexity/visits/${encodeURIComponent(item.id)}`, { excluded: !item.excluded, reason, at: moment }, 'PATCH'))}>{item.excluded ? 'Учитывать при расчёте времени' : 'Исключить из расчёта времени'}</button></details></article>) : <p className='cx-empty'>Посещений с этим видом работ пока нет.</p>}{kindVisits.length > visitLimit ? <button type='button' className='cx-action' onClick={() => setVisitLimit(value => value + 5)}>Показать ещё {Math.min(5, kindVisits.length - visitLimit)} визитов<ChevronRight size={16}/></button> : null}</> : null}
    {tab === 'conditions' && detailsLoaded ? <>
      <h3>Особенности обслуживания</h3>
      {kindConditions.length ? kindConditions.map(condition => <article className='cx-condition' key={condition.id}><strong>{REASONS[condition.reason]} · {SCOPES[condition.scope]}</strong><p>{condition.closedAt ? 'Больше не действует' : condition.validUntil && Date.parse(condition.validUntil) <= Date.parse(asOf(date)) ? 'Срок истёк' : 'Действует'} · подтверждающих визитов: {condition.evidenceIds?.length || 0}</p><small>{data.entities.find(entity => entity.id === condition.entityId)?.label || (condition.scope === 'object' ? data.object.address : 'Операция')} · {KINDS[condition.kind]}{condition.validUntil ? ` · до ${dateLabel(condition.validUntil)}` : ''}</small>{!condition.closedAt ? <><button type='button' onClick={() => { setVisitId(condition.evidenceIds?.[0] || ''); setScope(condition.scope); setEditingCondition(condition.id); setUntil(condition.validUntil ? new Date(Date.parse(condition.validUntil) + 3 * 60 * 60 * 1000).toISOString().slice(0, 16) : ''); setReason(''); }}>Изменить особенность</button><label>Причина изменения<input value={reason} onChange={event => setReason(event.target.value)}/></label><button type='button' disabled={busy || !reason.trim()} onClick={() => act(() => send(`/api/complexity/conditions/${encodeURIComponent(condition.id)}`, { at: moment, reason }, 'PATCH'))}>Больше не актуально</button></> : null}</article>) : <p className='cx-muted'>Особенности обслуживания не отмечены.</p>}
      <details open={Boolean(visitId)}><summary>{editingCondition ? 'Изменение особенности' : 'Добавить особенность по визиту'}</summary>
        <label>Визит<BusinessSelect ariaLabel='Визит для разбора отклонения' value={visitId} onChange={value => { setVisitId(value); setEditingCondition(''); setScope(visitScope(kindVisits.find(item => item.id === value))); }} searchable options={[{ value: '', label: 'Выберите визит' }, ...kindVisits.map(item => ({ value: item.id, label: `${dateLabel(item.endedAt)} · ${REASONS[item.reason]}` }))]}/></label>
        {visit ? <><div className='cx-note'><b>Работа: план {visit.forecast?.technical ?? '—'} мин · факт {visit.actualTechnical == null ? 'не измерен' : `${visit.actualTechnical} мин`}</b><p>{REASONS[visit.reason]}</p></div><label>Где учитывать эту особенность<BusinessSelect ariaLabel='Область применения особенности' value={scope} onChange={setScope} options={options(SCOPES).filter(option => option.value === 'operation' || (visit.entities?.[option.value] && (option.value !== 'node' || visit.forecast?.factors?.requiresNode)))}/></label><label>Действует до (необязательно)<input type='datetime-local' value={until} onChange={event => setUntil(event.target.value)}/></label><label>Причина решения<input value={reason} onChange={event => setReason(event.target.value)}/></label><div className='cx-actions'>{[['confirm', 'Учитывать в следующих визитах'], ['visit', 'Только этот визит'], ['reject', 'Не учитывать']].map(([action, label]) => <button type='button' key={action} disabled={busy || !reason.trim() || (action === 'confirm' && ['unknown', 'customer', 'other'].includes(visit.reason))} title={action === 'confirm' && ['unknown', 'customer', 'other'].includes(visit.reason) ? 'Для следующих визитов нужна подтверждённая причина, связанная с объектом или работой' : undefined} onClick={() => act(() => send('/api/complexity/decisions', { visitId, action, scope, reason, at: moment, replacesConditionId: action === 'confirm' ? editingCondition || undefined : undefined, validUntil: until ? `${until}:00+03:00` : null }))}>{label}</button>)}</div></> : null}
      </details>
      <details><summary>История изменений · {data.audit.length}</summary>{data.audit.length ? data.audit.map(item => <article className='cx-audit' key={item.id}><strong>{item.reason}</strong><small>{dateLabel(item.at)}</small></article>) : <p>Изменений пока нет.</p>}</details>
    </> : null}
    {!detailsLoaded && tab !== 'overview' && !error ? <p role='status'>Загружаем историю объекта…</p> : null}
  </> : !error ? <p role='status'>Загружаем данные объекта…</p> : null}</div></aside>;
}

/** Compare forecasts only on the same independent, stage-measured visits. */
export function DurationAccuracy({ date, zone = '', regionId = 'moscow' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [objects, setObjects] = useState([]);
  useEffect(() => { let live = true; const load = async () => { try { const [result, places] = await Promise.all([requestJson(`/api/complexity/accuracy?at=${encodeURIComponent(asOf(date))}&zone=${encodeURIComponent(zone)}&regionId=${encodeURIComponent(regionId)}`), requestJson(`/api/complexity/objects?at=${encodeURIComponent(asOf(date))}&zone=${encodeURIComponent(zone)}&regionId=${encodeURIComponent(regionId)}`)]); if (live) { setData(result); setObjects(places.filter(item => ['review', 'confirmed'].includes(item.state)).slice(0, 3)); setError(''); } } catch (issue) { if (live) setError(issue.message); } }; load(); window.addEventListener('beego:complexity-changed', load); return () => { live = false; window.removeEventListener('beego:complexity-changed', load); }; }, [day(date), zone, regionId]);
  return <section className='analytics-panel cx-accuracy'>
    <div className='cx-section-heading'><Clock3 size={20}/><h3>Точность времени работы</h3></div>
    {error ? <p role='alert'>{error}</p> : data ? <>
      <div className='cx-metrics'><article><small>Средняя ошибка прогноза</small><b>{number(data.mae)} мин</b><span>По одному нормативу: {number(data.fixedMae)} мин</span></article><article><small>Проверено по истории</small><b>{data.count} визитов</b><span>Завершено всего: {data.total}</span></article><article><small>Работа заняла больше / меньше плана</small><b>{data.underestimated} / {data.overestimated}</b><span>В среднем на {number(data.underMinutes)} / {number(data.overMinutes)} мин</span></article></div>
      <div className='cx-table-wrap'><table><caption>Средняя ошибка прогноза, мин</caption><thead><tr><th>Вид работ</th><th>Визитов</th><th>С учётом объекта</th><th>По нормативу</th></tr></thead><tbody>{data.byKind.map(item => <tr key={item.kind}><td>{KINDS[item.kind]}</td><td>{item.count}</td><td>{number(item.mae)}</td><td>{number(item.fixedMae)}</td></tr>)}</tbody></table></div>
      <details><summary>Данные проверки</summary><p>Период: {data.temporalSplit ? `с ${data.temporalSplit.split('-').reverse().join('.')}` : 'вся доступная история'}. Визитов с измеренным временем работы: {data.eligible}.</p><p className='cx-muted'>{data.limitations}</p></details>
      {objects.length ? <><h4>Проверить время на объектах</h4>{objects.map(object => <button type='button' className='cx-action' key={object.id} onClick={() => openObjectPassport(object.id, 'visits')}>{object.address}<ChevronRight size={16}/></button>)}</> : null}
    </> : <p>Загружаем историю визитов…</p>}
  </section>;
}

/** Persist duration norms, factor hypotheses and conservative history policy on the server. */
export function DurationSettings() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [effective, setEffective] = useState('2026-08-17T07:00');
  useEffect(() => { let live = true; const load = async () => { try { const result = await requestJson('/api/complexity/model'); if (live) { setData(result); setDraft(result.model); } } catch (issue) { if (live) setError(issue.message); } }; load(); return () => { live = false; }; }, []);
  const save = async () => { try { const result = await send('/api/complexity/model', { ...draft, expectedVersion: data.model.version, effectiveAt: `${effective}:00+03:00`, reason }); setData(current => ({ ...current, model: result, versions: [result, ...current.versions] })); setDraft(result); setSaved(`Сохранено: ${result.version}`); setError(''); changed(); } catch (issue) { setSaved(''); setError(issue.message); } };
  return <section className='cx-settings'>
    <div className='cx-section-heading'><Clock3 size={19}/><h3>Нормативы времени</h3></div>
    {draft ? <>
      <div className='cx-norm-head'><span>Вид работ</span><span>Работа, мин</span><span>Оформление, мин</span></div>{Object.entries(KINDS).map(([kind, label]) => <div className='cx-norm-row' key={kind}><b>{label}</b>{[0, 1].map(index => <input key={index} type='number' min={index ? 0 : 1} max={index ? 120 : 600} aria-label={`${label}: ${index ? 'оформление' : 'технические минуты'}`} value={draft.norms[kind][index]} onChange={event => setDraft(current => ({ ...current, norms: { ...current.norms, [kind]: current.norms[kind].map((value, at) => at === index ? Number(event.target.value) : value) } }))}/>)}</div>)}
      <details><summary>Нормативы по подтипам работ · {data.workRules.length}</summary>{data.workRules.map(rule => <p key={`${rule.workType}-${rule.serviceType}`}>{rule.workType} · {rule.serviceType}: работа {rule.technical} мин, оформление {rule.documents} мин</p>)}</details>
      <details><summary>Поправки за объём работ, мин</summary><div className='cx-field-grid'>{Object.entries(draft.weights).map(([key, value]) => <label key={key}>{({ existingLine: 'Пригодная линия', shortCable: 'Малый объём кабеля', longCable: 'Значительный объём кабеля', device: 'Дополнительное устройство', point: 'Дополнительная точка', site: 'Площадка', knownFault: 'Известная неисправность', intermittent: 'Периодические сбои', segment: 'Сегмент диагностики', replacement: 'Замена устройства', firmware: 'Обновление устройства', searchNode: 'Поиск узла', damage: 'Элемент восстановления', readyConfig: 'Готовая конфигурация', stairs: 'Этаж подъёма' })[key]}<input type='number' value={value} onChange={event => setDraft(current => ({ ...current, weights: { ...current.weights, [key]: Number(event.target.value) } }))}/></label>)}</div></details>
      <details><summary>Учёт истории визитов</summary>{Object.entries(draft.history).map(([key, value]) => <label key={key}>{({ minimum: 'Минимум визитов для поправки', shrinkage: 'Сглаживание малой выборки', maxAgeDays: 'Актуальность истории, дней', outlierMinutes: 'Отклонение для дополнительной проверки, мин' })[key]}<input type='number' value={value} onChange={event => setDraft(current => ({ ...current, history: { ...current.history, [key]: Number(event.target.value) } }))}/></label>)}</details>
      <label>Действует с<input type='datetime-local' value={effective} onChange={event => setEffective(event.target.value)}/></label><label>Причина изменения<input value={reason} onChange={event => setReason(event.target.value)}/></label><button type='button' className='primary' disabled={!reason.trim()} onClick={save}><Check size={17}/>Сохранить нормативы</button>{saved ? <p role='status'>Нормативы сохранены</p> : null}
      <details><summary>История версий · {data.versions.length}</summary>{data.versions.map(model => <p key={model.version}>{dateLabel(model.effectiveAt)}</p>)}</details>
    </> : <p>Загружаем настройки…</p>}{error ? <p className='cx-error' role='alert'>{error}</p> : null}
  </section>;
}

/** Structured facts retain unknown stages rather than inventing technical measurements. */
export function DurationFactFields({ value, onChange, snapshot, fact }) {
  const update = (key, next) => onChange({ ...value, [key]: next });
  return <section className='cx-fact-fields'><h4>Время визита</h4>{snapshot ? <p>В плане: {snapshot.total} мин</p> : null}<p>Начало: {fact?.startedAt || 'не отмечено'}</p><BusinessSelect ariaLabel='Причина отклонения длительности' value={value.deviationReason || ''} onChange={next => update('deviationReason', next)} options={[{ value: '', label: 'Причина отклонения от плана' }, ...options(REASONS)]}/><details><summary>Время этапов и комментарий</summary>{[['accessMinutes', 'Доступ, мин'], ['documentMinutes', 'Оформление, мин'], ['customerMinutes', 'Ожидание клиента, мин']].map(([key, label]) => <label key={key}>{label}<input type='number' min='0' placeholder='Не измерено' value={value[key] ?? ''} onChange={event => update(key, event.target.value)}/></label>)}<label>Комментарий<input value={value.comment || ''} onChange={event => update('comment', event.target.value)}/></label></details>{snapshot?.entities?.object ? <button type='button' onClick={() => openObjectPassport(snapshot.entities.object, 'visits')}>История объекта</button> : null}</section>;
}

/** Compare applied duration and downstream client-window reserve before publication. */
export function DurationDraftComparison({ shift, preview }) {
  const before = new Map((shift?.orders || []).map(order => [String(order.id), order]));
  const rows = (preview?.result?.orders || []).filter(order => Number(before.get(String(order.id))?.duration) !== Number(order.duration));
  if (!rows.length) return null;
  const minutes = value => { const [h, m] = String(value || '').split(':').map(Number); return h * 60 + m; };
  const visits = (preview.result.plan?.routes || []).flatMap(route => route.assignments || []);
  return <details open className='cx-draft-comparison'><summary>Длительности и запас до окон · {rows.length}</summary>{rows.map(order => { const previous = before.get(String(order.id)); const visit = visits.find(item => String(item.orderId) === String(order.id)); return <p key={order.id}><b>{order.name || order.id}:</b> {previous ? `${previous.duration} → ${order.duration} мин` : `новая · ${order.duration} мин`}{visit ? ` · окончание ${visit.plannedFinish} · запас до конца окна ${Math.max(0, minutes(order.end) - minutes(visit.plannedStart))} мин` : ' · без назначения'} <button type='button' onClick={() => openObjectPassport(order, 'calculation')}>Расчёт длительности</button></p>; })}</details>;
}
