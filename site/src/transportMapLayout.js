/** Group nearby restriction anchors without altering their geographic coordinates. */
export function groupTransportPins(items,project,radius=28) {
  const groups=[];
  for(const item of items){
    const point=project(item.coords);
    let group=groups.find(group=>Math.hypot(group.point.x-point.x,group.point.y-point.y)<radius);
    if(!group){group={coords:item.coords,point,events:[]};groups.push(group);}
    if(!group.events.some(event=>event.id===item.event.id))group.events.push(item.event);
  }
  return groups;
}

/** A caption must leave stop badges, closure pins and the checked route readable. */
export function transportBoxClear(box,obstacles) {
  return !obstacles.some(other=>box.x<other.x+other.w&&box.x+box.w>other.x&&box.y<other.y+other.h&&box.y+box.h>other.y);
}
