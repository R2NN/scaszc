import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";
import { cityNameFromAddress, cityNameFromValue, deriveRegions, regionIdForCity, resolveImportedCity } from "../src/regions.js";

test("derives the location catalog only from imported cities", () => {
  const orders = [
    { id: 1, regionId: regionIdForCity("Москва"), regionName: "Москва", coords: [55.75, 37.61], duration: 60 },
    { id: 2, regionId: regionIdForCity("Казань"), regionName: "Казань", coords: [55.79, 49.11], duration: 60 },
  ];
  const engineers = [{ id: "e-1", regionId: regionIdForCity("Казань"), regionName: "Казань", startCoords: [55.8, 49.1] }];
  const regions = deriveRegions(orders, engineers);
  assert.deepEqual(regions.map(region => region.name), ["Казань", "Москва"]);
  assert.equal(regions.find(region => region.name === "Казань").engineerCount, 1);
  assert.equal(regions.find(region => region.name === "Казань").orderCount, 1);
});

test("does not turn Moscow streets, districts, or oblast labels into cities", () => {
  assert.equal(cityNameFromAddress("Г.Город Москва, пр-кт Волгоградский, д. 128"), "Москва");
  assert.equal(cityNameFromAddress("Москва Бирюлёвская ул. д. 44"), "Москва");
  assert.equal(cityNameFromAddress("Кашира Крижановского ул. д. 5/1"), "");
  assert.equal(cityNameFromAddress("район Строгино, улица Твардовского"), "");
  assert.equal(cityNameFromValue("Обл.Московская область"), "");
  assert.equal(cityNameFromValue("Казань"), "Казань");
  assert.equal(resolveImportedCity("", "Кашира Крижановского ул. д. 5/1", "Москва"), "Москва");
  assert.equal(resolveImportedCity("Казань", "улица Баумана, 1", "Москва"), "Казань");
});

test("keeps the Moscow territory fixture in one city", async () => {
  const payload = JSON.parse(await readFile(new URL("../public/test-data/beego-moscow-territories.json", import.meta.url), "utf8"));
  const cities = new Set(payload.jobs.map(job => resolveImportedCity(job.city, job.address, "Москва")));
  assert.deepEqual([...cities], ["Москва"]);
});

test("keeps all 205 jobs from the initial planning fixture in the Moscow workspace", async () => {
  const payload = JSON.parse(await readFile(new URL("../public/test-data/beego-algorithm-initial.json", import.meta.url), "utf8"));
  const cities = payload.jobs.map(job => resolveImportedCity(job.city, job.address, "Москва"));
  assert.equal(cities.length, 205);
  assert.deepEqual([...new Set(cities)], ["Москва"]);
});

test("exposes planning backend contracts", async () => {
  const health = await worker.fetch(new Request("https://example.test/api/health"), {});
  assert.equal(health.status, 200);
  const healthPayload = await health.json();
  assert.equal(healthPayload.service, "beego-planning-adapter");
  assert.equal(healthPayload.algorithm, "beeline-planning-ortools-exact-v2.1-full-coverage-28-teams");

  const integrationData = JSON.parse(await readFile(new URL("../public/test-data/beego-algorithm-integration.json", import.meta.url), "utf8"));
  const artifact = await readFile(new URL("../public/data/beego-exact-plans.json", import.meta.url), "utf8");

  const plan = await worker.fetch(new Request("https://example.test/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      regionId: "moscow",
      engineers: integrationData.engineers.map((engineer) => ({ id: engineer.engineer_id, name: engineer.engineer_name, regionId: "moscow" })),
      orders: integrationData.jobs.map((job, index) => ({ id: index + 1, sourceId: job.job_id, regionId: "moscow" })),
    }),
  }), { PLANNING_ARTIFACT_JSON: artifact });
  const result = await plan.json();
  assert.equal(plan.status, 200);
  assert.equal(result.status, "EXACT_VALID");
  assert.equal(result.publicationAllowed, true);
  assert.equal(result.validation.status, "VALID");
  assert.equal(result.metrics.assigned, 206);
  assert.equal(result.metrics.unassigned, 0);
  assert.ok(result.routes.some((route) => route.assignments.some((assignment) => assignment.geometry.length > 1)));
  assert.match(result.algorithm, /ortools-exact/);
});

test("matches exact-plan engineers by imported source id", async () => {
  const fixture = JSON.parse(await readFile(new URL("../public/test-data/beego-algorithm-initial.json", import.meta.url), "utf8"));
  const artifact = await readFile(new URL("../public/data/beego-exact-plans.json", import.meta.url), "utf8");
  const response = await worker.fetch(new Request("https://example.test/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      regionId: "moscow",
      orders: fixture.jobs.map((job, index) => ({ id: `moscow:${job.job_id || index + 1}`, sourceId: job.job_id, regionId: "moscow" })),
      engineers: fixture.engineers.map((engineer) => ({
        id: `moscow:${engineer.engineer_id}`,
        sourceId: engineer.engineer_id,
        name: engineer.engineer_name,
        regionId: "moscow",
      })),
    }),
  }), { PLANNING_ARTIFACT_JSON: artifact });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.status, "EXACT_VALID");
  assert.equal(result.metrics.assigned, 205);
  assert.equal(result.metrics.unassigned, 0);
  assert.ok(result.routes.filter(route => route.assignments.length).every(route => String(route.engineerId).startsWith("moscow:")));
});

test("rejects an uploaded dataset that has not passed the exact pipeline", async () => {
  const artifact = await readFile(new URL("../public/data/beego-exact-plans.json", import.meta.url), "utf8");
  const response = await worker.fetch(new Request("https://example.test/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      regionId: "kazan",
      orders: [{ id: "kazan:NEW-1", sourceId: "NEW-1", regionId: "kazan", coords: [55.7908, 49.1142], start: "09:00", end: "15:00", duration: 60, skill: "Подключение" }],
      engineers: [{ id: "kazan:ENG-1", name: "Тестовый инженер", regionId: "kazan", startCoords: [55.7974, 49.105], shiftStart: "08:00", shiftEnd: "18:00", skills: ["Подключение"], transport: "Автомобиль" }],
    }),
  }), { PLANNING_ARTIFACT_JSON: artifact });
  const payload = await response.json();
  assert.equal(response.status, 422);
  assert.equal(payload.code, "UNSEALED_DATASET");
});

test("does not invent a route when the verified artifact is unavailable", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      regionId: "kazan",
      orders: [{ id: "job", sourceId: "job", regionId: "kazan", coords: [55.79, 49.12], start: "09:00", end: "17:00", duration: 30 }],
      engineers: [{ id: "engineer", name: "Инженер", regionId: "kazan", startCoords: [55.8, 49.1], shiftStart: "08:00", shiftEnd: "18:00" }],
    }),
  }), {});
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.code, "PLANNING_ARTIFACT_UNAVAILABLE");
});

test("serves the canonical urgent event used by exact replanning", async () => {
  const artifact = await readFile(new URL("../public/data/beego-exact-plans.json", import.meta.url), "utf8");
  const response = await worker.fetch(new Request("https://example.test/api/scenario/event"), { PLANNING_ARTIFACT_JSON: artifact });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.order.sourceId, "EAST-EVENT-001");
  assert.equal(payload.order.priority, "Авария");
  assert.deepEqual(payload.order.coords, [55.7104451, 37.7691714]);
  assert.equal(payload.event.event_type, "NEW_URGENT_JOB");
});

test("removed manual reassignment endpoint is unavailable", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/reassign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planId: "exact-plan", orderId: 1, engineerId: "EAST-ENG-01" }),
  }), {});
  const payload = await response.json();
  assert.equal(response.status, 404);
  assert.equal(payload.code, "API_NOT_FOUND");
});

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, new URL(request.url).pathname.startsWith("/api/") ? 0 : 1);
  }
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
});
