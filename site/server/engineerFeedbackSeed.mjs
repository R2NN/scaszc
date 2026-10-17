import { digest } from './durationModel.mjs';
import { engineerFeedback, saveEngineerFeedback } from './engineerFeedback.mjs';

const variants = {
  access: [
    'Ответственного за техническое помещение вызвали через диспетчера УК. Ожидание отмечено отдельно от ремонта.',
    'Ключ от шкафа выдали после согласования допуска. Само оборудование обслужил без дополнительного объёма.',
    'Сначала подтвердил наряд у ответственного за помещение, затем получил доступ к узлу.',
    'До открытия технической комнаты к работе приступить не мог. Время ожидания записал в этап «Доступ».',
  ],
  diagnosis: [
    'После настройки повторил проверку под нагрузкой: без неё нестабильный контакт не проявляется.',
    'Первый тест был нормальным, при повторной проверке обнаружился тот же плавающий сбой.',
    'Основное время заняла проверка устойчивости соединения после восстановления контакта.',
    'Поиск начал с предыдущего места неисправности. Потребовалась повторная диагностика этой линии.',
  ],
  simpler: [
    'Линия подписана, ввод пригоден. Повторный поиск трассы не понадобился; результат проверил.',
    'Воспользовался подтверждённой маркировкой. Дополнительных работ не было, поэтому закончил раньше.',
    'Существующее подключение оказалось исправным. После проверки использовал готовую линию.',
    'Нужный порт удалось определить по сохранённой маркировке, без перебора соседних линий.',
  ],
  customer: [
    'Клиент подошёл после звонка. Это отдельное ожидание; постоянную проблему по одному визиту не подтверждаю.',
    'До начала оформления ждал клиента. На техническую работу это время не относил.',
    'Клиент освободился позже согласованного времени. Для переноса на следующие визиты нужны повторные подтверждения.',
  ],
  unknown: [
    'План и фактическое время различаются. Этапы отметил, но устойчивую причину по этому визиту установить не могу.',
    'Отклонение подтверждаю по времени наряда. Оснований менять норматив для всех заказов в доме пока нет.',
    'Работа завершена с другим временем, чем ожидалось. Без повторных наблюдений переносить разницу не предлагаю.',
    'Фактическую длительность записал. Подтверждённого объяснения для будущих заказов у меня пока нет.',
  ],
};

/** Add varied engineer accounts to existing independent measurements, without regenerating facts or forecasts. */
export function seedEngineerFeedback(registry) {
  return registry.db.transaction(() => {
    for (const object of registry.objects()) for (const line of registry.entities(object.id).filter(item => item.kind === 'line')) {
      const example = object.examples?.find(item => item.serviceEntities?.line === line.id);
      const account = example?.clientId || example?.sourceData?.client_id || example?.sourceData?.customer_id;
      registry.db.prepare('INSERT OR IGNORE INTO service_client_links VALUES (?,?,?,?)').run(object.id, line.id, account ? String(account) : `SYN-ACCOUNT-${digest([object.id, line.id]).slice(0, 12)}`, `Лицевой счёт ${String(account || example?.sourceId || example?.id || digest(line.id)).slice(-5)}`);
    }
    const existing = new Set(registry.objects().flatMap(object => engineerFeedback(registry, object.id).map(item => item.visitId)));
    let added = 0;
    for (const visit of registry.visits().filter(item => String(item.source).startsWith('synthetic-'))) {
      if (existing.has(visit.id) || !Number.isFinite(visit.total) || !Number.isFinite(visit.forecast?.total) || visit.total === visit.forecast.total) continue;
      const code = parseInt(digest(visit.id).slice(0, 8), 16);
      const reason = visit.customerMinutes > 0 && visit.reason === 'unknown' ? 'customer' : visit.reason;
      const messages = variants[reason] || variants.unknown;
      const delta = visit.total - visit.forecast.total;
      const timing = `Наряд ${visit.orderId}: план ${visit.forecast.total} мин, факт ${visit.total} мин (${delta > 0 ? '+' : '−'}${Math.abs(delta)}).`;
      const measured = `Работа ${visit.actualTechnical} мин${visit.accessMinutes ? `, доступ ${visit.accessMinutes} мин` : ''}${visit.customerMinutes ? `, ожидание клиента ${visit.customerMinutes} мин` : ''}${visit.documentMinutes ? `, оформление ${visit.documentMinutes} мин` : ''}.`;
      const repeat = !['unknown', 'other', 'customer'].includes(reason) && !visit.excluded;
      saveEngineerFeedback(registry, visit.id, { at: visit.knownAt, reason, comment: `${messages[code % messages.length]} ${timing} ${measured}`, finding: reason === 'customer' ? 'Разовое ожидание клиента; повторяемость не подтверждена' : visit.finding, preparation: visit.preparation, proposedScope: reason === 'customer' ? 'client' : reason === 'access' ? 'node' : code % 5 === 0 ? 'client' : 'line', repeatability: repeat ? 'repeat' : reason === 'customer' || visit.excluded ? 'once' : 'unsure', actor: 'Архив обратной связи' }, { seed: true, seedVisit: visit });
      added++;
    }
    return { version: 'engineer-feedback-v1', added, total: registry.db.prepare('SELECT count(DISTINCT visit_id) AS n FROM engineer_feedback').get().n };
  })();
}
