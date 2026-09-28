import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import worker from "./worker/index.js";
import { runExactReplan } from './scripts/exact-replan-runner.mjs';
import { runExactPlan } from './scripts/exact-plan-runner.mjs';
import { isCanonicalPlanningInput } from './scripts/is-canonical-planning-input.mjs';

const loadLocalVariables = () => {
  const variables = { ...process.env };
  const variablesFile = resolve(".dev.vars");
  const planningArtifactFile = resolve("public/data/beego-exact-plans.json");

  if (existsSync(variablesFile)) {
    for (const line of readFileSync(variablesFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const separator = trimmed.indexOf("=");
      variables[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    }
  }

  if (existsSync(planningArtifactFile)) {
    variables.PLANNING_ARTIFACT_JSON = readFileSync(planningArtifactFile, "utf8");
  }
  variables.EXACT_PLANNER_URL ||= 'http://127.0.0.1:8787';

  return variables;
};

const parseRequestJson = body => {
  try {
    return body ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    const error = new Error('Некорректный JSON: проверьте запятые, кавычки и скобки');
    error.code = 'INVALID_INPUT';
    error.details = ['Тело запроса должно быть корректным JSON'];
    throw error;
  }
};

const localPlanningApi = () => ({
  name: "beego-local-planning-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith("/api/")) return next();

      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        if (request.url === '/api/replan' && request.method === 'POST') {
          const payload = parseRequestJson(body);
          const plan = await runExactReplan(payload, process.cwd());
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(JSON.stringify(plan));
          return;
        }
        if (request.url === '/api/plan' && request.method === 'POST') {
          const payload = parseRequestJson(body);
          const artifact = JSON.parse(loadLocalVariables().PLANNING_ARTIFACT_JSON || 'null');
          const sealed = isCanonicalPlanningInput(payload, artifact, process.cwd());
          const plan = sealed ? await worker.fetch(new Request('http://127.0.0.1/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }), { ...loadLocalVariables(), EXACT_PLANNER_URL: '' }) : await runExactPlan(payload, process.cwd());
          if (sealed) {
            response.writeHead(plan.status, Object.fromEntries(plan.headers));
            response.end(Buffer.from(await plan.arrayBuffer()));
          } else {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            response.end(JSON.stringify(plan));
          }
          return;
        }
        const webRequest = new Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers: request.headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
          duplex: body ? "half" : undefined,
        });
        const webResponse = await worker.fetch(webRequest, loadLocalVariables());
        response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
        response.end(Buffer.from(await webResponse.arrayBuffer()));
      } catch (error) {
        response.writeHead(error?.code === 'INVALID_INPUT' ? 422 : 500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error?.message || 'Ошибка локального API', code: error?.code || 'PLANNING_FAILED', details: error?.details || [] }));
      }
    });
  },
});

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [localPlanningApi(), react()],
});
