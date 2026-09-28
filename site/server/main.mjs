import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import worker from '../worker/index.js';
import { createOperationsApi } from './operationsApi.mjs';
import { handleExactPlanning } from './exactPlanningApi.mjs';
import { loadLocalVariables } from './loadLocalVariables.mjs';

loadLocalVariables();
const root = resolve('dist/client');
const artifact = resolve('public/data/beego-exact-plans.json');
const operations = createOperationsApi({ seedFromBase: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const port = Number(process.env.PORT || 8787);

async function send(response, result) {
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const webRequest = new Request(url, { method: request.method, headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : body, duplex: body ? 'half' : undefined });
      const operational = await operations.handle(webRequest);
      if (operational) return send(response, operational);
      const exact = await handleExactPlanning(webRequest);
      if (exact) return send(response, exact);
      const planArtifact = await readFile(artifact, 'utf8').catch(() => null);
      return send(response, await worker.fetch(webRequest, { ...process.env, PLANNING_ARTIFACT_JSON: planArtifact, ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } }));
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const requested = decodeURIComponent(url.pathname);
    const candidate = resolve(root, `.${requested}`);
    if (candidate !== root && !candidate.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
    const info = await stat(candidate).catch(() => null);
    const target = info?.isFile() ? candidate : resolve(root, 'index.html');
    const data = await readFile(target);
    response.writeHead(200, { 'content-type': types[extname(target)] || 'application/octet-stream', 'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error?.message || 'Ошибка сервера' }));
  }
}).listen(port, process.env.BEEGO_HOST || '127.0.0.1', () => {
  process.stdout.write(`BeeGo server: http://127.0.0.1:${port}\n`);
});
