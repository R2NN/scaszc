/** Use a side panel on wide screens and short landscape phones. */
export function transportUsesSidePanel(width,height) {
  return width>1100||(width>height&&height<=520);
}

/** Conservative screen bounds include every icon and the complete count badge. */
export function transportPinBox(group) {
  const kinds=new Set(group.events.map(event=>event.kind)).size,count=group.events.length;
  const width=Math.max(count>1?40:32,kinds*19+Math.max(0,kinds-1)*3+14);
  const badge=count>1?Math.max(22,String(count).length*8+8):0;
  return {x:group.point.x-width/2-5,y:group.point.y-18-(badge?13:0)-5,w:width+(badge?badge/2:0)+10,h:36+(badge?13:0)+10};
}

/** Merge overlapping badge bounds to a fixed point, retaining real anchor coordinates. */
export function groupTransportPins(items,project,radius=28) {
  const groups=[];
  for(const item of items){
    const point=project(item.coords);
    let group=groups.find(group=>Math.hypot(group.point.x-point.x,group.point.y-point.y)<radius);
    if(!group){group={coords:item.coords,point,events:[]};groups.push(group);}
    if(!group.events.some(event=>event.id===item.event.id))group.events.push(item.event);
  }
  let merged=true;
  while(merged){
    merged=false;
    for(let index=0;index<groups.length&&!merged;index++){
      for(let next=index+1;next<groups.length;next++){
        if(transportBoxClear(transportPinBox(groups[index]),[transportPinBox(groups[next])]))continue;
        for(const event of groups[next].events)if(!groups[index].events.some(item=>item.id===event.id))groups[index].events.push(event);
        groups.splice(next,1);merged=true;break;
      }
    }
  }
  return groups;
}

/** A caption must leave stop badges, closure pins and the checked route readable. */
export function transportBoxClear(box,obstacles) {
  return !obstacles.some(other=>box.x<other.x+other.w&&box.x+box.w>other.x&&box.y<other.y+other.h&&box.y+box.h>other.y);
}

/** Mark boarding, alighting and interchange stations from the checked itinerary. */
export function transportRouteStations(orders,catalog) {
  const stations=new Map();
  const add=(step,end,role)=>{
    const coords=end?step.geometry?.at(-1):step.geometry?.[0],name=end?step.to:step.from;
    if(!coords)return;
    const matches=(catalog?.stations||[]).filter(station=>Math.hypot(station.coords[0]-coords[0],station.coords[1]-coords[1])<.0001);
    const station=matches.find(station=>station.name===name)||matches[0];
    if((role==='transfer'&&!station)||(!station&&!name))return;
    const label=station?.name||name,near=[...stations.values()].find(item=>item.name===label&&Math.hypot(item.coords[0]-coords[0],item.coords[1]-coords[1])<.0015);
    const id=near?.id||station?.id||`${name}:${coords.join(',')}`,previous=stations.get(id);
    if(!previous||role==='transfer')stations.set(id,{id,name:label,coords:previous?.coords||station?.coords||coords,role});
  };
  for(const order of orders){
    const steps=order.stepsAfter||[],metro=steps.filter(step=>step.mode==='metro');
    if(!metro.length)continue;
    add(metro[0],false,'boarding');add(metro.at(-1),true,'alighting');
    for(const step of steps)if(step.mode==='walking_transfer'){add(step,false,'transfer');add(step,true,'transfer');}
    for(let index=1;index<metro.length;index++)if(metro[index].lineId!==metro[index-1].lineId){add(metro[index-1],true,'transfer');add(metro[index],false,'transfer');}
  }
  return [...stations.values()];
}


/** Clip route evidence to the visible corridor before testing caption collisions. */
export function clipTransportSegment(a,b,box) {
  let first=0,last=1;
  const dx=b.x-a.x,dy=b.y-a.y;
  for(const [p,q] of [[-dx,a.x-box.left],[dx,box.right-a.x],[-dy,a.y-box.top],[dy,box.bottom-a.y]]){
    if(p===0){if(q<0)return null;continue;}
    const t=q/p;if(p<0)first=Math.max(first,t);else last=Math.min(last,t);
    if(first>last)return null;
  }
  return [{x:a.x+dx*first,y:a.y+dy*first},{x:a.x+dx*last,y:a.y+dy*last}];
}
