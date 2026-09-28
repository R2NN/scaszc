import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import { runExactPlan } from '../scripts/exact-plan-runner.mjs';
import { projectRoot } from '../scripts/project-root.mjs';

let server;
let importer;

before(async () => {
  server = await createServer({
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: 'custom',
  });
  importer = await server.ssrLoadModule('/src/ImportWorkspace.jsx');
});

after(async () => {
  await server?.close();
});

test('import accepts unambiguous time and decimal formats for a new address', () => {
  const mappings = {
    0: 'id', 1: 'street', 2: 'house', 3: 'latitude', 4: 'longitude',
    5: 'windowStart', 6: 'windowEnd', 7: 'duration', 8: 'skill', 9: 'zoneId',
  };
  const row = ['NEW-1', 'Новогиреевская улица', '37', '55,752896', '37,7991095', '9.30', '17:00', '30', 'Подключение', 'EAST'];
  assert.equal(importer.validateImportRows([row], mappings).size, 0);
  const [order] = importer.buildOrders([], [row], mappings, { id: 'moscow', name: 'Москва' });
  assert.equal(order.address, 'Новогиреевская улица, д. 37');
  assert.equal(order.start, '09:30');
  assert.deepEqual(order.coords, [55.752896, 37.7991095]);
});

test('CSV upload keeps the new address and dotted time before validation', async () => {
  const csv = [
    'id;street;house;latitude;longitude;window_start;window_end;duration;skill;zone_id',
    'NEW-1;Новогиреевская улица;37;55,752896;37,7991095;9.30;17:00;30;Подключение;EAST',
  ].join('\n');
  const bytes = Buffer.from(csv, 'utf8');
  const file = { name: 'new-day.csv', size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  const session = await importer.parseImportFile(file);
  assert.equal(session.rows.length, 1);
  assert.equal(session.rows[0][1], 'Новогиреевская улица');
  assert.equal(session.rows[0][5], '9.30');
});

test('three-zone transit day survives separate requests and engineers CSV uploads', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/new-day-transit.json', import.meta.url), 'utf8'));
  const asFile = (name, lines) => {
    const bytes = Buffer.from(lines.join('\n'), 'utf8');
    return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  const ordersCsv = [
    'id;address;latitude;longitude;window_start;window_end;duration;skill;zone_id;transport;service_date',
    ...fixture.orders.map(order => [order.sourceId, order.address, ...order.coords, order.start, order.end, order.duration, order.skill, order.zoneId, order.transport, fixture.planningDate].join(';')),
  ];
  const engineersCsv = [
    'engineer_id;engineer_name;start_latitude;start_longitude;shift_start;shift_end;skills;zone_id;transport;status',
    ...fixture.engineers.map(engineer => [engineer.sourceId, engineer.sourceId, ...engineer.startCoords, engineer.shiftStart, engineer.shiftEnd, engineer.skills.join('|'), engineer.zoneId, engineer.transport, engineer.status].join(';')),
  ];
  const orderSession = await importer.parseImportFile(asFile('orders.csv', ordersCsv), 'orders');
  const engineerSession = await importer.parseImportFile(asFile('engineers.csv', engineersCsv), 'engineers');
  const orderMapping = Object.fromEntries(['id', 'address', 'latitude', 'longitude', 'windowStart', 'windowEnd', 'duration', 'skill', 'zoneId', 'transport', 'serviceDate'].map((field, index) => [index, field]));
  const engineerMapping = Object.fromEntries(['engineerId', 'engineerName', 'engineerStartLatitude', 'engineerStartLongitude', 'engineerShiftStart', 'engineerShiftEnd', 'engineerSkills', 'engineerZoneId', 'engineerTransport', 'engineerStatus'].map((field, index) => [index, field]));
  assert.equal(importer.validateImportRows(orderSession.rows, orderMapping).size, 0);
  assert.equal(importer.validateImportRows(engineerSession.rows, engineerMapping, 'engineers').size, 0);
  const orders = importer.buildOrders(orderSession.headers, orderSession.rows, orderMapping, { id: 'moscow', name: 'Москва' });
  const engineers = importer.buildEngineers(engineerSession.headers, engineerSession.rows, engineerMapping, { id: 'moscow', name: 'Москва' });
  assert.deepEqual(orders.map(order => order.zoneId), ['EAST', 'SOUTHEAST', 'SOUTHCENTER']);
  assert.ok(orders.every(order => order.transport === 'PUBLIC_TRANSIT' && order.coords.length === 2));
  assert.ok(engineers.every(engineer => engineer.transport === 'Общественный транспорт' && engineer.startCoords.length === 2));
  if (process.env.BEEGO_TEST_FULL_PIPELINE === '1') {
    const plan = await runExactPlan({ planningDate: fixture.planningDate, orders, engineers }, projectRoot());
    assert.equal(plan.status, 'EXACT_VALID');
    assert.equal(plan.validation.status, 'VALID');
    assert.equal(plan.metrics.assigned, 3);
  }
});

test('import names the row and field for malformed time and unknown engineer availability', () => {
  const orderMappings = { 0: 'id', 1: 'address', 2: 'windowStart', 3: 'windowEnd', 4: 'duration', 5: 'skill', 6: 'zoneId' };
  const orderIssues = importer.validateImportRows([['JOB-1', 'Москва, Новогиреевская улица, 37', '9:99', '08:00', '30.5', 'Подключение', 'EAST']], orderMappings);
  assert.match(orderIssues.get('0:2'), /ЧЧ:ММ/);
  assert.match(orderIssues.get('0:4'), /целым положительным/);

  const engineerMappings = {
    0: 'engineerId', 1: 'engineerName', 2: 'engineerSkills', 3: 'engineerShiftStart',
    4: 'engineerShiftEnd', 5: 'engineerTransport', 6: 'engineerStatus',
    7: 'engineerStartAddress', 8: 'engineerZoneId',
  };
  const engineerIssues = importer.validateImportRows([['ENG-1', 'Иванов', 'Подключение', '08:00', '18:00', 'PUBLIC_TRANSIT', 'Неизвестно', 'Москва, улица Плеханова, 4', 'EAST']], engineerMappings, 'engineers');
  assert.match(engineerIssues.get('0:6'), /Доступен/);
});
