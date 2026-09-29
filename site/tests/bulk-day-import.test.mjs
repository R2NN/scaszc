import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import XLSX from 'xlsx';
import { DEFAULT_REGION } from '../src/regions.js';
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
    const { parseImportFiles, buildOrders, validateRows, autoMapHeaders } = await vite.ssrLoadModule('/src/ImportWorkspace.jsx');
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
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});
