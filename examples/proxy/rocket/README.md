# ibh LLM proxy — Rust / Rocket

Production-grade LLM access for ibh with **no key in the browser**, as a single
Rust binary. Same contract as the node reference: exactly two paths forwarded to
OpenRouter, session-gated, size-capped, model-allowlisted server-side.

```
Browser (ibh, llm: { baseUrl: 'http://your-host:4181/api/v1' })
  → same-origin POST, session cookie flows automatically
    → Rocket: verify session → allowlist model → forward
      → https://openrouter.ai (Authorization: Bearer $OPENROUTER_KEY)
```

Exactly two paths are routed — everything else 404s:

- `POST /api/v1/chat/completions` (ibh's model client, 1 MiB cap)
- `POST /api/v1/audio/transcriptions` (ibh's `ui.stt` voice input, 8 MiB cap)

## Quickstart

```bash
# from examples/proxy/rocket/
OPENROUTER_KEY=sk-or-... \
AUTH_VERIFY_URL=http://127.0.0.1:3000/session/verify \
ALLOWED_MODELS="openai/gpt-6-luna" \
cargo run --release
# then point ibh at it:
ibh.init({ /* ... */ llm: { baseUrl: 'http://your-host:4181/api/v1' } });
```

## Configuration (environment)

| Variable | Meaning |
| --- | --- |
| `OPENROUTER_KEY` | **Required** — your server-side OpenRouter key. Never shipped to the browser. |
| `AUTH_VERIFY_URL` | **Required** — your app's session-verify endpoint; receives the caller's `Cookie` header, must answer 2xx (ok) or 4xx/5xx (reject). **Fail-closed:** the server refuses to start without it. |
| `ALLOWED_MODELS` | Comma-separated server-side model gate (the client manifest is advisory). Unset = allow any. |
| `ALLOWED_ORIGIN` | Optional — reject requests whose `Origin` header mismatches (defense in depth). |

## Session verification

Like the reference node proxy, verification **delegates to your app**: the
caller's `Cookie` header is forwarded to `AUTH_VERIFY_URL`; `2xx` = ok. That one
URL is the REPLACEME — swap it for inline JWT verification (e.g. the
`jsonwebtoken` crate) if you'd rather not make a per-request call. The server
**refuses to start** without a verifier configured.

## Privacy by construction

The upstream request is built from scratch — only `Authorization`,
`Content-Type` and `X-Title` are sent. The user's session `Cookie` **never**
reaches openrouter.ai.

## Recommendations & caveats (same posture as the other variants)

- **Model allowlist**: prefer the **one-hardcoded-model** approach
  (`llm.allowedModels: [X]`, `defaultModel: X`) — although, unlike nginx/Apache,
  this server *can* enforce the allowlist server-side, so `ALLOWED_MODELS` with
  your real list is the strongest option. Always pair with an **OpenRouter
  per-key spend cap**.
- **No built-in rate limiting**: Rocket has none. Add a `governor`-based
  middleware, put nginx/Cloudflare in front, or rate-limit inside
  `AUTH_VERIFY_URL`'s app. The OpenRouter spend cap is the backstop either way.
- **Timeouts**: the reqwest client is configured with a 180s timeout (> ibh's
  120s model timeout) so long generations aren't killed locally.

## Supply-chain discipline (mirrors the pnpm posture)

- `Cargo.toml` pins **exact versions** (no carets); upgrades are deliberate.
- `Cargo.lock` is committed; review it on every dependency change.
- Run `cargo install cargo-audit && cargo audit` in CI.
- All pins were published well before use (≥ 3 days) and are ecosystem-standard
  crates only: `rocket`, `reqwest` (rustls — no openssl C dependency), `serde`,
  `serde_json`. Keep the list this small.

## Manual smoke test

```bash
# rejected: no session cookie
curl -s -X POST http://127.0.0.1:8000/api/v1/chat/completions -d '{"model":"openai/gpt-6-luna"}'

# rejected: model not allowed (with a valid session cookie)
curl -s -X POST http://127.0.0.1:8000/api/v1/chat/completions \
  -b 'sid=<your-session>' -H 'content-type: application/json' \
  -d '{"model":"openai/o-billion"}'

# forwarded: OpenRouter answers (401 with a fake key proves the pipe)
curl -s -X POST http://127.0.0.1:8000/api/v1/chat/completions \
  -b 'sid=<your-session>' -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-6-luna","messages":[{"role":"user","content":"hi"}]}'
```

## ibh wiring

```js
ibh.init({
  // ...
  llm: { baseUrl: 'http://your-host:4181/api/v1' }, // no key in the page
  ui: { stt: { model: 'elevenlabs/scribe-v2' } },   // inherits the proxy (audio/transcriptions)
});
```

Security note: the manifest and this server gate what the *agent* does; your
API's own authorization remains the real boundary (see `docs/security-model.md`).
