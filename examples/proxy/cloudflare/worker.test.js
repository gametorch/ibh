import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import worker from './worker.js';

function makeEnv(overrides = {}) {
  return {
    OPENROUTER_KEY: 'sk-or-test',
    AUTH_MODE: 'jwt-hs256',
    AUTH_SECRET: 'test-secret',
    ALLOWED_MODELS: 'openai/gpt-6-luna',
    COOKIE_NAME: 'sid',
    ...overrides,
  };
}

const enc = new TextEncoder();
function b64url(bytes) {
  return btoa(String.fromCodePoint(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
async function signJwt(payload, secret) {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

function makeRequest(path, { token, body, origin } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('cookie', `sid=${token}`);
  if (origin) headers.set('origin', origin);
  return new Request(`https://gametorch.app${path}`, {
    method: 'POST',
    headers,
    body: body ?? JSON.stringify({ model: 'openai/gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

let upstreamCalls;
beforeEach(() => {
  upstreamCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      upstreamCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ibh cloudflare worker proxy', () => {
  it('404s unknown paths and rejects non-POST', async () => {
    const env = makeEnv();
    expect((await worker.fetch(makeRequest('/api/ibh-llm/other'), env)).status).toBe(404);
    const res = await worker.fetch(new Request('https://x/api/ibh-llm/chat/completions', { method: 'GET' }), env);
    expect(res.status).toBe(405);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('fails closed without OPENROUTER_KEY or AUTH_MODE', async () => {
    expect((await worker.fetch(makeRequest('/api/ibh-llm/chat/completions'), makeEnv({ OPENROUTER_KEY: undefined }))).status).toBe(500);
    expect((await worker.fetch(makeRequest('/api/ibh-llm/chat/completions'), makeEnv({ AUTH_MODE: undefined }))).status).toBe(500);
    expect(upstreamCalls).toHaveLength(0);
  });

  it('fails closed with no session cookie, bad signature, or expired token', async () => {
    const env = makeEnv();
    expect((await worker.fetch(makeRequest('/api/ibh-llm/chat/completions'), env)).status).toBe(403);

    const expired = await signJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 10 }, 'test-secret');
    expect((await worker.fetch(makeRequest('/api/ibh-llm/chat/completions', { token: expired }), env)).status).toBe(403);

    const forged = (await signJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 600 }, 'wrong-secret'));
    expect((await worker.fetch(makeRequest('/api/ibh-llm/chat/completions', { token: forged }), env)).status).toBe(403);

    expect(upstreamCalls).toHaveLength(0);
  });

  it('forwards authorized chat requests with the server-side key and passes the response through', async () => {
    const token = await signJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-secret');
    const res = await worker.fetch(makeRequest('/api/ibh-llm/chat/completions', { token }), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ choices: [{ message: { content: 'ok' } }] });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(upstreamCalls[0].init.headers.Authorization).toBe('Bearer sk-or-test');
  });

  it('forwards multimodal (image) chat bodies intact', async () => {
    const token = await signJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-secret');
    const body = JSON.stringify({
      model: 'openai/gpt-6-luna',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
          ],
        },
      ],
    });
    const res = await worker.fetch(makeRequest('/api/ibh-llm/chat/completions', { token, body }), makeEnv());
    expect(res.status).toBe(200);
    const forwarded = JSON.parse(new TextDecoder().decode(upstreamCalls[0].init.body));
    expect(forwarded.messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  it('enforces the server-side model allowlist', async () => {
    const token = await signJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-secret');
    const res = await worker.fetch(
      makeRequest('/api/ibh-llm/chat/completions', {
        token,
        body: JSON.stringify({ model: 'openai/o-billion', messages: [] }),
      }),
      makeEnv()
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain('not allowed');
    expect(upstreamCalls).toHaveLength(0);
  });

  it('remote auth mode verifies via the integrator endpoint', async () => {
    const remoteFetch = vi.fn(async (url, init) => {
      expect(init.headers.cookie).toContain('sid=');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('https://verify.example')) return remoteFetch(url, init);
      upstreamCalls.push({ url: String(url), init });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const token = await signJwt({ sub: 'u1' }, 'test-secret'); // any opaque token
    const res = await worker.fetch(
      makeRequest('/api/ibh-llm/chat/completions', { token }),
      makeEnv({ AUTH_MODE: 'remote', AUTH_VERIFY_URL: 'https://verify.example/check' })
    );
    expect(res.status).toBe(200);
    expect(remoteFetch).toHaveBeenCalledTimes(1);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('origin check: mismatched Origin is rejected when ALLOWED_ORIGIN is set', async () => {
    const token = await signJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-secret');
    const env = makeEnv({ ALLOWED_ORIGIN: 'https://gametorch.app' });
    const res = await worker.fetch(makeRequest('/api/ibh-llm/chat/completions', { token, origin: 'https://evil.example' }), env);
    expect(res.status).toBe(403);
    const ok = await worker.fetch(makeRequest('/api/ibh-llm/chat/completions', { token, origin: 'https://gametorch.app' }), env);
    expect(ok.status).toBe(200);
  });

  it('audio/transcriptions forwards with a larger size budget', async () => {
    const token = await signJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-secret');
    const res = await worker.fetch(
      makeRequest('/api/ibh-llm/audio/transcriptions', { token, body: JSON.stringify({ model: 'elevenlabs/scribe-v2' }) }),
      makeEnv({ ALLOWED_MODELS: '' })
    );
    expect(res.status).toBe(200);
    expect(upstreamCalls[0].url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
  });
});
