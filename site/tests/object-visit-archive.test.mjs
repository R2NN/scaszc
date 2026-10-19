import test from 'node:test';
import assert from 'node:assert/strict';
import { objectArchivePlans } from '../server/objectVisitArchive.mjs';
import { relatedOrders } from '../src/serviceContextDomain.js';

test('archive preserves planned status, exact address, engineer and times without inventing execution', () => {
  const object = { regionId: 'moscow', address: 'Москва, дом 1' };
  const day = (date, address = object.address, regionId = 'moscow') => ({ date, dataKind: 'SYNTHETIC_INPUT_EXACT_PLAN', actual: null, orders: [{ id: `${date}:A`, sourceId: 'A', regionId, address, workType: 'Подключение' }], plan: { routes: [{ engineerId: 'ENG-1', engineerName: 'Инженер 1', assignments: [{ orderId: `${date}:A`, plannedStart: '10:30', plannedFinish: '11:40' }] }] } });
  const history = { days: [day('2026-08-12'), day('2026-08-17'), day('2026-08-15'), day('2026-08-14', 'Москва, дом 10'), day('2026-08-13', object.address, 'other')] };
  const rows = objectArchivePlans(history, object, '2026-08-17T23:59:00+03:00');
  assert.deepEqual(rows.map(row => row.date), ['2026-08-15', '2026-08-12']);
  assert.equal(rows[0].plannedStart, '10:30');
  assert.equal(rows[0].engineerName, 'Инженер 1');
  assert.equal(rows[0].executionConfirmed, false);
  assert.equal(rows[0].status, 'planned');
  assert.match(rows[0].sourceLabel, /модельных/);
  assert.equal(rows[0].endedAt, undefined);
  assert.equal(objectArchivePlans(history, object, '2026-08-01').length, 0);
});
test('request numbering follows the incident links rather than array or route order', () => {
  const a = { id: 'A' }, b = { id: 'B' };
  assert.deepEqual(relatedOrders({ orderIds: ['B', 'A'] }, [a, b]), [b, a]);
});
