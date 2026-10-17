import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, MessageSquareText } from 'lucide-react';
import { BusinessSelect } from './BusinessSelect.jsx';
import './engineerFeedback.css';

const SCOPES = { line: 'Эта линия', node: 'Этот узел', entrance: 'Этот подъезд', object: 'Этот дом', client: 'Этот клиент', operation: 'Такой же вид и состав работ' };
const REASONS = { access: 'Доступ на объект', diagnosis: 'Дополнительная диагностика', simpler: 'Работа оказалась проще', extra: 'Дополнительные работы', customer: 'Ожидание клиента', unknown: 'Причина не установлена', other: 'Другое' };
const KINDS = { connection: 'Подключение', local: 'Ремонт и диагностика', equipment: 'Работы с оборудованием', emergency: 'Аварийные работы', information: 'Информация' };
const drafts = new Map();
const number = value => Number.isFinite(value) ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : '—';
const signed = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}`;
const date = value => value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Дата не указана';
const state = (reply, visit, estimate) => reply.status === 'awaiting' ? 'Ждём ответа' : Date.parse(reply.submittedAt) > Date.parse(visit?.knownAt) ? 'Нужно решение' : ({ confirmed: 'Перенос подтверждён', visit: 'Разовый случай', rejected: 'Перенос отклонён' })[visit?.learningDecision] || (reply.source === 'synthetic-feedback-v1' && reply.reason === visit?.reason && estimate?.histories?.some(item => item.evidence?.some(source => source.id === visit?.id)) ? 'Уже учитывается по истории' : 'Нужно решение');

async function request(url, body) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось сохранить ответ');
  return data;
}

/** Prominent passport inbox with engineer replies, reviewed transfer and complete calculation provenance. */
export function EngineerFeedback({ data, kind, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');
  const [scope, setScope] = useState('');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [decisionReason, setDecisionReason] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [allImpact, setAllImpact] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  const visits = new Map((data.visits || []).map(item => [item.id, item]));
  const replies = (data.feedback || []).filter(item => visits.get(item.visitId)?.kind === kind);
  const pending = replies.filter(item => ['Ждём ответа', 'Нужно решение'].includes(state(item, visits.get(item.visitId), data.estimate)));
  const confirmed = replies.filter(item => ['Перенос подтверждён', 'Уже учитывается по истории'].includes(state(item, visits.get(item.visitId), data.estimate)));
  const rows = filter === 'pending' ? pending : filter === 'confirmed' ? confirmed : replies;
  const reply = replies.find(item => item.visitId === selected);
  const visit = visits.get(selected);
  useEffect(() => { setSelected(null); setReport(null); setExpanded(false); setError(''); }, [data.object.id, kind]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setReport(null); setError('');
    const load = async () => { try { const value = await request(`/api/complexity/visits/${encodeURIComponent(selected)}/feedback/impact?review=current${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`); if (live) setReport(value); } catch (issue) { if (live) setError(issue.message); } };
    load();
    return () => { live = false; };
  }, [selected, scope, refresh]);
  const select = item => { setSelected(item.visitId); setScope(item.proposedScope); setEditing(false); setAllImpact(false); setAllHistory(false); setDecisionReason(''); setDraft(drafts.get(item.visitId) || { ...item }); };
  const update = (key, value) => { const next = { ...draft, [key]: value }; drafts.set(selected, next); setDraft(next); };
  const submit = async (path, body) => {
    setBusy(true); setError('');
    try { await request(`/api/complexity/visits/${encodeURIComponent(selected)}/feedback${path}`, { ...body, expectedRevision: reply.revision, at: new Date().toISOString(), actor: 'Диспетчер' }); drafts.delete(selected); setEditing(false); setRefresh(value => value + 1); onChanged(); }
    catch (issue) { setError(issue.message); }
    finally { setBusy(false); }
  };
  return <section className='cx-feedback' aria-label='Обратная связь инженеров'>
    <header><span className='cx-feedback-icon'><MessageSquareText size={21}/></span><div><h3>Обратная связь инженеров</h3><span>{replies.length ? `Ответов: ${replies.length} · требуют решения: ${pending.length}` : 'Отклонений с пояснениями пока нет'}</span></div></header>
    {selected && reply ? <>
      <button type='button' className='cx-feedback-back' onClick={() => { setSelected(null); setReport(null); }}><ArrowLeft size={16}/> Все ответы</button>
      <article className='cx-feedback-message'>
        <div className='cx-feedback-author'><strong>{reply.engineerName}</strong><span>{date(reply.submittedAt)}</span></div>
        <span className={`cx-feedback-state ${visit?.learningDecision === 'confirmed' ? 'is-confirmed' : ''}`}>{state(reply, visit, data.estimate)}</span>
        <div className='cx-feedback-timing'><span>План <b>{visit?.forecast?.total ?? '—'} мин</b></span><ArrowRight size={18}/><span>Факт <b>{visit?.total ?? '—'} мин</b></span><strong className={visit?.total < visit?.forecast?.total ? 'is-faster' : ''}>{Number.isFinite(visit?.total) ? `${signed(visit.total - visit.forecast.total)} мин` : 'Не измерено'}</strong></div>
        <p>{reply.status === 'awaiting' ? 'Ожидается пояснение инженера о причине отклонения.' : reply.comment}</p>
        {reply.finding && reply.repeatability === 'repeat' && !['unknown', 'other'].includes(reply.reason) ? <div className='cx-feedback-finding'><strong>Что учитывать</strong><span>{reply.finding}</span></div> : null}
        {reply.preparation ? <p className='cx-feedback-preparation'>{reply.preparation}</p> : null}
        <small>{visit?.orderLabel || `№${visit?.orderId}`} · {KINDS[visit?.kind]}{reply.source === 'dispatcher' ? ' · записано диспетчером со слов инженера' : ''}</small>
        <button type='button' className='cx-feedback-secondary' onClick={() => setEditing(value => !value)}>{reply.status === 'awaiting' ? 'Записать ответ инженера' : 'Дополнить ответ'}</button>
      </article>
      {editing ? <form className='cx-feedback-form' onSubmit={event => { event.preventDefault(); submit('', draft); }}>
        <h4>Ответ инженера</h4>
        <label>Почему быстрее или дольше<BusinessSelect ariaLabel='Причина в ответе инженера' value={draft.reason} onChange={value => update('reason', value)} options={Object.entries(REASONS).map(([value, label]) => ({ value, label }))}/></label>
        <label>Пояснение<textarea aria-label='Пояснение инженера' required rows={4} value={draft.comment || ''} onChange={event => update('comment', event.target.value)}/></label>
        <label>Повторится ли причина<BusinessSelect ariaLabel='Повторяемость причины' value={draft.repeatability || 'unsure'} onChange={value => update('repeatability', value)} options={[{ value: 'repeat', label: 'Повторяется' }, { value: 'once', label: 'Разовый случай' }, { value: 'unsure', label: 'Пока не знаю' }]}/></label>
        <label>Конкретная особенность<input value={draft.finding || ''} onChange={event => update('finding', event.target.value)}/></label>
        <label>Подготовка к следующему визиту<input value={draft.preparation || ''} onChange={event => update('preparation', event.target.value)}/></label>
        <label>Действует до · для временной причины<input type='datetime-local' value={draft.validUntil ? new Date(Date.parse(draft.validUntil) + 3 * 3600000).toISOString().slice(0, 16) : ''} onChange={event => update('validUntil', event.target.value ? `${event.target.value}:00+03:00` : null)}/></label>
        <button className='cx-feedback-primary' disabled={busy || !draft.comment?.trim()}>Сохранить ответ</button>
      </form> : null}
      {report ? <>
        {report.preview.some(item => item.state === 'applied') ? <div className='cx-feedback-current'><strong>Причина уже учитывается · заявок: {report.preview.filter(item => item.state === 'applied').length}</strong><span>{[...new Set(report.conditions.map(item => SCOPES[item.scope]))].join(' · ')}</span></div> : null}
        <section className='cx-feedback-review'><h4>Как учитывать дальше</h4>
          <label>Где повторяется причина<BusinessSelect ariaLabel='Где учитывать ответ инженера' value={scope || report.reply.proposedScope} onChange={setScope} options={report.scopes.map(value => ({ value, label: SCOPES[value] }))}/></label>
          {scope === 'client' ? <p>{report.client?.label || 'Нет связи с лицевым счётом'}</p> : null}
          <div className={`cx-feedback-recommendation ${report.recommendation.ready ? 'is-ready' : ''}`}><strong>{report.recommendation.ready ? `Рекомендуем ${signed(report.recommendation.minutes)} мин` : report.preview.some(item => item.state === 'applied') ? 'Текущую поправку менять не стоит' : 'Перенос пока не рекомендован'}</strong><span>Сопоставимых измерений: {report.recommendation.count} · инженеров: {report.recommendation.engineers} · дней: {report.recommendation.days}</span>{report.recommendation.reasons.length ? <ul>{report.recommendation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}</div>
          <details><summary>Проверка поправки</summary><p>Сравниваем одинаковый состав работ и подтверждённую область. Пропуски и ручные длительности не обучают модель; выбросы и противоречивые ответы отбрасываются.</p><p>На более поздних визитах ({report.recommendation.validation.testCount}): ошибка без истории — {number(report.recommendation.validation.baselineError)} мин; в сохранённых прогнозах — {number(report.recommendation.validation.referenceError)} мин; с проверяемой поправкой — {number(report.recommendation.validation.adjustedError)} мин. Для оценки использовано {report.recommendation.validation.trainCount} более ранних визитов.</p><p>Поправка учитывается с осторожностью: медиана отклонений × n / (n + {report.recommendation.policy.shrinkage}). Срок наблюдений — {report.recommendation.policy.maxAgeDays} дней; повторные поправки одного этапа не складываются.</p><ul>{report.recommendation.evidence.map(item => <li key={item.id}>{date(item.endedAt)} · {item.engineerName} · {signed(item.residual)} мин</li>)}</ul></details>
          <label>Решение оператора<textarea aria-label='Решение оператора по ответу' rows={2} placeholder='Что проверено и почему принято решение' value={decisionReason} onChange={event => setDecisionReason(event.target.value)}/></label>
          <div className='cx-feedback-decisions'><button type='button' className='cx-feedback-primary' disabled={busy || !decisionReason.trim() || !report.recommendation.ready} onClick={() => submit('/decision', { action: 'confirm', scope, reason: decisionReason })}><Check size={16}/> Учитывать дальше</button><button type='button' disabled={busy || !decisionReason.trim()} onClick={() => submit('/decision', { action: 'visit', scope, reason: decisionReason })}>Только этот визит</button><button type='button' disabled={busy || !decisionReason.trim()} onClick={() => submit('/decision', { action: 'reject', scope, reason: decisionReason })}>Отклонить перенос</button></div>
        </section>
        <details className='cx-feedback-impact' open><summary>Следующий расчёт · заявок: {report.preview.length}</summary><p>Оценка на {date(report.at)}. Сравнение с расчётом без этой причины; сохранённые планы не изменяются.</p>{report.preview.length ? (allImpact ? report.preview : report.preview.slice(0, 3)).map(item => <article key={`${item.objectId}/${item.orderId}`}><strong>№{item.orderId} · {item.address}</strong><span>{KINDS[item.kind]}</span><div><b>{item.before} → {item.after} мин</b><span>{item.state === 'manual' ? 'Ручное время' : item.state === 'insufficient' ? 'Пока без изменения' : item.state === 'proposed' ? 'После подтверждения' : item.state === 'shadowed' ? 'Есть более точная особенность' : 'Учитывается'}</span></div>{Number.isFinite(item.savedMinutes) ? <small>В сохранённой заявке: {item.savedMinutes} мин</small> : null}</article>) : <p>В реестре пока нет подходящих заявок.</p>}{report.preview.length > 3 ? <button type='button' className='cx-feedback-secondary' onClick={() => setAllImpact(value => !value)}>{allImpact ? 'Свернуть заявки' : `Показать все заявки (${report.preview.length})`}</button> : null}</details>
        <details className='cx-feedback-impact'><summary>Измерение уже влияло на расчёты · {report.history.length}</summary>{report.history.length ? (allHistory ? report.history : report.history.slice(0, 3)).map(item => <article key={item.key}><strong>№{item.orderId} · {item.address}</strong><span>{item.source} · {date(item.at)}</span><b>{item.before} → {item.after} мин ({signed(item.delta)})</b><small>Модель: {item.modelVersion}</small></article>) : <p>В сохранённых расчётах это измерение ещё не использовалось.</p>}{report.history.length > 3 ? <button type='button' className='cx-feedback-secondary' onClick={() => setAllHistory(value => !value)}>{allHistory ? 'Свернуть расчёты' : `Все расчёты (${report.history.length})`}</button> : null}</details>
        <details className='cx-feedback-impact'><summary>Полная история ответа и решений</summary>{[
          ...report.revisions.map(item => ({ id: `reply-${item.revision}`, at: item.submittedAt, actor: item.engineerName, title: `Ответ инженера · версия ${item.revision}`, text: item.comment || 'Запрошено пояснение', detail: `Записал: ${item.recordedBy}` })),
          ...report.audit.filter(item => !['ENGINEER_FEEDBACK_RECEIVED', 'ENGINEER_FEEDBACK_REQUESTED'].includes(item.action)).map(item => ({ id: item.id, at: item.at, actor: item.actor, title: item.reason, detail: item.after?.condition ? `Область: ${SCOPES[item.after.condition.scope]}` : null, text: item.after?.condition?.finding || item.after?.finding }))
        ].sort((a, b) => String(b.at).localeCompare(String(a.at))).map(item => <article key={item.id}><strong>{date(item.at)} · {item.actor}</strong><b>{item.title}</b>{item.text ? <p>{item.text}</p> : null}{item.detail ? <small>{item.detail}</small> : null}</article>)}</details>
      </> : !error ? <p role='status'>Проверяем историю и влияние…</p> : null}
      {error ? <p role='alert' className='cx-error'>{error}</p> : null}
    </> : <>
      {expanded ? <div className='cx-feedback-filters'>{[['all', 'Все', replies.length], ['pending', 'Нужно решение', pending.length], ['confirmed', 'Учтено', confirmed.length]].map(([key, label, count]) => <button type='button' key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label} <b>{count}</b></button>)}</div> : null}
      {(expanded ? rows : rows.slice(0, 2)).map(item => { const entry = visits.get(item.visitId), delta = entry.total - entry.forecast.total; return <button className='cx-feedback-row' type='button' key={item.visitId} onClick={() => select(item)}><span><strong>{item.engineerName}</strong><small>{date(entry.endedAt)} · {state(item, entry, data.estimate)}</small><span>{item.status === 'awaiting' ? 'Нужно пояснение отклонения' : item.comment}</span></span><span className={`cx-feedback-delta ${delta < 0 ? 'is-faster' : ''}`}>{signed(delta)} мин<ChevronRight size={16}/></span></button>; })}
      {replies.length ? <button type='button' className='cx-feedback-all' onClick={() => setExpanded(value => !value)}>{expanded ? 'Свернуть ответы' : `Все ответы и влияние на расчёт (${replies.length})`}<ChevronRight size={16}/></button> : null}
    </>}
  </section>;
}
