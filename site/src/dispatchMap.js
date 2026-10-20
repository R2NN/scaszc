import { useEffect } from 'react';
import { Marker } from 'maplibre-gl';
import { renderDispatchRoutes, renderDispatchImpact } from './dispatchComparison.js';
import { measureDispatchViewport } from './dispatchViewport.js';
import { DISPATCH_STOP_LABEL, DISPATCH_IMPACT_LABEL } from './dispatchLabelStyle.js';
import { savedDispatchFocus } from './dispatchMapEvents.js';

/** Draw a comparison on the existing map, starting both lines at the current position. */
export function attachDispatchMap(map, {events = window, dom = document, markerFactory = element => new Marker({element})} = {}) {
  let marker;
  let originMarker;
  let impactFeatures = [];
  let impactNeedsFocus = false;
  let routeNeedsFocus = false;
  let latestPreview;
  let routeLabels = [];
  let incidentCoords;
  const placeIncident = coords => {
    if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite)) return false;
    if (marker && incidentCoords?.every((value,index) => value === coords[index])) return true;
    marker?.remove();
    const element = dom.createElement('div');
    element.className = 'dispatch-map-incident'; element.textContent = '!'; element.setAttribute('aria-label','Место новой аварии');
    marker = markerFactory(element).setLngLat([coords[1],coords[0]]).addTo(map);
    incidentCoords = coords;
    return true;
  };
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
    if (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite)) return;
    clear();
    if (!placeIncident(coords)) return;
    if (!map.isStyleLoaded()) {
      routeNeedsFocus = true;
      map.off('idle',restore);map.once('idle',restore);
    } else fit([]);
  };
  const clear = () => {
    latestPreview = null;
    routeLabels = [];
    incidentCoords = null;
    map.off('idle', restore);
    impactFeatures = [];
    impactNeedsFocus = false;
    routeNeedsFocus = false;
    for (const id of ['dispatch-impact-labels', 'dispatch-impact-points', 'dispatch-stop-labels', 'dispatch-stop-points', 'dispatch-before-arrows', 'dispatch-after-arrows', 'dispatch-after-continuation', 'dispatch-before', 'dispatch-after']) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ['dispatch-impact', 'dispatch-stops', 'dispatch-before', 'dispatch-after']) if (map.getSource(id)) map.removeSource(id);
    marker?.remove(); originMarker?.remove(); marker = null; originMarker = null;
    for (const [id, visibility] of hiddenLayers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    hiddenLayers.clear();
  };
  const preview = event => {
    if (!event.detail.restore) {
      impactFeatures = [];
      impactNeedsFocus = false;
    }
    latestPreview = { ...event.detail, scope: event.detail.scope || latestPreview?.scope || 'day' };
    placeIncident(latestPreview.current?.emergencyCoords);
    if (!map.isStyleLoaded()) {
      routeNeedsFocus = Boolean(event.detail.focusRoute);
      map.off('idle', restore);
      map.once('idle', restore);
      return;
    }
    const rendered = renderDispatchRoutes(map, latestPreview);
    routeLabels = [rendered.before,rendered.after].flatMap(data => data.features.filter(feature => !feature.properties.movement).map(feature => ({...DISPATCH_STOP_LABEL,text:feature.properties.label})));
    hideBackgroundRoutes();
    renderDispatchImpact(map, impactFeatures);
    if (impactNeedsFocus) {
      fit(impactFeatures.map(feature => feature.geometry.coordinates));
      impactNeedsFocus = false;
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
      fit(points);
    }
  };
  const fit = points => {
    const anchors = [latestPreview?.current?.origin,latestPreview?.current?.emergencyCoords || incidentCoords].filter(Boolean).map(([lat,lon]) => [lon,lat]);
    const visible = [...points,...anchors];
    if (!visible.length) return;
    const padding = measureDispatchViewport(map,dom,[...routeLabels,...impactFeatures.map(feature => ({...DISPATCH_IMPACT_LABEL,text:feature.properties.address}))]);
    if (!padding) return;
    map.fitBounds([[Math.min(...visible.map(p => p[0])),Math.min(...visible.map(p => p[1]))],[Math.max(...visible.map(p => p[0])),Math.max(...visible.map(p => p[1]))]],{padding,retainPadding:false,maxZoom:15,duration:650});
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
    else if (incidentCoords) fit([]);
    routeNeedsFocus = false;
  };
  const refit = () => {
    if (!latestPreview) {if (incidentCoords) fit([]);return;}
    if (latestPreview.focusRoute === false) return;
    preview({detail:{...latestPreview,focusRoute:true,restore:true}});
  };
  const layoutSettled = event => {
    if (event.target?.matches?.('.shift-panel,.shift-timeline,.map-control-stack,.sidebar')) refit();
  };
  map.on('style.load', restore);
  map.on('styledata', hideBackgroundRoutes);
  events.addEventListener('resize',refit);
  dom.addEventListener?.('transitionend',layoutSettled,true);
  dom.addEventListener?.('animationend',layoutSettled,true);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null;
  for (const selector of ['.shift-panel','.map-control-stack','.shift-timeline']) for (const element of dom.querySelectorAll?.(selector) || []) observer?.observe(element);
  events.addEventListener('beego:dispatch-impact', showImpact); events.addEventListener('beego:incident-focus', focus); events.addEventListener('beego:dispatch-preview', preview); events.addEventListener('beego:dispatch-clear', clear); events.addEventListener('beego:dispatch-scope', changeScope);
  const retained = savedDispatchFocus(events);
  if (retained) focus({detail:retained});
  return () => {observer?.disconnect();events.removeEventListener('resize',refit);dom.removeEventListener?.('transitionend',layoutSettled,true);dom.removeEventListener?.('animationend',layoutSettled,true); map.off('style.load', restore); map.off('styledata', hideBackgroundRoutes); events.removeEventListener('beego:dispatch-impact', showImpact); events.removeEventListener('beego:incident-focus', focus); events.removeEventListener('beego:dispatch-preview', preview); events.removeEventListener('beego:dispatch-clear', clear); events.removeEventListener('beego:dispatch-scope', changeScope); clear(); };
}

/** Keep the existing map instance and release every comparison layer on unmount. */
export function useDispatchMap(map) {
  useEffect(() => map ? attachDispatchMap(map) : undefined, [map]);
}
