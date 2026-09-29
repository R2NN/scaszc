let active = false;

/** Allow one exact calculation at a time in the single API process. */
export async function withPlanningSlot(operation) {
  if (active) {
    const error = new Error('Подождите: другой пользователь уже запустил расчёт. Повторите попытку после его завершения.');
    error.code = 'PLANNING_BUSY';
    throw error;
  }
  active = true;
  try {
    return await operation();
  } finally {
    active = false;
  }
}
