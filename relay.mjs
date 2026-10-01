// Claude Code relay: lets a remote Claude Code client use this PC's OAuth login.
//
// The client (laptop) runs Claude Code with
//   ANTHROPIC_BASE_URL=http://<this-pc>:<port>
//   ANTHROPIC_AUTH_TOKEN=<relay secret>
// The relay checks the secret, swaps in this PC's OAuth access token, and
// streams the request/response to and from api.anthropic.com unchanged.
// Tools still run on the laptop, so only the laptop's files are touched.
//
// Usage: node relay.mjs [--host 0.0.0.0] [--port 8787]
// Zero dependencies (Node 18+).

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);

const HOST = args.host ?? process.env.RELAY_HOST ?? '0.0.0.0';
const PORT = Number(args.port ?? process.env.RELAY_PORT ?? 8787);
const UPSTREAM = 'api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';
const CREDS_PATH =
  process.env.CLAUDE_CREDENTIALS ?? path.join(os.homedir(), '.claude', '.credentials.json');

const here = path.dirname(fileURLToPath(import.meta.url));
const SECRET_PATH = path.join(here, 'relay.secret');

function loadSecret() {
  if (process.env.RELAY_SECRET) return process.env.RELAY_SECRET;
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, s + '\n', { mode: 0o600 });
  console.log(`Generated new relay secret in ${SECRET_PATH}`);
  return s;
}

const SECRET = loadSecret();

// Re-read on every request so refreshes done by Claude Code on this PC are picked up.
function readAccessToken() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')).claudeAiOauth;
  if (!creds?.accessToken) throw new Error(`no claudeAiOauth.accessToken in ${CREDS_PATH}`);
  if (creds.expiresAt && Date.now() > creds.expiresAt) {
    throw new Error(
      `OAuth token expired at ${new Date(creds.expiresAt).toLocaleString()}; ` +
        'run `claude` on the relay PC to refresh it',
    );
  }
  return creds.accessToken;
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function sendError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'relay_error', message } }));
}

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'upgrade', 'te', 'trailer', 'authorization', 'x-api-key',
]);

const server = http.createServer((req, res) => {
  const started = Date.now();
  const who = req.socket.remoteAddress;

  // Claude Code's unauthenticated connectivity check.
  if (req.url === '/api/hello') {
    res.writeHead(200);
    return res.end();
  }

  const presented =
    req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? req.headers['x-api-key'] ?? '';
  if (!safeEqual(presented, SECRET)) {
    console.warn(`[${who}] rejected ${req.method} ${req.url}: bad relay secret`);
    return sendError(res, 401, 'invalid relay secret');
  }

  if (!req.url.startsWith('/v1/')) return sendError(res, 404, `relay only forwards /v1/*`);

  let token;
  try {
    token = readAccessToken();
  } catch (e) {
    console.error(`[${who}] ${e.message}`);
    return sendError(res, 503, e.message);
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k)) headers[k] = v;
  }
  headers.host = UPSTREAM;
  headers.authorization = `Bearer ${token}`;
  const betas = (headers['anthropic-beta'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
  headers['anthropic-beta'] = betas.join(',');

  const upstream = https.request(
    { host: UPSTREAM, port: 443, method: req.method, path: req.url, headers },
    up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
      up.on('end', () =>
        console.log(`[${who}] ${req.method} ${req.url} -> ${up.statusCode} (${Date.now() - started}ms)`),
      );
    },
  );
  upstream.on('error', e => {
    console.error(`[${who}] upstream error: ${e.message}`);
    if (!res.headersSent) sendError(res, 502, `upstream error: ${e.message}`);
    else res.destroy(e);
  });
  // Abort upstream if the laptop disconnects (e.g. user hits Esc mid-stream).
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});

server.listen(PORT, HOST, () => {
  console.log(`Claude relay listening on http://${HOST}:${PORT}`);
  console.log(`Using credentials from ${CREDS_PATH}`);
  try {
    readAccessToken();
    console.log('OAuth token found and not expired.');
  } catch (e) {
    console.warn(`Warning: ${e.message}`);
  }
});
