/** Crew badges stay centered on their geographic position at every zoom level.
 * Co-located crews can be selected individually through the brigade list.
 */
export function layoutShiftCrewMarkers(crews) {
  return new Map(crews.map(crew => [crew.id, [0, 0]]));
}
