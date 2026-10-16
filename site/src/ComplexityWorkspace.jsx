import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Check, ChevronRight, Clock3, Layers3, Search, X } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import './complexity.css';

const KINDS = { connection: 'Подключение', local: 'Локальная заявка', equipment: 'Дозаказ', emergency: 'Аварийные работы', information: 'Информация' };
const SCOPES = { object: 'Объект', entrance: 'Подъезд', node: 'Технический узел', line: 'Линия', operation: 'Сопоставимая операция' };
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
const changed = () => window.dispatchEvent(new Event('beego:complexity-changed'));

/** Open the same object passport from orders, routes, map or analytics. */
export function openObjectPassport(orderOrObject, tab = 'overview') {
  window.dispatchEvent(new CustomEvent('beego:passport', { detail: { target: orderOrObject, tab } }));
}

/** Render the immutable forecast attached to the published order. */
export function DurationBreakdown({ snapshot, compact = false }) {
  if (!snapshot) return <p className='cx-muted'>Сохранённый норматив прежней версии. Новый расчёт появится в проверенном черновике.</p>;
  return <section className={`cx-breakdown ${compact ? 'compact' : ''}`} aria-label='Расчёт длительности'>
    <div className='cx-duration-hero'><Clock3 size={20}/><strong>{snapshot.total} <small>мин</small></strong><span>K {number(snapshot.coefficient)}<small>техническая работа / база</small></span></div>
    <dl>{snapshot.components.map((component, index) => <div key={`${component.key}-${index}`}><dt>{component.label}</dt><dd>{component.minutes > 0 && index ? '+' : ''}{component.minutes} мин</dd></div>)}<div><dt>История технической работы</dt><dd>{snapshot.historyMinutes > 0 ? '+' : ''}{snapshot.historyMinutes} мин</dd></div><div><dt>Техническая работа, итог</dt><dd>{snapshot.technical} мин</dd></div><div><dt>Доступ сверх обычной подготовки</dt><dd>{snapshot.access} мин</dd></div><div><dt>Оформление</dt><dd>{snapshot.documents} мин</dd></div></dl>
    {snapshot.override ? <p className='cx-note'>Ручная корректировка: {snapshot.override.minutes} мин. {snapshot.override.reason}. Автоматический расчёт: {snapshot.calculatedTotal} мин.</p> : null}
    <p className='cx-muted'>Дорога рассчитывается маршрутизатором отдельно. В базе — обычная подготовка и одна стандартная операция.</p>
    <details><summary>Основания и актуальность</summary><p>{snapshot.uncertainty}</p><p>{snapshot.observationCount} пригодных наблюдений в применённых поправках.</p>{snapshot.histories.map(item => <p key={item.conditionId}>{SCOPES[item.scope]} · {REASONS[item.reason]} · {item.count} визитов · {item.minutes > 0 ? '+' : ''}{item.minutes} мин · последнее {dateLabel(item.latestAt)}</p>)}{snapshot.components.slice(1).map(component => <p key={component.key}>{component.label}: {component.source}</p>)}<p>Модель {snapshot.modelVersion} · норматив {snapshot.normVersion} · расчёт {dateLabel(snapshot.asOf)}</p><p>Веса — калибруемая гипотеза команды. При нехватке сведений используется исходный сценарий.</p></details>
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
  </div><p className='cx-muted'>Оператор уточняет состав по заказу и инвентарю. Клиент сообщает только известные ему условия.</p>{error ? <p role='alert' className='cx-error'>{error}</p> : preview ? <DurationBreakdown snapshot={preview} compact/> : <p>Считаем длительность…</p>}<details><summary>Ручная корректировка с причиной</summary><label>Минуты вручную<input type='number' min='1' max='10080' value={form.durationOverride?.minutes ?? ''} onChange={event => onChange('durationOverride', event.target.value ? { minutes: Number(event.target.value), reason: form.durationOverride?.reason || '' } : undefined)}/></label><label>Причина корректировки<input value={form.durationOverride?.reason || ''} onChange={event => onChange('durationOverride', { minutes: form.durationOverride?.minutes || Number(form.duration), reason: event.target.value })}/></label></details></section>;
}

/** Keep object modes on the existing MapLibre instance, including city clustering. */
export function ComplexityMapLayer({ map, enabled, date, territory = '', territoryControl, regionId = 'moscow', routeOrderIds = [] }) {
  const [kind, setKind] = useState('local');
  const [volume, setVolume] = useState('order');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [objects, setObjects] = useState([]);
  const [visibleIds, setVisibleIds] = useState(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => { const refresh = () => setVersion(value => value + 1); window.addEventListener('beego:complexity-changed', refresh); return () => window.removeEventListener('beego:complexity-changed', refresh); }, []);
  const zone = territory.split(':').slice(1).join(':') || territory;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = async () => { try { const result = await requestJson(`/api/complexity/objects?kind=${kind}&volume=${volume}&at=${encodeURIComponent(asOf(date))}&regionId=${encodeURIComponent(regionId)}&zone=${encodeURIComponent(zone)}&q=${encodeURIComponent(query)}`); if (live) { setObjects(result); setError(''); } } catch (issue) { if (live) setError(issue.message); } };
    const timer = setTimeout(load, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, kind, volume, day(date), zone, regionId, query, version]);
  const routeIds = new Set(routeOrderIds.map(String));
  const filtered = objects.filter(object => filter === 'review' ? object.state === 'review' : filter === 'route' ? object.orderIds.some(id => routeIds.has(String(id))) : filter === 'repeat' ? object.observations >= 3 && Math.abs(object.coefficient - 1) >= 0.15 : true);
  const data = useMemo(() => ({ type: 'FeatureCollection', features: filtered.filter(object => Array.isArray(object.coords)).map(object => ({ type: 'Feature', id: object.id, properties: { id: object.id, coefficient: object.coefficient, color: object.insufficient ? '#92999f' : object.delta < -5 ? '#35a98c' : object.delta > 8 ? '#d87945' : '#e7c438', label: object.insufficient ? '?' : `${number(object.coefficient)}`, confirmed: object.state === 'confirmed' }, geometry: { type: 'Point', coordinates: [object.coords[1], object.coords[0]] } })) }), [JSON.stringify(filtered)]);
  useEffect(() => {
    if (!map) return;
    const container = map.getContainer();
    container.classList.toggle('cx-map-active', enabled);
    const render = () => {
      if (!map.isStyleLoaded()) return;
      if (!map.getSource('cx-objects')) {
        map.addSource('cx-objects', { type: 'geojson', data, cluster: true, clusterMaxZoom: 12, clusterRadius: 34 });
        map.addLayer({ id: 'cx-clusters', type: 'circle', source: 'cx-objects', filter: ['has', 'point_count'], paint: { 'circle-color': '#424b50', 'circle-radius': ['step', ['get', 'point_count'], 17, 20, 23, 60, 29], 'circle-stroke-color': '#FFD21F', 'circle-stroke-width': 2 } });
        map.addLayer({ id: 'cx-cluster-label', type: 'symbol', source: 'cx-objects', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#ffffff' } });
        map.addLayer({ id: 'cx-points', type: 'circle', source: 'cx-objects', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 16, 13], 'circle-color': ['get', 'color'], 'circle-stroke-color': ['case', ['get', 'confirmed'], '#202c32', '#ffffff'], 'circle-stroke-width': 2 } });
        map.addLayer({ id: 'cx-point-label', type: 'symbol', source: 'cx-objects', filter: ['!', ['has', 'point_count']], minzoom: 13, layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-font': ['Noto Sans Regular'], 'text-allow-overlap': true }, paint: { 'text-color': '#18242b' } });
      }
      map.getSource('cx-objects')?.setData(data);
      for (const id of ['cx-clusters', 'cx-cluster-label', 'cx-points', 'cx-point-label']) map.setLayoutProperty(id, 'visibility', enabled ? 'visible' : 'none');
    };
    render(); map.on('style.load', render);
    return () => { map.off('style.load', render); };
  }, [map, enabled, data]);
  useEffect(() => {
    if (!map || !enabled) return;
    const bounds = () => { const box = map.getBounds(); setVisibleIds(new Set(objects.filter(object => object.coords && box.contains([object.coords[1], object.coords[0]])).map(object => object.id))); };
    const click = async event => {
      if (!map.getLayer('cx-points')) return;
      const features = map.queryRenderedFeatures(event.point, { layers: ['cx-points', 'cx-clusters'] });
      const feature = features[0];
      if (!feature) return;
      if (feature.properties.cluster) { const zoom = await map.getSource('cx-objects').getClusterExpansionZoom(feature.properties.cluster_id); map.easeTo({ center: feature.geometry.coordinates, zoom }); }
      else openObjectPassport(feature.properties.id);
    };
    bounds(); map.on('moveend', bounds); map.on('click', click);
    return () => { map.off('moveend', bounds); map.off('click', click); };
  }, [map, enabled, objects]);
  if (!enabled) return null;
  const visible = query.trim() ? filtered : filtered.filter(object => !visibleIds || visibleIds.has(object.id));
  return <aside className='cx-map-panel' aria-label='Сложность объектов'><header><Layers3 size={19}/><div><h3>Сложность объектов</h3><small>Для выбранного вида и объёма работ</small></div><b>{visible.length}</b></header>{territoryControl}<BusinessSelect ariaLabel='Объём сравнения на карте' value={volume} onChange={setVolume} options={[{value:'order',label:'Известный состав работ'},{value:'standard',label:'1 устройство · 1 точка · 1 площадка'}]}/><BusinessSelect ariaLabel='Вид работ на карте сложности' value={kind} onChange={setKind} options={options(KINDS)}/><label className='cx-search'><Search size={16}/><input type='search' aria-label='Поиск обслуживаемого объекта' placeholder='Адрес из реестра, в том числе без заявки…' value={query} onChange={event => setQuery(event.target.value)}/></label><BusinessSelect ariaLabel='Фильтр объектов сложности' value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Объекты в области карты' }, { value: 'repeat', label: 'Повторяющиеся отклонения' }, { value: 'review', label: 'Требуют подтверждения' }, { value: 'route', label: 'Объекты выбранного маршрута' }]}/><div className='cx-legend'><span><i style={{ background: '#35a98c' }}/>−6 мин и меньше</span><span><i style={{ background: '#e7c438' }}/>−5…+8 мин · база</span><span><i style={{ background: '#d87945' }}/>+9 мин и больше</span><span><i style={{ background: '#92999f' }}/>Недостаточно сведений</span></div><p className='cx-muted'>Цвет — изменение всего визита относительно базы выбранных работ. K — только техническая работа. Тёмный контур — подтверждённая история; светлый — расчёт или проверка. Группы показывают число объектов, не среднюю сложность.</p>{error ? <p role='alert' className='cx-error'>{error}</p> : null}<div className='cx-object-list'>{visible.length ? visible.map(object => <button type='button' key={object.id} onClick={() => { if (map && Array.isArray(object.coords)) map.flyTo({ center: [object.coords[1], object.coords[0]], zoom: Math.max(map.getZoom(), 14) }); openObjectPassport(object.id); }}><Building2 size={17}/><span><strong>{object.address}</strong><small>{object.insufficient ? 'Недостаточно истории' : object.state === 'confirmed' ? 'Подтверждённая поправка' : object.state === 'review' ? 'Есть основания для разбора' : 'Расчёт по составу'} · {object.observations} визитов</small></span><b>{object.total} мин<small>K {number(object.coefficient)}</small></b></button>) : <p className='cx-empty'>Объектов по выбранным условиям нет. Измените фильтр или область карты.</p>}</div></aside>;
}

/** One passport drawer bound to stable object and infrastructure IDs. */
export function ComplexityPassport({ date, onOpen }) {
  const [target, setTarget] = useState(null);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('overview');
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
  useEffect(() => { const open = event => { setTarget(event.detail.target); setTab(event.detail.tab || 'overview'); setError(''); setData(null); onOpenRef.current?.(); }; window.addEventListener('beego:passport', open); return () => window.removeEventListener('beego:passport', open); }, []);
  useEffect(() => { if (!target) return; const key = event => { if (event.key === 'Escape') setTarget(null); }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, [target]);
  useEffect(() => {
    if (!target) return;
    let live = true;
    const load = async () => {
      try {
        let id = typeof target === 'string' ? target : target.objectId || target.serviceEntities?.object;
        if (!id) { const result = await send('/api/complexity/estimate', { order: target, asOf: asOf(date) }); id = result.snapshot.entities.object; }
        if (!id) throw new Error('У заявки ещё нет связи с реестром объектов. Сохраните подтверждённый объект при импорте.');
        const result = await requestJson(`/api/complexity/objects/${encodeURIComponent(id)}?kind=${kind}&at=${encodeURIComponent(asOf(date))}`);
        if (live) { setData(result); setError(''); }
      } catch (issue) { if (live) setError(issue.message); }
    };
    load(); return () => { live = false; };
  }, [target, kind, day(date), version]);
  const act = async action => { setBusy(true); setError(''); try { await action(); setVersion(value => value + 1); changed(); setReason(''); } catch (issue) { setError(issue.message); } finally { setBusy(false); } };
  if (!target) return null;
  const visit = data?.visits.find(item => item.id === visitId);
  const moment = `${day(date)}T23:58:00+03:00`;
  return <aside className='cx-passport' role='dialog' aria-label='Паспорт объекта'><header><Building2 size={23}/><div><small>ПАСПОРТ ОБЪЕКТА</small><h2>{data?.object.address || 'Загрузка объекта…'}</h2></div><button type='button' onClick={() => setTarget(null)} aria-label='Закрыть паспорт объекта'><X size={20}/></button></header><nav aria-label='Разделы паспорта'>{[['overview', 'Обзор'], ['calculation', 'Расчёт'], ['visits', 'Визиты'], ['conditions', 'Условия'], ['audit', 'Изменения']].map(([key, label]) => <button type='button' key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav><div className='cx-passport-body'>{error ? <p className='cx-error' role='alert'>{error}</p> : null}{data ? <>
    {tab === 'overview' ? <><div className='cx-note'><strong>{data.estimate.observationCount ? 'Есть подтверждённая сопоставимая история' : 'Расчёт по известному составу работ'}</strong><p>{data.visits.filter(item => item.eligible && !item.excluded).length} пригодных визитов · {data.entities.length} связанных сущностей</p></div><h3>Условия обслуживания</h3><p>Обычная подготовка включена в техническую базу. Дополнительный доступ учитывается отдельно при измеренном этапе и подтверждённой области.</p><ul className='cx-entities'>{data.entities.map(entity => <li key={entity.id}><b>{SCOPES[entity.kind] || 'Оборудование'} · {entity.label}</b><small>{entity.location || entity.nodeId || entity.entranceId || 'Связь с объектом подтверждена в реестре'}</small></li>)}</ul><details><summary>Источники данных</summary><p>{data.object.source}</p><p>ID объекта: {data.object.id}. Точное положение узлов не установлено; маркер показывает зарегистрированный адрес.</p></details><button type='button' className='cx-action' onClick={() => setTab('calculation')}>Открыть расчёт <ChevronRight size={16}/></button></> : null}
    {tab === 'calculation' ? <><BusinessSelect ariaLabel='Вид работ в паспорте' value={kind} onChange={setKind} options={options(KINDS)}/><h3>Следующий сопоставимый визит</h3><DurationBreakdown snapshot={data.estimate}/>{typeof target === 'object' && target.durationSnapshot ? <details><summary>Исходный прогноз выбранной заявки</summary><DurationBreakdown snapshot={target.durationSnapshot}/></details> : null}<p className='cx-muted'>Новая история меняет следующий расчёт. Опубликованная смена изменяется только через проверенный черновик.</p></> : null}
    {tab === 'visits' ? <><h3>План и пригодный факт</h3><p className='cx-muted'>Технический факт доступен, когда известны начало, конец и остальные этапы. Нет измерения — нет нулевых минут.</p>{data.visits.length ? data.visits.map(item => <article className='cx-visit' key={item.id}><header><strong>{dateLabel(item.endedAt)}</strong><span>{KINDS[item.kind]}</span></header><dl><div><dt>Исходный прогноз, тех.</dt><dd>{item.forecast?.technical ?? '—'} мин</dd></div><div><dt>Факт, тех.</dt><dd>{item.eligible && !item.excluded ? `${item.actualTechnical} мин` : 'Непригоден / не измерен'}</dd></div><div><dt>Доступ / весь визит</dt><dd>{item.accessMinutes ?? '—'} / {item.total ?? '—'} мин</dd></div></dl><small>{REASONS[item.reason]} · {item.engineerId} · {item.forecast?.modelVersion}</small><button type='button' onClick={() => { setVisitId(item.id); setTab('conditions'); setScope(item.forecast?.factors?.requiresNode ? 'node' : 'line'); }}>Разобрать отклонение</button><button type='button' disabled={busy || !reason.trim()} onClick={() => act(() => send(`/api/complexity/visits/${encodeURIComponent(item.id)}`, { excluded: !item.excluded, reason, at: moment }, 'PATCH'))}>{item.excluded ? 'Вернуть в историю' : 'Исключить с причиной'}</button></article>) : <p className='cx-empty'>Истории визитов пока нет.</p>}<label>Причина исправления пригодности<input value={reason} onChange={event => setReason(event.target.value)}/></label></> : null}
    {tab === 'conditions' ? <><h3>Подтверждения и область</h3>{data.conditions.map(condition => <article className='cx-condition' key={condition.id}><strong>{REASONS[condition.reason]} · {SCOPES[condition.scope]}</strong><p>{condition.evidenceIds?.length || 0} оснований · {condition.closedAt ? 'Закрыто' : condition.validUntil && condition.validUntil <= asOf(date) ? 'Срок истёк' : 'Действует'}</p><small>{data.entities.find(entity=>entity.id===condition.entityId)?.label || (condition.scope==='object'?data.object.address:'Сопоставимая операция')} · {KINDS[condition.kind]}{condition.validUntil ? ` · до ${dateLabel(condition.validUntil)}` : ''}</small>{!condition.closedAt ? <button type='button' onClick={() => { setVisitId(condition.evidenceIds?.[0] || ''); setScope(condition.scope); setEditingCondition(condition.id); setUntil(condition.validUntil?.slice(0,16) || ''); setReason(''); }}>Изменить область применения</button> : null}{!condition.closedAt ? <button type='button' disabled={busy || !reason.trim()} onClick={() => act(() => send(`/api/complexity/conditions/${encodeURIComponent(condition.id)}`, { at: moment, reason }, 'PATCH'))}>Больше не актуально</button> : null}</article>)}<BusinessSelect ariaLabel='Визит для разбора отклонения' value={visitId} onChange={value => { setVisitId(value); setEditingCondition(''); }} searchable options={[{ value: '', label: 'Выберите визит для разбора' }, ...data.visits.map(item => ({ value: item.id, label: `${dateLabel(item.endedAt)} · ${REASONS[item.reason]}` }))]}/>{visit ? <div className='cx-note'><b>Прогноз: {visit.forecast?.technical} мин · факт: {visit.actualTechnical ?? 'не измерен'} мин</b><p>{REASONS[visit.reason]} · источник: {visit.source === 'dispatcher' ? 'Отметка оператора' : 'Исторический визит'}</p><p>Предложение: переносить только установленную причину на сопоставимую операцию и выбранную сущность. Неизвестная причина остаётся у визита.</p></div> : null}<label>Область применения<BusinessSelect ariaLabel='Область применения особенности' value={scope} onChange={setScope} options={options(SCOPES)}/></label><label>Временная особенность, действует до<input type='datetime-local' value={until} onChange={event => setUntil(event.target.value)}/></label><label>Основание решения / закрытия<input value={reason} onChange={event => setReason(event.target.value)} placeholder='Что подтверждено и почему область применима'/></label><div className='cx-actions'>{[['confirm', 'Подтвердить'], ['visit', 'Учесть только в этом визите'], ['reject', 'Отклонить']].map(([action, label]) => <button type='button' key={action} disabled={busy || !visit || !reason.trim()} onClick={() => act(() => send('/api/complexity/decisions', { visitId, action, scope, reason, at: moment, replacesConditionId: action === 'confirm' ? editingCondition || undefined : undefined, validUntil: until ? `${until}:00+03:00` : null }))}>{label}</button>)}</div><p className='cx-muted'>Чтобы изменить область, выберите её перед подтверждением. Для переноса нужны минимум три пригодных сопоставимых этапа.</p></> : null}
    {tab === 'audit' ? <>{data.audit.length ? data.audit.map(item => <article className='cx-audit' key={item.id}><strong>{item.reason}</strong><small>{dateLabel(item.at)} · {item.actor}</small><details><summary>До и после</summary><pre>{JSON.stringify({ до: item.before, после: item.after }, null, 2)}</pre></details></article>) : <p>Изменений пока нет.</p>}</> : null}
  </> : !error ? <p>Загружаем паспорт…</p> : null}</div></aside>;
}

/** Compare forecasts only on the same independent, stage-measured visits. */
export function DurationAccuracy({ date, zone = '', regionId = 'moscow' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [objects, setObjects] = useState([]);
  useEffect(() => { let live = true; const load = async () => { try { const [result, places] = await Promise.all([requestJson(`/api/complexity/accuracy?at=${encodeURIComponent(asOf(date))}&zone=${encodeURIComponent(zone)}&regionId=${encodeURIComponent(regionId)}`), requestJson(`/api/complexity/objects?at=${encodeURIComponent(asOf(date))}&zone=${encodeURIComponent(zone)}&regionId=${encodeURIComponent(regionId)}`)]); if (live) { setData(result); setObjects(places.filter(item => ['review', 'confirmed'].includes(item.state)).slice(0, 3)); setError(''); } } catch (issue) { if (live) setError(issue.message); } }; load(); window.addEventListener('beego:complexity-changed', load); return () => { live = false; window.removeEventListener('beego:complexity-changed', load); }; }, [day(date), zone, regionId]);
  return <section className='analytics-panel cx-accuracy'><div className='cx-section-heading'><Clock3 size={20}/><h3>Точность длительности</h3></div>{error ? <p role='alert'>{error}</p> : data ? <><div className='cx-metrics'><article><small>Средняя абсолютная ошибка</small><b>{number(data.mae)} мин</b><span>Фиксированный норматив: {number(data.fixedMae)} мин</span></article><article><small>Независимая проверка</small><b>{data.count} визитов</b><span>Из {data.eligible} пригодных / {data.total} с завершением</span></article><article><small>Недооценка / переоценка</small><b>{data.underestimated} / {data.overestimated}</b><span>В среднем +{number(data.underMinutes)} / −{number(data.overMinutes)} мин на визит</span></article></div><p>Сравниваются технические минуты без дороги, оформления и ожидания клиента. Проверочный период — {data.temporalSplit ? `с ${data.temporalSplit.split('-').reverse().join('.')}` : 'по доступным измеренным визитам'}. Каждый прогноз рассчитан до своего визита; будущие сведения исключены.</p><div className='cx-table-wrap'><table><thead><tr><th>Вид работ</th><th>Визитов</th><th>Новая модель, мин</th><th>Фиксированная, мин</th></tr></thead><tbody>{data.byKind.map(item => <tr key={item.kind}><td>{KINDS[item.kind]}</td><td>{item.count}</td><td>{number(item.mae)}</td><td>{number(item.fixedMae)}</td></tr>)}</tbody></table></div><p className='cx-muted'>{data.limitations} Покрытие пригодными фактами: {data.coverage == null ? 'не определено' : `${number(data.coverage * 100)}%`}.</p>{objects.length ? <><h4>Разобрать повторяющиеся отклонения</h4>{objects.map(object => <button type='button' className='cx-action' key={object.id} onClick={() => openObjectPassport(object.id, 'visits')}>{object.address}<ChevronRight size={16}/></button>)}</> : null}</> : <p>Загружаем пригодные факты…</p>}</section>;
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
  return <section className='cx-settings'><div className='cx-section-heading'><Clock3 size={19}/><h3>Нормативы времени</h3><span>Рабочие настройки</span></div>{draft ? <><p className='cx-muted'>Область действия — новые расчёты и проверенные черновики. Опубликованные прогнозы сохраняют свою версию. Дорога не включается.</p><div className='cx-norm-head'><span>Вид работ</span><span>Технические, мин</span><span>Оформление, мин</span></div>{Object.entries(KINDS).map(([kind, label]) => <div className='cx-norm-row' key={kind}><b>{label}</b>{[0, 1].map(index => <input key={index} type='number' min={index ? 0 : 1} max={index ? 120 : 600} aria-label={`${label}: ${index ? 'оформление' : 'технические минуты'}`} value={draft.norms[kind][index]} onChange={event => setDraft(current => ({ ...current, norms: { ...current.norms, [kind]: current.norms[kind].map((value, at) => at === index ? Number(event.target.value) : value) } }))}/>)}</div>)}<details><summary>Все исходные подтипы нормативов ({data.workRules.length})</summary>{data.workRules.map(rule => <p key={`${rule.workType}-${rule.serviceType}`}>{rule.workType} · {rule.serviceType}: {rule.technical} + {rule.documents} мин</p>)}</details><details><summary>Веса факторов — гипотезы команды</summary><div className='cx-field-grid'>{Object.entries(draft.weights).map(([key, value]) => <label key={key}>{({ existingLine: 'Пригодная линия', shortCable: 'Малый объём кабеля', longCable: 'Значительный объём кабеля', device: 'Дополнительное устройство', point: 'Дополнительная точка', site: 'Площадка', knownFault: 'Известная неисправность', intermittent: 'Периодические сбои', segment: 'Сегмент диагностики', replacement: 'Замена устройства', firmware: 'Первоначальное обновление', searchNode: 'Поиск узла', damage: 'Элемент восстановления', readyConfig: 'Готовая конфигурация', stairs: 'Этаж подъёма' })[key]}<input type='number' value={value} onChange={event => setDraft(current => ({ ...current, weights: { ...current.weights, [key]: Number(event.target.value) } }))}/></label>)}</div></details><details><summary>Политика пригодной истории</summary>{Object.entries(draft.history).map(([key, value]) => <label key={key}>{({ minimum: 'Минимум наблюдений', shrinkage: 'Сглаживание малой выборки', maxAgeDays: 'Актуальность, дней', outlierMinutes: 'Граница проверки выброса, минут' })[key]}<input type='number' value={value} onChange={event => setDraft(current => ({ ...current, history: { ...current.history, [key]: Number(event.target.value) } }))}/></label>)}</details><label>Действует с<input type='datetime-local' value={effective} onChange={event => setEffective(event.target.value)}/></label><label>Причина изменения<input value={reason} onChange={event => setReason(event.target.value)} placeholder='Основание новой версии модели'/></label><button type='button' className='primary' disabled={!reason.trim()} onClick={save}><Check size={17}/>Сохранить модель</button>{saved ? <p role='status'>{saved}</p> : null}<details><summary>История версий ({data.versions.length})</summary>{data.versions.map(model => <p key={model.version}>{model.version} · {dateLabel(model.effectiveAt)}</p>)}</details></> : <p>Загружаем настройки…</p>}{error ? <p className='cx-error' role='alert'>{error}</p> : null}</section>;
}

/** Structured facts retain unknown stages rather than inventing technical measurements. */
export function DurationFactFields({ value, onChange, snapshot, fact }) {
  const update = (key, next) => onChange({ ...value, [key]: next });
  return <section className='cx-fact-fields'><h4>Длительность и причина отклонения</h4>{snapshot ? <p>Исходный визит: {snapshot.total} мин · техническая работа {snapshot.technical} мин · {snapshot.modelVersion}</p> : null}{fact?.startedAt ? <p>Начало: {fact.startedAt}</p> : <p className='cx-muted'>Без начала точная длительность неизвестна.</p>}<BusinessSelect ariaLabel='Причина отклонения длительности' value={value.deviationReason || ''} onChange={next => update('deviationReason', next)} options={[{ value: '', label: 'При существенном отклонении выберите причину' }, ...options(REASONS)]}/><details><summary>Известное время этапов и комментарий</summary><p className='cx-muted'>Оставьте пустым неизвестное. Измеренный ноль указывайте явно.</p>{[['accessMinutes', 'Доступ, мин'], ['documentMinutes', 'Оформление, мин'], ['customerMinutes', 'Ожидание клиента, мин']].map(([key, label]) => <label key={key}>{label}<input type='number' min='0' value={value[key] ?? ''} onChange={event => update(key, event.target.value)}/></label>)}<label>Комментарий<input value={value.comment || ''} onChange={event => update('comment', event.target.value)}/></label></details>{snapshot?.entities?.object ? <button type='button' onClick={() => openObjectPassport(snapshot.entities.object, 'visits')}>Паспорт и разбор отклонений</button> : null}</section>;
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
