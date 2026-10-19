import { minuteOf,timeOf } from './shiftDomain.js';

/** Run scheduled transport events independently of every workspace's UI lifecycle. */
export function createTransportScenarioClock({clock,getShift,request,adopt,onEvent,onError}) {
  let active=true,running=null,queued=false,last='';
  const tick=()=>{
    if(!active)return;
    queued=true;
    if(running)return running;
    running=(async()=>{
      while(active&&queued){
        queued=false;
        const shift=getShift(),minute=Math.floor(clock.getSnapshot().minute);
        if(!shift?.regionId?.includes(':scenario:transport-'))continue;
        const key=`${shift.id}:${shift.revision}:${minute}`;
        if(last===key)continue;
        last=key;
        try{
          const state=await request(`scenario?shiftId=${encodeURIComponent(shift.id)}`);
          const wave=state?.waves?.[state.index+1];
          if(!active||getShift()?.id!==shift.id||!wave||minute<minuteOf(wave.time))continue;
          const preview=await request(`previews/latest?shiftId=${encodeURIComponent(shift.id)}`);
          if(!active||getShift()?.id!==shift.id||['RUNNING','READY'].includes(preview?.status))continue;
          const result=await request('scenario/tick',{shiftId:shift.id,minute});
          if(!active||getShift()?.id!==shift.id||!result.event)continue;
          adopt(shift.id,{...result.clock,playing:false});
          // Event creation is durable before starting the independent preview.
          // A busy planner leaves the event available for an explicit retry.
          onEvent(result);
          const next=await request('previews',{shiftId:shift.id,expectedRevision:result.shift.revision,time:timeOf(Math.floor(result.clock.minute)),live:true});
          if(active&&getShift()?.id===shift.id)onEvent({...result,preview:next});
        }catch(error){if(active&&error.status!==429)onError(error);}
      }
    })().finally(()=>{running=null;});
    return running;
  };
  const unsubscribe=clock.subscribe(tick);
  tick();
  return {flush:async()=>{await running;},close(){active=false;queued=false;unsubscribe();}};
}
