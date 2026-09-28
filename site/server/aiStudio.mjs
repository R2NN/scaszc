import { shiftReportData } from './shiftReport.mjs';

const BEEGO_GUIDE = `Возможности BeeGo: диспетчер видит заявки, бригады, опубликованный план, очередь и ход смены. В «Ходе смены» он может проиграть план (это демонстрация, не факт), вручную отметить начало или итог визита, рассчитать черновик при отмене визита/заявки, недоступности или замене бригады, добавлении заявки/бригады и изменении рабочего времени. Новая версия публикуется только после проверки маршрута по дорогам и ограничений. PDF строится отдельно из сохранённого снимка смены без участия модели. Ты не можешь менять план, записывать факты, публиковать черновик или подтверждать выполнение; для этих действий направь диспетчера к соответствующему экрану. Не называй плановые километры или время фактическими. Если нет отметки, результат визита неизвестен.`;

export async function askShiftAi(shift, question, { apiKey = process.env.YANDEX_AI_API_KEY, folderId = process.env.YANDEX_AI_FOLDER_ID, fetchImpl = fetch, history = [] } = {}) {
  if (!apiKey || !folderId) throw new Error('AI пока не настроен на сервере: нужны YANDEX_AI_API_KEY и YANDEX_AI_FOLDER_ID. PDF-отчёт доступен без AI.');
  const prompt = String(question || '').trim();
  if (!prompt || prompt.length > 500) throw new Error('Введите вопрос длиной до 500 символов.');
  const report = shiftReportData(shift);
  const facts = JSON.stringify({ date: report.date, region: report.regionId, counts: report.counts, crews: report.crews.map(({ name, shift, visits, completed, notCompleted }) => ({ name, shift, visits, completed, notCompleted })), unassigned: report.unassigned.slice(0, 30), failures: report.failures.slice(0, 30), events: report.events.slice(-20) }).slice(0, 12000);
  const context = Array.isArray(history) ? history.slice(-6).filter(item => ['user', 'assistant'].includes(item?.role) && typeof item?.text === 'string').map(item => ({ role: item.role, text: item.text.slice(0, 600) })) : [];
  const response = await fetchImpl('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
    method: 'POST',
    headers: { authorization: `Api-Key ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ modelUri: `gpt://${folderId}/yandexgpt-lite/latest`, completionOptions: { stream: false, temperature: 0.1, maxTokens: '700' }, messages: [
      { role: 'system', text: `Ты помощник диспетчера BeeGo. Отвечай только по переданному снимку смены и справке о продукте. Не придумывай статусы, причины, маршруты или цифры. Если данных недостаточно, скажи об этом. Различай план и факт. Ответ краткий, по-русски. Справка: ${BEEGO_GUIDE}` },
      { role: 'user', text: `Снимок смены: ${facts}` },
      ...context,
      { role: 'user', text: `Вопрос по этому снимку: ${prompt}` },
    ] }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => { throw new Error('AI Studio сейчас недоступен. Данные смены и PDF не изменились.'); });
  if (!response.ok) {
    const fault = await response.json().catch(() => ({}));
    const detail = String(fault?.message || fault?.error?.message || fault?.error || '').replaceAll(apiKey, '[скрыто]').slice(0, 240);
    throw new Error(`AI Studio вернул ошибку ${response.status}${detail ? `: ${detail}` : ''}. Данные смены не изменились.`);
  }
  const payload = await response.json();
  const text = payload?.result?.alternatives?.[0]?.message?.text;
  if (!text) throw new Error('AI Studio не вернул ответ.');
  return { text, usage: payload?.result?.usage || null, source: 'YANDEX_AI_STUDIO', planRevision: shift.revision };
}
