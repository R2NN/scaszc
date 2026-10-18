/** Reconcile one session with the whole pending queue, preserving the current pause state. */
export function reconcileDispatchPlayback(session, pending, now) {
  const previous = session.clock;
  if (pending && session.preIncidentSpeed == null) session.preIncidentSpeed = previous.speed;
  const speed = pending ? 1 : session.preIncidentSpeed ?? previous.speed;
  if (!pending) session.preIncidentSpeed = null;
  const changed = previous.speed !== speed || Boolean(previous.awaitingDecision) !== pending;
  if (changed) {
    const minute = Math.min(1439,previous.minute + (previous.playing && !previous.confirmingDecision ? Math.max(0,now-previous.anchorAt)/60000*previous.speed : 0));
    session.clock = {...previous,minute,speed,awaitingDecision:pending,anchorAt:now,version:(previous.version || 0)+1};
  }
  return session;
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
