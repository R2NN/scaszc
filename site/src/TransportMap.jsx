import { useEffect, useRef, useSyncExternalStore } from 'react';
import * as maplibregl from 'maplibre-gl';
import { Car, TrainFront, Undo2, Crosshair, Layers3, Plus, Footprints } from 'lucide-react';
import { transportStatus } from './transportDomain.js';

let view={enabled:false,metro:true};
const listeners=new Set();
let liveMap=null;
/** A small bridge keeps transport overlays on the existing persistent MapLibre map. */
export const transportMap={
  subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  snapshot:()=>view,
  set:patch=>{view={...view,...patch};listeners.forEach(fn=>fn());},
  focus(segments){
    const coords=segments.flatMap(s=>s.geometry || []).map(p=>[p[1],p[0]]);
    if(!liveMap||!coords.length)return;
    const bounds=coords.reduce((b,p)=>b.extend(p),new maplibregl.LngLatBounds(coords[0],coords[0]));
    const scale=liveMap.getCanvas().getBoundingClientRect().width/liveMap.getContainer().clientWidth;
    const width=liveMap.getContainer().clientWidth;
    const mapRect=liveMap.getCanvas().getBoundingClientRect();
    const panel=document.querySelector('.transport-workspace-panel,.shift-layer.operational-shift .shift-panel')?.getBoundingClientRect();
    const left=Math.min(width*.72,Math.max(85,(panel?.right || 490)-mapRect.left+44)/scale);
    const legend=document.querySelector('.transport-map-legend')?.getBoundingClientRect();
    const bottom=Math.max(100,legend?(mapRect.bottom-legend.top+45)/scale:150);
    const padding=window.innerWidth<=760?{left:80,top:Math.min(liveMap.getContainer().clientHeight*.66,((panel?.bottom || 350)-mapRect.top+20)/scale),right:85,bottom:Math.min(bottom,liveMap.getContainer().clientHeight*.25)}:{left,top:155,right:125,bottom};
    liveMap.fitBounds(bounds,{padding,maxZoom:14.6,duration:650});
  },
};
const collection=features=>({type:'FeatureCollection',features});
const line=(geometry,properties)=>({type:'Feature',geometry:{type:'LineString',coordinates:geometry.map(p=>[p[1],p[0]])},properties});
const point=(coords,properties)=>({type:'Feature',geometry:{type:'Point',coordinates:[coords[1],coords[0]]},properties});

/** Transport topology, closures and independently checked detours; never a second map. */
export function TransportMapLayer({map,theme}) {
  const state=useSyncExternalStore(transportMap.subscribe,transportMap.snapshot);
  const current=useRef(state),renderRef=useRef(null);
  current.current=state;
  // Clock minutes change five times a second at ×300. Only crossing an event
  // boundary changes this overlay; callbacks still read the latest panel state.
  const statuses=[...(state.events || []),...(state.draft?[state.draft]:[])].map(event=>transportStatus(event,state.date,state.minute || 0)).join('|');
  useEffect(()=>{liveMap=map;return()=>{if(liveMap===map)liveMap=null;};},[map]);
  useEffect(()=>{
    if(!map)return;
    let markers=[];
    let captionsToPlace=[];
    const outer=map.getContainer().parentElement;
    const place=()=>{
      const rect=map.getContainer().getBoundingClientRect(),scale=rect.width/map.getContainer().clientWidth;
      const panel=document.querySelector('.transport-workspace-panel,.shift-layer.operational-shift .shift-panel')?.getBoundingClientRect();
      const timeline=document.querySelector('.shift-timeline')?.getBoundingClientRect();
      const left=window.innerWidth<=760?12:Math.max(12,((panel?.right||rect.left)-rect.left)/scale+22);
      const bottom=timeline?Math.max(20,(rect.bottom-timeline.top)/scale+20):24;
      outer.style.setProperty('--transport-corridor-left',`${left}px`);
      outer.style.setProperty('--transport-corridor-bottom',`${bottom}px`);
      const legend=outer.querySelector('.transport-map-legend')?.getBoundingClientRect();
      const width=map.getContainer().clientWidth,height=map.getContainer().clientHeight;
      const top=window.innerWidth<=760&&panel?(panel.bottom-rect.top)/scale+12:145;
      const limit=legend?(legend.top-rect.top)/scale-12:height-bottom;
      const placed=[];
      const ordered=[...captionsToPlace].sort((a,b)=>map.project(a.coords).y-map.project(b.coords).y);
      for(const {marker,coords,level} of ordered){
        const element=marker.getElement(),p=map.project(coords),w=element.getBoundingClientRect().width/scale,h=element.getBoundingClientRect().height/scale;
        const x=Math.max(left,Math.min(width-95-w,p.x+22));
        const desired=Math.max(top,Math.min(limit-h,p.y-h-22-level*68));
        const candidates=[desired,...placed.flatMap(box=>[box.y-h-8,box.y+box.h+8])].filter(y=>y>=top&&y+h<=limit);
        const y=candidates.filter(y=>!placed.some(box=>x<box.x+box.w+6&&x+w+6>box.x&&y<box.y+box.h+6&&y+h+6>box.y)).sort((a,b)=>Math.abs(a-desired)-Math.abs(b-desired))[0]??desired;
        placed.push({x,y,w,h});
        marker.setOffset([x-p.x,y-p.y]);
      }
    };
    const backgroundVisibility=new Map();
    const dimmed=new Map();
    let baseTheme=map.getContainer().dataset.mapTheme;
    const restoreBackground=()=>{delete map.getContainer().dataset.transportComparison;for(const [id,visibility] of backgroundVisibility)if(map.getLayer(id))map.setLayoutProperty(id,'visibility',visibility);backgroundVisibility.clear();for(const [id,{property,value}] of dimmed)if(map.getLayer(id))map.setPaintProperty(id,property,value);dimmed.clear();};
    const sources=['beego-transport-network','beego-transport-stations','beego-transport-closed','beego-transport-before','beego-transport-after'];
    const written=new Map();
    const write=(id,data)=>{
      const source=map.getSource(id),signature=JSON.stringify(data),previous=written.get(id);
      if(previous?.source===source&&previous.signature===signature)return;
      source.setData(data);written.set(id,{source,signature});
    };
    const layers=[
      {id:'beego-transport-links',type:'line',source:sources[0],paint:{'line-color':['get','color'],'line-width':2.4,'line-opacity':.55,'line-dasharray':[2,1.6]}},
      {id:'beego-transport-stations',type:'circle',source:sources[1],paint:{'circle-radius':5,'circle-color':'#fff','circle-stroke-color':['get','color'],'circle-stroke-width':2.5}},
      {id:'beego-transport-station-labels',type:'symbol',source:sources[1],minzoom:11.3,layout:{'text-field':['concat','M · ',['get','name']],'text-size':12,'text-font':['Noto Sans Regular'],'text-anchor':'top-left','text-offset':[.7,.5],'text-max-width':13,'text-optional':true},paint:{'text-color':'#394650','text-halo-color':'#fff','text-halo-width':2}},
      {id:'beego-transport-before',type:'line',source:sources[3],paint:{'line-color':'#868b93','line-width':4,'line-dasharray':[2,1.5],'line-opacity':.8}},
      {id:'beego-transport-casing',type:'line',source:sources[4],layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#fff','line-width':9}},
      {id:'beego-transport-after',type:'line',source:sources[4],filter:['!',['in',['get','mode'],['literal',['walking','pedestrian','walking_transfer']]]],layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#7c16eb','line-width':5}},
      {id:'beego-transport-after-walking',type:'line',source:sources[4],filter:['in',['get','mode'],['literal',['walking','pedestrian','walking_transfer']]],layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#7c16eb','line-width':4,'line-dasharray':[.5,1.5]}},
      {id:'beego-transport-arrows',type:'symbol',source:sources[4],layout:{'symbol-placement':'line','symbol-spacing':100,'icon-image':'beego-transport-arrow','icon-size':1,'icon-rotation-alignment':'map','icon-keep-upright':false,'icon-allow-overlap':true}},
      {id:'beego-transport-closed-casing',type:'line',source:sources[2],paint:{'line-color':'#fff','line-width':17}},
      {id:'beego-transport-closed',type:'line',source:sources[2],paint:{'line-color':'#ff344b','line-width':12,'line-opacity':['case',['get','ended'],.4,1]}},
      {id:'beego-transport-hatching',type:'line',source:sources[2],paint:{'line-color':'#fff','line-width':9,'line-dasharray':[.15,.5]}},
      {id:'beego-transport-closed-arrows',type:'symbol',source:sources[2],filter:['!=',['get','direction'],'both'],layout:{'symbol-placement':'line','symbol-spacing':65,'text-field':'❯','text-size':18,'text-font':['Noto Sans Regular'],'text-keep-upright':false,'text-allow-overlap':true},paint:{'text-color':'#ff1839','text-halo-color':'#fff','text-halo-width':2}},
    ];
    const render=()=>{
      const state=current.current;
      map.getCanvas().style.cursor=state.enabled&&state.drawing?'crosshair':'';
      if(!state.enabled){markers.forEach(m=>m.remove());markers=[];restoreBackground();for(const layer of layers)if(map.getLayer(layer.id))map.setLayoutProperty(layer.id,'visibility','none');return;}
      // Updating a GeoJSON source temporarily makes isStyleLoaded() false.
      // Existing layers are safe to update without waiting for every tile.
      if(!map.getLayer(layers[0].id)&&!map.isStyleLoaded()){map.off('idle',render);map.once('idle',render);return;}
      map.off('idle',render);
      if(baseTheme!==map.getContainer().dataset.mapTheme){
        for(const [id,record] of dimmed)if(map.getLayer(id)){
          const value=map.getPaintProperty(id,record.property);
          if(value!==.55)record.value=value;
          map.setPaintProperty(id,record.property,.55);
        }
        baseTheme=map.getContainer().dataset.mapTheme;
      }
      markers.forEach(m=>m.remove());markers=[];captionsToPlace=[];
      if(!map.hasImage('beego-transport-arrow')){
        const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;const ctx=canvas.getContext('2d');
        ctx.beginPath();ctx.moveTo(32,20);ctx.lineTo(12,7);ctx.lineTo(18,20);ctx.lineTo(12,33);ctx.closePath();ctx.lineWidth=5;ctx.strokeStyle='#fff';ctx.stroke();ctx.fillStyle='#7c16eb';ctx.fill();
        map.addImage('beego-transport-arrow',ctx.getImageData(0,0,40,40),{pixelRatio:2});
      }
      for(const id of sources)if(!map.getSource(id))map.addSource(id,{type:'geojson',data:collection([])});
      for(const layer of layers)if(!map.getLayer(layer.id))map.addLayer(layer);
      const hide=state.preview?.result?.consequences?.orders?.length?['planned-route','planned-route-casing','planned-route-arrows','planned-route-hit','shift-route-remaining','shift-route-travelled']:state.drawing?['planned-route-hit']:[];
      for(const [id,visibility] of backgroundVisibility)if(!hide.includes(id)){if(map.getLayer(id))map.setLayoutProperty(id,'visibility',visibility);backgroundVisibility.delete(id);}
      if(state.preview?.result||state.drawing)map.getContainer().dataset.transportComparison='true';else delete map.getContainer().dataset.transportComparison;
      if(state.preview?.result){
        for(const layer of map.getStyle().layers){
          if(/^(beego-|planned-|shift-|object-|dispatch-)/.test(layer.id)||dimmed.has(layer.id))continue;
          const property=({raster:'raster-opacity',fill:'fill-opacity',line:'line-opacity',symbol:'text-opacity',circle:'circle-opacity'})[layer.type];
          if(property){dimmed.set(layer.id,{property,value:map.getPaintProperty(layer.id,property)});map.setPaintProperty(layer.id,property,.55);}
        }
      }else{for(const [id,{property,value}] of dimmed)if(map.getLayer(id))map.setPaintProperty(id,property,value);dimmed.clear();}
      for(const id of hide)if(map.getLayer(id)){if(!backgroundVisibility.has(id))backgroundVisibility.set(id,map.getLayoutProperty(id,'visibility') || 'visible');map.setLayoutProperty(id,'visibility','none');}
      const dark=map.getContainer().closest('.app-shell')?.classList.contains('dark');
      map.setPaintProperty('beego-transport-station-labels','text-color',dark?'#eff3fa':'#394650');
      map.setPaintProperty('beego-transport-station-labels','text-halo-color',dark?'#202a39':'#fff');
      for(const layer of layers)map.setLayoutProperty(layer.id,'visibility',state.enabled && (!layer.source.includes('network')&&!layer.source.includes('stations')||state.metro)?'visible':'none');
      const catalog=state.catalog;
      const colors=catalog?.lines || {};
      write(sources[0],collection((catalog?.segments || []).map(s=>line(s.geometry,{id:s.id,color:colors[s.lineId]?.color || '#aab0bb',kind:s.kind}))));
      write(sources[1],collection((catalog?.stations || []).map(s=>point(s.coords,{id:s.id,name:s.name,color:colors[s.lineId]?.color || '#d41317'}))));
      const events=[...(state.events || [])];
      if(state.draft?.segments?.length)events.push({...state.draft,id:'draft',title:state.draft.title||'Новое ограничение',status:'OPEN'});
      const stationIds=[...new Set(events.filter(event=>!['Завершено','Отменено'].includes(transportStatus(event,state.date,state.minute||0))).flatMap(event=>event.segments.flatMap(segment=>[segment.fromId,segment.toId])).filter(id=>String(id).startsWith('m:')))];
      const affected=['in',['get','id'],['literal',stationIds]];
      map.setFilter('beego-transport-station-labels',state.preview?.result?affected:null);
      map.setLayerZoomRange('beego-transport-station-labels',state.preview?.result?0:11.3,24);
      map.setPaintProperty('beego-transport-station-labels','text-color',['case',affected,'#df1736',dark?'#eff3fa':'#394650']);
      map.setLayoutProperty('beego-transport-station-labels','text-size',['case',affected,15,12]);
      map.setPaintProperty('beego-transport-stations','circle-opacity',state.preview?.result?['case',affected,1,.25]:1);
      map.setPaintProperty('beego-transport-stations','circle-stroke-opacity',state.preview?.result?['case',affected,1,.25]:1);
      map.setPaintProperty('beego-transport-links','line-opacity',state.preview?.result?.22:.55);
      const closures=[];
      const captions=[];
      for(const event of events){
        if(event.id===state.editingId||event.status==='CANCELLED')continue;
        const status=transportStatus(event,state.date,state.minute || 0);
        if(status==='Завершено'&&!state.showEnded)continue;
        for(const segment of event.segments){
          if(segment.geometry.length>1)closures.push(line(event.direction==='reverse'?[...segment.geometry].reverse():segment.geometry,{id:event.id,kind:event.kind,direction:event.kind==='road'&&!segment.opposingEdgeId?'forward':event.direction,ended:status==='Завершено'}));
          for(const p of [segment.geometry[0],...(segment.geometry.length>1?[segment.geometry.at(-1)]:[])]){
            const element=document.createElement('button');element.className=`transport-map-pin ${event.kind==='road'?'road':'metro'} ${status==='Запланировано'?'planned':''} ${status==='Завершено'?'ended':''}`;
            element.textContent=event.kind==='road'?'−':'M';element.type='button';element.title=event.title;element.setAttribute('aria-label',`Открыть ограничение: ${event.title}`);
            element.onclick=e=>{e.stopPropagation();current.current.onSelect?.(event);};
            markers.push(new maplibregl.Marker({element}).setLngLat([p[1],p[0]]).addTo(map));
          }
        }
        const selected=event.segments[0];
        if(selected){const p=selected.geometry[Math.floor(selected.geometry.length/2)],element=document.createElement('button');
          element.className='transport-map-caption';element.type='button';element.textContent=`${event.kind==='road'?'⊘ Авто':'M Метро'} · ${event.title}`;
          const time=document.createElement('small');time.textContent=`${status} · ${event.startsAt?.slice(11,16)}–${event.endsAt?.slice(11,16)||'срок неизвестен'}`;element.append(time);
          element.onclick=()=>current.current.onSelect?.(event);
          const projected=map.project([p[1],p[0]]);let level=0;
          while(captions.some(c=>Math.abs(c.x-projected.x)<245&&Math.abs(c.y-(projected.y-level*68))<60))level++;
          captions.push({x:projected.x,y:projected.y-level*68});
          const marker=new maplibregl.Marker({element,anchor:'top-left'}).setLngLat([p[1],p[0]]).addTo(map);
          markers.push(marker);captionsToPlace.push({marker,coords:[p[1],p[0]],level});
        }
      }
      write(sources[2],collection(closures));
      const impacts=state.preview?.result?.consequences?.orders?.filter(o=>!o.lost) || [];
      const selected=impacts.filter(o=>!state.engineerId||o.engineerId===state.engineerId);
      write(sources[3],collection(selected.filter(o=>o.geometryBefore?.length>1).map(o=>line(o.geometryBefore,{}))));
      write(sources[4],collection(selected.flatMap(o=>o.stepsAfter?.some(s=>s.geometry?.length>1)?o.stepsAfter.filter(s=>s.geometry?.length>1).map(s=>line(s.geometry,{mode:s.mode})):o.geometryAfter?.length>1?[line(o.geometryAfter,{mode:'auto'})]:[])));
      selected.forEach((order,index)=>{
        const p=order.geometryAfter?.at(-1);if(!p)return;
        const element=document.createElement('span');element.className='transport-stop';element.textContent=String(index+1);element.title=order.address;
        markers.push(new maplibregl.Marker({element}).setLngLat([p[1],p[0]]).addTo(map));
      });
      place();
    };
    const click=event=>{
      const state=current.current;
      if(!state.enabled)return;
      const hit=map.queryRenderedFeatures(event.point,{layers:layers.filter(l=>map.getLayer(l.id)).map(l=>l.id)});
      const closure=hit.find(f=>f.layer.id==='beego-transport-closed');
      if(closure&&!state.drawing){state.onSelect?.((state.events || []).find(e=>e.id===closure.properties.id));return;}
      if(!state.drawing)return;
      if(state.kind==='road'){state.onRoad?.([event.lngLat.lat,event.lngLat.lng]);return;}
      const station=hit.find(f=>f.layer.id==='beego-transport-stations');
      if(state.kind==='entry'&&station){state.onSegment?.((state.catalog.stations || []).find(s=>s.id===station.properties.id));return;}
      const link=hit.find(f=>f.layer.id==='beego-transport-links'&&f.properties.kind===state.kind);
      if(link)state.onSegment?.(state.catalog.segments.find(s=>s.id===link.properties.id));
      else if(station)state.onStation?.(station.properties.id);
    };
    const styleLoaded=()=>{backgroundVisibility.clear();dimmed.clear();render();};
    renderRef.current=render;render();map.on('style.load',styleLoaded);map.on('click',click);map.on('move',place);map.on('resize',place);
    const observer=new ResizeObserver(place);observer.observe(outer);const panel=document.querySelector('.transport-workspace-panel,.shift-layer.operational-shift .shift-panel');if(panel)observer.observe(panel);
    return()=>{observer.disconnect();renderRef.current=null;markers.forEach(m=>m.remove());restoreBackground();map.getCanvas().style.cursor='';map.off('style.load',styleLoaded);map.off('idle',render);map.off('click',click);map.off('move',place);map.off('resize',place);};
  },[map]);
  useEffect(()=>{renderRef.current?.();},[state.enabled,state.metro,state.catalog,state.events,state.draft,state.editingId,state.preview?.result,state.date,statuses,state.showEnded,state.engineerId,state.drawing,state.kind,theme]);
  if(!state.enabled)return null;
  return <>
    <div className='transport-map-tools' aria-label='Выбор транспортного участка'>
      <button className={state.drawing&&state.kind==='road'?'active':''} onClick={()=>state.onKind?.('road')}><Car size={18}/>Участок дороги</button>
      <button className={state.drawing&&state.kind!=='road'?'active':''} onClick={()=>state.onKind?.('metro')}><TrainFront size={18}/>Метро</button>
      <button onClick={()=>transportMap.set({metro:!state.metro})} aria-pressed={state.metro} title='Показать станции и схему связей метро'><Layers3 size={18}/></button>
      {state.drawing?<button onClick={state.onUndo} aria-label='Отменить последний участок'><Undo2 size={18}/></button>:<button onClick={state.onNew}><Plus size={18}/>Ограничение</button>}
    </div>
    {state.drawing?<div className='transport-map-hint'>{state.kind==='road'?'Нажмите на проезжую часть — привяжем участок к дорожной сети':state.kind==='entry'?'Выберите станцию на карте или найдите по названию':'Выберите связь метро или две соседние станции'}{state.kind==='road'?<button onClick={()=>{const p=map.getCenter();state.onRoad?.([p.lat,p.lng]);}} aria-label='Выбрать дорогу в центре карты'><Crosshair size={15}/></button>:null}</div>:null}
    <div className='transport-map-legend'><span><i className='closure'/>Закрыто для авто</span><span><b>M</b>Метро · схема связей</span><span><i className='before'/>Было</span><span><i className='after'/>Проверенный путь</span><span><Footprints size={15}/><i className='walking'/>Пешком / пересадка</span></div>
  </>;
}
