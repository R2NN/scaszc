import { minuteOf, splitGeometry } from './shiftDomain.js';

/** Stable event/revision signature shared by preview and atomic publication. */
export function transportContextSignature(events = []) {
  return JSON.stringify(events.map(e=>[e.id,e.revision,e.kind,e.direction,e.startsAt,e.endsAt,e.status,e.segments.map(s=>s.id)]).sort((a,b)=>a[0].localeCompare(b[0])));
}

/** Moscow event intervals are [start,end); an unknown end is never invented. */
export function transportStatus(event, date, minute) {
  if (event.status === 'CANCELLED') return 'Отменено';
  if (event.status === 'ENDED') return 'Завершено';
  const at = Date.parse(`${date}T${String(Math.floor(minute / 60)).padStart(2,'0')}:${String(Math.floor(minute % 60)).padStart(2,'0')}:00+03:00`);
  return at < Date.parse(event.startsAt) ? 'Запланировано' : event.endsAt && at >= Date.parse(event.endsAt) ? 'Завершено' : 'Действует';
}

const nearPath=(point,path)=>path.some((target,index)=>{
  const source=path[Math.max(0,index-1)],scale=Math.cos(point[0]*Math.PI/180);
  const dx=(target[1]-source[1])*scale,dy=target[0]-source[0];
  const t=Math.max(0,Math.min(1,((point[1]-source[1])*scale*dx+(point[0]-source[0])*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot((point[1]-source[1])*scale-t*dx,point[0]-source[0]-t*dy)<.0045;
});

/** Frame only restrictions relevant to this engineer's transport and selected route. */
export function transportFocusSegments({orders=[],events=[],draft,selected,date,minute,transport}) {
  const routes=orders.filter(order=>!order.lost&&order.geometryAfter?.length);
  const paths=routes.flatMap(order=>[order.geometryBefore||[],order.geometryAfter]);
  const compatible=event=>!transport||(transport==='CAR'?event.kind==='road':event.kind!=='road');
  const relevant=event=>compatible(event)&&(!paths.length||event.segments.some(segment=>segment.geometry?.some(point=>paths.some(path=>nearPath(point,path)))));
  const current=events.filter(event=>transportStatus(event,date,minute)==='Действует'&&relevant(event));
  const closures=draft?.segments?.length&&relevant(draft)?draft.segments:selected&&transportStatus(selected,date,minute)==='Действует'&&relevant(selected)?selected.segments:current.flatMap(event=>event.segments);
  return [...routes.map(order=>({geometry:order.geometryAfter})),...closures];
}

const remaining = (visit, at) => {
  const departure = minuteOf(visit.departureAt) ?? at, arrival = minuteOf(visit.arrival) ?? departure;
  const ratio = arrival <= at ? 0 : departure >= at ? 1 : (arrival-at)/Math.max(1,arrival-departure);
  if(visit.travelSteps?.length){
    let elapsed=0,seconds=0,waiting=0,distance=0;
    const passed=Math.max(0,(at-departure)*60);
    for(const step of visit.travelSteps){
      const duration=Number(step.seconds)||0,left=Math.max(0,elapsed+duration-Math.max(elapsed,passed));
      if(['waiting','metro_wait_model'].includes(step.mode))waiting+=left;else seconds+=left;
      distance+=Number(step.distanceM || 0)*(duration?left/duration:0);elapsed+=duration;
    }
    return {minutes:seconds/60,waiting:waiting/60,distance:visit.travelSteps.every(s=>s.distanceM!=null)?distance:Number(visit.distanceM || 0)*ratio};
  }
  return {minutes:Math.max(0,Number(visit.travelMinutes || 0)*ratio),waiting:0,distance:Number(visit.distanceM || 0)*ratio};
};
const remainingSteps=(steps,passed)=>{
  let elapsed=0;const result=[];
  for(const step of steps){const duration=Number(step.seconds)||0,offset=Math.max(0,passed-elapsed);elapsed+=duration;if(offset>=duration)continue;
    const points=step.geometry || [];
    result.push({...step,seconds:duration-offset,geometry:points.length>1&&offset>0?splitGeometry(points,offset/duration)[1]:points});
  }
  return result;
};
const remainingGeometry=(visit,at)=>{
  const points=visit.geometry || [];
  const start=minuteOf(visit.departureAt) ?? at,end=minuteOf(visit.arrival) ?? start;
  if(visit.travelSteps?.some(s=>s.geometry?.length))return remainingSteps(visit.travelSteps,Math.max(0,at-start)*60).flatMap(s=>s.geometry);
  return points.length>1&&start<at&&end>at?splitGeometry(points,(at-start)/Math.max(1,end-start))[1]:points;
};

/** Compare only the remaining day from the same clock and unchanged fact set. */
export function transportConsequences(shift, plan, time) {
  const at=minuteOf(time) ?? 0;
  const remainingWait=movement=>(movement?.escape_waits || []).reduce((sum,w)=>sum+Math.max(0,(Date.parse(w.end)-Math.max(Date.parse(w.start),Date.parse(`${shift.date || w.start.slice(0,10)}T${time}:00+03:00`)))/60000),0);
  const orders=new Map(shift.orders.map(o=>[String(o.id),o]));
  const protectedIds=new Set((shift.facts || []).filter(f=>['started','completed'].includes(f.status)).map(f=>String(f.orderId)));
  const before=new Map(shift.plan.routes.flatMap(r=>r.assignments.map(v=>[String(v.orderId),{...v,engineerId:r.engineerId}])));
  const after=new Map(plan.routes.flatMap(r=>r.assignments.map(v=>[String(v.orderId),{...v,engineerId:r.engineerId}])));
  const affected=[], engineers=[];
  for(const [id,old] of before) {
    if(protectedIds.has(id)||(minuteOf(old.plannedStart) ?? 0)<at) continue;
    const next=after.get(id),order=orders.get(id);
    if(!next){affected.push({orderId:id,address:order?.address,lost:true,before:old.arrival,engineerId:old.engineerId});continue;}
    const delta=(minuteOf(next.arrival) ?? 0)-(minuteOf(old.arrival) ?? 0);
    const changed=next.engineerId!==old.engineerId||delta!==0||JSON.stringify(next.geometry)!==JSON.stringify(old.geometry);
    if(!changed) continue;
    const end=minuteOf(order?.end),start=minuteOf(next.plannedStart),arrival=minuteOf(next.arrival);
    const movement=plan.routes.find(r=>r.engineerId===next.engineerId)?.movements?.find(m=>String(m.source_job_id)===String(next.sourceOrderId || id)&&(minuteOf(m.at?.slice(11,16)) ?? 0)>at);
    const sourceSteps=(movement?.source_travel?.itinerary || []).map(s=>({mode:s.mode,geometry:s.geometry,seconds:s.duration_seconds,from:s.attributes?.from_station || s.attributes?.from_stop,to:s.attributes?.to_station || s.attributes?.to_stop}));
    const currentStep=remainingSteps(sourceSteps,Math.max(0,at-(minuteOf(movement?.departure_at?.slice(11,16)) ?? at))*60)[0];
    const continuedSteps=movement?.escape_steps?.flatMap(s=>[...(s.waitSeconds?[{mode:'waiting',geometry:[s.geometry[0]],seconds:s.waitSeconds}]:[]),{mode:s.kind==='transfer'?'walking_transfer':s.kind,geometry:s.geometry,seconds:s.seconds,from:s.fromName,to:s.toName}]) || [];
    const checkedSteps=[...(currentStep&&!['waiting','metro_wait_model','walking'].includes(currentStep.mode)?[currentStep]:[]),...continuedSteps];
    const prefix=checkedSteps.length?checkedSteps.flatMap(s=>s.geometry):movement?remainingGeometry({geometry:movement.geometry,departureAt:movement.departure_at.slice(11,16),arrival:movement.at.slice(11,16)},at):[];
    const waitSeconds=remainingWait(movement)*60;
    const prefixSteps=checkedSteps.length?checkedSteps:prefix.length>1?[{mode:'metro',geometry:prefix,seconds:Math.max(0,((minuteOf(movement.at.slice(11,16)) ?? at)-at)*60-waitSeconds),from:'Текущее положение · модель',to:'Безопасный выход'},...(waitSeconds?[{mode:'waiting',geometry:[prefix.at(-1)],seconds:waitSeconds}]:[])]:[];
    affected.push({orderId:id,address:order?.address,engineerId:next.engineerId,before:old.arrival,after:next.arrival,delta,
      transferred:next.engineerId!==old.engineerId,lateMinutes:end==null?null:Math.max(0,Math.max(start ?? 0,arrival ?? 0)-end),
      geometryBefore:remainingGeometry(old,at),geometryAfter:[...prefix,...remainingGeometry(next,at)],stepsAfter:[...prefixSteps,...(next.travelSteps || [])]});
  }
  const ids=new Set(affected.flatMap(o=>[o.engineerId,before.get(o.orderId)?.engineerId]).filter(Boolean));
  for(const id of ids) {
    const old=shift.plan.routes.find(r=>r.engineerId===id),next=plan.routes.find(r=>r.engineerId===id);
    const totals=route=>{
      const visits=(route?.assignments || []).reduce((sum,v)=>{const r=remaining(v,at);return {minutes:sum.minutes+r.minutes,waiting:sum.waiting+r.waiting,distance:sum.distance+r.distance};},{minutes:0,waiting:0,distance:0});
      for(const movement of route?.movements || []){
        const part=remaining({departureAt:movement.departure_at?.slice(11,16),arrival:movement.at?.slice(11,16),travelMinutes:movement.travel_minutes,distanceM:movement.distance_m},at);
        const waiting=remainingWait(movement);
        part.minutes=Math.max(0,part.minutes-waiting);part.waiting+=waiting;
        visits.minutes+=part.minutes;visits.waiting+=part.waiting;visits.distance+=part.distance;
      }
      return visits;
    };
    const a=totals(old),b=totals(next),engineer=shift.team.find(e=>e.id===id);
    engineers.push({engineerId:id,name:engineer?.name,transport:engineer?.transport,beforeMinutes:Math.round(a.minutes),afterMinutes:Math.round(b.minutes),
      deltaMinutes:Math.round(b.minutes-a.minutes),beforeWaitingMinutes:Math.round(a.waiting),afterWaitingMinutes:Math.round(b.waiting),beforeDistanceM:Math.round(a.distance),afterDistanceM:Math.round(b.distance),
      overtimeMinutes:Math.max(0,(minuteOf(next?.assignments.at(-1)?.plannedFinish) ?? 0)-(minuteOf(engineer?.shiftEnd) ?? 1440))});
  }
  return {orders:affected,engineers,addedTravelMinutes:engineers.reduce((s,e)=>s+e.deltaMinutes,0),
    lost:affected.filter(o=>o.lost).length,late:affected.filter(o=>o.lateMinutes>0).length,unknownWindows:affected.filter(o=>!o.lost&&o.lateMinutes==null).length,
    transferred:affected.filter(o=>o.transferred).length,overtime:engineers.filter(e=>e.overtimeMinutes>0).length,
    unchanged:shift.orders.length-affected.length,time};
}
