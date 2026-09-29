import test from 'node:test';
import assert from 'node:assert/strict';
import { filterLabel, matchesAnySelection, matchesSearch, orderSearchValues, orderWorkValues } from '../src/filterPresentation.js';

test('filter values keep source codes while displaying Russian labels', () => {
  assert.equal(filterLabel('EMERGENCY'), 'Аварийные работы');
  assert.equal(filterLabel('PUBLIC_TRANSIT'), 'Общественный транспорт');
  assert.equal(filterLabel('Глобальная проблема'), 'Глобальная проблема');
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
