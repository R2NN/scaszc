import { readFile } from 'node:fs/promises';

const [csvPath = 'C:/Users/bio24/Downloads/jobs.csv', resultsPath = '.codex-work/jobs-geocode-results-v3.json'] = process.argv.slice(2);
const normalize = (value) => String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
const districtBoundaryName = (value) => {
  const cleaned = String(value || '').replace(/^GPON\s+/i, '').trim();
  return normalize(cleaned) === 'выхино' ? 'Выхино-Жулебино' : cleaned;
};
const pointInRing = ([x, y], ring) => {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index], [xj, yj] = ring[previous];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const pointInPolygon = (point, polygon) => pointInRing(point, polygon[0]) && !polygon.slice(1).some((ring) => pointInRing(point, ring));
const contains = (geometry, point) => geometry?.type === 'Polygon'
  ? pointInPolygon(point, geometry.coordinates)
  : geometry?.type === 'MultiPolygon' && geometry.coordinates.some((polygon) => pointInPolygon(point, polygon));

const csv = await readFile(csvPath, 'utf8');
const [headerLine, ...lines] = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
const headers = headerLine.split(';');
const rows = lines.map((line) => Object.fromEntries(line.split(';').map((value, index) => [headers[index], value])));
const results = JSON.parse(await readFile(resultsPath, 'utf8'));
const byId = new Map(results.map((result) => [String(result.id), result]));
const catalogs = await Promise.all([
  readFile('public/data/moscow-administrative-areas.geojson', 'utf8'),
  readFile('public/data/moscow-oblast-operational-areas.geojson', 'utf8'),
]).then((values) => values.flatMap((value) => JSON.parse(value).features));

const summary = new Map();
const outside = [];
for (const row of rows) {
  const district = row.district;
  const result = byId.get(String(row.job_id));
  const boundaryName = districtBoundaryName(district);
  const feature = catalogs.find((item) => item.properties?.scope === 'district' && normalize(item.properties?.name) === normalize(boundaryName));
  const point = result?.coords?.length === 2 ? [Number(result.coords[1]), Number(result.coords[0])] : null;
  const current = summary.get(district) || { district, rows: 0, points: 0, boundary: Boolean(feature), inside: 0 };
  current.rows += 1;
  if (point?.every(Number.isFinite)) {
    current.points += 1;
    if (feature && contains(feature.geometry, point)) current.inside += 1;
    else if (feature) outside.push({ id: row.job_id, district, address: row.address, status: result.status, formattedAddress: result.formattedAddress, coords: result.coords });
  }
  summary.set(district, current);
}

const districts = [...summary.values()].sort((a, b) => a.district.localeCompare(b.district, 'ru'));
console.table(districts);
const failures = districts.filter((item) => item.points !== item.rows || !item.boundary || item.inside !== item.points);
console.log(JSON.stringify({ rows: rows.length, points: results.filter((item) => item.coords?.length === 2).length, districts: districts.length, failures: failures.length }, null, 2));
if (failures.length) {
  console.error('Failed map checks:', failures.map((item) => item.district).join(', '));
  console.table(outside);
  process.exitCode = 1;
}
