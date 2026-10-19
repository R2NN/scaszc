import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { TimePicker } from './TimePicker.jsx';
import './date-time-picker.css';

const months=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const keyOf=date=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const parse=value=>value?new Date(`${value.slice(0,10)}T12:00:00`):new Date();

/** BeeGo calendar and time controls with a popup positioned outside scrolling panels. */
export function DateTimePicker({label,value,onChange,disabled=false}) {
  const [open,setOpen]=useState(false),[month,setMonth]=useState(()=>parse(value));
  const [position,setPosition]=useState(null),trigger=useRef(null),popup=useRef(null);
  useEffect(()=>{
    if(!open)return;
    const close=event=>{if(event.key==='Escape'||event.type==='pointerdown'&&!trigger.current?.contains(event.target)&&!popup.current?.contains(event.target)){setOpen(false);if(event.key==='Escape')trigger.current?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close);};
  },[open]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{const rect=trigger.current.getBoundingClientRect(),width=Math.min(320,window.innerWidth-24),height=410;setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),top:Math.max(12,Math.min(rect.bottom+8,window.innerHeight-height-12)),width});};
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  const selected=value?.slice(0,10),time=value?.slice(11,16)||'09:30';
  const first=new Date(month.getFullYear(),month.getMonth(),1),offset=(first.getDay()+6)%7;
  const days=Array.from({length:42},(_,index)=>new Date(first.getFullYear(),first.getMonth(),index+1-offset));
  const change=(date,clock=time)=>onChange(`${date}T${clock}:00+03:00`);
  return <div className='beego-datetime-field'><span>{label}</span><button ref={trigger} type='button' className='beego-datetime-trigger' disabled={disabled} aria-label={label} aria-haspopup='dialog' aria-expanded={open} onClick={()=>{if(!open)setMonth(parse(value));setOpen(current=>!current);}}><span>{value?`${selected.split('-').reverse().join('.')} · ${time}`:'Не указано'}</span><CalendarDays size={17}/></button>
    {open&&position?createPortal(<section ref={popup} className={`date-popover beego-datetime-popup${trigger.current?.closest('.dark')?' dark':''}`} role='dialog' aria-label={`Выбор: ${label.toLocaleLowerCase('ru-RU')}`} style={position}>
      <div className='calendar-head'><button type='button' aria-label='Предыдущий месяц' onClick={()=>setMonth(new Date(first.getFullYear(),first.getMonth()-1,1))}><ChevronLeft/></button><strong>{months[first.getMonth()]} {first.getFullYear()}</strong><button type='button' aria-label='Следующий месяц' onClick={()=>setMonth(new Date(first.getFullYear(),first.getMonth()+1,1))}><ChevronRight/></button></div>
      <div className='weekday-row'>{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day=><span key={day}>{day}</span>)}</div>
      <div className='calendar-grid'>{days.map(date=><button key={keyOf(date)} type='button' aria-label={date.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'})} aria-pressed={keyOf(date)===selected} className={`${date.getMonth()!==first.getMonth()?'outside ':''}${keyOf(date)===selected?'selected':''}`} onClick={()=>change(keyOf(date))}>{date.getDate()}</button>)}</div>
      <div className='beego-datetime-footer'><TimePicker label='Время' value={time} onChange={clock=>change(selected,clock)}/><button type='button' className='beego-datetime-done' onClick={()=>{setOpen(false);trigger.current?.focus();}}><Check size={16}/>Готово</button></div>
    </section>,document.body):null}
  </div>;
}
