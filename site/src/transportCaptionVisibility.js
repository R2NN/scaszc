/** Keep dismissed explanations hidden during polling, until explicitly reopened or a new shift is shown. */
export function createTransportCaptionVisibility() {
  let scope;
  const dismissed = new Set();
  return {
    update(nextScope) {
      if (nextScope !== scope) {
        scope = nextScope;
        dismissed.clear();
      }
    },
    hide(id) { dismissed.add(id); },
    show(id) { dismissed.delete(id); },
    isHidden(id) { return dismissed.has(id); },
  };
}
