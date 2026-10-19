import { useEffect,useRef } from 'react';
import { shiftClock } from './shiftClock.js';
import { adoptDispatchClock } from './dispatchClockSync.js';
import { createTransportScenarioClock } from './transportScenarioClock.js';
import { createTransportImpactClock } from './transportImpactClock.js';
import { createTransportProblemFocus } from './transportProblemFocus.js';
import { transportMap } from './TransportMap.jsx';
import { transportStatus } from './transportDomain.js';
import { transportPlaybackClock } from './transportPlaybackClock.js';

/** Keep the scenario clock alive while the operator uses Orders or another workspace. */
export function useTransportScenario({shift,visible=false,onApply,onOpen,onError}) {
  const refs=useRef(null);refs.current={shift,visible,onApply,onOpen,onError};
  const problemFocus=useRef(null),latestEvents=useRef(null),focusNow=useRef(null);
  problemFocus.current ||= createTransportProblemFocus(event=>{
    const current=refs.current;current.onOpen?.(event);
    window.dispatchEvent(new CustomEvent('beego:transport-scenario',{detail:{shift:current.shift,event,operational:true,opening:true}}));
  });
  useEffect(()=>{focusNow.current?.();},[visible]);
  useEffect(()=>{
    let frame;
    const focus=()=>{
      const current=refs.current,latest=latestEvents.current;
      if(!current.shift||!latest||latest.shiftId!==current.shift.id)return;
      const problems=problemFocus.current.update({shiftId:current.shift.id,date:current.shift.date,minute:Math.floor(shiftClock.getSnapshot().minute),events:latest.events,visible:current.visible&&!transportMap.snapshot().draft});
      if(!problems.length)return;
      cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
        if(refs.current.shift?.id===latest.shiftId&&refs.current.visible&&!transportMap.snapshot().draft&&transportMap.focusProblem(problems))problemFocus.current.acknowledge(problems);
      });
    };
    focusNow.current=focus;
    const unsubscribeFocus=transportMap.subscribe(focus),focusTimer=setInterval(focus,2000);
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
        if(result.event)refs.current.onApply?.(result.shift);
        window.dispatchEvent(new CustomEvent('beego:transport-scenario',{detail:result}));
      },
      onError:error=>refs.current.onError?.(error),
    });
    const impacts=createTransportImpactClock({clock:shiftClock,getShift:()=>refs.current.shift,request,
      pause:async shift=>{
        let clock;
        if(shift.regionId.includes(':scenario:')){
          const response=await fetch(`/api/dispatch/shifts/${shift.id}/transport`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
          const value=await response.json();if(!response.ok)throw new Error(value.error);
          clock=value.clock;
        }
        if(refs.current.shift?.id===shift.id&&!shiftClock.getSnapshot().restartDay)transportPlaybackClock(shiftClock,shift.id,clock);
      },
      onEvents:events=>{latestEvents.current={shiftId:refs.current.shift.id,events};window.dispatchEvent(new CustomEvent('beego:transport-events',{detail:latestEvents.current}));focus();},
      onPreview:preview=>{
        const current=refs.current,minute=Math.floor(shiftClock.getSnapshot().minute);
        const event=[...(preview.events||[])].filter(event=>transportStatus(event,current.shift.date,minute)==='Действует').sort((a,b)=>String(b.createdAt||b.startsAt).localeCompare(String(a.createdAt||a.startsAt)))[0];
        window.dispatchEvent(new CustomEvent('beego:transport-scenario',{detail:{shift:current.shift,event,preview,waitingForPlanner:false,operational:true}}));
      },
      onWaiting:waitingForPlanner=>window.dispatchEvent(new CustomEvent('beego:transport-scenario',{detail:{shift:refs.current.shift,waitingForPlanner,operational:true}})),
      onError:error=>refs.current.onError?.(error),
    });
    return()=>{cancelAnimationFrame(frame);clearInterval(focusTimer);unsubscribeFocus();focusNow.current=null;controller.close();impacts.close();};
  },[shift?.id,shift?.revision]);
}
