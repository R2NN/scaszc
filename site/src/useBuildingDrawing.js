import { useCallback, useLayoutEffect, useState } from 'react';

/** Keep drawing labels and controls legible at different viewBox scales and viewport sizes. */
export function useBuildingDrawing(bounds) {
  const [element, setElement] = useState(null), [size, setSize] = useState({ width: 800, height: 500 });
  const ref = useCallback(node => setElement(node), []);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  const scale = Math.max(.1, Math.min(size.width / bounds[2], size.height / bounds[3]));
  return { ref, scale };
}
