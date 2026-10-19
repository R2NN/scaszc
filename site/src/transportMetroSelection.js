/** Resolve the selected stations along their actual line without inventing street segments. */
export function metroSectionBetween(catalog,kind,fromId,toId) {
  if(!fromId||fromId===toId)return [];
  const stations=new Map((catalog?.stations||[]).map(station=>[station.id,station]));
  const lineId=stations.get(fromId)?.lineId;
  if(kind==='metro'&&lineId!=null&&lineId!==stations.get(toId)?.lineId)return [];
  const graph=new Map();
  const add=(a,b,segment)=>{if(!graph.has(a))graph.set(a,[]);graph.get(a).push({to:b,segment});};
  for(const segment of catalog?.segments||[]){
    if(segment.kind!==kind)continue;
    if(kind==='metro'&&lineId!=null&&(stations.get(segment.fromId)?.lineId!==lineId||stations.get(segment.toId)?.lineId!==lineId))continue;
    add(segment.fromId,segment.toId,segment);if(segment.bidirectional)add(segment.toId,segment.fromId,segment);
  }
  const queue=[{id:fromId,path:[]}],seen=new Set([fromId]);
  for(let index=0;index<queue.length;index++){
    const current=queue[index];
    if(current.path.length>=(kind==='metro'?20:1))continue;
    for(const next of graph.get(current.id)||[]){
      if(seen.has(next.to))continue;
      const path=[...current.path,next.segment];if(next.to===toId)return path;
      seen.add(next.to);queue.push({id:next.to,path});
    }
  }
  return [];
}

/** Identify actual station highlights for the pending or confirmed metro section. */
export function transportMetroSelection(catalog,draft,pendingId) {
  if(!draft||draft.kind==='road')return new Map();
  const roles=new Map();
  if(pendingId)for(const segment of catalog?.segments||[]){
    if(segment.kind!==draft.kind)continue;
    if(segment.fromId===pendingId)roles.set(segment.toId,'available');
    if(segment.toId===pendingId&&segment.bidirectional)roles.set(segment.fromId,'available');
  }
  if(pendingId&&draft.kind==='metro')for(const station of catalog?.stations||[])if(metroSectionBetween(catalog,'metro',pendingId,station.id).length)roles.set(station.id,'available');
  for(const segment of draft.segments){roles.set(segment.fromId,'selected');if(segment.toId)roles.set(segment.toId,'selected');}
  if(pendingId)roles.set(pendingId,'pending');
  return roles;
}
