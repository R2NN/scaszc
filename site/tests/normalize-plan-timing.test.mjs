import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const days = JSON.parse(await readFile(new URL('../public/data/analytics-history.json', import.meta.url), 'utf8')).days;
const minuteOf = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

test('exact historical routes respect shifts, client windows and service durations', () => {
  let checked = 0;
  for (const day of days) {
    const orders = new Map(day.orders.map(order => [order.id, order]));
    const engineers = new Map(day.team.map(engineer => [engineer.id, engineer]));
    for (const route of day.plan.routes) {
      const engineer = engineers.get(route.engineerId);
      assert.ok(engineer);
      for (const visit of route.assignments) {
        const order = orders.get(visit.orderId);
        assert.ok(order);
        assert.ok(minuteOf(visit.departureAt) >= minuteOf(engineer.shiftStart));
        assert.ok(minuteOf(visit.arrival) <= minuteOf(visit.plannedStart));
        assert.ok(minuteOf(visit.plannedStart) >= minuteOf(order.start));
        assert.ok(minuteOf(visit.plannedStart) <= minuteOf(order.end));
        assert.equal(minuteOf(visit.plannedFinish) - minuteOf(visit.plannedStart), order.duration);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 29000);
});
