import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Clock3, X } from 'lucide-react';
import { algorithmPhaseLabel, estimateAlgorithmSeconds } from './algorithmProgress.js';
import './algorithm-progress.css';

const formatSeconds = seconds => seconds < 60 ? `${seconds} сек` : `${Math.floor(seconds / 60)} мин ${String(seconds % 60).padStart(2, '0')} сек`;

export function AlgorithmProgress({ activity, onOpen, onDismiss }) {
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setCollapsed(false);
    setNow(Date.now());
  }, [activity?.startedAt]);
  useEffect(() => {
    if (!activity || activity.status !== 'RUNNING') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity?.id, activity?.status]);
  if (!activity) return null;
  const elapsed = Math.max(0, Math.floor(((activity.finishedAt || now) - activity.startedAt) / 1000));
  const previous = estimateAlgorithmSeconds(activity.kind, activity.orderCount);
  const remaining = previous == null ? null : Math.max(0, previous - elapsed);
  const done = activity.status === 'READY';
  const failed = activity.status === 'FAILED';
  return <aside className={`algorithm-progress ${collapsed ? 'is-collapsed' : ''} ${failed ? 'is-failed' : ''}`} role="status" aria-live="polite">
    <div className="algorithm-progress-head"><span className="algorithm-progress-icon">{done ? <Check size={18}/> : failed ? <X size={18}/> : <span className="spinner"/>}</span><div><b>{activity.kind === 'plan' ? 'Планирование дня' : 'Перепланирование смены'}</b><small>{done ? 'Точный расчёт завершён' : failed ? 'Расчёт не завершён' : algorithmPhaseLabel(activity.progress?.phase)}</small></div><button type="button" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? 'Развернуть состояние расчёта' : 'Свернуть состояние расчёта'}>{collapsed ? <ChevronUp size={17}/> : <ChevronDown size={17}/>}</button>{activity.status !== 'RUNNING' ? <button type="button" onClick={onDismiss} aria-label="Закрыть сообщение о расчёте"><X size={17}/></button> : null}</div>
    {!collapsed ? <div className="algorithm-progress-body"><p><Clock3 size={15}/> Прошло: <strong>{formatSeconds(elapsed)}</strong></p>{activity.status === 'RUNNING' ? <p>{remaining == null ? 'Оставшееся время пока нельзя надёжно оценить.' : remaining === 0 ? 'Расчёт длится дольше предыдущих. Оценка уточняется.' : `По предыдущим расчётам такого объёма: ещё около ${formatSeconds(remaining)}.`}</p> : null}{activity.progress?.checkedRoads > 0 && activity.status === 'RUNNING' ? <p>Проверено дорожных участков: {activity.progress.checkedRoads}</p> : null}{failed ? <p className="algorithm-progress-error">{activity.error}</p> : null}<button type="button" onClick={onOpen}>{done ? 'Посмотреть результат' : failed ? 'Открыть раздел' : 'Открыть расчёт'}</button></div> : null}
  </aside>;
}
