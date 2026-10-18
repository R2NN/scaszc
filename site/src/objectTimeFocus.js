/** Focus a real building in the visible map corridor without changing map orientation. */
export function focusObjectTimeMap(map, coords, { onClosePanel, minZoom = 14.5, maxZoom = 15 } = {}) {
  if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite) || Math.abs(coords[0]) > 90 || Math.abs(coords[1]) > 180) return false;
  const container = map.getContainer();
  const box = container.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  const workspace = container.closest('.workspace-grid');
  const timePanel = workspace?.querySelector('.cx-time-panel:not(.is-closing)');
  const routePanel = workspace?.querySelector('.route-list-panel:not(.is-closing)');
  const panel = timePanel || (routePanel && globalThis.getComputedStyle?.(routePanel).visibility !== 'hidden' ? routePanel : null) || document.querySelector('.rating-shared-workspace.is-rating:not(.rating-expanded-view)');
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
  let x = right - left >= 60 ? (left + right) / 2 : box.left + box.width / 2;
  let y = box.top + box.height / 2 - 5;
  // A phone passport is a bottom sheet: use the exposed map above it.
  if (passport && right - left < 60 && passport.top - box.top > 150) {
    const top = Math.max(box.top + 36, 128);
    const bottom = passport.top - 30;
    x = (sidebarRight + box.right - 64) / 2;
    y = (top + bottom) / 2;
  }
  const scaleX = container.clientWidth / box.width;
  const scaleY = container.clientHeight / box.height;
  map.flyTo({
    center: [coords[1], coords[0]],
    zoom: Math.min(map.getMaxZoom(), maxZoom, Math.max(map.getZoom(), minZoom)),
    offset: [(x - box.left - box.width / 2) * scaleX, (y - box.top - box.height / 2) * scaleY],
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    retainPadding: false,
    curve: 1.2,
    speed: 1.3,
    duration: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 1000,
  });
  return true;
}
