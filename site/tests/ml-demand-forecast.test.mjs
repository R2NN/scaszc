import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const forecast = JSON.parse(await readFile(new URL('../public/data/ml-demand-forecast.json', import.meta.url), 'utf8'));

test('CatBoost forecast artifact is complete and internally reconciled', () => {
  assert.equal(forecast.model, 'CatBoostRegressor');
  assert.equal(forecast.targetDate, '2026-08-18');
  assert.ok(forecast.training.generatedRows >= 50_000);
  assert.ok(forecast.training.validationDays >= 90);
  assert.ok(forecast.training.wapePercent < 10);
  assert.deepEqual(
    Object.fromEntries(['low', 'middle', 'high'].map(key => [key, forecast.zones.reduce((sum, item) => sum + item[key], 0)])),
    forecast.total,
  );
  for (const dimension of ['zones', 'skills', 'timeBands']) {
    for (const item of forecast[dimension]) assert.ok(item.low <= item.middle && item.middle <= item.high);
  }
});
