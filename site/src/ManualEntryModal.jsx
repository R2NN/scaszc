import { useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { TimePicker } from './TimePicker.jsx';
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

export function ManualEntryModal({ type, zones = [], region, date, existingIds = [], onClose, onSave }) {
  const [form, setForm] = useState({ sourceId: '', name: '', address: '', zone: zones[0] || '', skill: 'Подключение', skills: ['Подключение'], equipment: '', priority: 'Обычная', transport: 'Автомобиль', start: '10:00', end: '12:00', duration: '60', shiftStart: '08:00', shiftEnd: '18:00', activeFrom: date?.toLocaleDateString?.('sv-SE') || new Date().toLocaleDateString('sv-SE') });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isOrder = type === 'orders';
  const update = (key, value) => { setForm(current => ({ ...current, [key]: value })); setError(''); };
  const submit = async event => {
    event.preventDefault();
    if (saving) return;
    const sourceId = form.sourceId.trim();
    if (!sourceId || !form.name.trim() || !form.zone.trim()) { setError('Укажите ID, название и зону.'); return; }
    if (existingIds.some(value => String(value).toLocaleLowerCase('ru-RU') === sourceId.toLocaleLowerCase('ru-RU'))) { setError('Такой ID уже существует. Выберите другой.'); return; }
    if (isOrder && (!form.address.trim() || !Number(form.duration) || Number(form.duration) < 1 || timeMinutes(form.end) <= timeMinutes(form.start))) { setError('Укажите адрес, длительность и корректное окно клиента.'); return; }
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
  return <div className="manual-entry-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}><section className="manual-entry-modal" role="dialog" aria-modal="true" aria-label={isOrder ? 'Добавить заявку вручную' : 'Добавить инженера вручную'}>
    <header><div><small>{isOrder ? 'РУЧНОЕ ДОБАВЛЕНИЕ' : 'ПОСТОЯННЫЙ СОСТАВ'}</small><h2>{isOrder ? 'Новая заявка' : 'Новый инженер'}</h2><p>{region?.name || 'Текущий регион'} · {isOrder ? date?.toLocaleDateString?.('ru-RU') || 'текущая смена' : `в составе с ${date?.toLocaleDateString?.('ru-RU') || 'выбранной даты'}`}</p></div><button type="button" aria-label="Закрыть" onClick={onClose}><X/></button></header>
    <form onSubmit={submit}><div className="manual-entry-grid">
      <label>ID {isOrder ? 'заявки' : 'инженера'}<input value={form.sourceId} onChange={event => update('sourceId', event.target.value)} placeholder={isOrder ? 'CRM-12345' : 'ENG-123'} required/></label>
      <label>{isOrder ? 'Название заявки' : 'Имя / название бригады'}<input value={form.name} onChange={event => update('name', event.target.value)} placeholder={isOrder ? 'Подключение абонента' : 'Бригада Иванов'} required/></label>
      <label>Зона{zones.length ? <BusinessSelect ariaLabel="Зона" value={form.zone} onChange={value => update('zone', value)} options={zones.map(zone => ({ value: zone, label: zone }))}/> : <input value={form.zone} onChange={event => update('zone', event.target.value)} placeholder="Название зоны" required/>}</label>
      {isOrder ? <>
        <label>Вид работ<BusinessSelect ariaLabel="Вид работ" value={form.skill} onChange={value => update('skill', value)} options={SKILLS}/></label>
        <label>Приоритет<BusinessSelect ariaLabel="Приоритет" value={form.priority} onChange={value => update('priority', value)} options={[{ value: 'Обычная', label: 'Обычная' }, { value: 'Срочная', label: 'Срочная' }, { value: 'Авария', label: 'Авария' }]}/></label>
        <label className="wide">Адрес<input value={form.address} onChange={event => update('address', event.target.value)} placeholder="Город, улица, дом" required/></label>
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
    </div><p className="manual-entry-hint">{isOrder ? 'Точный дом будет найден по адресу автоматически. Если адрес не подтвердится, заявка не добавится — проверьте улицу и номер дома.' : 'Точный адрес старта будет проверен автоматически. Если дом не найдётся, инженер не будет добавлен. Добавление в состав не меняет опубликованный план смены.'}</p>{error ? <p className="manual-entry-error" role="alert">{error}</p> : null}<footer><button type="button" onClick={onClose}>Отмена</button><button type="submit" className="primary" disabled={saving}><Plus/>{saving ? 'Проверяем адрес…' : `Добавить ${isOrder ? 'заявку' : 'инженера в состав'}`}</button></footer></form>
  </section></div>;
}
