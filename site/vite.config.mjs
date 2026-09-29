import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import worker from "./worker/index.js";
import { createOperationsApi } from './server/operationsApi.mjs';
import { handleExactPlanning } from './server/exactPlanningApi.mjs';

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

  return variables;
};

const localVariables = loadLocalVariables();
const operations = createOperationsApi({ seedFromBase: true, routingOptions: { geoapifyKey: localVariables.GEOAPIFY_API_KEY }, aiOptions: { apiKey: localVariables.YANDEX_AI_API_KEY, folderId: localVariables.YANDEX_AI_FOLDER_ID } });

const localPlanningApi = () => ({
  name: "beego-local-planning-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith("/api/")) return next();

      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const webRequest = new Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers: request.headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
          duplex: body ? "half" : undefined,
        });
        const webResponse = await operations.handle(webRequest) || await handleExactPlanning(webRequest) || await worker.fetch(webRequest, loadLocalVariables());
        response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
        response.end(Buffer.from(await webResponse.arrayBuffer()));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error?.message || "Ошибка локального API" }));
      }
    });
  },
});

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ['react', 'react-dom/client', 'xlsx'],
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
