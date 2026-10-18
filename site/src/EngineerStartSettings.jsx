import { useState } from 'react';
import { BusinessSelect } from './BusinessSelect.jsx';
import { TimePicker } from './TimePicker.jsx';
import { geocodeManualOrder } from './manualGeocoding.js';
import { ratingName } from './engineerPresentation.js';

/** A day-specific, confirmed origin is published only with a newly calculated plan. */
export function EngineerStartSettings({ shift, onDraft }) {
  const [engineerId, setEngineerId] = useState(''), [kind, setKind] = useState('home'), [address, setAddress] = useState('');
  const [point, setPoint] = useState(null), [availableFrom, setAvailableFrom] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const engineer = shift.team.find(item => item.id === engineerId);
  const confirm = async () => {
    setBusy(true);setError('');
    try { const value = await geocodeManualOrder(address, 'moscow', fetch, 'Адрес старта');setPoint({coords:value.coords,address:value.formattedAddress,source:value.geocodeProvider}); }
    catch (e) {setError(e.message);} finally {setBusy(false);}
  };
  const chooseRegistry = id => {
    const order = shift.orders.find(item => item.id === id);
    if (order) {setAddress(order.address);setPoint({coords:order.coords,address:order.address,source:`confirmed-registry:${order.objectId || order.id}`});}
  };
  const configured = kind === 'office' && engineer ? engineer.officeStart || { coords:engineer.startCoords,address:engineer.startAddress } : point;
  return <details className='dispatch-start-settings'><summary>Точка выезда инженера</summary><div className='shift-form'>
    <p className='shift-field-hint'>Откуда инженер начинает маршрут {shift.date.split('-').reverse().join('.')}. Новый старт изменит первую поездку и вступит в силу после публикации пересчитанного плана.</p>
    <label>Инженер<BusinessSelect ariaLabel='Инженер для настройки старта' value={engineerId} searchable options={[{value:'',label:'Выберите инженера'},...shift.team.map(item => ({value:item.id,label:ratingName(item)}))]} onChange={id => {const selected=shift.team.find(item=>item.id===id);setEngineerId(id);setAvailableFrom(selected?.startPoint?.availableFrom || '');setKind(selected?.startPoint?.kind || 'home');setAddress(selected?.startPoint?.address || '');setPoint(selected?.startPoint || null);}}/></label>
    <label>Откуда выезжает<BusinessSelect ariaLabel='Тип стартовой точки' value={kind} options={[{value:'office',label:'Офис'},{value:'home',label:'Из дома'},{value:'confirmed_address',label:'Другой адрес'}]} onChange={setKind}/></label>
    {kind !== 'office' ? <><label>{kind === 'home' ? 'Домашний адрес' : 'Адрес выезда'}<input value={address} onChange={e => {setAddress(e.target.value);setPoint(null);}} placeholder='Москва, улица, номер дома'/></label><button type='button' className='shift-secondary' onClick={confirm} disabled={!address.trim() || busy}>{busy ? 'Проверяем адрес…' : 'Проверить адрес'}</button><BusinessSelect ariaLabel='Выбрать подтверждённый адрес из реестра' value='' searchable options={[{value:'',label:'Выбрать адрес из заявок'},...shift.orders.filter(item => item.coords).map(item => ({value:item.id,label:item.address}))]} onChange={chooseRegistry}/></> : null}
    {configured ? <p>{configured.address} · координаты подтверждены</p> : null}
    <TimePicker value={availableFrom || engineer?.shiftStart || '08:00'} onChange={setAvailableFrom} label='Готов к выезду с'/>
    {error ? <p role='alert'>{error}</p> : null}
    {engineer?.startPoint ? <p>Сохранён старт: {engineer.startPoint.address}{engineer.startPoint.scenario ? ' · адрес задан для сценария' : ''}</p> : null}
    <button type='button' className='shift-primary' disabled={!engineer || !configured || busy} onClick={() => onDraft({type:'START_CHANGED',engineerId,time:'07:00',reason:'Изменение старта до начала дня',startPoint:{...configured,kind,date:shift.date,confirmed:true,source:kind==='office'?'confirmed-office':configured.source,availableFrom:availableFrom || engineer.shiftStart}})}>Подготовить пересчёт маршрута</button>
  </div></details>;
}
