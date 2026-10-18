const statuses = { preferred: 'Пожелание учтено', avoided: 'Неудачный повтор исключён', not_applied: 'Пожелание не применено', unavoidable: 'Нужна проверка оператора', unassigned: 'Заявка без назначения' };

/** Explain soft customer choices and why a safe repeat assignment was unavailable. */
export function CustomerPreferenceSummary({ items = [], results = [], catalog = [], nameFor }) {
  const rows = results.length ? results : items;
  if (!rows.length) return null;
  const name = id => { const person = catalog.find(item => item.id === id); return person ? nameFor(person) : id; };
  return <details className='customer-preferences'>
    <summary>Пожелания клиентов <span>{rows.length}</span></summary>
    <p>Учитываем среди взаимозаменяемых инженеров. Покрытие, окна, время визитов и ручные закрепления сохраняются.</p>
    <div className='customer-preference-list'>{rows.map(item => <article key={item.orderId}>
      <header><b>{item.client || 'Клиент'}</b>{item.synthetic ? <small>Учебный пример</small> : null}</header>
      <span>{item.address}</span>
      {item.preferredEngineerIds.length ? <p>Хочет снова: {item.preferredEngineerIds.map(name).join(', ')}</p> : null}
      {item.avoidEngineerIds.length ? <p>После 1★ просит другого: {item.avoidEngineerIds.map(name).join(', ')}</p> : null}
      {item.status ? <><strong className={`preference-status ${item.status}`}>{statuses[item.status]}</strong>
        {item.engineerId ? <span>В плане: {name(item.engineerId)}</span> : null}<p>{item.reason}</p></> : null}
    </article>)}</div>
  </details>;
}
