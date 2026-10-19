import { minuteOf,timeOf } from './shiftDomain.js';

/** Schedule map events independently of decisions, retrying a busy planner while paused. */
export function createTransportScenarioClock({clock,getShift,request,adopt,onEvent,onError,retryMs=2000,manageCalculations=true}) {
  let active=true,running=null,queued=false,handled='',waiting='',lastError='';
  const tick=()=>{
    if(!active)return;
    queued=true;
    if(running)return running;
    running=(async()=>{
      while(active&&queued){
        queued=false;
        const shift=getShift(),minute=Math.floor(clock.getSnapshot().minute);
        if(!shift?.regionId?.includes(':scenario:')||clock.getSnapshot().restartDay)continue;
        const owns=()=>active&&getShift()?.id===shift.id&&!clock.getSnapshot().restartDay;
        try{
          let state=await request(`scenario?shiftId=${encodeURIComponent(shift.id)}`);
          if(!owns()||!state)continue;
          const wave=state.waves?.[state.index+1];
          if(wave&&minute>=minuteOf(wave.time)){
            const result=await request('scenario/tick',{shiftId:shift.id,minute});
            if(!owns())continue;
            state=result.state;
            if(result.event){
              adopt(shift.id,{...result.clock,playing:false});
              onEvent(result);handled='';
            }
          }
          if(!manageCalculations)continue;
          const current=state?.waves?.[state.index];
          if(!current?.eventId||current.status==='APPLIED')continue;
          const target=`${shift.id}:${shift.revision}:${current.eventId}`;
          if(handled===target)continue;
          const preview=await request(`previews/latest?shiftId=${encodeURIComponent(shift.id)}`);
          if(!owns())continue;
          const ids=state.waves.slice(0,state.index+1).map(w=>w.eventId).filter(Boolean);
          const covers=preview?.events&&ids.every(id=>preview.events.some(event=>event.id===id));
          if(covers){
            // Current failures/cancellations wait for an explicit operator retry.
            if(waiting===target)onEvent({shift:getShift(),state,preview,waitingForPlanner:false});
            handled=target;waiting='';continue;
          }
          if(preview?.status==='RUNNING')await request(`previews/${preview.id}/cancel`,{});
          if(!owns())continue;
          try{
            const next=await request('previews',{shiftId:shift.id,expectedRevision:getShift().revision,time:timeOf(Math.floor(clock.getSnapshot().minute)),live:true});
            if(!owns())continue;
            handled=target;waiting='';lastError='';
            onEvent({shift:getShift(),state,preview:next,waitingForPlanner:false});
          }catch(error){
            if(!owns())continue;
            if(error.status!==429){handled=target;throw error;}
            if(waiting!==target){waiting=target;onEvent({shift:getShift(),state,waitingForPlanner:true});}
          }
        }catch(error){if(owns()&&error.status!==429&&lastError!==error.message){lastError=error.message;onError(error);}}
      }
    })().finally(()=>{running=null;});
    return running;
  };
  const unsubscribe=clock.subscribe(tick),timer=setInterval(tick,retryMs);
  timer.unref?.();
  tick();
  return {flush:async()=>{await running;},close(){active=false;queued=false;clearInterval(timer);unsubscribe();}};
}
