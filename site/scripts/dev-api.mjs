import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../worker/index.js';
import { runExactReplan } from './exact-replan-runner.mjs';
import { runExactPlan } from './exact-plan-runner.mjs';
import { isCanonicalPlanningInput } from './is-canonical-planning-input.mjs';
import { withPlanningSlot } from './planning-slot.mjs';

const variablesFile = resolve('.dev.vars');
const planningArtifactFile = resolve('public/data/beego-exact-plans.json');
const apiPort = Number(process.env.BEEGO_API_PORT || 8787);
const loadVariables = () => {
  const variables = { ...process.env };
  if (existsSync(variablesFile)) {
    for (const line of readFileSync(variablesFile, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const separator = trimmed.indexOf('=');
      variables[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    }
  }
  if (existsSync(planningArtifactFile)) {
    variables.PLANNING_ARTIFACT_JSON = readFileSync(planningArtifactFile, 'utf8');
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

const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    if (request.url === '/api/replan' && request.method === 'POST') {
      const payload = parseRequestJson(body);
      const plan = await withPlanningSlot(() => runExactReplan(payload, process.cwd()));
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(plan));
      return;
    }
    if (request.url === '/api/plan' && request.method === 'POST') {
      const payload = parseRequestJson(body);
      const artifact = JSON.parse(loadVariables().PLANNING_ARTIFACT_JSON || 'null');
      const sealed = isCanonicalPlanningInput(payload, artifact, process.cwd());
      if (!sealed) {
        const plan = await withPlanningSlot(() => runExactPlan(payload, process.cwd()));
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(plan));
        return;
      }
    }
    const webRequest = new Request(`http://127.0.0.1:8787${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
      duplex: body ? 'half' : undefined,
    });
    const webResponse = await worker.fetch(webRequest, { ...loadVariables(), EXACT_PLANNER_URL: '' });
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  } catch (error) {
    response.writeHead(error?.code === 'PLANNING_BUSY' ? 429 : error?.code === 'INVALID_INPUT' ? 422 : 500, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(error?.code === 'PLANNING_BUSY' ? { 'retry-after': '30' } : {}),
    });
    response.end(JSON.stringify({ error: error?.message || 'Ошибка локального API', code: error?.code || 'PLANNING_FAILED', details: error?.details || [] }));
  }
});

server.listen(apiPort, '127.0.0.1', () => {
  console.log(`BeeGo API: http://127.0.0.1:${apiPort}${loadVariables().GEOAPIFY_API_KEY ? ' · Geoapify подключён' : ' · добавьте GEOAPIFY_API_KEY в .dev.vars'}`);
});
