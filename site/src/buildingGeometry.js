// @ts-check
/** Geometry helpers use local metres; interior assumptions are kept out of footprint data. */
export function pointInFootprint([x, z], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, az] = polygon[i], [bx, bz] = polygon[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

const coordinates = values => {
  const groups = [];
  for (const value of values.sort((a, b) => a - b)) {
    const group = groups.at(-1);
    if (!group || value - group[0] > 1.2) groups.push([value]); else group.push(value);
  }
  return groups.map(group => group.reduce((sum, value) => sum + value, 0) / group.length);
};

/** Approximate orthogonal wings with occupied rectangles, retaining courtyards and setbacks. */
export function footprintSections(footprint, requested = 1) {
  if (footprint.length < 3) return [];
  const xs = coordinates(footprint.map(point => point[0])), zs = coordinates(footprint.map(point => point[1]));
  if (xs.length > 90 || zs.length > 90) return [];
  const rectangles = [];
  for (let row = 0; row < zs.length - 1; row++) {
    let start = -1;
    for (let column = 0; column < xs.length; column++) {
      const filled = column < xs.length - 1 && pointInFootprint([(xs[column] + xs[column + 1]) / 2, (zs[row] + zs[row + 1]) / 2], footprint);
      if (filled && start < 0) start = column;
      if (!filled && start >= 0) {
        const x = xs[start], width = xs[column] - x, z = zs[row], depth = zs[row + 1] - z;
        const previous = rectangles.find(item => Math.abs(item.x - x) < .01 && Math.abs(item.width - width) < .01 && Math.abs(item.z + item.depth - z) < .01);
        if (previous) previous.depth += depth; else rectangles.push({ x, z, width, depth });
        start = -1;
      }
    }
  }
  // Small vestibules and facade teeth should not become fictitious independent staircases.
  const useful = rectangles.filter(item => item.width >= 4 && item.depth >= 4 && item.width * item.depth >= 45);
  if (!useful.length || useful.length > 40) return [];
  const counts = useful.map(() => 1);
  const total = Math.min(60, Math.max(requested, useful.length));
  for (let count = useful.length; count < total; count++) {
    let best = -1, length = 0;
    useful.forEach((item, index) => { const next = Math.max(item.width, item.depth) / (counts[index] + 1); if (next >= 8 && next > length) { best = index; length = next; } });
    if (best < 0) break;
    counts[best]++;
  }
  return useful.flatMap((item, index) => Array.from({ length: counts[index] }, (_, offset) => {
    if (item.depth > item.width * 1.35) return { x: item.x + item.width, z: item.z + item.depth * offset / counts[index], width: item.depth / counts[index], depth: item.width, rotation: 90 };
    return { x: item.x + item.width * offset / counts[index], z: item.z, width: item.width / counts[index], depth: item.depth, rotation: 0 };
  })).sort((a, b) => a.z - b.z || a.x - b.x);
}

/** Transform local section coordinates into a building plan, including rotated wings. */
export function sectionPlanPoint(section, localX, localZ) {
  const angle = (section.rotation || 0) * Math.PI / 180;
  return [section.x + localX * Math.cos(angle) - localZ * Math.sin(angle), section.z + localX * Math.sin(angle) + localZ * Math.cos(angle)];
}

/** Polygon used by the plan inset and by tests of geometric coverage. */
export function sectionOutline(section) {
  return (section.outline || [[0, 0], [section.width, 0], [section.width, section.depth], [0, section.depth]]).map(([x, z]) => sectionPlanPoint(section, x, z));
}

/** Quantify approximation quality against the source contour without claiming an exact survey. */
export function footprintAgreement(footprint, sections) {
  if (footprint.length < 3 || !sections.length) return null;
  const outlines = sections.map(sectionOutline), all = [...footprint, ...outlines.flat()];
  const minX = Math.min(...all.map(point => point[0])), maxX = Math.max(...all.map(point => point[0]));
  const minZ = Math.min(...all.map(point => point[1])), maxZ = Math.max(...all.map(point => point[1]));
  let intersection = 0, union = 0;
  for (let x = 0; x < 48; x++) for (let z = 0; z < 48; z++) {
    const point = [minX + (x + .5) / 48 * (maxX - minX), minZ + (z + .5) / 48 * (maxZ - minZ)];
    const actual = pointInFootprint(point, footprint), drawn = outlines.some(outline => pointInFootprint(point, outline));
    if (actual && drawn) intersection++;
    if (actual || drawn) union++;
  }
  return union ? Math.round(intersection / union * 100) : null;
}
