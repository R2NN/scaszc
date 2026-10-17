import { useEffect } from 'react';
import { Marker } from 'maplibre-gl';

/** Draw a comparison on the existing map and focus only on explicit operator action. */
export function useDispatchMap(map) {
  useEffect(() => {
    if (!map) return undefined;
    let marker;
    let latestPreview;
    const focus = event => {
      const coords = event.detail?.coords;
      if (!coords) return;
      marker?.remove();
      const element = document.createElement('div');
      element.className = 'dispatch-map-incident'; element.textContent = '!'; element.setAttribute('aria-label', 'Место новой аварии');
      marker = new Marker({ element }).setLngLat([coords[1],coords[0]]).addTo(map);
      const panel = (document.querySelector('.shift-panel') || document.querySelector('.orders-panel'))?.getBoundingClientRect();
      const bounds = map.getContainer().getBoundingClientRect();
      const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
      const visibleLeft = Math.max(panel?.right || 0,(sidebar?.right || 0)+420);
      const offset = (visibleLeft + bounds.right - 60 - bounds.left - bounds.right)/2;
      map.flyTo({center:[coords[1],coords[0]],zoom:Math.max(13.4,map.getZoom()),offset:[Math.max(0,offset),-65],duration:900,essential:true});
    };
    const clear = () => { latestPreview=null;for (const key of ['before','after']) { if(map.getLayer(`dispatch-${key}`))map.removeLayer(`dispatch-${key}`);if(map.getSource(`dispatch-${key}`))map.removeSource(`dispatch-${key}`); } marker?.remove(); };
    const preview = event => {
      latestPreview=event.detail;
      for (const [key,color,dash] of [['before','#737b87',[3,3]],['after','#7c3aed',[1,0]]]) {
        const data = {type:'FeatureCollection',features:(event.detail[key]?.routes || []).filter(route => event.detail.ids.includes(route.engineerId)).flatMap(route => [...(route.movements || []).map(m => ({geometry:m.geometry})), ...route.assignments].filter(visit => visit.geometry?.length>1).map(visit => ({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:visit.geometry.map(([lat,lon])=>[lon,lat])}})))};
        const source = map.getSource(`dispatch-${key}`);
        if (source) source.setData(data);
        else if (map.isStyleLoaded()) { map.addSource(`dispatch-${key}`,{type:'geojson',data});map.addLayer({id:`dispatch-${key}`,type:'line',source:`dispatch-${key}`,paint:{'line-color':color,'line-width':key==='after'?5:4,'line-dasharray':dash,'line-opacity':.9}}); }
      }
      if(event.detail.focusRoute){
        const points=(event.detail.after?.routes || []).filter(route=>event.detail.ids.includes(route.engineerId)).flatMap(route=>[...(route.movements || []).map(item=>({geometry:item.geometry})),...route.assignments].flatMap(visit=>visit.geometry || []));
        if(points.length){
          const bounds=map.getContainer().getBoundingClientRect(),panel=document.querySelector('.shift-panel')?.getBoundingClientRect();
          map.fitBounds([[Math.min(...points.map(p=>p[1])),Math.min(...points.map(p=>p[0]))],[Math.max(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0]))]],{padding:{left:Math.min(bounds.width*.65,Math.max(40,(panel?.right || bounds.left)-bounds.left+20)),right:60,top:90,bottom:150},maxZoom:13.5,duration:850});
        }
      }
    };
    const restore=()=>{if(latestPreview)preview({detail:{...latestPreview,focusRoute:false}});};
    map.on('style.load',restore);
    window.addEventListener('beego:incident-focus',focus);window.addEventListener('beego:dispatch-preview',preview);window.addEventListener('beego:dispatch-clear',clear);
    return () => { map.off('style.load',restore);window.removeEventListener('beego:incident-focus',focus);window.removeEventListener('beego:dispatch-preview',preview);window.removeEventListener('beego:dispatch-clear',clear);clear(); };
  }, [map]);
}
