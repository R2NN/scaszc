import test from 'node:test';
import assert from 'node:assert/strict';
import { attachDispatchMap } from '../src/dispatchMap.js';

const setup = () => {
  const sources = new Map(), layers = new Map(), handlers = new Map(), timers = new Map(), fits = [];
  const events = new EventTarget();
  let ready = true, sequence = 0;
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
  const markerFactory=()=>({setLngLat(){return this;},addTo(){return this;},remove(){}});
  const cleanup = attachDispatchMap(map,{events,dom:{querySelector:() => null,createElement:()=>({setAttribute(){}})},markerFactory,schedule:fn => {timers.set(++sequence,fn);return sequence;},cancel:id => timers.delete(id)});
  const fire = (type,detail) => events.dispatchEvent(new CustomEvent(`beego:${type}`,{detail}));
  const loaded = event => {ready=true;const fn=handlers.get(event);if(event==='idle')handlers.delete(event);fn?.();};
  const after = {routes:[{engineerId:'E',assignments:[{orderId:'U',departureAt:'11:17',arrival:'11:38',plannedStart:'11:38',geometry:[[55.7,37.6],[55.71,37.61]]}]}]};
  const preview = {before:{routes:[]},after,ids:['E'],scope:'day',focusRoute:false,current:{engineerId:'E',time:'11:17',emergencyOrderId:'U'}};
  return {map,sources,layers,handlers,timers,fits,fire,loaded,preview,cleanup};
};

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

test('completion highlight expires, is cancelled by another option and is cleared on leaving', () => {
  const f = setup();
  try {
    f.fire('dispatch-preview',{...f.preview,highlightIds:['E']});
    assert.equal(f.layers.has('dispatch-result-highlight'),true);
    assert.equal(f.timers.size,1);
    const [timerId,expire] = [...f.timers][0];
    f.timers.delete(timerId);expire();
    assert.equal(f.sources.has('dispatch-result-highlight'),false);
    assert.equal(f.sources.has('dispatch-after'),true);
    f.loaded('style.load');
    f.fire('dispatch-preview',{...f.preview,highlightIds:['E']});
    f.loaded('idle');
    assert.equal(f.layers.has('dispatch-result-highlight'),true);
    f.fire('dispatch-preview',f.preview);
    assert.equal(f.layers.has('dispatch-result-highlight'),false);
    assert.equal(f.timers.size,0);
    f.loaded('idle');
    f.fire('dispatch-clear');
    assert.equal(f.sources.size,0);
  } finally {f.cleanup();}
  assert.equal(f.handlers.size,0);
  assert.equal(f.timers.size,0);
});
