import { RatingStore, ratingFingerprint } from './ratingStore.mjs';
import { calculateRatingPlan, reassignRatingPlan } from './ratingPlanning.mjs';
import { ensureBaseHistoricalShift } from './baseHistoryStore.mjs';
import { acquirePlanningSlot } from './planningSlot.mjs';
import { calculateStaffingPlan, proposeStaffingTeam, staffingOptions, staffingBreakdown, staffingForecast, loadStaffingForecast } from './staffingPlanning.mjs';

const inputFingerprint = shift => ratingFingerprint({orders:shift.orders,team:shift.team,plan:shift.plan.contentSha256});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
export function createRatingApi(shiftStore, { calculate = calculateRatingPlan, calculateStaffing = calculateStaffingPlan } = {}) {
  const ratings = new RatingStore(shiftStore.db);
  let seed;
  return async request => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/ratings/')) return null;
    try {
      seed ||= ratings.seed(); await seed;
      ratings.syncCompletedVisits();
      const target = url.pathname.slice('/api/ratings/'.length);
      const input = ['POST', 'PATCH'].includes(request.method) ? await request.json() : {};
      ratings.syncRoster(shiftStore.roster(url.searchParams.get('regionId') || input.regionId || 'moscow'));
      if (target === 'engineers' && request.method === 'GET') return json({ engineers: ratings.catalog(url.searchParams.get('regionId') || 'moscow',url.searchParams.get('date')), version: ratings.version(), provenance: 'SYNTHETIC_RATING_HISTORY' });
      if (target === 'staffing' && request.method === 'GET') {
        const regionId = url.searchParams.get('regionId') || 'moscow', date = url.searchParams.get('date');
        const settings = staffingOptions({ qualityFloor: url.searchParams.get('qualityFloor') ?? 4.2, qualityCeiling: url.searchParams.get('qualityCeiling') ?? 5, pool: url.searchParams.get('pool') || 'staff' });
        const shift = shiftStore.byDate(regionId, date), catalog = ratings.catalog(regionId,date), forecast = await loadStaffingForecast();
        const calibration = shiftStore.byDate(regionId, forecast.training.historyEnd);
        return json({ date, settings, version: ratings.version(), orders: shift?.orders.length || 0,
          hasPlan: shift?.plan?.status === 'EXACT_VALID', started: Boolean(shift?.facts?.some(item => ['started','completed'].includes(item.status))),
          sourceRevision: shift?.revision, sourceHash: shift?.plan?.contentSha256,
          breakdown: shift ? staffingBreakdown(shift, catalog, settings) : [],
          forecast: staffingForecast(calibration, catalog, forecast, settings),
          staff: catalog.filter(item => item.kind === 'staff').length, catalog: catalog.length });
      }
      if (target.startsWith('engineers/') && request.method === 'GET') return json(ratings.engineer(decodeURIComponent(target.slice(10))));
      if (target === 'cases' && request.method === 'GET') return json(ratings.cases());
      if (target === 'reviews' && request.method === 'POST') return json(ratings.addReview(input), 201);
      if (target === 'cases' && request.method === 'POST') return json(ratings.createCase(input), 201);
      const caseMatch = /^cases\/([^/]+)(?:\/(messages|decision|reopen|triage))?$/.exec(target);
      if (caseMatch) {
        const [, id, action] = caseMatch;
        if (!action && request.method === 'GET') return json(ratings.case(id));
        if (action === 'messages' && request.method === 'POST') return json(ratings.sendMessage(id, input), 201);
        if (action === 'decision' && request.method === 'POST') return json(ratings.decide(id, input));
        if (action === 'reopen' && request.method === 'POST') return json(ratings.reopen(id));
        if (action === 'triage' && request.method === 'PATCH') return json(ratings.triageCase(id,input));
      }
      if (target === 'scenarios' && request.method === 'GET') return json(ratings.scenarios(url.searchParams.get('regionId') || 'moscow', url.searchParams.get('date')));
      if (target === 'scenarios' && request.method === 'POST') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')) throw new Error('Выберите дату планирования.');
        if (!['all', 'staff'].includes(input.pool)) throw new Error('Выберите состав для расчёта.');
        const shift = input.regionId === 'moscow' ? await ensureBaseHistoricalShift(shiftStore, input.date) : shiftStore.byDate(input.regionId, input.date);
        if (!shift?.plan) throw new Error('Для выбранного дня сначала постройте точный план заявок.');
        const baseline = input.baselineId ? ratings.scenario(input.baselineId) : null;
        if (input.baselineId && (!baseline || baseline.kind !== 'staffing' || baseline.status !== 'READY' || baseline.regionId !== shift.regionId || baseline.date !== shift.date || baseline.sourceHash !== shift.plan.contentSha256 || baseline.sourceRevision !== shift.revision || baseline.ratingVersion !== ratings.version() || baseline.settings.qualityFloor !== Number(input.settings?.qualityFloor) || (baseline.settings.qualityCeiling ?? 5) !== Number(input.settings?.qualityCeiling ?? 5) || baseline.settings.pool !== input.pool)) throw new Error('Исходный состав изменился. Сначала пересчитайте его для сравнения.');
        if (input.kind === 'staffing') {
          const settings = staffingOptions({ ...input.settings, pool: input.pool });
          const proposal = proposeStaffingTeam(shift, ratings.catalog(shift.regionId,shift.date), settings);
          const scenario = ratings.createScenario({ kind: 'staffing', status: 'AWAITING_CONFIRMATION',
            progress: { phase: 'AWAITING_CONFIRMATION' }, regionId: shift.regionId, date: shift.date, pool: input.pool,
            settings, proposal, baselineId: baseline?.id || null, ratingVersion: ratings.version(), sourceRevision: shift.revision, sourceHash: shift.plan.contentSha256, inputFingerprint:inputFingerprint(shift) });
          return json(scenario, 201);
        }
        const release = acquirePlanningSlot();
        if (!release) return json({ error: 'Другой расчёт уже выполняется. Дождитесь его завершения.' }, 429);
        let scenario;
        try { scenario = ratings.createScenario({ regionId: shift.regionId, date: shift.date, pool: input.pool, ratingVersion: ratings.version(), sourceRevision: shift.revision, sourceHash: shift.plan.contentSha256, inputFingerprint:inputFingerprint(shift) }); }
        catch (error) { release(); throw error; }
        Promise.resolve().then(async () => {
          const result = await calculate(shift, ratings.catalog(shift.regionId,shift.date), scenario, progress => ratings.updateScenario(scenario.id, { ...ratings.scenario(scenario.id), progress }));
          ratings.updateScenario(scenario.id, { ...scenario, ...result, status: 'READY', progress: { phase: 'READY' } });
        }).catch(error => ratings.updateScenario(scenario.id, { ...scenario, status: 'FAILED', error: error.message })).finally(release);
        return json(scenario, 202);
      }
      const scenarioMatch = /^scenarios\/([\w-]+)(?:\/(save|reassign|confirm))?$/.exec(target);
      if (scenarioMatch) {
        const scenario = ratings.scenario(scenarioMatch[1]);
        if (!scenario) return json({ error: 'Сценарий не найден.' }, 404);
        if (!scenarioMatch[2] && request.method === 'GET') return json(scenario);
        if (scenarioMatch[2] === 'confirm' && request.method === 'POST') {
          if (scenario.kind !== 'staffing' || scenario.status !== 'AWAITING_CONFIRMATION') throw new Error('Сначала подберите состав для подтверждения.');
          const shift = shiftStore.byDate(scenario.regionId, scenario.date);
          if (!shift || shift.revision !== scenario.sourceRevision || shift.plan?.contentSha256 !== scenario.sourceHash || scenario.ratingVersion !== ratings.version() || scenario.inputFingerprint !== inputFingerprint(shift)) throw new Error('Заявки, состав или оценки изменились. Подберите состав заново.');
          const catalog = ratings.catalog(scenario.regionId,scenario.date);
          const current = proposeStaffingTeam(shift, catalog, scenario.settings);
          if (JSON.stringify(current.team.map(item => item.id)) !== JSON.stringify(scenario.proposal.team.map(item => item.id))) throw new Error('Доступность инженеров изменилась. Подберите состав заново.');
          if (!current.team.length) throw new Error('В диапазоне нет подходящего состава. Измените условия.');
          const release = acquirePlanningSlot();
          if (!release) return json({ error: 'Другой расчёт уже выполняется. Дождитесь его завершения.' }, 429);
          const next = { ...scenario, status: 'RUNNING', confirmedAt: new Date().toISOString(),
            approvedEngineerIds: current.team.map(item => item.id), progress: { phase: 'PREPARING_INPUTS' } };
          try { ratings.updateScenario(next.id, next); } catch (error) { release(); throw error; }
          Promise.resolve().then(async () => {
            const result = await calculateStaffing(shift, catalog, next, progress => ratings.updateScenario(next.id, { ...ratings.scenario(next.id), progress }));
            const baseline = next.baselineId ? ratings.scenario(next.baselineId) : null;
            if(baseline?.staffing && result.staffing)result.staffing.comparison={baselineId:baseline.id,assignedBefore:baseline.staffing.assigned,assignedAfter:result.staffing.assigned,shortageBefore:baseline.staffing.missing.length,shortageAfter:result.staffing.missing.length,engineersBefore:baseline.staffing.selected,engineersAfter:result.staffing.selected};
            ratings.updateScenario(next.id, { ...next, ...result, status: 'READY', progress: { phase: 'READY' } });
          }).catch(error => ratings.updateScenario(next.id, { ...next, status: 'FAILED', error: error.message })).finally(release);
          return json(next, 202);
        }
        if (scenarioMatch[2] === 'reassign' && request.method === 'POST') {
          if (scenario.kind === 'staffing') throw new Error('Для изменения состава задайте условия и выполните новый расчёт. Ручные закрепления рабочего плана защищены.');
          if (scenario.status !== 'READY' || scenario.ratingVersion !== ratings.version()) throw new Error('Сначала пересчитайте актуальный сценарий.');
          const release = acquirePlanningSlot();
          if (!release) return json({ error: 'Другой расчёт уже выполняется.' }, 429);
          let next;
          try { next = ratings.createScenario({ regionId: scenario.regionId, date: scenario.date, pool: scenario.pool,
            ratingVersion: ratings.version(), sourceRevision: scenario.sourceRevision, sourceHash: scenario.sourceHash,
            parentId: scenario.id, orderId: input.orderId, engineerId: input.engineerId }); }
          catch (error) { release(); throw error; }
          Promise.resolve().then(async () => {
            const result = await reassignRatingPlan(scenario, ratings.catalog(scenario.regionId,scenario.date), next);
            ratings.updateScenario(next.id, { ...result, status: 'READY' });
          }).catch(error => ratings.updateScenario(next.id, { ...next, status: 'FAILED', error: error.message })).finally(release);
          return json(next, 202);
        }
        if (scenarioMatch[2] === 'save' && request.method === 'POST') {
          const shift = shiftStore.byDate(scenario.regionId, scenario.date);
          if (shift?.revision !== scenario.sourceRevision || shift?.plan.contentSha256 !== scenario.sourceHash || scenario.inputFingerprint && scenario.inputFingerprint !== inputFingerprint(shift)) throw new Error('Основной план изменился. Пересчитайте сценарий.');
          return json(ratings.saveScenario(scenario.id));
        }
      }
      return json({ error: 'Неизвестный адрес раздела рейтинга.' }, 404);
    } catch (error) { return json({ error: error.message }, /уже измен|изменились|изменился/.test(error.message) ? 409 : /не найден/.test(error.message) ? 404 : 422); }
  };
}
