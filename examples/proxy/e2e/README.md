# ibh proxy end-to-end tests

True e2e tests: each reference proxy is started as a **real process**, receives
**exactly the requests ibh's browser panel sends** (same paths, cookies, no
`Authorization` header), reaches the **real OpenRouter API**, and the response
comes back — covering every route ibh uses:

- `chat/completions` — plain completion round trip
- `chat/completions` with tool definitions + forced tool choice (the agent-loop shape)
- server-side model allowlist covers **both** chat and STT models (set
  `ALLOWED_MODELS` to include your STT model, e.g. `elevenlabs/scribe-v2`)
- tool result fed back → final answer mentions the data
- server-side model allowlist → 403 before OpenRouter is contacted (node/rocket only;
  config-only proxies cannot read the body — documented tradeoff)
- `audio/transcriptions` — a real speech fixture (`fixtures/hello.wav`, committed)
  transcribed back, asserting the transcript contains "hello"
- **cost surfacing** — the node and Rocket proxies must return the real
  OpenRouter cost to the integrator (`X-Ibh-Cost` / `X-Ibh-Total-Tokens`
  headers), asserted on both the chat and STT round trips
- unknown path → 404

When a Chromium-based browser is available, the suite additionally runs the
**headless-browser flow** through the real UI: load the gametorch demo, type into
the ibh panel, wait for the agent to request a `confirm`-tier write, click
**Approve** on the consent card, and assert the mock API updated and the panel
answered. The browser talks same-origin to the demo server, which fronts the
proxy under test (`IBH_PROXY_URL`) — exactly how production app servers front an
LLM proxy.

## Run

```bash
# real key required for the positive tests; negative tests run without one.
# Store the key file OUTSIDE the repo (e.g. ~/.ibh/openrouter-e2e-key).
E2E_OPENROUTER_KEY="$(cat ~/.ibh/openrouter-e2e-key)" pnpm test:e2e

# restrict targets
E2E_OPENROUTER_KEY="$(cat ~/.ibh/openrouter-e2e-key)" E2E_TARGETS=node,rocket pnpm test:e2e
```

## Gating (fail-closed / skip-closed)

| Condition | Behavior |
| --- | --- |
| No `E2E_OPENROUTER_KEY` / `OPENROUTER_KEY` | positive tests **skipped** (with reason); negative tests (404s, allowlist 403, no-session 403) still run — they never reach OpenRouter |
| Rocket binary not built | target skipped (build it: `cargo build --release` in `examples/proxy/rocket/`) |
| `nginx` binary not found | target skipped |
| `apachectl`/modules not found | target skipped |
| No Chromium-based browser (set `CHROME_PATH` or install Chrome/Edge/Brave/Chromium) | headless-browser flow skipped |
| Any real failure | exit code 1, `FAILED:` lines printed |

This suite is **intentionally not part of `pnpm test`** — it hits the network and
spends real credits.

## Headless browser notes

The suite uses `playwright-core` (a devDependency) and launches **your**
locally installed Chromium-based browser via `executablePath` — no browser
binaries are downloaded from any CDN, keeping the supply-chain posture intact.
Without a browser the browser flow is skipped, not failed.

The demo supports `?llm-base=<url>` to boot ibh in **proxy mode** (no key
banner) — that is what the browser flow uses; it also demonstrates the
production integration shape.
