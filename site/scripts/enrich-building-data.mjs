import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// Run explicitly to refresh public building geometry; application requests stay offline.
const input = resolve(process.argv[2] || 'public/test-data/beego-algorithm-initial.json');
const output = resolve(process.argv[3] || 'server/data/building-osm.json');
const fixture = JSON.parse(await readFile(input, 'utf8'));
const rows = fixture.jobs || fixture.orders || fixture.requests;
if (!Array.isArray(rows)) throw new Error('В файле не найден список заявок.');
const ids = [...new Set(rows.map(row => row.geocode_object_id || row.sourceData?.geocode_object_id).filter(value => /^way\/\d+$/.test(value || '')).map(value => value.split('/')[1]))];
if (!ids.length || ids.length > 2000) throw new Error('Ожидается от 1 до 2000 зданий с идентификаторами OSM way.');
const query = `[out:json][timeout:60];way(id:${ids.join(',')});out tags geom;node(w)["entrance"~"^(yes|main|staircase)$"];out body;`;
const endpoint = process.env.BEEGO_OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const response = await fetch(`${endpoint}?${new URLSearchParams({ data: query })}`, { headers: { 'user-agent': 'BeeGo-Building-Inventory/1.0' }, signal: AbortSignal.timeout(80000) });
if (!response.ok) throw new Error(`OpenStreetMap: HTTP ${response.status}. Существующий снимок сохранён.`);
const data = await response.json();
if (data.remark || !Array.isArray(data.elements) || !data.elements.some(item => item.type === 'way')) throw new Error('Получен неполный ответ OpenStreetMap. Существующий снимок сохранён.');
const result = { source: 'OpenStreetMap contributors', license: 'ODbL-1.0', attributionUrl: 'https://www.openstreetmap.org/copyright', fetchedAt: data.osm3s?.timestamp_osm_base || new Date().toISOString(), elements: data.elements };
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result), 'utf8');
process.stdout.write(`Сохранено зданий: ${data.elements.filter(item => item.type === 'way').length}; с этажностью: ${data.elements.filter(item => item.type === 'way' && item.tags?.['building:levels']).length}.\n`);
