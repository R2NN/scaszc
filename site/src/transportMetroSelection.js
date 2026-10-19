/** Identify the pending station, selected closures and valid next station targets. */
export function transportMetroSelection(catalog,draft,pendingId) {
  if(!draft||draft.kind==='road')return new Map();
  const roles=new Map();
  if(pendingId)for(const segment of catalog?.segments||[]){
    if(segment.kind!==draft.kind)continue;
    if(segment.fromId===pendingId)roles.set(segment.toId,'available');
    if(segment.toId===pendingId&&segment.bidirectional)roles.set(segment.fromId,'available');
  }
  for(const segment of draft.segments){roles.set(segment.fromId,'selected');if(segment.toId)roles.set(segment.toId,'selected');}
  if(pendingId)roles.set(pendingId,'pending');
  return roles;
}
