import { manualDurationInput, workKind } from './durationKind.js';
import { changeServiceEntity, resolveServiceEntities } from './serviceLocation.js';
import { FACT_STAGES, factLearningStatus } from './visitFactDraft.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Marker } from 'maplibre-gl';
import { useDropdownPresence } from './useDropdownPresence.js';
import { Building2, Check, ChevronRight, Clock3, MapPin, Search, X } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { cachedObjectPassport, clearObjectPassports, loadObjectPassport } from './objectPassport.js';
import { objectTimeExplanation, conditionVisitChoices, filterObjectGroup, objectTimeCategory, standardVolumeLabel, summarizeObjectGroup, visibleVisitLimit, visitTimeRows } from './objectPresentation.js';
import { mountObjectTimeClusters } from './objectTimeClusters.js';
import { durationFormula } from './durationPresentation.js';
import { fitObjectTimeLayer, hideObjectTimeLayers, objectTimeGeoJSON, syncObjectTimeLayers } from './objectTimeLayers.js';
import { focusObjectTimeMap } from './objectTimeFocus.js';
import { WorkspaceFilters } from './WorkspaceFilters.jsx';
import { DurationErrorChart, DurationImpact } from './DurationCharts.jsx';
import { EngineerFeedback } from './EngineerFeedback.jsx';
import './complexity.css';
import './durationCharts.css';

const KINDS = { connection: 'Подключение', local: 'Ремонт и диагностика', equipment: 'Работы с оборудованием', emergency: 'Аварийные работы', information: 'Информационная заявка' };
const SCOPES = { object: 'Объект', entrance: 'Подъезд', node: 'Технический узел', line: 'Линия', client: 'Клиент по лицевому счёту', operation: 'Такие же работы' };
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
export function DurationBreakdown({ snapshot, conditions = [], compact = false, expanded = false }) {
  if (!snapshot) return <p className='cx-muted'>Расчёт времени недоступен.</p>;
  const formula = durationFormula(snapshot, conditions);
  return <section className={`cx-breakdown ${compact ? 'compact' : ''}`} aria-label='Расчёт длительности'>
    <div className='cx-duration-hero'><Clock3 size={20}/><strong>{snapshot.total} <small>мин</small></strong><span>Время визита</span></div>
    <details className='cx-formula' open={expanded || undefined}><summary><span>Формула расчёта<small>{formula.expression}</small></span><ChevronRight size={18}/></summary><dl>{formula.rows.map((row, index) => <div key={row.key}><dt>{row.label}{row.detail ? <small>{row.detail}</small> : null}</dt><dd>{index ? formula.signed(row.minutes) : row.minutes} мин</dd></div>)}</dl><div className='cx-formula-total'><span>Итого к планированию</span><strong>{formula.total} мин</strong></div></details>
  </section>;
}

/** Conditional questions and a server-calculated preview shared by creation paths. */
export function DurationFields({ form, onChange, date }) {
  const [preview, setPreview] = useState(null);
  const [previewConditions, setPreviewConditions] = useState([]);
  const [error, setError] = useState('');
  const [infrastructureData, setInfrastructure] = useState(null);
  const infrastructure = form.objectId && infrastructureData?.objectId === form.objectId ? infrastructureData.entities : [];
  const input = manualDurationInput(form);
  let kind = '';
  let kindError = '';
  try { kind = workKind(input); } catch (issue) { kindError = issue.message; }
  const factors = form.durationFactors || {};
  const setFactor = (key, value) => onChange('durationFactors', { ...factors, [key]: value });
  useEffect(() => {
    let live = true;
    setPreview(null);
    const timer = setTimeout(async () => {
      try {
        const result = await send('/api/complexity/estimate', { persist: false, order: { id: form.sourceId || 'preview', ...input }, asOf: `${day(date)}T07:00:00+03:00` });
        if (live) { setPreview(result.snapshot); setPreviewConditions(result.conditions || []); onChange('duration', String(result.snapshot.total)); onChange('durationPreviewKey', JSON.stringify(input)); setError(''); }
      } catch (issue) { if (live) { setError(issue.message); setPreview(null); } }
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [JSON.stringify(input), day(date)]);
  useEffect(() => { if (!form.objectId) { setInfrastructure(null); return; } let live = true; const load = async () => { try { const result = await requestJson(`/api/complexity/objects/${encodeURIComponent(form.objectId)}?at=${encodeURIComponent(asOf(date))}`); if (live) setInfrastructure({ objectId: form.objectId, entities: result.entities }); } catch (issue) { if (live) setError(issue.message); } }; load(); return () => { live = false; }; }, [form.objectId, day(date)]);
  useEffect(() => {
    if (!form.objectId || infrastructureData?.objectId !== form.objectId) return;
    const links = resolveServiceEntities(form.objectId, infrastructure, form.serviceEntities);
    if (JSON.stringify(links) !== JSON.stringify(form.serviceEntities)) onChange('serviceEntities', links);
  }, [infrastructureData, form.objectId, JSON.stringify(form.serviceEntities)]);
  const select = (key, label, choices, fallback) => <label key={key}>{label}<BusinessSelect ariaLabel={label} value={factors[key] ?? fallback} onChange={value => setFactor(key, value)} options={choices.map(([value, text]) => ({ value, label: text }))}/></label>;
  const count = (key, label, max = 100) => <label key={key}>{label}<input type='number' min='1' max={max} value={factors[key] ?? 1} onChange={event => setFactor(key, event.target.value)}/></label>;
  const flag = (key, label) => <label className='cx-check' key={key}><input type='checkbox' checked={Boolean(factors[key])} onChange={event => setFactor(key, event.target.checked)}/>{label}</label>;
  return <section className='cx-fields wide'><div className='cx-section-heading'><Clock3 size={18}/><h3>Расчёт длительности</h3><span>Автоматически</span></div>{form.objectId && infrastructure.length ? <details className='cx-infrastructure-fields'><summary>{['entrance', 'node', 'line'].some(scope => infrastructure.some(entity => entity.kind === scope) && !form.serviceEntities?.[scope]) ? 'Уточнить связи объекта' : 'Связи объекта заполнены'}</summary><div className='cx-field-grid'>{['entrance', 'node', 'line'].filter(scope => infrastructure.some(entity => entity.kind === scope)).map(scope => <label key={scope}>{SCOPES[scope]}<BusinessSelect ariaLabel={`Связь новой заявки: ${SCOPES[scope]}`} value={form.serviceEntities?.[scope] || ''} onChange={value => onChange('serviceEntities', changeServiceEntity(form.objectId, infrastructure, form.serviceEntities, scope, value))} options={[{ value: '', label: 'Не уточнено' }, ...infrastructure.filter(entity => entity.kind === scope).map(entity => ({ value: entity.id, label: entity.label }))]}/></label>)}</div></details> : null}{kindError ? <p className='cx-error' role='alert'>{kindError}</p> : <p className='cx-duration-kind'>Расчёт: {KINDS[kind]}</p>}<div className='cx-field-grid'>
    {kind === 'connection' ? <>{select('line', 'Линия до квартиры', [['unknown', 'Не уточнено'], ['existing', 'Есть пригодная линия'], ['new', 'Новая прокладка']], 'unknown')}{count('points', 'Согласованные точки')}</> : null}
    {kind === 'local' ? <>{select('diagnosis', 'Проявление неисправности', [['unknown', 'Нужна диагностика'], ['known', 'Место неисправности известно'], ['intermittent', 'Периодические сбои']], 'unknown')}{count('segments', 'Проверяемые сегменты')}{flag('replaceDevice', 'Замена и восстановление настройки')}</> : null}
    {kind === 'equipment' ? <>{select('action', 'Состав дозаказа', [['add', 'Добавление'], ['replace', 'Замена'], ['move', 'Перенос']], 'add')}{flag('firmwareRequired', 'Подтверждено обязательное обновление устройства')}</> : null}
    {['connection', 'equipment'].includes(kind) ? count('devices', 'Количество устройств') : null}
    {kind === 'emergency' ? <>{select('damage', 'Подтверждённое повреждение', [['unknown', 'Состав ещё не установлен'], ['cable', 'Кабельная линия'], ['equipment', 'Замена оборудования'], ['multiple', 'Несколько элементов']], 'unknown')}{flag('nodeSearch', 'Узел аварии нужно локализовать')}{flag('readyConfig', 'Есть готовая пригодная конфигурация')}</> : null}
    {!(kind === 'connection' && factors.line === 'existing') ? select('cable', 'Объём прокладки или замены', [['none', 'Без кабельных работ'], ['short', 'Малый'], ['standard', 'Стандартный'], ['large', 'Значительный']], 'none') : null}
    {count('sites', 'Технические площадки', 50)}{flag('requiresNode', 'Требуется посещение узла')}
  </div>{error ? <p role='alert' className='cx-error'>{error}</p> : preview && form.durationPreviewKey === JSON.stringify(input) ? <DurationBreakdown snapshot={preview} conditions={previewConditions} compact/> : <p>Считаем длительность…</p>}<details><summary>Изменить время вручную</summary><label>Длительность визита, мин<input type='number' min='1' max='10080' value={form.durationOverride?.minutes ?? ''} onChange={event => onChange('durationOverride', event.target.value ? { minutes: Number(event.target.value), reason: form.durationOverride?.reason || '' } : undefined)}/></label><label>Причина изменения<input value={form.durationOverride?.reason || ''} onChange={event => onChange('durationOverride', { minutes: form.durationOverride?.minutes || Number(form.duration), reason: event.target.value })}/></label></details></section>;
}

/** Group objects in visit-time mode and locate a building when its address is selected. */
export function ComplexityMapLayer({ map, enabled, view = 'markers', onLayerReady, date, territory = '', territoryControl, regionId = 'moscow', routeOrderIds = [], panelOpen = true, onClosePanel }) {
  const [kind, setKind] = useState('all');
  const [volume, setVolume] = useState('order');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState('all');
  const [objects, setObjects] = useState([]);
  const [groupIds, setGroupIds] = useState(null);
  const [groupCategory, setGroupCategory] = useState('all');
  const [groupComposition, setGroupComposition] = useState('');
  const clearGroup = () => { setGroupIds(null); setGroupCategory('all'); setGroupComposition(''); };
  useEffect(clearGroup, [kind, volume, territory, regionId, day(date), query, category]);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedObject, setSelectedObject] = useState(null);
  const selectedMarker = useRef(null);
  const closePanelRef = useRef(onClosePanel); closePanelRef.current = onClosePanel;
  const panelPresence = useDropdownPresence(enabled && panelOpen, 280);
  const panelMotionClass = panelPresence.visible ? 'is-open' : enabled && panelOpen ? 'is-opening' : 'is-closing';
  const panelHost = map?.getContainer().closest('.workspace-grid');
  useEffect(() => {
    if (!map) return;
    let frame;
    const focus = event => {
      const object = event.detail;
      cancelAnimationFrame(frame);
      // Wait for the passport to mount so the house is placed beside it.
      frame = requestAnimationFrame(() => {
        if (focusObjectTimeMap(map, object?.coords, { onClosePanel: enabled ? closePanelRef.current : undefined }) && enabled) setSelectedObject(object);
      });
    };
    window.addEventListener('beego:focus-object', focus);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('beego:focus-object', focus); };
  }, [map, enabled]);
  useEffect(() => {
    if (!map || !enabled || !selectedObject) { selectedMarker.current?.remove(); selectedMarker.current = null; return; }
    if (!selectedMarker.current) {
      const element = document.createElement('div');
      element.className = 'cx-selected-object-marker';
      element.setAttribute('role', 'img');
      selectedMarker.current = new Marker({ element, anchor: 'center' });
    }
    const element = selectedMarker.current.getElement();
    element.setAttribute('aria-label', `Выбранный дом${selectedObject.address ? `: ${selectedObject.address}` : ''}`);
    selectedMarker.current.setLngLat([selectedObject.coords[1], selectedObject.coords[0]]).addTo(map);
  }, [map, enabled, selectedObject]);
  useEffect(() => () => { selectedMarker.current?.remove(); selectedMarker.current = null; }, [map]);
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
  const locatedObjects = objects.filter(object => Array.isArray(object.coords) && object.coords.length === 2 && object.coords.every(Number.isFinite));
  const filtered = locatedObjects.filter(object => filter === 'review' ? object.state === 'review' : filter === 'route' ? object.orderIds.some(id => routeIds.has(String(id))) : filter === 'repeat' ? object.observations >= 3 && ['faster', 'slower'].includes(objectTimeCategory(object)) : true);
  const availableObjects = view === 'access' ? filtered.filter(object => object.estimate?.access > 0) : filtered;
  const categorized = filterObjectGroup(availableObjects, category);
  const grouped = groupIds ? categorized.filter(object => groupIds.includes(object.id)) : categorized;
  const groupSummary = groupIds ? summarizeObjectGroup(grouped) : [];
  const selectedComposition = groupSummary.find(group => `${group.kind}/${group.operation || 'unspecified'}` === groupComposition);
  const selectedGroup = filterObjectGroup(grouped, groupCategory, groupComposition);
  const scopedObjects = groupIds ? selectedGroup : categorized;
  const accessObjects = scopedObjects.filter(object => object.estimate?.access > 0);
  const mapObjects = view === 'access' ? accessObjects : scopedObjects;
  const visible = mapObjects;
  const fitObjects = view === 'access' ? categorized.filter(object => object.estimate?.access > 0) : categorized;
  useEffect(() => {
    if (!map || !enabled) { onLayerReady?.(null); return; }
    const fit = () => { clearGroup(); fitObjectTimeLayer(map, fitObjects); };
    onLayerReady?.({ count: fitObjects.length, fit });
    return () => onLayerReady?.(null);
  }, [map, enabled, view, JSON.stringify(fitObjects), onLayerReady]);
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
  const data = useMemo(() => objectTimeGeoJSON(mapObjects), [JSON.stringify(mapObjects)]);
  useEffect(() => {
    if (!map) return;
    const container = map.getContainer();
    container.classList.toggle('cx-map-active', enabled);
    const render = () => {
      syncObjectTimeLayers(map, data, { enabled, view, dark: document.documentElement.dataset.theme === 'dark' });
    };
    render(); map.on('style.load', render);
    return () => { map.off('style.load', render); hideObjectTimeLayers(map); container.classList.remove('cx-map-active'); };
  }, [map, enabled, data, view]);
  useEffect(() => {
    if (!map || !enabled || view !== 'markers') return;
    return mountObjectTimeClusters(map, Marker, setGroupIds, () => setError('Не удалось раскрыть группу объектов. Попробуйте ещё раз.'));
  }, [map, enabled, data, view]);
  useEffect(() => {
    if (!map || !enabled) return;
    const hover = event => {
      map.getCanvas().style.cursor = 'pointer';
      const object = objects.find(item => item.id === event.features?.[0]?.properties.id);
      if (object) loadObjectPassport(object.id, asOf(date), object.kind, volume).catch(() => {});
    };
    const leave = () => { map.getCanvas().style.cursor = ''; };
    const click = async event => {
      const layers = (view !== 'markers' ? ['cx-access-points', 'cx-access-label'] : ['cx-points', 'cx-point-label']).filter(id => map.getLayer(id));
      if (!layers.length) return;
      const features = map.queryRenderedFeatures(event.point, { layers });
      const feature = features[0];
      if (!feature) return;
      const object = objects.find(item => item.id === feature.properties.id);
      if (object) openObjectPassport(passportTarget(object, kind, volume));
    };
    map.on('click', click);
    for (const layer of ['cx-points', 'cx-access-points']) { map.on('mousemove', layer, hover); map.on('mouseleave', layer, leave); }
    return () => { map.off('click', click); for (const layer of ['cx-points', 'cx-access-points']) { map.off('mousemove', layer, hover); map.off('mouseleave', layer, leave); } leave(); };
  }, [map, enabled, objects, kind, volume, view]);
  if (!panelPresence.present || !panelHost) return null;
  return createPortal(<section className={`orders-panel route-list-panel cx-time-panel workspace-panel-enter ${panelMotionClass}`} aria-label='Время на объектах'>
    <div className='panel-heading'><div><h3>Время на объектах</h3><b className='engineer-count' aria-label='Объектов на карте'>{visible.length}</b></div><div className='panel-heading-actions'><button type='button' className='panel-close' aria-label='Скрыть панель времени на объектах' data-tooltip='Скрыть панель' onClick={onClosePanel}><X/></button></div></div>
    {territoryControl}
    <div className='engineer-tools cx-object-tools'>
      <div className='engineer-load-filters' role='group' aria-label='Отобрать объекты по времени'>
        {[['all', 'Все', availableObjects.length], ['slower', 'Дольше', availableObjects.filter(object => objectTimeCategory(object) === 'slower').length], ['faster', 'Быстрее', availableObjects.filter(object => objectTimeCategory(object) === 'faster').length], ['unknown', 'Мало истории', availableObjects.filter(object => objectTimeCategory(object) === 'unknown').length]].map(([key, label, count]) => <button type='button' key={key} className={category === key ? 'selected' : ''} aria-pressed={category === key} onClick={() => setCategory(current => current === key && key !== 'all' ? 'all' : key)}>{label}<b>{count}</b></button>)}
      </div>
      <div className='panel-search-row'><label className='panel-search'><Search aria-hidden='true'/><input type='search' aria-label='Поиск обслуживаемого объекта' placeholder='Адрес объекта…' value={query} onChange={event => setQuery(event.target.value)}/>{query ? <button type='button' aria-label='Очистить поиск объектов' onClick={() => setQuery('')}><X/></button> : null}</label>
      <WorkspaceFilters title='Отобрать объекты' sections={[
        ['kind', 'Вид работ', [['', 'Все виды работ'], ...Object.entries(KINDS)]],
        ['volume', 'Объём работ', [['', 'Как в заявках'], ['standard', kind === 'all' ? 'Стандартный объём по виду работ' : `Стандартный: ${standardVolumeLabel(kind)}`]]],
        ['filter', 'Дополнительно', [['', 'Все объекты'], ['repeat', 'Отклонение от норматива от 10 мин'], ['review', 'Нужно проверить время'], ['route', 'Объекты выбранного маршрута']]],
      ]} value={{ kind: kind === 'all' ? '' : kind, volume: volume === 'order' ? '' : volume, filter: filter === 'all' ? '' : filter }} onChange={change => { const next = typeof change === 'function' ? change({ kind: kind === 'all' ? '' : kind, volume: volume === 'order' ? '' : volume, filter: filter === 'all' ? '' : filter }) : change; setKind(next.kind || 'all'); setVolume(next.volume || 'order'); setFilter(next.filter || 'all'); }}/></div>
    </div>
    <div className='cx-time-content'>
    {groupIds ? <section className='cx-group-summary' aria-label='Состав группы объектов'>
      <header><strong>Группа · {grouped.length}</strong><button type='button' aria-label='Сбросить выбранную группу' onClick={clearGroup}><X size={16}/></button></header>
      <div className='cx-group-filters' aria-label='Отобрать адреса группы'>
        {[['all', 'Все', grouped.length], ['slower', 'Увеличенное время', grouped.filter(object => objectTimeCategory(object) === 'slower').length], ['faster', 'Меньше времени', grouped.filter(object => objectTimeCategory(object) === 'faster').length], ['unknown', 'Мало сведений', grouped.filter(object => objectTimeCategory(object) === 'unknown').length]].map(([value, label, count]) => <button type='button' key={value} aria-pressed={groupCategory === value && !groupComposition} onClick={() => { setGroupCategory(value); setGroupComposition(''); }}>{label}<b>{count}</b></button>)}
      </div>
      <details><summary>{selectedComposition ? `${KINDS[selectedComposition.kind]} · ${selectedComposition.composition}` : `По видам и составу работ · ${groupSummary.length}`}</summary><div className='cx-group-compositions'>{groupSummary.map(group => {
        const key = `${group.kind}/${group.operation || 'unspecified'}`;
        return <button type='button' key={key} aria-pressed={groupComposition === key} onClick={() => { setGroupComposition(key); setGroupCategory('all'); }}><span><b>{KINDS[group.kind]}</b><small>{group.composition}</small></span><strong>{group.count}</strong></button>;
      })}</div></details>
    </section> : null}
    {error ? <p role='alert' className='cx-error'>{error}</p> : null}
    <div className='cx-object-list' aria-busy={loading}>{loading ? <p role='status'>Загружаем объекты…</p> : visible.length ? visible.map(object => <button type='button' className='cx-object-row' key={object.id} aria-current={selectedObject?.id === object.id ? 'true' : undefined} onMouseEnter={() => { loadObjectPassport(object.id, asOf(date), object.kind, volume).catch(() => {}); }} onFocus={() => { loadObjectPassport(object.id, asOf(date), object.kind, volume).catch(() => {}); }} onClick={() => { openObjectPassport(passportTarget(object, kind, volume)); window.dispatchEvent(new CustomEvent('beego:focus-object', { detail: object })); }}>
      <span className='person-avatar cx-object-avatar'><Building2 size={21}/></span>
      <span className='cx-object-copy'><strong>{object.address}</strong><span className='engineer-list-skills'><small>{KINDS[object.kind]}</small></span>{objectTimeExplanation(object.estimate) ? <span className='cx-time-explanation'>{objectTimeExplanation(object.estimate)}</span> : null}{object.insufficient ? <span className='cx-row-status'>Мало истории</span> : null}</span>
      <span className='cx-object-duration'><b>{object.total} <small>мин</small></b>{object.delta !== 0 && Number.isFinite(object.delta) ? <span className={`cx-row-delta ${object.delta > 0 ? 'is-increased' : 'is-reduced'}`} title={deltaLabel(object.delta)}>{object.delta > 0 ? '+' : '−'}{Math.abs(object.delta)} мин</span> : null}<ChevronRight size={17}/></span>
    </button>) : <p className='cx-empty'>{view === 'access' ? 'Подтверждённых задержек доступа по выбранным фильтрам нет.' : 'Объектов не найдено. Измените фильтры или найдите адрес.'}</p>}</div>
    </div>
  </section>, panelHost);
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
export function ComplexityPassport({ date, onOpen, actor = 'Диспетчер' }) {
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
  const [finding, setFinding] = useState('');
  const [preparation, setPreparation] = useState('');
  const [cause, setCause] = useState('unknown');
  const [notice, setNotice] = useState('');
  const bodyRef = useRef(null);
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;
  useEffect(() => { setVisitId(target?.visitId || ''); setEditingCondition(''); setReason(''); setUntil(''); setNotice(''); }, [kind, target]);
  useEffect(() => {
    const condition = data?.conditions?.find(item => item.id === editingCondition);
    const item = conditionVisitChoices(data?.visits || [], condition, kind).find(row => row.id === visitId);
    setFinding(condition?.finding || item?.finding || ''); setPreparation(condition?.preparation || item?.preparation || ''); setCause(item?.reason || 'unknown');
  }, [visitId, data, editingCondition, kind]);
  useEffect(() => {
    if (tab !== 'visits' || !detailsLoaded || !target?.visitId) return;
    const frame = requestAnimationFrame(() => {
      const visit = bodyRef.current?.querySelector(`[data-visit-id="${CSS.escape(target.visitId)}"]`);
      if (!visit) return;
      const body = bodyRef.current;
      const bodyBox = body.getBoundingClientRect();
      const scaleY = bodyBox.height / body.offsetHeight || 1;
      body.scrollTop += (visit.getBoundingClientRect().top - bodyBox.top) / scaleY - 12;
      visit.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [tab, detailsLoaded, target, kind]);
  useEffect(() => { const open = event => { const next = event.detail.target; setTarget(next); setTab(event.detail.tab === 'calculation' ? 'overview' : event.detail.tab === 'audit' ? 'conditions' : event.detail.tab || 'overview'); setCalculationOpen(event.detail.tab === 'calculation'); setVisitLimit(5); setKind(next?.passportKind || next?.durationSnapshot?.kind || 'local'); setError(''); setData(next?.passportSummary || (next?.durationSnapshot ? { object: { address: next.address }, estimate: next.durationSnapshot, fromOrder: true } : null)); setDetailsLoaded(false); setVisitId(next?.visitId || ''); setEditingCondition(''); setReason(''); setUntil(''); setNotice(''); onOpenRef.current?.(); }; window.addEventListener('beego:passport', open); return () => window.removeEventListener('beego:passport', open); }, []);
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
  const submitChange = (url, input, method) => send(url, { ...input, actor }, method);
  const saveDecision = async input => {
    const result = await submitChange('/api/complexity/decisions', input);
    if (input.replacesConditionId) { setEditingCondition(''); setVisitId(''); }
    return result;
  };
  const act = async action => { setBusy(true); setError(''); try { await action(); setNotice('Изменение сохранено'); setVersion(value => value + 1); changed(); setReason(''); } catch (issue) { setError(issue.message); } finally { setBusy(false); } };
  if (!target) return null;
  const currentCondition = data?.conditions?.find(item => item.id === editingCondition);
  const visitChoices = conditionVisitChoices(data?.visits || [], currentCondition, kind);
  const visit = visitChoices.find(item => item.id === visitId);
  const kindVisits = (data?.visits || []).filter(item => item.kind === kind);
  const shownVisitLimit = visibleVisitLimit(kindVisits, target?.visitId, visitLimit);
  const kindConditions = (data?.conditions || []).filter(condition => condition.relevant ?? condition.kind === kind);
  const activeConditions = kindConditions.filter(condition => Date.parse(condition.knownAt) <= Date.parse(asOf(date)) && (!condition.closedAt || Date.parse(condition.closedAt) > Date.parse(asOf(date))) && (!condition.validUntil || Date.parse(condition.validUntil) > Date.parse(asOf(date))));
  const provisional = data?.object.insufficient ?? (!data?.object.examples?.some(example => example.id === data?.example?.id) || kindVisits.filter(item => item.eligible && !item.excluded && item.operation === data?.estimate.operation).length < 3);
  const moment = new Date().toISOString();
  const location = condition => { const entity = data?.entities?.find(item => item.id === condition.entityId); return entity ? `${entity.label}${entity.location ? ' · ' + entity.location : ''}` : condition.scope === 'object' ? data?.object.address : condition.scope === 'operation' ? KINDS[condition.kind] : SCOPES[condition.scope]; };
  const stateLabel = item => item.excluded ? 'Ошибочное измерение исключено' : ({ confirmed: 'Перенос подтверждён', pending: 'Причина уточнена, ожидает решения', visit: 'Разовый случай', rejected: 'Перенос отклонён' })[item.learningDecision] || (item.eligible ? 'Измерение учтено в статистике' : 'Неполное измерение');
  return <aside className='cx-passport' role='dialog' aria-label='Паспорт объекта'><header><Building2 size={23}/><div><small>ОБЪЕКТ</small><h2>{data?.object.address || target.address || 'Объект'}</h2></div><button type='button' onClick={() => setTarget(null)} aria-label='Закрыть паспорт объекта'><X size={20}/></button></header><nav aria-label='Разделы паспорта'>{[['overview', 'Обзор'], ['visits', 'Визиты'], ['conditions', 'Особенности']].map(([key, label]) => <button type='button' key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav><div className='cx-passport-body' ref={bodyRef}><label className='cx-filter-label'>Вид работ<BusinessSelect ariaLabel='Вид работ в паспорте' value={kind} onChange={value => { setKind(value); setData(null); setDetailsLoaded(false); }} options={options(KINDS)}/></label>{error ? <div className='cx-error' role='alert'>{error}<button type='button' className='cx-action' onClick={() => setVersion(value => value + 1)}>Повторить загрузку</button></div> : null}{notice ? <p role='status' className='cx-saved'>{notice}</p> : null}{data ? <>
    {tab === 'overview' ? <>
      <p className='cx-context-label'>{data.fromOrder ? 'Время в сохранённой заявке' : target.passportVolume === 'standard' ? `Стандартный объём · ${standardVolumeLabel(kind)}` : (detailsLoaded && !data.object.examples?.some(example => example.id === data.example?.id) ? 'Стандартный визит' : 'Объём работ по заявке')}{!data.fromOrder && provisional ? ' · предварительная оценка' : ''}</p>
      <DurationBreakdown snapshot={data.estimate} conditions={data.conditions} compact expanded={calculationOpen}/>
      {detailsLoaded ? <EngineerFeedback data={data} kind={kind} onChanged={() => { setVersion(value => value + 1); changed(); }}/> : null}
      {Array.isArray(data.object.coords) ? <button type='button' className='cx-action cx-locate' onClick={() => window.dispatchEvent(new CustomEvent('beego:focus-object', { detail: data.object }))}><MapPin size={16}/>Показать на карте<ChevronRight size={16}/></button> : null}
      <div className='cx-overview-stats'><button type='button' onClick={() => setTab('visits')}><strong>{detailsLoaded ? kindVisits.length : data.object.visitCount ?? '—'}</strong><span>Визитов этого типа</span><ChevronRight size={15}/></button><button type='button' onClick={() => setTab('conditions')}><strong>{detailsLoaded ? activeConditions.length : '—'}</strong><span>Действующих особенностей</span><ChevronRight size={15}/></button></div>
      {detailsLoaded ? <><h3>Что учесть при визите</h3>{activeConditions.length ? <ul className='cx-condition-summary'>{activeConditions.map(condition => <li key={condition.id}><b>{condition.finding || REASONS[condition.reason]}{data.estimate.histories.find(item => item.conditionId === condition.id)?.minutes ? ` · ${data.estimate.histories.find(item => item.conditionId === condition.id).minutes > 0 ? '+' : ''}${data.estimate.histories.find(item => item.conditionId === condition.id).minutes} мин` : ''}</b><span>{location(condition)}{condition.validUntil ? ` · до ${dateLabel(condition.validUntil)}` : ''}</span>{condition.preparation ? <strong className='cx-preparation'>{condition.preparation}</strong> : null}<small>{condition.actor || 'Оператор'} · {dateLabel(condition.knownAt)}</small></li>)}</ul> : <p className='cx-muted'>Особенности обслуживания не отмечены.</p>}{kindVisits[0] ? <button type='button' className='cx-action' onClick={() => setTab('visits')}><span>Последний визит · {dateLabel(kindVisits[0].endedAt)}<strong>План {kindVisits[0].forecast?.total ?? '—'} мин · {Number.isFinite(kindVisits[0].total) ? `факт ${kindVisits[0].total} мин` : 'время не измерено'}</strong></span><ChevronRight size={16}/></button> : null}{typeof target === 'object' && target.durationSnapshot ? <details><summary>Время в сохранённой заявке</summary><DurationBreakdown snapshot={target.durationSnapshot}/></details> : null}<details><summary>Оборудование и точки обслуживания · {data.entities.length}</summary><ul className='cx-entities'>{data.entities.map(entity => <li key={entity.id}><b>{entity.label}</b>{entity.location ? <small>{entity.location}</small> : null}</li>)}</ul></details></> : !error ? <p role='status' className='cx-muted'>Загружаем историю визитов…</p> : null}
    </> : null}
    {tab === 'visits' && detailsLoaded ? <><h3>История посещений · {kindVisits.length}</h3>{kindVisits.length ? kindVisits.slice(0, shownVisitLimit).map(item => <article className={`cx-visit ${item.id === target?.visitId ? 'is-target' : ''}`} data-visit-id={item.id} tabIndex={item.id === target?.visitId ? -1 : undefined} aria-label={item.id === target?.visitId ? `Выбранный визит ${dateLabel(item.endedAt)}` : undefined} key={item.id}>{item.id === target?.visitId ? <span className='cx-selected-visit'>Выбранный визит</span> : null}<header><strong>{dateLabel(item.endedAt)}</strong><span>{KINDS[item.kind]}</span></header>{Date.parse(item.knownAt) > Date.parse(asOf(date)) ? <small>Уточнено {dateLabel(item.knownAt)} · {item.actor}</small> : null}<p className='cx-visit-person'>{item.engineerName || item.engineerId || 'Исполнитель не указан'} · {item.shiftId ? `Заявка №${item.orderId}` : `Архивный наряд ${item.orderId}`}</p><small>{item.workType || KINDS[item.kind]}{item.serviceType ? ` · ${item.serviceType}` : ''}</small><VisitTiming visit={item}/><p className='cx-decision-state'>{stateLabel(item)}</p><strong>{item.finding || REASONS[item.reason]}</strong>{item.comment && item.comment !== item.finding ? <p>{item.comment}</p> : null}{item.preparation ? <p>{item.preparation}</p> : null}<details><summary>Состав работ</summary>{(item.forecast?.components || []).map((component, index) => <p key={index}>{component.label} · {component.minutes} мин</p>)}</details><button type='button' onClick={() => { setVisitId(item.id); setEditingCondition(''); setTab('conditions'); setScope(visitScope(item)); }}>Проверить причину отклонения</button><details><summary>Изменить учёт визита</summary><label>Причина изменения<input value={reason} onChange={event => setReason(event.target.value)}/></label><button type='button' className='cx-action' disabled={busy || !reason.trim()} onClick={() => act(() => submitChange(`/api/complexity/visits/${encodeURIComponent(item.id)}`, { excluded: !item.excluded, reason, at: moment }, 'PATCH'))}>{item.excluded ? 'Восстановить измерение' : 'Исключить ошибочное измерение'}</button></details></article>) : <p className='cx-empty'>Посещений с этим видом работ пока нет.</p>}{kindVisits.length > shownVisitLimit ? <button type='button' className='cx-action' onClick={() => setVisitLimit(shownVisitLimit + 5)}>Показать ещё {Math.min(5, kindVisits.length - shownVisitLimit)} визитов<ChevronRight size={16}/></button> : null}</> : null}
    {tab === 'conditions' && detailsLoaded ? <>
      <h3>Особенности обслуживания</h3>
      {kindConditions.length ? kindConditions.map(condition => <article className='cx-condition' key={condition.id}><strong>{condition.finding || REASONS[condition.reason]}</strong>{condition.preparation ? <p className='cx-preparation'>{condition.preparation}</p> : null}<p>{condition.closedAt ? 'Больше не действует' : condition.validUntil && Date.parse(condition.validUntil) <= Date.parse(asOf(date)) ? 'Срок истёк' : 'Действует'} · пригодных подтверждений: {condition.evidenceCount ?? condition.evidenceIds?.length ?? 0}</p><small>{location(condition)} · {SCOPES[condition.scope]}{condition.validUntil ? ` · до ${dateLabel(condition.validUntil)}` : ''}</small><small>Подтвердил: {condition.actor || 'Оператор'} · {dateLabel(condition.knownAt)}</small><small>Основание: {condition.source || 'Разбор визитов'}</small><details><summary>Подтверждающие визиты</summary>{condition.evidence?.map(evidence => <button type='button' className='cx-action' key={evidence.id} onClick={() => openObjectPassport({ objectId: evidence.objectId, passportKind: evidence.kind, visitId: evidence.id }, 'visits')}><span>{evidence.address}<small>{dateLabel(evidence.endedAt)} · {evidence.engineerName} · {evidence.orderId}</small></span><ChevronRight size={15}/></button>)}</details>{!condition.closedAt ? <><button type='button' onClick={() => { setVisitId(condition.evidenceIds?.[0] || ''); setScope(condition.scope); setEditingCondition(condition.id); setUntil(condition.validUntil ? new Date(Date.parse(condition.validUntil) + 3 * 60 * 60 * 1000).toISOString().slice(0, 16) : ''); setReason(''); }}>Изменить особенность</button><label>Причина изменения<input value={reason} onChange={event => setReason(event.target.value)}/></label><button type='button' disabled={busy || !reason.trim()} onClick={() => act(() => submitChange(`/api/complexity/conditions/${encodeURIComponent(condition.id)}`, { at: moment, reason }, 'PATCH'))}>Больше не актуально</button></> : null}</article>) : <p className='cx-muted'>Особенности обслуживания не отмечены.</p>}
      <details open={Boolean(visitId)}><summary>{editingCondition ? 'Изменение особенности' : 'Добавить особенность по визиту'}</summary>{editingCondition ? <button type='button' className='cx-action' onClick={() => { setEditingCondition(''); setVisitId(''); setReason(''); }}>Отменить редактирование</button> : null}
        <label>Визит<BusinessSelect ariaLabel='Визит для разбора отклонения' value={visitId} onChange={value => { setVisitId(value); if (!editingCondition) setScope(visitScope(visitChoices.find(item => item.id === value))); }} searchable options={[{ value: '', label: 'Выберите визит' }, ...visitChoices.map(item => ({ value: item.id, label: `${dateLabel(item.endedAt)} · ${REASONS[item.reason]} · ${item.address || data.object.address}` }))]}/></label>
        {visit ? <><div className='cx-note'><b>Работа: план {visit.forecast?.technical ?? '—'} мин · факт {visit.actualTechnical == null ? 'не измерен' : `${visit.actualTechnical} мин`}</b><p>{REASONS[visit.reason]}</p></div>{!editingCondition ? <details open={visit.reason === 'unknown' || undefined}><summary>Уточнить установленную причину</summary><label>Причина<BusinessSelect ariaLabel='Установленная причина визита' value={cause} onChange={setCause} options={options(REASONS)}/></label><label>Что обнаружено<input value={finding} onChange={event => setFinding(event.target.value)}/></label><label>Что подготовить к визиту<input value={preparation} onChange={event => setPreparation(event.target.value)}/></label><label>Откуда получены сведения<input value={reason} onChange={event => setReason(event.target.value)}/></label><button type='button' className='cx-action' disabled={busy || !reason.trim() || !finding.trim()} onClick={() => act(() => submitChange(`/api/complexity/visits/${encodeURIComponent(visit.id)}`, { deviationReason: cause, finding, preparation, reason, at: moment }, 'PATCH'))}>Сохранить уточнение причины</button></details> : <div className='cx-condition-edit-fields'><label>Что учитывать<textarea rows={3} value={finding} onChange={event => setFinding(event.target.value)}/></label><label>Подготовка к визиту<textarea rows={3} value={preparation} onChange={event => setPreparation(event.target.value)}/></label></div>}<p className='cx-decision-state'>{stateLabel(visit)}</p><label>Где учитывать эту особенность<BusinessSelect ariaLabel='Область применения особенности' value={scope} onChange={setScope} options={options(SCOPES).filter(option => option.value === 'operation' || (visit.entities?.[option.value] && (option.value !== 'node' || visit.forecast?.factors?.requiresNode)))}/></label><label>Действует до (необязательно)<input type='datetime-local' value={until} onChange={event => setUntil(event.target.value)}/></label><label>Причина решения<input value={reason} onChange={event => setReason(event.target.value)}/></label><div className='cx-actions'>{(editingCondition ? [['confirm', 'Сохранить особенность']] : [['confirm', 'Подтвердить перенос'], ['visit', 'Разовый случай'], ['reject', 'Отклонить перенос']]).map(([action, label]) => <button type='button' key={action} disabled={busy || !reason.trim() || (editingCondition && !finding.trim()) || (action === 'confirm' && ['unknown', 'customer', 'other'].includes(visit.reason))} title={action === 'confirm' && ['unknown', 'customer', 'other'].includes(visit.reason) ? 'Для следующих визитов нужна подтверждённая причина, связанная с объектом или работой' : undefined} onClick={() => act(() => saveDecision({ visitId, action, scope, reason, finding, preparation, at: moment, replacesConditionId: action === 'confirm' ? editingCondition || undefined : undefined, validUntil: until ? `${until}:00+03:00` : null }))}>{label}</button>)}</div></> : null}
      </details>
      <details><summary>История изменений · {data.audit.length}</summary>{data.audit.length ? data.audit.map(item => <article className='cx-audit' key={item.id}><strong>{item.reason}</strong><small>{item.actor || 'Оператор'} · {dateLabel(item.at)}</small>{item.before || item.after ? <details><summary>Что изменилось</summary>{[['До', item.before?.visit || item.before], ['После', item.after?.visit || item.after]].map(([label, value]) => <p key={label}><b>{label}:</b> {value ? [value.finding || REASONS[value.reason], value.learningDecision && ({ confirmed: 'перенос подтверждён', pending: 'ожидает решения', visit: 'разовый случай', rejected: 'перенос отклонён' })[value.learningDecision], value.excluded ? 'измерение исключено' : value.eligible ? 'измерение пригодно' : '', Number.isFinite(value.actualTechnical) ? `${value.actualTechnical} мин работы` : '', value.closedAt ? 'закрыто' : ''].filter(Boolean).join(' · ') || 'Изменение параметров' : 'Новая запись'}</p>)}</details> : null}</article>) : <p>Изменений пока нет.</p>}</details>
    </> : null}
    {!detailsLoaded && tab !== 'overview' && !error ? <p role='status'>Загружаем историю объекта…</p> : null}
  </> : !error ? <p role='status'>Загружаем данные объекта…</p> : null}</div></aside>;
}

/** Load ranked unresolved evidence for the orders of the selected shift. */
export function useDurationAttention(date, orders) {
  const [signals, setSignals] = useState([]);
  const ids = orders.map(order => String(order.id)).sort().join(',');
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const places = await requestJson(`/api/complexity/objects?review=current&kind=all&at=${encodeURIComponent(asOf(date))}`);
        const today = new Set(ids.split(','));
        const ranked = places.filter(object => object.attention?.currentOrders > 0 && object.orderIds.some(id => today.has(String(id)))).sort((a, b) => b.attention.score - a.attention.score);
        if (live) setSignals(ranked.slice(0, 3));
      } catch { if (live) setSignals([]); }
    };
    load(); window.addEventListener('beego:complexity-changed', load);
    return () => { live = false; window.removeEventListener('beego:complexity-changed', load); };
  }, [day(date), ids]);
  return signals;
}

/** Compare forecasts only on the same independent, stage-measured visits. */
export function DurationAccuracy({ date, zone = '', regionId = 'moscow' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [objects, setObjects] = useState([]);
  useEffect(() => { let live = true; const load = async () => { try { const [result, places] = await Promise.all([requestJson(`/api/complexity/accuracy?review=current&at=${encodeURIComponent(asOf(date))}&zone=${encodeURIComponent(zone)}&regionId=${encodeURIComponent(regionId)}`), requestJson(`/api/complexity/objects?review=current&at=${encodeURIComponent(asOf(date))}&zone=${encodeURIComponent(zone)}&regionId=${encodeURIComponent(regionId)}`)]); if (live) { setData(result); setObjects(places.filter(item => item.attention).sort((a, b) => b.attention.score - a.attention.score).slice(0, 3)); setError(''); } } catch (issue) { if (live) setError(issue.message); } }; load(); window.addEventListener('beego:complexity-changed', load); return () => { live = false; window.removeEventListener('beego:complexity-changed', load); }; }, [day(date), zone, regionId]);
  return <section className='analytics-panel cx-accuracy'>
    <div className='cx-section-heading'><Clock3 size={24}/><h3>Точность времени работы</h3></div>
    {error ? <p role='alert'>{error}</p> : data ? <>
      {data.impactWeek ? <DurationImpact impact={data.impactWeek}/> : null}
      <div className='cx-metrics'><article><small>Средняя ошибка прогноза</small><b>{number(data.mae)} мин</b><span>По одному нормативу: {number(data.fixedMae)} мин</span></article><article><small>Проверено визитов по истории</small><b>{data.count}</b><span>Завершено всего: {data.total}</span></article><article><small>Отклонения по истории</small><div className='cx-direction-stat'><b>Дольше прогноза: {data.underestimated}</b><span>{data.underestimated ? `В среднем +${number(data.underMinutes)} мин` : 'Превышений нет'}</span></div><div className='cx-direction-stat'><b>Быстрее прогноза: {data.overestimated}</b><span>{data.overestimated ? `В среднем −${number(data.overMinutes)} мин` : 'Сокращений нет'}</span></div></article></div>
      <DurationErrorChart data={data} kinds={KINDS}/>
      <details><summary>Данные проверки</summary><p>Период: {data.temporalSplit ? `с ${data.temporalSplit.split('-').reverse().join('.')}` : 'вся доступная история'}. Визитов с измеренным временем работы: {data.eligible}.</p><p className='cx-muted'>{data.limitations}</p></details>
      {objects.length ? <><h4>Проверить время на объектах</h4>{objects.map(object => <button type='button' className='cx-action' key={object.id} onClick={() => openObjectPassport({ objectId: object.id, passportKind: object.attention.kind, visitId: object.attention.visitId }, 'conditions')}><span>{object.address}<small>{object.attention.why}</small><strong>{object.attention.action}</strong></span><ChevronRight size={16}/></button>)}</> : null}
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
      <details><summary>Поправки за объём работ, мин</summary><div className='cx-field-grid'>{Object.entries(draft.weights).filter(([key]) => key !== 'shortCable').map(([key, value]) => <label key={key}>{({ existingLine: 'Пригодная линия', shortCable: 'Малый объём кабеля', longCable: 'Значительный объём кабеля', device: 'Дополнительное устройство', point: 'Дополнительная точка', site: 'Площадка', knownFault: 'Известная неисправность', intermittent: 'Периодические сбои', segment: 'Сегмент диагностики', replacement: 'Замена устройства', firmware: 'Обновление устройства', searchNode: 'Поиск узла', damage: 'Элемент восстановления', readyConfig: 'Готовая конфигурация', stairs: 'Этаж подъёма' })[key]}<input type='number' value={value} onChange={event => setDraft(current => ({ ...current, weights: { ...current.weights, [key]: Number(event.target.value) } }))}/></label>)}</div></details>
      <details><summary>Учёт истории визитов</summary>{Object.entries(draft.history).map(([key, value]) => <label key={key}>{({ minimum: 'Минимум визитов для поправки', shrinkage: 'Сглаживание малой выборки', maxAgeDays: 'Актуальность истории, дней', outlierMinutes: 'Отклонение для дополнительной проверки, мин' })[key]}<input type='number' value={value} onChange={event => setDraft(current => ({ ...current, history: { ...current.history, [key]: Number(event.target.value) } }))}/></label>)}</details>
      <label>Действует с<input type='datetime-local' value={effective} onChange={event => setEffective(event.target.value)}/></label><label>Причина изменения<input value={reason} onChange={event => setReason(event.target.value)}/></label><button type='button' className='primary' disabled={!reason.trim()} onClick={save}><Check size={17}/>Сохранить нормативы</button>{saved ? <p role='status'>Нормативы сохранены</p> : null}
      <details><summary>История версий · {data.versions.length}</summary>{data.versions.map(model => <p key={model.version}>{dateLabel(model.effectiveAt)}</p>)}</details>
    </> : <p>Загружаем настройки…</p>}{error ? <p className='cx-error' role='alert'>{error}</p> : null}
  </section>;
}

/** Structured facts retain unknown stages rather than inventing technical measurements. */
export function DurationFactFields({ value, onChange, snapshot, fact, order }) {
  const [client, setClient] = useState(null);
  useEffect(() => {
    let live = true;
    setClient(null);
    const load = async () => { if (!snapshot?.entities?.object) return; try { const place = await loadObjectPassport(snapshot.entities.object, snapshot.asOf, snapshot.kind); if (live) setClient(place.clientLinks?.find(item => item.lineId === snapshot.entities.line) || null); } catch { /* The measured fact remains editable while registry metadata is unavailable. */ } };
    load();
    return () => { live = false; };
  }, [snapshot?.entities?.object, snapshot?.entities?.line, snapshot?.asOf, snapshot?.kind]);
  const update = (key, next) => onChange({ ...value, [key]: next });
  const learning = factLearningStatus(fact, snapshot);
  return <section className='cx-fact-fields'><h4>Время визита</h4>{snapshot ? <p>В плане: {snapshot.total} мин</p> : null}<p>Начало: {fact?.startedAt || 'не отмечено'}</p>
    {fact?.status === 'completed' ? <div className={`cx-learning-status ${learning.eligible ? 'ready' : ''}`} role='status'><strong>Выполнение сохранено</strong><span>{learning.eligible ? 'Измерение пригодно для уточнения времени' : learning.missing.length ? `Для обучения не хватает: ${learning.missing.join(', ')}` : 'Измерение исключено из обучения'}</span></div> : null}
    <BusinessSelect ariaLabel='Причина отклонения длительности' value={value.deviationReason || ''} onChange={next => update('deviationReason', next)} options={[{ value: '', label: 'Причина отклонения от плана' }, ...options(REASONS)]}/>
    <details><summary>Время этапов и комментарий</summary>{FACT_STAGES.map(([key, label]) => <div className='cx-stage-measurement' key={key}><label>{label}, мин<input type='number' min='0' max='1440' placeholder='Не измерено' value={value[key] ?? ''} onChange={event => update(key, event.target.value)}/></label><button type='button' className='cx-stage-choice' aria-label={`${label}: ${value[key] === '' || value[key] == null ? 'не было — 0 минут' : 'не измерено'}`} onClick={() => update(key, value[key] === '' || value[key] == null ? '0' : '')}>{value[key] === '' || value[key] == null ? 'Не было · 0 мин' : 'Не измерено'}</button></div>)}</details>
    <div className='cx-engineer-reply-fields'><h4>Обратная связь инженера</h4><label>Почему получилось быстрее или дольше<textarea aria-label='Пояснение отклонения факта' rows={3} placeholder='Что произошло и повторится ли это в следующий раз' value={value.comment || ''} onChange={event => update('comment', event.target.value)}/></label><label>Повторяемость<BusinessSelect ariaLabel='Повторяемость причины факта' value={value.feedbackRepeatability || 'unsure'} onChange={next => update('feedbackRepeatability', next)} options={[{ value: 'unsure', label: 'Пока не знаю' }, { value: 'once', label: 'Только этот визит' }, { value: 'repeat', label: 'Повторяется' }]}/></label><label>Где повторяется<BusinessSelect ariaLabel='Область причины факта' value={value.feedbackScope || 'object'} onChange={next => update('feedbackScope', next)} options={[{ value: 'object', label: 'В этом доме' }, ...(client || snapshot?.entities?.client ? [{ value: 'client', label: client ? `У этого клиента · ${client.label}` : 'У этого клиента' }] : []), ...(snapshot?.entities?.line ? [{ value: 'line', label: 'На этой линии' }] : []), ...(snapshot?.entities?.node && snapshot?.factors?.requiresNode ? [{ value: 'node', label: 'На этом узле' }] : [])]}/></label><label>Конкретная особенность<input placeholder='Например, доступ к узлу только через ответственного УК' value={value.feedbackFinding || ''} onChange={event => update('feedbackFinding', event.target.value)}/></label></div>
    {snapshot?.entities?.object ? <button type='button' className='cx-action' onClick={() => openObjectPassport({ ...order, objectId: snapshot.entities.object, durationSnapshot: snapshot, passportKind: snapshot.kind }, 'visits')}>История объекта<ChevronRight size={15}/></button> : null}
  </section>;
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
