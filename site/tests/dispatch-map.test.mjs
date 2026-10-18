import test from 'node:test';
import assert from 'node:assert/strict';
import { attachDispatchMap } from '../src/dispatchMap.js';
import { publishDispatchMapEvent,createIncidentAnnouncer,savedDispatchFocus } from '../src/dispatchMapEvents.js';

const setup = ({preFocus = null,readyInitially = true} = {}) => {
  const sources = new Map(), layers = new Map(), handlers = new Map(), fits = [];
  const events = new EventTarget();
  let ready = readyInitially;
  if (preFocus) publishDispatchMapEvent(events,'incident-focus',{coords:preFocus});
  const map = {
    isStyleLoaded:() => ready,
    getSource:id => sources.get(id),getLayer:id => layers.get(id),
    addSource(id,value) {sources.set(id,{data:value.data,setData(data){this.data=data;}});ready=false;},
    addLayer(value) {layers.set(value.id,structuredClone(value));},
    setPaintProperty(id,key,value) {layers.get(id).paint[key]=value;},
    setFilter(id,value) {layers.get(id).filter=value;},moveLayer(){},
    removeLayer:id => layers.delete(id),removeSource:id => sources.delete(id),
    getContainer:() => ({getBoundingClientRect:() => ({left:0,right:1600,width:1600,top:0,bottom:900,height:900})}),
    fitBounds:(...args) => fits.push(args),
    on:(event,fn) => handlers.set(event,fn),once:(event,fn) => handlers.set(event,fn),
    off(event,fn) {if(handlers.get(event)===fn)handlers.delete(event);},
  };
  const markers=[];
  const markerFactory=element=>{const marker={element,setLngLat(coords){this.coords=coords;return this;},addTo(){return this;},remove(){this.removed=true;}};markers.push(marker);return marker;};
  const cleanup = attachDispatchMap(map,{events,dom:{querySelector:() => null,createElement:()=>({setAttribute(){}})},markerFactory});
  const fire = (type,detail) => events.dispatchEvent(new CustomEvent(`beego:${type}`,{detail}));
  const loaded = event => {ready=true;const fn=handlers.get(event);if(event==='idle')handlers.delete(event);fn?.();};
  const after = {routes:[{engineerId:'E',assignments:[{orderId:'U',departureAt:'11:17',arrival:'11:38',plannedStart:'11:38',geometry:[[55.7,37.6],[55.71,37.61]]}]}]};
  const preview = {before:{routes:[]},after,ids:['E'],scope:'day',focusRoute:false,current:{engineerId:'E',time:'11:17',emergencyOrderId:'U'}};
  return {map,sources,layers,handlers,fits,fire,loaded,preview,cleanup,markers,events};
};

test('a newly received emergency marks and focuses the map before any notification click, once per incident',()=>{
  const f=setup();
  try{
    const opened=[];
    const announce=createIncidentAnnouncer(f.events,incident=>opened.push(incident));
    const incident={id:'I',status:'SEARCHING',order:{coords:[55.71,37.61]}};
    announce([incident]);
    assert.deepEqual(opened,[incident],'The panel opens as soon as the emergency arrives, before candidates are ready');
    assert.deepEqual(f.markers.at(-1).coords,[37.61,55.71]);
    assert.equal(f.markers.at(-1).element.className,'dispatch-map-incident');
    assert.deepEqual(f.fits.at(-1)[0],[[37.61,55.71],[37.61,55.71]]);
    const count=f.fits.length;
    announce([{...incident,status:'WAITING'}]);
    assert.equal(opened.length,1,'Polling must not reopen a panel the operator has closed');
    assert.equal(f.fits.length,count,'Polling must not keep recentering the camera');
    announce([{id:'accepted',status:'ACCEPTED',order:{coords:[55,37]}}]);
    assert.equal(opened.length,1,'Past accepted incidents do not open the panel');
    assert.equal(f.fits.length,count);
    publishDispatchMapEvent(f.events,'clear');
    assert.equal(savedDispatchFocus(f.events),undefined);
    assert.equal(f.markers.at(-1).removed,true);
  }finally{f.cleanup();}
});

test('incident focus received before map readiness is retained and restored after style loading',()=>{
  const f=setup({preFocus:[55.71,37.61],readyInitially:false});
  try{
    assert.equal(f.markers.length,1);
    assert.equal(f.fits.length,0);
    f.loaded('style.load');
    assert.deepEqual(f.fits.at(-1)[0],[[37.61,55.71],[37.61,55.71]]);
    f.loaded('idle');
    assert.deepEqual(f.fits.at(-1)[0],[[37.61,55.71],[37.61,55.71]]);
  }finally{f.cleanup();publishDispatchMapEvent(f.events,'clear');}
});

test('selecting an alternative displays the emergency marker even if its opening notification was missed',()=>{
  const f=setup();
  try{
    f.fire('dispatch-preview',{...f.preview,focusRoute:true,current:{...f.preview.current,emergencyCoords:[55.75,37.65]}});
    assert.deepEqual(f.markers[0].coords,[37.65,55.75]);
    assert.equal(f.markers[0].element.className,'dispatch-map-incident');
  }finally{f.cleanup();}
});

for (const scope of ['day','next']) test(`${scope} scope retains the engineer checkpoint and emergency even when neither is a route endpoint`,()=>{
  const f=setup();
  try{
    f.fire('dispatch-preview',{...f.preview,scope,focusRoute:true,current:{...f.preview.current,origin:[55.6,37.5],emergencyCoords:[55.9,37.9]}});
    assert.deepEqual(f.fits.at(-1)[0],[[37.5,55.6],[37.9,55.9]]);
    assert.equal(f.fits.at(-1)[1].retainPadding,false);
    const count=f.fits.length;
    f.loaded('idle');
    f.fire('dispatch-scope',{scope:scope==='day'?'next':'day'});
    f.loaded('idle');
    assert.ok(f.fits.length>count);
    assert.deepEqual(f.fits.at(-1)[0],[[37.5,55.6],[37.9,55.9]]);
  }finally{f.cleanup();}
});

test('an address request arriving while route sources load survives until idle and retains its focus', () => {
  const f = setup();
  try {
    f.fire('dispatch-preview',f.preview);
    const point = {type:'Feature',properties:{orderId:'lost',address:'Адрес без назначения'},geometry:{type:'Point',coordinates:[37.8,55.8]}};
    f.fire('dispatch-impact',{features:[point]});
    assert.equal(f.sources.get('dispatch-impact').data.features.length,0);
    f.loaded('idle');
    assert.deepEqual(f.sources.get('dispatch-impact').data.features,[point]);
    assert.deepEqual(f.fits[0][0],[[37.8,55.8],[37.8,55.8]]);
    f.loaded('style.load');
    assert.deepEqual(f.sources.get('dispatch-impact').data.features,[point]);
    assert.equal(f.fits.length,1,'Passive restoration must preserve the camera');
  } finally {f.cleanup();}
  assert.equal(f.sources.size,0);
  assert.equal(f.layers.size,0);
});

test('confirmation keeps the selected route without a yellow overlay or unrelated routes', () => {
  const f = setup();
  try {
    const after = structuredClone(f.preview.after);
    after.routes.push({engineerId:'other',assignments:[{orderId:'other-job',departureAt:'12:00',arrival:'12:30',geometry:[[56,38],[57,39]]}]});
    f.fire('dispatch-preview',{...f.preview,after,focusRoute:true,highlightIds:['E','other']});
    assert.equal(f.layers.has('dispatch-result-highlight'),false);
    assert.equal(f.sources.has('dispatch-result-highlight'),false);
    assert.deepEqual(f.sources.get('dispatch-after').data.features.map(feature => feature.properties.orderId),['U']);
    assert.deepEqual(f.fits.at(-1)[0],[[37.6,55.7],[37.61,55.71]]);
    f.loaded('idle');
    f.loaded('style.load');
    assert.equal(f.layers.has('dispatch-result-highlight'),false);
    f.fire('dispatch-clear');
    assert.equal(f.sources.size,0);
    assert.equal(f.layers.size,0);
  } finally {f.cleanup();}
  assert.equal(f.handlers.size,0);
});
