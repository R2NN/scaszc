import { readFileSync } from 'node:fs';
import { generateBuildingModel, validateBuildingModel } from '../src/buildingModel.js';

const catalog = JSON.parse(readFileSync(new URL('./data/building-osm.json', import.meta.url), 'utf8'));
const buildings = new Map(catalog.elements.filter(item => item.type === 'way').map(item => [`way/${item.id}`, item]));
const entrances = catalog.elements.filter(item => item.type === 'node');
const ready = new WeakSet();
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const decode = row => row ? JSON.parse(row.payload_json) : null;

function setup(registry) {
  if (ready.has(registry)) return;
  registry.db.exec(`CREATE TABLE IF NOT EXISTS building_models(object_id TEXT PRIMARY KEY REFERENCES service_objects(id), revision INTEGER NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS building_model_history(object_id TEXT NOT NULL, revision INTEGER NOT NULL, changed_at TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(object_id,revision));`);
  ready.add(registry);
}

/** Return generated metadata for existing and newly imported buildings without altering the registry. */
export function readBuilding(registry, objectId) {
  setup(registry);
  const object = registry.object(objectId);
  if (!object) throw new Error('Объект не найден.');
  const row = registry.db.prepare('SELECT * FROM building_models WHERE object_id=?').get(objectId);
  const osmId = object.sourceId || object.examples?.[0]?.sourceData?.geocode_object_id;
  const osm = buildings.get(osmId);
  const model = row ? decode(row) : generateBuildingModel(object, registry.entities(objectId), osm ? { ...osm, fetchedAt: catalog.fetchedAt } : null, entrances);
  return { model, revision: row?.revision || 0, attribution: { label: '© OpenStreetMap contributors', url: catalog.attributionUrl, fetchedAt: catalog.fetchedAt }, history: registry.db.prepare('SELECT revision,changed_at AS changedAt,actor,reason FROM building_model_history WHERE object_id=? ORDER BY revision DESC LIMIT 20').all(objectId) };
}

/** Store explicit geometry corrections with optimistic concurrency and a recoverable version history. */
export function saveBuilding(registry, objectId, input) {
  setup(registry);
  return registry.db.transaction(() => {
    const current = readBuilding(registry, objectId);
    if (input.expectedRevision !== current.revision) throw new Error('Схема уже изменилась. Обновите данные перед сохранением.');
    const reason = String(input.reason || '').trim();
    if (reason.length < 4 || reason.length > 1500) throw new Error('Укажите основание изменения схемы (от 4 до 1500 символов).');
    const model = validateBuildingModel(input.model, objectId, registry.entities(objectId));
    const revision = current.revision + 1;
    const at = new Date().toISOString(), actor = String(input.actor || 'Диспетчер').slice(0, 120);
    const payload = JSON.stringify(model);
    if (revision === 1) registry.db.prepare('INSERT OR IGNORE INTO building_model_history VALUES (?,?,?,?,?,?)').run(objectId, 0, at, 'Генератор схем', 'Исходная схема до первого уточнения', JSON.stringify(current.model));
    registry.db.prepare('INSERT INTO building_models VALUES (?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,payload_json=excluded.payload_json').run(objectId, revision, payload);
    registry.db.prepare('INSERT INTO building_model_history VALUES (?,?,?,?,?,?)').run(objectId, revision, at, actor, reason, payload);
    return readBuilding(registry, objectId);
  })();
}

/** Isolated building API; no route, duration, review or factual-visit mutations. */
export async function handleBuilding(request, registry) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/buildings/')) return null;
  const match = /^\/api\/buildings\/([^/]+)$/.exec(url.pathname);
  if (!match) return json({ error: 'Раздел схемы не найден.' }, 404);
  try {
    const id = decodeURIComponent(match[1]);
    if (request.method === 'GET') return json(readBuilding(registry, id));
    if (request.method === 'PUT') return json(saveBuilding(registry, id, await request.json()));
    return json({ error: 'Метод не поддерживается.' }, 405);
  } catch (error) {
    return json({ error: error.message }, /уже изменилась/.test(error.message) ? 409 : /Объект не найден/.test(error.message) ? 404 : 422);
  }
}
