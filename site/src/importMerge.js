import { parseImportedDate, resolveImportedDate } from './importDate.js';

const dateKey = value => parseImportedDate(value)?.toLocaleDateString('sv-SE') || '';

/** Return the working day represented by an imported batch. */
export function importTargetDate(items, selectedDate) {
  return items.map(item => dateKey(item.serviceDate)).find(Boolean)
    || resolveImportedDate(items)?.toLocaleDateString('sv-SE')
    || dateKey(selectedDate);
}

/** Compare IDs within one region, entity type and working day. */
export function importIdentity(item, entityType, fallbackDate) {
  return `${entityType}:${item.regionId || ''}:${dateKey(item.serviceDate) || fallbackDate}:${item.sourceId || item.id}`;
}

/** Describe exactly which records a repeat import would add or update. */
export function summarizeImport(payload, existing, selectedDate) {
  const incoming = [
    ...(payload.orders || []).map(item => ({ item, entityType: 'orders' })),
    ...(payload.engineers || []).map(item => ({ item, entityType: 'engineers' })),
  ];
  const selectedDay = dateKey(selectedDate);
  const targetDate = importTargetDate(incoming.map(({ item }) => item), selectedDate);
  const keyOf = ({ item, entityType }, fallbackDate) => importIdentity(item, entityType, fallbackDate);
  const incomingKeys = incoming.map(entry => keyOf(entry, targetDate));
  const existingEntries = [
    ...(existing.orders || []).map(item => ({ item, entityType: 'orders' })),
    ...(existing.engineers || []).map(item => ({ item, entityType: 'engineers' })),
  ];
  const existingKeys = new Set(existingEntries.map(entry => keyOf(entry, selectedDay)));
  const conflictingItems = incoming.filter((entry, index) => existingKeys.has(incomingKeys[index]));
  const importedRegions = new Set(incoming.map(({ item }) => item.regionId).filter(Boolean));
  const importedTypes = new Set(incoming.map(({ entityType }) => entityType));
  return {
    orders: payload.orders?.length || 0,
    engineers: payload.engineers?.length || 0,
    newIds: incoming.length - conflictingItems.length,
    conflicts: conflictingItems.length,
    conflictIds: conflictingItems.map(({ item }) => String(item.sourceId || item.id)),
    replaceRemovals: existingEntries.filter(entry => importedTypes.has(entry.entityType)
      && importedRegions.has(entry.item.regionId)
      && (dateKey(entry.item.serviceDate) || selectedDay) === targetDate).length,
    duplicateIds: incomingKeys.length - new Set(incomingKeys).size,
    differentDate: targetDate !== selectedDay,
    selectedDate: selectedDay,
    targetDate,
  };
}
