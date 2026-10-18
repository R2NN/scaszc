import { useId } from 'react';
import { floorPlanAt } from './buildingInterior.js';
import { sectionOutline, sectionPlanPoint } from './buildingGeometry.js';
import { useBuildingDrawing } from './useBuildingDrawing.js';

const points = values => values.map(point => point.map(value => value.toFixed(2)).join(',')).join(' ');
const colors = { apartment: '#f4eee2', office: '#edf0e6', technical: '#dfedf6', storage: '#e8e9ed', lobby: '#f8f9fa', hall: '#f4eee2', corridor: '#f8f9fa', stairs: '#edf0f3', lift: '#dce6ec' };

function PlanSpace({ space, section, scale, model }) {
  const p = point => sectionPlanPoint(section, ...point);
  const xs = space.polygon.map(point => point[0]), zs = space.polygon.map(point => point[1]);
  const x = Math.min(...xs), z = Math.min(...zs), w = Math.max(...xs) - x, d = Math.max(...zs) - z;
  const center = [x + w / 2, z + d / 2], [cx, cy] = p(center);
  const widthPx = Math.min(w, d) * scale;
  const fontSize = 12 / scale;
  const shortNames = { apartment: 'Кв.', office: 'Пом.', technical: 'Тех.', storage: 'Хоз.', lobby: 'Холл', stairs: 'Лестница', lift: 'Лифт', hall: 'Зал', corridor: 'Холл' };
  const candidate = widthPx > 100 ? space.label || shortNames[space.kind] : shortNames[space.kind];
  const label = candidate.length * 6.2 < w * scale - 12 ? candidate : shortNames[space.kind];
  let door = null;
  if (model && ['apartment', 'office', 'technical', 'storage'].includes(space.kind)) {
    const size = Math.min(.95, w * .55, d * .55);
    const side = space.kind === 'apartment' ? center[0] < section.width / 2 ? 'right' : 'left' : 'front';
    const hinge = side === 'front' ? [center[0] - size / 2, z] : [side === 'right' ? x + w : x, center[1] - size / 2];
    const end = side === 'front' ? [hinge[0] + size, z] : [hinge[0], hinge[1] + size];
    const leaf = side === 'front' ? [hinge[0], z + size] : [hinge[0] + (side === 'right' ? -size : size), hinge[1]];
    const bend = side === 'front' ? [end[0], leaf[1]] : [leaf[0], end[1]];
    door = <g className='building-plan-door'><path d={`M ${p(hinge)} L ${p(end)}`} stroke={colors[space.kind]} strokeWidth='5' vectorEffect='non-scaling-stroke'/><path d={`M ${p(end)} Q ${p(bend)} ${p(leaf)} L ${p(hinge)}`} fill='none' stroke='#9ca9b2' strokeWidth='1' vectorEffect='non-scaling-stroke'/></g>;
  }
  return <g data-floor-space={space.id} className={`building-plan-room kind-${space.kind}`}>
    <polygon points={points(space.polygon.map(p))} fill={colors[space.kind]} stroke='#aab5bd' strokeWidth='1.4' vectorEffect='non-scaling-stroke'/>
    {space.kind === 'stairs' ? <g className='building-plan-stairs'>{Array.from({ length: 9 }, (_, index) => <path key={index} d={`M ${p([x, z + d * index / 9])} L ${p([x + w, z + d * index / 9])}`} stroke='#a1adb7' strokeWidth='.9' vectorEffect='non-scaling-stroke'/>)}<path d={`M ${p([x + w * .5, z + d * .82])} L ${p([x + w * .5, z + d * .2])} M ${p([x + w * .35, z + d * .36])} L ${p([x + w * .5, z + d * .2])} L ${p([x + w * .65, z + d * .36])}`} fill='none' stroke='#6e8392' strokeWidth='1.5' vectorEffect='non-scaling-stroke'/></g> : null}
    {space.kind === 'lift' ? <g><path d={`M ${p([x + w * .12, z + d * .12])} L ${p([x + w * .88, z + d * .88])} M ${p([x + w * .88, z + d * .12])} L ${p([x + w * .12, z + d * .88])}`} stroke='#a2b3bf' strokeWidth='1' vectorEffect='non-scaling-stroke'/></g> : null}
    {widthPx > 33 && !['stairs', 'lift'].includes(space.kind) ? <text x={cx} y={cy} style={{ fontSize }} textAnchor='middle' dominantBaseline='middle'>{label}</text> : null}
    {door}<title>{space.label}</title>
  </g>;
}

/** Architectural floor drawing preserves supplied polygons/walls; door symbols are model-only. */
export function BuildingFloorPlan({ model, assets, selectedId, onSelect, floor, sectionId, zoom, attentionIds }) {
  const uid = useId().replace(/:/g, '');
  const sections = model.sections.filter(section => (sectionId === 'all' || section.id === sectionId) && (floor === -1 ? section.basement : section.floors >= floor));
  const outlines = sections.map(sectionOutline), all = outlines.flat();
  const xs = all.map(point => point[0]), zs = all.map(point => point[1]);
  const bounds = all.length ? [Math.min(...xs) - 3, Math.min(...zs) - 3, Math.max(...xs) - Math.min(...xs) + 6, Math.max(...zs) - Math.min(...zs) + 7] : [0, 0, 1, 1];
  const { ref, scale } = useBuildingDrawing(bounds);
  if (!all.length) return <div className='building-load-state'><p>На этом уровне нет помещений выбранной секции.</p></div>;
  const unit = 1 / scale;
  return <svg ref={ref} className='building-floor-plan' style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, minWidth: `${zoom * 100}%`, minHeight: `${zoom * 100}%` }} viewBox={bounds.join(' ')} aria-label={`План этажа: ${floor < 0 ? 'подвал' : floor}`}>
    <defs><filter id={`${uid}-plan-shadow`} x='-10%' y='-10%' width='125%' height='130%'><feDropShadow dx='0' dy='.2' stdDeviation='.25' floodColor='#344c60' floodOpacity='.1'/></filter></defs>
    {sections.map((section, index) => {
      const p = point => sectionPlanPoint(section, ...point), plan = floorPlanAt(section, floor), caption = p([section.width / 2, section.depth + 1.5]);
      return <g key={section.id} className='building-floor-section'>
        <polygon points={points(outlines[index])} className='building-floor-shell' strokeWidth='2.4' vectorEffect='non-scaling-stroke' filter={`url(#${uid}-plan-shadow)`}/>
        {plan.spaces.map(space => <PlanSpace key={space.id} space={space} section={section} scale={scale} model={section.floorPlans.source === 'model'}/>)}
        {plan.walls.map((wall, index) => <polyline key={index} points={points(wall.map(p))} fill='none' stroke='#647783' strokeWidth='3' vectorEffect='non-scaling-stroke'/>)}
        <text x={caption[0]} y={caption[1]} style={{ fontSize: 12 * unit }} className='building-floor-caption' textAnchor='middle'>{section.label}</text>
      </g>;
    })}
    {model.cables.map(cable => {
      const paths = []; let run = [];
      for (const point of cable.points) {
        const section = sections.find(item => item.id === point.sectionId), level = point.floor < 0 ? -1 : Math.floor(point.floor) + 1;
        if (section && level === floor) run.push(sectionPlanPoint(section, point.x, point.z)); else { if (run.length > 1) paths.push(run); run = []; }
      }
      if (run.length > 1) paths.push(run);
      return paths.map((path, index) => <polyline key={`${cable.id}-${index}`} className='building-plan-cable' points={points(path)} fill='none' stroke='#168ed0' strokeWidth='2.3' vectorEffect='non-scaling-stroke'><title>{cable.label}</title></polyline>);
    })}
    {assets.filter(asset => asset.floor === floor && sections.some(section => section.id === asset.sectionId)).map(asset => {
      const section = sections.find(item => item.id === asset.sectionId), [x, y] = sectionPlanPoint(section, section.width * asset.x, section.depth * asset.z), selected = asset.id === selectedId;
      const width = 15 * unit, height = 20 * unit;
      return <g key={asset.id} className={`building-floor-asset ${selected ? 'selected' : ''} ${attentionIds.has(asset.id) ? 'has-problem' : ''}`} transform={`translate(${x},${y})`} role='button' tabIndex='0' aria-label={`На плане: ${asset.label}, ${asset.location}`} aria-pressed={selected} onClick={() => onSelect(asset.id)} onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect(asset.id); } }}>
        <rect className='building-plan-asset-hit' x={-20 * unit} y={-23 * unit} width={40 * unit} height={46 * unit} rx={8 * unit}/>
        {selected ? <rect className='building-plan-asset-selection' x={-width / 2 - 5 * unit} y={-height / 2 - 5 * unit} width={width + 10 * unit} height={height + 10 * unit} rx={6 * unit} strokeWidth='2' vectorEffect='non-scaling-stroke'/> : null}
        <rect className='building-plan-cabinet' x={-width / 2} y={-height / 2} width={width} height={height} rx={2 * unit} strokeWidth='1.4' vectorEffect='non-scaling-stroke'/>
        <path d={`M ${-width / 2 + 3 * unit} ${-height / 2 + 4 * unit} h ${width - 6 * unit} M ${-width / 2 + 3 * unit} ${-height / 2 + 7 * unit} h ${width - 6 * unit}`} stroke='#6d93ac' strokeWidth='1' vectorEffect='non-scaling-stroke'/>
        {attentionIds.has(asset.id) ? <circle cx={width / 2 + 3 * unit} cy={-height / 2} r={4 * unit} fill='#e65b50' stroke='#fff' strokeWidth='1.5' vectorEffect='non-scaling-stroke'/> : null}
        <title>{asset.label} · {asset.location}</title>
      </g>;
    })}
  </svg>;
}
