export const IMPORT_HISTORY_LIMIT = 40;

export function pushImportHistory(history, next, { coalesce = false, limit = IMPORT_HISTORY_LIMIT } = {}) {
  if (next === history.present) return history;
  return {
    past: coalesce ? history.past : [...history.past.slice(-(limit - 1)), history.present],
    present: next,
    future: [],
  };
}

export function undoImportHistory(history, limit = IMPORT_HISTORY_LIMIT) {
  if (!history.past.length) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past.at(-1),
    future: [history.present, ...history.future].slice(0, limit),
  };
}

export function redoImportHistory(history, limit = IMPORT_HISTORY_LIMIT) {
  if (!history.future.length) return history;
  return {
    past: [...history.past.slice(-(limit - 1)), history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}
