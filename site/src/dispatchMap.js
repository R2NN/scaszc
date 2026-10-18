import { useEffect } from 'react';
import { Marker } from 'maplibre-gl';
import { renderDispatchRoutes, renderDispatchImpact, renderDispatchHighlight } from './dispatchComparison.js';

/** Draw a comparison on the existing map, starting both lines at the current position. */
export function attachDispatchMap(map, {events = window, dom = document, markerFactory = element => new Marker({element}), schedule = setTimeout, cancel = clearTimeout} = {}) {
  let marker;
  let originMarker;
  let highlightTimer;
  let impactFeatures = [];
  let impactNeedsFocus = false;
  let routeNeedsFocus = false;
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
    const element = dom.createElement('div');
    element.className = 'dispatch-map-incident'; element.textContent = '!'; element.setAttribute('aria-label', 'Место новой аварии');
    marker = markerFactory(element).setLngLat([coords[1], coords[0]]).addTo(map);
    const panel = (dom.querySelector('.shift-panel') || dom.querySelector('.orders-panel'))?.getBoundingClientRect();
    const bounds = map.getContainer().getBoundingClientRect();
    const sidebar = dom.querySelector('.sidebar')?.getBoundingClientRect();
    const visibleLeft = Math.max(panel?.right || 0, (sidebar?.right || 0) + 420);
    const offset = (visibleLeft + bounds.right - 60 - bounds.left - bounds.right) / 2;
    map.flyTo({ center: [coords[1], coords[0]], zoom: Math.max(13.4, map.getZoom()), offset: [Math.max(0, offset), -65], duration: 900, essential: true });
  };
  const clear = () => {
    latestPreview = null;
    map.off('idle', restore);
    cancel(highlightTimer);
    impactFeatures = [];
    impactNeedsFocus = false;
    routeNeedsFocus = false;
    for (const id of ['dispatch-impact-labels', 'dispatch-impact-points', 'dispatch-result-highlight', 'dispatch-stop-labels', 'dispatch-stop-points', 'dispatch-before-arrows', 'dispatch-after-arrows', 'dispatch-after-continuation', 'dispatch-before', 'dispatch-after']) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ['dispatch-impact', 'dispatch-result-highlight', 'dispatch-stops', 'dispatch-before', 'dispatch-after']) if (map.getSource(id)) map.removeSource(id);
    marker?.remove(); originMarker?.remove(); marker = null; originMarker = null;
    for (const [id, visibility] of hiddenLayers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    hiddenLayers.clear();
  };
  const preview = event => {
    if (!event.detail.restore) {
      impactFeatures = [];
      impactNeedsFocus = false;
      cancel(highlightTimer);
      if (map.getLayer('dispatch-result-highlight')) map.removeLayer('dispatch-result-highlight');
      if (map.getSource('dispatch-result-highlight')) map.removeSource('dispatch-result-highlight');
    }
    latestPreview = { ...event.detail, scope: event.detail.scope || latestPreview?.scope || 'day' };
    if (!map.isStyleLoaded()) {
      routeNeedsFocus = Boolean(event.detail.focusRoute);
      map.off('idle', restore);
      map.once('idle', restore);
      return;
    }
    const rendered = renderDispatchRoutes(map, latestPreview);
    hideBackgroundRoutes();
    renderDispatchImpact(map, impactFeatures);
    if (impactNeedsFocus) {
      fit(impactFeatures.map(feature => feature.geometry.coordinates));
      impactNeedsFocus = false;
    }
    if (event.detail.highlightIds) {
      cancel(highlightTimer);
      const highlighted = renderDispatchHighlight(map, latestPreview);
      latestPreview.highlightIds = undefined;
      highlightTimer = schedule(() => {
        if (map.getLayer('dispatch-result-highlight')) map.removeLayer('dispatch-result-highlight');
        if (map.getSource('dispatch-result-highlight')) map.removeSource('dispatch-result-highlight');
      }, 3600);
      if (event.detail.focusRoute && highlighted.features.length) fit(highlighted.features.flatMap(feature => feature.geometry.coordinates));
    }
    originMarker?.remove();
    if (event.detail.current?.origin) {
      const element = dom.createElement('div');
      element.className = 'dispatch-map-origin'; element.textContent = '●'; element.title = `Текущее положение · ${event.detail.current.time || ''}`;
      originMarker = markerFactory(element).setLngLat([event.detail.current.origin[1], event.detail.current.origin[0]]).addTo(map);
    }
    if (event.detail.focusRoute) {
      const points = [rendered.before, rendered.after]
        .flatMap(data => data.features.flatMap(feature => feature.geometry.coordinates));
      if (points.length) {
        if (!event.detail.highlightIds) fit(points);
      }
    }
  };
  const fit = points => {
    if (!points.length) return;
    const bounds = map.getContainer().getBoundingClientRect(), panel = dom.querySelector('.shift-panel')?.getBoundingClientRect();
    map.fitBounds([[Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))], [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]], {padding:{left:Math.min(bounds.width * .65,Math.max(40,(panel?.right || bounds.left) - bounds.left + 20)),right:60,top:90,bottom:150},maxZoom:15,duration:650});
  };
  const showImpact = event => {
    impactFeatures = event.detail.features;
    if (!map.isStyleLoaded()) {
      impactNeedsFocus = true;
      map.off('idle', restore);
      map.once('idle', restore);
      return;
    }
    renderDispatchImpact(map, impactFeatures);
    fit(impactFeatures.map(feature => feature.geometry.coordinates));
  };
  const changeScope = event => {
    if (latestPreview && ['day', 'next'].includes(event.detail?.scope)) preview({detail:{...latestPreview,scope:event.detail.scope,focusRoute:true}});
  };
  const restore = () => {
    if (latestPreview) preview({detail:{...latestPreview,focusRoute:routeNeedsFocus,restore:true}});
    routeNeedsFocus = false;
  };
  map.on('style.load', restore);
  map.on('styledata', hideBackgroundRoutes);
  events.addEventListener('beego:dispatch-impact', showImpact); events.addEventListener('beego:incident-focus', focus); events.addEventListener('beego:dispatch-preview', preview); events.addEventListener('beego:dispatch-clear', clear); events.addEventListener('beego:dispatch-scope', changeScope);
  return () => { map.off('style.load', restore); map.off('styledata', hideBackgroundRoutes); events.removeEventListener('beego:dispatch-impact', showImpact); events.removeEventListener('beego:incident-focus', focus); events.removeEventListener('beego:dispatch-preview', preview); events.removeEventListener('beego:dispatch-clear', clear); events.removeEventListener('beego:dispatch-scope', changeScope); clear(); };
}

/** Keep the existing map instance and release every comparison layer on unmount. */
export function useDispatchMap(map) {
  useEffect(() => map ? attachDispatchMap(map) : undefined, [map]);
}
