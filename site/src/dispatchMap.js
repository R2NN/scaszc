import { useEffect } from 'react';
import { Marker } from 'maplibre-gl';

const asLine = geometry => Array.isArray(geometry) && geometry.length > 1
  ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: geometry.map(([lat, lon]) => [lon, lat]) } }
  : null;
const currentTime = detail => detail.current?.time || '';
const future = (visit, time) => !time || String(visit.plannedStart || '99:99') >= time;

/** Draw the selected engineer's remaining day from the current position. */
const routeData = (plan, detail, includeMovements) => ({
  type: 'FeatureCollection',
  features: (plan?.routes || []).filter(route => detail.ids.includes(route.engineerId)).flatMap(route => {
    const time = currentTime(detail);
    const visits = (route.assignments || []).filter(visit => future(visit, time));
    const features = visits.map(visit => asLine(visit.geometry)).filter(Boolean);
    if (includeMovements) for (const movement of route.movements || []) {
      if (!time || String(movement.measured_at || '').slice(11, 16) >= time) {
        const line = asLine(movement.geometry);
        if (line) features.unshift(line);
      }
    }
    if (route.engineerId === detail.current?.engineerId && detail.current?.origin && features[0]) {
      const [lat, lon] = detail.current.origin;
      const first = features[0].geometry.coordinates[0];
      features.unshift({ type: 'Feature', properties: { branch: true }, geometry: { type: 'LineString', coordinates: [[lon, lat], first] } });
    }
    return features;
  }),
});

/** Draw a comparison on the existing map, starting both lines at the current position. */
export function useDispatchMap(map) {
  useEffect(() => {
    if (!map) return undefined;
    let marker;
    let originMarker;
    let latestPreview;
    const focus = event => {
      const coords = event.detail?.coords;
      if (!coords) return;
      marker?.remove();
      const element = document.createElement('div');
      element.className = 'dispatch-map-incident'; element.textContent = '!'; element.setAttribute('aria-label', 'Место новой аварии');
      marker = new Marker({ element }).setLngLat([coords[1], coords[0]]).addTo(map);
      const panel = (document.querySelector('.shift-panel') || document.querySelector('.orders-panel'))?.getBoundingClientRect();
      const bounds = map.getContainer().getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
      const visibleLeft = Math.max(panel?.right || 0, (sidebar?.right || 0) + 420);
      const offset = (visibleLeft + bounds.right - 60 - bounds.left - bounds.right) / 2;
      map.flyTo({ center: [coords[1], coords[0]], zoom: Math.max(13.4, map.getZoom()), offset: [Math.max(0, offset), -65], duration: 900, essential: true });
    };
    const clear = () => {
      latestPreview = null;
      for (const key of ['before', 'after']) {
        if (map.getLayer(`dispatch-${key}`)) map.removeLayer(`dispatch-${key}`);
        if (map.getSource(`dispatch-${key}`)) map.removeSource(`dispatch-${key}`);
      }
      marker?.remove(); originMarker?.remove(); marker = null; originMarker = null;
    };
    const preview = event => {
      latestPreview = event.detail;
      const intercept = event.detail.current?.kind === 'Перехват в пути';
      const styles = intercept ? [['before', '#7c3aed', [1, 0]], ['after', '#ef4444', [1, 0]]] : [['before', '#737b87', [3, 3]], ['after', '#7c3aed', [1, 0]]];
      for (const [key, color, dash] of styles) {
        const data = routeData(event.detail[key], event.detail, key === 'after');
        const source = map.getSource(`dispatch-${key}`);
        if (source) source.setData(data);
        else if (map.isStyleLoaded()) {
          map.addSource(`dispatch-${key}`, { type: 'geojson', data });
          map.addLayer({ id: `dispatch-${key}`, type: 'line', source: `dispatch-${key}`, paint: { 'line-color': color, 'line-width': intercept ? 6 : key === 'after' ? 5 : 4, 'line-dasharray': dash, 'line-opacity': .94 } });
        }
      }
      originMarker?.remove();
      if (event.detail.current?.origin) {
        const element = document.createElement('div');
        element.className = 'dispatch-map-origin'; element.textContent = '●'; element.title = `Текущее положение · ${event.detail.current.time || ''}`;
        originMarker = new Marker({ element }).setLngLat([event.detail.current.origin[1], event.detail.current.origin[0]]).addTo(map);
      }
      if (event.detail.focusRoute) {
        const data = routeData(event.detail.after, event.detail, true);
        const points = data.features.flatMap(feature => feature.geometry.coordinates);
        if (points.length) {
          const bounds = map.getContainer().getBoundingClientRect(), panel = document.querySelector('.shift-panel')?.getBoundingClientRect();
          map.fitBounds([[Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))], [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]], { padding: { left: Math.min(bounds.width * .65, Math.max(40, (panel?.right || bounds.left) - bounds.left + 20)), right: 60, top: 90, bottom: 150 }, maxZoom: 13.5, duration: 850 });
        }
      }
    };
    const restore = () => { if (latestPreview) preview({ detail: { ...latestPreview, focusRoute: false } }); };
    map.on('style.load', restore);
    window.addEventListener('beego:incident-focus', focus); window.addEventListener('beego:dispatch-preview', preview); window.addEventListener('beego:dispatch-clear', clear);
    return () => { map.off('style.load', restore); window.removeEventListener('beego:incident-focus', focus); window.removeEventListener('beego:dispatch-preview', preview); window.removeEventListener('beego:dispatch-clear', clear); clear(); };
  }, [map]);
}
