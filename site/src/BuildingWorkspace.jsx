import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Building2, Cable, ChevronRight, CircleHelp, Expand, FileText, Layers3, LoaderCircle, Minus, Plus, Save, Settings2, Upload, Wrench, X } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { buildingAssets, buildingScene, linkedBuildingOrders, validateBuildingModel } from './buildingModel.js';
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

/** Procedural cutaway. All floors, sections and equipment positions come from the model. */
export function BuildingCutaway({ model, assets, selectedId, onSelect, sectionId, attentionIds, requestCounts = new Map(), zoom = 1 }) {
  const uid = useId().replace(/:/g, '');
  const scene = useMemo(() => buildingScene(model, sectionId), [model, sectionId]);
  const { project: p, sections, viewBox } = scene;
  const shape = coordinates => points(coordinates.map(([x, floor, z]) => p(x, floor, z)));
  const paint = name => `url(#${uid}-${name})`;
  const visibleAssets = assets.filter(asset => sections.some(section => section.id === asset.sectionId));
  const maxFloors = Math.max(...sections.map(section => section.floors));
  const labelStep = Math.max(1, Math.ceil(maxFloors / 13));
  const floorLabelSection = sections[0];
  return <svg className='building-cutaway' viewBox={viewBox.join(' ')} style={{ width: `${zoom * 100}%`, minWidth: `${zoom * 100}%`, height: `${zoom * 100}%`, minHeight: `${zoom * 100}%` }} role='group' aria-label={`Схема здания: ${sections.length} секций, до ${maxFloors} этажей`}>
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
        const base = section.basement ? -1 : 0;
        const label = p(x + w / 2, h + .8, z + d / 2);
        return <g key={section.id} data-building-section={section.id}>
          <polygon className='building-back-wall' points={shape([[x, base, z + d], [x + w, base, z + d], [x + w, h, z + d], [x, h, z + d]])} fill={paint('back')}/>
          <polygon className='building-side-wall' points={shape([[x, base, z], [x, base, z + d], [x, h, z + d], [x, h, z]])} fill={paint('side')}/>
          <polygon className='building-side-wall' points={shape([[x + w, base, z], [x + w, base, z + d], [x + w, h, z + d], [x + w, h, z]])} fill={paint('side')}/>
          {Array.from({ length: h - base }, (_, index) => base + index).map(floor => {
            const door = p(x + w * .16, floor + .1, z + d * .77);
            const room = p(x + w * .59, floor + .1, z + d * .83);
            const stair = p(x + w * .39, floor + .06, z + d * .48);
            const stepWidth = Math.min(24, w * .7);
            return <g key={floor} className={floor < 0 ? 'building-basement' : ''}>
              <polygon points={shape([[x, floor, z], [x + w, floor, z], [x + w, floor, z + d], [x, floor, z + d]])} fill={paint('slab')} stroke='#bfc4cb' strokeWidth='.6'/>
              <polygon points={shape([[x, floor, z], [x + w, floor, z], [x + w, floor - .065, z], [x, floor - .065, z]])} fill='#c7cbd0'/>
              <path d={`M ${door[0]} ${door[1]} v -23 h 13 v 23 M ${room[0]} ${room[1]} v -23 h 13 v 23`} className='building-doors' fill='none' strokeWidth='1'/>
              <path d={`M ${door[0] + 1} ${door[1]} v -22 h 11 v 22 M ${room[0] + 1} ${room[1]} v -22 h 11 v 22`} fill='#c4baaa' opacity='.8'/>
              <path d={`M ${door[0] + 10} ${door[1] - 10} h 2 M ${room[0] + 10} ${room[1] - 10} h 2`} stroke='#7e817d' strokeWidth='.8'/>
              <path d={`M ${stair[0]} ${stair[1]} l 14 -20 h ${stepWidth} l -14 20 z`} fill='#dedfdf' stroke='#b4bac0' strokeWidth='.6'/>
              <path d={Array.from({ length: 8 }, (_, i) => `M ${stair[0] + i * 1.7} ${stair[1] - i * 2.4} h ${stepWidth}`).join(' ')} className='building-stairs' fill='none' stroke='#9da5ad' strokeWidth='.85'/>
              <path d={`M ${stair[0] - 1} ${stair[1] - 5} l 14 -20 M ${stair[0] + 1} ${stair[1] - 2} v -6 M ${stair[0] + 8} ${stair[1] - 12} v -6 M ${stair[0] + 14} ${stair[1] - 21} v -6`} stroke='#929da6' strokeWidth='.85' fill='none'/>
              {floor >= 0 && section === sections[0] ? [.12, .58].map(offset => <g key={offset}><polygon points={shape([[x - .02, floor + .22, z + d * offset], [x - .02, floor + .22, z + d * (offset + .25)], [x - .02, floor + .76, z + d * (offset + .25)], [x - .02, floor + .76, z + d * offset]])} fill={paint('glass')} stroke='#8d9da9' strokeWidth='.8'/><path d={`M ${p(x - .02, floor + .22, z + d * (offset + .12))} L ${p(x - .02, floor + .76, z + d * (offset + .12))}`} stroke='#ecf0f3' strokeWidth='1'/></g>) : null}
              <polygon points={shape([[x + w * .49, floor, z], [x + w * .49, floor, z + d], [x + w * .49, floor + .95, z + d], [x + w * .49, floor + .95, z]])} fill='#e4e2de' opacity='.3'/>
            </g>;
          })}
          <polygon className='building-roof' points={shape([[x, h, z], [x + w, h, z], [x + w, h, z + d], [x, h, z + d]])} fill={paint('slab')} stroke='#bfc4cb' strokeWidth='.85'/>
          {section.roof !== 'flat' ? <><polygon className='building-pitched-roof' points={shape([[x, h, z], [x + w, h, z], [x + w * (section.roof === 'hip' ? .8 : 1), h + .7, z + d / 2], [x + w * (section.roof === 'hip' ? .2 : 0), h + .7, z + d / 2]])} fill='#aeb9c5' stroke='#8f9eac'/><polygon points={shape([[x + w, h, z], [x + w, h, z + d], [x + w * (section.roof === 'hip' ? .8 : 1), h + .7, z + d / 2]])} fill='#c5cdd5'/></> : <polygon points={shape([[x + w * .15, h, z + d * .35], [x + w * .34, h, z + d * .35], [x + w * .34, h + .28, z + d * .35], [x + w * .15, h + .28, z + d * .35]])} fill='#d4d6d9' stroke='#b6bcc3'/>}
          <g transform={`translate(${label[0]},${label[1]})`} className='building-section-label'><rect x={-Math.max(40, section.label.length * 3.6)} y='-16' width={Math.max(80, section.label.length * 7.2)} height='27' rx='6'/><text textAnchor='middle' y='2'>{section.label}</text></g>
        </g>;
      })}
    </g>
    <g className='building-floor-labels'>{Array.from({ length: floorLabelSection.floors }, (_, i) => i + 1).filter(floor => floor === 1 || floor === floorLabelSection.floors || floor % labelStep === 0).map(floor => { const [x, y] = p(floorLabelSection.x, floor - .35, floorLabelSection.z); return <text key={floor} x={x - 12} y={y} textAnchor='end'>{floor} этаж</text>; })}{floorLabelSection.basement ? <text x={p(floorLabelSection.x, 0, floorLabelSection.z)[0] - 12} y={p(floorLabelSection.x, -.65, floorLabelSection.z)[1]} textAnchor='end'>Подвал</text> : null}</g>
    <g className='building-cables'>{sections.map(section => {
      const x = section.x + section.width * .76, z = section.z + 1;
      const start = section.basement ? -.7 : .1;
      const path = `M ${p(x, start, z)} L ${p(x, section.floors - .22, z)}`;
      return <g key={section.id}><path d={path} stroke='#fff' strokeWidth='5.5' fill='none'/><path d={path} stroke='#168ed0' strokeWidth='2.7' fill='none'/>{section.basement ? <><path d={`M ${p(section.x + section.width * .15, start, z)} L ${p(x, start, z)}`} stroke='#fff' strokeWidth='5.5'/><path d={`M ${p(section.x + section.width * .15, start, z)} L ${p(x, start, z)}`} stroke='#168ed0' strokeWidth='2.7'/></> : null}</g>;
    })}</g>
    <g>{visibleAssets.map(asset => {
      const section = sections.find(item => item.id === asset.sectionId);
      const [x, y] = p(section.x + section.width * .76, asset.floor < 0 ? -.6 : asset.floor - .45, section.z + 1);
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
        {selected ? <g className='building-selected-label' transform={`translate(${w + 9},${-h - 20})`}><rect x='-8' y='-14' width={Math.min(200, asset.label.length * 6.5 + 18)} height='26' rx='5'/><text x='0' y='3'>{asset.schematic ? 'Этажная коробка' : asset.label}</text></g> : null}
      </g>;
    })}</g>
  </svg>;
}

function BuildingEditor({ model, revision, actor, entities, onSaved, onClose, onPreview }) {
  const draftKey = `${model.objectId}/${revision}`;
  const [draft, setDraft] = useState(() => buildingDrafts.get(draftKey)?.model || structuredClone(model));
  const [reason, setReason] = useState(() => buildingDrafts.get(draftKey)?.reason || ''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { buildingDrafts.set(draftKey, { model: draft, reason }); if (buildingDrafts.size > 30) buildingDrafts.delete(buildingDrafts.keys().next().value); }, [draft, reason, draftKey]);
  useEffect(() => { try { onPreview(validateBuildingModel(draft, model.objectId, entities)); } catch { onPreview(null); } }, [draft, model.objectId, entities, onPreview]);
  const inputRef = useRef(null);
  const setSection = (id, key, value) => setDraft(current => ({ ...current, sections: current.sections.map(section => section.id === id ? { ...section, [key]: value } : section), placements: current.placements.map(placement => {
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
      return { ...current, sections, placements: current.placements.map(placement => sections.some(section => section.id === placement.sectionId) ? placement : { ...placement, sectionId: last.id, floor: placement.floor === -1 && !last.basement ? 1 : Math.min(placement.floor, last.floors) }) };
    });
  };
  const save = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch(`/api/buildings/${encodeURIComponent(model.objectId)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, actor, reason, model: { ...draft, source: { ...draft.source, kind: 'operator', label: 'Параметры уточнены оператором' }, provenance: { ...draft.provenance, floors: 'Параметры секций уточнены оператором', entrances: 'Секции заданы оператором' } } }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error); buildingDrafts.delete(draftKey); onSaved(result);
    } catch (issue) { setError(issue.message); } finally { setBusy(false); }
  };
  const upload = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try { if (file.size > 2 * 1024 * 1024) throw new Error('Описание здания должно быть не больше 2 МБ.'); const imported = JSON.parse(await file.text()); setDraft(validateBuildingModel({ ...imported, objectId: model.objectId, placements: imported.placements || [] }, model.objectId, entities)); setError(''); } catch (issue) { setError(`Не удалось прочитать схему: ${issue.message}`); }
    event.target.value = '';
  };
  return <form className='building-editor' onSubmit={save}>
    <div className='building-editor-heading'><div><h3>Параметры здания</h3><p>Схема перестраивается по данным секций</p></div><button type='button' className='building-icon-button' onClick={onClose} aria-label='Закрыть параметры здания'><X size={19}/></button></div>
    <div className='building-edit-summary'><label>Назначение<BusinessSelect ariaLabel='Назначение здания' value={draft.type} onChange={type => setDraft({ ...draft, type })} options={Object.entries(kindLabels).map(([value, label]) => ({ value, label }))}/></label><label>Количество секций<input type='number' min='1' max='80' value={draft.sections.length} onChange={event => changeCount(Number(event.target.value))}/></label></div>
    <div className='building-editor-sections'>{draft.sections.map((section, index) => <details key={section.id} open={draft.sections.length <= 3 || undefined}><summary>{section.label} <span>{section.floors} эт.</span></summary><div className='building-editor-fields'><label>Название<input maxLength='80' value={section.label} onChange={event => setSection(section.id, 'label', event.target.value)}/></label><label>Этажей<input type='number' min='1' max='180' value={section.floors} onChange={event => setSection(section.id, 'floors', Number(event.target.value))}/></label><label>Ширина, м<input type='number' min='4' max='300' step='.1' value={section.width} onChange={event => setSection(section.id, 'width', Number(event.target.value))}/></label><label>Глубина, м<input type='number' min='4' max='150' step='.1' value={section.depth} onChange={event => setSection(section.id, 'depth', Number(event.target.value))}/></label><label>Смещение по фасаду, м<input type='number' min='-1000' max='1000' step='.1' value={section.x} onChange={event => setSection(section.id, 'x', Number(event.target.value))}/></label><label>Смещение крыла, м<input type='number' min='-1000' max='1000' step='.1' value={section.z} onChange={event => setSection(section.id, 'z', Number(event.target.value))}/></label><label>Крыша<BusinessSelect ariaLabel={`Крыша секции ${index + 1}`} value={section.roof} onChange={value => setSection(section.id, 'roof', value)} options={[{ value: 'flat', label: 'Плоская' }, { value: 'gable', label: 'Скатная' }, { value: 'hip', label: 'Вальмовая' }]}/></label><label className='building-check'><input type='checkbox' checked={section.basement} onChange={event => setSection(section.id, 'basement', event.target.checked)}/>Есть подвал</label></div></details>)}</div>
    {draft.placements.length ? <details><summary>Размещение оборудования</summary>{draft.placements.map((placement, index) => <div className='building-placement-edit' key={placement.entityId}><strong>{entities.find(item => item.id === placement.entityId)?.label || 'Узел'}</strong><BusinessSelect ariaLabel={`Секция оборудования ${index + 1}`} value={placement.sectionId} onChange={value => setDraft(current => ({ ...current, placements: current.placements.map((item, i) => i === index ? { ...item, sectionId: value, floor: item.floor === -1 && !current.sections.find(section => section.id === value).basement ? 1 : Math.min(item.floor, current.sections.find(section => section.id === value).floors) } : item) }))} options={draft.sections.map(section => ({ value: section.id, label: section.label }))}/><label>Этаж<input type='number' min={draft.sections.find(section => section.id === placement.sectionId)?.basement ? '-1' : '1'} max={draft.sections.find(section => section.id === placement.sectionId)?.floors} value={placement.floor} onChange={event => setDraft(current => ({ ...current, placements: current.placements.map((item, i) => i === index ? { ...item, floor: Number(event.target.value), source: 'Уточнено оператором' } : item) }))}/></label></div>)}</details> : null}
    <label>Основание изменения<input required minLength='4' maxLength='1500' placeholder='Например: обследование здания от 17 августа' value={reason} onChange={event => setReason(event.target.value)}/></label>
    {error ? <p role='alert' className='cx-error'>{error}</p> : null}
    <div className='building-editor-actions'><input ref={inputRef} type='file' accept='.json,application/json' hidden onChange={upload}/><button type='button' className='building-secondary' onClick={() => inputRef.current?.click()}><Upload size={16}/>Импорт JSON</button><button type='button' className='building-secondary' onClick={() => downloadModel(draft)}><ArrowDownToLine size={16}/>Шаблон</button><button type='button' className='building-secondary' onClick={() => { setDraft(structuredClone(model)); setReason(''); setError(''); }}>Сбросить</button><button type='submit' className='building-primary' disabled={busy || reason.trim().length < 4}>{busy ? <LoaderCircle size={17} className='building-spin'/> : <Save size={17}/>}Сохранить</button></div>
  </form>;
}

/** Building operator workspace over the existing map and object passport. */
export function BuildingWorkspace({ data, date, orders = [], actor, onOrder, onVisit }) {
  const [payload, setPayload] = useState(null), [error, setError] = useState(''), [version, setVersion] = useState(0);
  const [previewModel, setPreviewModel] = useState(null);
  const [selectedId, setSelectedId] = useState(''), [sectionId, setSectionId] = useState('all'), [view, setView] = useState('scheme'), [zoom, setZoom] = useState(1), [editing, setEditing] = useState(false);
  const canvasRef = useRef(null), lastZoom = useRef(1);
  const objectId = data.object.id;
  useEffect(() => {
    let live = true; setPayload(null); setPreviewModel(null); setError(''); setSectionId('all'); setZoom(1); setSelectedId(''); setEditing(false); setView('scheme');
    const load = async () => { try { const response = await fetch(`/api/buildings/${encodeURIComponent(objectId)}`); const result = await response.json(); if (!response.ok) throw new Error(result.error); if (live) { setPayload(result); if (result.model.sections.length > 6) setSectionId(result.model.placements[0]?.sectionId || result.model.sections[0].id); } } catch (issue) { if (live) setError(issue.message); } };
    load(); return () => { live = false; };
  }, [objectId, version]);
  useEffect(() => { if (!editing) setPreviewModel(null); }, [editing]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) { const ratio = zoom / lastZoom.current; canvas.scrollLeft = zoom === 1 ? 0 : (canvas.scrollLeft + canvas.clientWidth / 2) * ratio - canvas.clientWidth / 2; canvas.scrollTop = zoom === 1 ? 0 : (canvas.scrollTop + canvas.clientHeight / 2) * ratio - canvas.clientHeight / 2; }
    lastZoom.current = zoom;
  }, [zoom]);
  const model = editing && previewModel ? previewModel : payload?.model;
  const activeSectionId = model?.sections.some(section => section.id === sectionId) ? sectionId : 'all';
  const assets = useMemo(() => model ? buildingAssets(model, data.entities) : [], [model, data.entities]);
  const at = `${String(date).slice(0, 10)}T23:59:59+03:00`;
  const conditions = (data.conditions || []).filter(condition => isActive(condition, at));
  const attentionIds = new Set(assets.filter(asset => !asset.schematic && conditions.some(condition => asset.entityIds.includes(condition.entityId) || data.entities.some(entity => entity.kind === 'line' && entity.id === condition.entityId && asset.entityIds.includes(entity.nodeId)))).map(asset => asset.id));
  const visibleAssets = assets.filter(asset => activeSectionId === 'all' || asset.sectionId === activeSectionId);
  const selected = visibleAssets.find(asset => asset.id === selectedId) || visibleAssets.find(asset => attentionIds.has(asset.id)) || visibleAssets.find(asset => !asset.schematic) || visibleAssets[0];
  const currentOrders = orders.map(order => {
    const defaults = data.object.orderDefaults?.[String(order.id)];
    return defaults ? { ...order, objectId: order.objectId || objectId, serviceEntities: { ...defaults.serviceEntities, ...order.serviceEntities } } : order;
  });
  const requestCounts = new Map(assets.filter(asset => !asset.schematic).map(asset => [asset.id, linkedBuildingOrders(asset, currentOrders, objectId, data.entities).length]));
  const related = linkedBuildingOrders(selected, currentOrders, objectId, data.entities);
  const relatedConditions = selected && !selected.schematic ? conditions.filter(condition => selected.entityIds.includes(condition.entityId) || data.entities.some(entity => entity.kind === 'line' && entity.id === condition.entityId && selected.entityIds.includes(entity.nodeId))) : [];
  const visits = selected && !selected.schematic ? (data.visits || []).filter(visit => selected.entityIds.includes(visit.entities?.node) || data.entities.some(entity => entity.id === visit.entities?.line && selected.entityIds.includes(entity.nodeId))).slice(0, 2) : [];
  if (error) return <div className='building-load-state'><AlertCircle size={32}/><p role='alert'>{error}</p><button className='building-secondary' type='button' onClick={() => setVersion(value => value + 1)}>Повторить загрузку</button></div>;
  if (!model) return <div className='building-load-state' role='status'><LoaderCircle className='building-spin' size={30}/><p>Строим схему объекта…</p></div>;
  const minFloors = Math.min(...model.sections.map(section => section.floors)), maxFloors = Math.max(...model.sections.map(section => section.floors));
  const contourX = model.footprint.map(point => point[0]), contourY = model.footprint.map(point => point[1]);
  const contourBounds = model.footprint.length ? [Math.min(...contourX) - 10, Math.min(...contourY) - 10, Math.max(...contourX) - Math.min(...contourX) + 20, Math.max(...contourY) - Math.min(...contourY) + 20].join(' ') : '';
  return <div className='building-workspace'>
    <div className='building-main'>
      <div className='building-toolbar'><div className='building-view-switch'><button type='button' className={view === 'scheme' ? 'active' : ''} onClick={() => setView('scheme')}><Layers3 size={17}/>Схема</button><button type='button' className={view === 'footprint' ? 'active' : ''} onClick={() => setView('footprint')}><Building2 size={17}/>Контур</button></div><BusinessSelect ariaLabel='Секция здания' value={activeSectionId} onChange={value => { setSectionId(value); setSelectedId(''); setZoom(1); }} options={[{ value: 'all', label: 'Все секции' }, ...model.sections.map(section => ({ value: section.id, label: section.label }))]} searchable portalMenu/><button className='building-icon-button building-edit-toggle' type='button' onClick={() => setEditing(value => !value)} aria-label='Изменить параметры здания' aria-expanded={editing}><Settings2 size={19}/></button></div>
      <div className='building-meta'><span>{kindLabels[model.type]}</span><i/><span>{minFloors === maxFloors ? maxFloors : `${minFloors}–${maxFloors}`} эт.</span><i/><span>{model.sections.length} секц.</span>{model.year ? <><i/><span>{model.year} г.</span></> : null}<span className='building-source-chip'><span/>{editing ? 'Предпросмотр изменений' : model.source.kind === 'osm' ? 'Данные OSM' : model.source.kind === 'operator' ? 'Уточнено оператором' : 'По параметрам объекта'}</span></div>
      <div className='building-stage' data-building-stage>
        {view === 'scheme' ? <div className='building-canvas-scroll' ref={canvasRef}><BuildingCutaway model={model} assets={assets} selectedId={selected?.id} onSelect={id => { setSelectedId(id); setEditing(false); }} sectionId={activeSectionId} attentionIds={attentionIds} requestCounts={requestCounts} zoom={zoom}/></div> : <div className='building-footprint-view'>{model.footprint.length ? <svg viewBox={contourBounds} aria-label='Контур здания из OpenStreetMap'><polygon points={points(model.footprint)} fill='#ffe99a' stroke='#aa8514' strokeWidth='.7'/></svg> : <><Building2 size={60}/><p>Точный контур здания пока не добавлен.</p><span>Схема строится по размерам секций.</span></>}<p>Контур участка здания{model.source.url ? <a href={model.source.url} target='_blank' rel='noreferrer'>Открыть в OpenStreetMap<ChevronRight size={15}/></a> : null}</p></div>}
        {view === 'scheme' ? <div className='building-zoom'><button type='button' className='building-icon-button' disabled={zoom <= .75} onClick={() => setZoom(value => Math.max(.75, value - .25))} aria-label='Уменьшить схему'><Minus size={17}/></button><span>{Math.round(zoom * 100)}%</span><button type='button' className='building-icon-button' disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))} aria-label='Увеличить схему'><Plus size={17}/></button><button type='button' className='building-icon-button' onClick={() => setZoom(1)} aria-label='Показать всю схему'><Expand size={17}/></button></div> : null}
      </div>
      <div className='building-legend'><span><span className='building-legend-cabinet'/>Оборудование</span><span><i className='building-legend-line'/>Стояк</span><span><span className='building-legend-count'>1</span>Заявки</span><span><AlertCircle size={15} color='#d17b24'/>Особенности</span><span className='building-legend-note'>Внутреннее устройство и размещение условные</span></div>
      <details className='building-provenance'><summary><CircleHelp size={15}/>Источники данных и точность схемы<ChevronRight size={15}/></summary><div>{Object.values(model.provenance).map((label, index) => <p key={index}>{String(label)}</p>)}{model.source.url ? <a href={model.source.url} target='_blank' rel='noreferrer'>{payload.attribution.label} · {timestamp(payload.attribution.fetchedAt)}</a> : null}<p>Схема стояков и этажные коробки — модельные. Состояние сети в реальном времени не подключено.</p></div></details>
    </div>
    <div className='building-detail'>
      {editing ? <BuildingEditor model={payload.model} revision={payload.revision} entities={data.entities} actor={actor} onPreview={setPreviewModel} onClose={() => setEditing(false)} onSaved={result => { setPayload(result); setSelectedId(''); setSectionId('all'); setZoom(1); setEditing(false); }}/> : selected ? <>
        <div className='building-detail-heading'><span className='building-eyebrow'>{selected.schematic ? 'МОДЕЛЬНАЯ ТОЧКА' : 'ОБОРУДОВАНИЕ'}</span><h3>{selected.label}</h3><p>{selected.location}</p>{model.sections.length > 3 && activeSectionId === 'all' ? <button type='button' className='building-section-focus' onClick={() => { setSectionId(selected.sectionId); setZoom(1); }}><Expand size={13}/>Показать секцию крупнее</button> : null}{attentionIds.has(selected.id) ? <span className='building-attention'><AlertCircle size={16}/>Есть особенности обслуживания</span> : <span className='building-neutral'><Cable size={14}/>{selected.schematic ? 'Расположение не подтверждено' : 'По данным реестра объекта'}</span>}</div>
        {selected.note ? <div className='building-access'><Wrench size={19}/><span>{selected.note.replace(/; положение известно.*$/i, '')}</span></div> : null}
        {selected.equipment?.length ? <div className='building-equipment-list'>{selected.equipment.map(item => <span key={item.id}><Cable size={16}/>{item.label}</span>)}</div> : null}
        <section className='building-related'><h4>Связанные заявки <span>{related.length}</span></h4>{related.length ? related.map(order => <button type='button' className='building-order' key={order.id} onClick={() => onOrder?.(orders.find(item => item.id === order.id) || order)}><span className={`building-order-icon ${order.workType === 'Подключение' ? 'connection' : ''}`}><Cable size={17}/></span><span><strong>№{String(order.sourceData?.source_job_id || order.sourceId || order.id).replace(/^(EAST|SOUTHEAST|SOUTHCENTER)-/, '')}</strong><small>{order.workType || 'Заявка'} · {order.start || '—'}–{order.end || '—'}</small></span><ChevronRight size={16}/></button>) : <p className='building-empty-note'>{selected.schematic ? 'Заявки привязываются к подтверждённому оборудованию.' : 'На выбранный день связанных заявок нет.'}</p>}</section>
        {relatedConditions.length ? <section><h4>Что учесть при выезде</h4>{relatedConditions.map(condition => <div className='building-condition' key={condition.id}><AlertCircle size={16}/><div><strong>{condition.finding || 'Особенность обслуживания'}</strong>{condition.preparation ? <p>{condition.preparation}</p> : null}</div></div>)}</section> : null}
        <section className='building-visits'><h4>Последние работы</h4>{visits.length ? visits.map(visit => <button type='button' key={visit.id} onClick={() => onVisit?.(visit)}><FileText size={18}/><span><strong>{timestamp(visit.endedAt || visit.startedAt)}</strong><small>{visit.finding || visit.workType || 'Визит на объект'}</small></span><ChevronRight size={15}/></button>) : <p className='building-empty-note'>История работ по этой точке пока не записана.</p>}</section>
        <div className='building-detail-footer'><button type='button' className='building-primary' onClick={() => setEditing(true)}><Settings2 size={17}/>Уточнить сведения</button><button type='button' className='building-secondary' onClick={() => downloadModel(model)} aria-label='Скачать описание здания'><ArrowDownToLine size={17}/></button></div>
      </> : <div className='building-load-state'><Building2 size={38}/><h3>Оборудование не размещено</h3><p>Сведения можно дополнить в параметрах здания.</p><button type='button' className='building-primary' onClick={() => setEditing(true)}>Уточнить сведения</button></div>}
      {payload.history.length ? <details className='building-history'><summary>История уточнений · {payload.history.filter(item => item.revision > 0).length}</summary>{payload.history.map(item => <p key={item.revision}><strong>{timestamp(item.changedAt)} · {item.actor}</strong><span>{item.reason}</span></p>)}</details> : null}
    </div>
  </div>;
}
