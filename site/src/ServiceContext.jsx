import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Network, Wrench, X } from 'lucide-react';
import { Marker, LngLatBounds } from 'maplibre-gl';
import { BusinessSelect } from './BusinessSelect.jsx';
import { INCIDENT_STATUSES, INCIDENT_TYPES, ORDER_DECISIONS, emptyServiceContext, orderLabel, relatedOrders, serviceEventAt, serviceHistoryRows, serviceStats } from './serviceContextDomain.js';
import { useWorkspacePresence } from './useWorkspacePresence.js';
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
  const [refreshing, setRefreshing] = useState(false);
  const data = loaded?.shiftId === shiftId ? loaded : { revision: 0, ...emptyServiceContext() };
  useEffect(() => { setIncidentId(''); setError(''); }, [shiftId]);
  useEffect(() => {
    if (!shiftId) return;
    const controller = new AbortController();
    setRefreshing(true);
    fetch(`/api/service-context?shiftId=${encodeURIComponent(shiftId)}`, { signal: controller.signal }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error); setLoaded(result); setError(''); }).catch(issue => { if (issue.name !== 'AbortError') setError(issue.message); }).finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
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
  const model = { ...data, orders, plan, actor, shiftId, day, panelOpen, setPanelOpen, incidentId, setIncidentId, error, busy, refreshing, ready: Boolean(shiftId && loaded?.shiftId === shiftId), reload: () => setVersion(value => value + 1), save,
    demo: () => save({ action: 'demo' }, 'POST'),
    importData: payload => save({ shiftId: payload.shiftId, date: payload.date, data: payload.data }, 'PUT'),
    exportData: () => downloadJson({ schemaVersion: 1, shiftId, date: day, data: { cases: data.cases, incidents: data.incidents, components: data.components } }),
    prepare: async (kind, record, order) => { setBusy(true); try { await onPrepare?.(order, record); await save({ kind, id: record.id, action: 'prepare', orderId: String(order.id) }); } catch(issue) { setError(issue.message); throw issue; } finally { setBusy(false); } },
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
  return <p className={`service-source ${record.provenance === 'demo' ? 'demo' : ''}`}>{record.provenance === 'demo' ? 'Учебный пример' : record.provenance === 'import' ? 'Импортированные данные' : 'Отметка диспетчера'} · Сигнал {stamp(record.observedAt || record.updatedAt)}</p>;
}
function History({ record, model, onOrder }) {
  const [limit, setLimit] = useState(8);
  useEffect(() => setLimit(8), [record.id]);
  const rows = serviceHistoryRows(record, model.day);
  return <section className='network-journal' aria-label='Журнал сетевого события' aria-busy={model.refreshing}>
    <div className='network-journal-heading'><div><h3>Действия по событию</h3><small>Новые записи сверху · {rows.length}</small></div></div>
    <p className='service-muted'>Статусы, решения по выездам и комментарии сохраняются здесь автоматически.</p>
    <ol className='service-history'>{rows.slice(0, limit).map(event => <li key={event.index}><div className='service-history-heading'><b>{event.label}</b>{event.status ? <span>{INCIDENT_STATUSES[event.status]}</span> : null}</div><time title={`Запись внесена: ${stamp(event.recordedAt)}`}>{event.displayAt ? stamp(event.displayAt) : event.eventTimeKnown === false ? `Записано ${stamp(event.recordedAt)}` : 'Время события не указано'}</time><strong>{event.text}</strong>{event.actor ? <small>{event.actor}</small> : null}{event.orderId && model.orders.find(item => String(item.id) === event.orderId) ? <button type='button' className='service-secondary' onClick={() => onOrder?.(model.orders.find(item => String(item.id) === event.orderId))}>Открыть заявку<ChevronRight size={15}/></button> : null}</li>)}</ol>
    {rows.length > limit ? <button type='button' className='service-secondary' onClick={() => setLimit(value => value + 8)}>Показать ещё {Math.min(8, rows.length - limit)}</button> : null}
  </section>;
}
function EventTimeField({ day, value, onChange, required = true }) {
  return <label>Время события в смене<input type='time' required={required} value={value} onChange={event => onChange(event.target.value)}/><small className='service-muted'>Дата: {day.split('-').reverse().join('.')} · укажите время проверки или действия.</small></label>;
}
const recoveryInput = value => value ? new Date(value).toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).slice(0, 16).replace(' ', 'T') : '';
function IncidentControls({ model, record, component }) {
  const [status, setStatus] = useState(record.status), [unknown, setUnknown] = useState(!record.expectedRecoveryAt), [recovery, setRecovery] = useState(recoveryInput(record.expectedRecoveryAt));
  const [note, setNote] = useState(''), [eventTime, setEventTime] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { setStatus(record.status); setUnknown(!record.expectedRecoveryAt); setRecovery(recoveryInput(record.expectedRecoveryAt)); setNote(''); setEventTime(''); setNotice(''); }, [record.id]);
  const dirty = status !== record.status || (status !== 'resolved' && (unknown !== !record.expectedRecoveryAt || (!unknown && recovery !== recoveryInput(record.expectedRecoveryAt)))) || Boolean(note.trim());
  const submit = async event => {
    event.preventDefault();
    try {
      const saved = await model.save({ kind: 'incident', id: record.id, action: 'details', status, expectedRecoveryAt: status === 'resolved' || unknown ? null : serviceEventAt(recovery.slice(0, 10), recovery.slice(11, 16)), ...(note.trim() ? { note: note.trim() } : {}), ...(eventTime ? { effectiveAt: serviceEventAt(model.day, eventTime) } : {}) });
      const updated = saved.incidents.find(item => item.id === record.id);
      setUnknown(!updated.expectedRecoveryAt); setRecovery(recoveryInput(updated.expectedRecoveryAt)); setNote(''); setEventTime(''); setNotice('Сохранено в истории');
    } catch { /* Shared error remains visible. */ }
  };
  return <form className='network-incident-controls' onSubmit={submit}>
    <div className='network-source-summary'><Network size={17}/><div><small>Общий источник</small><b>{component?.title || 'Не указан'}</b></div></div>
    <label>Статус проблемы<BusinessSelect portalMenu ariaLabel='Статус проблемы' value={status} options={statusOptions(INCIDENT_STATUSES)} onChange={value => { setStatus(value); setNotice(''); }}/></label>
    {status !== 'resolved' ? <div className='network-recovery'><b>Ожидаемое восстановление</b><label className='service-check'><input type='checkbox' checked={unknown} onChange={event => { setUnknown(event.target.checked); setNotice(''); }}/>Время пока неизвестно</label>{!unknown ? <label><span className='service-muted'>Дата и время · МСК</span><input aria-label='Ожидаемое восстановление' type='datetime-local' required value={recovery} onChange={event => { setRecovery(event.target.value); setNotice(''); }}/></label> : null}</div> : <p className='service-muted'>Проблема устранена. Проверьте, какие выезды ещё нужны клиентам.</p>}
    <details className='network-comment'><summary>Добавить комментарий</summary><label>Комментарий<textarea aria-label='Комментарий к проблеме' maxLength={2000} value={note} onChange={event => { setNote(event.target.value); setNotice(''); }} placeholder='Необязательно: уточнение от сетевой службы или результат звонка'/></label></details>
    {dirty ? <div className='network-save-details'><details><summary>Указать время события</summary><EventTimeField day={model.day} value={eventTime} onChange={setEventTime} required={false}/></details><button className='service-primary' type='submit' disabled={model.busy}>Сохранить</button></div> : null}
    {notice ? <small className='service-muted' role='status'>{notice}</small> : null}
  </form>;
}
function IncidentOrders({ model, record, component, orders, onOrder }) {
  return <section className='network-related-orders' aria-label='Связанные заявки'>
    <div className='network-related-heading'><h3>Связанные заявки · {orders.length}</h3><small>Решите, какие выезды можно выполнять.</small></div>
    <details className='network-link-basis'><summary>Почему эти заявки связаны</summary><p className='service-muted'>{record.basis}</p></details>
    {orders.map((order, index) => {
      const route = model.plan?.routes?.find(item => item.assignments?.some(value => String(value.orderId) === String(order.id)));
      const assignment = route?.assignments.find(item => String(item.orderId) === String(order.id));
      const decision = record.orderDecisions?.[String(order.id)] || 'review';
      return <article className='network-order' key={order.id}><span className='network-number'>{index + 1}</span><div>
        <b>Заявка {orderLabel(order)}</b><p>{order.address}</p>
        <small>{record.status === 'review' ? 'Возможна зависимость' : record.status === 'resolved' ? 'Источник восстановлен' : 'Связана с проблемой'} · {component?.title || 'общий источник'}</small>
        <small>Окно: {order.start && order.end ? `${order.start}–${order.end}` : 'не задано'}{assignment ? ` · в плане ${assignment.plannedStart}` : ' · не назначена'}</small>
        <span className={`network-decision-label ${decision}`}>{ORDER_DECISIONS[decision]}</span>
        <div className='network-order-decisions' role='group' aria-label={`Решение по заявке ${orderLabel(order)}`}>{['proceed', 'wait'].map(value => <button type='button' key={value} aria-pressed={decision === value} className={decision === value ? 'active' : ''} disabled={model.busy} onClick={() => model.save({ kind: 'incident', id: record.id, action: 'order_decision', orderId: String(order.id), decision: decision === value ? 'review' : value }).catch(() => {})}>{ORDER_DECISIONS[value]}</button>)}</div>
        <div className='network-order-actions'><button type='button' className='service-secondary' onClick={() => onOrder(order)}>Открыть заявку<ChevronRight size={15}/></button><button type='button' className='service-primary' disabled={model.busy} onClick={() => model.prepare('incident', record, order).catch(() => {})}><Wrench size={15}/>Пересмотреть план</button></div>
      </div></article>;
    })}
    {!orders.length ? <p className='service-muted'>Связанных заявок пока нет.</p> : <p className='service-footnote'>Отметки не меняют план. «Пересмотреть план» открывает перенос времени выбранной заявки; публикация — отдельно.</p>}
  </section>;
}
function ServiceError({ model }) { return model.error ? <div className='service-error' role='alert'>{model.error}<button onClick={model.reload} type='button'>Обновить данные</button></div> : null; }
function DemoButton({ model }) { return <button type='button' disabled={!model.ready || model.busy || model.incidents.length > 0} onClick={() => model.demo().catch(() => {})}>Показать демонстрационный пример</button>; }

function NetworkEventForm({ model, onClose }) {
  const [form, setForm] = useState({ title: '', component: '', type: 'equipment', basis: '', observedTime: '', lat: '', lng: '', locationBasis: '', orderIds: [] });
  const [query, setQuery] = useState('');
  const change = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const submit = async event => {
    event.preventDefault();
    const at = serviceEventAt(model.day, form.observedTime), recordedAt = new Date().toISOString(), id = crypto.randomUUID();
    const component = { id: `ASSET-${id}`, title: form.component.trim(), provenance: 'operator', locationBasis: form.locationBasis.trim(), ...((form.lat !== '' && form.lng !== '') ? { coords: [Number(form.lat), Number(form.lng)] } : {}) };
    const incident = { id: `INC-${id.slice(0, 8)}`, title: form.title.trim(), componentId: component.id, type: form.type, status: 'review', provenance: 'operator', basis: form.basis.trim(), observedAt: at, updatedAt: recordedAt, orderIds: form.orderIds, history: [{ at, recordedAt, kind: 'signal', eventTimeKnown: true, text: 'Событие зарегистрировано диспетчером. Причина требует проверки.', actor: model.actor }], task: { ...taskDefaults } };
    try { await model.importData({ shiftId: model.shiftId, date: model.day, data: { cases: model.cases, incidents: [...model.incidents, incident], components: [...model.components, component] } }); onClose(); model.setIncidentId(incident.id); } catch { /* Shared error. */ }
  };
  return <form className='service-create' onSubmit={submit}><h3>Зарегистрировать общую проблему</h3><EventTimeField day={model.day} value={form.observedTime} onChange={value => change('observedTime', value)}/><label>Что произошло<input required maxLength={250} value={form.title} onChange={event => change('title', event.target.value)}/></label><label>Тип проблемы<BusinessSelect portalMenu ariaLabel='Тип общей проблемы' value={form.type} options={statusOptions(INCIDENT_TYPES)} onChange={value => change('type', value)}/></label><label>Компонент / площадка<input required maxLength={250} value={form.component} onChange={event => change('component', event.target.value)}/></label><label>Основание связи с заявками<textarea required maxLength={2000} value={form.basis} onChange={event => change('basis', event.target.value)} placeholder='ID из реестра, результат проверки или ссылка на внешний инцидент'/></label><details><summary>Известные координаты</summary><p className='service-muted'>Без координат событие будет доступно в списке. Положение не угадывается по заявкам.</p><div className='service-fields'><label>Широта<input type='number' step='any' min='-90' max='90' required={form.lng !== ''} value={form.lat} onChange={event => change('lat', event.target.value)}/></label><label>Долгота<input type='number' step='any' min='-180' max='180' required={form.lat !== ''} value={form.lng} onChange={event => change('lng', event.target.value)}/></label></div><label>Источник координат<input required={form.lat !== ''} value={form.locationBasis} onChange={event => change('locationBasis', event.target.value)}/></label></details><details><summary>Связанные заявки · {form.orderIds.length}</summary><input aria-label='Поиск связанных заявок' placeholder='Номер или адрес' value={query} onChange={event => setQuery(event.target.value)}/><div className='service-order-choices'>{model.orders.filter(item => `${orderLabel(item)} ${item.address}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <label className='service-check' key={item.id}><input type='checkbox' checked={form.orderIds.includes(String(item.id))} onChange={event => change('orderIds', event.target.checked ? [...form.orderIds, String(item.id)] : form.orderIds.filter(id => id !== String(item.id)))}/>{orderLabel(item)} · {item.address}</label>)}</div></details><div className='service-actions'><button type='button' onClick={onClose}>Отмена</button><button type='submit' disabled={model.busy}>Зарегистрировать</button></div></form>;
}
function NetworkMapDrawing({ map, model, selected, visible, links }) {
  const overview = model.panelOpen && !selected;
  const signature = JSON.stringify({ overview, incidents: model.incidents, components: model.components, selected: selected?.id, orders: visible.map(order => ({ id: order.id, coords: order.coords })), links });
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
        affected.forEach((order,index)=>{const incidents=active.filter(item=>item.orderIds.includes(String(order.id)));add(order.coords,overview?String(index+1):'',overview?'request':'affected',`Заявка ${orderLabel(order)}: связана с общей проблемой ${incidents.map(item=>item.id).join(', ')}`,()=>{model.setIncidentId(incidents[0].id);model.setPanelOpen(true);});});
      }
    };
    drawMarkers(); map.on('moveend', drawMarkers);
    // Project dependency connectors independently from basemap tile/style loading.
    // They are UI links, not a claim about physical cable geometry.
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('network-connections');svg.setAttribute('aria-hidden','true');map.getContainer().append(svg);
    let frame=0;
    const renderLinks=()=>{
      frame=0;svg.replaceChildren();
      const incidents = selected ? (links ? [selected] : []) : overview ? active : [];
      if (!incidents.length) return;
      svg.setAttribute('viewBox',`0 0 ${map.getContainer().clientWidth} ${map.getContainer().clientHeight}`);
      for (const incident of incidents) {
        const component = model.components.find(item => item.id === incident.componentId);
        if (!Array.isArray(component?.coords)) continue;
        const start = map.project([component.coords[1],component.coords[0]]);
        relatedOrders(incident, model.orders).filter(item=>Array.isArray(item.coords)&&item.coords.length===2&&item.coords.every(Number.isFinite)).forEach(order=>{
          const end=map.project([order.coords[1],order.coords[0]]);
          for(const kind of ['outline','link']){const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',start.x);line.setAttribute('y1',start.y);line.setAttribute('x2',end.x);line.setAttribute('y2',end.y);line.setAttribute('class',`network-connection-${kind}`);svg.append(line);}
        });
      }
    };
    const queueLinks=()=>{if(!frame)frame=requestAnimationFrame(renderLinks);};
    renderLinks();map.on('move',queueLinks);map.on('resize',queueLinks);map.on('idle',queueLinks);
    return()=>{markers.forEach(marker=>marker.remove());map.off('moveend',drawMarkers);map.off('move',queueLinks);map.off('resize',queueLinks);map.off('idle',queueLinks);if(frame)cancelAnimationFrame(frame);svg.remove();};

  }, [map, signature]);
  return null;
}

export function NetworkWorkspace({ map, enabled, onOrder }) {
  const model = useServiceContext();
  const [tab, setTab] = useState('orders'), [onlyLinked, setOnlyLinked] = useState(false), [links, setLinks] = useState(true);
  const [creating, setCreating] = useState(false);
  const panelPresence = useWorkspacePresence(enabled && model?.panelOpen ? model.incidentId || 'network-list' : null, 180);
  const selected = model?.incidents.find(item => item.id === model.incidentId);
  // Retain the outgoing record through its exit, instead of flashing the event list.
  const displayed = model?.incidents.find(item => item.id === panelPresence.renderedKey);
  const displayedOrders = useMemo(() => displayed ? relatedOrders(displayed, model?.orders || []) : [], [displayed, model?.orders]);
  const visible = useMemo(() => selected ? relatedOrders(selected, model?.orders || []) : [], [selected, model?.orders]);
  useEffect(() => { setTab('orders'); setLinks(true); }, [panelPresence.renderedKey]);
  useEffect(() => { if (!enabled) { model?.setPanelOpen(false); model?.setIncidentId(''); } }, [enabled]);
  useEffect(() => {
    const open = event => onOrder?.(event.detail);
    window.addEventListener('beego:service-order', open); return () => window.removeEventListener('beego:service-order', open);
  }, [onOrder]);
  useEffect(() => {
    if (!enabled || !map || (!model.panelOpen && !selected) || panelPresence.renderedKey !== (selected?.id || 'network-list') || panelPresence.motionClass === 'is-closing') return;
    const incidents = selected ? [selected] : model.incidents.filter(item => item.status !== 'resolved');
    const affected = selected ? visible : relatedOrders({ orderIds: incidents.flatMap(item => item.orderIds) }, model.orders);
    const components = incidents.map(incident => model.components.find(item => item.id === incident.componentId));
    const points = [...components, ...affected].filter(item => Array.isArray(item?.coords) && item.coords.length === 2 && item.coords.every(Number.isFinite));
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
  }, [map, selected?.id, model?.panelOpen, panelPresence.renderedKey, panelPresence.motionClass]);
  useEffect(() => {
    if (!enabled || !map) return;
    const container = map.getContainer().closest('.map-canvas');
    container?.classList.toggle('network-focused', Boolean(selected || model.panelOpen));
    map.fire('beego:network-focus');
    return () => { container?.classList.remove('network-focused'); map.fire('beego:network-focus'); };
  }, [map, enabled, selected?.id, model?.panelOpen]);
  useEffect(() => {
    if (!model?.panelOpen || !enabled) return;
    const close = event => { if (event.key === 'Escape' && !document.querySelector('.business-select-menu')) { model.setPanelOpen(false); model.setIncidentId(''); } };
    document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close);
  }, [model?.panelOpen, enabled]);
  useEffect(() => {
    if (!enabled || !map || !selected) return;
    const dismiss = event => {
      const target = event.originalEvent?.target;
      // Map controls, popups and point markers are not empty map clicks.
      if (!target || target !== map.getCanvas() || event.originalEvent.defaultPrevented) return;
      const layers = ['planned-route-hit', 'cx-points', 'cx-point-label'].filter(id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
      if (layers.length && map.queryRenderedFeatures(event.point, { layers }).length) return;
      model.setIncidentId('');
      model.setPanelOpen(false);
    };
    map.on('click', dismiss);
    return () => map.off('click', dismiss);
  }, [map, enabled, selected?.id]);
  if (!model || !enabled) return null;
  const stats = serviceStats(model.incidents);
  const component = displayed && model.components.find(item => item.id === displayed.componentId);
  const openOrder = order => { onOrder?.(order); };
  return <><NetworkMapDrawing map={map} model={model} selected={selected} visible={visible} links={links}/>{panelPresence.present ? <aside key={panelPresence.renderedKey} className={`network-panel service-ui ${displayed?'is-detail':''} ${panelPresence.motionClass}`} aria-label='Влияние сети на заявки' aria-hidden={panelPresence.motionClass === 'is-closing'} inert={panelPresence.motionClass === 'is-closing' ? true : undefined}><header><div><small>КОНТЕКСТ ЗАЯВОК</small><h2>{displayed ? displayed.id : 'Влияние на заявки'}</h2></div><button type='button' aria-label='Закрыть сетевые инциденты' onClick={() => { model.setPanelOpen(false); model.setIncidentId(''); }}><X size={20}/></button></header><ServiceError model={model}/>{displayed ? <><button type='button' className='network-back' onClick={() => model.setIncidentId('')}><ArrowLeft size={16}/>Все события</button><div className={`network-alert ${displayed.status}`}><strong>{displayed.status === 'resolved' ? 'Проблема устранена' : displayed.title}</strong><span>{INCIDENT_TYPES[displayed.type]} · {INCIDENT_STATUSES[displayed.status]}</span></div><SourceLabel record={displayed}/><nav className='service-tabs network-detail-tabs' aria-label='Разделы сетевого события'>{[['orders', `Заявки · ${displayedOrders.length}`], ['history', 'История']].map(([key, label]) => <button type='button' key={key} className={tab === key ? 'active' : ''} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</nav><div className='network-tab-content' hidden={tab !== 'orders'}><IncidentControls model={model} record={displayed} component={component}/><IncidentOrders model={model} record={displayed} component={component} orders={displayedOrders} onOrder={openOrder}/><label className='service-check'><input type='checkbox' checked={links} onChange={event => setLinks(event.target.checked)}/>Показать связи с заявками</label>{links ? <small className='service-footnote'>Пунктир показывает зависимость от источника.</small> : null}</div><div className='network-tab-content' hidden={tab !== 'history'}><History record={displayed} model={model} onOrder={openOrder}/></div></> : <><p className='service-muted'>Зарегистрированные общие проблемы. Живой мониторинг не подключён.</p><div className='network-stats'><span><b>{stats.active}</b>активных</span><span><b>{stats.orders}</b>заявок</span><span><b>{stats.review}</b>проверить</span></div><div className='service-tabs'><button type='button' className={!onlyLinked ? 'active' : ''} onClick={() => setOnlyLinked(false)}>Все события</button><button type='button' className={onlyLinked ? 'active' : ''} onClick={() => setOnlyLinked(true)}>Только с заявками</button></div>{model.incidents.filter(item => !onlyLinked || item.orderIds.length).map(item => <button className={`network-event ${item.status}`} type='button' key={item.id} onClick={() => { model.setIncidentId(item.id); }}><span className='network-event-icon'><Network size={19}/></span><span><b>{model.components.find(component=>component.id===item.componentId)?.title || item.id}</b><small>{item.title}</small><small>{INCIDENT_TYPES[item.type]} · {INCIDENT_STATUSES[item.status]}</small><small>{item.orderIds.length} связанных заявок{!model.components.find(value=>value.id===item.componentId)?.coords?' · нет координат':''}{item.provenance === 'demo' ? ' · демо' : ''}</small></span><ChevronRight size={16}/></button>)}{!model.incidents.length ? <div className='service-empty'><Network size={24}/><h3>{model.ready ? 'Общих событий нет' : 'Загрузка контекста…'}</h3><p>Зарегистрируйте общую проблему и укажите связанные с ней заявки.</p><DemoButton model={model}/></div> : null}{creating ? <NetworkEventForm model={model} onClose={() => setCreating(false)}/> : <button type='button' className='service-primary' disabled={!model.ready} onClick={() => setCreating(true)}>Зарегистрировать проблему</button>}</>}</aside> : null}</>;
}
