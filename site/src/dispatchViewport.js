const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const textContexts = new WeakMap();
const labelClearance = (dom, labels) => {
  if (!textContexts.has(dom)) textContexts.set(dom,dom.createElement?.('canvas')?.getContext?.('2d') || null);
  const context = textContexts.get(dom);
  let horizontal = 0, top = 0;
  for (const {text,size,maxWidth,offset,halo} of labels) {
    if (!text) continue;
    if (context) context.font = `${size}px "Open Sans", "Arial Unicode MS", sans-serif`;
    const measured = context?.measureText(String(text)).width ?? [...String(text)].length * size;
    const width = Math.min(measured,maxWidth*size);
    const lines = Math.max(1,Math.ceil(measured/(maxWidth*size)));
    horizontal = Math.max(horizontal,width/2+halo+12);
    top = Math.max(top,lines*size*1.2+offset*size+halo+12);
  }
  return {horizontal,top};
};

/** Find the largest visible rectangle between the actual panel/control footprints. */
export function dispatchViewport(bounds, obstacles, clearance = {left:36,right:80,top:56,bottom:36}) {
  const clipped = obstacles.filter(box => box && box.width !== 0 && box.height !== 0 && intersects(bounds,box))
    .map(box => ({left:Math.max(bounds.left,box.left),right:Math.min(bounds.right,box.right),top:Math.max(bounds.top,box.top),bottom:Math.min(bounds.bottom,box.bottom)}));
  const xs = [...new Set([bounds.left,bounds.right,...clipped.flatMap(box => [box.left,box.right])])].sort((a,b) => a-b);
  const ys = [...new Set([bounds.top,bounds.bottom,...clipped.flatMap(box => [box.top,box.bottom])])].sort((a,b) => a-b);
  let best = null, area = 0;
  for (let l=0;l<xs.length-1;l++) for (let r=l+1;r<xs.length;r++) for (let t=0;t<ys.length-1;t++) for (let b=t+1;b<ys.length;b++) {
    const rect = {left:xs[l],right:xs[r],top:ys[t],bottom:ys[b]};
    const usable = Math.max(0,rect.right-rect.left-clearance.left-clearance.right) * Math.max(0,rect.bottom-rect.top-clearance.top-clearance.bottom);
    if (usable > area && !clipped.some(box => intersects(rect,box))) {best=rect;area=usable;}
  }
  if (!best) return null;
  return {left:best.left-bounds.left+clearance.left,right:bounds.right-best.right+clearance.right,
    top:best.top-bounds.top+clearance.top,bottom:bounds.bottom-best.bottom+clearance.bottom};
}

/** Measure rendered BeeGo surfaces, retaining room for marker rings and stop labels. */
export function measureDispatchViewport(map, dom, labels = []) {
  const container = map.getContainer(), screen = container.getBoundingClientRect();
  // MapLibre sizes its camera from clientWidth/clientHeight, while DOM rects
  // include the app's CSS zoom. Never use the canvas bitmap size (device DPR).
  const width = container.clientWidth || screen.width, height = container.clientHeight || screen.height;
  if (!(width > 0 && height > 0 && screen.width > 0 && screen.height > 0)) return null;
  const x = width/screen.width, y = height/screen.height;
  const bounds = {left:0,top:0,right:width,bottom:height,width,height};
  const local = box => ({left:(box.left-screen.left)*x,right:(box.right-screen.left)*x,
    top:(box.top-screen.top)*y,bottom:(box.bottom-screen.top)*y,width:box.width*x,height:box.height*y});
  const selectors = ['.sidebar','.shift-panel','.orders-panel','.map-control-stack','.shift-timeline','.minimal-topbar .date-switch','.map-theme-picker','.map-hierarchy-panel'];
  const boxes = selectors.flatMap(selector => [...(dom.querySelectorAll?.(selector) || [dom.querySelector(selector)].filter(Boolean))]
    .filter(element => element.getClientRects?.().length !== 0).map(element => local(element.getBoundingClientRect())));
  const markerBoxes = ['.dispatch-map-incident','.dispatch-map-origin'].flatMap(selector => [...(dom.querySelectorAll?.(selector) || [])].map(element => local(element.getBoundingClientRect())));
  const radius = Math.max(24,...markerBoxes.map(box => Math.max(box.width,box.height)/2+10));
  const text = labelClearance(dom,labels);
  return dispatchViewport(bounds,boxes,{left:Math.max(radius+12,text.horizontal),right:Math.max(80,radius+12,text.horizontal),top:Math.max(56,radius+28,text.top),bottom:radius+12});
}
