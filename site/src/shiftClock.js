import { timeOf } from './shiftDomain.js';

let state = { minute: 8 * 60, playing: false, speed: 60, mode: 'plan', selectedEngineerId: '', follow: false };
const listeners = new Set();
let frame = 0;
let last = 0;
let simulatedMinute = state.minute;
let seekSequence = 0;
const notify = () => listeners.forEach(listener => listener());
const tick = stamp => {
  if (!state.playing) { frame = 0; last = 0; return; }
  if (last && !state.confirmingDecision) {
    simulatedMinute = Math.min(1439, simulatedMinute + (stamp - last) / 60000 * state.speed);
    if (Math.floor(simulatedMinute) !== Math.floor(state.minute) || simulatedMinute === 1439) {
      state = { ...state, minute: simulatedMinute, playing: simulatedMinute < 1439 };
      notify();
    }
  }
  last = stamp;
  frame = state.playing ? requestAnimationFrame(tick) : 0;
};
export const shiftClock = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  getSnapshot() { return state; },
  /** An explicit seek to the start can request a fresh demonstration without reloading. */
  seek(minute, { restartDay = false } = {}) {
    if (state.restartDay) return;
    const restart = restartDay && state.mode === 'plan' && minute === 360 && state.minute > 360;
    shiftClock.set({ minute, playing:false, ...(restart ? { restartDay:`${Date.now()}:${++seekSequence}`, restartFromMinute:state.minute } : {}) });
  },
  set(patch) {
    const wasPlaying = state.playing;
    state = { ...state, ...patch };
    if (Object.hasOwn(patch, 'minute')) simulatedMinute = state.minute;
    notify();
    if (!wasPlaying && state.playing && !frame) frame = requestAnimationFrame(tick);
    if (wasPlaying && !state.playing && frame) { cancelAnimationFrame(frame); frame = 0; last = 0; }
  },
  label() { return timeOf(Math.floor(state.minute)); },
};
