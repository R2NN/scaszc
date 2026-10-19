const bridges=new Map(),pendingClocks=new Map();
/** Adopt an explicit server transition without echoing a previous session's local clock. */
export function adoptDispatchClock(scope,value) {
  const bridge=bridges.get(scope);
  if(bridge){bridge(value);return true;}
  pendingClocks.set(scope,value);if(pendingClocks.size>20)pendingClocks.delete(pendingClocks.keys().next().value);
  return false;
}

/** Serialize clock writes and ignore old polls or responses superseded by local controls. */
export function createDispatchClockSync({clock, scope, send, onValue = () => {}, onError = () => {}}) {
  let applying = false, active = true, running = null, queued = false, version = -1, epoch=0;
  const apply = value => {
    if (!active || !value || (value.version ?? 0) < version) return false;
    version = value.version ?? version;
    const current = clock.getSnapshot();
    const patch = {speed:value.speed,awaitingDecision:Boolean(value.awaitingDecision),confirmingDecision:Boolean(value.confirmingDecision)};
    if (!current.playing || !value.playing || value.confirmingDecision) Object.assign(patch,{minute:value.minute,playing:value.playing});
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
          const requestEpoch=epoch;
          const result = await send({...clock.getSnapshot(),...(version>=0?{serverClockVersion:version}:{})});
          if (!active) return;
          if(requestEpoch!==epoch)continue;
          version=Math.max(version,result.clock?.version ?? version);
          if (!queued && apply(result.clock)) onValue(result);
        } catch (error) {if (active) onError(error);}
      }
    })().finally(() => {running = null;});
    return running;
  };
  const adopt=value=>{
    epoch++;queued=false;version=value.version ?? version;
    applying=true;try{clock.set({...value,awaitingDecision:Boolean(value.awaitingDecision),confirmingDecision:Boolean(value.confirmingDecision)});}finally{applying=false;}
  };
  const unsubscribe = clock.subscribe(sync);
  if(scope){bridges.set(scope,adopt);if(pendingClocks.has(scope)){adopt(pendingClocks.get(scope));pendingClocks.delete(scope);}}
  return {apply(value) {return running ? false : apply(value);},flush:async () => {await running;},
    close() {active=false;unsubscribe();if(scope&&bridges.get(scope)===adopt)bridges.delete(scope);}};
}
