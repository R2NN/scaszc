import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../worker/index.js';

const variablesFile = resolve('.dev.vars');
const planningArtifactFile = resolve('public/data/beego-exact-plans.json');
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
  return variables;
};

const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const webRequest = new Request(`http://127.0.0.1:8787${request.url}`, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
      duplex: body ? 'half' : undefined,
    });
    const webResponse = await worker.fetch(webRequest, loadVariables());
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error?.message || 'Ошибка локального API' }));
  }
});

server.listen(8787, '127.0.0.1', () => {
  console.log(`BeeGo API: http://127.0.0.1:8787${loadVariables().GEOAPIFY_API_KEY ? ' · Geoapify подключён' : ' · добавьте GEOAPIFY_API_KEY в .dev.vars'}`);
});
