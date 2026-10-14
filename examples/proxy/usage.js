'use strict';

// OpenRouter usage accounting — the integrator's billing hook.
//
// OpenRouter includes a `usage` object on EVERY response with the REAL cost, no
// extra request or parameter needed (the old `usage: { include: true }` /
// `stream_options.include_usage` flags are deprecated no-ops). This is what lets
// a business-logic proxy meter exactly what each user spent and charge them
// however it likes.
//
// Chat completions (`/chat/completions`):
//   usage.cost                                  -> USD charged to YOUR account
//   usage.cost_details.upstream_inference_cost  -> USD the upstream provider charged
//   usage.prompt_tokens / completion_tokens / total_tokens
// Speech-to-text (`/audio/transcriptions`) uses a different shape:
//   usage.cost, usage.seconds, usage.input_tokens / output_tokens / total_tokens
//
// `cost` is the amount OpenRouter actually debits from the key in the proxy, so
// it is the true per-request figure to bill against (pass-through, markup,
// credits, quotas — your call). This is deliberately NOT an ibh front-end
// concern: the browser has no use for cost, and the proxy is where the session
// identity and the key already live.

/** Coerce a JSON value to a finite number, else null. */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Pull usage accounting out of a parsed OpenRouter response body.
 *
 * @param {unknown} body parsed response JSON
 * @param {string|null} [generationIdHeader] `X-Generation-Id` response header
 *   (OpenRouter returns it for STT, whose body carries no `id`)
 * @returns {object|null} a flat usage record, or null when there is no usage
 */
function extractUsage(body, generationIdHeader = null) {
  if (!body || typeof body !== 'object') return null;
  const usage = body.usage;
  if (!usage || typeof usage !== 'object') return null;
  const bodyId = typeof body.id === 'string' ? body.id : null;
  return {
    generationId: bodyId ?? (typeof generationIdHeader === 'string' ? generationIdHeader : null),
    model: typeof body.model === 'string' ? body.model : null,
    cost: num(usage.cost),
    upstreamInferenceCost: num(usage.cost_details?.upstream_inference_cost),
    promptTokens: num(usage.prompt_tokens) ?? num(usage.input_tokens),
    completionTokens: num(usage.completion_tokens) ?? num(usage.output_tokens),
    totalTokens: num(usage.total_tokens),
    cachedTokens: num(usage.prompt_tokens_details?.cached_tokens),
    reasoningTokens: num(usage.completion_tokens_details?.reasoning_tokens),
    audioSeconds: num(usage.seconds),
  };
}

/**
 * Map a usage record to `X-Ibh-*` response headers (unknown fields omitted).
 * These let the integrator's own app server observe cost per request without
 * parsing the body — useful for logging/aggregation, and trivially assertable.
 */
function usageHeaders(usage) {
  const headers = {};
  if (!usage) return headers;
  if (usage.cost !== null) headers['x-ibh-cost'] = String(usage.cost);
  if (usage.upstreamInferenceCost !== null)
    headers['x-ibh-upstream-inference-cost'] = String(usage.upstreamInferenceCost);
  if (usage.totalTokens !== null) headers['x-ibh-total-tokens'] = String(usage.totalTokens);
  if (usage.audioSeconds !== null) headers['x-ibh-audio-seconds'] = String(usage.audioSeconds);
  if (usage.generationId) headers['x-ibh-generation-id'] = usage.generationId;
  if (usage.model) headers['x-ibh-model'] = usage.model;
  return headers;
}

/**
 * The billing hook.
 *
 * REPLACEME: persist `record` to your database / billing system and charge the
 * user however you want — pass `cost` through, add a markup, debit a credit
 * balance, count against a plan quota, alert on anomalies. `user` is whatever
 * your session verifier returned (`AUTH_VERIFY_URL`'s JSON `user` field).
 *
 * The default just writes one machine-readable line per request so it can be
 * piped straight into whatever you already use for metering:
 *
 *   ibh.usage {"user":"u_123","cost":0.000508,"totalTokens":113,...}
 */
function recordUsage(record) {
  console.log(`ibh.usage ${JSON.stringify(record)}`);
}

module.exports = { extractUsage, usageHeaders, recordUsage };
