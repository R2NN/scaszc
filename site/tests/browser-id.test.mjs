import test from 'node:test';
import assert from 'node:assert/strict';
import { browserId } from '../src/browserId.js';

test('HTTP drafts get distinct version 4 UUIDs without the secure-context randomUUID API', () => {
  const crypto = {getRandomValues: bytes => globalThis.crypto.getRandomValues(bytes)};
  const ids = Array.from({length:100}, () => browserId(crypto));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('secure contexts keep the native UUID generator', () => {
  assert.equal(browserId({randomUUID: () => 'native-id'}), 'native-id');
});
