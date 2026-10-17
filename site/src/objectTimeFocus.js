/** Focus a real building in the visible map corridor without changing map orientation. */
export function focusObjectTimeMap(map, coords, { onClosePanel } = {}) {
  if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite) || Math.abs(coords[0]) > 90 || Math.abs(coords[1]) > 180) return false;
  const container = map.getContainer();
  const box = container.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  const panel = container.closest('.workspace-grid')?.querySelector('.cx-time-panel:not(.is-closing)');
  const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
  const passport = document.querySelector('.cx-passport')?.getBoundingClientRect();
  const sidebarRight = Math.max(box.left, sidebar?.right || box.left);
  let left = Math.max(sidebarRight, panel?.getBoundingClientRect().right || box.left);
  const right = Math.min(box.right - 64, passport?.left ?? box.right - 64);
  // On narrow screens the two drawers overlap. Keep the selected house visible
  // beside the passport; closing the list retains its filters and reopen action.
  if (right - left < 90 && panel && onClosePanel) {
    onClosePanel();
    left = sidebarRight;
  }
  const x = right - left >= 60 ? (left + right) / 2 : box.left + box.width / 2;
  const scaleX = container.clientWidth / box.width;
  const scaleY = container.clientHeight / box.height;
  map.easeTo({
    center: [coords[1], coords[0]],
    zoom: Math.min(map.getMaxZoom(), Math.max(map.getZoom(), 16.5)),
    offset: [(x - box.left - box.width / 2) * scaleX, -5 * scaleY],
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    retainPadding: false,
    duration: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 650,
  });
  return true;
}
