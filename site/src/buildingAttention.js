// @ts-check
/** Resolve recorded service problems by explicit infrastructure links, retaining their full scope. */
export function buildingAttention(model, entities = [], conditions = [], at) {
  const sectionConditions = new Map(), assetConditions = new Map();
  if (!model) return { sectionConditions, assetConditions };
  const add = (map, key, condition) => { if (!map.has(key)) map.set(key, []); if (!map.get(key).some(item => item.id === condition.id)) map.get(key).push(condition); };
  for (const condition of conditions) {
    if (Date.parse(condition.knownAt) > Date.parse(at) || !Number.isFinite(Date.parse(condition.knownAt))) continue;
    if (condition.closedAt && Date.parse(condition.closedAt) <= Date.parse(at)) continue;
    if (condition.validUntil && Date.parse(condition.validUntil) <= Date.parse(at)) continue;
    if (condition.reason === 'simpler' || condition.scope === 'operation') continue;
    if (condition.objectId && condition.objectId !== model.objectId) continue;
    const wholeObject = condition.scope === 'object' && (condition.entityId === model.objectId || condition.objectId === model.objectId);
    const targets = new Set([condition.entityId, ...(condition.affectedEntityIds || [])]);
    const nodeIds = new Set();
    for (const entity of entities) {
      if (targets.has(entity.id) && entity.kind === 'node') nodeIds.add(entity.id);
      if (targets.has(entity.id) && entity.nodeId) nodeIds.add(entity.nodeId);
      if (entity.kind === 'node' && targets.has(entity.entranceId)) nodeIds.add(entity.id);
    }
    for (const placement of model.placements) if (wholeObject || nodeIds.has(placement.entityId)) {
      add(sectionConditions, placement.sectionId, condition);
      add(assetConditions, placement.entityId, condition);
    }
    if (wholeObject) for (const section of model.sections) add(sectionConditions, section.id, condition);
    for (const id of condition.affectedSectionIds || []) if (model.sections.some(section => section.id === id)) add(sectionConditions, id, condition);
  }
  return { sectionConditions, assetConditions };
}
