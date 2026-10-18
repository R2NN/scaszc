import { minuteOf } from './shiftDomain.js';
import { MAP_UI } from './mapDesign.js';

/** Resolve comparisons against the candidate's immutable source revision. */
export function dispatchPreviewDetail(shift, candidate, { engineerId = candidate.engineer.id, scope = 'day' } = {}) {
  const before = shift?.versions?.find(version => Number(version.version) === Number(candidate.baseRevision))?.plan;
  if (!before) throw new Error(`Исходная версия плана ${candidate.baseRevision} недоступна. Обновите смену перед сравнением.`);
  if (candidate.basePlanContentSha256 && before.contentSha256 !== candidate.basePlanContentSha256) {
    throw new Error('Исходная версия плана не совпадает с проверенным вариантом. Обновите смену.');
  }
  const primary = String(engineerId) === String(candidate.engineer.id);
  return { before, after:candidate.plan, scope, ids:[engineerId],
    current:{engineerId,origin:primary ? candidate.state?.coords || candidate.departureOrigin : null,
      time:candidate.scenarioTime,kind:primary ? candidate.kind : 'Изменение маршрута',emergencyOrderId:candidate.visit.orderId},
    focusRoute:true };
}

const distance = (a, b) => {
  const rad = value => value * Math.PI / 180;
  const lat1 = rad(a[0]), lat2 = rad(b[0]);
  return 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(rad(b[1] - a[1]) / 2) ** 2)));
};

const routeMinute = value => minuteOf(String(value || '').match(/(?:T|^)(\d{1,2}:\d{2})/)?.[1]);

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
  const minute = routeMinute(detail.current?.time);
  const features = [];
  if (minute == null) return { type: 'FeatureCollection', features };
  for (const route of plan?.routes || []) {
    if (!detail.ids.includes(route.engineerId)) continue;
    const legs = [...(includeMovements ? (route.movements || []).map(movement => ({
      geometry: movement.geometry,
      departureAt: movement.departure_at?.slice(11, 16),
      arrival: movement.at?.slice(11, 16),
      movement: true,
    })) : []), ...(route.assignments || [])];
    let position = 0;
    for (const leg of legs) {
      if (!Array.isArray(leg.geometry) || leg.geometry.length < 2) continue;
      const departure = routeMinute(leg.departureAt);
      const arrival = routeMinute(leg.arrivalAt || leg.arrival)
        ?? (departure != null && Number.isFinite(leg.travelMinutes) ? departure + leg.travelMinutes : null);
      // A completed service proves its journey is past even if arrival is absent.
      if ((routeMinute(leg.plannedStart) ?? Infinity) <= minute || arrival != null && arrival <= minute) continue;
      // Do not show an unknown travelled prefix as a future journey.
      if (departure == null || arrival == null) continue;
      const fraction = arrival > minute && departure < minute
        ? (minute - departure) / (arrival - departure) : 0;
      const points = remainingGeometry(leg.geometry, fraction);
      if (points.length < 2) continue;
      if (!leg.movement) position += 1;
      const response = position <= 1;
      const arrivalLabel = `${String(Math.floor(arrival / 60)).padStart(2, '0')}:${String(arrival % 60).padStart(2, '0')}`;
      features.push({ type: 'Feature', properties: { engineerId: route.engineerId, orderId: leg.orderId || '',
        phase: response ? 'response' : 'continuation', movement: Boolean(leg.movement), position,
        arrival: arrivalLabel, label: `${response ? includeMovements && leg.orderId === detail.current?.emergencyOrderId ? 'Авария' : 'Своя заявка' : position} · ${arrivalLabel}` },
        geometry: { type: 'LineString', coordinates: points.map(([lat, lon]) => [lon, lat]) } });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Reapply paints on every selection so an existing grey layer cannot survive an intercept preview. */
export function renderDispatchRoutes(map, detail) {
  const intercept = Boolean(detail.current?.emergencyOrderId) || detail.current?.kind === 'Перехват в пути';
  const rendered = {};
  const stops = [];
  for (const [key, color, dash] of intercept
    ? [['before', MAP_UI.routeSelected, [1, 0]], ['after', MAP_UI.urgent, [1, 0]]]
    : [['before', '#737b87', [3, 3]], ['after', MAP_UI.routeSelected, [1, 0]]]) {
    const id = `dispatch-${key}`;
    const all = dispatchRouteData(detail[key], detail, key === 'after');
    const data = { ...all, features: all.features.filter(feature => detail.scope !== 'next' || feature.properties.phase === 'response') };
    rendered[key] = data;
    const source = map.getSource(id);
    if (source) source.setData(data);
    else map.addSource(id, { type: 'geojson', data });
    if (!map.getLayer(id)) map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {} });
    const paint = { 'line-color': color, 'line-width': intercept ? key === 'after' ? 7 : 5 : key === 'after' ? 5 : 4,
      'line-offset': intercept ? key === 'before' ? -3 : 3 : 0,
      'line-dasharray': dash, 'line-opacity': 1 };
    for (const [property, value] of Object.entries(paint)) map.setPaintProperty(id, property, value);
    map.setFilter(id, key === 'after' ? ['==', ['get', 'phase'], 'response'] : null);
    map.moveLayer(id);
    const continuation = `${id}-continuation`;
    if (key === 'after') {
      if (!map.getLayer(continuation)) map.addLayer({ id: continuation, type: 'line', source: id,
        filter: ['==', ['get', 'phase'], 'continuation'], layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': color, 'line-width': 4, 'line-dasharray': [2, 2], 'line-opacity': .9 } });
      map.setPaintProperty(continuation, 'line-color', color);
      map.moveLayer(continuation);
    }
    const arrows = `${id}-arrows`;
    if (!map.getLayer(arrows)) map.addLayer({ id: arrows, type: 'symbol', source: id,
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 110, 'text-field': '➤', 'text-size': 14,
        'text-rotation-alignment': 'map', 'text-keep-upright': false, 'text-allow-overlap': false },
      paint: { 'text-color': '#fff', 'text-halo-color': color, 'text-halo-width': 1.5 } });
    map.setPaintProperty(arrows, 'text-halo-color', color);
    map.moveLayer(arrows);
    for (const feature of data.features) {
      if (feature.properties.movement) continue;
      stops.push({ type: 'Feature', properties: { ...feature.properties, color },
        geometry: { type: 'Point', coordinates: feature.geometry.coordinates.at(-1) } });
    }
  }
  const stopData = { type: 'FeatureCollection', features: stops };
  if (map.getSource('dispatch-stops')) map.getSource('dispatch-stops').setData(stopData);
  else map.addSource('dispatch-stops', { type: 'geojson', data: stopData });
  if (!map.getLayer('dispatch-stop-points')) map.addLayer({ id: 'dispatch-stop-points', type: 'circle', source: 'dispatch-stops',
    paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  if (!map.getLayer('dispatch-stop-labels')) map.addLayer({ id: 'dispatch-stop-labels', type: 'symbol', source: 'dispatch-stops',
    layout: { 'text-field': ['get', 'label'], 'text-size': 13, 'text-anchor': 'bottom', 'text-offset': [0, -1], 'text-allow-overlap': false },
    paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#fff', 'text-halo-width': 2 } });
  map.moveLayer('dispatch-stop-points');
  map.moveLayer('dispatch-stop-labels');
  return rendered;
}

/** Mark the actual addresses in an expanded consequence group, including unassigned jobs. */
export function renderDispatchImpact(map, features) {
  const data = {type:'FeatureCollection',features};
  if (map.getSource('dispatch-impact')) map.getSource('dispatch-impact').setData(data);
  else map.addSource('dispatch-impact', {type:'geojson',data});
  if (!map.getLayer('dispatch-impact-points')) map.addLayer({id:'dispatch-impact-points',type:'circle',source:'dispatch-impact',
    paint:{'circle-radius':12,'circle-color':'#ffd21f','circle-stroke-color':'#6d28d9','circle-stroke-width':3}});
  if (!map.getLayer('dispatch-impact-labels')) map.addLayer({id:'dispatch-impact-labels',type:'symbol',source:'dispatch-impact',
    layout:{'text-field':['get','address'],'text-size':14,'text-anchor':'bottom','text-offset':[0,-1.5],'text-max-width':18},
    paint:{'text-color':'#482477','text-halo-color':'#fff','text-halo-width':2}});
  map.moveLayer('dispatch-impact-points');
  map.moveLayer('dispatch-impact-labels');
  return data;
}

/** A temporary bright overlay shows the remaining routes affected by a publication. */
export function renderDispatchHighlight(map, detail) {
  const ids = detail.highlightIds?.length ? detail.highlightIds : detail.ids;
  const data = dispatchRouteData(detail.after, {...detail,ids}, true);
  if (map.getSource('dispatch-result-highlight')) map.getSource('dispatch-result-highlight').setData(data);
  else map.addSource('dispatch-result-highlight', {type:'geojson',data});
  if (!map.getLayer('dispatch-result-highlight')) map.addLayer({id:'dispatch-result-highlight',type:'line',source:'dispatch-result-highlight',
    layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#ffd21f','line-width':14,'line-opacity':.7}});
  map.moveLayer('dispatch-after');
  map.moveLayer('dispatch-after-continuation');
  return data;
}
