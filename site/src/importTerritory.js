const FILE_TERRITORIES = [
  [/^юго[\s_-]*восток(?:[\s_.-]|$)/iu, { id: 'SOUTHEAST', label: 'Юго-Восток' }],
  [/^юго[\s_-]*центр(?:[\s_.-]|$)/iu, { id: 'SOUTHCENTER', label: 'Югоцентр' }],
  [/^восток(?:[\s_.-]|$)/iu, { id: 'EAST', label: 'Восток' }],
];

/** Infer the operational sector only for files whose names state it explicitly. */
export function territoryFromImportFile(fileName) {
  const name = String(fileName || '').trim();
  return FILE_TERRITORIES.find(([pattern]) => pattern.test(name))?.[1] || null;
}
