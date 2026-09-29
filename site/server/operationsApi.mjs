import { ShiftStore } from './shiftStore.mjs';
import { eventModel, normalizeDataAdditionEvent } from '../src/shiftDomain.js';
import { exactShiftReplan } from './exactShiftReplan.mjs';
import { createShiftPdf, shiftReportData } from './shiftReport.mjs';
import { reportMode } from './dispatcherPdf.mjs';
import { askShiftAi } from './aiStudio.mjs';
import { seedBaseShift } from './seedBaseShift.mjs';
import { baseHistoryDates, ensureBaseHistoricalShift } from './baseHistoryStore.mjs';
import { acquirePlanningSlot, planningBusyResponse } from './planningSlot.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bodyOf = async request => request.json().catch(() => ({}));
const errorStatus = error => /устарел|уже изменился/.test(error.message) ? 409 : /не найден/.test(error.message) ? 404 : 422;

export function createOperationsApi({ store = new ShiftStore(), routing = exactShiftReplan, routingOptions = {}, ai = askShiftAi, aiOptions = {}, seedFromBase = false } = {}) {
  const seedPromise = seedFromBase ? seedBaseShift(store) : Promise.resolve();
  const aiCalls = new Map();
  const aiLimit = Math.max(1, Math.min(100, Number(process.env.BEEGO_AI_MAX_PER_HOUR || 10)));
  const monthlyTokenLimit = Math.max(6000, Number(process.env.BEEGO_AI_MONTHLY_TOKEN_BUDGET || 240000));
  const tokenReservation = 6000;
  const limitedAi = async (shift, question, history = []) => {
    if (!shift?.plan) throw new Error('Для ответа AI нужен сохранённый план смены.');
    const key = shift.id;
    const recent = (aiCalls.get(key) || []).filter(stamp => Date.now() - stamp < 3_600_000);
    if (recent.length >= aiLimit) throw new Error('Лимит AI-запросов за час достигнут. Отчёт PDF остаётся доступен.');
    const month = new Date().toISOString().slice(0, 7);
    if (!store.reserveAiBudget(month, tokenReservation, monthlyTokenLimit)) throw new Error('Месячный лимит AI-запросов достигнут. Отчёт PDF остаётся доступен.');
    recent.push(Date.now());
    aiCalls.set(key, recent);
    try {
      const result = await ai(shift, question, { ...aiOptions, history });
      const reported = Number(result?.usage?.totalTokens) || Number(result?.usage?.inputTextTokens || 0) + Number(result?.usage?.completionTokens || 0);
      const fallback = Math.ceil((String(question).length + JSON.stringify(history).length + String(result?.text || '').length + 12000) / 2);
      store.settleAiBudget(month, tokenReservation, reported > 0 ? reported : fallback);
      return result;
    } catch (error) {
      store.settleAiBudget(month, tokenReservation, 0);
      throw error;
    }
  };
  async function handle(request) {
    await seedPromise;
    const url = new URL(request.url);
    if (url.pathname === '/api/base-data/status' && request.method === 'GET') {
      const dates = await baseHistoryDates();
      const storedDays = store.db.prepare("SELECT count(*) AS total FROM shifts WHERE region_id = 'moscow' AND current_plan_id IS NOT NULL").get().total;
      return json({ source: 'FIRST_ARCHIVE', days: dates.length, firstDate: dates[0], lastDate: dates.at(-1), storedDays });
    }
    if (url.pathname.startsWith('/api/previews/') && request.method === 'GET') return preview(request);
    if (url.pathname === '/api/staff/engineers' && request.method === 'GET') return json(store.roster(url.searchParams.get('regionId')));
    if (url.pathname === '/api/staff/engineers' && request.method === 'POST') {
      try { const input = await bodyOf(request); return json(store.addStaff(input.engineer, input.activeFrom), 201); }
      catch (error) { return json({ error: error.message }, errorStatus(error)); }
    }
    const staffAction = /^\/api\/staff\/engineers\/([^/]+)\/(archive|restore)$/.exec(url.pathname);
    if (staffAction && request.method === 'PATCH') {
      try { const input = await bodyOf(request); return json(store.changeStaffAvailability(decodeURIComponent(staffAction[1]), input.regionId, input.date, staffAction[2])); }
      catch (error) { return json({ error: error.message }, errorStatus(error)); }
    }
    if (!url.pathname.startsWith('/api/shifts')) return null;
    try {
      if (url.pathname === '/api/shifts/history' && request.method === 'GET') {
        if (url.searchParams.get('regionId') === 'moscow') {
          const dates = (await baseHistoryDates()).filter(date => date <= (url.searchParams.get('throughDate') || '')).slice(-12);
          for (const date of dates) await ensureBaseHistoricalShift(store, date);
        }
        const history = store.history(url.searchParams.get('regionId'), url.searchParams.get('throughDate'), 12);
        return json(history.map(shift => {
          const report = shiftReportData(shift);
          return { id: shift.id, date: shift.date, revision: shift.revision, hasFact: report.hasFact, counts: report.counts, analysis: { assignmentRate: report.analysis.assignmentRate, completionRate: report.analysis.completionRate } };
        }));
      }
      if (url.pathname === '/api/shifts/report-archive' && request.method === 'GET') {
        return json(store.reportArchive(url.searchParams.get('regionId'), url.searchParams.get('throughDate')));
      }
      if (url.pathname === '/api/shifts' && request.method === 'GET') {
        const shift = url.searchParams.get('regionId') === 'moscow'
          ? await ensureBaseHistoricalShift(store, url.searchParams.get('date'))
          : store.byDate(url.searchParams.get('regionId'), url.searchParams.get('date'));
        return shift ? json(shift) : json({ error: 'Смена ещё не создана.' }, 404);
      }
      if (url.pathname === '/api/shifts' && request.method === 'POST') return json(store.ensure(await bodyOf(request)));
      const match = /^\/api\/shifts\/([^/]+)(?:\/(preview|publish|facts|rollback|report|report-data|ai\/summary|ai\/question|ai\/status))?$/.exec(url.pathname);
      if (!match) return json({ error: 'Неизвестный адрес API.' }, 404);
      const [, shiftId, action] = match;
      if (!action && request.method === 'GET') {
        const shift = store.get(shiftId);
        return shift ? json(shift) : json({ error: 'Смена не найдена.' }, 404);
      }
      if (action === 'preview' && request.method === 'GET') {
        const preview = store.latestPreview(shiftId);
        return preview ? json(preview) : json({ error: 'Черновик не найден.' }, 404);
      }
      if (action === 'preview' && request.method === 'DELETE') {
        const input = await bodyOf(request);
        return json(store.discardPreview(shiftId, input.previewId, Number(input.expectedRevision)));
      }
      if (action === 'preview' && request.method === 'POST') {
        const input = await bodyOf(request);
        const shift = store.get(shiftId);
        if (!shift) return json({ error: 'Смена не найдена.' }, 404);
        const release = acquirePlanningSlot();
        if (!release) return planningBusyResponse();
        try {
          const event = normalizeDataAdditionEvent(shift, input.event);
          const model = eventModel(shift, event);
          const id = store.startPreview(shiftId, Number(input.expectedRevision), event);
          Promise.resolve().then(async () => {
            const plan = await routing(shift, model, progress => store.updatePreviewProgress(id, progress));
            store.completePreview(id, { orders: model.orders, team: model.team, plan });
          }).catch(error => store.failPreview(id, error)).finally(release);
          return json({ id, status: 'RUNNING' }, 202);
        } catch (error) {
          release();
          throw error;
        }
      }
      if (action === 'publish' && request.method === 'POST') {
        const input = await bodyOf(request);
        return json(store.publish(shiftId, input.previewId, Number(input.expectedRevision), input.actor));
      }
      if (action === 'facts' && request.method === 'POST') {
        const input = await bodyOf(request);
        return json(store.recordFact(shiftId, input, input.actor));
      }
      if (action === 'rollback' && request.method === 'POST') {
        const input = await bodyOf(request);
        return json(store.rollback(shiftId, input.targetPlanId, Number(input.expectedRevision), input.actor, input.time));
      }
      if (action === 'report-data' && request.method === 'GET') {
        const shift = store.get(shiftId);
        const previous = store.history(shift?.regionId, shift?.date, 2).find(item => item.date < shift.date);
        return json({ ...shiftReportData(shift), comparison: previous ? shiftReportData(previous) : null });
      }
      if (action === 'ai/status' && request.method === 'GET') return json({ configured: Boolean(aiOptions.apiKey || process.env.YANDEX_AI_API_KEY) && Boolean(aiOptions.folderId || process.env.YANDEX_AI_FOLDER_ID), budget: { month: new Date().toISOString().slice(0, 7), ...store.aiUsage(new Date().toISOString().slice(0, 7)), limit: monthlyTokenLimit } });
      if (action === 'report' && request.method === 'POST') {
        const shift = store.get(shiftId);
        if (!shift?.plan) throw new Error('Для отчёта нужен сохранённый план смены.');
        const input = await bodyOf(request);
        const author = String(input.author || 'Диспетчер').slice(0, 120);
        const generatedAt = new Date().toISOString();
        const pdf = await createShiftPdf(shift, null, { origin: url.origin, generatedAt, author });
        const artifact = store.saveReportArtifact({ shift, mode: reportMode(shift), author, generatedAt, pdf });
        return json({ ...artifact, url: `/api/shifts/${shift.id}/report?artifactId=${artifact.id}` }, 201);
      }
      if (action === 'report' && request.method === 'GET') {
        const shift = store.get(shiftId);
        if (!shift?.plan) throw new Error('Для отчёта нужен сохранённый план смены.');
        const artifactId = url.searchParams.get('artifactId');
        if (artifactId) {
          const artifact = store.reportArtifact(artifactId);
          if (!artifact || artifact.shiftId !== shiftId) return json({ error: 'Сохранённый PDF не найден.' }, 404);
          return new Response(artifact.pdf, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'content-disposition': `inline; filename="beego-${artifact.date}-${artifact.mode}.pdf"` } });
        }
        const previous = store.history(shift?.regionId, shift?.date, 2).find(item => item.date < shift.date);
        const pdf = await createShiftPdf(shift, previous ? shiftReportData(previous) : null, { origin: url.origin });
        return new Response(pdf, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'content-disposition': 'inline; filename="beego-shift.pdf"' } });
      }
      if (action === 'ai/summary' && request.method === 'POST') return json(await limitedAi(store.get(shiftId), 'Сформулируй 3–4 главных вывода по текущей смене с конкретными числами.'));
      if (action === 'ai/question' && request.method === 'POST') { const input = await bodyOf(request); return json(await limitedAi(store.get(shiftId), input.question, input.history)); }
      return json({ error: 'Метод не поддерживается.' }, 405);
    } catch (error) {
      return json({ error: error?.message || 'Ошибка смены.' }, errorStatus(error));
    }
  }

  async function preview(request) {
    const id = new URL(request.url).pathname.split('/').at(-1);
    const result = store.preview(id);
    return result ? json(result) : json({ error: 'Черновик не найден.' }, 404);
  }

  return { handle, preview, store };
}
