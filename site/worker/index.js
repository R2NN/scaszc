import exactWorker from './exact-base.js';
import { transportCode } from '../src/transport.js';

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...(init.headers || {}),
  },
});

const geocodeMemoryCache = new Map();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let nextGeoapifySlot = 0;
const normalizeAddress = (value) => String(value || "").trim().replace(/\s+/g, " ");
const normalizePlace = (value) => String(value || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, "");
const normalizeHouseNumber = (value) => String(value || "").toLocaleLowerCase("ru-RU").replace(/^\s*(?:дом|д)\.?\s*/i, "").replace(/[,;]/g, " ").replace(/корпус|корп\.?|к\.?/g, "к").replace(/строение|стр\.?|с\.?/g, "с").replace(/[\s.-]+/g, "");
const houseNumbersMatch = (requested, candidate) => {
  if (!requested || !candidate) return false;
  if (requested === candidate) return true;
  const requestedHasPart = /[кс]/.test(requested);
  return !requestedHasPart && new RegExp(`^${requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[кс].+)$`).test(candidate);
};
const addressHouseNumber = (value) => {
  const address = normalizeAddress(value);
  const explicit = address.match(/(?:^|[,\s])(?:д|дом)\.?\s*(\d+[а-яa-z]?(?:\s*(?:к|корпус|корп|с|стр|строение)\.?\s*\d+)?(?:\/\d+)?)/i);
  if (explicit) return normalizeHouseNumber(explicit[1]);
  const numericParts = address.match(/\b\d+[а-яa-z]?(?:\/\d+)?\b/gi) || [];
  return normalizeHouseNumber(numericParts.at(-1));
};

const MOSCOW_LOCALITY = /(?:^|[\s,.])(?:г\.?\s*)?(?:город\s+)?москва(?:[\s,]|$)/i;
const streetTypeLabels = {
  "ул": "улица", "улица": "улица", "пр-кт": "проспект", "пркт": "проспект", "проспект": "проспект",
  "пер": "переулок", "переулок": "переулок", "б-р": "бульвар", "бр": "бульвар", "бульвар": "бульвар",
  "наб": "набережная", "набережная": "набережная", "проезд": "проезд", "пр-зд": "проезд", "ш": "шоссе", "шоссе": "шоссе",
};
const canonicalStreetType = (value) => streetTypeLabels[String(value || '').toLocaleLowerCase('ru-RU')] || String(value || '').toLocaleLowerCase('ru-RU');
const streetParts = (value) => {
  const text = normalizeAddress(value).replace(/\s*\([^)]*\)\s*/g, ' ');
  const typePattern = '(улица|ул|проспект|пр-?кт|переулок|пер|бульвар|б-?р|набережная|наб|проезд|пр-?зд|шоссе|ш)';
  const before = text.match(new RegExp(`(?:^|[\\s,])${typePattern}(?=\\.|\\s|$)\\.?\\s*([^,]+?)(?=,\\s*(?:дом|д)?\\.?\\s*\\d|,|$)`, 'i'));
  const after = text.match(new RegExp(`(?:^|,)\\s*([^,]+?)\\s+${typePattern}(?=\\.|\\s|,|$)\\.?(?=\\s*(?:дом|д)\\.?|,|$)`, 'i'));
  const type = canonicalStreetType(before?.[1] || after?.[2]);
  const name = normalizePlace(before?.[2] || after?.[1]);
  return { type, name };
};
const streetsMatch = (requested, candidate) => {
  if (!requested.name) return true;
  if (!candidate.name || candidate.name !== requested.name) return false;
  return !requested.type || !candidate.type || requested.type === candidate.type;
};
const geocodeQuery = (original, locality) => {
  const nestedLocalityPattern = /^\s*(?:(?:обл\.?\s*)?Московская\s+область|МО)\s*,?\s*(?:г\.?|город)\s*([^,]+),\s*(?:пгт\.?|пос[её]лок)\s*([^,]+),\s*(ул|улица|пр-?кт|проспект|пер|переулок|б-?р|бульвар|наб|набережная|проезд|пр-?зд|ш|шоссе)\.?\s*([^,]+),\s*(?:д|дом)\.?\s*(.+)$/i;
  const componentPattern = /^(.+?),\s*(ул|улица|пр-?кт|проспект|пер|переулок|б-?р|бульвар|наб|набережная|проезд|пр-?зд|ш|шоссе)\.?\s*([^,]+),\s*(?:д|дом)\.?\s*(.+)$/i;
  const regionPattern = /^\s*(?:МО|Московская\s+область)\s*,?\s*(?:г\.?|город)\s+([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]*)\s+(.+?)\s+(ул|улица|пр-?кт|проспект|пер|переулок|б-?р|бульвар|наб|набережная|проезд|пр-?зд|ш|шоссе)\.?\s+(?:д|дом)\.?\s*(.+)$/i;
  const nestedLocalityMatch = original.match(nestedLocalityPattern);
  if (nestedLocalityMatch) {
    const type = streetTypeLabels[nestedLocalityMatch[3].toLocaleLowerCase("ru-RU")] || nestedLocalityMatch[3];
    const settlement = nestedLocalityMatch[2].replace(/-1$/i, "").trim();
    return `Московская область, ${nestedLocalityMatch[1].trim()}, ${settlement}, ${type} ${nestedLocalityMatch[4].trim()}, ${nestedLocalityMatch[5].trim()}, Россия`;
  }
  const componentMatch = original.match(componentPattern);
  const regionMatch = original.match(regionPattern);
  let streetType = "", street = "", house = "";
  if (componentMatch) {
    streetType = componentMatch[2];
    street = componentMatch[3];
    house = componentMatch[4];
  } else if (regionMatch) {
    streetType = regionMatch[3];
    street = regionMatch[2];
    house = regionMatch[4];
  }
  if (street && house) {
    const type = streetTypeLabels[streetType.toLocaleLowerCase("ru-RU").replace("пр-кт", "пр-кт").replace("б-р", "б-р").replace("пр-зд", "пр-зд")] || streetType;
    const area = locality === "Москва" ? "Москва" : ["Московская область", locality].filter(Boolean).join(", ");
    return `${area}, ${type} ${street.trim()}, ${house.trim()}, Россия`;
  }
  return /(?:^|,\s*)россия(?:,|$)/i.test(original) ? original : `${original}, Россия`;
};
const parseRussianAddress = (value) => {
  const original = normalizeAddress(value);
  if (!original) return { original, locality: "", query: "" };
  let locality = MOSCOW_LOCALITY.test(original) ? "Москва" : "";
  if (!locality) locality = original.match(/^\s*(?:(?:обл\.?\s*)?Московская\s+область|МО)\s*,?\s*(?:г\.?|город)\s*([А-ЯЁA-Z][А-ЯЁа-яёA-Za-z-]*)/i)?.[1] || "";
  if (!locality) {
    const firstPart = original.split(",")[0]?.trim() || "";
    if (firstPart && !/^(?:ул|улица|пр-?кт|проспект|пер|переулок|б-?р|бульвар|наб|набережная|проезд|ш|шоссе)\.?\b/i.test(firstPart)) locality = firstPart.replace(/^(?:г\.?|город)\s+/i, "");
  }
  return { original, locality, query: geocodeQuery(original, locality) };
};
const geocodeCacheKey = (address) => `russia-v6:${normalizeAddress(address).toLocaleLowerCase("ru-RU")}`;

async function geocodeAddress(item, apiKey) {
  const address = normalizeAddress(item.address);
  const parsed = parseRussianAddress(address);
  if (!parsed.query) return { id: item.id, address, status: "review", error: "Адрес не указан", provider: "geoapify" };
  const cacheKey = geocodeCacheKey(address);
  if (geocodeMemoryCache.has(cacheKey)) return { ...geocodeMemoryCache.get(cacheKey), id: item.id, cached: true };

  const params = new URLSearchParams({
    format: "json",
    lang: "ru",
    limit: "10",
    country: "Россия",
    text: parsed.query,
    filter: "countrycode:ru",
    bias: "proximity:37.6173,55.7558",
    apiKey,
  });
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`https://api.geoapify.com/v1/geocode/search?${params}`);
      if (response.ok) break;
      if (response.status !== 429 && response.status < 500) break;
      const retryAfter = Number(response.headers.get("retry-after")) || attempt + 1;
      await sleep(Math.max(900, retryAfter * 1000));
    } catch {
      if (attempt < 2) await sleep(700 * (attempt + 1));
    }
  }
  if (!response?.ok) {
    return { id: item.id, address, status: "error", error: response?.status === 429 ? "Лимит Geoapify временно исчерпан" : "Временная ошибка соединения с Geoapify" };
  }

  const payload = await response.json().catch(() => ({}));
  const requestedHouse = normalizeHouseNumber(addressHouseNumber(address));
  const requestedStreet = streetParts(parsed.query);
  const requestedLocality = parsed.locality.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const requestedDistrict = normalizePlace(item.district);
  const candidates = (payload.results || []).filter((candidate) => {
    const localityText = [candidate.city, candidate.town, candidate.village, candidate.municipality, candidate.county, candidate.formatted].filter(Boolean).join(" ").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    const localityMatches = !requestedLocality || localityText.includes(requestedLocality);
    const countryMatches = String(candidate.country_code || "ru").toLocaleLowerCase("ru-RU") === "ru";
    const buildingLevel = ["building", "amenity"].includes(candidate.result_type);
    const candidateHouse = normalizeHouseNumber(candidate.housenumber || addressHouseNumber(candidate.formatted));
    const streetMatches = streetsMatch(requestedStreet, streetParts(candidate.street || candidate.formatted));
    return countryMatches && localityMatches && buildingLevel && streetMatches && houseNumbersMatch(requestedHouse,candidateHouse);
  });
  const match = candidates.sort((a, b) => {
    const score = (candidate) => Number(candidate.rank?.match_type === "full_match") * 3 + Number(candidate.result_type === "building") * 2 + Number(candidate.rank?.confidence || 0);
    return score(b) - score(a);
  })[0];
  if (!match) {
    const suggestions = (payload.results || []).filter((candidate) => !requestedLocality || [candidate.city, candidate.town, candidate.village, candidate.municipality, candidate.county, candidate.formatted].filter(Boolean).join(" ").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").includes(requestedLocality));
    const suggestion = suggestions.sort((a,b)=>{
      const score=candidate=>Number(streetsMatch(requestedStreet,streetParts(candidate.street||candidate.formatted)))*12+Number(requestedDistrict&&normalizePlace(candidate.formatted).includes(requestedDistrict))*6+Number(candidate.result_type==='building')*3+Number(candidate.result_type==='street')*2+Number(candidate.rank?.confidence||0);
      return score(b)-score(a);
    })[0];
    const suggestionLat=Number(suggestion?.lat),suggestionLon=Number(suggestion?.lon),hasSuggestionCoords=Number.isFinite(suggestionLat)&&Number.isFinite(suggestionLon);
    const result = { address, status: "review", error: "Точный дом не найден", formattedAddress: suggestion?.formatted || "", coords:hasSuggestionCoords?[suggestionLat,suggestionLon]:null, confidence:Number(suggestion?.rank?.confidence||0), precision:suggestion?.result_type||"unknown", provider: "geoapify" };
    geocodeMemoryCache.set(cacheKey, result);
    return { ...result, id: item.id };
  }

  const lat = Number(match.lat), lon = Number(match.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const result = { address, status: "review", error: "Геокодер вернул некорректные координаты", provider: "geoapify" };
    geocodeMemoryCache.set(cacheKey, result);
    return { ...result, id: item.id };
  }

  const confidence = Number(match.rank?.confidence || 0);
  const result = {
    address,
    formattedAddress: match.formatted || address,
    coords: [lat, lon],
    confidence,
    precision: match.result_type || "unknown",
    status: "exact",
    provider: "geoapify",
  };
  geocodeMemoryCache.set(cacheKey, result);
  return { ...result, id: item.id };
}

async function geocodeBatch(payload = {}, env = {}) {
  const apiKey = env.GEOAPIFY_API_KEY;
  if (!apiKey) return { error: "Geoapify не настроен", code: "GEOAPIFY_NOT_CONFIGURED" };
  const addresses = Array.isArray(payload.addresses) ? payload.addresses.slice(0, 25).map((item, index) => typeof item === "string" ? { id: index, address: item } : item).filter((item) => normalizeAddress(item.address)) : [];
  if (!addresses.length) return { results: [], provider: "geoapify" };

  const groupTasks = [];
  for (let index = 0; index < addresses.length; index += 5) {
    const group = addresses.slice(index, index + 5);
    const needsProvider = group.some((item) => normalizeAddress(item.address) && !geocodeMemoryCache.has(geocodeCacheKey(item.address)));
    let scheduledDelay = 0;
    if (needsProvider) {
      const scheduledAt = Math.max(Date.now(), nextGeoapifySlot);
      scheduledDelay = Math.max(0, scheduledAt - Date.now());
      nextGeoapifySlot = scheduledAt + 1050;
    }
    groupTasks.push((async () => {
      if (scheduledDelay) await sleep(scheduledDelay);
      const settled = await Promise.allSettled(group.map((item) => geocodeAddress(item, apiKey)));
      return settled.map((entry, itemIndex) => entry.status === "fulfilled" ? entry.value : { id: group[itemIndex].id, address: group[itemIndex].address, status: "error", error: "Временная ошибка Geoapify" });
    })());
  }
  const results = (await Promise.all(groupTasks)).flat();
  return { results, provider: "geoapify", attribution: "Powered by Geoapify" };
}

async function suggestMoscowAddresses(query, env = {}) {
  if (!env.GEOAPIFY_API_KEY) return { error: 'Geoapify не настроен', code: 'GEOAPIFY_NOT_CONFIGURED' };
  const text = normalizeAddress(query).slice(0, 160);
  if (text.length < 3) return { results: [], provider: 'geoapify' };
  const params = new URLSearchParams({
    text: /москв/i.test(text) ? text : `Москва, ${text}`,
    format: 'json',
    lang: 'ru',
    limit: '8',
    bias: 'proximity:37.6173,55.7558',
    filter: 'rect:36.95,55.55,38.15,56.05',
    apiKey: env.GEOAPIFY_API_KEY,
  });
  const response = await fetch(`https://api.geoapify.com/v1/geocode/autocomplete?${params}`);
  if (!response.ok) return { error: 'Geoapify временно недоступен', code: 'GEOAPIFY_UNAVAILABLE' };
  const payload = await response.json();
  const results = (payload.results || []).filter(item => /москв/i.test([
    item.city, item.municipality, item.county, item.formatted,
  ].filter(Boolean).join(' '))).map(item => ({
    address: item.formatted,
    coords: [Number(item.lat), Number(item.lon)],
    precision: item.result_type || '',
  })).filter(item => item.address && item.coords.every(Number.isFinite));
  return { results, provider: 'geoapify' };
}

const sourceOrderId = (order = {}) => String(
  order.sourceId
  || order.sourceData?.job_id
  || order.sourceData?.JOB_ID
  || order.id
  || "",
).trim();

const sourceEngineerId = (engineer = {}) => String(
  engineer.sourceId
  || engineer.sourceData?.engineer_id
  || engineer.sourceData?.ENGINEER_ID
  || engineer.id
  || "",
).trim();

const sameIdSet = (actual, expected) => {
  if (actual.length !== expected.length) return false;
  const actualIds = new Set(actual);
  return expected.every((id) => actualIds.has(id));
};

function buildExactPlan(payload = {}, artifact) {
  if (!artifact?.plans || !artifact?.canonical) {
    const error = new Error("Точный планировщик не загрузил проверенный артефакт");
    error.code = "PLANNING_ARTIFACT_UNAVAILABLE";
    throw error;
  }
  const regionId = payload.regionId || "moscow";
  const orders = Array.isArray(payload.orders) ? payload.orders.filter((order) => !order.regionId || order.regionId === regionId) : [];
  const engineers = Array.isArray(payload.engineers) ? payload.engineers.filter((engineer) => !engineer.regionId || engineer.regionId === regionId) : [];
  const orderIds = orders.map(sourceOrderId).filter(Boolean).sort();
  const planKey = sameIdSet(orderIds, artifact.canonical.eventJobIds || [])
    ? "event"
    : sameIdSet(orderIds, artifact.canonical.initialJobIds || []) ? "initial" : "";
  if (!planKey) {
    const error = new Error("Этот набор отличается от проверенного набора алгоритма. Сначала подготовьте матрицы маршрутов для новых данных.");
    error.code = "UNSEALED_DATASET";
    throw error;
  }
  const source = artifact.plans[planKey];
  if (!sameIdSet(engineers.map(sourceEngineerId).filter(Boolean), artifact.canonical.engineerIds || [])) {
    const error = new Error('Состав инженеров изменился; нужен новый расчёт маршрутов.');
    error.code = 'UNSEALED_DATASET';
    throw error;
  }
  if (engineers.some(engineer => /снят со смены|недоступ|отпуск|боле/i.test(engineer.status || ''))) {
    const error = new Error('Доступность инженеров изменилась; нужен новый расчёт маршрутов.');
    error.code = 'UNSEALED_DATASET';
    throw error;
  }
  if (source.status !== "EXACT_VALID" || source.publicationAllowed !== true || source.validationStatus !== "VALID") {
    const error = new Error("Алгоритм вернул план, который не прошёл независимую проверку");
    error.code = "PLAN_NOT_PUBLISHABLE";
    throw error;
  }
  const orderBySourceId = new Map(orders.map((order) => [sourceOrderId(order), order]));
  const engineerById = new Map(engineers.map((engineer) => [sourceEngineerId(engineer), engineer]));
  const missingEngineers = [...new Set(source.routes.filter((route) => route.assignments.length).map((route) => route.engineerId))]
    .filter((engineerId) => !engineerById.has(String(engineerId)));
  if (missingEngineers.length) {
    const error = new Error(`Для точного плана не загружены инженеры: ${missingEngineers.slice(0, 4).join(", ")}${missingEngineers.length > 4 ? "…" : ""}`);
    error.code = "ENGINEERS_MISSING";
    throw error;
  }
  const expectedTransports = artifact.canonical.engineerTransports;
  if (!expectedTransports || typeof expectedTransports !== 'object') {
    const error = new Error('В проверенном плане отсутствуют исходные виды транспорта инженеров');
    error.code = 'PLANNING_ARTIFACT_UNAVAILABLE';
    throw error;
  }
  const mismatchedTransports = engineers.filter((engineer) => {
    const expected = expectedTransports[sourceEngineerId(engineer)];
    return expected && transportCode(engineer.transport) !== transportCode(expected);
  });
  if (mismatchedTransports.length) {
    const error = new Error(`Транспорт инженеров отличается от проверенного расчёта: ${mismatchedTransports.slice(0, 4).map(sourceEngineerId).join(', ')}${mismatchedTransports.length > 4 ? '…' : ''}`);
    error.code = 'ENGINEER_TRANSPORT_MISMATCH';
    throw error;
  }
  const routes = source.routes.map((route) => {
    const engineer = engineerById.get(String(route.engineerId));
    return {
      ...route,
      engineerId: engineer?.id ?? route.engineerId,
      engineerName: engineer?.name || route.engineerName,
      assignments: route.assignments.map((assignment) => ({
        ...assignment,
        orderId: orderBySourceId.get(String(assignment.sourceOrderId))?.id,
        engineerId: engineer?.id ?? route.engineerId,
      })).filter((assignment) => assignment.orderId !== undefined),
    };
  });
  const unassigned = source.unassigned.map((item) => ({
    ...item,
    orderId: orderBySourceId.get(String(item.sourceOrderId))?.id,
  })).filter((item) => item.orderId !== undefined);
  return {
    id: `exact-${source.contentSha256.slice(0, 12)}`,
    algorithm: artifact.algorithm,
    provider: artifact.provider,
    regionId,
    createdAt: source.planningAt,
    status: source.status,
    publicationAllowed: true,
    validation: { status: source.validationStatus },
    datasetSha256: source.datasetSha256,
    contentSha256: source.contentSha256,
    routes,
    unassigned,
    event: source.event,
    metrics: {
      ...source.metrics,
      total: orders.length,
      assigned: routes.reduce((sum, route) => sum + route.assignments.length, 0),
      unassigned: unassigned.length,
      additionalEngineers: unassigned.length ? 1 : 0,
    },
  };
}

async function planningArtifact(request, env = {}) {
  if (env.PLANNING_ARTIFACT_JSON) {
    try {
      return JSON.parse(env.PLANNING_ARTIFACT_JSON);
    } catch {
      return null;
    }
  }
  if (!env.ASSETS?.fetch) return null;
  const artifactUrl = new URL("/data/beego-exact-plans.json", request.url);
  const response = await env.ASSETS.fetch(new Request(artifactUrl));
  return response.ok ? response.json().catch(() => null) : null;
}

async function api(request, env = {}) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" } });
  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ status: "ok", service: "beego-planning-adapter", algorithm: "beeline-planning-ortools-exact", version: 2 });
  }
  if (url.pathname === "/api/plan" && request.method === "POST") {
    return exactWorker.fetch(request, env);
  }
  if (url.pathname === "/api/scenario/event" && request.method === "GET") {
    const artifact = await planningArtifact(request, env);
    if (!artifact?.canonical?.eventOrder) return json({ error: "Контрольное событие недоступно" }, { status: 404 });
    return json({ order: artifact.canonical.eventOrder, event: artifact.plans?.event?.event || null });
  }
  if (url.pathname === "/api/geocode" && request.method === "POST") {
    const payload = await request.json().catch(() => ({}));
    const result = await geocodeBatch(payload, env);
    if (result.code === "GEOAPIFY_NOT_CONFIGURED") return json(result, { status: 503 });
    return json(result);
  }
  if (url.pathname === '/api/geocode/suggest' && request.method === 'GET') {
    const result = await suggestMoscowAddresses(url.searchParams.get('q'), env);
    return json(result, { status: result.error ? 503 : 200 });
  }
  if (url.pathname === "/api/reassign" && request.method === "POST") {
    const payload = await request.json().catch(() => ({}));
    if (!payload.orderId || !payload.engineerId) return json({ error: "orderId and engineerId are required" }, { status: 400 });
    return json({
      error: "Ручное назначение должно пройти повторный проверяемый расчёт и валидацию",
      code: "REPLAN_REQUIRED",
      ...payload,
    }, { status: 409 });
  }
  return null;
}

export { buildExactPlan };

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      const apiResponse = await api(request, env);
      if (apiResponse) return apiResponse;
    }
    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return response;
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
