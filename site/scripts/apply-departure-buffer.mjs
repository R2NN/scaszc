import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEPARTURE_BUFFER_MINUTES, normalizeRouteDepartures } from './normalize-plan-timing.mjs';

const artifactPath = resolve(process.argv[2] || 'public/data/beego-exact-plans.json');
const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
const plans = Object.fromEntries(Object.entries(artifact.plans || {}).map(([key, plan]) => {
  const routes = (plan.routes || []).map(route => {
    const timing = normalizeRouteDepartures(route.assignments, route.shiftStart);
    return { ...route, assignments: timing.assignments, waitingMinutes: timing.waitingMinutes, delayedDepartures: timing.delayedDepartures };
  });
  const waitingMinutes = routes.reduce((sum, route) => sum + route.waitingMinutes, 0);
  return [key, { ...plan, routes, metrics: { ...plan.metrics, waitingMinutes } }];
}));

const output = {
  ...artifact,
  algorithm: String(artifact.algorithm || 'exact-plan').replace(/\+latest-safe-departure$/, '') + '+latest-safe-departure',
  schedulePostprocessing: { kind: 'LATEST_SAFE_DEPARTURE', bufferMinutes: DEPARTURE_BUFFER_MINUTES },
  plans,
};

await writeFile(artifactPath, `${JSON.stringify(output)}\n`, 'utf8');
const summary = Object.fromEntries(Object.entries(plans).map(([key, plan]) => [key, {
  waitingMinutes: plan.metrics.waitingMinutes,
  delayedDepartures: plan.routes.reduce((sum, route) => sum + route.delayedDepartures, 0),
}]));
process.stdout.write(`${JSON.stringify({ artifactPath, bufferMinutes: DEPARTURE_BUFFER_MINUTES, plans: summary }, null, 2)}\n`);
