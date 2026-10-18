import { useEffect } from 'react';

/** Drag a zoomed drawing without turning a finished drag into an equipment click. */
export function useBuildingPan(canvasRef, objectId) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gesture = null, suppressUntil = 0;
    const down = event => {
      if (event.button !== 0 || !event.isPrimary) return;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop, dragging: false };
    };
    const move = event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (!gesture.dragging && Math.hypot(dx, dy) < 5) return;
      if (!gesture.dragging) {
        gesture.dragging = true; canvas.classList.add('is-panning');
        canvas.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      canvas.scrollLeft = gesture.left - dx * canvas.clientWidth / rect.width;
      canvas.scrollTop = gesture.top - dy * canvas.clientHeight / rect.height;
    };
    const end = event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      if (gesture.dragging) suppressUntil = performance.now() + 300;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      gesture = null; canvas.classList.remove('is-panning');
    };
    const click = event => { if (performance.now() < suppressUntil && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const preventDrag = event => event.preventDefault();
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    canvas.addEventListener('click', click, true);
    canvas.addEventListener('dragstart', preventDrag);
    return () => {
      if (gesture && canvas.hasPointerCapture(gesture.id)) canvas.releasePointerCapture(gesture.id);
      canvas.classList.remove('is-panning');
      canvas.removeEventListener('pointerdown', down); window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
      canvas.removeEventListener('click', click, true); canvas.removeEventListener('dragstart', preventDrag);
    };
  }, [canvasRef, objectId]);
}
