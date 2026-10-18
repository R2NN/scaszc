/** Serialize clock writes and ignore old polls or responses superseded by local controls. */
export function createDispatchClockSync({clock, send, onValue = () => {}, onError = () => {}}) {
  let applying = false, active = true, running = null, queued = false, version = -1;
  const apply = value => {
    if (!active || !value || (value.version ?? 0) < version) return false;
    version = value.version ?? version;
    const current = clock.getSnapshot();
    const patch = {speed:value.speed,awaitingDecision:Boolean(value.awaitingDecision)};
    if (!current.playing || !value.playing) Object.assign(patch,{minute:value.minute,playing:value.playing});
    if (Object.entries(patch).every(([key,val]) => current[key] === val)) return true;
    applying = true;
    try {clock.set(patch);} finally {applying = false;}
    return true;
  };
  const sync = () => {
    if (!active || applying) return;
    queued = true;
    if (running) return running;
    running = (async () => {
      while (queued && active) {
        queued = false;
        try {
          const result = await send(clock.getSnapshot());
          if (!active) return;
          if (!queued && apply(result.clock)) onValue(result);
        } catch (error) {if (active) onError(error);}
      }
    })().finally(() => {running = null;});
    return running;
  };
  const unsubscribe = clock.subscribe(sync);
  return {apply(value) {return running ? false : apply(value);},flush:async () => {await running;},
    close() {active=false;unsubscribe();}};
}
