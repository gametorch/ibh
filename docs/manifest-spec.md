# ibh Capability Manifest — Specification (v1)

The manifest is the **hard contract** between a host site and ibh. It is the single
source of truth for what the agent is allowed to do. If it is not in the manifest,
the runtime will not execute it — the model's prompt is only a hint, the manifest is
the gate.

Validation is **fail-closed**: a manifest that does not explicitly configure consent
tiers is rejected and ibh refuses to start. There are no library defaults.

```ts
type Tier = 'auto' | 'session' | 'confirm' | 'denied';
```

| Tier        | Behavior                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `auto`      | Executes without asking the user. Still rate-limited and budgeted.        |
| `session`   | Asks once per browser session per capability; afterwards executes freely. |
| `confirm`   | Shows an approval card describing the exact action, every single time.    |
| `denied`    | Never executable. Declared for documentation and UX clarity only.         |

## Top-level shape

```jsonc
{
  "version": 1,
  "site": { "name": "GameTorch", "origin": "https://gametorch.app" },
  "api":   [ /* ApiCapability */ ],
  "dom":   [ /* DomCapability (optional) */ ],
  "nav":   [ /* NavCapability (optional) */ ],
  "policies": { /* session-level budgets */ },
  "llm":   { /* model policy */ }
}
```

Validation rules:

- `version` must be `1`.
- `site.name` — non-empty string. `site.origin` — valid `http(s)` origin. All API and
  navigation targets are restricted to this origin.
- Capability `id`s are **globally unique across all kinds** and must match
  `^[_a-zA-Z][-_a-zA-Z0-9]{0,63}$`.
- Every capability **must** declare `tier`. Omitting it is a validation error.

## ApiCapability

```jsonc
{
  "id": "sprites_generate",
  "method": "POST",                    // GET | POST | PUT | PATCH | DELETE
  "path": "/api/sprites/:id/generate", // ":param" segments; NO wildcards
  "tier": "confirm",
  "description": "Generate sprite art for an existing sprite.",
  "argSchema":    { /* lite JSON schema for the request body */ },
  "querySchema":  { /* lite JSON schema for query params */ },
  "rate": { "maxPerSession": 10, "minIntervalMs": 1000 }
}
```

- `path` is relative to `site.origin`. Cross-origin calls are structurally impossible.
- `":name"` segments are interpolated from the call's `path` arguments
  (URL-encoded). Missing parameters are rejected before execution.
- **A capability is *mutating* if `method !== 'GET'`.** Mutating capabilities with a
  tier other than `denied` require `policies.maxMutatingActionsPerSession` to be set.
- `argSchema` / `querySchema` use the **lite schema subset** below. When present they
  are enforced before execution; invalid calls never fire a request.
- `approve` — optional custom approval copy (see "Approval copy" below).

## DomCapability

```jsonc
{
  "id": "sprites_publish",
  "action": "click",                              // click | fill | submit | highlight
  "selector": "[data-ibh-action=\"publish\"]",    // any CSS selector
  "tier": "confirm",
  "description": "Publishes the sprite currently open in the editor.",
  "argSchema": { "type": "string" }               // only meaningful for `fill`
}
```

- `selector` is authored by the (trusted) host and may be any CSS selector.
  Prefer `data-ibh-action="…"` markers on the interactive elements you intend
  the agent to use.
- A DOM intent may additionally pass a `ref` from the latest page snapshot; the
  runtime then requires the element to actually match `selector` — a stale or
  mismatched ref is rejected.
- **Mutating** if `action !== 'highlight'`.
- The adapter refuses to act on elements inside `[data-ibh-ui]` (ibh's own UI)
  or `[data-ibh-ignore]` subtrees.

## NavCapability

```jsonc
{
  "id": "editor",
  "route": "/sprites/:id",     // ":param" segments; NO wildcards in v1
  "tier": "auto",
  "mode": "spa",               // spa (default) | full
  "description": "Open a sprite in the editor."
}
```

- `mode: "spa"` uses `history.pushState` + a `popstate` dispatch (works with plain
  history-based routers); hosts with framework routers should hook `nav.customNavigate`
  at init. `mode: "full"` performs a same-origin `location.assign`.
- Navigation is never counted as mutating.

## Policies

```jsonc
"policies": {
  "maxMutatingActionsPerSession": 20,  // REQUIRED if executable mutating caps exist
  "maxStepsPerTurn": 12,               // agent reasoning/tool steps per user turn
  "maxToolCallsPerTurn": 20,
  "maxTokensPerSession": 200000        // prompt+completion tokens, whole session
}
```

All values are **clamped by library ceilings** (a manifest may only tighten, never
loosen): steps ≤ 20, tool calls ≤ 30, tokens ≤ 500k, mutating actions ≤ 200.

## LlmPolicy

```jsonc
"llm": {
  "allowedModels": ["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"],
  "defaultModel": "openai/gpt-6-luna"   // must be a member of allowedModels
}
```

## Approval copy (`approve`)

Every capability (api/dom/nav) accepts an optional `approve` spec that replaces the
default technical consent card (method + path + payload) with integrator-authored
copy. The integrator is trusted code, so the string is arbitrary; the UI renders it
as **plain text** (never HTML).

Two forms:

**1. String template** (JSON-friendly) — `{{dot.path}}` placeholders resolve against
the approval context (strings raw, numbers/booleans stringified, objects JSON'd,
missing → empty):

```jsonc
{ "id": "sprites_create", "approve": "Create a sprite named \"{{body.name}}\"?" }
```

**2. Function** (programmatic init only — JSON manifests cannot carry functions):

```js
{
  id: 'sprites_update',
  approve: (c) => c.body?.published ? `Publish sprite #${c.path.id}?` : `Update sprite #${c.path.id}?`,
}
```

The approval context (`ApproveContext`) passed to functions / available to templates:

| Field          | Present | Meaning                                    |
| -------------- | ------- | ------------------------------------------ |
| `kind`         | always  | `api` \| `dom` \| `nav`                     |
| `capabilityId` | always  | manifest id                                 |
| `method`       | api     | HTTP method                                 |
| `path`         | api/nav | interpolated path / route **string**        |
| `params`       | api/nav | path parameters object — use `{{params.id}}`|
| `query`, `body`| api     | request args (objects — use `{{body.name}}`)|
| `action`       | dom     | `click` \| `fill` \| `submit` \| `highlight`|
| `value`        | dom     | fill value                                  |
| `element`      | dom     | human-readable target description           |

Notes:
- The audit log always records the full technical detail regardless of `approve`.
- Omitting `approve` keeps the default technical preview.
- Cap: strings ≤ 2000 chars.

## Lite JSON schema subset

Enough to catch agent mistakes, simple enough to audit:

```ts
{
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null',  // required
  properties?: Record<string, LiteSchema>,
  required?: string[],
  additionalProperties?: false,
  items?: LiteSchema,
  enum?: Array<string | number | boolean | null>,
  minLength?: number, maxLength?: number,
  minimum?: number, maximum?: number,
  pattern?: string   // ECMA regex, host-authored
}
```

## Built-in tools (not part of the manifest)

Two read-only builtins exist with library-fixed rate limits:

- `page_snapshot` — compact accessibility-style snapshot of the current page with
  stable element refs (`#rN`).
- `analyze` — runs model-authored JS as a **pure function** over JSON data in a
  sandboxed iframe with `default-src 'none'` CSP (no network, no host DOM).

## Tool naming

Capabilities surface to the model as tools named `api_<id>`, `dom_<id>`, `nav_<id>`
(function names must be `[a-zA-Z0-9_-]{1,64}`, hence ids may not contain dots).
