import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const areas = ['Кашира', 'Ступино', 'Домодедово'];
const features = [];

for (const name of areas) {
  const query = `городской округ ${name} Московская область Россия`;
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ format: 'jsonv2', polygon_geojson: '1', limit: '3', q: query });
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, { headers: { 'user-agent': 'beego-route-planner-local/1.0' }, signal: AbortSignal.timeout(30000) });
      if (response.ok) break;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  if (!response?.ok) throw new Error(`Nominatim ${response?.status || 'unavailable'}: ${name}`);
  const candidates = await response.json();
  const match = candidates.find((item) => item.geojson && item.type === 'administrative');
  if (!match) throw new Error(`Administrative boundary not found: ${name}`);
  features.push({
    type: 'Feature',
    properties: { name, scope: 'district', type: 'administrative', category: 'boundary', source: 'OpenStreetMap / Nominatim', osmType: match.osm_type, osmId: match.osm_id },
    geometry: match.geojson,
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));
}

const output = path.resolve('public/data/moscow-oblast-operational-areas.geojson');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ type: 'FeatureCollection', features })}\n`, 'utf8');
console.log(`Created ${output} with ${features.length} boundaries.`);
