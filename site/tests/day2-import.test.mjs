import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import worker from '../worker/index.js';
import { DEFAULT_REGION } from '../src/regions.js';
import { territoryFromImportFile } from '../src/importTerritory.js';

test('district filenames provide an operational sector only when the CSV has none', async () => {
  assert.deepEqual(territoryFromImportFile('восток день 2.csv'), { id: 'EAST', label: 'Восток' });
  assert.deepEqual(territoryFromImportFile('юго-восток день 2.csv'), { id: 'SOUTHEAST', label: 'Юго-Восток' });
  assert.deepEqual(territoryFromImportFile('юго-центр день 2.csv'), { id: 'SOUTHCENTER', label: 'Югоцентр' });
  assert.equal(territoryFromImportFile('заявки.csv'), null);

  const vite = await createServer({ server: { middlewareMode: true, hmr: false } });
  const originalFetch = globalThis.fetch;
  try {
    const { parseImportFiles, buildOrders } = await vite.ssrLoadModule('/src/ImportWorkspace.jsx');
    const norms = await readFile(new URL('../public/data/work-norms.xlsx', import.meta.url));
    globalThis.fetch = async () => new Response(norms, { status: 200 });
    const heading = 'Заявка;Тип заявки BK;Начало;Окончание;Район;Адрес\n';
    const files = [
      new File([heading + 'E-1;Подключение;28.09.2026 10:00;28.09.2026 12:00;Таганский;Город Москва, ул.Перекопская, д. 14 к 1'], 'восток день 2.csv'),
      new File([heading + 'C-1;Подключение;28.09.2026 13:00;28.09.2026 15:00;Зюзино;Город Москва, ул.Перекопская, д. 14 к 1'], 'юго-центр день 2.csv'),
    ];
    const session = await parseImportFiles(files);
    const dataset = session.datasets.orders;
    const orders = buildOrders(dataset.headers, dataset.rows, dataset.savedMappings, DEFAULT_REGION, session.workNorms, session.fileName);
    assert.deepEqual(orders.map(order => [order.sourceId, order.zoneId, order.district, order.serviceDate]), [
      ['E-1', 'EAST', 'Таганский', '2026-09-28'],
      ['C-1', 'SOUTHCENTER', 'Зюзино', '2026-09-28'],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
  }
});

test('geocoder accepts the same exact street before or after its type and rejects another street', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ results: [{
      street: 'Перекопская улица', housenumber: '14 к1', city: 'Москва',
      country_code: 'ru', result_type: 'building', lat: 55.66, lon: 37.58,
      formatted: 'Перекопская улица 14 к1, Москва, Россия', rank: { confidence: 0.9 },
    }] }), { status: 200 });
    const response = await worker.fetch(new Request('http://localhost/api/geocode', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: [
        { id: 'matching', address: 'Город Москва, ул.Перекопская, д. 14 к 1' },
        { id: 'different', address: 'Город Москва, ул.Ковров, д. 14 к 1' },
      ] }),
    }), { GEOAPIFY_API_KEY: 'test' });
    const payload = await response.json();
    assert.deepEqual(payload.results.map(item => [item.id, item.status]), [
      ['matching', 'exact'], ['different', 'review'],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
