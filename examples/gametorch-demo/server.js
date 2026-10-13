// gametorch-demo server: static pages + a small in-memory mock API.
// Node builtins only. Run: node examples/gametorch-demo/server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 4173;
const PUBLIC = path.join(__dirname, 'public');
const IBH_BUNDLE = path.join(__dirname, '..', '..', 'packages', 'ibh', 'dist', 'index.global.js');

/** sprite id -> {id, name, palette, published, svg} */
const sprites = new Map();
let nextSpriteId = 1;
/** sid -> {name, credits} */
const sessions = new Map();

const WHIMSICAL_NAMES = [
  'Pixel Pixie',
  'Sir Quackington',
  'Doctor Doodle',
  'Baron Von Bounce',
  'Marmalade Moon',
  'Turbo Turtle',
  'Captain Whiskers',
  'Waffle Wizard',
  'Disco Duck',
  'Professor Puff',
  'Bleep Bloop',
  'Moss Goblin',
  'Luna Lovelace',
  'Sprout Skywalker',
  'Giggles McGee',
  'Fuzzy Dunlop',
  'Nimbus Noodle',
  'Chaos Carp',
  'Duchess Fluffington',
  'Zippy Zebra',
];

/** No sign-in page: visiting the app auto-creates a session as a random whimsical user. */
function ensureSession(req, res) {
  const existing = userOf(req);
  if (existing) return existing;
  const sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const name = WHIMSICAL_NAMES[Math.floor(Math.random() * WHIMSICAL_NAMES.length)];
  const user = { name, credits: 42 };
  sessions.set(sid, user);
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return user;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => {
      resolve(data);
    });
  });
}

function sidOf(req) {
  const cookie = req.headers.cookie ?? '';
  const m = /(?:^|;\s*)sid=([A-Za-z0-9-]+)/u.exec(cookie);
  return m ? m[1] : null;
}

function userOf(req) {
  const sid = sidOf(req);
  return sid ? sessions.get(sid) ?? null : null;
}

function randomPalette() {
  const base = Math.floor(Math.random() * 360);
  const palette = [];
  for (let i = 0; i < 5; i++) {
    palette.push(`hsl(${(base + i * 28) % 360} ${60 + Math.random() * 30}% ${45 + i * 8}%)`);
  }
  return palette;
}

// Colors are interpolated into SVG markup and rendered on the client, so only
// strict, inert color strings may pass — anything else is rejected (stored-XSS guard).
const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|hsl\([0-9.]+ [0-9.]+% [0-9.]+%\))$/u;

function isSafePalette(palette) {
  return (
    Array.isArray(palette) &&
    palette.length > 0 &&
    palette.length <= 12 &&
    palette.every((c) => typeof c === 'string' && SAFE_COLOR.test(c) && c.length <= 64)
  );
}

function makeSvg(palette) {
  let blobs = '';
  for (let i = 0; i < 7; i++) {
    const c = palette[i % palette.length];
    blobs += `<circle cx="${10 + Math.random() * 76}" cy="${10 + Math.random() * 76}" r="${6 + Math.random() * 18}" fill="${c}" opacity="0.85"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="12" fill="#14151a"/>${blobs}</svg>`;
}

async function api(req, res, url) {
  const user = userOf(req);

  if (url.pathname === '/api/me' && req.method === 'GET') {
    if (!user) return json(res, 401, { error: 'not signed in' });
    return json(res, 200, { user });
  }

  if (!user) return json(res, 401, { error: 'not signed in' });

  if (url.pathname === '/api/events' && req.method === 'GET') {
    return sse(req, res);
  }

  const spriteMatch = /^\/api\/sprites\/(\d+)(\/generate)?$/u.exec(url.pathname);

  if (url.pathname === '/api/sprites' && req.method === 'GET') {
    return json(res, 200, { sprites: [...sprites.values()].toSorted((a, b) => b.id - a.id) });
  }

  if (url.pathname === '/api/sprites' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 40) {
      return json(res, 400, { error: 'name is required (max 40 chars)' });
    }
    if (body.palette !== undefined && !isSafePalette(body.palette)) {
      return json(res, 400, { error: 'palette must be an array of 1-12 CSS colors (hex or hsl)' });
    }
    const sprite = {
      id: nextSpriteId++,
      name: body.name.trim(),
      palette: body.palette ?? randomPalette(),
      published: false,
      svg: null,
    };
    sprites.set(sprite.id, sprite);
    broadcast('sprites', { kind: 'created', id: sprite.id });
    return json(res, 201, { sprite });
  }

  if (spriteMatch) {
    const id = Number(spriteMatch[1]);
    const sprite = sprites.get(id);
    if (!sprite) return json(res, 404, { error: `sprite ${id} not found` });

    if (req.method === 'GET' && !spriteMatch[2]) return json(res, 200, { sprite });

    if (req.method === 'POST' && spriteMatch[2]) {
      // pretend generation is expensive
      await new Promise((resolve) => {
        setTimeout(resolve, 700);
      });
      sprite.svg = makeSvg(sprite.palette);
      broadcast('sprites', { kind: 'updated', id: sprite.id });
      return json(res, 200, { sprite, note: 'generated' });
    }

    if (req.method === 'PATCH') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 40) {
          return json(res, 400, { error: 'name must be a non-empty string (max 40 chars)' });
        }
        sprite.name = body.name.trim();
      }
      if (body.palette !== undefined) {
        if (!isSafePalette(body.palette)) {
          return json(res, 400, { error: 'palette must be an array of 1-12 CSS colors (hex or hsl)' });
        }
        sprite.palette = body.palette;
      }
      if (body.published !== undefined) {
        if (typeof body.published !== 'boolean') {
          return json(res, 400, { error: 'published must be a boolean' });
        }
        sprite.published = body.published;
      }
      broadcast('sprites', { kind: 'updated', id: sprite.id });
      return json(res, 200, { sprite });
    }

    if (req.method === 'DELETE') {
      sprites.delete(id);
      broadcast('sprites', { kind: 'deleted', id });
      return json(res, 200, { deleted: id });
    }
  }

  return json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
}

// ---------------------------------------------------------------------------
// Server-Sent Events: the UI reacts to every mutation (the user's OR ibh's)
// through the same channel, because ibh goes through the same API.
// ---------------------------------------------------------------------------
const sseClients = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      /* closed */
    }
  }, 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

function serveFile(res, filePath, status = 200) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(status, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

function staticFile(req, res, url) {
  if (url.pathname === '/ibh.js') return serveFile(res, IBH_BUNDLE);
  // The app is a single-page app: "/" (dashboard) and "/sprites/:id" (editor)
  // are all served by index.html; the client router renders the right view.
  // Visiting without a session silently signs you in as a random whimsical user.
  const editorMatch = /^\/sprites\/(\d+)\/?$/u.exec(url.pathname);
  if (url.pathname === '/' || url.pathname === '/index.html' || editorMatch) {
    ensureSession(req, res);
    return serveFile(res, path.join(PUBLIC, 'index.html'));
  }
  const safe = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/u, '');
  serveFile(res, path.join(PUBLIC, safe));
}

// When IBH_PROXY_URL is set, the demo server fronts the LLM proxy under test:
// the browser talks same-origin to /api/ibh-llm/* (cookies included) and this
// server forwards — exactly how production app servers front an LLM proxy.
const PROXY_URL = process.env.IBH_PROXY_URL; // e.g. http://127.0.0.1:4180/api/v1

async function forwardToProxy(req, res, url) {
  const suffix = url.pathname.endsWith('/chat/completions')
    ? '/chat/completions'
    : '/audio/transcriptions';
  const body = await readBody(req);
  const upstream = await fetch(`${PROXY_URL}${suffix}`, {
    method: 'POST',
    headers: {
      'content-type': req.headers['content-type'] || 'application/json',
      cookie: req.headers.cookie || '',
    },
    body,
  });
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (PROXY_URL && req.method === 'POST' && url.pathname.startsWith('/api/ibh-llm/')) {
        return await forwardToProxy(req, res, url);
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return staticFile(req, res, url);
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  })
  .listen(PORT, () => {
    console.log(`gametorch demo: http://localhost:${PORT}`);
  });
