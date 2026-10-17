import { useEffect } from 'react';
import { Marker } from 'maplibre-gl';
import { renderDispatchRoutes } from './dispatchComparison.js';

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
      for (const id of ['dispatch-stop-labels', 'dispatch-stop-points', 'dispatch-before-arrows', 'dispatch-after-arrows', 'dispatch-after-continuation', 'dispatch-before', 'dispatch-after']) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of ['dispatch-stops', 'dispatch-before', 'dispatch-after']) if (map.getSource(id)) map.removeSource(id);
      marker?.remove(); originMarker?.remove(); marker = null; originMarker = null;
      legend?.remove(); legend = null;
      for (const [id, visibility] of hiddenLayers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
      hiddenLayers.clear();
    };
    const preview = event => {
      latestPreview = { ...event.detail, scope: event.detail.scope || latestPreview?.scope || 'day' };
      const intercept = Boolean(event.detail.current?.emergencyOrderId) || event.detail.current?.kind === 'Перехват в пути';
      if (!map.isStyleLoaded()) {
        map.off('idle', restore);
        map.once('idle', restore);
        return;
      }
      const rendered = renderDispatchRoutes(map, latestPreview);
      hideBackgroundRoutes();
      legend?.remove();
      legend = document.createElement('div');
      legend.className = `dispatch-comparison-legend${intercept ? ' intercept' : ''}`;
      legend.setAttribute('aria-label', 'Сравнение маршрутов');
      const wholeDay = latestPreview.scope === 'day';
      const toEmergency = rendered.after.features.some(feature => feature.properties.orderId === event.detail.current?.emergencyOrderId);
      const rows = [['origin', `${event.detail.current?.kind === 'Выезд из дома' ? 'Домашний старт' : 'От положения'} в ${event.detail.current?.time || ''}`]];
      if (rendered.before.features.length) rows.push(['before', wholeDay ? 'Будущие заявки без перехвата' : 'К своей следующей заявке']);
      rows.push(['after', toEmergency ? 'До аварии · стрелки по ходу движения' : 'Новый путь к следующей заявке']);
      if (wholeDay && rendered.after.features.some(f=>f.properties.phase==='continuation')) rows.push(['continuation', toEmergency ? 'Пунктир — заявки после аварии' : 'Пунктир — следующие заявки']);
      if (wholeDay && rendered.after.features.filter(f=>!f.properties.movement).length > 1) rows.push(['note', 'Цифры — порядок заявок, время — прибытие']);
      for (const [className, label] of rows) {
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
        const points = [rendered.before, rendered.after]
          .flatMap(data => data.features.flatMap(feature => feature.geometry.coordinates));
        if (points.length) {
          const bounds = map.getContainer().getBoundingClientRect(), panel = document.querySelector('.shift-panel')?.getBoundingClientRect();
          map.fitBounds([[Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))], [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]], { padding: { left: Math.min(bounds.width * .65, Math.max(40, (panel?.right || bounds.left) - bounds.left + 20)), right: 60, top: 90, bottom: 150 }, maxZoom: 13.5, duration: 850 });
        }
      }
    };
    const changeScope = event => {
      if (latestPreview && ['day', 'next'].includes(event.detail?.scope)) preview({detail:{...latestPreview,scope:event.detail.scope,focusRoute:true}});
    };
    const restore = () => { if (latestPreview) preview({ detail: { ...latestPreview, focusRoute: false } }); };
    map.on('style.load', restore);
    map.on('styledata', hideBackgroundRoutes);
    window.addEventListener('beego:incident-focus', focus); window.addEventListener('beego:dispatch-preview', preview); window.addEventListener('beego:dispatch-clear', clear); window.addEventListener('beego:dispatch-scope', changeScope);
    return () => { map.off('style.load', restore); map.off('styledata', hideBackgroundRoutes); window.removeEventListener('beego:incident-focus', focus); window.removeEventListener('beego:dispatch-preview', preview); window.removeEventListener('beego:dispatch-clear', clear); window.removeEventListener('beego:dispatch-scope', changeScope); clear(); };
  }, [map]);
}
