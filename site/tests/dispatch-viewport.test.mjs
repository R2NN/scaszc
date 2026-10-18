import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchViewport,measureDispatchViewport} from '../src/dispatchViewport.js';
import {DISPATCH_STOP_LABEL,DISPATCH_IMPACT_LABEL} from '../src/dispatchLabelStyle.js';

const rect = (left,top,right,bottom) => ({left,top,right,bottom,width:right-left,height:bottom-top});
for (const [width,height] of [[900,800],[1280,720],[1440,900]]) {
  test(`camera fits marker and label extents between actual surfaces at ${width}×${height}`, () => {
    const bounds=rect(0,0,width,height);
    const surfaces=[rect(0,0,84,height),rect(90,8,460,height-8),rect(width-74,180,width-8,height-150),rect(470,height-98,width,height),rect(width/2-70,0,width/2+110,42)];
    const padding=dispatchViewport(bounds,surfaces);
    assert.ok(padding);
    assert.ok(padding.left>=496);
    assert.ok(padding.right>=154);
    assert.ok(padding.bottom>=134);
    assert.ok(width-padding.left-padding.right>0);
    assert.ok(height-padding.top-padding.bottom>0);
    const camera=rect(padding.left,padding.top,width-padding.right,height-padding.bottom);
    for (const obstacle of surfaces) assert.ok(camera.right<=obstacle.left || camera.left>=obstacle.right || camera.bottom<=obstacle.top || camera.top>=obstacle.bottom);
    const elements=surfaces.map(box=>({getBoundingClientRect:()=>box,getClientRects:()=>[box]}));
    const selectors=['.sidebar','.shift-panel','.map-control-stack','.shift-timeline','.minimal-topbar .date-switch'];
    const measured=measureDispatchViewport({getContainer:()=>({getBoundingClientRect:()=>bounds})},{querySelectorAll:selector=>elements.filter((_,index)=>selectors[index]===selector)});
    assert.deepEqual(measured,padding);
  });
}
test('camera does not invent a visible area when a panel covers the entire map',()=>{
  const bounds=rect(100,40,1000,840);
  assert.equal(dispatchViewport(bounds,[bounds]),null);
  const padding=dispatchViewport(bounds,[rect(100,40,450,840),rect(940,40,1000,840)]);
  assert.equal(padding.left,386);
  assert.equal(padding.right,140);
});

for (const [width,height] of [[900,800],[1280,720],[1440,900]]) for (const scale of [0.9,1]) {
  test(`padding and the full stop label clear the panel at ${width}×${height}, scale ${scale}`,()=>{
    const internal=rect(0,0,width/scale,height/scale);
    const screen=rect(27,45,27+width,45+height);
    const panel=rect(27,45,27+420,45+height-8);
    const controls=rect(screen.right-70,150,screen.right-10,screen.bottom-150);
    const timeline=rect(panel.right+8,screen.bottom-90,screen.right,screen.bottom);
    const marker=rect(500,400,500+40*scale,400+40*scale);
    const elements=new Map([['.shift-panel',panel],['.map-control-stack',controls],['.shift-timeline',timeline],['.dispatch-map-incident',marker]]);
    const context={font:'',measureText:()=>({width:118})};
    const dom={querySelectorAll:selector=>elements.has(selector)?[{getBoundingClientRect:()=>elements.get(selector),getClientRects:()=>[1]}]:[],createElement:()=>({getContext:()=>context})};
    const map={getContainer:()=>({clientWidth:internal.width,clientHeight:internal.height,getBoundingClientRect:()=>screen}),getCanvas:()=>({width:internal.width*2,height:internal.height*2})};
    const label={...DISPATCH_STOP_LABEL,text:'Своя заявка · 11:47'};
    const padding=measureDispatchViewport(map,dom,[label]);
    const screenLeft=screen.left+padding.left*scale;
    const screenRight=screen.right-padding.right*scale;
    const textHalf=118/2*scale;
    assert.ok(screenLeft-textHalf>=panel.right+(DISPATCH_STOP_LABEL.halo+12)*scale-0.001);
    assert.ok(screenRight+textHalf<controls.left);
    assert.ok(screen.bottom-padding.bottom*scale<timeline.top);
    assert.ok(internal.width-padding.left-padding.right>0);
    assert.match(context.font,/13px/);
    const noLabels=measureDispatchViewport(map,dom);
    assert.ok(padding.left>noLabels.left,'Left padding includes the centered label half-width, not only the marker radius');
    if(scale===0.9) assert.ok(padding.left>420,'DOM pixels are converted to the larger internal viewport');
  });
}

test('long wrapped labels reserve height and both sides in internal pixels without scaling font size twice',()=>{
  const container={clientWidth:1000,clientHeight:800,getBoundingClientRect:()=>rect(0,0,900,720)};
  const context={font:'',measureText:()=>({width:400})};
  const dom={querySelectorAll:()=>[],createElement:()=>({getContext:()=>context})};
  const padding=measureDispatchViewport({getContainer:()=>container},dom,[{...DISPATCH_IMPACT_LABEL,text:'Длинный адрес'}]);
  assert.equal(padding.left,140);
  assert.equal(padding.right,140);
  assert.ok(padding.top>=2*14*1.2+21+14);
  assert.equal(context.font,'14px "Open Sans", "Arial Unicode MS", sans-serif');
});
