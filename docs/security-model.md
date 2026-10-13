# ibh Security Model

## Trust model

- **The host is trusted.** The site ships the bundle and authors the manifest;
  a malicious host is out of scope (it already controls your session by definition).
- **The user is trusted** — it is their account and their consent cards.
- **The LLM is untrusted.** It may hallucinate, misuse tools, or be manipulated
  by page content. Every protection below is aimed at this layer.
- **Page content is untrusted.** Comments, reviews, titles — any of it may contain
  instructions aimed at the agent (prompt injection).

## The enforcement stack (prompt is a hint, manifest is the gate)

1. **Capability manifest.** The model has no network, no DOM, nothing. It emits
   structured intents. Anything not declared in the manifest is structurally
   impossible, no matter what the prompt says or what the page injects.
2. **Gatekeeper pipeline.** `intent → policy evaluation → argument validation →
   consent → rate/budget commit → execution → audit`. Argument validation happens
   BEFORE consent, so a user never approves an action that would fail, and the
   consent preview always matches exactly what executes.
3. **Consent tiers.** `auto` / `session` / `confirm` / `denied` — set explicitly per
   capability by the host. ibh has **no library default** and **fails closed**: with
   no consent UI connected, everything above `auto` is denied. Headless deployments
   (`ui.enabled: false`) therefore deny mutations by default; a host that wants them
   must opt in by supplying a `consent` handler and takes responsibility for
   obtaining the user's approval.
4. **Confirmation cards.** For `confirm` capabilities the user sees the exact HTTP
   method + path + payload preview, or the exact element about to be acted on.
   Page content cannot approve a card; only the user can.
5. **Rate limits and budgets.** Per-capability `maxPerSession` / `minIntervalMs`,
   a session-wide mutating-action budget, per-turn step/tool limits, and a session
   token budget. Library ceilings clamp everything a manifest can request.
6. **Injection hardening.** Page text and tool results are framed to the model as
   data, not instructions. Combined with (4), the worst a successful injection can
   achieve is a *visible, user-approved* action.
7. **Sandboxed compute.** Model-written JS runs in a fresh iframe per call with
   `sandbox="allow-scripts"` (opaque origin — no cookies, no storage, no host DOM)
   and CSP `default-src 'none'` (no network). It computes; nothing else.
8. **Audit ledger.** Every decision — allow, confirm, consent-denied, deny, error —
   is recorded with timestamps and details, and rendered in the panel.

## Honest boundaries

- **Client-side enforcement constrains the model, not the user.** A determined user
  can open devtools; that is fine — it is their account. ibh is not a DRM system.
- **A key in the page is a drained key.** LLM access has exactly three modes
  (see [integration-guide.md](./integration-guide.md)): BYO *user* key (pure
  frontend — the key is the visitor's own, billed to them, stored in their
  browser), a **backend proxy** (production — `llm.baseUrl` points at your
  endpoint; ibh sends no key, your session cookie authenticates, and your server
  forwards to OpenRouter with the server-side key; a zero-dependency reference
  proxy ships at `examples/proxy/`), or a shared site key in the page — which ibh
  **refuses to initialize with**. Fail-closed credential validation is tested in
  `packages/ibh/src/init.test.ts`.
- **Defense in depth lives server-side.** For sensitive sites, mint a
  **harness-scoped token** per session with reduced permissions (e.g. cannot access
  billing, cannot delete) and hand THAT to `auth: { mode: 'token' }`. Then even a
  fully-compromised agent cannot exceed its server-side scope. This is the real
  security boundary; the client stack is correctness and UX. The same logic applies
  to the LLM proxy: model allowlists, rate limits and spend caps must be enforced
  at your proxy, not only in the client manifest.
- **Result truncation** caps tool output size so a huge API response cannot blow the
  context window or hide cost, but hosts should still avoid returning enormous
  payloads from read capabilities.

## Permissions: a best-effort layer, NOT a security boundary

This repo ships an extensive permissions layer — the capability manifest, consent
tiers, rate limits, budgets and the gatekeeper — and it is **audited and covered by
tests** (`pnpm test`; see the gatekeeper security suite in
`packages/executor/src/gate.security.test.ts` which proves fail-closed behavior:
unregistered capabilities are denied, denials execute nothing, missing consent UI
disables mutations, arguments are validated before consent, budgets and rate limits
hold, cross-origin targets are refused, and so on).

But be clear-eyed about what that is:

- **ibh runs in the page with the signed-in user's session. Assume ibh has exactly
  the same permissions as the user controlling it.** Any action the user could take
  by hand is, by construction, reachable through the harness.
- The enforcement stack constrains the *model* — it prevents mistakes and limits the
  blast radius of prompt injection. It is not a sandbox against a determined
  attacker, and no client-side mechanism can be (the page is the attacker's
  territory, not yours).
- The consent UI is a UX affordance, not a guarantee.

**This is a tradeoff the integrator must make.** If you are conservative, do not rely
on this layer alone:

1. Enforce authorization **server-side**. The manifest shapes agent behavior; your
   API's own authz is what guarantees it.
2. For sensitive sites, mint a **harness-scoped token** per session with reduced
   permissions and hand it to `auth: { mode: 'token' }` — then even a runaway agent
   cannot exceed its server-side scope.
3. Keep destructive surfaces (billing, account deletion, admin endpoints) out of the
   manifest entirely, and rate-limit / audit mutating endpoints server-side.

We ship the permissions layer because a harness with no guardrails is unusable in
practice, and we test it hard because silent gaps are worse than none. But the
honest engineering position is: trust the server, use ibh's manifest to make the
agent well-behaved, and never as your only line of defense.

## What ibh deliberately does NOT do

- No undo / rollback of any action — see [non-goals.md](./non-goals.md).
- No default consent behavior — the host must configure every tier.
- No cross-origin API calls or navigation, ever.
- No credential storage, parsing, or transmission beyond what the auth adapter does.
- No persistence by default — history, the audit log and session approvals live in
  memory, and a refresh starts a clean session. A host can opt in with
  `persistence: { enabled: true }`; ibh then stores that state in localStorage and
  restores it on the next load. Budgets, rate limits and token spend are never
  persisted, so a refresh always resets them.

Two behaviors are safe-by-default but overridable, and both move responsibility to
the host when overridden:

- **Headless mutations.** With `ui.enabled: false` there is no consent surface, so
  every capability above `auto` is denied. Supplying a `consent` handler opts in to
  executing them without the panel. If that handler unconditionally approves, the
  user is no longer watching — only do this for trusted automation, and keep
  mutating tiers out of the manifest where a human should decide.
- **Persistence.** When enabled, conversation content and the audit log are written
  to localStorage, which is readable by any script on the origin. Do not enable it
  on shared machines or for sessions carrying sensitive data.
