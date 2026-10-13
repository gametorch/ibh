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
//! REPLACEME: `verify_session` below is the ONE thing you should replace or
//! point at your real session verifier. Like the reference node proxy, the
//! default delegates to your app's session-verify endpoint over HTTP.

use rocket::data::ByteUnit;
use rocket::futures::TryStreamExt;
use rocket::http::{ContentType, Status};
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

async fn verify_session(client: &reqwest::Client, verify_url: &str, cookie_header: &Option<String>) -> bool {
    match cookie_header {
        Some(c) if !c.is_empty() => {
            match client.get(verify_url).header("Cookie", c.as_str()).send().await {
                Ok(res) => res.status().is_success(),
                Err(_) => false,
            }
        }
        _ => false,
    }
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

    if !verify_session(&config.http, &config.auth_verify_url, cookie_header).await {
        return error_json(Status::Forbidden, "forbidden");
    }

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
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| ContentType::parse_flexible(s))
        .unwrap_or(ContentType::JSON);

    // success bodies stream (bounded memory); error bodies are small and buffered
    if upstream.status().is_success() {
        let stream = upstream
            .bytes_stream()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e));
        let reader = StreamReader::new(stream);
        ProxyResponse(
            rocket::response::Response::build()
                .status(status)
                .header(content_type)
                .streamed_body(reader)
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
