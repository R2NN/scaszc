import test from 'node:test';
import assert from 'node:assert/strict';
import { algorithmPhaseLabel, estimateAlgorithmSeconds, recordAlgorithmSeconds } from '../src/algorithmProgress.js';

test('waiting-time estimate uses only measured comparable calculations', () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    assert.equal(estimateAlgorithmSeconds('plan', 205), null);
    recordAlgorithmSeconds('plan', 205, 65);
    recordAlgorithmSeconds('plan', 205, 75);
    recordAlgorithmSeconds('replan', 205, 22);
    assert.equal(estimateAlgorithmSeconds('plan', 205), 75);
    assert.equal(estimateAlgorithmSeconds('replan', 205), 22);
    assert.equal(estimateAlgorithmSeconds('plan', 25), null);
    assert.equal(algorithmPhaseLabel('EXACT_PIPELINE'), 'Строим маршруты и проверяем ограничения');
  } finally {
    delete globalThis.localStorage;
  }
});
