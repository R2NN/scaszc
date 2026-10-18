import { ChevronDown, Heart, MapPin, MessageSquare, UserMinus } from 'lucide-react';

const statuses = { preferred: 'Пожелание учтено', avoided: 'Неудачный повтор исключён', not_applied: 'Пожелание не применено', unavoidable: 'Нужна проверка оператора', unassigned: 'Заявка без назначения' };

/** Explain soft customer choices without changing coverage or assignment rules. */
export function CustomerPreferenceSummary({ items = [], results = [], catalog = [], nameFor, loading = false }) {
  const rows = results.length ? results : items;
  const name = id => { const person = catalog.find(item => item.id === id); return person ? nameFor(person) : id; };
  return <details className='customer-preferences'>
    <summary><i className='customer-preference-icon'><MessageSquare size={16}/></i><b>Пожелания клиентов</b>{!loading ? <span className='customer-preference-count'>{rows.length}</span> : null}<ChevronDown className='customer-preference-chevron' size={16}/></summary>
    {!rows.length ? <p className='customer-preference-empty'>{loading ? 'Проверяем пожелания для выбранного дня.' : 'Для выбранного дня отдельных пожеланий нет.'}</p> : <>
      <p className='customer-preference-note'>Учитываем при равных условиях. Покрытие, окна и ручные закрепления сохраняются.</p>
      <div className='customer-preference-list'>{rows.map(item => {
        const avoid = Boolean(item.avoidEngineerIds?.length);
        const Icon = avoid ? UserMinus : Heart;
        return <article key={item.orderId || item.id} className={avoid ? 'is-avoid' : 'is-preferred'}>
          <i className='customer-request-icon'><Icon size={15}/></i>
          <div className='customer-request-copy'>
            <header><b>{item.client || 'Клиент'}</b>{item.synthetic ? <small>Учебный пример</small> : null}</header>
            <span className='customer-request-address'><MapPin size={12}/><span>{item.address}</span></span>
            {item.preferredEngineerIds?.length ? <p className='customer-request-engineer'>Хочет снова <b>{item.preferredEngineerIds.map(name).join(', ')}</b></p> : null}
            {avoid ? <p className='customer-request-engineer'>Просит другого после 1★ <b>{item.avoidEngineerIds.map(name).join(', ')}</b></p> : null}
            {item.status ? <><strong className={`preference-status ${item.status}`} title={item.reason}>{statuses[item.status]}</strong>{item.engineerId && !item.preferredEngineerIds?.includes(item.engineerId) ? <span>В плане: {name(item.engineerId)}</span> : null}{!['preferred', 'avoided'].includes(item.status) ? <p>{item.reason}</p> : null}</> : null}
          </div>
        </article>;
      })}</div>
    </>}
  </details>;
}
