/** Reconcile one session with the whole pending queue, preserving the current pause state. */
export function reconcileDispatchPlayback(session, pending, now) {
  const previous = session.clock;
  if (pending && session.preIncidentSpeed == null) session.preIncidentSpeed = session.preTransportSpeed ?? previous.speed;
  const transport=session.preTransportSpeed!=null;
  const speed = previous.reviewSpeed ?? (pending || transport ? 1 : session.preIncidentSpeed ?? previous.speed);
  const reviewSpeed=pending||transport?previous.reviewSpeed??null:null;
  if (!pending) session.preIncidentSpeed = null;
  const changed = previous.speed !== speed || (previous.reviewSpeed??null)!==reviewSpeed || Boolean(previous.awaitingDecision) !== pending || Boolean(previous.awaitingTransport)!==transport;
  if (changed) {
    const minute = Math.min(1439,previous.minute + (previous.playing && !previous.confirmingDecision ? Math.max(0,now-previous.anchorAt)/60000*previous.speed : 0));
    session.clock = {...previous,minute,speed,reviewSpeed,awaitingDecision:pending,awaitingTransport:transport,anchorAt:now,version:(previous.version || 0)+1};
  }
  return session;
}

/** Default review to real time while retaining the operator's explicit speed choice. */
export function transportDecisionPlayback(store,shiftId,{finish=false,minute,now=Date.now()}={}) {
  const row=store.db.prepare('SELECT id,payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shiftId);
  if(!row)return null;
  const session=JSON.parse(row.payload),clock=session.clock;
  if(session.restartedAs)throw new Error('Сценарий устарел: показ начат заново');
  const current=Math.min(1439,clock.minute+(clock.playing&&!clock.confirmingDecision?Math.max(0,now-clock.anchorAt)/60000*clock.speed:0));
  const saved=session.preTransportSpeed??session.preIncidentSpeed??clock.speed;
  const reviewSpeed=session.preTransportSpeed!=null||clock.awaitingDecision?clock.reviewSpeed??null:null;
  session.preTransportSpeed=finish?null:saved;
  session.clock={...clock,minute:minute??current,playing:true,speed:reviewSpeed??(finish&&!clock.awaitingDecision?saved:1),reviewSpeed:finish&&!clock.awaitingDecision?null:reviewSpeed,awaitingTransport:!finish,anchorAt:now,version:(clock.version||0)+1};
  store.db.prepare('UPDATE dispatch_sessions SET payload=? WHERE id=?').run(JSON.stringify(session),row.id);
  return session.clock;
}

/** Freeze scenario progression only while an explicitly chosen dispatch is revalidated. */
export function holdDispatchClock(dispatch,shiftId,hold) {
  const row=dispatch.store.db.prepare('SELECT id,payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shiftId);
  if(!row) return;
  const session=JSON.parse(row.payload),clock=session.clock,now=dispatch.now();
  const minute=Math.min(1439,clock.minute+(clock.playing && !clock.confirmingDecision ? Math.max(0,now-clock.anchorAt)/60000*clock.speed : 0));
  session.clock={...clock,minute,confirmingDecision:hold,anchorAt:now,version:(clock.version||0)+1};
  dispatch.store.db.prepare('UPDATE dispatch_sessions SET payload=? WHERE id=?').run(JSON.stringify(session),row.id);
}

/** Manual decisions, automatic decisions and cancellations share the same playback transition. */
export function syncDispatchPlayback(dispatch, shiftId) {
  const row = dispatch.store.db.prepare('SELECT id,payload FROM dispatch_sessions WHERE shift_id=? ORDER BY rowid DESC LIMIT 1').get(shiftId);
  if (!row) return null;
  const session = JSON.parse(row.payload);
  reconcileDispatchPlayback(session,dispatch.hasPending(shiftId),dispatch.now());
  dispatch.store.db.prepare('UPDATE dispatch_sessions SET payload=? WHERE id=?').run(JSON.stringify(session),row.id);
  return session.clock;
}
