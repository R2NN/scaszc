import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { Check, FileUp, MapPin, Plus, X } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { TimePicker } from './TimePicker.jsx';
import { parseReplanningOrderFile } from './ImportWorkspace.jsx';
import './manual-entry.css';

const SKILLS = [
  { value: 'Подключение', label: 'Подключение' },
  { value: 'Локальные работы', label: 'Локальные работы' },
  { value: 'Аварийные работы', label: 'Аварийные работы' },
  { value: 'Дозаказ', label: 'Дозаказ' },
];
const TRANSPORT = [
  { value: 'Автомобиль', label: 'Автомобиль' },
  { value: 'Общественный транспорт', label: 'Общественный транспорт' },
  { value: 'Велосипед', label: 'Велосипед' },
  { value: 'Пешком', label: 'Пешком' },
];
const timeMinutes = value => { const [hours, minutes] = String(value || '').split(':').map(Number); return hours * 60 + minutes; };

export function ManualEntryModal({ type, zones = [], region, date, existingIds = [], replanning = false, onClose, onSave }) {
  const [form, setForm] = useState({ sourceId: '', name: '', address: '', coords: null, locationSource: '', zone: zones[0] || '', skill: 'Подключение', skills: ['Подключение'], equipment: '', priority: 'Обычная', transport: 'Автомобиль', start: '10:00', end: '12:00', duration: '60', shiftStart: '08:00', shiftEnd: '18:00', activeFrom: date?.toLocaleDateString?.('sv-SE') || new Date().toLocaleDateString('sv-SE') });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [importedOrders, setImportedOrders] = useState([]);
  const [importedFileName, setImportedFileName] = useState('');
  const [draggingFile, setDraggingFile] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const isOrder = type === 'orders';
  const update = (key, value) => { setForm(current => ({ ...current, [key]: value })); setError(''); };
  useEffect(() => {
    if (!isOrder || form.locationSource === 'suggestion' || form.locationSource === 'map' || form.address.trim().length < 3) {
      setSuggestions([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/geocode/suggest?q=${encodeURIComponent(form.address)}`, { signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Не удалось получить подсказки адресов.');
        setSuggestions(payload.results || []);
      } catch (issue) {
        if (!controller.signal.aborted) setError(issue.message);
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [form.address, form.locationSource, isOrder]);
  useEffect(() => {
    if (!mapOpen || !mapContainerRef.current) return undefined;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://tiles.openfreemap.org/styles/bright',
      center: form.coords ? [form.coords[1], form.coords[0]] : [37.6173, 55.7558],
      zoom: form.coords ? 15 : 10,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('click', event => {
      const coords = [Number(event.lngLat.lat.toFixed(7)), Number(event.lngLat.lng.toFixed(7))];
      setForm(current => ({ ...current, coords, locationSource: 'map', address: '' }));
      setSuggestions([]);
      setError('');
    });
    return () => { markerRef.current?.remove(); markerRef.current = null; map.remove(); mapRef.current = null; };
  }, [mapOpen]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !form.coords) return;
    markerRef.current?.remove();
    markerRef.current = new maplibregl.Marker({ color: '#f3bf00' }).setLngLat([form.coords[1], form.coords[0]]).addTo(map);
    map.flyTo({ center: [form.coords[1], form.coords[0]], zoom: Math.max(map.getZoom(), 13) });
  }, [form.coords, mapOpen]);
  const loadOrder = order => {
    setForm(current => ({ ...current,
      sourceId: order.sourceId || '', name: order.name || '', address: order.address || '',
      coords: order.coords || null, locationSource: order.coords ? 'file' : '',
      zone: order.zone || current.zone, skill: order.skill || current.skill,
      equipment: Array.isArray(order.equipment) ? order.equipment.join(', ') : order.equipment || '',
      priority: order.priority || current.priority, start: order.start || current.start,
      end: order.end || current.end, duration: String(order.duration || current.duration),
    }));
    setSuggestions([]);
    setError('');
  };
  const importFile = async file => {
    if (!file) return;
    try {
      const orders = await parseReplanningOrderFile(file, region);
      setImportedOrders(orders);
      setImportedFileName(file.name);
      loadOrder(orders[0]);
    } catch (issue) { setError(issue.message || 'Не удалось прочитать файл заявки.'); }
  };
  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    const sourceId = form.sourceId.trim();
    if (!sourceId || !form.name.trim() || !form.zone.trim()) { setError('Укажите ID, название и зону.'); return; }
    if (existingIds.some(value => String(value).toLocaleLowerCase('ru-RU') === sourceId.toLocaleLowerCase('ru-RU'))) { setError('Такой ID уже существует. Выберите другой.'); return; }
    if (isOrder && ((!form.address.trim() && !form.coords) || !Number(form.duration) || Number(form.duration) < 1 || timeMinutes(form.end) <= timeMinutes(form.start))) { setError('Укажите адрес или точку на карте, длительность и корректное окно клиента.'); return; }
    if (!isOrder && (!form.address.trim() || !form.skills.length || timeMinutes(form.shiftEnd) <= timeMinutes(form.shiftStart))) { setError('Укажите точный адрес старта, навык и корректную смену.'); return; }
    if (!isOrder && !/^\d{4}-\d{2}-\d{2}$/.test(form.activeFrom)) { setError('Укажите дату приёма в состав.'); return; }
    setSaving(true);
    try {
      const result = await onSave?.({ ...form, sourceId });
      if (result) setError(result);
    } catch (issue) {
      setError(issue?.message || 'Не удалось сохранить запись.');
    } finally {
      setSaving(false);
    }
  };
  return <div className="manual-entry-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className={`manual-entry-modal${isOrder ? ' manual-order-modal' : ''}`} role="dialog" aria-modal="true" aria-label={isOrder ? 'Добавить заявку вручную' : 'Добавить инженера вручную'}>
    <header><div><small>{isOrder ? 'РУЧНОЕ ДОБАВЛЕНИЕ' : replanning ? 'ДОБАВЛЕНИЕ В СМЕНУ' : 'ПОСТОЯННЫЙ СОСТАВ'}</small><h2>{isOrder ? 'Новая заявка' : 'Новый инженер'}</h2><p>{region?.name || 'Текущий регион'} · {isOrder ? date?.toLocaleDateString?.('ru-RU') || 'текущая смена' : `в составе с ${date?.toLocaleDateString?.('ru-RU') || 'выбранной даты'}`}</p></div><button type="button" aria-label="Закрыть" onClick={onClose}><X/></button></header>
    <form onSubmit={submit}>{isOrder ? <div className="manual-entry-import"><div className={`manual-entry-dropzone${draggingFile ? ' dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDraggingFile(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDraggingFile(false); }} onDrop={event => { event.preventDefault(); setDraggingFile(false); importFile(event.dataTransfer.files?.[0]); }}><span className="manual-entry-upload-icon"><FileUp size={25}/></span><div><strong>{importedFileName || 'Загрузить заявку из файла'}</strong><span>Перетащите файл сюда или выберите на компьютере</span><small>CSV · JSON · XLS · XLSX</small></div><label className="manual-entry-file-button">Выбрать файл<input type="file" accept=".csv,.json,.xls,.xlsx,application/json" onChange={event => { importFile(event.target.files?.[0]); event.target.value = ''; }}/></label></div>{importedOrders.length > 1 ? <label>Заявка из файла<select onChange={event => loadOrder(importedOrders[Number(event.target.value)])}>{importedOrders.map((order, index) => <option value={index} key={`${order.id}-${index}`}>{order.name} · {order.sourceId}</option>)}</select></label> : null}</div> : null}<div className="manual-entry-grid">
      <label>ID {isOrder ? 'заявки' : 'инженера'}<input value={form.sourceId} onChange={event => update('sourceId', event.target.value)} placeholder={isOrder ? 'CRM-12345' : 'ENG-123'} required/></label>
      <label>{isOrder ? 'Название заявки' : 'Имя / название бригады'}<input value={form.name} onChange={event => update('name', event.target.value)} placeholder={isOrder ? 'Подключение абонента' : 'Бригада Иванов'} required/></label>
      <label>Зона{zones.length ? <BusinessSelect ariaLabel="Зона" value={form.zone} onChange={value => update('zone', value)} options={zones.map(zone => ({ value: zone, label: zone }))}/> : <input value={form.zone} onChange={event => update('zone', event.target.value)} placeholder="Название зоны" required/>}</label>
      {isOrder ? <>
        <label>Вид работ<BusinessSelect ariaLabel="Вид работ" value={form.skill} onChange={value => update('skill', value)} options={SKILLS}/></label>
        <label>Приоритет<BusinessSelect ariaLabel="Приоритет" value={form.priority} onChange={value => update('priority', value)} options={[{ value: 'Обычная', label: 'Обычная' }, { value: 'Срочная', label: 'Срочная' }, { value: 'Авария', label: 'Авария' }]}/></label>
        <div className="wide manual-address-field"><label>Адрес в Москве<input value={form.address} onChange={event => { setForm(current => ({ ...current, address: event.target.value, coords: null, locationSource: '' })); setError(''); }} placeholder="Улица, дом" autoComplete="off"/></label>{suggestions.length ? <div className="manual-address-suggestions" role="listbox" aria-label="Подсказки адресов">{suggestions.map((item, index) => <button type="button" role="option" aria-selected={false} key={`${item.address}-${index}`} onClick={() => { setForm(current => ({ ...current, address: item.address, coords: item.coords, locationSource: 'suggestion' })); setSuggestions([]); }}><MapPin size={15}/>{item.address}</button>)}</div> : null}<button type="button" className="manual-map-toggle" onClick={() => setMapOpen(value => !value)}><MapPin size={16}/>{mapOpen ? 'Скрыть карту' : 'Выбрать точку на карте'}</button>{form.coords ? <small>Точка: {form.coords[0].toFixed(6)}, {form.coords[1].toFixed(6)} · {form.locationSource === 'map' ? 'выбрана на карте' : 'из адреса или файла'}</small> : null}{mapOpen ? <div ref={mapContainerRef} className="manual-entry-map" aria-label="Карта для выбора точки заявки"/> : null}</div>
        <TimePicker label="Начало окна" value={form.start} onChange={value => update('start', value)}/><TimePicker label="Конец окна" value={form.end} onChange={value => update('end', value)}/>
        <label>Работа, минут<input type="number" min="1" max="600" value={form.duration} onChange={event => update('duration', event.target.value)} required/></label>
        <label>Оборудование<input value={form.equipment} onChange={event => update('equipment', event.target.value)} placeholder="Роутер, ТВ-приставка"/></label>
      </> : <>
        <fieldset className="wide manual-skill-picker"><legend>Навыки</legend>{SKILLS.map(skill => <label className="manual-skill-option" key={skill.value}><input type="checkbox" checked={form.skills.includes(skill.value)} onChange={event => update('skills', event.target.checked ? [...form.skills, skill.value] : form.skills.filter(value => value !== skill.value))}/><span className="manual-checkbox" aria-hidden="true"><Check/></span><span>{skill.label}</span></label>)}</fieldset>
        <label>Транспорт<BusinessSelect ariaLabel="Транспорт" value={form.transport} onChange={value => update('transport', value)} options={TRANSPORT}/></label>
        <label>Оснащение<input value={form.equipment} onChange={event => update('equipment', event.target.value)} placeholder="Роутер, инструмент"/></label>
        <label>Адрес старта<input value={form.address} onChange={event => update('address', event.target.value)} placeholder="Город, улица, дом" required/></label>
        <label>В составе с<input type="date" value={form.activeFrom} onChange={event => update('activeFrom', event.target.value)} required/></label>
        <TimePicker label="Начало смены" value={form.shiftStart} onChange={value => update('shiftStart', value)}/><TimePicker label="Конец смены" value={form.shiftEnd} onChange={value => update('shiftEnd', value)}/>
      </>}
    </div><p className="manual-entry-hint">{isOrder ? 'Укажите адрес с домом, выберите подсказку или точку на карте. Заявка станет черновиком для точного перепланирования.' : replanning ? 'Адрес старта будет проверен. После сохранения инженер войдёт в состав, а изменение плана появится как черновик. Маршрут появится только после расчёта и публикации.' : 'Точный адрес старта будет проверен автоматически. Если дом не найдётся, инженер не будет добавлен. Добавление в состав не меняет опубликованный план смены.'}</p>{error ? <p className="manual-entry-error" role="alert">{error}</p> : null}<footer><button type="button" onClick={onClose}>Отмена</button><button type="submit" className="primary" disabled={saving}><Plus/>{saving ? 'Проверяем адрес…' : isOrder ? 'Добавить заявку' : replanning ? 'Подготовить инженера для плана' : 'Добавить инженера в состав'}</button></footer></form>
  </section></div>;
}
