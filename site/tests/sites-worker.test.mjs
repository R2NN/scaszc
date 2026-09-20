import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

test("exposes planning backend contracts", async () => {
  const health = await worker.fetch(new Request("https://example.test/api/health"), {});
  assert.equal(health.status, 200);
  const healthPayload = await health.json();
  assert.equal(healthPayload.service, "beego-planning-adapter");
  assert.equal(healthPayload.algorithm, "beeline-planning-ortools-exact");

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
  assert.equal(result.metrics.assigned, 205);
  assert.equal(result.metrics.unassigned, 1);
  assert.ok(result.routes.some((route) => route.assignments.some((assignment) => assignment.geometry.length > 1)));
  assert.match(result.algorithm, /ortools-exact/);
});

test("rejects an unsealed dataset instead of fabricating a route", async () => {
  const artifact = await readFile(new URL("../public/data/beego-exact-plans.json", import.meta.url), "utf8");
  const response = await worker.fetch(new Request("https://example.test/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ regionId: "moscow", orders: [{ id: 1, sourceId: "NEW-1" }], engineers: [] }),
  }), { PLANNING_ARTIFACT_JSON: artifact });
  const payload = await response.json();
  assert.equal(response.status, 422);
  assert.equal(payload.code, "UNSEALED_DATASET");
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

test("refuses to publish an unvalidated manual reassignment", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/reassign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planId: "exact-plan", orderId: 1, engineerId: "EAST-ENG-01" }),
  }), {});
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.code, "REPLAN_REQUIRED");
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
    assert.equal(calls, 1);
  }
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
});
