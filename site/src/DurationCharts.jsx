import { Clock3, TrendingDown } from 'lucide-react';

const number = value => Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : '—';
const dateLabel = value => value.split('-').reverse().slice(0, 2).join('.');
const visitWord = value => ({ one: 'визит', few: 'визита', many: 'визитов', other: 'визита' }[new Intl.PluralRules('ru-RU').select(value)]);

/** Show measured forecast adjustments without presenting them as proven SLA prevention. */
export function DurationImpact({ impact }) {
  const peak = Math.max(1, ...(impact.daily || []).map(item => item.additionalMinutes));
  return <div className='cx-impact-grid'>
    <article className='cx-sla-impact' aria-label='Предотвращено опозданий'>
      <span className='cx-impact-icon'><Clock3 size={24}/></span>
      <h4>Предотвращено опозданий</h4>
      <strong className='cx-sla-pending'>Пока не рассчитано</strong>
      <p>Нет сравнения планов с обычным и адаптивным временем.</p>
      <details><summary>Что нужно для расчёта</summary><p>Сравниваем опоздания к клиентам в двух независимо проверенных расписаниях на одинаковых заявках и дорогах. Учтённые дополнительные минуты не равны предотвращённым опозданиям.</p>{impact.synthetic ? <p>Источник текущей истории — учебная симуляция.</p> : null}</details>
    </article>
    <figure className='cx-week-chart'>
      <figcaption><div><h4>Дополнительное время по дням</h4><p>{dateLabel(impact.startDate)} — {dateLabel(impact.endDate)} · минуты сверх норматива</p></div><strong>{number(impact.additionalMinutes)} <small>мин</small></strong></figcaption>
      <div className='cx-week-bars' aria-label='Дополнительные минуты за семь дней'>
        {(impact.daily || []).map(item => <div className={`cx-week-day${item.comparedVisits ? '' : ' is-empty'}`} key={item.date} tabIndex={0} role='img' aria-label={item.comparedVisits ? `${dateLabel(item.date)}: ${item.additionalMinutes} дополнительных минут, ${item.extendedVisits} визитов с увеличением из ${item.comparedVisits} проверенных` : `${dateLabel(item.date)}: нет проверенных визитов`}>
          <div className='cx-week-track'><span style={{ height: `${item.additionalMinutes / peak * 100}%` }}><b>{item.comparedVisits ? number(item.additionalMinutes) : '—'}</b></span></div>
          <span className='cx-week-date'>{dateLabel(item.date)}</span>
          <span className='cx-chart-tooltip'>{item.comparedVisits ? `${item.extendedVisits} с увеличением · ${item.comparedVisits} проверено` : 'Нет проверенных визитов'}</span>
        </div>)}
      </div>
      <p className='cx-week-footnote'><b>{impact.extendedVisits}</b> {visitWord(impact.extendedVisits)} с увеличенным временем · проверено за неделю: <b>{impact.comparedVisits}</b></p>
      {!impact.comparedVisits ? <p className='cx-muted'>За неделю нет визитов с полным измерением и сохранённым прогнозом.</p> : null}
    </figure>
  </div>;
}

/** Compare both forecasts against the same measured visits using one common minute scale. */
export function DurationErrorChart({ data, kinds }) {
  const rows = data.byKind.filter(item => item.count > 0);
  const maximum = Math.max(1, ...rows.flatMap(item => [item.mae, item.fixedMae]).filter(Number.isFinite));
  const axisMax = Math.ceil(maximum / 5) * 5;
  const reduction = data.fixedMae > 0 ? Math.round((1 - data.mae / data.fixedMae) * 100) : null;
  return <figure className='cx-error-chart'>
    <figcaption><div><h4>Насколько точнее прогноз</h4><p>Средняя ошибка в минутах · меньше — лучше</p></div>{reduction > 0 ? <span className='cx-error-improvement'><TrendingDown size={19}/> На {reduction}% меньше ошибка</span> : null}</figcaption>
    <div className='cx-chart-key'><span><i className='cx-key-baseline'/>Обычный норматив</span><span><i className='cx-key-adaptive'/>С учётом объекта</span></div>
    <div className='cx-error-axis' aria-hidden='true'><span>0</span><span>{number(axisMax / 2)}</span><span>{axisMax} мин</span></div>
    <div className='cx-error-rows'>{rows.map(item => <div className='cx-error-row' key={item.kind}>
      <div className='cx-error-label'><strong>{kinds[item.kind] || item.kind}</strong><span>{item.count} {visitWord(item.count)}</span></div>
      <div className='cx-error-pair'>
        {[['baseline', item.fixedMae, 'Обычный норматив'], ['adaptive', item.mae, 'С учётом объекта']].map(([key, value, label]) => <div className={`cx-error-track is-${key}`} key={key} aria-label={`${label}: ${number(value)} мин`}><span style={{ width: `${Number.isFinite(value) ? value / axisMax * 100 : 0}%` }}/><b>{number(value)}</b></div>)}
      </div>
    </div>)}</div>
    {!rows.length ? <p className='cx-muted'>Нет измеренных визитов для сравнения.</p> : null}
  </figure>;
}
