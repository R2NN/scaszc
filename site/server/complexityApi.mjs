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
    if (url.pathname === '/api/complexity/estimate' && request.method === 'POST') {
      const input = await request.json();
      if (!input.order || typeof input.order !== 'object') throw new Error('Передайте заявку для расчёта.');
      const order = input.persist === false ? { ...input.order, durationSnapshot: registry.estimate(input.order, input.asOf || at) } : registry.prepareOrders([input.order], input.asOf || at)[0];
      return json({ snapshot: order.durationSnapshot, order });
    }
    if (url.pathname === '/api/complexity/accuracy' && request.method === 'GET') return json(registry.accuracy(at, url.searchParams.get('zone'), url.searchParams.get('regionId') || 'moscow'));
    if (url.pathname === '/api/complexity/decisions' && request.method === 'POST') return json(registry.decide(await request.json()));
    const close = /^\/api\/complexity\/conditions\/([^/]+)$/.exec(url.pathname);
    if (close && request.method === 'PATCH') return json(registry.closeCondition(decodeURIComponent(close[1]), await request.json()));
    const visitMatch = /^\/api\/complexity\/visits\/([^/]+)$/.exec(url.pathname);
    if (visitMatch && request.method === 'PATCH') {
      const input = await request.json();
      if (typeof input.excluded !== 'boolean' || !input.reason?.trim()) throw new Error('Укажите исключение факта и причину.');
      const visit = registry.visits(input.at).find(item => item.id === decodeURIComponent(visitMatch[1]));
      if (!visit || !Number.isFinite(Date.parse(input.at)) || Date.parse(input.at) < Date.parse(visit.knownAt)) throw new Error('Визит не найден или время исправления неверно.');
      return json(registry.db.transaction(() => registry.recordVisit({ ...visit, excluded: input.excluded, knownAt: input.at }, input.reason, input.actor))());
    }
    const objectMatch = /^\/api\/complexity\/objects\/([^/]+)$/.exec(url.pathname);
    const originalExampleFor = object => object.examples?.find(example => {
      try { return allKinds || registry.estimate(example, at).kind === kind; } catch { return false; }
    }) || { id: `PREVIEW-${object.id}-${kind}`, objectId: object.id, serviceEntities: { object: object.id }, workType: WORK_KINDS[allKinds ? 'local' : kind], skill: kind === 'information' ? 'LOCAL' : undefined, serviceType: kind === 'information' ? 'Информация' : undefined, sourceData: kind === 'information' ? { bk_type: 'Глобальная проблема', hd_type: 'Информация' } : undefined };
    const exampleFor = object => {
      const example = originalExampleFor(object);
      if (url.searchParams.get('volume') !== 'standard') return example;
      return { ...example, durationFactors: { ...example.durationFactors, devices: 1, points: 1, sites: 1, segments: 1 } };
    };
    if (objectMatch && request.method === 'GET') {
      const object = registry.object(decodeURIComponent(objectMatch[1]));
      if (!object) return json({ error: 'Объект не найден.' }, 404);
      const example = exampleFor(object);
      return json({ object, entities: registry.entities(object.id), estimate: registry.estimate(example, at), example, visits: registry.visits(at, object.id).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt))), conditions: registry.conditions(object.id).filter(condition => Date.parse(condition.knownAt) <= Date.parse(at)).map(condition => condition.closedAt && Date.parse(condition.closedAt) > Date.parse(at) ? { ...condition, closedAt: null } : condition), audit: registry.history(object.id).filter(item => Date.parse(item.at) <= Date.parse(at)), kinds: WORK_KINDS, reasons: REASONS });
    }
    if (url.pathname === '/api/complexity/objects' && request.method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLocaleLowerCase('ru-RU');
      const zone = url.searchParams.get('zone');
      const region = url.searchParams.get('regionId') || 'moscow';
      const allVisits = registry.visits(at);
      const objects = registry.objects().filter(object => object.regionId === region && (!zone || object.zone === zone || object.zoneId === zone || object.district === zone) && `${object.address} ${object.id}`.toLocaleLowerCase('ru-RU').includes(q));
      return json(objects.map(object => {
        const example = exampleFor(object);
        const estimate = registry.estimate(example, at);
        const visitCount = allVisits.filter(visit => visit.entities?.object === object.id && visit.kind === estimate.kind).length;
        const visits = allVisits.filter(visit => visit.entities?.object === object.id && visit.endedAt && Date.parse(visit.endedAt) <= Date.parse(at) && visit.eligible && !visit.excluded && visit.kind === estimate.kind && visit.operation === estimate.operation);
        const hasRelevantExample = object.examples?.some(item => item.id === example.id);
        const recurring = visits.filter(visit => !['unknown', 'customer', 'other'].includes(visit.reason) && Math.abs(visit.actualTechnical - visit.factorTechnical) >= 8).length >= 3;
        const state = estimate.observationCount ? 'confirmed' : recurring ? 'review' : 'estimated';
        return { id: object.id, address: object.address, coords: object.coords, zone: object.zone, zoneId: object.zoneId, district: object.district, total: estimate.total, delta: estimate.total - estimate.baseTechnical - estimate.documents, coefficient: estimate.coefficient, observations: visits.length, visitCount, state, insufficient: !hasRelevantExample || visits.length < 3, kind: estimate.kind, estimate, orderIds: object.examples?.map(item => item.id) || [], entities: estimate.entities };
      }));
    }
    return json({ error: 'Неизвестный адрес или метод реестра объектов.' }, 404);
  } catch (error) { return json({ error: error.message }, /уже измен/.test(error.message) ? 409 : 422); }
}
