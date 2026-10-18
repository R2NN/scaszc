import { Check } from 'lucide-react';

/** Opening an incident and acknowledging it remain separate, normally laid out actions. */
export function NotificationActions({ item, onOpen, onRead, toast = false }) {
  return <div className='notification-actions'>
    {item.incidentId ? <button type='button' className={toast ? 'toast-open-incident' : 'notification-open-incident'} onClick={() => onOpen(item)}>Открыть решение</button> : null}
    {item.read ? <em className='notification-read-state'><Check/>Прочитано</em> : <button type='button' className={toast ? 'toast-mark-read' : 'notification-mark-read'} onClick={() => onRead(item.id)} aria-label='Отметить уведомление прочитанным'><Check/><span>Прочитано</span></button>}
  </div>;
}
