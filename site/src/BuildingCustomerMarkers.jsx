import { customerOrderNumber } from './buildingCustomers.js';
import { sectionPlanPoint } from './buildingGeometry.js';

const points = values => values.map(point => point.map(value => value.toFixed(2)).join(',')).join(' ');

/** A compact locator in the cutaway; the room polygon appears only on the floor plan. */
export function BuildingCustomerMarkers({ customers, selectedOrderId, onSelect, scene, floor, sectionId = 'all', scale = 1, bounds = scene?.viewBox }) {
  const visible = customers.filter(customer => customer.known && (sectionId === 'all' || customer.sectionId === sectionId) && (scene || customer.floor === floor));
  return <g className='building-customer-markers'>{visible.map(customer => {
    const { section, space } = customer;
    const p = ([x, z]) => scene ? scene.project(section.x + x, customer.floor - .95, section.z + z, section) : sectionPlanPoint(section, x, z);
    const polygon = scene ? null : space.polygon.map(p);
    const center = space.polygon.reduce(([x, z], point) => [x + point[0] / space.polygon.length, z + point[1] / space.polygon.length], [0, 0]);
    const anchor = p(center), selected = customer.orderId === selectedOrderId;
    const unit = 1 / scale, markerY = anchor[1] - (scene ? 10 : 0) * unit;
    const fullCaption = `${customer.label} · №${customerOrderNumber(customer.order)}`;
    const caption = fullCaption.length > 36 ? `${fullCaption.slice(0, 35)}…` : fullCaption;
    const captionWidth = (caption.length * 6.2 + 17) * unit;
    const captionX = bounds ? Math.max(bounds[0] + 7 * unit, Math.min(anchor[0] + 14 * unit, bounds[0] + bounds[2] - captionWidth - 7 * unit)) - anchor[0] : 14 * unit;
    const captionY = bounds ? Math.max(bounds[1] + 16 * unit, markerY - 22 * unit) - markerY : -22 * unit;
    const markerSize = 10 * unit;
    return <g key={customer.orderId} className={`building-customer-marker ${selected ? 'is-selected' : ''}`} data-customer-order={customer.orderId} role='button' tabIndex='0' aria-label={`Квартира клиента: ${customer.label}, ${section.label}, ${customer.floor} этаж, заявка ${customerOrderNumber(customer.order)}${customer.source === 'synthetic' ? ', демонстрационная привязка' : ''}`} aria-pressed={selected} onClick={() => onSelect(customer.orderId)} onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect(customer.orderId); } }}>
      {polygon ? <polygon className='building-customer-room' points={points(polygon)} strokeWidth={selected ? '2.3' : '1.5'} vectorEffect='non-scaling-stroke'/> : null}
      <g transform={`translate(${anchor[0]},${markerY})`}>
        <circle className='building-customer-hit' r={22 * unit}/>
        <circle className='building-customer-pin' r={markerSize} strokeWidth='2' vectorEffect='non-scaling-stroke'/>
        <path d={`M ${-5 * unit} ${1 * unit} v ${-4 * unit} l ${5 * unit} ${-4 * unit} l ${5 * unit} ${4 * unit} v ${7 * unit} h ${-10 * unit} v ${-3 * unit} M 0 ${4 * unit} v ${-5 * unit}`} fill='none' stroke='#fff' strokeWidth='1.3' vectorEffect='non-scaling-stroke' strokeLinejoin='round'/>
        {selected && !scene ? <g className='building-customer-caption' transform={`translate(${captionX},${captionY})`}><rect x={-5 * unit} y={-13 * unit} width={captionWidth} height={26 * unit} rx={6 * unit}/><text x={3 * unit} y={4 * unit} style={{ fontSize: 11 * unit }}>{caption}</text></g> : null}
      </g>
      <title>{fullCaption} · {customer.source === 'synthetic' ? 'Демонстрационная привязка квартиры' : 'Расположение по данным заявки'}{scene ? ' · Открыть план этажа' : ''}</title>
    </g>;
  })}</g>;
}
