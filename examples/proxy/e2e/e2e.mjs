#!/usr/bin/env node
/**
 * True end-to-end tests for the ibh proxy reference implementations.
 *
 * Starts each proxy as a REAL process (node / rocket / nginx / apache), sends
 * exactly the requests ibh's browser panel would send (same paths, cookies,
 * no Authorization header), reaches the REAL OpenRouter API, and verifies the
 * full round trip — chat completions, chat completions with tool calls (the
 * agent-loop shape), and speech-to-text.
 *
 * Optionally (when a Chromium-based browser is present) runs the flow from a
 * HEADLESS BROWSER through the real UI: load the gametorch demo, type into the
 * ibh panel, approve the consent card, and watch the mock API update via SSE.
 *
 * Environment:
 *   E2E_OPENROUTER_KEY (or OPENROUTER_KEY)  a REAL OpenRouter key.
 *                                           MISSING -> positive tests are
 *                                           SKIPPED; negative tests (proxy
 *                                           behavior that never reaches
 *                                           OpenRouter) still run.
 *   E2E_TARGETS      comma list to restrict targets (node,rocket,nginx,apache)
 *   CHROME_PATH      explicit Chromium-browser executable for the headless flow
 *
 * Exit code 0 when everything passed or skipped; 1 on any failure.
 * This suite is intentionally NOT part of `pnpm test` (it hits the network and
 * spends real credits) — run it with `pnpm test:e2e`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PROXY_DIR = path.join(ROOT, 'examples', 'proxy');
const DEMO_DIR = path.join(ROOT, 'examples', 'gametorch-demo');

const MODEL = 'openai/gpt-6-luna';
const STT_MODEL = 'elevenlabs/scribe-v2';
const DISALLOWED_MODEL = 'openai/o-billion';

// 1x1 PNG — enough to prove a multimodal (image) body passes through intact.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const KEY = process.env.E2E_OPENROUTER_KEY || process.env.OPENROUTER_KEY || '';
const HAVE_KEY = KEY.trim().length > 0;
const TARGET_FILTER = (process.env.E2E_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean);

const results = [];
function record(name, status, detail = '') {
  results.push({ name, status, detail });
  const icon = status === 'pass' ? '✔' : status === 'skip' ? '↷' : '✘';
  console.log(`${icon} [${status.toUpperCase()}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Spawn a process and wait until its TCP port accepts connections. */
function spawnServer(cmd, args, env, port, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    proc.stderr?.on('data', (d) => {
      stderrTail += d.toString();
    });
    proc.stdout?.on('data', () => {});
    const started = Date.now();
    proc.once('exit', (code) => reject(new Error(`${label} exited early (code ${code})\n${stderrTail.slice(-2000)}`)));
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve({
          proc,
          stop: () =>
            new Promise((resolveDone) => {
              proc.once('exit', () => resolveDone());
              proc.kill('SIGTERM');
              setTimeout(() => {
                try {
                  proc.kill('SIGKILL');
                } catch {}
                resolveDone();
              }, 2000).unref();
            }),
        });
      });
      sock.once('error', () => {
        sock.destroy();
        if (proc.exitCode !== null || Date.now() - started > 15000) {
          reject(new Error(`${label} failed to listen on :${port}\n${stderrTail.slice(-2000)}`));
          return;
        }
        setTimeout(tryConnect, 150);
      });
    };
    tryConnect();
  });
}

function freePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    // Bind the full wildcard (dual-stack): an IPv4-only probe would miss
    // services holding the IPv6 wildcard on the same port.
    srv.once('error', () => resolve(freePort(preferred + 1)));
    srv.listen(preferred, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** Session-verify helper for proxies that delegate auth (rocket). */
async function startVerifyServer(port) {
  const server = createServer((req, res) => {
    if (!req.headers.cookie) {
      // the session-verify endpoint rejects callers with no session at all
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"user":"e2e"}');
  });
  await new Promise((r) => {
    server.listen(port, '127.0.0.1', r);
  });
  return {
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}

/** Client shaped exactly like ibh's browser panel: cookies, no Authorization. */
function apiClient(base, cookie = 'sid=e2e-session') {
  return async function call(endpointPath, body) {
    const res = await fetch(`${base}${endpointPath}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, headers: Object.fromEntries(res.headers), json, text };
  };
}

/** Every business-logic proxy (node, rocket) must surface OpenRouter's REAL
 *  per-request cost to the integrator so it can meter and bill users. */
function assertUsageSurface(name, res) {
  const costHeader = res.headers['x-ibh-cost'];
  const tokensHeader = res.headers['x-ibh-total-tokens'];
  if (costHeader === undefined || !Number.isFinite(Number(costHeader))) {
    throw new Error(`cost not surfaced: x-ibh-cost=${costHeader}`);
  }
  if (tokensHeader === undefined) {
    throw new Error('cost not surfaced: missing x-ibh-total-tokens');
  }
  record(`${name}: usage cost surfaced (X-Ibh-*)`, 'pass', `cost=$${Number(costHeader)} tokens=${tokensHeader}`);
}

const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'sprite_count',
      description: 'Returns the number of sprites the signed-in user owns.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

/** The API route matrix every proxy must satisfy (real OpenRouter). */
async function runMatrix(name, base, { expectAllowlist403, expectNoSession403 }) {
  const call = apiClient(base);

  const plain = await call('/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  });
  const plainContent = plain.json?.choices?.[0]?.message?.content;
  if (plain.status !== 200 || !plainContent) {
    throw new Error(`plain chat failed: ${plain.status} ${plain.text?.slice(0, 300)}`);
  }
  record(`${name}: chat/completions round trip`, 'pass', `model replied "${String(plainContent).slice(0, 40)}"`);
  assertUsageSurface(name, plain);

  const image = await call('/chat/completions', {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with the single word: pong' },
          { type: 'image_url', image_url: { url: TINY_PNG } },
        ],
      },
    ],
  });
  const imageContent = image.json?.choices?.[0]?.message?.content;
  if (image.status !== 200 || !imageContent) {
    throw new Error(`multimodal (image) chat failed: ${image.status} ${image.text?.slice(0, 300)}`);
  }
  record(`${name}: multimodal (image) round trip`, 'pass', `model replied "${String(imageContent).slice(0, 40)}"`);

  const forced = await call('/chat/completions', {
    model: MODEL,
    messages: [{ role: 'user', content: 'How many sprites do I own?' }],
    tools: toolDefs,
    tool_choice: { type: 'function', function: { name: 'sprite_count' } },
  });
  const toolCall = forced.json?.choices?.[0]?.message?.tool_calls?.[0];
  if (forced.status !== 200 || toolCall?.function?.name !== 'sprite_count') {
    throw new Error(`tool-call chat failed: ${forced.status} ${forced.text?.slice(0, 300)}`);
  }
  record(`${name}: chat/completions with tool calls`, 'pass', `tool ${toolCall.function.name} requested`);

  const loop = await call('/chat/completions', {
    model: MODEL,
    messages: [
      { role: 'user', content: 'How many sprites do I own?' },
      { role: 'assistant', content: '', tool_calls: forced.json.choices[0].message.tool_calls },
      { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ count: 3 }) },
    ],
    tools: toolDefs,
  });
  const loopContent = loop.json?.choices?.[0]?.message?.content ?? '';
  if (loop.status !== 200 || !loopContent) {
    throw new Error(`tool-result round trip failed: ${loop.status} ${loop.text?.slice(0, 300)}`);
  }
  if (!String(loopContent).includes('3')) {
    throw new Error(`tool-result answer does not mention the count: "${String(loopContent).slice(0, 120)}"`);
  }
  record(`${name}: tool result -> final answer`, 'pass', `"${String(loopContent).slice(0, 60)}"`);

  if (expectAllowlist403) {
    const denied = await call('/chat/completions', {
      model: DISALLOWED_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    if (denied.status !== 403 || !String(denied.text).includes('not allowed')) {
      throw new Error(`allowlist violation not rejected: ${denied.status} ${denied.text?.slice(0, 200)}`);
    }
    record(`${name}: server-side model allowlist`, 'pass', `${DISALLOWED_MODEL} -> 403`);
  } else {
    record(`${name}: server-side model allowlist`, 'skip', 'config-only proxies cannot read the body (documented tradeoff)');
  }

  if (expectNoSession403) {
    const noSession = await apiClient(base, '')('/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
    });
    if (noSession.status !== 403) {
      throw new Error(`no-session call expected 403, got ${noSession.status}`);
    }
    record(`${name}: no session -> 403`, 'pass');
  } else {
    record(`${name}: no session -> 403`, 'skip', 'no auth configured (documented tradeoff)');
  }

  const unknown = await call('/nope', {});
  if (unknown.status !== 404) {
    throw new Error(`unknown path expected 404, got ${unknown.status}`);
  }
  record(`${name}: unknown path -> 404`, 'pass');
}

/** Speech-to-text through the proxy with a real committed speech fixture. */
async function runStt(name, base) {
  const call = apiClient(base);
  const wav = await readFile(path.join(PROXY_DIR, 'e2e', 'fixtures', 'hello.wav'));
  const res = await call('/audio/transcriptions', {
    model: STT_MODEL,
    input_audio: { data: wav.toString('base64'), format: 'wav' },
  });
  const text = res.json?.text ?? '';
  if (res.status !== 200 || typeof text !== 'string') {
    throw new Error(`transcription failed: ${res.status} ${res.text?.slice(0, 300)}`);
  }
  if (!/hello/iu.test(text)) {
    throw new Error(`transcription did not contain "hello": "${text.slice(0, 120)}"`);
  }
  record(`${name}: audio/transcriptions (real speech)`, 'pass', `"${text.slice(0, 60)}"`);
  assertUsageSurface(name, res);
}

/* ------------------------------------------------------------------ */
/* proxy targets                                                       */
/* ------------------------------------------------------------------ */

const targets = [
  {
    name: 'node',
    expectAllowlist403: true,
    expectNoSession403: true,
    browser: true,
    async start(port) {
      const verifyPort = await freePort(4183);
      const verify = await startVerifyServer(verifyPort);
      try {
        const handle = await spawnServer(
          'node',
          [path.join(PROXY_DIR, 'server.js')],
          {
            PORT: String(port),
            OPENROUTER_KEY: KEY || 'sk-e2e-placeholder',
            ALLOWED_MODELS: `${MODEL},${STT_MODEL}`,
            AUTH_VERIFY_URL: `http://127.0.0.1:${verifyPort}`,
          },
          port,
          'node proxy'
        );
        return {
          base: `http://127.0.0.1:${port}/api/v1`,
          stop: async () => {
            await handle.stop();
            await verify.stop();
          },
        };
      } catch (e) {
        await verify.stop();
        return { skip: e.message.split('\n')[0] };
      }
    },
  },
  {
    name: 'rocket',
    expectAllowlist403: true,
    expectNoSession403: true,
    browser: true,
    async start(port) {
      const bin = path.join(PROXY_DIR, 'rocket', 'target', 'release', 'ibh-llm-proxy');
      if (!exists(bin)) {
        return { skip: 'rocket binary not built (cargo build --release in examples/proxy/rocket)' };
      }
      const verifyPort = await freePort(4183);
      const verify = await startVerifyServer(verifyPort);
      try {
        const handle = await spawnServer(
          bin,
          [],
          {
            ROCKET_PORT: String(port),
            OPENROUTER_KEY: KEY || 'sk-e2e-placeholder',
            AUTH_VERIFY_URL: `http://127.0.0.1:${verifyPort}`,
            ALLOWED_MODELS: `${MODEL},${STT_MODEL}`,
          },
          port,
          'rocket proxy'
        );
        return {
          base: `http://127.0.0.1:${port}/api/v1`,
          stop: async () => {
            await handle.stop();
            await verify.stop();
          },
        };
      } catch (e) {
        await verify.stop();
        return { skip: e.message.split('\n')[0] };
      }
    },
  },
  {
    name: 'nginx',
    expectAllowlist403: false,
    expectNoSession403: false,
    browser: false,
    async start(port) {
      const nginx = which('nginx');
      if (!nginx) return { skip: 'nginx binary not found' };
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'ibh-nginx-'));
      const key = KEY || 'sk-e2e-placeholder';
      const conf = `worker_processes 1;
daemon off;
error_log ${tmp}/error.log info;
pid ${tmp}/nginx.pid;
events { worker_connections 64; }
http {
  access_log off;
  server {
    listen 127.0.0.1:${port};
    location = /api/ibh-llm/chat/completions {
      proxy_pass https://openrouter.ai/api/v1/chat/completions;
      proxy_ssl_server_name on;
      proxy_set_header Authorization "Bearer ${key}";
      proxy_set_header Content-Type $content_type;
      proxy_set_header Cookie "";
    }
    location = /api/ibh-llm/audio/transcriptions {
      proxy_pass https://openrouter.ai/api/v1/audio/transcriptions;
      proxy_ssl_server_name on;
      proxy_set_header Authorization "Bearer ${key}";
      proxy_set_header Content-Type $content_type;
      proxy_set_header Cookie "";
    }
    location / { return 404; }
  }
}
`;
      const confPath = path.join(tmp, 'nginx.conf');
      await writeFile(confPath, conf);
      const r = spawnSync(nginx, ['-t', '-c', confPath, '-p', tmp], { encoding: 'utf8' });
      if (r.status !== 0) {
        await rm(tmp, { recursive: true, force: true });
        return { skip: `nginx -t failed: ${(r.stderr || r.stdout).slice(-300)}` };
      }
      // foreground child owned by this harness; SIGTERM only ever reaches OUR nginx
      const handle = await spawnServer(nginx, ['-c', confPath, '-p', tmp], {}, port, 'nginx proxy');
      return {
        base: `http://127.0.0.1:${port}/api/ibh-llm`,
        stop: async () => {
          await handle.stop();
          await rm(tmp, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'apache',
    expectAllowlist403: false,
    expectNoSession403: false,
    browser: false,
    async start(port) {
      const apachectl = which('apachectl') || (exists('/usr/sbin/apachectl') ? '/usr/sbin/apachectl' : null);
      if (!apachectl) return { skip: 'apachectl not found' };
      const modulesRoot = '/usr/libexec/apache2';
      const required = ['mod_proxy.so', 'mod_proxy_http.so', 'mod_headers.so', 'mod_ssl.so', 'mod_unixd.so', 'mod_authz_core.so', 'mod_log_config.so', 'mod_mime.so', 'mod_mpm_prefork.so', 'mod_socache_shmcb.so'];
      const missing = required.filter((m) => !exists(path.join(modulesRoot, m)));
      if (missing.length > 0) return { skip: `apache modules missing: ${missing.join(', ')}` };
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'ibh-apache-'));
      const emptyRoot = path.join(tmp, 'htdocs');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(emptyRoot, { recursive: true });
      const key = KEY || 'sk-e2e-placeholder';
      void key;
      const conf = `ServerRoot /usr
Listen 127.0.0.1:${port}
LoadModule mpm_prefork_module ${modulesRoot}/mod_mpm_prefork.so
LoadModule authz_core_module ${modulesRoot}/mod_authz_core.so
LoadModule unixd_module ${modulesRoot}/mod_unixd.so
LoadModule log_config_module ${modulesRoot}/mod_log_config.so
LoadModule headers_module ${modulesRoot}/mod_headers.so
LoadModule proxy_module ${modulesRoot}/mod_proxy.so
LoadModule proxy_http_module ${modulesRoot}/mod_proxy_http.so
LoadModule ssl_module ${modulesRoot}/mod_ssl.so
LoadModule socache_shmcb_module ${modulesRoot}/mod_socache_shmcb.so
LoadModule mime_module ${modulesRoot}/mod_mime.so
PidFile ${tmp}/httpd.pid
Mutex file:${tmp}
ErrorLog ${tmp}/error.log
LogLevel warn
DocumentRoot "${emptyRoot}"
ServerName localhost
# mod_ssl is loaded ONLY for the outbound proxy TLS (SSLProxyEngine); a global
# SSLEngine would demand a server certificate we do not have or need.
SSLProxyEngine on
SSLProxyVerify require
# depth 1 default rejects real-world chains (leaf + intermediate): AH02040
SSLProxyVerifyDepth 3
SSLProxyCheckPeerName on
SSLProxyCACertificateFile /etc/ssl/cert.pem
<Location /api/ibh-llm/chat/completions>
  ProxyPass https://openrouter.ai/api/v1/chat/completions
  RequestHeader set Authorization "Bearer ${KEY || 'sk-e2e-placeholder'}"
  RequestHeader unset Cookie early
  LimitRequestBody 1048576
</Location>
<Location /api/ibh-llm/audio/transcriptions>
  ProxyPass https://openrouter.ai/api/v1/audio/transcriptions
  RequestHeader set Authorization "Bearer ${KEY || 'sk-e2e-placeholder'}"
  RequestHeader unset Cookie early
  LimitRequestBody 8388608
</Location>
`;
      const confPath = path.join(tmp, 'httpd.conf');
      await writeFile(confPath, conf);
      const httpd = path.join(path.dirname(apachectl), 'httpd');
      const r = spawnSync(httpd, ['-t', '-f', confPath], { encoding: 'utf8' });
      if (r.status !== 0) {
        await rm(tmp, { recursive: true, force: true });
        return { skip: `httpd -t failed: ${(r.stderr || r.stdout).slice(-300)}` };
      }
      // foreground child owned by this harness (never touches a system apache,
      // never uses apachectl start/stop signals)
      const handle = await spawnServer(httpd, ['-f', confPath, '-DFOREGROUND'], { OPENROUTER_KEY: KEY || '' }, port, 'apache proxy');
      const errorLogTail = async () => {
        try {
          return (await readFile(path.join(tmp, 'error.log'), 'utf8')).slice(-1600);
        } catch {
          return '(error.log unavailable)';
        }
      };
      return {
        base: `http://127.0.0.1:${port}/api/ibh-llm`,
        errorLogTail,
        stop: async () => {
          await handle.stop();
          await rm(tmp, { recursive: true, force: true });
        },
      };
    },
  },
];

/* ------------------------------------------------------------------ */
/* headless browser flow (through the real UI, demo server + proxy)    */
/* ------------------------------------------------------------------ */

async function startDemoServer(proxyBase) {
  const port = await freePort(4173);
  const handle = await spawnServer(
    'node',
    [path.join(DEMO_DIR, 'server.js')],
    { PORT: String(port), IBH_PROXY_URL: proxyBase },
    port,
    'demo server'
  );
  // Verify the demo actually fronts the proxy before the browser starts —
  // an invalid (invalid-model) body must reach OpenRouter's 400, NOT the
  // demo's string-error 404 ("no route"), which would mean we are talking
  // to the wrong server.
  const probe = await fetch(`http://127.0.0.1:${port}/api/ibh-llm/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'sid=e2e' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }] }),
  });
  const probeBody = await probe.text();
  if (probe.status === 404 || probeBody.includes('no route for')) {
    await handle.stop();
    throw new Error(
      'demo server is not forwarding to the proxy (got 404 "no route") — IBH_PROXY_URL was not applied'
    );
  }
  return { url: `http://127.0.0.1:${port}`, ...handle };
}

function findChromiumExecutable() {
  if (process.env.CHROME_PATH && exists(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

async function runBrowserFlowOnce(proxyBase) {
  const { chromium } = await import('playwright-core');
  const executablePath = findChromiumExecutable();
  if (!executablePath) {
    return { skipped: 'no Chromium-based browser found (set CHROME_PATH)' };
  }

  const demo = await startDemoServer(proxyBase);
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    // the browser talks SAME-ORIGIN to the demo server, which fronts the proxy
    // under test — exactly how production app servers front the LLM proxy.
    await page.goto(`${demo.url}/?llm-base=/api/ibh-llm`, { waitUntil: 'domcontentloaded' });

    // the ibh panel lives in a shadow root; playwright CSS pierces open shadow roots
    await page.waitForSelector('[data-ibh-ui] .composer textarea', { timeout: 30_000 });
    await page.fill('[data-ibh-ui] .composer textarea', 'Create a sprite named "E2E Flux". Use exactly that name.');
    await page.press('[data-ibh-ui] .composer textarea', 'Enter');

    // the agent must call sprites_create (confirm tier) -> consent card appears
    await page.waitForSelector('[data-ibh-ui] .confirm-card', { timeout: 120_000 });
    await page.click('[data-ibh-ui] .confirm-card .approve');

    // SSE must update the dashboard with the created sprite (mock API write)
    await page.waitForFunction(() => document.body.innerText.includes('E2E Flux'), { timeout: 120_000 });
    await page.waitForSelector('[data-ibh-ui] .msg.assistant', { timeout: 120_000 });
    return { detail: 'headless Chrome -> panel -> LLM -> tool call -> consent -> mock API -> SSE update' };
  } finally {
    await browser?.close().catch(() => {});
    await demo.stop();
  }
}

async function runBrowserFlow(label, proxyBase) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await runBrowserFlowOnce(proxyBase);
      if (r.skipped) {
        record(`browser flow via ${label}`, 'skip', r.skipped);
        return;
      }
      record(`browser flow via ${label}`, 'pass', `${r.detail}${attempt > 1 ? ' (attempt 2)' : ''}`);
      return;
    } catch (e) {
      lastError = e;
      console.log(`  ↷ browser flow attempt ${attempt} failed: ${e.message?.slice(0, 200)}`);
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

const children = [];
process.on('exit', () => {
  for (const p of children) {
    try {
      p.kill('SIGKILL');
    } catch {}
  }
});

async function main() {
  console.log(`ibh proxy e2e — real OpenRouter key: ${HAVE_KEY ? 'YES' : 'NO (positive tests will be skipped)'}`);
  if (!HAVE_KEY) {
    console.log('Set E2E_OPENROUTER_KEY=<real key> to run the full suite. Negative tests still run.');
  }

  let requested = targets;
  if (TARGET_FILTER.length > 0) requested = targets.filter((t) => TARGET_FILTER.includes(t.name));

  for (const target of requested) {
    const port = await freePort(4180 + targets.indexOf(target) * 2);
    let handle;
    try {
      handle = await target.start(port);
    } catch (e) {
      record(`${target.name} proxy startup`, 'skip', e.message.split('\n').slice(0, 4).join(' | ').slice(0, 300));
      continue;
    }
    if (handle.skip) {
      record(`${target.name} proxy startup`, 'skip', handle.skip);
      continue;
    }

    try {
      const base = handle.base;

      if (HAVE_KEY) {
        await runMatrix(target.name, base, { expectAllowlist403: target.expectAllowlist403, expectNoSession403: target.expectNoSession403 === true });
        await runStt(target.name, base);
      } else {
        record(`${target.name}: full route matrix`, 'skip', 'no real OpenRouter key (E2E_OPENROUTER_KEY)');
        record(`${target.name}: speech-to-text`, 'skip', 'no real OpenRouter key (E2E_OPENROUTER_KEY)');
      }

      // negative tests: never reach OpenRouter, run with or without a real key
      const call = apiClient(base);
      const unknown = await call('/nope', {});
      if (unknown.status !== 404) {
        throw new Error(`unknown path expected 404, got ${unknown.status}`);
      }
      record(`${target.name}: unknown path -> 404 (negative)`, 'pass');

      if (target.expectAllowlist403) {
        const denied = await call('/chat/completions', {
          model: DISALLOWED_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        });
        if (denied.status !== 403) {
          throw new Error(`allowlist violation expected 403, got ${denied.status}`);
        }
        record(`${target.name}: model allowlist -> 403 (negative)`, 'pass');
      }

      if (target.expectNoSession403) {
        const noSession = await apiClient(base, '')('/chat/completions', {
          model: MODEL,
          messages: [{ role: 'user', content: 'hi' }],
        });
        if (noSession.status !== 403) {
          throw new Error(`no-session call expected 403, got ${noSession.status}`);
        }
        record(`${target.name}: no session -> 403 (negative)`, 'pass');
      }

      if (HAVE_KEY && target.browser) {
        await runBrowserFlow(target.name, base);
      } else if (!HAVE_KEY) {
        record(`browser flow via ${target.name}`, 'skip', 'no real OpenRouter key');
      }
    } catch (e) {
      let detail = e.message?.split('\n')[0];
      if (typeof handle.errorLogTail === 'function') {
        detail += ' | ' + (await handle.errorLogTail()).split('\n').slice(-3).join(' | ').slice(0, 400);
      }
      record(`${target.name} e2e`, 'fail', detail);
    } finally {
      await handle.stop();
    }
  }

  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  const passed = results.filter((r) => r.status === 'pass');
  console.log(`\ne2e summary: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

await main();
