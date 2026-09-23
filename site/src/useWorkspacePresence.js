import { useLayoutEffect, useRef, useState } from 'react';

// Retain the outgoing workspace until its exit finishes. A key change must
// mount a new panel so the entrance also runs between two open workspaces.
export function useWorkspacePresence(requestedKey, exitDuration = 280) {
  const [renderedKey, setRenderedKey] = useState(requestedKey);
  const requestedRef = useRef(requestedKey);
  requestedRef.current = requestedKey;
  const closing = renderedKey !== null && renderedKey !== requestedKey;
  const openingKey = renderedKey === null ? requestedKey : null;

  useLayoutEffect(() => {
    if (renderedKey === null) {
      setRenderedKey(requestedRef.current);
      return;
    }
    if (!closing) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(() => {
      setRenderedKey(requestedRef.current);
    }, reducedMotion ? 0 : exitDuration);
    return () => window.clearTimeout(timer);
  }, [renderedKey, closing, exitDuration, openingKey]);

  return {
    renderedKey,
    present: renderedKey !== null,
    motionClass: closing ? 'is-closing' : 'is-open',
  };
}
