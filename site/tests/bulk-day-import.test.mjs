import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import XLSX from 'xlsx';
import { DEFAULT_REGION } from '../src/regions.js';
import { resolveImportedDate } from '../src/importDate.js';
import { parseWorkNorms, workDurationFor } from '../src/workNorms.js';

const normsPath = new URL('../public/data/work-norms.xlsx', import.meta.url);

test('system work norms exclude travel and preserve technical and document time', async () => {
  const workbook = XLSX.read(await readFile(normsPath), { type: 'buffer' });
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: true });
  const norms = parseWorkNorms(matrix);
  assert.deepEqual(Object.fromEntries(Object.entries(norms).map(([type, item]) => [type, item.serviceMinutes])), {
    connection: 70, emergency: 80, upgrade: 20, local: 30,
  });
  assert.equal(workDurationFor({ workType: 'Подключение' }, norms, '999'), 70);
  assert.equal(workDurationFor({ workType: 'Неизвестный вид' }, norms, ''), null);
  assert.throws(() => parseWorkNorms(matrix.map((row, index) => index === 1 ? [row[0], row[1], '', row[3], row[4]] : row)),
    /Не заполнены составляющие норматива/);
});

test('district files merge with different ID and window headings before one review', async () => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false } });
  const originalFetch = globalThis.fetch;
  try {
    const { parseImportFiles, parseReplanningOrderFile, buildOrders, validateRows, autoMapHeaders,
      unmatchedWorkNorms } = await vite.ssrLoadModule('/src/ImportWorkspace.jsx');
    const normsBytes = await readFile(normsPath);
    globalThis.fetch = async url => {
      assert.equal(url, '/data/work-norms.xlsx');
      return new Response(normsBytes, { status: 200 });
    };
    const files = [
      new File(['Номер обращения;Время начала;Время окончания;Тип работ;Адрес\nR-1;10:00;12:00;Подключение;Москва Тверская 1'], 'Север.csv'),
      new File(['Ticket ID;Visit start;Visit end;Work type;Address\nE-2;13:00;15:00;EMERGENCY;Москва Арбат 2'], 'Юг.csv'),
    ];
    const session = await parseImportFiles(files);
    const dataset = session.datasets.orders;
    assert.equal(dataset.rows.length, 2);
    assert.deepEqual(session.sourceFiles.map(file => file.fileName), ['Север.csv', 'Юг.csv']);
    assert.equal(validateRows(dataset.rows, dataset.savedMappings, 'orders', session.workNorms).size, 0);
    const orders = buildOrders(dataset.headers, dataset.rows, dataset.savedMappings, DEFAULT_REGION, session.workNorms);
    assert.deepEqual(orders.map(order => [order.sourceId, order.start, order.end, order.duration, order.durationSource]), [
      ['R-1', '10:00', '12:00', 70, 'Нормативы.xlsx'],
      ['E-2', '13:00', '15:00', 80, 'Нормативы.xlsx'],
    ]);
    const rangeHeaders = ['Номер', 'Окно заявки', 'Тип работ', 'Адрес'];
    const rangeMappings = autoMapHeaders(rangeHeaders);
    const rangeRows = [['R-3', '09:30–11:00', 'Локальная заявка', 'Москва Ленина 3']];
    assert.equal(validateRows(rangeRows, rangeMappings, 'orders', session.workNorms).size, 0);
    const [rangeOrder] = buildOrders(rangeHeaders, rangeRows, rangeMappings, DEFAULT_REGION, session.workNorms);
    assert.deepEqual([rangeOrder.sourceId, rangeOrder.start, rangeOrder.end, rangeOrder.duration], ['R-3', '09:30', '11:00', 30]);
    assert.ok(validateRows([['R-4', '09:30–11:00', 'Неизвестная работа', 'Москва Ленина 4']], rangeMappings,
      'orders', session.workNorms).size > 0);
    const datedHeaders = ['Номер заявки', 'Начало', 'Окончание', 'Тип работ', 'Адрес'];
    const datedMappings = autoMapHeaders(datedHeaders);
    const datedRows = [['R-5', '28.09.2026 12:00', '28.09.2026 14:00', 'Подключение', 'Москва Ленина 5']];
    assert.equal(validateRows(datedRows, datedMappings, 'orders', session.workNorms).size, 0,
      JSON.stringify({ mappings: datedMappings, invalid: [...validateRows(datedRows, datedMappings, 'orders', session.workNorms)] }));
    const [datedOrder] = buildOrders(datedHeaders, datedRows, datedMappings, DEFAULT_REGION, session.workNorms);
    assert.deepEqual([datedOrder.start, datedOrder.end, datedOrder.serviceDate], ['12:00', '14:00', '2026-09-28']);
    assert.equal(resolveImportedDate([datedOrder], new Date(2026, 8, 29))?.toLocaleDateString('sv-SE'), '2026-09-28');
    assert.ok(validateRows([['R-6', '28.09.2026 12:00', '29.09.2026 14:00', 'Подключение', 'Москва Ленина 6']],
      datedMappings, 'orders', session.workNorms).size > 0);
    const unknownFile = new File(['Номер заявки;Начало;Окончание;Тип работ;Адрес\nR-7;28.09.2026 12:00;28.09.2026 14:00;Новая услуга;Москва Ленина 7'], 'unknown.csv');
    const unknownSession = await parseImportFiles([unknownFile]);
    const unknownDataset = unknownSession.datasets.orders;
    const durationColumn = Number(Object.keys(unknownDataset.savedMappings).find(key => unknownDataset.savedMappings[key] === 'duration'));
    assert.equal(unknownDataset.rows[0][durationColumn], '60');
    assert.equal(validateRows(unknownDataset.rows, unknownDataset.savedMappings, 'orders', unknownSession.workNorms).size, 0);
    assert.equal(unmatchedWorkNorms(unknownDataset.rows, unknownDataset.savedMappings, unknownSession.workNorms)[0].type, 'Новая услуга');
    const [defaultOrder] = await parseReplanningOrderFile(unknownFile, DEFAULT_REGION);
    assert.equal(defaultOrder.duration, 60);
    assert.equal(defaultOrder.durationSource, 'Без норматива · 60 мин');
    unknownDataset.rows[0][durationColumn] = '45';
    const [changedOrder] = buildOrders(unknownDataset.headers, unknownDataset.rows, unknownDataset.savedMappings,
      DEFAULT_REGION, unknownSession.workNorms);
    assert.equal(changedOrder.duration, 45);
    assert.equal(changedOrder.durationSource, 'Изменено оператором');
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});
