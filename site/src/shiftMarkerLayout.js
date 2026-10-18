/** Keep real coordinates unchanged while separating crew badges from starts and each other. */
export function layoutShiftCrewMarkers(crews, starts, project) {
  const occupied = starts.map(coords => ({ ...project(coords), radius: 27 }));
  const offsets = new Map();
  const fits = point => occupied.every(other => Math.abs(point.x - other.x) >= 14 + other.radius + 7 || Math.abs(point.y - other.y) >= 14 + other.radius + 7);
  for (const crew of [...crews].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const origin = project(crew.coords);
    let offset = [0, 0];
    if (!fits(origin)) {
      search: for (let radius = 50; radius <= 290; radius += 30) {
        for (let step = 0; step < 16; step++) {
          const angle = -Math.PI / 2 + step * Math.PI / 8;
          const candidate = [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)];
          if (fits({ x: origin.x + candidate[0], y: origin.y + candidate[1] })) { offset = candidate; break search; }
        }
      }
    }
    offsets.set(crew.id, offset);
    occupied.push({ x: origin.x + offset[0], y: origin.y + offset[1], radius: 14 });
  }
  return offsets;
}
