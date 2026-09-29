import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CalendarDays, Check, ChevronLeft, ChevronRight, Plus, RotateCcw, Search, X } from 'lucide-react';
import { TimePicker } from './TimePicker.jsx';
import { staffAvailableForShift } from './staffRoster.js';
import './staff-roster.css';

const laterTime = (first, second) => first > second ? first : second;
const calendarMonths = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const calendarDate = value => { const [year, month, day] = String(value || '').split('-').map(Number); return year && month && day ? new Date(year, month - 1, day) : new Date(); };
const calendarKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function RosterDatePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => { const date = calendarDate(value); return new Date(date.getFullYear(), date.getMonth(), 1); });
  const rootRef = useRef(null);
  useEffect(() => { if (!open) return undefined; const close = event => { if (event.key === 'Escape' || (event.type === 'pointerdown' && !rootRef.current?.contains(event.target))) setOpen(false); }; document.addEventListener('pointerdown', close); document.addEventListener('keydown', close); return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); }; }, [open]);
  const selected = calendarDate(value);
  const firstOffset = (visibleMonth.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, index) => new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), index + 1 - firstOffset));
  const choose = date => { onChange(calendarKey(date)); setOpen(false); };
  return <div className="staff-date-picker" ref={rootRef}>
    <button type="button" className="staff-date-trigger" aria-label="Дата изменения состава" aria-expanded={open} onClick={() => setOpen(current => !current)}>{String(selected.getDate()).padStart(2, '0')}.{String(selected.getMonth() + 1).padStart(2, '0')}.{selected.getFullYear()}<CalendarDays size={17}/></button>
    {open ? <section className="date-popover staff-date-popover" role="dialog" aria-label="Выбор даты изменения состава"><div className="calendar-head"><button type="button" onClick={() => setVisibleMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))} aria-label="Предыдущий месяц"><ChevronLeft/></button><strong>{calendarMonths[visibleMonth.getMonth()]} {visibleMonth.getFullYear()}</strong><button type="button" onClick={() => setVisibleMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))} aria-label="Следующий месяц"><ChevronRight/></button></div><div className="weekday-row">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{days.map(date => <button type="button" key={calendarKey(date)} className={`${date.getMonth() !== visibleMonth.getMonth() ? 'outside ' : ''}${calendarKey(date) === value ? 'selected' : ''}`} onClick={() => choose(date)} aria-label={`${date.getDate()} ${calendarMonths[date.getMonth()]} ${date.getFullYear()}`}>{date.getDate()}</button>)}</div><div className="calendar-footer"><button type="button" onClick={() => choose(new Date())}><CalendarDays/>Сегодня</button></div></section> : null}
  </div>;
}

export function StaffRosterModal({ mode = 'manage', roster = [], shift, date, onClose, onAddNew, onArchive, onRestore, onInclude }) {
  const [query, setQuery] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [startsLater, setStartsLater] = useState(false);
  const [customTime, setCustomTime] = useState('12:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [employmentDate, setEmploymentDate] = useState(new Date().toLocaleDateString('sv-SE'));
  const isInclude = mode === 'include';
  const candidates = useMemo(() => isInclude ? staffAvailableForShift(roster, shift, date) : [...roster].sort((left, right) => Number(left.rosterArchived) - Number(right.rosterArchived)), [isInclude, roster, shift, date]);
  const visible = candidates.filter(member => `${member.name} ${member.sourceId} ${member.zone || ''}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
  const selected = candidates.find(member => String(member.id) === selectedId);
  const lastPlanTime = shift?.versions?.at(-1)?.effectiveAt || '00:00';
  const workStart = selected?.shiftStart || '08:00';
  const availableFrom = startsLater ? laterTime(workStart, customTime) : workStart;
  const effectiveTime = laterTime(lastPlanTime, availableFrom);
  const act = async callback => {
    setBusy(true); setError('');
    try { await callback(); }
    catch (issue) { setError(issue?.message || 'Не удалось изменить состав.'); }
    finally { setBusy(false); }
  };
  return <div className="staff-roster-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="staff-roster-modal" role="dialog" aria-modal="true" aria-label={isInclude ? 'Включить бригаду в смену' : 'Управление составом'}>
      <header><div><small>{isInclude ? 'ПЛАН СМЕНЫ' : 'ПОСТОЯННЫЙ СОСТАВ'}</small><h2>{isInclude ? 'Включить бригаду в смену' : 'Управление составом'}</h2><p>{isInclude ? 'Выберите инженера из состава. План изменится только после проверки и публикации.' : 'Исключение из состава сохраняет историю. Для текущей смены инженера нужно отдельно снять с работы во вкладке «Бригады».'}</p></div><button type="button" aria-label="Закрыть" onClick={onClose}><X/></button></header>
      <div className="staff-roster-body">
        <label className="staff-roster-search"><Search size={18}/><input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Имя, ID или территория…" aria-label="Поиск в составе"/></label>
        {!isInclude ? <div className="staff-roster-employment-date"><span>Дата изменения состава</span><RosterDatePicker value={employmentDate} onChange={setEmploymentDate}/></div> : null}
        <div className="staff-roster-list">
          {visible.map(member => <article key={member.id} className={`staff-roster-row${selectedId === member.id ? ' selected' : ''}`}>
            <span className="staff-roster-avatar">{member.name.split(' ').map(part=>part[0]).join('').slice(0,2)}</span>
            <div><b>{member.name}</b><small>{member.sourceId} · {member.zone || 'Территория не указана'}</small><small>{member.rosterArchived ? `В архиве с ${member.rosterPeriods?.at(-1)?.to || '—'}` : `В составе с ${member.rosterPeriods?.at(-1)?.from || '—'}`}</small></div>
            {isInclude ? <button type="button" onClick={()=>{setSelectedId(member.id);setStartsLater(false);setError('')}}>Выбрать</button> : member.rosterArchived ? <button type="button" disabled={busy || !employmentDate} onClick={()=>act(()=>onRestore(member,employmentDate))}><RotateCcw size={15}/>Вернуть</button> : confirmId === member.id ? <div className="staff-roster-confirm"><span>Исключить из состава с {employmentDate}? Текущий план не изменится.</span><button type="button" disabled={busy || !employmentDate} onClick={()=>act(()=>onArchive(member,employmentDate))}><Check size={15}/>Подтвердить</button><button type="button" onClick={()=>setConfirmId('')}>Нет</button></div> : <button type="button" onClick={()=>setConfirmId(member.id)}><Archive size={15}/>Исключить из состава</button>}
          </article>)}
          {!visible.length ? <p className="staff-roster-empty">{query.trim()
            ? 'По вашему запросу инженеры не найдены.'
            : isInclude
              ? candidates.length === 0 && roster.some(member => staffActiveOn(member, date))
                ? 'Все инженеры действующего состава уже включены в эту смену. Чтобы увеличить команду, добавьте нового инженера в состав. Недоступную бригаду можно вернуть через её карточку.'
                : 'На выбранную дату в постоянном составе нет доступных инженеров. Добавьте инженера в состав или проверьте дату.'
              : 'Инженеры не найдены.'}</p> : null}
        </div>
        {isInclude && selected ? <div className="staff-roster-inclusion"><b>{selected.name}</b><p>Рабочее время: {workStart}–{selected.shiftEnd || '18:00'}. После публикации бригада будет видна в списке весь день, а на карте — с {availableFrom}.</p>{lastPlanTime > availableFrom ? <p>Маршрутные изменения начнут действовать с {lastPlanTime}: это время последней опубликованной версии плана, а не начало работы бригады.</p> : null}<label><input type="checkbox" checked={startsLater} onChange={event=>setStartsLater(event.target.checked)}/>Начнёт работу позже</label>{startsLater ? <TimePicker label="Доступна с" value={customTime} onChange={setCustomTime}/> : null}<button type="button" className="staff-roster-primary" disabled={busy} onClick={()=>act(()=>onInclude(selected,effectiveTime,availableFrom))}>Проверить включение в план</button></div> : null}
        {error ? <p className="staff-roster-error" role="alert">{error}</p> : null}
      </div>
      <footer><button type="button" onClick={onClose}>Закрыть</button><button type="button" className="staff-roster-primary" onClick={onAddNew}><Plus size={17}/>Добавить инженера в состав</button></footer>
    </section>
  </div>;
}
