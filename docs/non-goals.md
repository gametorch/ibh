# ibh Non-Goals

These are deliberate design decisions, not oversights. They will not be revisited
lightly.

## 1. No undo / rollback — ever

ibh has a full audit log of every action, but **no undo mechanism, and none will be
added**. Supporting undo would contort the design: it would push hosts toward
modeling inverses for every action, encourage the agent to take more risks because
"it can be undone", and create false confidence (most real-world side effects —
emails sent, payments charged, third-party state changed — cannot be undone anyway).

If you want undo support, **fork this repo**.

## 2. No library defaults for consent

ibh refuses to guess whether an action is safe. Every capability in the manifest
declares its own tier; a manifest without explicit tiers is rejected. A harness with
defaults is a harness that silently ships someone else's risk tolerance to your users.

## 3. No raw network or DOM access for the model

The model gets structured tools only. No `fetch`, no `eval` on the host page, no
arbitrary selectors, no cross-origin anything. This is the property that makes the
manifest a real contract rather than a suggestion.

## 4. No cross-site/portable credentials

ibh acts only within `manifest.site.origin`. It never reads, stores, or moves
credentials between sites, and its API calls can only ever carry the host's own
session forward.

## 5. No session persistence across page loads

History, audit log, and session approvals live in memory. A refresh is a clean
session. Persistent agent state would turn a browsing assistant into an ambient
daemon — out of scope.

## 6. No headless mutating actions

`ui.enabled: false` (headless mode) removes the consent UI, so by fail-closed
construction every capability above `auto` is denied. ibh will never ship a mode
where mutating actions execute without a user watching.
