import { transportStatus } from './transportDomain.js';

const keyOf=event=>`${event.id}:${event.revision||0}`;

/** Queue each newly active problem once; preserve it until the visible map accepts focus. */
export function createTransportProblemFocus(onProblem=()=>{}) {
  let scope='',seen=new Set(),pending=new Map();
  return {
    update({shiftId,date,minute,events,visible}) {
      if(scope!==shiftId){scope=shiftId;seen=new Set();pending=new Map();}
      const active=events.filter(event=>transportStatus(event,date,minute)==='Действует');
      const keys=new Set(active.map(keyOf));
      for(const key of pending.keys())if(!keys.has(key))pending.delete(key);
      for(const event of active){const key=keyOf(event);if(!seen.has(key)){seen.add(key);pending.set(key,event);onProblem(event);}}
      return visible?[...pending.values()]:[];
    },
    acknowledge(events) {for(const event of events)pending.delete(keyOf(event));},
  };
}
