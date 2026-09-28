import { useEffect, useRef, useState } from 'react';
import { Clock3 } from 'lucide-react';
import './time-picker.css';

const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'));
const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'));

export function TimePicker({ label, value = '00:00', onChange, className = '', disabled = false }) {
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const hourListRef = useRef(null);
  const minuteListRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [opensUp, setOpensUp] = useState(false);
  const [hour = '00', minute = '00'] = String(value).split(':');

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = event => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      [hourListRef.current, minuteListRef.current].forEach(list => {
        const selected = list?.querySelector('[aria-pressed="true"]');
        if (selected) list.scrollTop = selected.offsetTop - list.offsetTop - (list.clientHeight - selected.offsetHeight) / 2;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const toggle = () => {
    if (!open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      setOpensUp(Boolean(rect && window.innerHeight - rect.bottom < 290 && rect.top > 290));
    }
    setOpen(current => !current);
  };

  return <div className={`beego-time-field ${className}`} ref={rootRef}>
    <span className="beego-time-label">{label}</span>
    <button ref={triggerRef} type="button" className={`beego-time-trigger${open ? ' is-open' : ''}`} aria-label={`${label}: ${value}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={toggle}>
      <span>{value}</span><Clock3 size={16} aria-hidden="true" />
    </button>
    {open ? <div className={`beego-time-menu${opensUp ? ' opens-up' : ''}`} role="dialog" aria-label={`Выбрать ${label.toLocaleLowerCase('ru-RU')}`}>
      <div className="beego-time-menu-heading"><span>Часы</span><span>Минуты</span></div>
      <div className="beego-time-columns">
        <div ref={hourListRef} className="beego-time-options" role="group" aria-label="Часы">
          {hours.map(option => <button key={option} type="button" aria-pressed={option === hour} onClick={() => onChange?.(`${option}:${minute}`)}>{option}</button>)}
        </div>
        <div ref={minuteListRef} className="beego-time-options" role="group" aria-label="Минуты">
          {minutes.map(option => <button key={option} type="button" aria-pressed={option === minute} onClick={() => { onChange?.(`${hour}:${option}`); setOpen(false); triggerRef.current?.focus(); }}>{option}</button>)}
        </div>
      </div>
    </div> : null}
  </div>;
}
