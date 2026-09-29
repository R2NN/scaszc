import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalWorkValue, filterLabel, matchesAnySelection, matchesSearch, orderSearchValues, orderWorkValues } from '../src/filterPresentation.js';

test('filter values keep source codes while displaying Russian labels', () => {
  assert.equal(filterLabel('EMERGENCY'), 'Аварийные работы');
  assert.equal(filterLabel('UPSELL'), 'Дозаказ');
  assert.equal(filterLabel('PUBLIC_TRANSIT'), 'Общественный транспорт');
  assert.equal(filterLabel('Глобальная проблема'), 'Глобальная проблема');
});

test('work filters show one Russian option for each source code and label', () => {
  const orders = [
    { workType: 'INSTALL', skill: 'Подключение', sourceData: { bk_type: 'INSTALL', required_skill: 'Подключение' } },
    { workType: 'UPSELL', skill: 'Дозаказ' },
    { workType: 'Глобальная проблема', skill: 'EMERGENCY' },
  ];
  const values = [...new Set(orders.flatMap(orderWorkValues))];
  assert.deepEqual(values, ['INSTALL', 'UPSELL', 'Глобальная проблема', 'EMERGENCY']);
  assert.deepEqual(values.map(filterLabel), ['Подключение', 'Дозаказ', 'Глобальная проблема', 'Аварийные работы']);
  assert.equal(canonicalWorkValue('локальные работы'), 'LOCAL');
  assert.equal(matchesAnySelection(['INSTALL'], orderWorkValues(orders[0])), true);
  assert.equal(matchesAnySelection(['EMERGENCY'], orderWorkValues(orders[0])), false);
});

test('multiple selections match either value within a group', () => {
  assert.equal(matchesAnySelection(['EMERGENCY', 'INSTALL'], ['EMERGENCY']), true);
  assert.equal(matchesAnySelection(['EMERGENCY'], ['LOCAL', 'INSTALL']), false);
  assert.equal(matchesAnySelection([], ['LOCAL']), true);
});

test('search finds IDs, source text and visible Russian skill labels', () => {
  assert.equal(matchesSearch('21367', ['EAST-21367', 'Глобальная проблема']), true);
  assert.equal(matchesSearch('аварийные', [['LOCAL', 'EMERGENCY']]), true);
  assert.equal(matchesSearch('комарь', ['Бригада Комарь']), true);
  assert.equal(matchesSearch('неизвестно', ['EAST-21367']), false);
});

test('request filters keep work type and required skill independent', () => {
  const order = {
    id: 'EAST-41962', workType: 'Глобальная проблема', skill: 'EMERGENCY',
    sourceData: { source_job_id: '41962' },
  };
  assert.equal(matchesAnySelection(['Глобальная проблема'], orderWorkValues(order)), true);
  assert.equal(matchesAnySelection(['EMERGENCY'], orderWorkValues(order)), true);
  assert.equal(matchesAnySelection(['INSTALL'], orderWorkValues(order)), false);
  assert.equal(matchesSearch('41962', orderSearchValues(order)), true);
  assert.equal(matchesSearch('Аварийные работы', orderSearchValues(order)), true);
});
