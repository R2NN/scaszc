import { useState } from 'react';
import { Expand, MousePointer2 } from 'lucide-react';
import { sectionOutline } from './buildingGeometry.js';
import { useBuildingDrawing } from './useBuildingDrawing.js';

const points = values => values.map(point => point.join(',')).join(' ');

/** Building overview with independent problem fill and current-section outline. */
export function BuildingNavigator({ model, sectionId, currentSectionId, sectionConditions, onSection }) {
  const [hovered, setHovered] = useState('');
  const polygons = model.sections.map(sectionOutline), all = [...model.footprint, ...polygons.flat()];
  const xs = all.map(point => point[0]), zs = all.map(point => point[1]);
  const bounds = [Math.min(...xs) - 5, Math.min(...zs) - 5, Math.max(...xs) - Math.min(...xs) + 10, Math.max(...zs) - Math.min(...zs) + 10];
  const { ref, scale } = useBuildingDrawing(bounds);
  const focused = model.sections.find(section => section.id === (hovered || currentSectionId));
  return <div className='building-navigator'>
    <div className='building-navigator-heading'><div><strong>Форма здания</strong><span><MousePointer2 size={12}/>Нажмите на секцию</span></div><button type='button' onClick={() => onSection('all')} aria-label='Показать все секции' title='Показать все секции' aria-pressed={sectionId === 'all'}><Expand size={16}/></button></div>
    <svg ref={ref} viewBox={bounds.join(' ')} aria-label='Навигация по секциям здания'>
      {model.footprint.length ? <polygon className='building-navigator-outline' points={points(model.footprint)}/> : null}
      {model.sections.map((section, index) => {
        const polygon = polygons[index], problems = sectionConditions.get(section.id) || [], selected = currentSectionId === section.id;
        const center = polygon.reduce(([x, z], point) => [x + point[0] / polygon.length, z + point[1] / polygon.length], [0, 0]);
        const width = Math.max(...polygon.map(point => point[0])) - Math.min(...polygon.map(point => point[0]));
        const depth = Math.max(...polygon.map(point => point[1])) - Math.min(...polygon.map(point => point[1]));
        return <g key={section.id} className={`building-navigator-section ${problems.length ? 'has-problem' : ''} ${selected ? 'is-current' : ''}`} data-nav-section={section.id} data-problem-count={problems.length} role='button' tabIndex='0' aria-label={`На плане: ${section.label}${problems.length ? ', требует внимания' : ''}`} aria-pressed={selected} onClick={() => onSection(section.id)} onMouseEnter={() => setHovered(section.id)} onMouseLeave={() => setHovered('')} onFocus={() => setHovered(section.id)} onBlur={() => setHovered('')} onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); onSection(section.id); } }}>
          <polygon className='building-navigator-fill' points={points(polygon)}/>
          <polygon className='building-navigator-ring' points={points(polygon)}/>
          {width * scale > 24 && depth * scale > 22 ? <text x={center[0]} y={center[1]} fontSize={12 / scale} textAnchor='middle' dominantBaseline='middle'>{index + 1}</text> : null}
          <title>{section.label} · {section.floors} эт.{problems.length ? ` · ${problems.map(problem => problem.finding || 'Особенность обслуживания').join('; ')}` : ''}</title>
        </g>;
      })}
    </svg>
    <div className='building-navigator-current'><strong>{focused?.label || 'Все секции'}</strong><span>{focused ? `${focused.floors} этажей` : `${model.sections.length} секций`}</span></div>
    <div className='building-navigator-key'><span><i className='current'/>Вы смотрите</span><span><i className='problem'/>Требует внимания{sectionConditions.size ? ` · ${sectionConditions.size}` : ''}</span></div>
  </div>;
}
