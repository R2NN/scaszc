import { minuteOf } from './shiftDomain.js';
import { MAP_UI } from './mapDesign.js';

const distance = (a, b) => {
  const rad = value => value * Math.PI / 180;
  const lat1 = rad(a[0]), lat2 = rad(b[0]);
  return 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(rad(b[1] - a[1]) / 2) ** 2)));
};

// Slice along the actual road geometry, using the same length interpolation
// as the dispatch checkpoint. Never draw a straight connector to an address.
const remainingGeometry = (points, fraction) => {
  if (fraction <= 0) return points;
  const lengths = points.slice(1).map((point, index) => distance(points[index], point));
  let remaining = lengths.reduce((sum, value) => sum + value, 0) * fraction;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const ratio = lengths[index] ? Math.min(1, remaining / lengths[index]) : 0;
      const cut = points[index].map((value, axis) => value + (points[index + 1][axis] - value) * ratio);
      const tail = points.slice(index + 1);
      if (tail.length && distance(cut, tail[0]) < 1e-12) tail.shift();
      return [cut, ...tail];
    }
    remaining -= lengths[index];
  }
  return [];
};

/** Build only untravelled road segments; both alternatives share the event-time origin. */
export function dispatchRouteData(plan, detail, includeMovements = false) {
  const minute = minuteOf(detail.current?.time);
  const features = [];
  for (const route of plan?.routes || []) {
    if (!detail.ids.includes(route.engineerId)) continue;
    const legs = [...(includeMovements ? (route.movements || []).map(movement => ({
      geometry: movement.geometry,
      departureAt: movement.departure_at?.slice(11, 16),
      arrival: movement.at?.slice(11, 16),
    })) : []), ...(route.assignments || [])];
    for (const leg of legs) {
      if (!Array.isArray(leg.geometry) || leg.geometry.length < 2) continue;
      const departure = minuteOf(leg.departureAt);
      const arrival = minuteOf(leg.arrivalAt || leg.arrival);
      if (minute != null && arrival != null && arrival <= minute) continue;
      const fraction = minute != null && departure != null && arrival > minute && departure < minute
        ? (minute - departure) / (arrival - departure) : 0;
      const points = remainingGeometry(leg.geometry, fraction);
      if (points.length < 2) continue;
      features.push({ type: 'Feature', properties: { engineerId: route.engineerId, orderId: leg.orderId || '' },
        geometry: { type: 'LineString', coordinates: points.map(([lat, lon]) => [lon, lat]) } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Reapply paints on every selection so an existing grey layer cannot survive an intercept preview. */
export function renderDispatchRoutes(map, detail) {
  const intercept = detail.current?.kind === 'Перехват в пути';
  for (const [key, color, dash] of intercept
    ? [['before', MAP_UI.routeSelected, [1, 0]], ['after', MAP_UI.urgent, [1, 0]]]
    : [['before', '#737b87', [3, 3]], ['after', MAP_UI.routeSelected, [1, 0]]]) {
    const id = `dispatch-${key}`;
    const data = dispatchRouteData(detail[key], detail, key === 'after');
    const source = map.getSource(id);
    if (source) source.setData(data);
    else map.addSource(id, { type: 'geojson', data });
    if (!map.getLayer(id)) map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {} });
    const paint = { 'line-color': color, 'line-width': intercept ? 6 : key === 'after' ? 5 : 4,
      'line-offset': intercept ? key === 'before' ? -3 : 3 : 0,
      'line-dasharray': dash, 'line-opacity': 1 };
    for (const [property, value] of Object.entries(paint)) map.setPaintProperty(id, property, value);
    map.moveLayer(id);
  }
}
