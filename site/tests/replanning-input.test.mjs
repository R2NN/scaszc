import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplanningCsv } from '../src/replanningInput.js';

test('replanning CSV accepts Russian semicolon headers without coordinates', () => {
  const [request] = parseReplanningCsv('Номер заявки;Клиент;Адрес;Участок;Тип работ;Начало окна;Конец окна;Длительность\n99101;Иванов;Москва, ул. Вавилова, 14;Восток;Аварийные работ;13:00;15:00;60');
  assert.equal(request.externalId, '99101');
  assert.equal(request.zone, 'Восток');
  assert.equal(request.skill, 'EMERGENCY');
  assert.equal(request.latitude, '');
  assert.equal(request.start, '13:00');
});

test('global region selection overrides a conflicting region from CSV', () => {
  const [request] = parseReplanningCsv('id,address,region\n42,"Москва, ул. Тверская, 1",Югоцентр', 'Юго-восток');
  assert.equal(request.zone, 'Юго-восток');
  assert.equal(request.address, 'Москва, ул. Тверская, 1');
});

test('replanning CSV rejects files without address column', () => {
  assert.throws(() => parseReplanningCsv('id,name\n1,Клиент'), /«Адрес»/);
});

