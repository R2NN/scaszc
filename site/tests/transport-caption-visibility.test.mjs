import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransportCaptionVisibility } from '../src/transportCaptionVisibility.js';

test('closing an explanation survives repeated polling without hiding other restrictions', () => {
  const captions = createTransportCaptionVisibility();
  captions.update('shift-1:2026-08-17');
  captions.hide('road');
  for (let tick = 0; tick < 5; tick++) captions.update('shift-1:2026-08-17');
  assert.equal(captions.isHidden('road'), true);
  assert.equal(captions.isHidden('metro'), false);
  captions.show('road');
  assert.equal(captions.isHidden('road'), false);
});

test('a new session or day restores explanations even when event IDs are reused', () => {
  const captions = createTransportCaptionVisibility();
  captions.update('shift-1:2026-08-17');
  captions.hide('road');
  captions.update('shift-2:2026-08-17');
  assert.equal(captions.isHidden('road'), false);
  captions.hide('road');
  captions.update('shift-2:2026-08-18');
  assert.equal(captions.isHidden('road'), false);
});
