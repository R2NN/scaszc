export const MAP_UI = Object.freeze({
  routeNeutral: '#667085',
  routeNeutralDark: '#98A2B3',
  routeSelected: '#6D28D9',
  routeSelectedDark: '#7C3AED',
  routeSelectedCasing: '#FFC800',
  routeDirection: '#FFFFFF',
  routeGraphite: '#1E1E1E',
  routeCasingLight: '#FFFFFF',
  routeCasingDark: '#1B1F27',
  urgent: '#E52B20',
  unassigned: '#FF9500',
  invalid: '#D92D20',
  manualReview: '#5965D8',
  selectedRing: '#FFC800',
  routePalette: ['#7928CA', '#0066FF', '#8F274B', '#D95F02', '#B83280', '#3B5CCC', '#5C4DB1', '#8A5A00'],
});

export const MAP_SCALE = Object.freeze({
  cityMaxZoom: 10.45,
  routeNumbersMinZoom: 10.25,
  directionArrowsMinZoom: 10.2,
  clusterRadiusPx: 82,
});

export function stableRouteColor(value) {
  const text = String(value ?? 'route');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return MAP_UI.routePalette[Math.abs(hash >>> 0) % MAP_UI.routePalette.length];
}

export function shouldClusterOrders(zoom, hasFocusedRoute = false) {
  return Number(zoom) < MAP_SCALE.cityMaxZoom && !hasFocusedRoute;
}

export function shouldShowRouteNumbers(zoom, hasFocusedRoute = false) {
  return Boolean(hasFocusedRoute) && Number(zoom) >= MAP_SCALE.routeNumbersMinZoom;
}

export function groupProjectedMarkers(items, project, radius = MAP_SCALE.clusterRadiusPx) {
  const cells = new Map();
  items.forEach(item => {
    const projected = project(item);
    if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return;
    const key = `${Math.floor(projected.x / radius)}:${Math.floor(projected.y / radius)}`;
    const group = cells.get(key) || [];
    group.push(item);
    cells.set(key, group);
  });
  return [...cells.values()];
}

export function worldPixelForCoords(coords, zoom, tileSize = 512) {
  const [lat, lon] = Array.isArray(coords) ? coords : [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const boundedLat = Math.max(-85.051129, Math.min(85.051129, lat));
  const scale = tileSize * (2 ** Number(zoom || 0));
  const sin = Math.sin((boundedLat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

// Unlike viewport-relative projection, world pixels do not change when the map
// pans. Cluster membership therefore stays fixed while the dispatcher drags the
// map and is recalculated only when the zoom level changes.
export function groupGeographicMarkers(items, getCoords, zoom, radius = MAP_SCALE.clusterRadiusPx) {
  return groupProjectedMarkers(items, item => worldPixelForCoords(getCoords(item), zoom), radius);
}

export function routeModeForCount(requestedMode, visibleRouteCount) {
  return requestedMode === 'brigades' && visibleRouteCount <= 8 ? 'brigades' : 'focus';
}
