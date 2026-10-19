import { minuteOf,timeOf } from './shiftDomain.js';
import { transportContextSignature,transportStatus } from './transportDomain.js';

/** Match the entire restriction context and publication, never just one event ID. */
export function transportPreviewMatches(preview,shift,events) {
  return Boolean(preview&&transportContextSignature(preview.events||[])===transportContextSignature(events)
    && (preview.status==='APPLIED'?preview.appliedRevision===shift.revision:preview.baseRevision===shift.revision));
}

/** Reuse a current search, but an explicit recalculation never reuses a finished answer. */
export function transportPreviewReusable(preview,shift,events,time,{force=false,selection=false}={}) {
  if(!transportPreviewMatches(preview,shift,events))return false;
  if(preview.status==='RUNNING')return preview.time===time;
  if(force)return false;
  return Boolean(preview.result?.eventImpacts&&((preview.status==='READY'&&preview.time===time)||(selection&&preview.status==='APPLIED')));
}

/** Keep every new saved restriction ready for exact review, including non-demo events. */
export function createTransportImpactClock({clock,getShift,request,pause,onEvents,onPreview,onWaiting,onError,retryMs=2000}) {
  let active=true,running=null,queued=false,handled='',seen='',waiting='',failed='',paused='',lastError='';
  const tick=()=>{
    if(!active)return;
    queued=true;
    if(running)return running;
    running=(async()=>{
      while(active&&queued){
        queued=false;
        const shift=getShift();if(!shift?.plan||!shift.date||clock.getSnapshot().restartDay)continue;
        const owns=()=>active&&getShift()?.id===shift.id&&!clock.getSnapshot().restartDay;
        try{
          const {events}=await request(`events?shiftId=${encodeURIComponent(shift.id)}`);
          if(!owns())continue;
          const signature=transportContextSignature(events),minute=Math.floor(clock.getSnapshot().minute);
          const scope=`${shift.id}:${signature}`,appearance=`${scope}:${events.map(e=>transportStatus(e,shift.date,minute)).join('|')}`;
          if(seen!==appearance){seen=appearance;onEvents(events);}
          const key=`${appearance}:${shift.revision}`;
          if(!events.length||handled===key||failed===key)continue;
          const previous=await request(`previews/latest?shiftId=${encodeURIComponent(shift.id)}`);
          if(!owns())continue;
          const previousMinute=minuteOf(previous?.time),sameAppearance=previousMinute==null||events.every(event=>transportStatus(event,shift.date,minute)===transportStatus(event,shift.date,previousMinute));
          if(transportPreviewMatches(previous,shift,events)&&sameAppearance&&
            (['RUNNING','FAILED','CANCELLED'].includes(previous.status)||previous.result?.eventImpacts)){
            handled=key;
            if(waiting===key){waiting='';onWaiting(false);onPreview(previous);}
            continue;
          }
          if(previous?.hasDraft&&previous.status==='RUNNING'){
            if(waiting!==key){waiting=key;onWaiting(true);}
            continue;
          }
          if(previous?.status==='RUNNING')await request(`previews/${previous.id}/cancel`,{});
          if(!owns())continue;
          if(paused!==key||clock.getSnapshot().playing){await pause(shift);paused=key;}
          if(!owns())continue;
          try{
            const preview=await request('previews',{shiftId:shift.id,expectedRevision:getShift().revision,time:timeOf(Math.floor(clock.getSnapshot().minute)),live:true});
            if(!owns())continue;
            handled=key;waiting='';lastError='';onWaiting(false);onPreview(preview);
          }catch(error){
            if(!owns())continue;
            if(error.status!==429){failed=key;throw error;}
            if(waiting!==key){waiting=key;onWaiting(true);}
          }
        }catch(error){if(owns()&&error.status!==429&&lastError!==error.message){lastError=error.message;onError(error);}}
      }
    })().finally(()=>{running=null;});
    return running;
  };
  const unsubscribe=clock.subscribe(tick),timer=setInterval(tick,retryMs);timer.unref?.();tick();
  return {flush:async()=>{await running;},close(){active=false;queued=false;unsubscribe();clearInterval(timer);}};
}
