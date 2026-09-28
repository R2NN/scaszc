import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addressHouseNumber, houseNumbersMatch, normalizeHouseNumber,
  parseRussianAddress, streetParts, streetsMatch,
} from '../worker/index.js';

test('street and building spellings from a new Moscow import match the same address', () => {
  const requested = 'Москва, Варшавское шоссе, 95 корпус 1';
  const candidate = 'Варшавское шоссе 95 к1';
  assert.equal(normalizeHouseNumber(addressHouseNumber(requested)), '95к1');
  assert.equal(normalizeHouseNumber(addressHouseNumber(candidate)), '95к1');
  assert.equal(houseNumbersMatch('95к1', '95к1'), true);
  assert.equal(streetsMatch(streetParts(parseRussianAddress(requested).query), streetParts('Варшавское шоссе')), true);
  assert.equal(streetsMatch(streetParts(parseRussianAddress('Город Москва, ул.Бирюлёвская, д. 1 к 1').query), streetParts('Бирюлёвская улица')), true);
});

test('a different building part cannot be silently accepted as the requested house', () => {
  assert.equal(houseNumbersMatch('7', '7с1'), false);
  assert.equal(houseNumbersMatch('95к1', '95к2'), false);
  assert.equal(streetsMatch(streetParts('Москва, улица Бирюлёвская, 1 к1'), streetParts('Тверская улица')), false);
});
