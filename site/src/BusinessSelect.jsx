import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import './business-select.css';

/**
 * Единый выпадающий список BeeGo с управлением мышью и клавиатурой.
 * @param {{value: string, options: Array<{value: string, label: string, hint?: string, priority?: boolean, disabled?: boolean}>, onChange: (value: string) => void, ariaLabel: string, className?: string, disabled?: boolean}} props
 */
export function BusinessSelect({ value, options, onChange, ariaLabel, className = '', disabled = false, searchable = false }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selected = options[selectedIndex] || options[0];
  const visibleOptions = useMemo(() => options.map((option, index) => ({option,index})).filter(({option,index}) => !searchable || !query.trim() || !index || `${option.label} ${option.hint||''}`.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU'))), [options,query,searchable]);
  const enabledIndexes = useMemo(() => visibleOptions.filter(({option}) => !option.disabled).map(({index})=>index), [visibleOptions]);

  useEffect(() => {
    if (!open) return undefined;
    const close = event => {
      if (event.key === 'Escape' || (event.type === 'pointerdown' && !rootRef.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const show = () => {
    if (disabled) return;
    setQuery('');
    setActiveIndex(options[selectedIndex]?.disabled ? (enabledIndexes[0] ?? 0) : selectedIndex);
    setOpen(true);
  };
  const choose = option => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };
  const move = direction => {
    if (!enabledIndexes.length) return;
    const position = enabledIndexes.indexOf(activeIndex);
    const fallback = direction > 0 ? -1 : 0;
    const next = (position === -1 ? fallback : position) + direction;
    setActiveIndex(enabledIndexes[(next + enabledIndexes.length) % enabledIndexes.length]);
  };
  const onKeyDown = event => {
    if (disabled) return;
    if (event.target instanceof HTMLInputElement && !['ArrowDown','ArrowUp','Escape'].includes(event.key)) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
      else move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) show();
      else choose(options[activeIndex]);
    } else if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveIndex(enabledIndexes[0] ?? 0);
    } else if (event.key === 'End' && open) {
      event.preventDefault();
      setActiveIndex(enabledIndexes.at(-1) ?? 0);
    }
  };

  return <div className={`business-select ${open ? 'open' : ''} ${disabled ? 'disabled' : ''} ${className}`.trim()} ref={rootRef} onKeyDown={onKeyDown}>
    <button type="button" className="business-select-trigger" disabled={disabled} onClick={() => open ? setOpen(false) : show()} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}>
      <span>{selected?.label || 'Выберите значение'}</span><ChevronDown/>
    </button>
    {open ? <div className="business-select-menu" role="listbox" aria-label={ariaLabel}>
      {searchable?<input className="business-select-search" value={query} onChange={event=>{setQuery(event.target.value);setActiveIndex(0)}} placeholder="Найти в списке…" aria-label={`Поиск: ${ariaLabel}`} autoFocus/>:null}
      {visibleOptions.map(({option,index}) => <button type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className={`${option.value === value ? 'selected' : ''} ${index === activeIndex ? 'focused' : ''} ${option.priority ? 'priority' : ''}`.trim()} key={option.value} onPointerMove={() => !option.disabled && setActiveIndex(index)} onClick={() => choose(option)}>
        <span><b>{option.label}</b>{option.hint ? <small>{option.hint}</small> : null}</span>{option.value === value ? <Check/> : null}
      </button>)}
      {!visibleOptions.length?<p className="business-select-empty">Совпадений нет</p>:null}
    </div> : null}
  </div>;
}
