//! ibh LLM proxy — Rust / Rocket reference implementation.
//!
//! Zero-key-in-the-browser: ibh talks to THIS server
//! (`llm: { baseUrl: 'http://localhost:4181/api/v1' }`), your existing session
//! cookie authenticates the user, and this server forwards exactly two paths to
//! OpenRouter with the server-side key:
//!
//!   POST /api/v1/chat/completions      (ibh's model client, 1 MiB cap)
//!   POST /api/v1/audio/transcriptions  (ibh's ui.stt voice input, 8 MiB cap)
//!
//! Run:
//!   OPENROUTER_KEY=sk-or-... AUTH_VERIFY_URL=http://127.0.0.1:3000/session/verify \
//!   cargo run --release
//!
//! Fail-closed: the server refuses to start without OPENROUTER_KEY and
//! AUTH_VERIFY_URL, and refuses to forward requests that fail session
//! verification. See examples/proxy/rocket/README.md for the tradeoffs
//! (one hardcoded model + OpenRouter spend cap; no built-in rate limiting).
//!
//! COST / USAGE ACCOUNTING: OpenRouter returns the real per-request cost
//! (`usage.cost`) on every response. ibh is non-streaming, so this server reads
//! it from the JSON body, mirrors it into `X-Ibh-*` response headers and logs
//! one machine-readable `ibh.usage {...}` line attributed to the verified user.
//! See `record_usage` — REPLACEME it to persist usage and charge users.
//!
//! REPLACEME: `verify_session` below is the ONE thing you should replace or
//! point at your real session verifier. Like the reference node proxy, the
//! default delegates to your app's session-verify endpoint over HTTP.

use rocket::data::ByteUnit;
use rocket::futures::TryStreamExt;
use rocket::http::{ContentType, Header, Status};
use rocket::request::{FromRequest, Outcome};
use rocket::response::{self, Responder};
use rocket::{Build, Data, Request, Rocket, State};
use rocket::{launch, post, routes};
use std::env;
use tokio_util::io::StreamReader;

const CHAT_PATH: &str = "/api/v1/chat/completions";
const TRANSCRIPTIONS_PATH: &str = "/api/v1/audio/transcriptions";
const CHAT_CAP: ByteUnit = ByteUnit::Mebibyte(1); // 1 MiB
const TRANSCRIPTIONS_CAP: ByteUnit = ByteUnit::Mebibyte(8); // 8 MiB

#[derive(Clone)]
struct ProxyConfig {
    openrouter_key: String,
    /// Empty = allow any model (the client-side manifest is advisory; you SHOULD
    /// set this — it is the real server-side gate).
    allowed_models: Vec<String>,
    /// Session-verify endpoint; receives the caller's Cookie header.
    auth_verify_url: String,
    /// Optional: reject requests whose Origin header mismatches (defense in depth).
    allowed_origin: Option<String>,
    http: reqwest::Client,
}

/** Newtype so raw `Response` values can be returned from route handlers
 * (Rocket 0.5 does not implement `Responder` for bare `Response`). */
struct ProxyResponse(response::Response<'static>);

impl<'r> Responder<'r, 'static> for ProxyResponse {
    fn respond_to(self, _: &'r Request<'_>) -> response::Result<'static> {
        Ok(self.0)
    }
}

/// Small JSON error body with the given status.
fn error_json(status: Status, message: &str) -> ProxyResponse {
    let body = serde_json::json!({ "error": { "message": message } }).to_string();
    ProxyResponse(
        rocket::response::Response::build()
            .status(status)
            .header(ContentType::JSON)
            .sized_body(body.len(), std::io::Cursor::new(body))
            .finalize(),
    )
}

/// Raw `Cookie` header guard (Rocket parses cookies; we want the raw value to
/// forward verbatim to the session verifier).
struct RawCookieHeader(Option<String>);

#[rocket::async_trait]
impl<'r> FromRequest<'r> for RawCookieHeader {
    type Error = std::convert::Infallible;

    async fn from_request(req: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let v = req.headers().get_one("Cookie").map(|s| s.to_string());
        Outcome::Success(RawCookieHeader(v))
    }
}

/// Raw `Origin` header guard.
struct RawOriginHeader(Option<String>);

#[rocket::async_trait]
impl<'r> FromRequest<'r> for RawOriginHeader {
    type Error = std::convert::Infallible;

    async fn from_request(req: &'r Request<'_>) -> Outcome<Self, Self::Error> {
        let v = req.headers().get_one("Origin").map(|s| s.to_string());
        Outcome::Success(RawOriginHeader(v))
    }
}

/// Identity extracted from the session verifier. `user` is the verifier's JSON
/// `{"user": "..."}` field when present, so cost can be attributed per user.
struct SessionIdentity {
    user: Option<String>,
}

/// Verify the caller's session. `None` = rejected; `Some(identity)` = allowed.
/// The verifier may answer 2xx without JSON (authenticated, no identity).
async fn verify_session(
    client: &reqwest::Client,
    verify_url: &str,
    cookie_header: &Option<String>,
) -> Option<SessionIdentity> {
    let cookie = match cookie_header {
        Some(c) if !c.is_empty() => c,
        _ => return None,
    };
    let res = client
        .get(verify_url)
        .header("Cookie", cookie.as_str())
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let body = res.text().await.unwrap_or_default();
    let user = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("user").and_then(|u| u.as_str()).map(str::to_string));
    Some(SessionIdentity { user })
}

/// OpenRouter usage accounting for one request (see `record_usage`).
#[derive(Default)]
struct UsageRecord {
    generation_id: Option<String>,
    model: Option<String>,
    cost: Option<f64>,
    upstream_inference_cost: Option<f64>,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
    audio_seconds: Option<f64>,
}

/// Pull usage accounting out of a parsed OpenRouter response body. Handles both
/// the chat shape (`prompt_tokens`/`completion_tokens`) and the STT shape
/// (`input_tokens`/`output_tokens`/`seconds`). `generation_id_header` is the
/// upstream `X-Generation-Id` (STT bodies carry no `id`).
fn extract_usage(body: &serde_json::Value, generation_id_header: Option<&str>) -> Option<UsageRecord> {
    let usage = body.get("usage")?;
    if !usage.is_object() {
        return None;
    }
    Some(UsageRecord {
        generation_id: body
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .or_else(|| generation_id_header.map(str::to_string)),
        model: body
            .get("model")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        cost: usage.get("cost").and_then(serde_json::Value::as_f64),
        upstream_inference_cost: usage
            .get("cost_details")
            .and_then(|d| d.get("upstream_inference_cost"))
            .and_then(serde_json::Value::as_f64),
        prompt_tokens: usage
            .get("prompt_tokens")
            .and_then(serde_json::Value::as_u64)
            .or_else(|| usage.get("input_tokens").and_then(serde_json::Value::as_u64)),
        completion_tokens: usage
            .get("completion_tokens")
            .and_then(serde_json::Value::as_u64)
            .or_else(|| usage.get("output_tokens").and_then(serde_json::Value::as_u64)),
        total_tokens: usage.get("total_tokens").and_then(serde_json::Value::as_u64),
        audio_seconds: usage.get("seconds").and_then(serde_json::Value::as_f64),
    })
}

/// The billing hook.
///
/// REPLACEME: persist `record` to your database / billing system and charge the
/// user however you like — pass `cost` through, add a markup, debit a credit
/// balance, count against a plan quota. `user` is whatever your session
/// verifier returned. The default writes one machine-readable line per request:
///
///   ibh.usage {"user":"u_123","cost":0.000508,"totalTokens":113,...}
fn record_usage(usage: &UsageRecord, user: Option<&str>, path: &str) {
    let record = serde_json::json!({
        "user": user,
        "path": path,
        "cost": usage.cost,
        "upstreamInferenceCost": usage.upstream_inference_cost,
        "model": usage.model,
        "generationId": usage.generation_id,
        "promptTokens": usage.prompt_tokens,
        "completionTokens": usage.completion_tokens,
        "totalTokens": usage.total_tokens,
        "audioSeconds": usage.audio_seconds,
    });
    println!("ibh.usage {record}");
}

async fn read_capped(data: Data<'_>, cap: ByteUnit) -> Result<Vec<u8>, ProxyResponse> {
    use rocket::tokio::io::AsyncReadExt;
    let mut stream = data.open(cap);
    let mut buf = Vec::new();
    match stream.read_to_end(&mut buf).await {
        Ok(_) => Ok(buf),
        Err(_) => Err(error_json(Status::BadRequest, "could not read request body")),
    }
}

/// Model allowlist — enforced on BOTH forwarded paths (chat and STT).
fn check_model(config: &ProxyConfig, body: &[u8]) -> Option<ProxyResponse> {
    if config.allowed_models.is_empty() {
        return None;
    }
    let parsed: Result<serde_json::Value, _> = serde_json::from_slice(body);
    if let Ok(parsed) = parsed {
        if let Some(model) = parsed.get("model").and_then(|m| m.as_str()) {
            if !config.allowed_models.iter().any(|m| m == model) {
                return Some(error_json(
                    Status::Forbidden,
                    &format!("model \"{model}\" is not allowed"),
                ));
            }
        }
    }
    None // non-JSON body: let OpenRouter produce the error
}

async fn forward(
    config: &ProxyConfig,
    path: &str,
    cookie_header: &Option<String>,
    origin: &Option<String>,
    body: Vec<u8>,
) -> ProxyResponse {
    // Origin defense in depth (mirrors the Cloudflare worker).
    if let (Some(expected), Some(actual)) = (&config.allowed_origin, origin) {
        if expected != actual {
            return error_json(Status::Forbidden, "origin not allowed");
        }
    }

    let session = match verify_session(&config.http, &config.auth_verify_url, cookie_header).await {
        Some(session) => session,
        None => return error_json(Status::Forbidden, "forbidden"),
    };

    let upstream = match config
        .http
        .post(format!("https://openrouter.ai{path}"))
        .header("Authorization", format!("Bearer {}", config.openrouter_key))
        .header("Content-Type", "application/json")
        .header("X-Title", "ibh-proxy")
        // NOTE: no Cookie header is forwarded — user session cookies never
        // reach openrouter.ai (the forward request is built from scratch).
        .body(body)
        .send()
        .await
    {
        Ok(res) => res,
        Err(e) => return error_json(Status::InternalServerError, &format!("upstream error: {e}")),
    };

    let status = Status::from_code(upstream.status().as_u16()).unwrap_or(Status::InternalServerError);
    let content_type_str = upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let content_type = ContentType::parse_flexible(&content_type_str).unwrap_or(ContentType::JSON);
    let generation_id = upstream
        .headers()
        .get("x-generation-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    if upstream.status().is_success() {
        // ibh is non-streaming, so success bodies are JSON: buffer them to read
        // OpenRouter's real per-request cost, surface it as X-Ibh-* headers and
        // hand it to the billing hook. Non-JSON success bodies (e.g. an SSE
        // stream from some other client) stream through untouched.
        if !content_type_str.contains("application/json") {
            let stream = upstream
                .bytes_stream()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
            let reader = StreamReader::new(stream);
            return ProxyResponse(
                rocket::response::Response::build()
                    .status(status)
                    .header(content_type)
                    .streamed_body(reader)
                    .finalize(),
            );
        }

        let bytes = upstream.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
        let mut builder = rocket::response::Response::build();
        builder.status(status).header(content_type);
        if let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(usage) = extract_usage(&parsed, generation_id.as_deref()) {
                record_usage(&usage, session.user.as_deref(), path);
                if let Some(cost) = usage.cost {
                    builder.header(Header::new("X-Ibh-Cost", cost.to_string()));
                }
                if let Some(up) = usage.upstream_inference_cost {
                    builder.header(Header::new("X-Ibh-Upstream-Inference-Cost", up.to_string()));
                }
                if let Some(tokens) = usage.total_tokens {
                    builder.header(Header::new("X-Ibh-Total-Tokens", tokens.to_string()));
                }
                if let Some(seconds) = usage.audio_seconds {
                    builder.header(Header::new("X-Ibh-Audio-Seconds", seconds.to_string()));
                }
                if let Some(id) = &usage.generation_id {
                    builder.header(Header::new("X-Ibh-Generation-Id", id.clone()));
                }
                if let Some(model) = &usage.model {
                    builder.header(Header::new("X-Ibh-Model", model.clone()));
                }
            }
        }
        ProxyResponse(
            builder
                .sized_body(bytes.len(), std::io::Cursor::new(bytes))
                .finalize(),
        )
    } else {
        let body = upstream.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
        error_json(status, &String::from_utf8_lossy(&body))
    }
}

#[post("/api/v1/chat/completions", data = "<body_data>")]
async fn chat(
    config: &State<ProxyConfig>,
    cookies: RawCookieHeader,
    origin: RawOriginHeader,
    body_data: Data<'_>,
) -> ProxyResponse {
    let body = match read_capped(body_data, CHAT_CAP).await {
        Ok(b) => b,
        Err(e) => return e,
    };
    if let Some(err) = check_model(&config, &body) {
        return err;
    }
    forward(&config, CHAT_PATH, &cookies.0, &origin.0, body).await
}

#[post("/api/v1/audio/transcriptions", data = "<body_data>")]
async fn transcriptions(
    config: &State<ProxyConfig>,
    cookies: RawCookieHeader,
    origin: RawOriginHeader,
    body_data: Data<'_>,
) -> ProxyResponse {
    let body = match read_capped(body_data, TRANSCRIPTIONS_CAP).await {
        Ok(b) => b,
        Err(e) => return e,
    };
    if let Some(err) = check_model(&config, &body) {
        return err;
    }
    forward(&config, TRANSCRIPTIONS_PATH, &cookies.0, &origin.0, body).await
}

#[launch]
fn rocket() -> Rocket<Build> {
    let openrouter_key = env::var("OPENROUTER_KEY").unwrap_or_else(|_| {
        eprintln!("Set OPENROUTER_KEY in the environment.");
        std::process::exit(1);
    });
    // Fail-closed: no session verifier configured -> no server. Replace this
    // with inline JWT verification (e.g. the `jsonwebtoken` crate) if you'd
    // rather not make the per-request verify call.
    let auth_verify_url = env::var("AUTH_VERIFY_URL").unwrap_or_else(|_| {
        eprintln!("Set AUTH_VERIFY_URL (your app's session-verify endpoint).");
        std::process::exit(1);
    });
    let allowed_origin = env::var("ALLOWED_ORIGIN").ok().filter(|s| !s.is_empty());

    let http = reqwest::Client::builder()
        // ibh's own model timeout is 120s; stay comfortably above it.
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .expect("reqwest client");

    let allowed_models = env::var("ALLOWED_MODELS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    rocket::build()
        .manage(ProxyConfig {
            openrouter_key,
            allowed_models,
            auth_verify_url,
            allowed_origin,
            http,
        })
        .mount("/", routes![chat, transcriptions])
}

// Any other path simply has no route -> Rocket 404s it. That IS the path
// allowlist: exactly two endpoints are proxied, nothing else can be reached.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_chat_usage() {
        let body = serde_json::json!({
            "id": "gen-1",
            "model": "openai/gpt-6-luna",
            "usage": {
                "prompt_tokens": 194,
                "completion_tokens": 2,
                "total_tokens": 196,
                "cost": 0.95,
                "cost_details": { "upstream_inference_cost": 0.19 }
            }
        });
        let usage = extract_usage(&body, None).expect("usage");
        assert_eq!(usage.generation_id.as_deref(), Some("gen-1"));
        assert_eq!(usage.model.as_deref(), Some("openai/gpt-6-luna"));
        assert_eq!(usage.cost, Some(0.95));
        assert_eq!(usage.upstream_inference_cost, Some(0.19));
        assert_eq!(usage.prompt_tokens, Some(194));
        assert_eq!(usage.completion_tokens, Some(2));
        assert_eq!(usage.total_tokens, Some(196));
    }

    #[test]
    fn extracts_stt_usage_and_falls_back_to_header_id() {
        let body = serde_json::json!({
            "text": "hello",
            "usage": {
                "seconds": 9.2,
                "total_tokens": 113,
                "input_tokens": 83,
                "output_tokens": 30,
                "cost": 0.000508
            }
        });
        let usage = extract_usage(&body, Some("gen-stt")).expect("usage");
        assert_eq!(usage.generation_id.as_deref(), Some("gen-stt"));
        assert_eq!(usage.prompt_tokens, Some(83));
        assert_eq!(usage.completion_tokens, Some(30));
        assert_eq!(usage.total_tokens, Some(113));
        assert_eq!(usage.audio_seconds, Some(9.2));
        assert_eq!(usage.cost, Some(0.000508));
    }

    #[test]
    fn prefers_body_id_over_header() {
        let body = serde_json::json!({ "id": "from-body", "usage": {} });
        assert_eq!(
            extract_usage(&body, Some("from-header"))
                .expect("usage")
                .generation_id
                .as_deref(),
            Some("from-body")
        );
    }

    #[test]
    fn no_usage_object_is_none() {
        assert!(extract_usage(&serde_json::json!({ "choices": [] }), None).is_none());
    }
}
