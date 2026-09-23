import test from 'node:test';
import assert from 'node:assert/strict';
import { pushImportHistory, redoImportHistory, undoImportHistory } from '../src/importHistory.js';

test('table history restores and reapplies a cell edit', () => {
  const initial = { rows: [['old']] };
  const edited = { rows: [['new']] };
  const committed = pushImportHistory({ past: [], present: initial, future: [] }, edited);

  assert.equal(committed.present.rows[0][0], 'new');
  const undone = undoImportHistory(committed);
  assert.equal(undone.present.rows[0][0], 'old');
  const redone = redoImportHistory(undone);
  assert.equal(redone.present.rows[0][0], 'new');
});

test('typing in one cell coalesces into one undo step', () => {
  const initial = { rows: [['']] };
  const first = { rows: [['a']] };
  const second = { rows: [['ab']] };
  const committed = pushImportHistory({ past: [], present: initial, future: [] }, first);
  const coalesced = pushImportHistory(committed, second, { coalesce: true });

  assert.equal(coalesced.past.length, 1);
  assert.equal(undoImportHistory(coalesced).present.rows[0][0], '');
});

test('a new edit clears the redo branch', () => {
  const initial = { rows: [['old']] };
  const edited = { rows: [['new']] };
  const undone = undoImportHistory(pushImportHistory({ past: [], present: initial, future: [] }, edited));
  const replacement = { rows: [['replacement']] };

  assert.deepEqual(pushImportHistory(undone, replacement).future, []);
});
