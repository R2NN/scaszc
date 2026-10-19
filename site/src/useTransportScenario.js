import { useEffect,useRef } from 'react';
import { shiftClock } from './shiftClock.js';
import { adoptDispatchClock } from './dispatchClockSync.js';
import { createTransportScenarioClock } from './transportScenarioClock.js';

/** Keep the scenario clock alive while the operator uses Orders or another workspace. */
export function useTransportScenario({shift,onApply,onOpen,onError}) {
  const refs=useRef(null);refs.current={shift,onApply,onOpen,onError};
  useEffect(()=>{
    const controller=createTransportScenarioClock({
      clock:shiftClock,getShift:()=>refs.current.shift,
      request:async(path,body)=>{
        const response=await fetch(`/api/transport/${path}`,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);
        const value=await response.json();
        if(!response.ok){const error=new Error(value.error||'Не удалось подготовить транспортное событие');error.status=response.status;throw error;}
        return value;
      },
      adopt:(id,value)=>{if(!adoptDispatchClock(id,value))shiftClock.set(value);},
      onEvent:result=>{
        if(!result.preview){refs.current.onApply?.(result.shift);refs.current.onOpen?.();}
        window.dispatchEvent(new CustomEvent('beego:transport-scenario',{detail:result}));
      },
      onError:error=>refs.current.onError?.(error),
    });
    return()=>controller.close();
  },[shift?.id,shift?.revision]);
}
