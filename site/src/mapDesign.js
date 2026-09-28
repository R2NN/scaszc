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
  routeNumbersMinZoom: 10.25,
  directionArrowsMinZoom: 10.2,
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

export function shouldShowRouteNumbers(zoom, hasFocusedRoute = false) {
  return Boolean(hasFocusedRoute) && Number(zoom) >= MAP_SCALE.routeNumbersMinZoom;
}

export function routeModeForCount(requestedMode, visibleRouteCount) {
  return requestedMode === 'brigades' && visibleRouteCount <= 8 ? 'brigades' : 'focus';
}
