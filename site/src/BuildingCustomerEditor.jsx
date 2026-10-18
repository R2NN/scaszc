import { Plus, X } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { floorPlanAt } from './buildingInterior.js';
import { customerOrderNumber } from './buildingCustomers.js';

const spacesAt = (section, floor) => floorPlanAt(section, floor).spaces.filter(space => ['apartment', 'office'].includes(space.kind));

/** Explicit apartment mapping for imported/new orders, kept in the versioned building model. */
export function BuildingCustomerEditor({ draft, setDraft, orders }) {
  const rows = draft.customerLocations || [];
  const available = orders.filter(order => !rows.some(row => row.orderId === String(order.id)));
  const update = (index, patch) => setDraft(current => ({ ...current, customerLocations: current.customerLocations.map((row, i) => i === index ? { ...row, ...patch, source: 'operator' } : row) }));
  const add = () => {
    const order = available[0];
    if (!order) return;
    let section = draft.sections[0], floor = 1;
    outer: for (const item of draft.sections) for (let level = 1; level <= item.floors; level++) if (spacesAt(item, level).length) { section = item; floor = level; break outer; }
    const space = spacesAt(section, floor)[0];
    if (!space) return;
    setDraft(current => ({ ...current, customerLocations: [...(current.customerLocations || []), { orderId: String(order.id), sectionId: section.id, floor, spaceId: space.id, unit: '', source: 'operator' }] }));
  };
  return <details className='building-customer-editor'><summary>Квартиры клиентов <span>{rows.length}</span></summary>
    {rows.map((row, index) => {
      const section = draft.sections.find(item => item.id === row.sectionId), order = orders.find(item => String(item.id) === row.orderId), spaces = section ? spacesAt(section, row.floor) : [];
      return <div className='building-customer-edit-row' key={row.orderId}>
        <div><strong>№{order ? customerOrderNumber(order) : row.orderId}</strong><button type='button' aria-label={`Удалить привязку квартиры ${index + 1}`} className='building-icon-button' onClick={() => setDraft(current => ({ ...current, customerLocations: current.customerLocations.filter((_, i) => i !== index) }))}><X size={14}/></button></div>
        <BusinessSelect ariaLabel={`Секция квартиры ${index + 1}`} value={row.sectionId} onChange={id => {
          const next = draft.sections.find(item => item.id === id), floor = Math.min(row.floor, next.floors);
          update(index, { sectionId: id, floor, spaceId: spacesAt(next, floor)[0]?.id || '' });
        }} options={draft.sections.map(item => ({ value: item.id, label: item.label }))}/>
        <div className='building-customer-edit-fields'><label>Этаж<input type='number' min='1' max={section?.floors || 180} value={row.floor} onChange={event => { const floor = Number(event.target.value); update(index, { floor, spaceId: section ? spacesAt(section, floor)[0]?.id || '' : '' }); }}/></label><label>Квартира / помещение<input maxLength='40' value={row.unit} onChange={event => update(index, { unit: event.target.value })}/></label></div>
        {spaces.length ? <BusinessSelect ariaLabel={`Помещение квартиры ${index + 1}`} value={row.spaceId} onChange={spaceId => update(index, { spaceId })} options={spaces.map(space => ({ value: space.id, label: space.label || space.id }))}/> : <p className='building-empty-note'>На этом уровне нет квартиры или помещения. Уточните этаж или планировку.</p>}
        <small>{row.source === 'synthetic' ? 'Демонстрационная привязка' : 'Указано оператором / импортировано'}</small>
      </div>;
    })}
    {available.length ? <button type='button' className='building-secondary' onClick={add}><Plus size={14}/>Добавить квартиру по заявке</button> : rows.length ? null : <p className='building-empty-note'>На выбранный день нет заявок этого объекта.</p>}
  </details>;
}
