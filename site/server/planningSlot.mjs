let active = false;

/** Reserve the single API process for one exact calculation. */
export function acquirePlanningSlot() {
  if (active) return null;
  active = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active = false;
  };
}

/** Run a calculation while rejecting another simultaneous launch. */
export async function withPlanningSlot(operation) {
  const release = acquirePlanningSlot();
  if (!release) {
    const error = new Error('Подождите: другой пользователь уже запустил расчёт. Повторите попытку после его завершения.');
    error.code = 'PLANNING_BUSY';
    throw error;
  }
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Describe a busy planner consistently for both planning entry points. */
export function planningBusyResponse() {
  return new Response(JSON.stringify({
    error: 'Подождите: другой пользователь уже запустил расчёт. Повторите попытку после его завершения.',
    code: 'PLANNING_BUSY',
  }), {
    status: 429,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' },
  });
}
