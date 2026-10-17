import { OBJECT_TIME_LEGEND, objectTimeCategory } from './objectPresentation.js';

/** Keep marker deltas and the access layer tied to the same filtered object forecasts. */
export function objectTimeGeoJSON(objects) {
  return { type: 'FeatureCollection', features: objects.filter(object => Array.isArray(object.coords) && object.coords.length === 2 && object.coords.every(Number.isFinite)).map(object => {
    const delta = Number.isFinite(object.delta) && object.delta !== 0 ? ` (${object.delta > 0 ? '+' : '−'}${Math.abs(object.delta)})` : '';
    return { type: 'Feature', id: object.id, properties: { id: object.id, color: OBJECT_TIME_LEGEND.find(item => item.key === objectTimeCategory(object)).color, label: `${object.total} мин`, total: object.total, accessLabel: `Доступ +${object.estimate?.access || 0} мин`, deltaLabel: delta, positiveDelta: object.delta > 0 ? 1 : 0, access: object.estimate?.access || 0, slower: objectTimeCategory(object) === 'slower' ? 1 : 0, unknown: objectTimeCategory(object) === 'unknown' ? 1 : 0 }, geometry: { type: 'Point', coordinates: [object.coords[1], object.coords[0]] } };
  }) };
}

/** Add only layers to the persistent map and restore them after a theme/style change. */
export function syncObjectTimeLayers(map, data, { enabled, view, dark }) {
  // getStyle is available once the style JSON is ready; background tiles may still load.
  if (!map.getStyle()) return;
  const accessData = { ...data, features: view === 'heat' ? data.features : data.features.filter(feature => feature.properties.access > 0) };
  if (!map.getSource('cx-objects')) map.addSource('cx-objects', { type: 'geojson', data, cluster: true, clusterMaxZoom: 13, clusterRadius: 88, clusterProperties: { slower: ['+', ['get', 'slower']], unknown: ['+', ['get', 'unknown']] } });
  if (!map.getSource('cx-access')) map.addSource('cx-access', { type: 'geojson', data: accessData });
  if (!map.getLayer('cx-access-heat')) map.addLayer({ id: 'cx-access-heat', type: 'heatmap', source: 'cx-access', paint: {
    'heatmap-weight': ['interpolate', ['linear'], ['get', 'access'], 0, 0, 15, 0.7, 30, 1],
    'heatmap-intensity': 2.4,
    'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 7, 24, 11, 42, 15, 64],
    'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,195,70,0)', 0.08, 'rgba(255,195,70,0.35)', 0.4, '#f7ad49', 0.7, '#ed744d', 1, '#ce4b48'],
    'heatmap-opacity': dark ? 0.75 : 0.65,
  } });
  for (const [id, source] of [['cx-points', 'cx-objects'], ['cx-access-points', 'cx-access']]) {
    if (!map.getLayer(id)) map.addLayer({ id, type: 'circle', source, filter: ['!', ['has', 'point_count']], ...(source === 'cx-access' ? { minzoom: 11 } : {}), paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 16, 9], 'circle-color': ['get', 'color'], 'circle-stroke-color': dark ? '#eeeae3' : '#343a40', 'circle-stroke-width': 1.5 } });
    const labelId = id === 'cx-points' ? 'cx-point-label' : 'cx-access-label';
    if (!map.getLayer(labelId)) map.addLayer({ id: labelId, type: 'symbol', source, filter: ['!', ['has', 'point_count']], minzoom: source === 'cx-access' ? 11 : 10, layout: {
      'text-field': source === 'cx-access' ? ['get', 'accessLabel'] : ['format', ['get', 'label'], {}, ['get', 'deltaLabel'], { 'text-color': ['case', ['==', ['get', 'positiveDelta'], 1], dark ? '#ffa395' : '#b53d32', dark ? '#71d4b8' : '#23765f'] }],
      'text-size': 12, 'text-offset': [0, 1.6], 'text-font': ['Noto Sans Regular'], 'text-allow-overlap': false,
    }, paint: { 'text-color': dark ? '#f5f1e8' : '#18242b', 'text-halo-color': dark ? '#252a31' : '#ffffff', 'text-halo-width': 2 } });
  }
  map.setPaintProperty('cx-access-heat', 'heatmap-weight', view === 'heat' ? ['interpolate', ['linear'], ['get', 'total'], 0, 0, 60, 0.8, 180, 1.8] : ['interpolate', ['linear'], ['get', 'access'], 0, 0, 15, 0.7, 30, 1]);
  map.setLayoutProperty('cx-access-label', 'text-field', ['get', view === 'heat' ? 'label' : 'accessLabel']);
  map.getSource('cx-objects').setData(data);
  map.getSource('cx-access').setData(accessData);
  for (const id of ['cx-points', 'cx-point-label']) map.setLayoutProperty(id, 'visibility', enabled && view === 'markers' ? 'visible' : 'none');
  for (const id of ['cx-access-heat', 'cx-access-points', 'cx-access-label']) map.setLayoutProperty(id, 'visibility', enabled && view !== 'markers' ? 'visible' : 'none');
  map.setPaintProperty('cx-access-heat', 'heatmap-opacity', dark ? 0.75 : 0.65);
}

/** Hide the complete overlay on workspace changes, including while the base style reloads. */
export function hideObjectTimeLayers(map) {
  for (const id of ['cx-points', 'cx-point-label', 'cx-access-heat', 'cx-access-points', 'cx-access-label']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
}

/** Fit the selected layer's real coordinates, accounting for the open left panel. */
export function fitObjectTimeLayer(map, objects) {
  const points = objectTimeGeoJSON(objects).features.map(feature => feature.geometry.coordinates);
  if (!points.length) return;
  const container = map.getContainer();
  const box = container.getBoundingClientRect();
  const panel = container.closest('.workspace-grid')?.querySelector('.cx-time-panel');
  const sidebar = document.querySelector('.sidebar');
  const covered = Math.max(panel?.getBoundingClientRect().right || 0, sidebar?.getBoundingClientRect().right || 0) - box.left;
  const left = Math.min(container.clientWidth * 0.55, Math.max(32, covered * container.clientWidth / box.width + 24));
  map.fitBounds([[Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))], [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))]], { padding: { left, right: 92, top: 90, bottom: 80 }, maxZoom: 14, duration: 650 });
}
