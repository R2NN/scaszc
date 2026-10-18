// @ts-check
const round = value => Math.round(value * 100) / 100;
const rectangle = (id, kind, x, z, width, depth, label) => ({ id, kind, label, polygon: [[x, z], [x + width, z], [x + width, z + depth], [x, z + depth]].map(point => point.map(round)) });

/** Build a coherent demonstration floor plan from the section's architectural profile. */
export function syntheticFloorPlans(section) {
  const { width: w, depth: d, floors, interior } = section;
  const spaces = [];
  if (interior.layout === 'open') {
    spaces.push(rectangle('hall', 'hall', w * .04, d * .1, w * .78, d * .82, 'Рабочий зал'));
    spaces.push(rectangle('service', 'technical', w * .84, d * .48, w * .12, d * .44, 'Техническое помещение'));
  } else {
    const count = interior.rooms;
    for (let index = 0; index < count; index++) {
      const corridor = interior.layout === 'corridor', side = index % 2, row = Math.floor(index / 2), perSide = Math.ceil(count / 2);
      spaces.push(corridor ? rectangle(`room-${index + 1}`, 'office', w * (.035 + index * .93 / count), d * .61, w * .88 / count, d * .34, `Помещение ${index + 1}`) : rectangle(`room-${index + 1}`, 'apartment', w * (side ? .71 : .035), d * (.035 + row * .92 / perSide), w * .255, d * .86 / perSide, `Квартира ${index + 1}`));
    }
    spaces.push(interior.layout === 'corridor' ? rectangle('corridor', 'corridor', w * .035, d * .37, w * .93, d * .2, 'Общий коридор') : rectangle('corridor', 'corridor', w * .32, d * .035, w * .36, d * .92, 'Лестнично-лифтовой узел'));
    spaces.push(rectangle('stairs', 'stairs', w * interior.stairsX, d * .08, Math.min(w * .24, 4.4), d * .25, 'Лестница'));
    for (let index = 0; index < interior.elevators; index++) spaces.push(rectangle(`lift-${index + 1}`, 'lift', w * (.51 + index * .085), d * .12, w * .075, d * .2, `Лифт ${index + 1}`));
  }
  const overrides = [];
  if (section.basement) overrides.push({ floor: -1, spaces: [rectangle('technical', 'technical', w * .04, d * .42, w * .56, d * .51, 'Техническое помещение'), rectangle('storage', 'storage', w * .66, d * .48, w * .3, d * .45, 'Хозяйственное помещение')], walls: [] });
  if (['corridor', 'central'].includes(interior.layout) && floors > 3) overrides.push({ floor: 1, spaces: [rectangle('lobby', 'lobby', w * .04, d * .07, w * .5, d * .85, 'Входной вестибюль'), rectangle('service', 'technical', w * .59, d * .49, w * .35, d * .44, 'Узел связи'), ...spaces.filter(space => space.kind === 'lift')], walls: [] });
  return { typical: { spaces, walls: [] }, overrides, source: 'model' };
}

/** Validate explicit per-floor rooms and wall traces; survey imports use exactly the same renderer. */
export function validateFloorPlans(input, section) {
  if (!input) return syntheticFloorPlans(section);
  const number = (value, min, max) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('Координаты помещений должны находиться внутри секции.'); return value; };
  const point = value => { if (!Array.isArray(value) || value.length !== 2) throw new Error('Некорректная точка плана этажа.'); return [number(value[0], 0, section.width), number(value[1], 0, section.depth)]; };
  const plan = value => {
    if (!value || !Array.isArray(value.spaces) || value.spaces.length > 100 || (value.walls && (!Array.isArray(value.walls) || value.walls.length > 200))) throw new Error('Некорректный план этажа.');
    const ids = new Set();
    return { spaces: value.spaces.map(space => {
      if (!space || typeof space.id !== 'string' || !space.id || ids.has(space.id) || !Array.isArray(space.polygon) || space.polygon.length < 3 || space.polygon.length > 64) throw new Error('У помещений должны быть уникальные ID и контуры.');
      ids.add(space.id);
      return { id: space.id.slice(0, 120), label: String(space.label || '').slice(0, 120), kind: ['apartment', 'office', 'technical', 'storage', 'corridor', 'stairs', 'lift', 'hall', 'lobby'].includes(space.kind) ? space.kind : 'office', polygon: space.polygon.map(point) };
    }), walls: (value.walls || []).map(wall => { if (!Array.isArray(wall) || wall.length < 2 || wall.length > 64) throw new Error('Стена должна содержать минимум две точки.'); return wall.map(point); }) };
  };
  if (!Array.isArray(input.overrides || []) || input.overrides?.length > 181) throw new Error('Некорректные индивидуальные планы этажей.');
  const floors = new Set();
  return { typical: plan(input.typical), overrides: (input.overrides || []).map(override => {
    const floor = override.floor;
    if (!Number.isInteger(floor) || floor === 0 || floor < (section.basement ? -1 : 1) || floor > section.floors || floors.has(floor)) throw new Error('Некорректный или повторяющийся этаж плана.');
    floors.add(floor); return { floor, ...plan(override) };
  }), source: String(input.source || 'import').slice(0, 100) };
}

/** Resolve a floor without interpolating or replacing supplied room geometry. */
export function floorPlanAt(section, floor) {
  return section.floorPlans.overrides.find(item => item.floor === floor) || section.floorPlans.typical;
}
