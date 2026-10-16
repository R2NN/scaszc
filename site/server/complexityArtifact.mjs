import { readFile } from 'node:fs/promises';
import { digest } from './durationModel.mjs';

let artifactPromise;
/** Read the retained, independently validated candidate, if packaged. */
export async function loadComplexityArtifact() {
  artifactPromise ||= (async () => {
    try { return JSON.parse(await readFile(new URL('../public/data/beego-complexity-plan.json', import.meta.url), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  })();
  return artifactPromise;
}
const orderKey = order => ({ id: order.id, sourceId: order.sourceId, start: order.start, end: order.end, duration: order.duration, snapshot: order.durationSnapshot?.id, coords: order.coords, priority: order.priority, skill: order.skill, workType: order.workType, serviceType: order.serviceType, zone: order.zone, zoneId: order.zoneId, equipment: order.equipment, transport: order.transport, sourceData: order.sourceData, status: order.status });
const engineerKey = engineer => { const { serviceDate, rosterPeriods, rosterArchived, ...rest } = engineer; return rest; };
const ordered = values => [...values].sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** Reuse a sealed schedule only when every duration, order and resource input matches. */
export function matchesComplexityArtifact(input, artifact) {
  return Boolean(artifact && input.planningDate === artifact.planningDate
    && digest(ordered(input.orders.map(orderKey))) === digest(ordered(artifact.orders.map(orderKey)))
    && digest(ordered(input.engineers.map(engineerKey))) === digest(ordered(artifact.engineers.map(engineerKey)))
    && !input.sharedInventory?.length);
}
