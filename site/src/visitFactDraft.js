const stageKeys = ['deviationReason', 'accessMinutes', 'documentMinutes', 'customerMinutes', 'comment'];

/** Populate only this visit's saved measurements, preserving unknown stages. */
export function savedFactDraft(fact) {
  return { ...Object.fromEntries(stageKeys.map(key => [key, fact?.[key] ?? ''])), time: fact?.time || '12:00', reason: fact?.reason || '', correctionReason: '' };
}

/** Resolve a draft by shift and order; a different order never inherits its neighbours' input. */
export function visitFactDraft(drafts, key, fact) {
  return drafts[key]?.value || savedFactDraft(fact);
}

/** Keep unsaved input with its original server revision so refresh conflicts can be shown. */
export function updateFactDraft(drafts, key, fact, value) {
  return { ...drafts, [key]: { value, saved: drafts[key]?.saved || JSON.stringify(savedFactDraft(fact)) } };
}
