import { Clock3, Flame, List, Maximize2 } from 'lucide-react';
import { OBJECT_TIME_LEGEND } from './objectPresentation.js';

/** Keep map display choices beside the existing basemap picker, away from address filters. */
export function ObjectTimeControls({ enabled, view, onChange, onRoutes, count, onFit }) {
  return <section className='cx-layer-controls' aria-label='Слои основной карты'>
    <h4>Что показать</h4>
    <div className='cx-layer-choices' role='group' aria-label='Слой основной карты'>
      <button type='button' aria-pressed={!enabled} onClick={onRoutes}><List size={20}/><span>Заявки и маршруты</span></button>
      <button type='button' aria-pressed={enabled && view === 'markers'} onClick={() => onChange('markers')}><Clock3 size={20}/><span>Метки времени</span></button>
      <button type='button' aria-pressed={enabled && view !== 'markers'} onClick={() => onChange(view === 'access' ? 'access' : 'heat')}><Flame size={20}/><span>Тепловая карта</span></button>
    </div>
    {enabled && view !== 'markers' ? <div className='cx-heat-measures' role='group' aria-label='Показатель тепловой карты'><button type='button' aria-pressed={view === 'heat'} onClick={() => onChange('heat')}>Время визита</button><button type='button' aria-pressed={view === 'access'} onClick={() => onChange('access')}>Задержки доступа</button></div> : null}
    {enabled ? <div className='cx-layer-extent'><span>Объектов в слое <b>{count}</b></span><button type='button' disabled={!count} onClick={onFit}><Maximize2 size={17}/>Показать весь слой</button></div> : null}
  </section>;
}

/** Display an operational legend in the existing map legend popover. */
export function ObjectTimeLegend({ view, count }) {
  return <section className='cx-layer-legend' aria-label='Легенда времени на объектах'><h3>{view === 'markers' ? 'Время на объектах' : view === 'access' ? 'Задержки доступа' : 'Длительность визитов'}</h3>
    {view === 'markers' ? <><div className='cx-color-key'>{OBJECT_TIME_LEGEND.map(item => <span key={item.key}><i style={{ background: item.color }}/>{item.label}</span>)}</div><p>Время в минутах · в скобках — отличие от норматива</p><p>↑ в группе — объекты с увеличенным временем</p></> : <><div className='cx-heat-ramp'/><div className='cx-ramp-labels'><span>Меньше</span><span>Больше</span></div><p>{view === 'access' ? 'Подтверждённые минуты доступа и плотность адресов' : 'Длительность визитов и плотность объектов'}</p><b>Объектов в слое: {count}</b></>}
  </section>;
}
