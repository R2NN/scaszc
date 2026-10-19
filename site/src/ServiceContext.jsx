import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Network, X } from 'lucide-react';
import { Marker, LngLatBounds } from 'maplibre-gl';
import { BusinessSelect } from './BusinessSelect.jsx';
import { INCIDENT_STATUSES, INCIDENT_TYPES, emptyServiceContext, orderLabel, relatedOrders, serviceStats } from './serviceContextDomain.js';
import './serviceContext.css';

const Context = createContext(null);
export const useServiceContext = () => useContext(Context);
const stamp = value => value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : 'Нет данных';
const taskDefaults = { action: '', owner: '', deadline: '', access: 'unknown', equipment: 'unknown', customer: 'unknown' };
const statusOptions = values => Object.entries(values).map(([value, label]) => ({ value, label }));
function downloadJson(payload) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `beego-service-${payload.date}.json`; link.click(); URL.revokeObjectURL(url);
}
export function ServiceContextProvider({ shift, date, orders, plan, actor, onPrepare, onOpenOrder, children }) {
  const day = typeof date === 'string' ? date.slice(0, 10) : date?.toLocaleDateString('sv-SE');
  const shiftId = shift?.date === day ? shift.id : '';
  const [loaded, setLoaded] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [version, setVersion] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false), [incidentId, setIncidentId] = useState('');
  const data = loaded?.shiftId === shiftId ? loaded : { revision: 0, ...emptyServiceContext() };
  useEffect(() => {
    setIncidentId(''); setError('');
    if (!shiftId) return;
    const controller = new AbortController();
    fetch(`/api/service-context?shiftId=${encodeURIComponent(shiftId)}`, { signal: controller.signal }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error); setLoaded(result); }).catch(issue => { if (issue.name !== 'AbortError') setError(issue.message); });
    return () => controller.abort();
  }, [shiftId, version]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('serviceOrder');
    const order = orders.find(item => String(item.id) === id);
    if (order && shiftId) onOpenOrder?.(order);
  }, [shiftId, orders]);
  const save = async (input, method = 'PATCH') => {
    if (!shiftId || loaded?.shiftId !== shiftId) throw new Error('Дождитесь загрузки сохранённой смены.');
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/service-context?shiftId=${encodeURIComponent(shiftId)}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, revision: data.revision, actor }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setLoaded(result); return result;
    } catch (issue) { setError(issue.message); throw issue; } finally { setBusy(false); }
  };
  const model = { ...data, orders, plan, actor, shiftId, day, panelOpen, setPanelOpen, incidentId, setIncidentId, error, busy, ready: Boolean(shiftId && loaded?.shiftId === shiftId), reload: () => setVersion(value => value + 1), save,
    demo: () => save({ action: 'demo' }, 'POST'),
    importData: payload => save({ shiftId: payload.shiftId, date: payload.date, data: payload.data }, 'PUT'),
    exportData: () => downloadJson({ schemaVersion: 1, shiftId, date: day, data: { cases: data.cases, incidents: data.incidents, components: data.components } }),
    prepare: async (kind, record, order) => { await save({ kind, id: record.id, action: 'note', note: `Запрошена подготовка выезда по заявке ${orderLabel(order)}. План не изменён.` }); try { await onPrepare?.(order, record); } catch(issue) { setError(issue.message); throw issue; } },
  };
  return <Context.Provider value={model}>{children}</Context.Provider>;
}
export function NetworkControl({ onActivate }) {
  const model=useServiceContext();
  if(!model)return null;
  const count=serviceStats(model.incidents).active;
  return <button type='button' className='network-mode-control' aria-label='Сеть: влияние на заявки' data-tooltip='Сеть: влияние на заявки' aria-pressed={model.panelOpen} aria-expanded={model.panelOpen} onClick={()=>{onActivate?.();if(model.panelOpen)model.setIncidentId('');model.setPanelOpen(!model.panelOpen);}}><Network size={21}/>{count?<i className='network-mode-dot' aria-label={`${count} общих проблем`}/>:null}</button>;
}
export function ServiceOrderBadge({ order }) {
  const model = useServiceContext();
  if (!model) return null;
  const incident = model.incidents.find(item => item.id === model.incidentId && item.orderIds.includes(String(order.id))) || model.incidents.find(item=>item.status!=='resolved'&&item.orderIds.includes(String(order.id)));
  return incident ? <span className='service-badge incident'>{incident.id} · {incident.orderIds.indexOf(String(order.id)) + 1}</span> : null;
}
export function ServiceOrderFocusList({ onOrder }) {
  const model = useServiceContext();
  const incident = model?.incidents.find(item => item.id === model.incidentId);
  if (!incident) return null;
  return <section className='service-order-focus service-ui' aria-label='Заявки выбранного сетевого события'><header><b>{incident.id}</b><button type='button' aria-label='Снять выделение связанных заявок' onClick={() => model.setIncidentId('')}><X size={15}/></button></header>{relatedOrders(incident, model.orders).map((order, index) => <button type='button' key={order.id} onClick={() => onOrder?.(order)}><span className='network-number'>{index + 1}</span><span><b>Заявка {orderLabel(order)}</b><small>{order.address}</small></span><ChevronRight size={15}/></button>)}</section>;
}
function SourceLabel({ record }) {
  return <p className={`service-source ${record.provenance === 'demo' ? 'demo' : ''}`}>{record.provenance === 'demo' ? 'Демонстрационные данные' : record.provenance === 'import' ? 'Импортированные данные' : 'Отметка диспетчера'} · {stamp(record.updatedAt)}</p>;
}
function History({ record, model, onOrder }) {
  return <ol className='service-history'>{(record.history || []).map((event, index) => <li key={index}><time>{stamp(event.at)}</time><strong>{event.text}</strong>{event.actor ? <small>{event.actor}</small> : null}{event.orderId && model.orders.find(item => String(item.id) === event.orderId) ? <button type='button' onClick={() => onOrder?.(model.orders.find(item => String(item.id) === event.orderId))}>Открыть исходную заявку</button> : null}</li>)}</ol>;
}
function TaskEditor({ model, record, kind }) {
  const [task, setTask] = useState({ ...taskDefaults, ...record.task }), [notice, setNotice] = useState('');
  useEffect(() => { setTask({ ...taskDefaults, ...record.task }); setNotice(''); }, [record.id]);
  const change = (key, value) => { setTask(current => ({ ...current, [key]: value })); setNotice(''); };
  return <form className='service-task' onSubmit={async event => { event.preventDefault(); try { await model.save({ kind, id: record.id, action: 'task', task }); setNotice('Подготовка сохранена'); } catch { /* Shared error remains visible. */ } }}><h3>До следующего выезда</h3><label>Следующий шаг<input required maxLength={2000} value={task.action} onChange={event => change('action', event.target.value)}/></label><div className='service-fields'><label>Ответственный<input required maxLength={100} value={task.owner} onChange={event => change('owner', event.target.value)}/></label><label>Срок<input type='datetime-local' value={task.deadline} onChange={event => change('deadline', event.target.value)}/></label></div><div className='service-readiness'>{[['access', 'Доступ'], ['equipment', 'Оборудование'], ['customer', 'Клиент']].map(([key, label]) => <label key={key}>{label}<BusinessSelect portalMenu ariaLabel={`${label}: подготовка`} value={task[key]} onChange={value => change(key, value)} options={statusOptions({ unknown: 'Не проверено', waiting: 'Ожидаем', ready: 'Готово' })}/></label>)}</div><button type='submit' disabled={model.busy}>Сохранить подготовку</button>{notice ? <small role='status'>{notice}</small> : null}</form>;
}
function RecordNotes({ model, record, kind }) {
  const [note, setNote] = useState('');
  return <form className='service-note' onSubmit={async event => { event.preventDefault(); try { await model.save({ kind, id: record.id, action: 'note', note }); setNote(''); } catch { /* Shared error. */ } }}><label>Добавить результат проверки<textarea maxLength={2000} required value={note} onChange={event => setNote(event.target.value)} placeholder='Что проверили и что осталось сделать'/></label><button disabled={model.busy || !note.trim()}>Добавить в историю</button></form>;
}
function ServiceError({ model }) { return model.error ? <div className='service-error' role='alert'>{model.error}<button onClick={model.reload} type='button'>Обновить данные</button></div> : null; }
function DemoButton({ model }) { return <button type='button' disabled={!model.ready || model.busy || model.incidents.length > 0} onClick={() => model.demo().catch(() => {})}>Показать демонстрационный пример</button>; }

function NetworkEventForm({ model, onClose }) {
  const [form, setForm] = useState({ title: '', component: '', type: 'equipment', basis: '', lat: '', lng: '', locationBasis: '', orderIds: [] });
  const [query, setQuery] = useState('');
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const submit = async event => {
    event.preventDefault();
    const at = new Date().toISOString(), id = crypto.randomUUID();
    const component = { id: `ASSET-${id}`, title: form.component.trim(), provenance: 'operator', locationBasis: form.locationBasis.trim(), ...((form.lat !== '' && form.lng !== '') ? { coords: [Number(form.lat), Number(form.lng)] } : {}) };
    const incident = { id: `INC-${id.slice(0, 8)}`, title: form.title.trim(), componentId: component.id, type: form.type, status: 'review', provenance: 'operator', basis: form.basis.trim(), observedAt: at, updatedAt: at, orderIds: form.orderIds, history: [{ at, text: 'Событие зарегистрировано диспетчером. Причина требует проверки.', actor: model.actor }], task: { ...taskDefaults } };
    try { await model.importData({ shiftId: model.shiftId, date: model.day, data: { cases: model.cases, incidents: [...model.incidents, incident], components: [...model.components, component] } }); onClose(); model.setIncidentId(incident.id); } catch { /* Shared error. */ }
  };
  return <form className='service-create' onSubmit={submit}><h3>Зарегистрировать общую проблему</h3><label>Что произошло<input required maxLength={250} value={form.title} onChange={event => change('title', event.target.value)}/></label><label>Тип проблемы<BusinessSelect portalMenu ariaLabel='Тип общей проблемы' value={form.type} options={statusOptions(INCIDENT_TYPES)} onChange={value => change('type', value)}/></label><label>Компонент / площадка<input required maxLength={250} value={form.component} onChange={event => change('component', event.target.value)}/></label><label>Основание связи с заявками<textarea required maxLength={2000} value={form.basis} onChange={event => change('basis', event.target.value)} placeholder='ID из реестра, результат проверки или ссылка на внешний инцидент'/></label><details><summary>Известные координаты</summary><p className='service-muted'>Без координат событие будет доступно в списке. Положение не угадывается по заявкам.</p><div className='service-fields'><label>Широта<input type='number' step='any' min='-90' max='90' required={form.lng !== ''} value={form.lat} onChange={event => change('lat', event.target.value)}/></label><label>Долгота<input type='number' step='any' min='-180' max='180' required={form.lat !== ''} value={form.lng} onChange={event => change('lng', event.target.value)}/></label></div><label>Источник координат<input required={form.lat !== ''} value={form.locationBasis} onChange={event => change('locationBasis', event.target.value)}/></label></details><details><summary>Связанные заявки · {form.orderIds.length}</summary><input aria-label='Поиск связанных заявок' placeholder='Номер или адрес' value={query} onChange={event => setQuery(event.target.value)}/><div className='service-order-choices'>{model.orders.filter(item => `${orderLabel(item)} ${item.address}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <label className='service-check' key={item.id}><input type='checkbox' checked={form.orderIds.includes(String(item.id))} onChange={event => change('orderIds', event.target.checked ? [...form.orderIds, String(item.id)] : form.orderIds.filter(id => id !== String(item.id)))}/>{orderLabel(item)} · {item.address}</label>)}</div></details><div className='service-actions'><button type='button' onClick={onClose}>Отмена</button><button type='submit' disabled={model.busy}>Зарегистрировать</button></div></form>;
}
function NetworkMapDrawing({ map, model, selected, visible, links }) {
  const signature = JSON.stringify({ incidents: model.incidents, components: model.components, selected: selected?.id, orders: visible.map(order => ({ id: order.id, coords: order.coords })), links });
  useEffect(() => {
    if (!map) return;
    const markers = [];
    const add = (coords, text, kind, label, click) => {
      if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite)) return;
      const button = document.createElement('button'); button.type = 'button'; button.className = `network-map-marker ${kind}`; button.textContent = text; button.setAttribute('aria-label', label); button.title = label;
      if(kind.startsWith('source')){button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/></svg>';const count=document.createElement('span');count.textContent=text.replace('▦','').trim();if(count.textContent)button.append(count);}
      button.onclick = event => { event.stopPropagation(); click(); };
      markers.push(new Marker({ element: button }).setLngLat([coords[1], coords[0]]).addTo(map));
    };
    const active = model.incidents.filter(item => selected ? item.id === selected.id : item.status !== 'resolved');
    const drawMarkers = () => {
      markers.splice(0).forEach(marker => marker.remove());
      const groups = new Map();
      active.forEach(item => {
        const component = model.components.find(value => value.id === item.componentId);
        if (!component?.coords) return;
        const point = map.project([component.coords[1], component.coords[0]]);
        const key = selected ? item.id : `${Math.floor(point.x / 56)}:${Math.floor(point.y / 56)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ item, component });
      });
      groups.forEach(group => {
        const { item, component } = group[0];
        if (group.length === 1) add(component.coords, `▦${item.orderIds.length ? ` ${item.orderIds.length}` : ''}`, `source ${item.status} ${item.provenance==='demo'?'is-demo':''}`, `${item.id}: ${item.title}`, () => { model.setIncidentId(item.id); model.setPanelOpen(true); });
        else add(component.coords, `▦ ${group.length}`, 'source grouped', `${group.length} общих событий: открыть список`, () => { model.setIncidentId(''); model.setPanelOpen(true); });
      });
      if (selected) visible.forEach((order, index) => add(order.coords, String(index + 1), 'request', `Связанная заявка ${orderLabel(order)}`, () => window.dispatchEvent(new CustomEvent('beego:service-order', { detail: order }))));
      else {
        const affected = relatedOrders({orderIds:[...new Set(active.flatMap(item=>item.orderIds))]},model.orders);
        affected.forEach(order=>{const incidents=active.filter(item=>item.orderIds.includes(String(order.id)));add(order.coords,'','affected',`Заявка ${orderLabel(order)}: связана с общей проблемой ${incidents.map(item=>item.id).join(', ')}`,()=>{model.setIncidentId(incidents[0].id);model.setPanelOpen(true);});});
      }
    };
    drawMarkers(); map.on('moveend', drawMarkers);
    const component = selected && model.components.find(item => item.id === selected.componentId);
    // Project dependency connectors independently from basemap tile/style loading.
    // They are UI links, not a claim about physical cable geometry.
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('network-connections');svg.setAttribute('aria-hidden','true');map.getContainer().append(svg);
    let frame=0;
    const renderLinks=()=>{
      frame=0;svg.replaceChildren();
      if(!selected||!links||!Array.isArray(component?.coords))return;
      svg.setAttribute('viewBox',`0 0 ${map.getContainer().clientWidth} ${map.getContainer().clientHeight}`);
      const start=map.project([component.coords[1],component.coords[0]]);
      visible.filter(item=>Array.isArray(item.coords)&&item.coords.length===2&&item.coords.every(Number.isFinite)).forEach(order=>{
        const end=map.project([order.coords[1],order.coords[0]]);
        for(const kind of ['outline','link']){const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',start.x);line.setAttribute('y1',start.y);line.setAttribute('x2',end.x);line.setAttribute('y2',end.y);line.setAttribute('class',`network-connection-${kind}`);svg.append(line);}
      });
    };
    const queueLinks=()=>{if(!frame)frame=requestAnimationFrame(renderLinks);};
    renderLinks();map.on('move',queueLinks);map.on('resize',queueLinks);map.on('idle',queueLinks);
    return()=>{markers.forEach(marker=>marker.remove());map.off('moveend',drawMarkers);map.off('move',queueLinks);map.off('resize',queueLinks);map.off('idle',queueLinks);if(frame)cancelAnimationFrame(frame);svg.remove();};

  }, [map, signature]);
  return null;
}

export function NetworkWorkspace({ map, enabled, onOrder }) {
  const model = useServiceContext();
  const [tab, setTab] = useState('orders'), [onlyLinked, setOnlyLinked] = useState(false), [links, setLinks] = useState(true), [fileError, setFileError] = useState('');
  const [creating, setCreating] = useState(false);
  const selected = model?.incidents.find(item => item.id === model.incidentId);
  const visible = useMemo(() => selected ? relatedOrders(selected, model?.orders || []) : [], [selected, model?.orders]);
  useEffect(() => { setTab('orders'); setLinks(true); }, [selected?.id]);
  useEffect(() => { if (!enabled) { model?.setPanelOpen(false); model?.setIncidentId(''); } }, [enabled]);
  useEffect(() => {
    const open = event => onOrder?.(event.detail);
    window.addEventListener('beego:service-order', open); return () => window.removeEventListener('beego:service-order', open);
  }, [onOrder]);
  useEffect(() => {
    if (!enabled || !selected || !map) return;
    const component = model.components.find(item => item.id === selected.componentId);
    const points = [component, ...visible].filter(item => Array.isArray(item?.coords) && item.coords.length === 2 && item.coords.every(Number.isFinite));
    if (!points.length) return;
    const bounds = points.reduce((result, item) => result.extend([item.coords[1], item.coords[0]]), new LngLatBounds());
    const host = map.getContainer(), rect = host.getBoundingClientRect();
    const scaleX = host.clientWidth / rect.width, scaleY = host.clientHeight / rect.height;
    const leftPanel = document.querySelector('.route-list-panel');
    const left = leftPanel && getComputedStyle(leftPanel).visibility !== 'hidden' ? leftPanel.getBoundingClientRect() : null;
    const rightPanel = document.querySelector('.network-panel')?.getBoundingClientRect();
    const narrow = window.innerWidth <= 760;
    const padding = narrow
      ? { top: 120 * scaleY, bottom: Math.min(host.clientHeight * .6, (rect.bottom - (rightPanel?.top || rect.bottom) + 30) * scaleY), left: 80 * scaleX, right: 25 * scaleX }
      : { top: 125 * scaleY, bottom: 100 * scaleY, left: (left ? Math.max(70, left.right - rect.left + 55) : 75) * scaleX, right: (rightPanel ? Math.max(75, rect.right - rightPanel.left + 55) : 80) * scaleX };
    map.fitBounds(bounds, { padding, bearing: map.getBearing(), pitch: map.getPitch(), maxZoom: 16.5, duration: 600 });
  }, [map, selected?.id]);
  useEffect(() => {
    if (!enabled || !map) return;
    const container = map.getContainer().closest('.map-canvas');
    container?.classList.toggle('network-focused', Boolean(selected));
    return () => container?.classList.remove('network-focused');
  }, [map, enabled, selected?.id]);
  useEffect(() => {
    if (!model?.panelOpen || !enabled) return;
    const close = event => { if (event.key === 'Escape' && !document.querySelector('.business-select-menu')) { model.setPanelOpen(false); model.setIncidentId(''); } };
    document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close);
  }, [model?.panelOpen, enabled]);
  if (!model || !enabled) return null;
  const stats = serviceStats(model.incidents);
  const component = selected && model.components.find(item => item.id === selected.componentId);
  const patch = input => model.save({ kind: 'incident', id: selected.id, ...input }).catch(() => {});
  const openOrder = order => { model.setPanelOpen(false); onOrder?.(order); };
  return <><NetworkMapDrawing map={map} model={model} selected={selected} visible={visible} links={links}/>{!model.panelOpen&&model.incidents.some(item=>item.provenance==='demo'&&item.status!=='resolved')?<button className='network-map-notice' type='button' onClick={()=>{model.setIncidentId(model.incidents.find(item=>item.provenance==='demo'&&item.status!=='resolved').id);model.setPanelOpen(true);}}><Network size={15}/><span>Учебная проблема сети · {stats.orders} заявки</span></button>:null}{model.panelOpen ? <aside className={`network-panel service-ui ${selected?'is-detail':''}`} aria-label='Влияние сети на заявки'><header><div><small>КОНТЕКСТ ЗАЯВОК</small><h2>{selected ? selected.id : 'Влияние на заявки'}</h2></div><button type='button' aria-label='Закрыть сетевые инциденты' onClick={() => { model.setPanelOpen(false); model.setIncidentId(''); }}><X size={20}/></button></header><ServiceError model={model}/>{fileError ? <p className='service-error' role='alert'>{fileError}</p> : null}{selected ? <><button type='button' className='network-back' onClick={() => model.setIncidentId('')}><ArrowLeft size={16}/>Все события</button><div className={`network-alert ${selected.status}`}><strong>{selected.title}</strong><span>{INCIDENT_TYPES[selected.type]} · {INCIDENT_STATUSES[selected.status]}</span></div><SourceLabel record={selected}/><nav className='service-tabs' aria-label='Разделы сетевого события'>{[['orders', `Заявки · ${visible.length}`], ['cause', 'Причина'], ['history', 'История']].map(([key, label]) => <button type='button' key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>{tab === 'orders' ? <><p className='service-muted'>Привязка по реестру, не по расстоянию до узла.</p>{visible.length ? visible.map((order, index) => {
    const route = model.plan?.routes?.find(item => item.assignments?.some(value => String(value.orderId) === String(order.id)));
    const assignment = route?.assignments.find(item => String(item.orderId) === String(order.id));
    return <article className='network-order' key={order.id}><span className='network-number'>{index + 1}</span><div><b>Заявка {orderLabel(order)}</b><p>{order.address}</p><small>Окно: {order.start && order.end ? `${order.start}–${order.end}` : 'не задано'}</small><small>{assignment ? `План: ${assignment.plannedStart} · ${route.engineerName || route.engineerId}` : 'Не назначена'}</small><button type='button' onClick={() => openOrder(order)}>Открыть заявку<ChevronRight size={14}/></button><button type='button' disabled={model.busy} onClick={() => model.prepare('incident', selected, order).catch(() => {})}>Подготовить решение</button></div></article>;
  }) : <p className='service-empty'>Связанных обращений пока нет.</p>}<label className='service-check'><input type='checkbox' checked={links} onChange={event => setLinks(event.target.checked)}/>Показать связи с заявками</label>{links ? <small className='service-footnote'>Пунктир — зависимость от источника, не кабельная трасса и не маршрут бригады.</small> : null}</> : tab === 'cause' ? <><h3>Основание связи</h3><p>{selected.basis}</p><h3>Источник проблемы</h3><p>{component?.title || 'Неизвестен'}</p>{!component?.coords?<p className='service-muted'>Расположение источника неизвестно. На карте показаны только связанные заявки.</p>:null}{component?.locationBasis ? <p className='service-muted'>{component.locationBasis}</p> : null}<p className='service-muted'>Сигнал на {stamp(selected.observedAt || selected.updatedAt)}. Текущее состояние оборудования не измеряется. Причина требует проверки.</p><label>Результат проверки<BusinessSelect portalMenu ariaLabel='Статус сетевого события' value={selected.status} options={statusOptions(INCIDENT_STATUSES)} onChange={status => patch({ action: 'status', status })}/></label><TaskEditor model={model} kind='incident' record={selected}/></> : <><History record={selected} model={model} onOrder={openOrder}/><RecordNotes model={model} kind='incident' record={selected}/></>}</> : <><p className='service-muted'>Зарегистрированные общие проблемы. Живой мониторинг не подключён.</p><div className='network-stats'><span><b>{stats.active}</b>активных</span><span><b>{stats.orders}</b>заявок</span><span><b>{stats.review}</b>проверить</span></div><div className='service-tabs'><button type='button' className={!onlyLinked ? 'active' : ''} onClick={() => setOnlyLinked(false)}>Все события</button><button type='button' className={onlyLinked ? 'active' : ''} onClick={() => setOnlyLinked(true)}>Только с заявками</button></div>{model.incidents.filter(item => !onlyLinked || item.orderIds.length).map(item => <button className={`network-event ${item.status}`} type='button' key={item.id} onClick={() => { model.setIncidentId(item.id); }}><span className='network-event-icon'><Network size={19}/></span><span><b>{item.title}</b><small>{INCIDENT_TYPES[item.type]} · {INCIDENT_STATUSES[item.status]}</small><small>{item.orderIds.length} связанных заявок{!model.components.find(value=>value.id===item.componentId)?.coords?' · нет координат':''}{item.provenance === 'demo' ? ' · демо' : ''}</small></span><ChevronRight size={16}/></button>)}{!model.incidents.length ? <div className='service-empty'><Network size={24}/><h3>{model.ready ? 'Общих событий нет' : 'Загрузка контекста…'}</h3><p>Импортируйте реестр и явные связи с заявками либо откройте учебный пример.</p><DemoButton model={model}/></div> : null}{creating ? <NetworkEventForm model={model} onClose={() => setCreating(false)}/> : <button type='button' className='service-primary' disabled={!model.ready} onClick={() => setCreating(true)}>Зарегистрировать проблему</button>}<details className='network-equipment'><summary>Оборудование и связи · {model.components.length}</summary><p className='service-muted'>Обычные компоненты скрыты с карты. Влияние показывается только у выбранного события.</p>{model.components.map(item => <p key={item.id}><b>{item.title}</b><br/><small>{item.provenance === 'demo' ? 'Демонстрационный компонент' : item.id} · {item.coords ? 'Координаты заданы' : 'Расположение неизвестно'}</small></p>)}</details><details><summary>Данные: импорт и экспорт</summary><p className='service-muted'>JSON текущей смены: реестр и сетевые события. Импорт заменяет только этот контекст, не план и не факты.</p><div className='service-actions'><button type='button' disabled={!model.ready} onClick={model.exportData}>Экспорт JSON</button><label className='service-file'>Импорт JSON<input aria-label='Импорт контекста JSON' type='file' accept='.json,application/json' disabled={!model.ready || model.busy} onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { if (file.size > 2_000_000) throw new Error('Файл превышает 2 МБ.'); const payload = JSON.parse(await file.text()); if (payload.schemaVersion !== 1) throw new Error('Нужен schemaVersion: 1.'); await model.importData(payload); setFileError(''); } catch (issue) { setFileError(issue.message); } }}/></label></div></details></>}</aside> : null}</>;
}
