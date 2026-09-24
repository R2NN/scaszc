import { normalizePlanningPriority } from '../src/planningPriority.js';

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
  const typePattern = '(ул|улица|пр-?кт|проспект|пер|переулок|б-?р|бульвар|наб|набережная|проезд|пр-?зд|ш|шоссе)';
  const before = text.match(new RegExp(`${typePattern}\\.?\\s*([^,]+?)(?=,\\s*(?:дом|д)?\\.?\\s*\\d|,|$)`, 'i'));
  const after = text.match(new RegExp(`(?:^|,)\\s*([^,]+?)\\s+${typePattern}\\.?(?=\\s*(?:дом|д)\\.?|,|$)`, 'i'));
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
const geocodeCacheKey = (address) => `russia-v5:${normalizeAddress(address).toLocaleLowerCase("ru-RU")}`;

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

const planningClock = value => String(value || '').match(/T(\d{2}:\d{2})/)?.[1] || String(value || '').slice(0, 5);
const planningSkill = value => ({ 'Локальные работы': 'LOCAL', 'Подключение': 'INSTALL', 'Аварийные работы': 'EMERGENCY', 'Дозаказ': 'UPSELL' })[String(value || '').trim()] || String(value || '').trim().toUpperCase();
const planningTransport = value => ({ 'Автомобиль': 'CAR', 'Общественный транспорт': 'PUBLIC_TRANSIT', 'Пешком': 'WALKING', 'Велосипед': 'BICYCLE' })[String(value || '').trim()] || String(value || '').trim().toUpperCase();
const planningEquipment = value => String(value || '').split(/\s*[|;,·]\s*/).filter(Boolean).map(item => ({ 'Диагностический комплект': 'DIAG_SET', 'Монтажный комплект': 'INSTALL_SET', 'Кабельный комплект': 'CABLE_SET', 'Кабель': 'CABLE_PACK', 'Роутер': 'ROUTER', 'ONT': 'ONT_GIGABIT', 'ТВ-приставка': 'TV_BOX' })[item] || item).sort().join('|');
const sameCoordinates = (point, model) => Array.isArray(point) && point.length === 2 && Math.abs(Number(point[0]) - Number(model.latitude)) < 0.000001 && Math.abs(Number(point[1]) - Number(model.longitude)) < 0.000001;
const differsFromSealedModel = (orders, engineers, canonical) => {
  const jobs = canonical.jobModels || {};
  const crew = canonical.engineerModels || {};
  for (const order of orders) {
    const model = jobs[sourceOrderId(order)];
    if (!model) return true;
    const source = order.sourceData || {};
    if (Object.keys(model).some(key => source[key] !== undefined && String(source[key]) !== String(model[key]))) return true;
    if (order.start && planningClock(order.start) !== planningClock(model.window_start)) return true;
    if (order.end && planningClock(order.end) !== planningClock(model.window_end)) return true;
    if (order.duration && Number(order.duration) !== Number(model.service_duration_min)) return true;
    if (order.skill && planningSkill(order.skill) !== model.required_skill) return true;
    if (normalizePlanningPriority(order.priority ?? source.priority ?? model.priority) !== model.priority) return true;
    if (order.zoneId && String(order.zoneId) !== model.zone_id) return true;
    if (order.coords && !sameCoordinates(order.coords, model)) return true;
    if (order.equipment && planningEquipment(order.equipment) !== planningEquipment(model.required_equipment)) return true;
  }
  for (const engineer of engineers) {
    const model = crew[sourceEngineerId(engineer)];
    if (!model) return true;
    const source = engineer.sourceData || {};
    for (const [key, value] of Object.entries({ zone_id: model.zone_id, shift_start: model.shift_start, shift_end: model.shift_end, transport_type: model.transport_type, start_office_id: model.start_office_id })) {
      if (source[key] !== undefined && String(source[key]) !== String(value)) return true;
    }
    if (engineer.shiftStart && planningClock(engineer.shiftStart) !== planningClock(model.shift_start)) return true;
    if (engineer.shiftEnd && planningClock(engineer.shiftEnd) !== planningClock(model.shift_end)) return true;
    if (engineer.transport && planningTransport(engineer.transport) !== model.transport_type) return true;
    if (engineer.zoneId && String(engineer.zoneId) !== model.zone_id) return true;
    if (engineer.startCoords && !sameCoordinates(engineer.startCoords, model)) return true;
    if (Array.isArray(engineer.skills) && engineer.skills.map(planningSkill).sort().join('|') !== model.skills.join('|')) return true;
    if (engineer.equipment && planningEquipment(engineer.equipment) !== model.equipment.join('|')) return true;
  }
  return false;
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
  if (differsFromSealedModel(orders, engineers, artifact.canonical)) {
    const error = new Error('Загруженные поля отличаются от опубликованного точного набора; нужен новый exact-расчёт.');
    error.code = 'UNSEALED_DATASET';
    throw error;
  }
  const source = artifact.plans[planKey];
  if (payload.planningDate && String(payload.planningDate).slice(0, 10) !== String(source.planningAt || '').slice(0, 10)) {
    const error = new Error('Дата отличается от проверенного точного набора; нужен новый exact-расчёт.');
    error.code = 'UNSEALED_DATASET';
    throw error;
  }
  if (Array.isArray(payload.sharedInventory) && payload.sharedInventory.length) {
    const error = new Error('Остатки отличаются от проверенного точного набора; нужен новый exact-расчёт.');
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
    return json({
      status: "ok",
      service: "beego-planning-adapter",
      algorithm: "beeline-planning-ortools-exact-v2.1-full-coverage-28-teams",
      dynamicReplanning: env.EXACT_PLANNER_URL ? "connected" : "requires_exact_backend",
      version: 3,
    });
  }
  if (url.pathname === "/api/plan" && request.method === "POST") {
    if (env.EXACT_PLANNER_URL) {
      const endpoint = new URL('/api/plan', env.EXACT_PLANNER_URL);
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: await request.text(),
          signal: AbortSignal.timeout(15 * 60 * 1000),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
          return json({ error: 'Расчёт остановлен после 15 минут: проверенный план не получен' }, { status: 504 });
        }
        throw error;
      }
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const payload = await request.json().catch(() => ({}));
    try {
      return json(buildExactPlan(payload, await planningArtifact(request, env)));
    } catch (error) {
      const status = error?.code === "PLANNING_ARTIFACT_UNAVAILABLE" ? 503 : 422;
      return json({ error: error?.message || "Не удалось построить точный план", code: error?.code || "PLANNING_FAILED" }, { status });
    }
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
  if (url.pathname === "/api/replan" && request.method === "POST") {
    if (!env.EXACT_PLANNER_URL) {
      return json({
        error: "Точный backend перепланирования не настроен. Публикация приближённого плана запрещена.",
        code: "EXACT_REPLANNER_UNAVAILABLE",
      }, { status: 503 });
    }
    const endpoint = new URL("/api/replan", env.EXACT_PLANNER_URL);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await request.text(),
    });
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return null;
}

export { buildExactPlan };

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      const apiResponse = await api(request, env);
      if (apiResponse) return apiResponse;
      return json({ error: "API endpoint not found", code: "API_NOT_FOUND" }, { status: 404 });
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
