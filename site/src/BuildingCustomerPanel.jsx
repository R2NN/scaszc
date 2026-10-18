import { House, ArrowUpRight, Layers3 } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { customerOrderNumber } from './buildingCustomers.js';

/** Apartment locator stays independent from the selected cabinet and its linked service history. */
export function BuildingCustomerPanel({ customers, selected, onSelect, onFloor, onOrder }) {
  if (!customers.length) return null;
  return <section className='building-customer-panel'>
    <div className='building-customer-heading'><span><House size={15}/>Клиент по заявке</span>{selected?.source === 'synthetic' ? <small>Демо-привязка</small> : null}</div>
    {customers.length > 1 ? <BusinessSelect ariaLabel='Заявка клиента на схеме' value={selected?.orderId || ''} onChange={onSelect} options={customers.map(customer => ({ value: customer.orderId, label: `№${customerOrderNumber(customer.order)} · ${customer.known ? customer.label : 'Квартира не указана'}` }))}/> : <strong className='building-customer-number'>№{customerOrderNumber(customers[0].order)}</strong>}
    {selected?.known ? <>
      <h3>{selected.label}</h3><p>{selected.section.label} · {selected.floor} этаж</p>
      <div className='building-customer-actions'><button type='button' onClick={() => onFloor(selected)}><Layers3 size={14}/>На плане этажа</button><button type='button' onClick={() => onOrder(selected.order)} aria-label='Открыть заявку клиента'><ArrowUpRight size={15}/></button></div>
    </> : <p className='building-customer-unknown'>{selected?.reason || 'Расположение квартиры не указано'}</p>}
  </section>;
}
