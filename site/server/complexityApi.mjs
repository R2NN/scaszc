import { loadObjectArchivePlans } from './objectVisitArchive.mjs';
import { objectAttention } from './complexityAttention.mjs';
import { decideEngineerFeedback, engineerFeedback, engineerFeedbackImpact, saveEngineerFeedback } from './engineerFeedback.mjs';
import { conditionEvidence, matchesConditionWork } from './durationModel.mjs';
import { DEFAULT_MODEL, REASONS, WORK_KINDS, WORK_RULES } from './durationModel.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const contextAt = url => url.searchParams.get('at') || '2026-08-17T07:00:00+03:00';

/** Handle the durable complexity registry and duration policy endpoints. */
export async function handleComplexity(request, registry) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/complexity')) return null;
  try {
    const at = contextAt(url);
    if (!Number.isFinite(Date.parse(at))) throw new Error('Некорректный момент расчёта.');
    const kind = url.searchParams.get('kind') || 'local';
    const allKinds = kind === 'all' && url.pathname === '/api/complexity/objects' && request.method === 'GET';
    if (!allKinds && !Object.hasOwn(WORK_KINDS, kind)) throw new Error('Неизвестный вид работ.');
    if (url.pathname === '/api/complexity/model' && request.method === 'GET') return json({ model: registry.model(), versions: registry.models(), kinds: WORK_KINDS, reasons: REASONS, workRules: WORK_RULES, defaults: DEFAULT_MODEL });
    if (url.pathname === '/api/complexity/model' && request.method === 'POST') return json(registry.saveModel(await request.json()));
    if (url.pathname === '/api/complexity/validate-orders' && request.method === 'POST') {
      const input = await request.json();
      if (!Array.isArray(input.orders)) throw new Error('Передайте список заявок для проверки.');
      const errors = [];
      const orders = input.orders.map((order, index) => {
        try {
          if (!order || typeof order !== 'object' || Array.isArray(order)) throw new Error('Ожидается заявка с полями.');
          return registry.validateServiceOrder(order);
        } catch (error) { errors.push(`Строка ${index + 1}, заявка ${order?.sourceId || order?.id || 'без номера'}: ${error.message}`); return order; }
      });
      return errors.length ? json({ error: errors.join('\n'), details: errors }, 422) : json({ orders });
    }
    if (url.pathname === '/api/complexity/estimate' && request.method === 'POST') {
      const input = await request.json();
      if (!input.order || typeof input.order !== 'object') throw new Error('Передайте заявку для расчёта.');
      const order = input.persist === false ? { ...input.order, durationSnapshot: registry.estimate(input.order, input.asOf || at) } : registry.prepareOrders([input.order], input.asOf || at)[0];
      const applied = new Set(order.durationSnapshot.histories.map(item => item.conditionId));
      const conditions = registry.conditions(order.durationSnapshot.entities.object).filter(item => applied.has(item.id)).map(({ id, finding, preparation }) => ({ id, finding, preparation }));
      return json({ snapshot: order.durationSnapshot, order, conditions });
    }
    if (url.pathname === '/api/complexity/accuracy' && request.method === 'GET') return json(registry.accuracy(at, url.searchParams.get('zone'), url.searchParams.get('regionId') || 'moscow', url.searchParams.get('review') === 'current' ? new Date().toISOString() : at));
    if (url.pathname === '/api/complexity/decisions' && request.method === 'POST') return json(registry.decide(await request.json()));
    const feedbackMatch = /^\/api\/complexity\/visits\/([^/]+)\/feedback(?:\/(impact|decision))?$/.exec(url.pathname);
    if (feedbackMatch) {
      const id = decodeURIComponent(feedbackMatch[1]);
      if (feedbackMatch[2] === 'impact' && request.method === 'GET') return json(engineerFeedbackImpact(registry, id, { at: url.searchParams.get('review') === 'current' ? new Date().toISOString() : at, scope: url.searchParams.get('scope') || undefined }));
      if (feedbackMatch[2] === 'decision' && request.method === 'POST') return json(decideEngineerFeedback(registry, id, await request.json()));
      if (!feedbackMatch[2] && request.method === 'POST') return json(saveEngineerFeedback(registry, id, await request.json()));
    }
    const close = /^\/api\/complexity\/conditions\/([^/]+)$/.exec(url.pathname);
    if (close && request.method === 'PATCH') return json(registry.closeCondition(decodeURIComponent(close[1]), await request.json()));
    const visitMatch = /^\/api\/complexity\/visits\/([^/]+)$/.exec(url.pathname);
    if (visitMatch && request.method === 'PATCH') {
      const input = await request.json();
      return json(registry.reviseVisit(decodeURIComponent(visitMatch[1]), input));
    }
    let readContext;
    const forecasts = new WeakMap();
    const estimateFor = order => {
      if (!forecasts.has(order)) forecasts.set(order, registry.estimate(order, at, false, readContext));
      return forecasts.get(order);
    };
    const objectMatch = /^\/api\/complexity\/objects\/([^/]+)$/.exec(url.pathname);
    const originalExampleFor = object => object.examples?.find(example => {
      try { return allKinds || estimateFor(example).kind === kind; } catch { return false; }
    }) || { id: `PREVIEW-${object.id}-${kind}`, objectId: object.id, serviceEntities: { object: object.id }, workType: WORK_KINDS[allKinds ? 'local' : kind], skill: kind === 'information' ? 'EMERGENCY' : undefined, serviceType: kind === 'information' ? 'Информация' : undefined, sourceData: kind === 'information' ? { bk_type: 'Глобальная проблема', hd_type: 'Информация' } : undefined };
    const exampleFor = object => {
      const example = originalExampleFor(object);
      if (url.searchParams.get('volume') !== 'standard') return example;
      return { ...example, durationFactors: { ...example.durationFactors, devices: 1, points: 1, sites: 1, segments: 1 } };
    };
    if (objectMatch && request.method === 'GET') {
      const object = registry.object(decodeURIComponent(objectMatch[1]));
      if (!object) return json({ error: 'Объект не найден.' }, 404);
      const example = exampleFor(object);
      const estimate = estimateFor(example);
      const reviewAt = url.searchParams.get('review') === 'current' ? new Date().toISOString() : at;
      const visits = registry.visits(reviewAt);
      return json({ reviewAt, object, archivePlans: await loadObjectArchivePlans(object, at), clientLinks: registry.db.prepare('SELECT line_id AS lineId,client_id AS clientId,label FROM service_client_links WHERE object_id=?').all(object.id), feedback: engineerFeedback(registry, object.id).filter(item => Date.parse(item.submittedAt) <= Date.parse(reviewAt)), entities: registry.entities(object.id), estimate, example, visits: visits.filter(visit => visit.entities?.object === object.id && Date.parse(visit.endedAt || visit.startedAt) <= Date.parse(at)).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt))), conditions: registry.conditions(object.id).filter(condition => Date.parse(condition.knownAt) <= Date.parse(reviewAt)).map(condition => ({ ...condition, closedAt: condition.closedAt && Date.parse(condition.closedAt) > Date.parse(reviewAt) ? null : condition.closedAt, relevant: matchesConditionWork(condition, estimate), evidenceCount: conditionEvidence(condition, visits, reviewAt, registry.model(reviewAt)).length, evidence: (condition.evidenceIds || []).map(id => visits.find(visit => visit.id === id)).filter(Boolean).map(visit => ({ ...visit, id: visit.id, objectId: visit.entities.object, address: registry.object(visit.entities.object)?.address, kind: visit.kind, endedAt: visit.endedAt, orderId: visit.orderId, engineerName: visit.engineerName || visit.engineerId, finding: visit.finding })) })), audit: registry.history(object.id).filter(item => Date.parse(item.at) <= Date.parse(reviewAt)), kinds: WORK_KINDS, reasons: REASONS });
    }
    if (url.pathname === '/api/complexity/objects' && request.method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLocaleLowerCase('ru-RU');
      const zone = url.searchParams.get('zone');
      const region = url.searchParams.get('regionId') || 'moscow';
      const allVisits = registry.visits(at);
      readContext = registry.durationReadContext(at, allVisits);
      const attentionVisits = url.searchParams.get('review') === 'current' ? registry.visits(new Date().toISOString()) : allVisits;
      const objects = registry.objects().filter(object => object.regionId === region && (!zone || object.zone === zone || object.zoneId === zone || object.district === zone) && `${object.address} ${object.id}`.toLocaleLowerCase('ru-RU').includes(q));
      return json(objects.map(object => {
        const example = exampleFor(object);
        const estimate = estimateFor(example);
        const visitCount = allVisits.filter(visit => visit.entities?.object === object.id && visit.kind === estimate.kind).length;
        const visits = allVisits.filter(visit => visit.entities?.object === object.id && visit.endedAt && Date.parse(visit.endedAt) <= Date.parse(at) && visit.eligible && !visit.excluded && visit.kind === estimate.kind && visit.operation === estimate.operation);
        const hasRelevantExample = object.examples?.some(item => item.id === example.id);
        const recurring = visits.filter(visit => !['unknown', 'customer', 'other'].includes(visit.reason) && Math.abs(visit.actualTechnical - visit.factorTechnical) >= 8).length >= 3;
        const state = estimate.observationCount ? 'confirmed' : recurring ? 'review' : 'estimated';
        return { attention: objectAttention(object, attentionVisits, at, estimateFor), id: object.id, address: object.address, coords: object.coords, zone: object.zone, zoneId: object.zoneId, district: object.district, total: estimate.total, delta: estimate.total - estimate.baseTechnical - estimate.documents, coefficient: estimate.coefficient, observations: visits.length, visitCount, state, insufficient: !estimate.observationCount && (!hasRelevantExample || visits.length < 3), kind: estimate.kind, estimate, orderIds: object.examples?.map(item => item.id) || [], entities: estimate.entities };
      }));
    }
    return json({ error: 'Неизвестный адрес или метод реестра объектов.' }, 404);
  } catch (error) { return json({ error: error.message }, /уже измен/.test(error.message) ? 409 : 422); }
}
