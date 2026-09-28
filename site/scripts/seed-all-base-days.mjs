import { ShiftStore } from '../server/shiftStore.mjs';
import { baseHistoryDates, ensureBaseHistoricalShift } from '../server/baseHistoryStore.mjs';

const store = new ShiftStore();
try {
  const dates = await baseHistoryDates();
  let orders = 0;
  let assigned = 0;
  for (const [index, date] of dates.entries()) {
    const shift = await ensureBaseHistoricalShift(store, date);
    if (!shift?.plan || shift.plan.status !== 'EXACT_VALID' || shift.plan.metrics.total !== shift.orders.length) {
      throw new Error(`Исторический день ${date} не прошёл сверку.`);
    }
    orders += shift.orders.length;
    assigned += shift.plan.metrics.assigned;
    if ((index + 1) % 20 === 0 || index + 1 === dates.length) {
      process.stdout.write(`${index + 1}/${dates.length}: ${date}\n`);
    }
  }
  process.stdout.write(JSON.stringify({ days: dates.length, first: dates[0], last: dates.at(-1), orders, assigned }) + '\n');
} finally {
  store.close();
}
