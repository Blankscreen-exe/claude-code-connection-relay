// Claude Code relay: lets a remote Claude Code client use this PC's OAuth login.
//
// The client (laptop) runs Claude Code with
//   ANTHROPIC_BASE_URL=http://<this-pc>:<port>
//   ANTHROPIC_AUTH_TOKEN=<relay secret>
// The relay checks the secret, swaps in this PC's OAuth access token, and
// streams the request/response to and from api.anthropic.com unchanged.
// Tools still run on the laptop, so only the laptop's files are touched.
//
// The OAuth token is refreshed automatically shortly before it expires, and the
// new token is written back to the PC's credentials file so Claude Code there
// keeps working too.
//
// Usage: node relay.mjs [--host 0.0.0.0] [--port 8787]
//        node relay.mjs --refresh-now   (force one token refresh and exit)
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

// OAuth refresh, same endpoint and request shape Claude Code uses.
const TOKEN_URL = process.env.CLAUDE_OAUTH_TOKEN_URL ?? 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Refresh this long before expiry. Kept short so a Claude Code session running on
// this PC (which refreshes earlier) usually wins and the relay just re-reads its result.
const REFRESH_MARGIN_MS = Number(process.env.RELAY_REFRESH_MARGIN_MS ?? 2 * 60 * 1000);

function readCredsFile() {
  const file = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  if (!file.claudeAiOauth?.accessToken) {
    throw new Error(`no claudeAiOauth.accessToken in ${CREDS_PATH}`);
  }
  return file;
}

// Write via temp file + rename so Claude Code never sees a half-written file.
function writeCredsFile(file) {
  const tmp = `${CREDS_PATH}.relay-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  fs.renameSync(tmp, CREDS_PATH);
}

const needsRefresh = creds => creds.expiresAt && Date.now() > creds.expiresAt - REFRESH_MARGIN_MS;

async function refreshCreds({ force = false } = {}) {
  // Re-read first: Claude Code on this PC may have refreshed in the meantime.
  const creds = readCredsFile().claudeAiOauth;
  if (!force && !needsRefresh(creds)) return creds.accessToken;
  if (!creds.refreshToken) throw new Error('token expiring and no refresh token available');

  const body = {
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: CLIENT_ID,
  };
  if (Array.isArray(creds.scopes) && creds.scopes.length) body.scope = creds.scopes.join(' ');

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    // Someone else may have rotated the refresh token while we were waiting.
    const latest = readCredsFile().claudeAiOauth;
    if (latest.accessToken !== creds.accessToken && !needsRefresh(latest)) return latest.accessToken;
    throw new Error(`token refresh failed (${r.status}): ${text.slice(0, 300)}`);
  }

  const data = await r.json();
  const latest = readCredsFile();
  latest.claudeAiOauth = {
    ...latest.claudeAiOauth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    ...(data.refresh_token_expires_in && {
      refreshTokenExpiresAt: Date.now() + data.refresh_token_expires_in * 1000,
    }),
  };
  writeCredsFile(latest);
  console.log(
    `Refreshed OAuth token; valid until ${new Date(latest.claudeAiOauth.expiresAt).toLocaleString()}`,
  );
  return data.access_token;
}

// Only one refresh at a time, even with many concurrent laptop requests.
let refreshing = null;

// Re-read on every request so refreshes done by Claude Code on this PC are picked up.
async function getAccessToken() {
  const creds = readCredsFile().claudeAiOauth;
  if (!needsRefresh(creds)) return creds.accessToken;
  refreshing ??= refreshCreds().finally(() => (refreshing = null));
  return refreshing;
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

const server = http.createServer(async (req, res) => {
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
    token = await getAccessToken();
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

// `node relay.mjs --refresh-now`: force one token refresh and exit (for testing).
// Uses exitCode instead of process.exit(): exiting while fetch's sockets are
// still closing trips a libuv assertion on Windows.
if ('refresh-now' in args) {
  try {
    await refreshCreds({ force: true });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
} else server.listen(PORT, HOST, async () => {
  console.log(`Claude relay listening on http://${HOST}:${PORT}`);
  console.log(`Using credentials from ${CREDS_PATH}`);
  try {
    await getAccessToken();
    const { expiresAt } = readCredsFile().claudeAiOauth;
    console.log(`OAuth token OK; valid until ${new Date(expiresAt).toLocaleString()} (auto-refreshes).`);
  } catch (e) {
    console.warn(`Warning: ${e.message}`);
  }
});
