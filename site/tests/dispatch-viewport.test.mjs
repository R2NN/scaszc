import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchViewport,measureDispatchViewport} from '../src/dispatchViewport.js';

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
