import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Filter } from 'lucide-react';
import { useDropdownPresence } from './useDropdownPresence.js';

const selectedValues = value => Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];

// The same searchable-list filter shell is used in the main and Shift workspaces.
export function WorkspaceFilters({ label = 'Фильтры', title, sections, value, onChange, multiKeys = [] }) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const presence = useDropdownPresence(open, 220);
  const multiKeySet = useMemo(() => new Set(multiKeys), [multiKeys.join('|')]);
  const activeCount = Object.entries(value).reduce((total, [key, current]) => total + (multiKeySet.has(key) ? selectedValues(current).length : current ? 1 : 0), 0);
  const setFilter = (key, next) => onChange(current => {
    if (multiKeySet.has(key)) {
      if (!next) return { ...current, [key]: [] };
      const selected = selectedValues(current[key]);
      return { ...current, [key]: selected.includes(next) ? selected.filter(item => item !== next) : [...selected, next] };
    }
    return { ...current, [key]: String(current[key] || '') === String(next) ? '' : next };
  });
  const reset = () => onChange(Object.fromEntries(sections.map(([key]) => [key, multiKeySet.has(key) ? [] : ''])));
  const positionMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const row = triggerRef.current.closest('.panel-search-row')?.getBoundingClientRect();
    const menuWidth = row?.width ?? rect.width;
    const centerX = row ? row.left + row.width / 2 : rect.left + rect.width / 2;
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const maxHeight = Math.max(280, Math.min(520, spaceBelow));
    setMenuStyle({ top: rect.bottom + 6, left: Math.max(8, Math.min(centerX - menuWidth / 2, window.innerWidth - menuWidth - 8)), width: menuWidth, maxHeight });
  }, []);
  useLayoutEffect(() => { if (open) positionMenu(); }, [open, positionMenu]);
  useEffect(() => {
    if (!open) return undefined;
    const close = event => { if (event.key === 'Escape' || (event.type === 'pointerdown' && !rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target))) setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('resize', positionMenu);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); window.removeEventListener('resize', positionMenu); };
  }, [open, positionMenu]);
  return <section className="engineer-advanced-filters" ref={rootRef} aria-label={title}>
    <button ref={triggerRef} type="button" className={`engineer-filter-trigger ${activeCount ? 'active' : ''}`} onClick={() => setOpen(current => !current)} aria-label={title} title={title} aria-haspopup="dialog" aria-expanded={open}><span><Filter/><b>{label}</b>{activeCount ? <em>{activeCount}</em> : null}</span><ChevronDown/></button>
    {presence.present && menuStyle ? createPortal(<div ref={menuRef} className={`engineer-filter-menu dropdown-transition ${presence.visible ? 'is-open' : 'is-closing'}`} role="dialog" aria-label="Параметры фильтра" style={menuStyle}>
      <div className="engineer-filter-menu-head"><span><Filter/><b>{title}</b></span>{activeCount ? <button type="button" onClick={reset}>Сбросить</button> : null}</div>
      <div className="engineer-filter-menu-scroll">{sections.map(([key, sectionLabel, items]) => { const multiple = multiKeySet.has(key), selected = selectedValues(value[key]); return <section className="engineer-filter-section" key={key}><b>{sectionLabel}{multiple ? <small>Можно выбрать несколько</small> : null}</b><div role="group" aria-label={sectionLabel} aria-multiselectable={multiple || undefined}>{items.map(([id, itemTitle]) => { const checked = id ? selected.includes(id) : selected.length === 0; return <button type="button" role={multiple ? 'checkbox' : 'radio'} aria-checked={checked} className={checked ? 'selected' : ''} key={`${key}-${id || 'all'}`} onClick={() => setFilter(key, id)}><span>{itemTitle}</span>{checked ? <Check/> : null}</button>; })}</div></section>; })}</div>
      <footer><button type="button" onClick={() => setOpen(false)}>Готово</button></footer>
    </div>, document.body) : null}
  </section>;
}
