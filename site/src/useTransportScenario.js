import { useEffect,useRef } from 'react';
import { shiftClock } from './shiftClock.js';
import { adoptDispatchClock } from './dispatchClockSync.js';
import { createTransportScenarioClock } from './transportScenarioClock.js';
import { createTransportImpactClock } from './transportImpactClock.js';

/** Keep the scenario clock alive while the operator uses Orders or another workspace. */
export function useTransportScenario({shift,onApply,onOpen,onError}) {
  const refs=useRef(null);refs.current={shift,onApply,onOpen,onError};
  useEffect(()=>{
    const request=async(path,body)=>{
        const response=await fetch(`/api/transport/${path}`,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);
        const value=await response.json();
        if(!response.ok){const error=new Error(value.error||'Не удалось подготовить транспортное событие');error.status=response.status;throw error;}
        return value;
      };
    const controller=createTransportScenarioClock({
      clock:shiftClock,getShift:()=>refs.current.shift,request,manageCalculations:false,
      adopt:(id,value)=>{if(!adoptDispatchClock(id,value))shiftClock.set(value);},
      onEvent:result=>{
        if(result.event){refs.current.onApply?.(result.shift);refs.current.onOpen?.();}
        window.dispatchEvent(new CustomEvent('beego:transport-scenario',{detail:result}));
      },
      onError:error=>refs.current.onError?.(error),
    });
    const impacts=createTransportImpactClock({clock:shiftClock,getShift:()=>refs.current.shift,request,
      pause:async shift=>{
        const current=shiftClock.getSnapshot();
        if(current.playing)shiftClock.set({playing:false});
        if(shift.regionId.includes(':scenario:')){
          const response=await fetch(`/api/dispatch/shifts/${shift.id}/clock`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...shiftClock.getSnapshot(),playing:false})});
          const value=await response.json();if(!response.ok)throw new Error(value.error);
          if(!adoptDispatchClock(shift.id,value.clock))shiftClock.set(value.clock);
        }
      },
      onEvents:events=>window.dispatchEvent(new CustomEvent('beego:transport-events',{detail:{shiftId:refs.current.shift.id,events}})),
      onPreview:preview=>window.dispatchEvent(new CustomEvent('beego:transport-scenario',{detail:{shift:refs.current.shift,preview,waitingForPlanner:false,operational:true}})),
      onWaiting:waitingForPlanner=>window.dispatchEvent(new CustomEvent('beego:transport-scenario',{detail:{shift:refs.current.shift,waitingForPlanner,operational:true}})),
      onError:error=>refs.current.onError?.(error),
    });
    return()=>{controller.close();impacts.close();};
  },[shift?.id,shift?.revision]);
}
