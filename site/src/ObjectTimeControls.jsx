import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Clock3, DoorOpen, Flame, Route } from 'lucide-react';
import { OBJECT_TIME_LEGEND } from './objectPresentation.js';

/** One map-mode toolbar; heat measures belong to the heat button, never the basemap menu. */
export function ObjectTimeControls({ enabled, view, onChange, onRoutes }) {
  const [heatOpen, setHeatOpen] = useState(false);
  const [measure, setMeasure] = useState(view === 'access' ? 'access' : 'heat');
  const rootRef = useRef(null), heatButtonRef = useRef(null);
  useEffect(() => {
    if (!heatOpen) return;
    const close = event => {
      if (event.key === 'Escape') { setHeatOpen(false); heatButtonRef.current?.focus(); }
      else if (event.type === 'pointerdown' && !rootRef.current?.contains(event.target)) setHeatOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, [heatOpen]);
  const choose = value => { setMeasure(value); onChange(value); setHeatOpen(false); heatButtonRef.current?.focus(); };
  return <div ref={rootRef} className='cx-mode-switch' role='group' aria-label='Режим основной карты'>
    <button type='button' aria-label='Заявки и маршруты' data-tooltip='Заявки и маршруты' aria-pressed={!enabled} onClick={() => { setHeatOpen(false); onRoutes(); }}><Route size={21}/></button>
    <button type='button' aria-label='Метки времени' data-tooltip='Метки времени' aria-pressed={enabled && view === 'markers'} onClick={() => { setHeatOpen(false); onChange('markers'); }}><Clock3 size={21}/></button>
    <button ref={heatButtonRef} type='button' aria-label='Тепловая карта' data-tooltip='Тепловая карта' aria-pressed={enabled && view !== 'markers'} aria-expanded={heatOpen} aria-controls='cx-heat-options' onClick={() => { onChange(measure); setHeatOpen(open => !open); }}><Flame size={21}/><ChevronDown className='cx-heat-chevron' size={11}/></button>
    {heatOpen ? <section id='cx-heat-options' className='cx-heat-popover' aria-label='Показатель тепловой карты'><b>Тепловая карта</b>{[['heat', 'Время визита', Clock3], ['access', 'Задержки доступа', DoorOpen]].map(([value, label, Icon]) => <button key={value} type='button' aria-pressed={measure === value} onClick={() => choose(value)}><Icon size={18}/><span>{label}</span>{measure === value ? <Check size={17}/> : null}</button>)}</section> : null}
  </div>;
}

/** Display an operational legend in the existing map legend popover. */
export function ObjectTimeLegend({ view, count }) {
  return <section className='cx-layer-legend' aria-label='Легенда времени на объектах'><h3>{view === 'markers' ? 'Время на объектах' : view === 'access' ? 'Задержки доступа' : 'Длительность визитов'}</h3>
    {view === 'markers' ? <><div className='cx-color-key'>{OBJECT_TIME_LEGEND.map(item => <span key={item.key}><i style={{ background: item.color }}/>{item.label}</span>)}</div><p>Время в минутах · в скобках — отличие от норматива</p><p>↑ в группе — объекты с увеличенным временем</p></> : <><div className='cx-heat-ramp'/><div className='cx-ramp-labels'><span>Меньше</span><span>Больше</span></div><p>{view === 'access' ? 'Подтверждённые минуты доступа и плотность адресов' : 'Длительность визитов и плотность объектов'}</p><b>Объектов в слое: {count}</b></>}
  </section>;
}
