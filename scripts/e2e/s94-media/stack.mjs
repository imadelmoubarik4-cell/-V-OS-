// Local S94 Media stack front door (not part of the app).
//
// One base URL, like a hosted project:
//   /rest/v1/*                         -> PostgREST (Docker)
//   /storage/v1/*                      -> the real Supabase Storage API (Docker, file backend)
//   /auth/v1/*                         -> a small password auth stub issuing HS256 JWTs
//   /functions/v1/atlas-marketing-media     -> supabase/functions/atlas-marketing-media/handler.mjs
//   /functions/v1/atlas-marketing-workspace -> supabase/functions/atlas-marketing-workspace/handler.mjs
//   /functions/v1/<anything else>      -> 404 without CORS headers (an undeployed function)
// It listens on HTTPS (self-signed, for https://<ref>.supabase.co and
// https://<ref>.storage.supabase.co mapped by Chromium) and on plain HTTP (for
// the handlers' own server-to-server calls). A static server serves apps/web
// with config.js pointed at the fake project ref.
//
// Test controls (loopback only): POST /__e2e/function-off?name=, /__e2e/function-on?name=,
// /__e2e/fail-next-put (the next single PUT to Storage is cut off), /__e2e/fail-puts?ms= (every
// single PUT in that window is cut).
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { anonKey, serviceKey, sign, verify } from './jwt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const WEB = path.join(ROOT, 'apps/web');
const env = process.env;
const SECRET = env.E2E_JWT_SECRET;
const REF = env.E2E_REF;
const WORK = env.E2E_WORK;
if (!SECRET || !REF || !WORK) throw new Error('source env.sh first (E2E_JWT_SECRET, E2E_REF, E2E_WORK)');
const PORTS = {
  postgrest: Number(env.E2E_POSTGREST_PORT), storage: Number(env.E2E_STORAGE_PORT),
  http: Number(env.E2E_PROXY_HTTP_PORT), https: Number(env.E2E_PROXY_HTTPS_PORT), app: Number(env.E2E_APP_PORT),
};
const PROJECT = `https://${REF}.supabase.co`;
const STORAGE_HOST = `${REF}.storage.supabase.co`;
const ANON = anonKey(SECRET);
const SERVICE = serviceKey(SECRET);
const PASSWORD = 's94-e2e-password';
const LOG = path.join(WORK, 'stack.log');
const FN_LOG = path.join(WORK, 'functions.log');
writeFileSync(LOG, '');
writeFileSync(FN_LOG, '');

// Access log: method, host, path and status only (never a query string, a header or a body).
const log = (line) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

// Function console output goes to its own file so a test can scan it for secrets.
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    appendFileSync(FN_LOG, `${level} ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}\n`);
    original(...args);
  };
}

// Server-side fetch used by the handlers: the hosted URLs are rewritten to the
// plain-HTTP side of this proxy, keeping the original host for forwarding.
const handlerFetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname === `${REF}.supabase.co` || url.hostname === STORAGE_HOST) {
    const host = url.host;
    url.protocol = 'http:';
    url.host = `127.0.0.1:${PORTS.http}`;
    const headers = new Headers(init.headers || {});
    headers.set('x-e2e-host', host);
    return fetch(url, { ...init, headers });
  }
  return fetch(input, init);
};
const handlerEnv = {
  SUPABASE_URL: PROJECT,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  ATLAS_AUTH_PROJECT_URL: PROJECT,
  ATLAS_AUTH_PUBLISHABLE_KEY: ANON,
};
const getEnv = (name) => handlerEnv[name];
const { createMarketingMediaHandler } = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/atlas-marketing-media/handler.mjs')).href);
const functions = {
  'atlas-marketing-media': createMarketingMediaHandler({ env: getEnv, fetchImpl: handlerFetch, now: () => Date.now() }),
};
try {
  const { createMarketingHandler } = await import(pathToFileURL(path.join(ROOT, 'supabase/functions/atlas-marketing-workspace/handler.mjs')).href);
  functions['atlas-marketing-workspace'] = createMarketingHandler({ env: getEnv, fetchImpl: handlerFetch, now: () => Date.now() });
} catch (error) {
  console.warn('[e2e] marketing workspace handler not loaded', error?.message);
}
const disabled = new Set();
const controls = { failNextPut: 0, failPutsUntil: 0 };

// ---------- auth stub ----------
async function users() {
  const response = await fetch(`http://127.0.0.1:${PORTS.postgrest}/profiles?select=id,email`, { headers: { authorization: `Bearer ${SERVICE}` } });
  return response.ok ? response.json() : [];
}
function session(user) {
  const now = Math.floor(Date.now() / 1000);
  const access = sign({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600, session_id: `s-${user.id}` }, SECRET);
  const refresh = Buffer.from(JSON.stringify({ id: user.id, email: user.email, n: Math.random() })).toString('base64url');
  return {
    access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh,
    user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  };
}
async function auth(req, res, url, body) {
  const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', ...CORS }); res.end(value === undefined ? '' : JSON.stringify(value)); };
  if (req.method === 'OPTIONS') return send(204);
  const route = url.pathname.replace(/^\/auth\/v1/, '');
  if (route === '/token' && req.method === 'POST') {
    const input = JSON.parse(body.toString('utf8') || '{}');
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const user = (await users()).find((entry) => entry.email === String(input.email || '').toLowerCase());
      if (!user || input.password !== PASSWORD) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials' });
      return send(200, session(user));
    }
    if (grant === 'refresh_token') {
      try {
        const parsed = JSON.parse(Buffer.from(String(input.refresh_token), 'base64url').toString('utf8'));
        return send(200, session(parsed));
      } catch { return send(400, { error: 'invalid_grant' }); }
    }
    return send(400, { error: 'unsupported_grant_type' });
  }
  if (route === '/user') {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const claims = verify(token, SECRET);
    if (!claims?.sub) return send(401, { code: 401, msg: 'invalid JWT' });
    return send(200, { id: claims.sub, aud: 'authenticated', role: 'authenticated', email: claims.email, app_metadata: {}, user_metadata: {} });
  }
  if (route === '/logout') return send(204);
  if (route === '/settings') return send(200, { external: { email: true }, disable_signup: true });
  return send(404, { msg: 'not found' });
}

// Kong-like CORS for REST and Auth (the hosted API gateway adds these).
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, accept-profile, content-profile, prefer, range, x-upsert, cache-control, tus-resumable, upload-length, upload-metadata, upload-offset, x-signature',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'access-control-expose-headers': 'content-range, location, upload-offset, upload-length, tus-resumable, tus-version, tus-max-size, tus-extension, upload-expires',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(req, res, port, upstreamPath, host, { cut = false } = {}) {
  const headers = { ...req.headers, host: `127.0.0.1:${port}`, 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'x-forwarded-port': '443' };
  delete headers['x-e2e-host'];
  // The hosted gateway turns an apikey-only request into the anon role; the
  // stack does the same so Storage and PostgREST see what they see in production.
  if (!headers.authorization && headers.apikey) headers.authorization = `Bearer ${headers.apikey}`;
  const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: upstreamPath, headers }, (response) => {
    const out = { ...response.headers };
    if (req.headers.origin) Object.assign(out, CORS, { 'access-control-allow-origin': '*' });
    res.writeHead(response.statusCode, out);
    response.pipe(res);
    response.on('end', () => log(`${req.method} ${host}${upstreamPath.split('?')[0]} -> ${response.statusCode}`));
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  if (cut) {
    // Simulated network drop: send part of the body, then destroy both sides.
    let sent = 0;
    req.on('data', (chunk) => { sent += chunk.length; if (sent < 4096) upstream.write(chunk); else { upstream.destroy(); req.socket.destroy(); } });
    log(`${req.method} ${host}${upstreamPath.split('?')[0]} -> CUT`);
    return;
  }
  req.pipe(upstream);
}

async function handle(req, res) {
  const host = String(req.headers['x-e2e-host'] || req.headers.host || '').replace(/:\d+$/, '');
  const url = new URL(req.url, `https://${host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p.startsWith('/__e2e/')) {
      if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') { res.writeHead(403); return res.end(); }
      if (p === '/__e2e/function-off') disabled.add(url.searchParams.get('name'));
      if (p === '/__e2e/function-on') disabled.delete(url.searchParams.get('name'));
      if (p === '/__e2e/fail-next-put') controls.failNextPut += 1;
      // Every single PUT for the next `ms` is cut (a browser retries a reset PUT once by itself).
      if (p === '/__e2e/fail-puts') controls.failPutsUntil = Date.now() + Number(url.searchParams.get('ms') || 2000);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ disabled: [...disabled], failNextPut: controls.failNextPut }));
    }
    if (p.startsWith('/rest/v1/')) return forward(req, res, PORTS.postgrest, p.slice('/rest/v1'.length) + url.search, host);
    if (p.startsWith('/storage/v1/')) {
      const isPut = req.method === 'PUT' && p.startsWith('/storage/v1/object/upload/sign/');
      const cut = isPut && (controls.failNextPut > 0 || Date.now() < controls.failPutsUntil);
      if (cut && controls.failNextPut > 0) controls.failNextPut -= 1;
      return forward(req, res, PORTS.storage, p.slice('/storage/v1'.length) + url.search, host, { cut });
    }
    if (p.startsWith('/auth/v1/')) {
      const body = await readBody(req);
      await auth(req, res, url, body);
      return log(`${req.method} ${host}${p} -> ${res.statusCode}`);
    }
    if (p.startsWith('/functions/v1/')) {
      const name = p.slice('/functions/v1/'.length).split('/')[0];
      const fn = functions[name];
      if (!fn || disabled.has(name)) {
        // What the hosted gateway does for a function that is not deployed: 404, no CORS headers.
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Requested function was not found' }));
        return log(`${req.method} ${host}${p} -> 404 (not deployed)`);
      }
      const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : await readBody(req);
      const request = new Request(`${PROJECT}${p}${url.search}`, { method: req.method, headers: req.headers, body });
      const response = await fn(request);
      const headers = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      return log(`${req.method} ${host}${p}?action=${url.searchParams.get('action') ?? ''} -> ${response.status}`);
    }
    res.writeHead(404); res.end();
    log(`${req.method} ${host}${p} -> 404`);
  } catch (error) {
    log(`${req.method} ${host}${p} -> 500 ${error?.name}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

// ---------- certificate ----------
const certDir = path.join(WORK, 'cert');
mkdirSync(certDir, { recursive: true });
const keyFile = path.join(certDir, 'key.pem');
const certFile = path.join(certDir, 'cert.pem');
if (!existsSync(certFile)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${REF}.supabase.co`,
    '-addext', `subjectAltName=DNS:${REF}.supabase.co,DNS:${STORAGE_HOST}`, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
}

// ---------- static app with a local config ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.gz': 'application/gzip', '.jpg': 'image/jpeg' };
const app = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = decodeURIComponent(url.pathname);
  if (file === '/') file = '/index.html';
  const target = path.join(WEB, file);
  if (!target.startsWith(WEB) || !existsSync(target)) { res.writeHead(404); return res.end('not found'); }
  let body = readFileSync(target);
  if (file === '/config.js') {
    body = Buffer.from(body.toString('utf8')
      .replaceAll('dnefgcmjcgxlynycxkts', REF)
      // rehearsal-boundary.js pins MODE "production" to the production ref and an
      // sb_publishable_ key; this local copy is neither, so it runs as a local mode.
      .replace(/MODE: "production"/, 'MODE: "local-e2e"')
      .replace(/SUPABASE_ANON_KEY: "[^"]*"/, `SUPABASE_ANON_KEY: "${ANON}"`));
  }
  if (file === '/index.html') {
    // The pinned SRI hash is for the CDN build; the browser run serves the npm build.
    body = Buffer.from(body.toString('utf8').replace(/\s+integrity="[^"]*"/g, '').replace(/script\.integrity = SUPABASE_SRI;/, ''));
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
});

http.createServer(handle).listen(PORTS.http, '127.0.0.1');
https.createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, handle).listen(PORTS.https, '127.0.0.1');
app.listen(PORTS.app, '127.0.0.1');
writeFileSync(path.join(WORK, 'stack.json'), JSON.stringify({ project: PROJECT, anon: ANON, https: PORTS.https, http: PORTS.http, app: `http://localhost:${PORTS.app}`, storageHost: STORAGE_HOST, pid: process.pid }, null, 2));
console.log(`[e2e] stack up: ${PROJECT} -> https :${PORTS.https} / http :${PORTS.http}; app http://localhost:${PORTS.app}`);
