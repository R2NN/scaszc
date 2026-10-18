import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Building2, Cable, ChevronRight, CircleHelp, Expand, FileText, Layers3, LoaderCircle, Minus, Plus, Save, Settings2, Upload, Wrench, X } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { buildingAssets, buildingScene, linkedBuildingOrders, validateBuildingModel } from './buildingModel.js';
import { floorPlanAt, syntheticFloorPlans } from './buildingInterior.js';
import { BuildingFloorPlan } from './BuildingFloorPlan.jsx';
import { BuildingNavigator } from './BuildingNavigator.jsx';
import { buildingAttention } from './buildingAttention.js';
import { buildingCustomers } from './buildingCustomers.js';
import { BuildingCustomerMarkers } from './BuildingCustomerMarkers.jsx';
import { BuildingCustomerPanel } from './BuildingCustomerPanel.jsx';
import { BuildingCustomerEditor } from './BuildingCustomerEditor.jsx';
import { useBuildingPan } from './useBuildingPan.js';
import { useBuildingDrawing } from './useBuildingDrawing.js';
import './building.css';

const points = values => values.map(point => point.map(value => value.toFixed(2)).join(',')).join(' ');
const timestamp = at => new Date(at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
const kindLabels = { apartments: 'Жилой дом', house: 'Частный дом', office: 'Офисное здание', industrial: 'Производственный корпус', public: 'Общественное здание', other: 'Другое здание' };
const isActive = (condition, at) => Date.parse(condition.knownAt) <= Date.parse(at) && (!condition.closedAt || Date.parse(condition.closedAt) > Date.parse(at)) && (!condition.validUntil || Date.parse(condition.validUntil) > Date.parse(at));
const buildingDrafts = new Map();

function downloadModel(model) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `building-${model.objectId}.json`; link.click(); URL.revokeObjectURL(url);
}

function FloorInterior({ section, floor, project }) {
  const plan = floorPlanAt(section, floor < 0 ? -1 : floor + 1);
  const p = (x, level, z) => project(section.x + x, level, section.z + z);
  const polygon = (outline, level) => points(outline.map(([x, z]) => p(x, level, z)));
  return <g className='building-floor-interior'>
    {plan.spaces.map(space => {
      const xs = space.polygon.map(point => point[0]), zs = space.polygon.map(point => point[1]);
      const x = Math.min(...xs), z = Math.min(...zs), width = Math.max(...xs) - x, depth = Math.max(...zs) - z;
      if (space.kind === 'stairs') return <g key={space.id} className='building-stairs'>
        <polygon points={points([p(x, floor + .05, z), p(x + width, floor + .05, z), p(x + width, floor + .91, z + depth), p(x, floor + .91, z + depth)])} fill='#d6d9da' stroke='#afb8bf' strokeWidth='.6'/>
        {Array.from({ length: 9 }, (_, index) => <path key={index} d={`M ${p(x, floor + .05 + index * .095, z + depth * index / 9)} L ${p(x + width, floor + .05 + index * .095, z + depth * index / 9)}`} stroke='#9ca8b1' strokeWidth='.8'/>)}
        <path d={`M ${p(x, floor + .25, z)} L ${p(x, floor + 1.1, z + depth)}`} stroke='#84949e' strokeWidth='.9'/>
      </g>;
      if (space.kind === 'lift') return <g key={space.id} className='building-lift'><polygon points={points([p(x, floor, z), p(x + width, floor, z), p(x + width, floor + .85, z), p(x, floor + .85, z)])} fill='#aebec9' stroke='#7f939f' strokeWidth='.6'/><path d={`M ${p(x + width / 2, floor, z)} L ${p(x + width / 2, floor + .85, z)}`} stroke='#eff5f7' strokeWidth='1.1'/><title>{space.label}</title></g>;
      const flat = ['corridor', 'hall', 'lobby'].includes(space.kind);
      return <g key={space.id} data-space-kind={space.kind}><polygon points={polygon(space.polygon, floor + .015)} fill={space.kind === 'technical' ? '#d8e5eb' : flat ? '#e8eef2' : '#e4ded3'} opacity={flat ? '.65' : '.38'}/>{!flat && section.floorPlans.source === 'model' ? <>
        {space.polygon.map((point, index) => {
          const next = space.polygon[(index + 1) % space.polygon.length];
          if ((point[1] + next[1]) / 2 < z + depth * .6) return null;
          return <polygon key={index} points={points([p(point[0], floor, point[1]), p(next[0], floor, next[1]), p(next[0], floor + .88, next[1]), p(point[0], floor + .88, point[1])])} fill='#dedbd4' stroke='#c4c3bd' strokeWidth='.45' opacity='.9'/>;
        })}
        {[ [x, x + width * .35, 0, .88], [x + width * .65, x + width, 0, .88], [x + width * .35, x + width * .65, .73, .88] ].map(([left, right, bottom, top], index) => <polygon key={`jamb-${index}`} points={points([p(left, floor + bottom, z), p(right, floor + bottom, z), p(right, floor + top, z), p(left, floor + top, z)])} fill='#e5e1d8' stroke='#c5c5be' strokeWidth='.4'/>)}
        <polygon points={points([p(x + width * .35, floor, z), p(x + width * .65, floor, z), p(x + width * .65, floor + .73, z), p(x + width * .35, floor + .73, z)])} fill={space.kind === 'technical' ? '#9eafbc' : '#c2b59f'} stroke='#a2a5a2' strokeWidth='.65'/>
      </> : null}<title>{space.label}</title></g>;
    })}
    {plan.walls.flatMap((wall, index) => wall.slice(1).map((point, segment) => <polygon key={`${index}-${segment}`} className='building-survey-wall' points={points([p(wall[segment][0], floor, wall[segment][1]), p(point[0], floor, point[1]), p(point[0], floor + .9, point[1]), p(wall[segment][0], floor + .9, wall[segment][1])])} fill='#d4d7d7' stroke='#aab1b5' strokeWidth='.7' opacity='.72'/>))}
  </g>;
}

/** Procedural cutaway. All floors, sections and equipment positions come from the model. */
export function BuildingCutaway({ model, assets, selectedId, onSelect, sectionId, attentionIds, requestCounts = new Map(), zoom = 1, customers = [], selectedCustomerId, onCustomer }) {
  const uid = useId().replace(/:/g, '');
  const scene = useMemo(() => buildingScene(model, sectionId), [model, sectionId]);
  const { ref: drawingRef, scale: drawingScale } = useBuildingDrawing(scene.viewBox);
  const { project: p, sections, viewBox } = scene;
    const paint = name => `url(#${uid}-${name})`;
  const visibleAssets = assets.filter(asset => sections.some(section => section.id === asset.sectionId));
  const maxFloors = Math.max(...sections.map(section => section.floors));
  const labelStep = Math.max(1, Math.ceil(maxFloors / 13));
  const floorLabelSection = sections[0];
  const selectedAsset = visibleAssets.find(asset => asset.id === selectedId);
  let selectionLabel = null;
  if (selectedAsset) {
    const section = sections.find(item => item.id === selectedAsset.sectionId);
    const [x, y] = p(section.x + section.width * selectedAsset.x, selectedAsset.floor < 0 ? -.6 : selectedAsset.floor - .45, section.z + section.depth * selectedAsset.z, section);
    const name = selectedAsset.schematic ? 'Этажная коробка' : selectedAsset.label;
    const caption = name.length > 28 ? `${name.slice(0, 27)}…` : name;
    const width = Math.min(caption.length * 6.5 + 20, viewBox[2] - 16);
    selectionLabel = { caption, width, x: Math.max(viewBox[0] + 8, Math.min(x + 17, viewBox[0] + viewBox[2] - width - 8)), y: Math.max(viewBox[1] + 8, y - (selectedAsset.schematic ? 17 : 27) - 34) };
  }
  return <svg ref={drawingRef} className='building-cutaway' viewBox={viewBox.join(' ')} style={{ width: `${zoom * 100}%`, minWidth: `${zoom * 100}%`, height: `${zoom * 100}%`, minHeight: `${zoom * 100}%` }} role='group' aria-label={`Схема здания: ${sections.length} секций, до ${maxFloors} этажей`}>
    <defs>
      <linearGradient id={`${uid}-back`} x2='0' y2='1'><stop stopColor='#e9e6df'/><stop offset='1' stopColor='#f5f3ef'/></linearGradient>
      <linearGradient id={`${uid}-slab`} x2='.2' y2='1'><stop stopColor='#fdfcfb'/><stop offset='1' stopColor='#d9dadd'/></linearGradient>
      <linearGradient id={`${uid}-side`} x2='1' y2='.1'><stop stopColor='#c8cbd0'/><stop offset='1' stopColor='#e7e8eb'/></linearGradient>
      <linearGradient id={`${uid}-cabinet`} x2='1' y2='.4'><stop stopColor='#eff6fb'/><stop offset='.5' stopColor='#b9cbd8'/><stop offset='1' stopColor='#e1eaf0'/></linearGradient>
      <linearGradient id={`${uid}-glass`} x2='1' y2='1'><stop stopColor='#b5d0e3'/><stop offset='.5' stopColor='#e1edf3'/><stop offset='1' stopColor='#839fb3'/></linearGradient>
      <filter id={`${uid}-shadow`} x='-25%' y='-25%' width='160%' height='170%'><feDropShadow dx='0' dy='6' stdDeviation='5' floodColor='#243b4b' floodOpacity='.13'/></filter>
      <filter id={`${uid}-selected`} x='-70%' y='-60%' width='250%' height='250%'><feDropShadow dx='0' dy='0' stdDeviation='5' floodColor='#ffd21f' floodOpacity='.55'/></filter>
    </defs>
    <g className='building-architecture' filter={paint('shadow')}>
      {sections.slice().sort((a, b) => b.z - a.z || a.x - b.x).map(section => {
        const { x, z, width: w, depth: d, floors: h } = section;
        const p = (px, floor, pz) => scene.project(px, floor, pz, section);
        const shape = coordinates => points(coordinates.map(([px, floor, pz]) => p(px, floor, pz)));
        const base = section.basement ? -1 : 0;
        return <g key={section.id} data-building-section={section.id}>
          {section.outline.map((point, index) => { const next = section.outline[(index + 1) % section.outline.length]; if (point[1] + next[1] < d * 1.1 && Math.abs(point[0] - next[0]) > .1) return null; return <polygon key={index} className='building-side-wall' points={shape([[x + point[0], base, z + point[1]], [x + next[0], base, z + next[1]], [x + next[0], h, z + next[1]], [x + point[0], h, z + point[1]]])} fill={paint(Math.abs(point[1] - next[1]) < .1 ? 'back' : 'side')}/>; })}
          {Array.from({ length: h - base }, (_, index) => base + index).map(floor => {
            return <g key={floor} className={floor < 0 ? 'building-basement' : ''}>
              <polygon points={shape(section.outline.map(([dx, dz]) => [x + dx, floor, z + dz]))} fill={paint('slab')} stroke='#bfc4cb' strokeWidth='.6'/>
              <polygon points={shape([[x, floor, z], [x + w, floor, z], [x + w, floor - .065, z], [x, floor - .065, z]])} fill='#c7cbd0'/>
              <FloorInterior section={section} floor={floor} project={p}/>
              {floor >= 0 && section === sections[0] && section.floorPlans.source === 'model' ? [.18, .62].map(offset => <polygon key={offset} points={shape([[x - .02, floor + .2, z + d * offset], [x - .02, floor + .2, z + d * (offset + .23)], [x - .02, floor + .76, z + d * (offset + .23)], [x - .02, floor + .76, z + d * offset]])} fill={paint('glass')} stroke='#94a6b1' strokeWidth='.75'/>) : null}

            </g>;
          })}
          <polygon className='building-roof' points={shape(section.outline.map(([dx, dz]) => [x + dx, h, z + dz]))} fill={paint('slab')} stroke='#bfc4cb' strokeWidth='.85'/>
          {section.roof !== 'flat' ? <><polygon className='building-pitched-roof' points={shape([[x, h, z], [x + w, h, z], [x + w * (section.roof === 'hip' ? .8 : 1), h + .7, z + d / 2], [x + w * (section.roof === 'hip' ? .2 : 0), h + .7, z + d / 2]])} fill='#aeb9c5' stroke='#8f9eac'/><polygon points={shape([[x + w, h, z], [x + w, h, z + d], [x + w * (section.roof === 'hip' ? .8 : 1), h + .7, z + d / 2]])} fill='#c5cdd5'/></> : <polygon points={shape([[x + w * .15, h, z + d * .35], [x + w * .34, h, z + d * .35], [x + w * .34, h + .28, z + d * .35], [x + w * .15, h + .28, z + d * .35]])} fill='#d4d6d9' stroke='#b6bcc3'/>}
        </g>;
      })}
    </g>
    <g className='building-floor-labels'>{Array.from({ length: floorLabelSection.floors }, (_, i) => i + 1).filter(floor => floor === 1 || floor === floorLabelSection.floors || floor % labelStep === 0).map(floor => { const [x, y] = p(floorLabelSection.x, floor - .35, floorLabelSection.z, floorLabelSection); return <text key={floor} x={x - 12} y={y} textAnchor='end'>{floor} этаж</text>; })}{floorLabelSection.basement ? <text x={p(floorLabelSection.x, 0, floorLabelSection.z, floorLabelSection)[0] - 12} y={p(floorLabelSection.x, -.65, floorLabelSection.z, floorLabelSection)[1]} textAnchor='end'>Подвал</text> : null}</g>
    <g className='building-cables'>{sections.flatMap(section => section.risers.map(riser => {
      const p = (x, floor, z) => scene.project(x, floor, z, section);
      const x = section.x + section.width * riser.x, z = section.z + section.depth * riser.z;
      const start = riser.fromFloor < 0 ? -.7 : riser.fromFloor - .6, end = riser.toFloor - .2;
      const feed = section.interior.feed === 'attic' ? end : start;
      const path = `M ${p(x, start, z)} L ${p(x, end, z)} M ${p(section.x + section.width * .08, feed, z)} L ${p(x, feed, z)}`;
      return <g key={`${section.id}/${riser.id}`} data-building-riser={riser.id}><path d={path} stroke='#fff' strokeWidth='5.5' fill='none'/><path d={path} stroke='#168ed0' strokeWidth='2.7' fill='none'/></g>;
    }))}{model.cables.map(cable => {
      const route = cable.points.filter(point => sections.some(section => section.id === point.sectionId)).map(point => { const section = sections.find(item => item.id === point.sectionId); return scene.project(section.x + point.x, point.floor, section.z + point.z, section); });
      return route.length > 1 ? <g key={cable.id} className='building-cable-trace'><polyline points={points(route)} fill='none' stroke='#fff' strokeWidth='5.5'/><polyline points={points(route)} fill='none' stroke='#168ed0' strokeWidth='2.7'/><title>{cable.label}</title></g> : null;
    })}</g>
    <g>{visibleAssets.map(asset => {
      const section = sections.find(item => item.id === asset.sectionId);
      const [x, y] = p(section.x + section.width * asset.x, asset.floor < 0 ? -.6 : asset.floor - .45, section.z + section.depth * asset.z, section);
      const selected = asset.id === selectedId, attention = attentionIds.has(asset.id);
      const w = asset.schematic ? 10 : 16, h = asset.schematic ? 17 : 27;
      return <g key={asset.id} className={`building-asset ${selected ? 'is-selected' : ''} ${asset.schematic ? 'is-schematic' : ''}`} transform={`translate(${x},${y})`} role='button' tabIndex='0' aria-label={`${asset.label}, ${asset.location}${asset.schematic ? ', модельная точка' : ''}`} aria-pressed={selected} onClick={() => onSelect(asset.id)} onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect(asset.id); } }}>
        <title>{`${asset.label} · ${asset.location}${asset.schematic ? ' · модельная точка стояка' : ''}`}</title>
        <rect className='building-asset-hit' x='-16' y={-h - 8} width='40' height={h + 18} fill='transparent'/>
        {selected ? <rect x='-7' y={-h - 6} width={w + 14} height={h + 12} rx='5' fill='#ffd21f22' stroke='#f2bb00' strokeWidth='2.5' filter={paint('selected')}/> : null}
        <path d={`M ${w} 0 l 5 -3 v -${h} l -5 3 z`} fill='#8aa4b7' stroke='#6e8da4' strokeWidth='.75'/>
        <rect x='0' y={-h} width={w} height={h} rx='1' fill={paint('cabinet')} stroke={selected ? '#a87900' : '#6b8fa8'} strokeWidth='1'/>
        <path d={`M 3 ${-h + 3} v ${h - 6} M 5 ${-h + 5} h ${w - 7} M 5 ${-h + 8} h ${w - 7}`} stroke='#6b8fa8' strokeWidth='.7' opacity='.8'/>
        <circle cx={w - 3} cy={-h / 2} r='1' fill='#607b8d'/>
        {attention ? <g transform={`translate(${w + 5},${-h})`}><circle r='8' fill='#e88321' stroke='#fff' strokeWidth='2'/><text y='3' textAnchor='middle' fill='#fff' fontSize='10' fontWeight='800'>!</text></g> : null}
        {requestCounts.get(asset.id) ? <g transform={`translate(${w + 9},${attention ? -h + 20 : -h + 4})`}><circle r='8' fill='#1389c8' stroke='#fff' strokeWidth='1.5'/><text y='3' textAnchor='middle' fill='#fff' fontSize='9' fontWeight='750'>{requestCounts.get(asset.id)}</text></g> : null}
      </g>;
    })}</g>
    <BuildingCustomerMarkers customers={customers} selectedOrderId={selectedCustomerId} onSelect={onCustomer} scene={scene} sectionId={sectionId} scale={drawingScale}/>
    <g className='building-section-labels' pointerEvents='none'>{sections.map(section => {
      const label = p(section.x + section.width / 2, section.floors + .8, section.z + section.depth / 2, section);
      return <g key={section.id} transform={`translate(${label[0]},${label[1]})`} className='building-section-label'><rect x={-Math.max(40, section.label.length * 3.6)} y='-16' width={Math.max(80, section.label.length * 7.2)} height='27' rx='6'/><text textAnchor='middle' y='2'>{section.label}</text></g>;
    })}</g>
    {selectionLabel ? <g className='building-selected-label' transform={`translate(${selectionLabel.x},${selectionLabel.y})`} pointerEvents='none' aria-hidden='true'><rect width={selectionLabel.width} height='26' rx='5'/><text x='10' y='17'>{selectionLabel.caption}</text></g> : null}
  </svg>;
}

function BuildingEditor({ model, revision, actor, entities, orders, onSaved, onClose, onPreview }) {
  const draftKey = `${model.objectId}/${revision}`;
  const [draft, setDraft] = useState(() => buildingDrafts.get(draftKey)?.model || structuredClone(model));
  const [reason, setReason] = useState(() => buildingDrafts.get(draftKey)?.reason || ''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { buildingDrafts.set(draftKey, { model: draft, reason }); if (buildingDrafts.size > 30) buildingDrafts.delete(buildingDrafts.keys().next().value); }, [draft, reason, draftKey]);
  useEffect(() => { try { onPreview(validateBuildingModel(draft, model.objectId, entities)); } catch { onPreview(null); } }, [draft, model.objectId, entities, onPreview]);
  const inputRef = useRef(null);
  const setSection = (id, key, value) => setDraft(current => ({ ...current, sections: current.sections.map(section => {
    if (section.id !== id) return section;
    const next = key.startsWith('interior.') ? { ...section, interior: { ...section.interior, [key.slice(9)]: value } } : { ...section, [key]: value };
    if (key === 'floors' || key === 'basement') {
      next.risers = section.risers.map(riser => ({ ...riser, fromFloor: !next.basement && riser.fromFloor < 0 ? 1 : Math.min(riser.fromFloor, next.floors), toFloor: riser.toFloor === section.floors ? next.floors : Math.min(riser.toFloor, next.floors), boxFloors: riser.source === 'model' ? Array.from({ length: Math.min(180, Math.max(0, next.floors)) }, (_, index) => index + 1).filter(floor => (floor - 1) % next.interior.boxEvery === 0) : riser.boxFloors.filter(floor => floor <= next.floors && (next.basement || floor > 0)) }));
      next.floorPlans = { ...section.floorPlans, overrides: section.floorPlans.overrides.filter(plan => plan.floor <= next.floors && (next.basement || plan.floor > 0)) };
      next.technicalFloors = section.technicalFloors.filter(floor => floor <= next.floors && (next.basement || floor > 0));
    }
    if (key === 'width' || key === 'depth') {
      const scalePoint = ([x, z]) => [key === 'width' ? x * value / section.width : x, key === 'depth' ? z * value / section.depth : z];
      const scalePlan = plan => ({ ...plan, spaces: plan.spaces.map(space => ({ ...space, polygon: space.polygon.map(scalePoint) })), walls: plan.walls.map(wall => wall.map(scalePoint)) });
      next.outline = section.outline.map(scalePoint);
      next.floorPlans = { ...section.floorPlans, typical: scalePlan(section.floorPlans.typical), overrides: section.floorPlans.overrides.map(scalePlan) };
    }
    if (key.startsWith('interior.')) {
      next.floorPlans = syntheticFloorPlans(next);
      if (key === 'interior.boxEvery') next.risers = section.risers.map(riser => ({ ...riser, boxFloors: Array.from({ length: section.floors }, (_, index) => index + 1).filter(floor => (floor - 1) % value === 0) }));
    }
    return next;
  }), placements: current.placements.map(placement => {
    if (placement.sectionId !== id) return placement;
    if (key === 'floors' && placement.floor > Number(value)) return { ...placement, floor: Number(value) };
    if (key === 'basement' && !value && placement.floor === -1) return { ...placement, floor: 1 };
    return placement;
  }) }));
  const changeCount = count => {
    if (!Number.isInteger(count) || count < 1 || count > 80) return;
    setDraft(current => {
      const sections = current.sections.slice(0, count);
      while (sections.length < count) { const last = sections.at(-1); let suffix = sections.length + 1; while (sections.some(section => section.id === `section-new-${suffix}`)) suffix++; sections.push({ ...last, id: `section-new-${suffix}`, label: `Секция ${sections.length + 1}`, x: last.x + last.width }); }
      const last = sections.at(-1);
      return { ...current, sections, placements: current.placements.map(placement => sections.some(section => section.id === placement.sectionId) ? placement : { ...placement, sectionId: last.id, riserId: last.risers[0]?.id || '', x: last.risers[0]?.x || .68, z: last.risers[0]?.z || .08, floor: placement.floor === -1 && !last.basement ? 1 : Math.min(placement.floor, last.floors) }) };
    });
  };
  const save = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch(`/api/buildings/${encodeURIComponent(model.objectId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, actor, reason, model: { ...draft, geometry: { basis: 'operator', agreement: null }, source: { ...draft.source, kind: 'operator', label: 'Параметры уточнены оператором' }, provenance: { ...draft.provenance, floors: 'Параметры секций уточнены оператором', entrances: 'Секции заданы оператором' } } }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); buildingDrafts.delete(draftKey); onSaved(result);
    } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const upload = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try { if (file.size > 2 * 1024 * 1024) throw new Error('Описание здания должно быть не больше 2 МБ.'); const imported = JSON.parse(await file.text()); setDraft(validateBuildingModel({ ...imported, objectId: model.objectId, placements: imported.placements || [] }, model.objectId, entities)); setError(''); } catch (issue) { setError(`Не удалось прочитать схему: ${issue.message}`); }
    event.target.value = '';
  };
  const loadExample = async () => {
    try {
      const response = await fetch('/examples/building-model-import.json');
      if (!response.ok) throw new Error('Не удалось загрузить пример.');
      const example = await response.json();
      setDraft(validateBuildingModel({ ...example, objectId: model.objectId, placements: [] }, model.objectId, entities));
      setReason(''); setError('');
    } catch (issue) { setError(issue.message); }
  };
  return <form className='building-editor' onSubmit={save}>
    <div className='building-editor-heading'><div><h3>Параметры здания</h3><p>Схема перестраивается по данным секций</p></div><button type='button' className='building-icon-button' onClick={onClose} aria-label='Закрыть параметры здания'><X size={19}/></button></div>
    <button type='button' className='building-secondary' onClick={loadExample}><Building2 size={16}/>Синтетический пример здания</button>
    <div className='building-edit-summary'><label>Назначение<BusinessSelect ariaLabel='Назначение здания' value={draft.type} onChange={type => setDraft({ ...draft, type })} options={Object.entries(kindLabels).map(([value, label]) => ({ value, label }))}/></label><label>Количество секций<input type='number' min='1' max='80' value={draft.sections.length} onChange={event => changeCount(Number(event.target.value))}/></label></div>
    <div className='building-editor-sections'>{draft.sections.map((section, index) => <details key={section.id} open={draft.sections.length <= 3 || undefined}><summary>{section.label} <span>{section.floors} эт.</span></summary><div className='building-editor-fields'><label>Название<input maxLength='80' value={section.label} onChange={event => setSection(section.id, 'label', event.target.value)}/></label><label>Этажей<input type='number' min='1' max='180' value={section.floors} onChange={event => setSection(section.id, 'floors', Number(event.target.value))}/></label><label>Ширина, м<input type='number' min='4' max='300' step='any' value={section.width} onChange={event => setSection(section.id, 'width', Number(event.target.value))}/></label><label>Глубина, м<input type='number' min='4' max='150' step='any' value={section.depth} onChange={event => setSection(section.id, 'depth', Number(event.target.value))}/></label><label>Смещение по фасаду, м<input type='number' min='-1000' max='1000' step='any' value={section.x} onChange={event => setSection(section.id, 'x', Number(event.target.value))}/></label><label>Смещение крыла, м<input type='number' min='-1000' max='1000' step='any' value={section.z} onChange={event => setSection(section.id, 'z', Number(event.target.value))}/></label><label>Крыша<BusinessSelect ariaLabel={`Крыша секции ${index + 1}`} value={section.roof} onChange={value => setSection(section.id, 'roof', value)} options={[{ value: 'flat', label: 'Плоская' }, { value: 'gable', label: 'Скатная' }, { value: 'hip', label: 'Вальмовая' }]}/></label><label>Поворот, °<input type='number' min='-360' max='360' step='any' value={section.rotation} onChange={event => setSection(section.id, 'rotation', Number(event.target.value))}/></label><label>Планировка<BusinessSelect ariaLabel={`Планировка секции ${index + 1}`} value={section.interior.layout} onChange={value => setSection(section.id, 'interior.layout', value)} options={[{ value: 'stairwell', label: 'Лестничная' }, { value: 'central', label: 'Общий лифтовой узел' }, { value: 'corridor', label: 'Коридорная' }, { value: 'open', label: 'Открытый зал' }]}/></label><label>Помещений на этаже<input type='number' min='0' max='16' value={section.interior.rooms} onChange={event => setSection(section.id, 'interior.rooms', Number(event.target.value))}/></label><label>Лифтов<input type='number' min='0' max='4' value={section.interior.elevators} onChange={event => setSection(section.id, 'interior.elevators', Number(event.target.value))}/></label><label>Шаг этажных коробок<input type='number' min='1' max='180' value={section.interior.boxEvery} onChange={event => setSection(section.id, 'interior.boxEvery', Number(event.target.value))}/></label><label>Разводка<BusinessSelect ariaLabel={`Разводка секции ${index + 1}`} value={section.interior.feed} onChange={value => setSection(section.id, 'interior.feed', value)} options={[{ value: 'basement', label: 'Снизу, через подвал' }, { value: 'attic', label: 'Сверху, через чердак' }, { value: 'ground', label: 'На первом этаже' }]}/></label><label className='building-check'><input type='checkbox' checked={section.basement} onChange={event => setSection(section.id, 'basement', event.target.checked)}/>Есть подвал</label></div></details>)}</div>
    {draft.placements.length ? <details><summary>Размещение оборудования</summary>{draft.placements.map((placement, index) => <div className='building-placement-edit' key={placement.entityId}><strong>{entities.find(item => item.id === placement.entityId)?.label || 'Узел'}</strong><BusinessSelect ariaLabel={`Секция оборудования ${index + 1}`} value={placement.sectionId} onChange={value => setDraft(current => ({ ...current, placements: current.placements.map((item, i) => i === index ? { ...item, sectionId: value, riserId: current.sections.find(section => section.id === value).risers[0]?.id || '', x: current.sections.find(section => section.id === value).risers[0]?.x || .68, z: current.sections.find(section => section.id === value).risers[0]?.z || .08, floor: item.floor === -1 && !current.sections.find(section => section.id === value).basement ? 1 : Math.min(item.floor, current.sections.find(section => section.id === value).floors) } : item) }))} options={draft.sections.map(section => ({ value: section.id, label: section.label }))}/><label>Этаж<input type='number' min={draft.sections.find(section => section.id === placement.sectionId)?.basement ? '-1' : '1'} max={draft.sections.find(section => section.id === placement.sectionId)?.floors} value={placement.floor} onChange={event => setDraft(current => ({ ...current, placements: current.placements.map((item, i) => i === index ? { ...item, floor: Number(event.target.value), source: 'Уточнено оператором' } : item) }))}/></label></div>)}</details> : null}
    <BuildingCustomerEditor draft={draft} setDraft={setDraft} orders={orders}/>
    <label>Основание изменения<input required minLength='4' maxLength='1500' placeholder='Например: обследование здания от 17 августа' value={reason} onChange={event => setReason(event.target.value)}/></label>
    {error ? <p role='alert' className='cx-error'>{error}</p> : null}
    <div className='building-editor-actions'><input ref={inputRef} type='file' accept='.json,application/json' hidden onChange={upload}/><button type='button' className='building-secondary' onClick={() => inputRef.current?.click()}><Upload size={16}/>Импорт JSON</button><button type='button' className='building-secondary' onClick={() => downloadModel(draft)}><ArrowDownToLine size={16}/>Шаблон</button><button type='button' className='building-secondary' onClick={() => { setDraft(structuredClone(model)); setReason(''); setError(''); }}>Сбросить</button><button type='submit' className='building-primary' disabled={busy || reason.trim().length < 4}>{busy ? <LoaderCircle size={17} className='building-spin'/> : <Save size={17}/>}Сохранить</button></div>
  </form>;
}

/** Building operator workspace over the existing map and object passport. */
export function BuildingWorkspace({ data, date, orders = [], initialOrderId, actor, onOrder, onVisit }) {
  const [payload, setPayload] = useState(null), [error, setError] = useState(''), [version, setVersion] = useState(0);
  const [previewModel, setPreviewModel] = useState(null);
  const [selectedId, setSelectedId] = useState(''), [sectionId, setSectionId] = useState('all'), [view, setView] = useState('scheme'), [zoom, setZoom] = useState(1), [editing, setEditing] = useState(false), [floor, setFloor] = useState(1), [customerId, setCustomerId] = useState('');
  const canvasRef = useRef(null), lastZoom = useRef(1), zoomAnchor = useRef(null), zoomRef = useRef(1);
  const objectId = data.object.id;
  useBuildingPan(canvasRef, payload?.model.objectId);
  useEffect(() => {
    let live = true; setPayload(null); setPreviewModel(null); setError(''); setSectionId('all'); setZoom(1); setSelectedId(''); setEditing(false); setView('scheme'); setFloor(1); setCustomerId(String(initialOrderId || ''));
    const load = async () => { try { const response = await fetch(`/api/buildings/${encodeURIComponent(objectId)}`); const result = await response.json(); if (!response.ok) throw new Error(result.error); if (live) setPayload(result); } catch (issue) { if (live) setError(issue.message); } };
    load(); return () => { live = false; };
  }, [objectId, version]);
  useEffect(() => { setCustomerId(String(initialOrderId || '')); }, [initialOrderId]);
  useEffect(() => { if (!editing) setPreviewModel(null); }, [editing]);
  useLayoutEffect(() => {
    zoomRef.current = zoom;
    const canvas = canvasRef.current;
    if (canvas) {
      const ratio = zoom / lastZoom.current;
      const anchor = zoomAnchor.current || { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
      canvas.scrollLeft = zoom === 1 ? 0 : (canvas.scrollLeft + anchor.x) * ratio - anchor.x;
      canvas.scrollTop = zoom === 1 ? 0 : (canvas.scrollTop + anchor.y) * ratio - anchor.y;
    }
    zoomAnchor.current = null; lastZoom.current = zoom;
  }, [zoom]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = event => {
      if (!event.deltaY) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAnchor.current = { x: (event.clientX - rect.left) * canvas.clientWidth / rect.width, y: (event.clientY - rect.top) * canvas.clientHeight / rect.height };
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
      const next = Math.max(.5, Math.min(4, zoomRef.current * Math.exp(-delta * .0015)));
      zoomRef.current = next; setZoom(next);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [payload?.model.objectId, view]);
  const model = editing && previewModel ? previewModel : payload?.model;
  const activeSectionId = model?.sections.some(section => section.id === sectionId) ? sectionId : 'all';
  const assets = useMemo(() => model ? buildingAssets(model, data.entities) : [], [model, data.entities]);
  const at = `${String(date).slice(0, 10)}T23:59:59+03:00`;
  const conditions = (data.conditions || []).filter(condition => isActive(condition, at));
  const attention = buildingAttention(model, data.entities, conditions, at);
  const attentionIds = new Set(attention.assetConditions.keys());
  const visibleSections = model?.sections.filter(section => activeSectionId === 'all' || section.id === activeSectionId) || [];
  const viewedFloor = Math.min(floor, Math.max(1, ...visibleSections.map(section => section.floors)));
  const visibleAssets = assets.filter(asset => (activeSectionId === 'all' || asset.sectionId === activeSectionId) && (view !== 'floor' || asset.floor === viewedFloor));
  const selected = visibleAssets.find(asset => asset.id === selectedId) || visibleAssets.find(asset => attentionIds.has(asset.id)) || visibleAssets.find(asset => !asset.schematic) || visibleAssets[0];
  const selectedSection = model?.sections.find(section => section.id === selected?.sectionId);
  const selectedRiser = selectedSection?.risers.find(riser => riser.id === selected?.riserId);
  const currentOrders = orders.map(order => {
    const defaults = data.object.orderDefaults?.[String(order.id)];
    return defaults ? { ...order, objectId: order.objectId || objectId, serviceEntities: { ...defaults.serviceEntities, ...order.serviceEntities } } : order;
  });
  const customers = useMemo(() => buildingCustomers(model, currentOrders), [model, orders, data.object.orderDefaults]);
  const selectedCustomer = customers.find(customer => customer.orderId === customerId) || customers[0];
  const selectCustomer = id => {
    setCustomerId(id);
    const customer = customers.find(item => item.orderId === id);
    if (customer?.known) { setSectionId(customer.sectionId); setFloor(customer.floor); setZoom(1); canvasRef.current?.scrollTo(0, 0); }
  };
  const requestCounts = new Map(assets.filter(asset => !asset.schematic).map(asset => [asset.id, linkedBuildingOrders(asset, currentOrders, objectId, data.entities).length]));
  const related = linkedBuildingOrders(selected, currentOrders, objectId, data.entities);
  const relatedConditions = attention.assetConditions.get(selected?.id) || [];
  const visits = selected && !selected.schematic ? (data.visits || []).filter(visit => selected.entityIds.includes(visit.entities?.node) || data.entities.some(entity => entity.id === visit.entities?.line && selected.entityIds.includes(entity.nodeId))).slice(0, 2) : [];
  if (error) return <div className='building-load-state'><AlertCircle size={32}/><p role='alert'>{error}</p><button className='building-secondary' type='button' onClick={() => setVersion(value => value + 1)}>Повторить загрузку</button></div>;
  if (!model) return <div className='building-load-state' role='status'><LoaderCircle className='building-spin' size={30}/><p>Строим схему объекта…</p></div>;
  const minFloors = Math.min(...model.sections.map(section => section.floors)), maxFloors = Math.max(...model.sections.map(section => section.floors));
  const activeFloor = viewedFloor;
  const floorOptions = [...(visibleSections.some(section => section.basement) ? [{ value: '-1', label: 'Подвал' }] : []), ...Array.from({ length: Math.max(1, ...visibleSections.map(section => section.floors)) }, (_, index) => ({ value: String(index + 1), label: `${index + 1} этаж` }))];
  return <div className='building-workspace'>
    <div className='building-main'>
      <div className='building-toolbar'><div className='building-view-switch'><button type='button' className={view === 'scheme' ? 'active' : ''} onClick={() => { setView('scheme'); setZoom(1); }}><Layers3 size={17}/>Схема</button><button type='button' className={view === 'floor' ? 'active' : ''} onClick={() => { setView('floor'); setZoom(1); }}><Layers3 size={17}/>План этажа</button></div><BusinessSelect ariaLabel='Секция здания' value={activeSectionId} onChange={value => { setSectionId(value); setSelectedId(''); setZoom(1); }} options={[{ value: 'all', label: 'Все секции' }, ...model.sections.map(section => ({ value: section.id, label: section.label }))]} searchable portalMenu/><button className='building-icon-button building-edit-toggle' type='button' onClick={() => setEditing(value => !value)} aria-label='Изменить параметры здания' aria-expanded={editing}><Settings2 size={19}/></button></div>
      <div className='building-meta'><span>{kindLabels[model.type]}</span><i/><span>{minFloors === maxFloors ? maxFloors : `${minFloors}–${maxFloors}`} эт.</span><i/><span>{model.sections.length} секц.</span>{model.year ? <><i/><span>{model.year} г.</span></> : null}{editing ? <span className='building-source-chip'>Предпросмотр изменений</span> : null}</div>
      {view === 'floor' ? <div className='building-floor-toolbar'><BusinessSelect ariaLabel='Этаж на плане' value={String(activeFloor)} onChange={value => setFloor(Number(value))} options={floorOptions} searchable/><span>{model.sections.every(section => section.floorPlans.source === 'model') ? 'Демонстрационные планы помещений' : 'Планы по загруженным данным'}</span></div> : null}
      <div className={`building-stage ${view === 'floor' ? 'is-floor-view' : ''}`} data-building-stage>
        <div className='building-viewport'>
          <div className='building-canvas-scroll' ref={canvasRef}>
            {view === 'scheme' ? <BuildingCutaway model={model} assets={assets} selectedId={selected?.id} onSelect={id => { setSelectedId(id); setEditing(false); }} sectionId={activeSectionId} attentionIds={attentionIds} requestCounts={requestCounts} zoom={zoom} customers={customers} selectedCustomerId={selectedCustomer?.orderId} onCustomer={id => { selectCustomer(id); setView('floor'); }}/> : <BuildingFloorPlan model={model} assets={assets} selectedId={selected?.id} onSelect={id => setSelectedId(id)} floor={activeFloor} sectionId={activeSectionId} zoom={zoom} attentionIds={attentionIds} customers={customers} selectedCustomerId={selectedCustomer?.orderId} onCustomer={selectCustomer}/>}
          </div>
          {view === 'floor' ? <div className='building-floor-key'><span><i className='room'/>Помещения</span><span><i className='common'/>Общие зоны</span><span><i className='technical'/>Технические</span></div> : null}
          <div className='building-zoom'><button type='button' className='building-icon-button' disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))} aria-label='Уменьшить схему'><Minus size={17}/></button><span>{Math.round(zoom * 100)}%</span><button type='button' className='building-icon-button' disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + .25))} aria-label='Увеличить схему'><Plus size={17}/></button><button type='button' className='building-icon-button' onClick={() => { setZoom(1); canvasRef.current?.scrollTo(0, 0); }} aria-label='Показать всю схему'><Expand size={17}/></button></div>
        </div>
        <BuildingNavigator model={model} sectionId={activeSectionId} currentSectionId={activeSectionId === 'all' ? selectedCustomer?.sectionId || selected?.sectionId : activeSectionId} sectionConditions={attention.sectionConditions} onSection={id => { setSectionId(id); setSelectedId(''); setZoom(1); canvasRef.current?.scrollTo(0, 0); }}/>
      </div>
      <div className='building-legend'><span><span className='building-legend-cabinet'/>Оборудование</span><span><i className='building-legend-line'/>Стояк</span><span><span className='building-legend-count'>1</span>Заявки</span><span><AlertCircle size={15} color='#d17b24'/>Особенности</span><span><span className='building-legend-customer'/>Квартира клиента</span><span className='building-legend-note'>Внутреннее устройство и размещение условные</span></div>
      <details className='building-provenance'><summary><CircleHelp size={15}/>Источники данных и точность схемы<ChevronRight size={15}/></summary><div>{Object.values(model.provenance).map((label, index) => <p key={index}>{String(label)}</p>)}{model.source.url ? <a href={model.source.url} target='_blank' rel='noreferrer'>{payload.attribution.label} · {timestamp(payload.attribution.fetchedAt)}</a> : null}<p>Квартиры с пометкой «Демо-привязка» синтетические. Для новых заявок расположение появляется только после явной привязки к помещению в параметрах здания или импорте.</p><p>Схема стояков и этажные коробки — модельные. Состояние сети в реальном времени не подключено.</p></div></details>
    </div>
    <div className='building-detail'>
      {!editing ? <BuildingCustomerPanel customers={customers} selected={selectedCustomer} onSelect={selectCustomer} onFloor={customer => { selectCustomer(customer.orderId); setView('floor'); }} onOrder={order => onOrder?.(orders.find(item => String(item.id) === String(order.id)) || order)}/> : null}
      {editing ? <BuildingEditor model={payload.model} revision={payload.revision} entities={data.entities} orders={currentOrders.filter(order => (order.serviceEntities?.object || order.objectId) === objectId)} actor={actor} onPreview={setPreviewModel} onClose={() => setEditing(false)} onSaved={result => { setPayload(result); setSelectedId(''); setSectionId('all'); setZoom(1); setEditing(false); }}/> : selected ? <>
        <div className='building-detail-heading'><span className='building-eyebrow'>{selected.schematic ? 'МОДЕЛЬНАЯ ТОЧКА' : 'ОБОРУДОВАНИЕ'}</span><h3>{selected.label}</h3><p>{selected.location}</p>{model.sections.length > 3 && activeSectionId === 'all' ? <button type='button' className='building-section-focus' onClick={() => { setSectionId(selected.sectionId); setZoom(1); }}><Expand size={13}/>Показать секцию крупнее</button> : null}{attentionIds.has(selected.id) ? <span className='building-attention'><AlertCircle size={16}/>Есть особенности обслуживания</span> : <span className='building-neutral'><Cable size={14}/>{selected.schematic ? 'Расположение не подтверждено' : 'По данным реестра объекта'}</span>}</div>
        {selected.note ? <div className='building-access'><Wrench size={19}/><span>{selected.note.replace(/; положение известно.*$/i, '')}</span></div> : null}
        {selected ? <button type='button' className='building-section-focus building-open-floor' onClick={() => { setSectionId(selected.sectionId); setFloor(selected.floor); setView('floor'); setZoom(1); }}><Layers3 size={14}/>Показать на плане этажа</button> : null}
        {selectedRiser ? <div className='building-network-summary'><strong>{selectedRiser.label}</strong><span>{selectedRiser.fromFloor < 0 ? 'Подвал' : `${selectedRiser.fromFloor} этаж`} → {selectedRiser.toFloor} этаж · {selectedSection.interior.feed === 'attic' ? 'разводка сверху' : selectedSection.interior.feed === 'basement' ? 'разводка снизу' : 'ввод на первом этаже'}</span><small>{selectedRiser.source === 'model' ? 'Демонстрационная схема сети' : 'По загруженной схеме сети'}</small></div> : null}
        {selected.equipment?.length ? <div className='building-equipment-list'>{selected.equipment.map(item => <span key={item.id}><Cable size={16}/>{item.label}</span>)}</div> : null}
        <section className='building-related'><h4>Связанные заявки <span>{related.length}</span></h4>{related.length ? related.map(order => <button type='button' className='building-order' key={order.id} onClick={() => onOrder?.(orders.find(item => item.id === order.id) || order)}><span className={`building-order-icon ${order.workType === 'Подключение' ? 'connection' : ''}`}><Cable size={17}/></span><span><strong>№{String(order.sourceData?.source_job_id || order.sourceId || order.id).replace(/^(EAST|SOUTHEAST|SOUTHCENTER)-/, '')}</strong><small>{order.workType || 'Заявка'} · {order.start || '—'}–{order.end || '—'}</small></span><ChevronRight size={16}/></button>) : <p className='building-empty-note'>{selected.schematic ? 'Заявки привязываются к подтверждённому оборудованию.' : 'На выбранный день связанных заявок нет.'}</p>}</section>
        {relatedConditions.length ? <section><h4>Что учесть при выезде</h4>{relatedConditions.map(condition => <div className='building-condition' key={condition.id}><AlertCircle size={16}/><div><strong>{condition.finding || 'Особенность обслуживания'}</strong>{condition.preparation ? <p>{condition.preparation}</p> : null}</div></div>)}</section> : null}
        <section className='building-visits'><h4>Последние работы</h4>{visits.length ? visits.map(visit => <button type='button' key={visit.id} onClick={() => onVisit?.(visit)}><FileText size={18}/><span><strong>{timestamp(visit.endedAt || visit.startedAt)}</strong><small>{visit.finding || visit.workType || 'Визит на объект'}</small></span><ChevronRight size={15}/></button>) : <p className='building-empty-note'>История работ по этой точке пока не записана.</p>}</section>
        <div className='building-detail-footer'><button type='button' className='building-primary' onClick={() => setEditing(true)}><Settings2 size={17}/>Уточнить сведения</button><button type='button' className='building-secondary' onClick={() => downloadModel(model)} aria-label='Скачать описание здания'><ArrowDownToLine size={17}/></button></div>
      </> : <div className='building-load-state'><Building2 size={38}/><h3>{view === 'floor' ? 'На этом этаже нет точек оборудования' : 'Оборудование не размещено'}</h3><p>Сведения можно дополнить в параметрах здания.</p><button type='button' className='building-primary' onClick={() => setEditing(true)}>Уточнить сведения</button></div>}
      {payload.history.length ? <details className='building-history'><summary>История уточнений · {payload.history.filter(item => item.revision > 0).length}</summary>{payload.history.map(item => <p key={item.revision}><strong>{timestamp(item.changedAt)} · {item.actor}</strong><span>{item.reason}</span></p>)}</details> : null}
    </div>
  </div>;
}
