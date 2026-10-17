import { useEffect } from 'react';
import { Marker } from 'maplibre-gl';
import { dispatchRouteData, renderDispatchRoutes } from './dispatchComparison.js';

/** Draw a comparison on the existing map, starting both lines at the current position. */
export function useDispatchMap(map) {
  useEffect(() => {
    if (!map) return undefined;
    let marker;
    let originMarker;
    let legend;
    let latestPreview;
    const hiddenLayers = new Map();
    const hideBackgroundRoutes = () => {
      if (!latestPreview) return;
      for (const id of ['planned-route', 'planned-route-casing', 'planned-route-arrows', 'planned-route-hit', 'shift-route-remaining', 'shift-route-travelled']) {
        if (!map.getLayer(id)) continue;
        if (!hiddenLayers.has(id)) hiddenLayers.set(id, map.getLayoutProperty(id, 'visibility') || 'visible');
        if (map.getLayoutProperty(id, 'visibility') !== 'none') map.setLayoutProperty(id, 'visibility', 'none');
      }
    };
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
      map.off('idle', restore);
      for (const key of ['before', 'after']) {
        if (map.getLayer(`dispatch-${key}`)) map.removeLayer(`dispatch-${key}`);
        if (map.getSource(`dispatch-${key}`)) map.removeSource(`dispatch-${key}`);
      }
      marker?.remove(); originMarker?.remove(); marker = null; originMarker = null;
      legend?.remove(); legend = null;
      for (const [id, visibility] of hiddenLayers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
      hiddenLayers.clear();
    };
    const preview = event => {
      latestPreview = event.detail;
      const intercept = event.detail.current?.kind === 'Перехват в пути';
      if (!map.isStyleLoaded()) {
        map.off('idle', restore);
        map.once('idle', restore);
        return;
      }
      renderDispatchRoutes(map, event.detail);
      hideBackgroundRoutes();
      legend?.remove();
      legend = document.createElement('div');
      legend.className = `dispatch-comparison-legend${intercept ? ' intercept' : ''}`;
      legend.setAttribute('aria-label', 'Сравнение маршрутов');
      for (const [className, label] of [['origin', `Точка выбора · ${event.detail.current?.time || ''}`], ['before', 'Продолжить свои заявки'], ['after', 'Направить на аварию']]) {
        const row = document.createElement('div');
        row.className = className; row.textContent = label; legend.appendChild(row);
      }
      map.getContainer().appendChild(legend);
      originMarker?.remove();
      if (event.detail.current?.origin) {
        const element = document.createElement('div');
        element.className = 'dispatch-map-origin'; element.textContent = '●'; element.title = `Текущее положение · ${event.detail.current.time || ''}`;
        originMarker = new Marker({ element }).setLngLat([event.detail.current.origin[1], event.detail.current.origin[0]]).addTo(map);
      }
      if (event.detail.focusRoute) {
        const points = [dispatchRouteData(event.detail.before, event.detail), dispatchRouteData(event.detail.after, event.detail, true)]
          .flatMap(data => data.features.flatMap(feature => feature.geometry.coordinates));
        if (points.length) {
          const bounds = map.getContainer().getBoundingClientRect(), panel = document.querySelector('.shift-panel')?.getBoundingClientRect();
          map.fitBounds([[Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))], [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]], { padding: { left: Math.min(bounds.width * .65, Math.max(40, (panel?.right || bounds.left) - bounds.left + 20)), right: 60, top: 90, bottom: 150 }, maxZoom: 13.5, duration: 850 });
        }
      }
    };
    const restore = () => { if (latestPreview) preview({ detail: { ...latestPreview, focusRoute: false } }); };
    map.on('style.load', restore);
    map.on('styledata', hideBackgroundRoutes);
    window.addEventListener('beego:incident-focus', focus); window.addEventListener('beego:dispatch-preview', preview); window.addEventListener('beego:dispatch-clear', clear);
    return () => { map.off('style.load', restore); map.off('styledata', hideBackgroundRoutes); window.removeEventListener('beego:incident-focus', focus); window.removeEventListener('beego:dispatch-preview', preview); window.removeEventListener('beego:dispatch-clear', clear); clear(); };
  }, [map]);
}
