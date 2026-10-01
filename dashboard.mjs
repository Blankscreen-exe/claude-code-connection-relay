// Live traffic stats for the relay, plus a local-only dashboard server.
//
// The relay calls stats.begin()/stats.end() around each request and tapUsage()
// on each upstream response. The dashboard (dashboard.html) subscribes to
// /events and receives a full snapshot whenever something changes.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RECENT_MAX = 100;
const MINUTES_SHOWN = 15;
const EVENTS_MAX = 30;

const cleanIp = ip => (ip ?? '?').replace(/^::ffff:/, '');
const minuteOf = t => Math.floor(t / 60_000);

export function createStats({ getTokenExpiry }) {
  const subscribers = new Set();
  const totals = {
    requests: 0, errors: 0, rejected: 0,
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
    latencySum: 0, latencyCount: 0,
  };
  const recent = [];
  const minutes = new Map(); // minute -> { requests, tokens }
  const clients = new Map(); // ip -> { first, last, requests }
  const events = [];
  const started = Date.now();
  let nextId = 1;
  let pushTimer = null;

  function snapshot() {
    const now = Date.now();
    const cur = minuteOf(now);
    const series = [];
    for (let m = cur - MINUTES_SHOWN + 1; m <= cur; m++) {
      series.push({ t: m * 60_000, ...(minutes.get(m) ?? { requests: 0, tokens: 0 }) });
    }
    let expiresAt = null;
    try { expiresAt = getTokenExpiry(); } catch {}
    return {
      now, started, totals, expiresAt,
      inFlight: recent.filter(r => r.status == null).length,
      recent: recent.slice(0, 60),
      minutes: series,
      clients: [...clients].map(([ip, c]) => ({ ip, ...c })).sort((a, b) => b.last - a.last),
      events,
    };
  }

  function push() {
    pushTimer = null;
    if (!subscribers.size) return;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of subscribers) res.write(msg);
  }

  // Coalesce bursts (streaming token updates) into at most ~4 pushes/sec.
  function changed() {
    pushTimer ??= setTimeout(push, 250);
  }

  function bucket(t) {
    const m = minuteOf(t);
    if (!minutes.has(m)) {
      minutes.set(m, { requests: 0, tokens: 0 });
      for (const k of minutes.keys()) if (k < m - 60) minutes.delete(k);
    }
    return minutes.get(m);
  }

  // Heartbeat so the charts roll forward and the expiry countdown stays fresh.
  setInterval(changed, 5000).unref();

  return {
    subscribers,
    snapshot,
    changed,

    begin(ip, method, url) {
      const rec = {
        id: nextId++, start: Date.now(), ip: cleanIp(ip), method, url: url.split('?')[0],
        model: null, status: null, ms: null, note: null,
        input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
      };
      recent.unshift(rec);
      if (recent.length > RECENT_MAX) recent.pop();
      changed();
      return rec;
    },

    end(rec, status, note) {
      if (rec.ms != null) return; // already ended
      rec.status ??= status;
      if (note) rec.note = note;
      rec.ms = Date.now() - rec.start;

      if (rec.status === 401 && rec.note === 'bad secret') {
        totals.rejected++;
        this.event(`Rejected request from ${rec.ip} (bad relay secret)`, 'warn');
      } else {
        totals.requests++;
        if (rec.status >= 400) totals.errors++;
        totals.latencySum += rec.ms;
        totals.latencyCount++;
        totals.input += rec.input;
        totals.cacheRead += rec.cacheRead;
        totals.cacheWrite += rec.cacheWrite;
        totals.output += rec.output;
        const b = bucket(rec.start);
        b.requests++;
        b.tokens += rec.input + rec.cacheRead + rec.cacheWrite + rec.output;
        const c = clients.get(rec.ip);
        if (!c) this.event(`New client connected: ${rec.ip}`, 'info');
        clients.set(rec.ip, {
          first: c?.first ?? rec.start, last: Date.now(), requests: (c?.requests ?? 0) + 1,
        });
      }
      changed();
    },

    event(text, level = 'info') {
      events.unshift({ t: Date.now(), text, level });
      if (events.length > EVENTS_MAX) events.pop();
      changed();
    },

    uptime: () => Date.now() - started,
  };
}

// Read token usage out of an upstream /v1/messages response without altering it.
// Handles both streaming (SSE) and plain JSON bodies, compressed or not.
// Resolves once the whole body has been parsed (decompression can lag behind
// the response's own 'end').
export function tapUsage(up, rec, stats) {
  if (!rec.url.startsWith('/v1/messages') || rec.url.includes('count_tokens')) {
    return Promise.resolve();
  }
  let done;
  const finished = new Promise(r => (done = r));

  const apply = (u, model) => {
    if (model) rec.model = model;
    if (!u) return;
    if (u.input_tokens != null) rec.input = u.input_tokens;
    if (u.cache_read_input_tokens != null) rec.cacheRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens != null) rec.cacheWrite = u.cache_creation_input_tokens;
    if (u.output_tokens != null) rec.output = u.output_tokens;
    stats.changed();
  };

  const isSse = (up.headers['content-type'] ?? '').includes('text/event-stream');
  let buf = '';
  const onText = text => {
    buf += text;
    if (!isSse) {
      if (buf.length > 4_000_000) buf = ''; // not worth parsing huge bodies
      return;
    }
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'message_start') apply(ev.message?.usage, ev.message?.model);
        else if (ev.type === 'message_delta') apply(ev.usage);
      } catch {}
    }
  };
  const onEnd = () => {
    if (!isSse && buf) {
      try {
        const body = JSON.parse(buf);
        apply(body.usage, body.model);
      } catch {}
    }
    done();
  };

  const enc = up.headers['content-encoding'];
  const dec =
    enc === 'gzip' ? zlib.createGunzip()
    : enc === 'br' ? zlib.createBrotliDecompress()
    : enc === 'deflate' ? zlib.createInflate()
    : null;

  if (dec) {
    dec.setEncoding('utf8');
    dec.on('data', onText);
    dec.on('end', onEnd);
    dec.on('error', done);
    up.on('data', chunk => dec.write(chunk));
    up.on('end', () => dec.end());
  } else {
    up.on('data', chunk => onText(chunk.toString('utf8')));
    up.on('end', onEnd);
  }
  up.on('error', done);
  up.on('aborted', done);
  return finished;
}

const here = path.dirname(fileURLToPath(import.meta.url));

// Serves dashboard.html and the live /events stream. Bound to localhost only,
// so it's never reachable from the laptop or the tailnet.
export function startDashboard(stats, { port, open }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(stats.snapshot())}\n\n`);
      stats.subscribers.add(res);
      req.on('close', () => stats.subscribers.delete(res));
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(here, 'dashboard.html')).pipe(res);
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Dashboard on ${url}`);
    if (open) openAppWindow(url);
  });
}

// Open the dashboard as a small standalone window (no tabs or address bar).
function openAppWindow(url) {
  const flags = [`--app=${url}`, '--window-size=1100,780'];
  let child;
  if (process.platform === 'win32') {
    child = spawn('cmd', ['/c', 'start', '', 'msedge', ...flags], { detached: true, stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    child = spawn('open', ['-na', 'Google Chrome', '--args', ...flags], { detached: true, stdio: 'ignore' });
  } else {
    child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  }
  child.on('error', () => console.log(`Couldn't open a window automatically; open ${url} in a browser.`));
  child.unref();
}
