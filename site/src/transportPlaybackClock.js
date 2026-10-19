import { adoptDispatchClock } from './dispatchClockSync.js';

/** Adopt durable scenario playback or retain the ordinary clock's original acceleration. */
export function transportPlaybackClock(clock,scope,serverClock,{finish=false}={}) {
  if(serverClock){if(!adoptDispatchClock(scope,serverClock))clock.set(serverClock);return;}
  const current=clock.getSnapshot(),saved=current.transportResumeSpeed??current.speed;
  clock.set({playing:true,speed:finish?saved:1,awaitingTransport:!finish,transportResumeSpeed:finish?null:saved});
}
