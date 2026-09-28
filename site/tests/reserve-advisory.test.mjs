import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildReserveReleaseAdvisories } from '../src/reserveAdvisory.js';

const engineer = (id, skills, shiftStart = '10:00', shiftEnd = '20:00') => ({ id, zone: 'Восток', skills, shiftStart, shiftEnd });
const record = (team, orders = []) => ({ team, orders, plan: { routes: [] } });

test('warns when release removes the only idle emergency skill in the zone', () => {
  const advice = buildReserveReleaseAdvisories(record([
    engineer('reserve', ['EMERGENCY']),
    engineer('other', ['INSTALL']),
  ])).get('reserve');
  assert.equal(advice.level, 'keep');
  assert.match(advice.reason, /аварийные работы/);
  assert.match(advice.reason, /с 10:00 до 20:00/);
});

test('warns only for hours not covered by a same-skill idle colleague', () => {
  const advice = buildReserveReleaseAdvisories(record([
    engineer('reserve', ['INSTALL']),
    engineer('other', ['INSTALL'], '10:00', '16:00'),
  ], [{ zone: 'Восток', skill: 'INSTALL' }])).get('reserve');
  assert.equal(advice.level, 'keep');
  assert.match(advice.reason, /с 16:00 до 20:00/);
});

test('does not count active or already released engineers as available reserve', () => {
  const input = record([
    engineer('reserve', ['LOCAL']),
    engineer('busy', ['LOCAL']),
    engineer('released', ['LOCAL']),
  ], [{ zone: 'Восток', skill: 'LOCAL' }]);
  input.plan.routes.push({ engineerId: 'busy', assignments: [{ orderId: '1' }] });
  const advice = buildReserveReleaseAdvisories(input, ['released']).get('reserve');
  assert.equal(advice.level, 'keep');
  assert.match(advice.reason, /локальные работы/);
});

test('uses a cautious review status when another idle engineer covers the shift', () => {
  const advice = buildReserveReleaseAdvisories(record([
    engineer('reserve', ['INSTALL']),
    engineer('other', ['INSTALL']),
  ], [{ zone: 'Восток', skill: 'INSTALL' }])).get('reserve');
  assert.equal(advice.level, 'review');
  assert.equal(advice.reason, 'В зоне «Восток» остаётся свободная бригада «other» с навыком «подключение» на всю смену с 10:00 до 20:00. Эту бригаду можно рассмотреть для снятия со смены.');
});

test('recalculates the recommendation from each selected day instead of fixed crew text', () => {
  const dayOne = record([
    engineer('reserve', ['EMERGENCY']),
    engineer('other', ['EMERGENCY']),
  ]);
  dayOne.date = '2026-08-17';
  const dayTwo = record([
    engineer('reserve', ['EMERGENCY']),
    engineer('other', ['EMERGENCY'], '10:00', '16:00'),
  ]);
  dayTwo.date = '2026-08-18';
  const first = buildReserveReleaseAdvisories(dayOne).get('reserve');
  const second = buildReserveReleaseAdvisories(dayTwo).get('reserve');
  assert.equal(first.level, 'review');
  assert.equal(second.level, 'keep');
  assert.match(second.reason, /с 16:00 до 20:00/);
  assert.notEqual(first.reason, second.reason);
});

test('uses the real selected-day crew and its actual uncovered hours', async () => {
  const history = JSON.parse(await readFile(new URL('../public/data/analytics-history.json', import.meta.url), 'utf8'));
  const currentDay = history.days.at(-1);
  const engineerId = currentDay.team.find(item => item.name === 'Бригада Арташкин').id;
  const advice = buildReserveReleaseAdvisories(currentDay).get(engineerId);
  assert.equal(advice.level, 'keep');
  assert.match(advice.reason, /Восток.*с 12:00 до 22:00/);

  const changedDay = structuredClone(currentDay);
  changedDay.team.find(item => item.id === engineerId).shiftEnd = '16:00';
  const changedAdvice = buildReserveReleaseAdvisories(changedDay).get(engineerId);
  assert.equal(changedAdvice.level, 'keep');
  assert.match(changedAdvice.reason, /с 12:00 до 16:00/);
});

test('warns when an imported shift is missing instead of assuming availability', () => {
  const advice = buildReserveReleaseAdvisories(record([
    engineer('reserve', ['INSTALL'], '', ''),
  ])).get('reserve');
  assert.equal(advice.level, 'keep');
  assert.match(advice.reason, /время смены этой бригады не указано/);
});
