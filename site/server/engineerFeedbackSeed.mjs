import { digest } from './durationModel.mjs';
import { engineerFeedback, saveEngineerFeedback } from './engineerFeedback.mjs';
import { ENGINEER_COMMENT_VERSION, engineerVisitComment } from './engineerFeedbackLanguage.mjs';

/** Add varied engineer accounts to existing independent measurements, without regenerating facts or forecasts. */
export function seedEngineerFeedback(registry) {
  return registry.db.transaction(() => {
    for (const object of registry.objects()) for (const line of registry.entities(object.id).filter(item => item.kind === 'line')) {
      const example = object.examples?.find(item => item.serviceEntities?.line === line.id);
      const account = example?.clientId || example?.sourceData?.client_id || example?.sourceData?.customer_id;
      registry.db.prepare('INSERT OR IGNORE INTO service_client_links VALUES (?,?,?,?)').run(object.id, line.id, account ? String(account) : `SYN-ACCOUNT-${digest([object.id, line.id]).slice(0, 12)}`, `Лицевой счёт ${String(account || example?.sourceId || example?.id || digest(line.id)).slice(-5)}`);
    }
    const existing = new Map(registry.objects().flatMap(object => engineerFeedback(registry, object.id).map(item => [item.visitId, item])));
    const updateComment = registry.db.prepare('UPDATE engineer_feedback SET payload_json=? WHERE visit_id=? AND revision=?');
    let added = 0;
    let updated = 0;
    const recent = new Map();
    const visits = registry.visits().filter(item => String(item.source).startsWith('synthetic-')).sort((a, b) => b.knownAt.localeCompare(a.knownAt) || a.id.localeCompare(b.id));
    for (const visit of visits) {
      if (!Number.isFinite(visit.total) || !Number.isFinite(visit.forecast?.total) || visit.total === visit.forecast.total) continue;
      const previous = existing.get(visit.id);
      const key = `${visit.entities.object}/${visit.kind}`;
      const priorComments = recent.get(key) || [];
      const comment = engineerVisitComment(visit, priorComments);
      const remember = text => recent.set(key, [text, ...priorComments].slice(0, 2));
      if (previous) {
        // Correct only untouched fixture prose. Human replies, revisions, review
        // decisions and original measurements remain exactly as recorded.
        if (previous.source === 'synthetic-feedback-v1' && previous.recordedBy === 'Архив обратной связи' && previous.revision === 1 && previous.commentVersion !== ENGINEER_COMMENT_VERSION) {
          updateComment.run(JSON.stringify({ ...previous, comment, commentVersion: ENGINEER_COMMENT_VERSION }), visit.id, previous.revision);
          updated++;
          remember(comment);
        } else {
          remember(previous.comment);
        }
        continue;
      }
      const code = parseInt(digest(visit.id).slice(0, 8), 16);
      const reason = visit.customerMinutes > 0 && visit.reason === 'unknown' ? 'customer' : visit.reason;
      const repeat = !['unknown', 'other', 'customer'].includes(reason) && !visit.excluded;
      const reply = saveEngineerFeedback(registry, visit.id, { at: visit.knownAt, reason, comment, finding: reason === 'customer' ? 'Разовое ожидание клиента; повторяемость не подтверждена' : visit.finding, preparation: visit.preparation, proposedScope: reason === 'customer' ? 'client' : reason === 'access' ? 'node' : code % 5 === 0 ? 'client' : 'line', repeatability: repeat ? 'repeat' : reason === 'customer' || visit.excluded ? 'once' : 'unsure', actor: 'Архив обратной связи' }, { seed: true, seedVisit: visit });
      updateComment.run(JSON.stringify({ ...reply, commentVersion: ENGINEER_COMMENT_VERSION }), visit.id, reply.revision);
      remember(comment);
      added++;
    }
    return { version: ENGINEER_COMMENT_VERSION, added, updated, total: registry.db.prepare('SELECT count(DISTINCT visit_id) AS n FROM engineer_feedback').get().n };
  })();
}
