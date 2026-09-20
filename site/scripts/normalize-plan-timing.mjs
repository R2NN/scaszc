export const DEPARTURE_BUFFER_MINUTES = 15;

const minutes = value => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

const clock = value => `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

/**
 * Delay departures while preserving the exact visit order and planned service starts.
 * Each crew retains a small arrival buffer; if a leg has no spare time it is left unchanged.
 */
export function normalizeRouteDepartures(assignments, shiftStart, bufferMinutes = DEPARTURE_BUFFER_MINUTES) {
  let previousFinish = minutes(shiftStart);
  let delayedDepartures = 0;
  const normalized = (assignments || []).map(assignment => {
    const sourceDeparture = minutes(assignment.departureAt);
    const plannedStart = minutes(assignment.plannedStart);
    const plannedFinish = minutes(assignment.plannedFinish);
    const travelMinutes = Math.max(0, Number(assignment.travelMinutes) || 0);
    if (sourceDeparture == null || plannedStart == null || plannedFinish == null) {
      previousFinish = plannedFinish ?? previousFinish;
      return assignment;
    }
    const earliestDeparture = Math.max(sourceDeparture, previousFinish ?? sourceDeparture);
    const latestSafeDeparture = plannedStart - travelMinutes - Math.max(0, bufferMinutes);
    const departure = Math.max(earliestDeparture, latestSafeDeparture);
    const arrival = departure + travelMinutes;
    // Never introduce a schedule that arrives after its exact planned service start.
    if (arrival > plannedStart) {
      previousFinish = plannedFinish;
      return assignment;
    }
    if (departure > sourceDeparture) delayedDepartures += 1;
    previousFinish = plannedFinish;
    return { ...assignment, departureAt: clock(departure), arrival: clock(arrival) };
  });
  const waitingMinutes = normalized.reduce((sum, assignment) => {
    const arrival = minutes(assignment.arrival);
    const plannedStart = minutes(assignment.plannedStart);
    return sum + (arrival == null || plannedStart == null ? 0 : Math.max(0, plannedStart - arrival));
  }, 0);
  return { assignments: normalized, waitingMinutes, delayedDepartures };
}
