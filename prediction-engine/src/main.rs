// Import the things we need
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket};
use axum::http::{Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::{
    extract::{Json as ExtractJson, Path, Query, State, WebSocketUpgrade},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use chrono;
use futures_util::{sink::SinkExt, stream::StreamExt};
use moka::future::Cache;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

// Import our modules
mod config;
mod database;
mod db_adapter;
mod lmsr_api; // Clean LMSR API using lmsr_core directly
mod lmsr_core;
mod lmsr_multi_core;
mod market_import;
mod metaculus; // Configuration management

#[cfg(test)]
mod integration_tests;
// Removed outdated tests.rs - lmsr_core.rs has comprehensive property-based tests

// DRY helper types and functions
type ApiResult<T> = Result<Json<T>, (axum::http::StatusCode, Json<Value>)>;

// Common error response helper
fn internal_error(message: &str) -> (axum::http::StatusCode, Json<Value>) {
    eprintln!("{}", message);
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "Internal server error"})),
    )
}

// User not found error
fn not_found_error(entity: &str) -> (axum::http::StatusCode, Json<Value>) {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(json!({"error": format!("{} not found", entity)})),
    )
}

// Bad request error for validation failures
fn bad_request_error(message: &str) -> (axum::http::StatusCode, Json<Value>) {
    eprintln!("❌ Bad request: {}", message);
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(json!({"error": message})),
    )
}

async fn auth_guard(State(app_state): State<AppState>, req: Request<Body>, next: Next) -> Response {
    if req.method() == Method::OPTIONS || req.uri().path() == "/health" || req.uri().path() == "/events" {
        return next.run(req).await;
    }

    // 1. Check for x-engine-token (Service-to-Service)
    if let Some(engine_token) = &app_state.auth_token {
        if let Some(provided) = req.headers().get("x-engine-token").and_then(|v| v.to_str().ok()) {
            if provided == engine_token.as_str() {
                return next.run(req).await;
            }
        }
    }

    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": "Unauthorized"})),
    )
        .into_response()
}

// Cache and broadcast helper for score updates
fn invalidate_and_broadcast(app_state: &AppState, event_type: &str, data: Value) {
    app_state.cache.invalidate_all();
    let msg = json!({
        "type": event_type,
        "data": data,
        "timestamp": chrono::Utc::now()
    })
    .to_string();
    let _ = app_state.tx.send(msg);
}

// Global state for WebSocket broadcasting and caching
#[derive(Clone)]
struct AppState {
    db: PgPool,
    tx: broadcast::Sender<String>,
    cache: Cache<String, String>,
    config: config::Config,
    auth_token: Option<String>,
}

// This is our main function - but notice the #[tokio::main] attribute!
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load environment variables from .env file
    dotenv::dotenv().ok();

    println!("🦀 Starting Prediction Engine...");

    // Load configuration from environment
    let config = config::Config::from_env();
    config.print_config();

    // Get database URL from environment variable
    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgres://intellacc_user:supersecretpassword@db:5432/intellaccdb".to_string()
    });

    println!(
        "🔌 Connecting to database: {}",
        database_url.replace(
            &std::env::var("POSTGRES_PASSWORD").unwrap_or_default(),
            "***"
        )
    );

    // Connect to PostgreSQL database
    let pool = database::create_pool(&database_url).await?;

    // Create broadcast channel for real-time updates
    let (tx, _rx) = broadcast::channel::<String>(100);

    // Create cache for performance optimization
    let cache = Cache::builder()
        .max_capacity(1000)
        .time_to_live(Duration::from_secs(300)) // 5 minutes TTL
        .time_to_idle(Duration::from_secs(60)) // 1 minute idle timeout
        .build();

    // Create shared app state
    let auth_token = std::env::var("PREDICTION_ENGINE_AUTH_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if auth_token.is_none() {
        return Err(anyhow::anyhow!(
            "PREDICTION_ENGINE_AUTH_TOKEN is required for prediction-engine startup"
        ));
    }

    let app_state = AppState {
        db: pool,
        tx: tx.clone(),
        cache,
        config,
        auth_token,
    };

    // Create our web application routes with shared state.
    let app = Router::new()
        .route("/", get(hello_world))
        .route("/health", get(health_check))
        .route(
            "/persuasion/score-mature-episodes",
            post(score_mature_persuasion_episodes_endpoint),
        )
        .route("/ws", get(websocket_handler)) // Real-time updates enabled
        .route("/metaculus/sync", get(manual_metaculus_sync))
        .route("/metaculus/bulk-import", get(manual_bulk_import_endpoint))
        .route(
            "/metaculus/limited-import",
            get(manual_limited_import_endpoint),
        )
        .route("/metaculus/sync-categories", get(manual_category_sync))
        .route("/imports/sync-all", post(sync_all_imports_endpoint))
        .route(
            "/imports/sync/:provider",
            post(sync_provider_import_endpoint),
        )
        .route("/imports/status", get(import_status_endpoint))
        // LMSR Market API endpoints
        .route("/events", get(get_events_endpoint))
        .route("/events/:id/market", get(get_market_state_endpoint))
        .route("/events/:id/trades", get(get_event_trades_endpoint))
        .route("/events/:id/update", post(update_market_endpoint))
        .route(
            "/events/:id/update-outcome",
            post(update_market_outcome_endpoint),
        )
        .route("/events/:id/kelly", get(kelly_suggestion_endpoint))
        .route("/events/:id/sell", post(sell_shares_endpoint))
        .route(
            "/events/:id/market-resolve",
            post(resolve_market_event_endpoint),
        )
        .route("/events/:id/shares", get(get_user_shares_endpoint))
        .route("/lmsr/test-invariants", get(test_lmsr_invariants_endpoint))
        // Invariant verification endpoints
        .route(
            "/lmsr/verify-balance-invariant",
            post(verify_balance_invariant_endpoint),
        )
        .route(
            "/lmsr/verify-staked-invariant",
            post(verify_staked_invariant_endpoint),
        )
        .route(
            "/lmsr/verify-post-resolution",
            post(verify_post_resolution_endpoint),
        )
        .route(
            "/lmsr/verify-consistency",
            post(verify_consistency_endpoint),
        )
        .layer(middleware::from_fn_with_state(
            app_state.clone(),
            auth_guard,
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
        )
        .with_state(app_state); // Share app state with all routes

    // Define the address to listen on - bind to all interfaces in Docker
    let addr = SocketAddr::from(([0, 0, 0, 0], 3001));

    println!("🚀 Server running on http://{}", addr);
    println!("📊 Available endpoints (LMSR + persuasion services):");
    println!("  GET /health - Health check");
    println!("  POST /persuasion/score-mature-episodes - Score mature persuasive-alpha episode components");
    println!("  GET /metaculus/sync - Manual sync with Metaculus API (150 recent questions)");
    println!("  GET /metaculus/bulk-import - Complete import of ALL Metaculus questions");
    println!("  GET /metaculus/sync-categories - Manual category sync");
    println!("  POST /imports/sync-all - Sync all configured external market providers");
    println!(
        "  POST /imports/sync/:provider - Sync one provider (metaculus|manifold|polymarket|kalshi)"
    );
    println!("  GET /imports/status - Recent provider sync runs");
    println!("  GET /events/:id/market - Get market state for event");
    println!("  GET /events/:id/trades - Get recent trades for event");
    println!("  POST /events/:id/update - Update market with stake");
    println!("  POST /events/:id/update-outcome - Update N-outcome market with stake");
    println!("  GET /events/:id/kelly - Get Kelly criterion suggestion");
    println!("  POST /events/:id/sell - Sell shares back to market");
    println!("  POST /events/:id/market-resolve - Resolve market event");
    println!("  GET /events/:id/shares - Get user's shares for event");
    println!("  POST /lmsr/verify-balance-invariant - Verify balance invariant");
    println!("  POST /lmsr/verify-staked-invariant - Verify staked invariant");
    println!("  POST /lmsr/verify-post-resolution - Verify post-resolution invariant");
    println!("  POST /lmsr/verify-consistency - Verify system consistency");

    // Start the server
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// This is our first route handler - it returns JSON
async fn hello_world() -> Json<Value> {
    Json(json!({
        "message": "Hello from Rust Prediction Engine! 🦀",
        "status": "running"
    }))
}

// Health check endpoint
async fn health_check() -> Json<Value> {
    Json(json!({
        "status": "healthy",
        "service": "prediction-engine"
    }))
}

// WebSocket handler for real-time updates
async fn websocket_handler(ws: WebSocketUpgrade, State(app_state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| websocket_connection(socket, app_state))
}

// Handle individual WebSocket connections
async fn websocket_connection(socket: WebSocket, app_state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = app_state.tx.subscribe();

    // Spawn task to send updates to client
    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages from client
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(Message::Text(text))) = receiver.next().await {
            // Handle client messages (e.g., subscription requests)
            println!("Received: {}", text);
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}

// Manual Metaculus sync endpoint
async fn manual_metaculus_sync(State(app_state): State<AppState>) -> ApiResult<Value> {
    match metaculus::manual_sync(&app_state.db).await {
        Ok(count) => {
            invalidate_and_broadcast(&app_state, "metaculus_sync", json!({"count": count}));
            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully synced {} new questions from Metaculus", count),
                "count": count
            })))
        }
        Err(e) => Err(internal_error(&format!("Metaculus sync error: {}", e))),
    }
}

// Manual Metaculus bulk import endpoint
async fn manual_bulk_import_endpoint(State(app_state): State<AppState>) -> ApiResult<Value> {
    println!("🚀 Bulk import endpoint called");

    match metaculus::manual_bulk_import(&app_state.db).await {
        Ok(count) => {
            invalidate_and_broadcast(
                &app_state,
                "metaculus_bulk_import",
                json!({"count": count, "type": "bulk_import"}),
            );
            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully imported {} questions from Metaculus (bulk import)", count),
                "count": count,
                "type": "bulk_import"
            })))
        }
        Err(e) => Err(internal_error(&format!(
            "Metaculus bulk import error: {}",
            e
        ))),
    }
}

// Manual Metaculus limited import endpoint
async fn manual_limited_import_endpoint(
    State(app_state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Value> {
    let max_batches: u32 = params
        .get("batches")
        .and_then(|s| s.parse().ok())
        .unwrap_or(5); // Default to 5 batches for testing

    println!(
        "🚀 Limited import endpoint called with max_batches: {}",
        max_batches
    );

    match metaculus::manual_limited_import(&app_state.db, max_batches).await {
        Ok(count) => {
            invalidate_and_broadcast(
                &app_state,
                "metaculus_limited_import",
                json!({
                    "count": count,
                    "max_batches": max_batches,
                    "type": "limited_import"
                }),
            );
            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully imported {} questions from Metaculus (limited to {} batches)", count, max_batches),
                "count": count,
                "max_batches": max_batches,
                "type": "limited_import"
            })))
        }
        Err(e) => Err(internal_error(&format!(
            "Metaculus limited import error: {}",
            e
        ))),
    }
}

// Manual category sync endpoint
async fn manual_category_sync(
    State(app_state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Value> {
    let default_categories = "politics,economics,science".to_string();
    let categories_str = params.get("categories").unwrap_or(&default_categories);
    let categories: Vec<&str> = categories_str.split(',').map(|s| s.trim()).collect();

    match metaculus::manual_category_sync(&app_state.db, categories.clone()).await {
        Ok(count) => {
            invalidate_and_broadcast(
                &app_state,
                "category_sync",
                json!({
                    "categories": categories,
                    "count": count
                }),
            );
            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully synced {} questions from categories: {:?}", count, categories),
                "categories": categories,
                "count": count
            })))
        }
        Err(e) => Err(internal_error(&format!("Category sync error: {}", e))),
    }
}

#[derive(Debug, Deserialize)]
struct ImportStatusQuery {
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ImportSyncQuery {
    full: Option<bool>,
}

async fn sync_all_imports_endpoint(
    State(app_state): State<AppState>,
    Query(params): Query<ImportSyncQuery>,
) -> ApiResult<Value> {
    let full = params.full.unwrap_or(false);
    match market_import::sync_all_markets(&app_state.db, full).await {
        Ok(runs) => {
            invalidate_and_broadcast(
                &app_state,
                "external_import_sync_all",
                json!({ "providers": runs.len(), "full": full }),
            );
            let summary = runs.iter().fold(
                json!({
                    "fetched_count": 0,
                    "excluded_count": 0,
                    "merged_count": 0,
                    "created_count": 0,
                    "linked_count": 0,
                    "error_count": 0
                }),
                |mut acc, run| {
                    acc["fetched_count"] = json!(
                        acc["fetched_count"].as_i64().unwrap_or(0) + run.fetched_count as i64
                    );
                    acc["excluded_count"] = json!(
                        acc["excluded_count"].as_i64().unwrap_or(0) + run.excluded_count as i64
                    );
                    acc["merged_count"] =
                        json!(acc["merged_count"].as_i64().unwrap_or(0) + run.merged_count as i64);
                    acc["created_count"] = json!(
                        acc["created_count"].as_i64().unwrap_or(0) + run.created_count as i64
                    );
                    acc["linked_count"] =
                        json!(acc["linked_count"].as_i64().unwrap_or(0) + run.linked_count as i64);
                    acc["error_count"] =
                        json!(acc["error_count"].as_i64().unwrap_or(0) + run.error_count as i64);
                    acc
                },
            );

            Ok(Json(json!({
                "success": true,
                "full": full,
                "runs": runs,
                "summary": summary
            })))
        }
        Err(e) => Err(internal_error(&format!(
            "External import sync-all error: {}",
            e
        ))),
    }
}

async fn sync_provider_import_endpoint(
    State(app_state): State<AppState>,
    Path(provider): Path<String>,
    Query(params): Query<ImportSyncQuery>,
) -> ApiResult<Value> {
    let full = params.full.unwrap_or(false);
    match market_import::sync_provider_named(&app_state.db, &provider, full).await {
        Ok(run) => {
            invalidate_and_broadcast(
                &app_state,
                "external_import_sync_provider",
                json!({ "provider": provider, "full": full }),
            );
            Ok(Json(json!({
                "success": true,
                "full": full,
                "run": run
            })))
        }
        Err(e) => Err(internal_error(&format!(
            "External import sync-provider error: {}",
            e
        ))),
    }
}

async fn import_status_endpoint(
    State(app_state): State<AppState>,
    Query(params): Query<ImportStatusQuery>,
) -> ApiResult<Value> {
    let limit = params.limit.unwrap_or(25).clamp(1, 200);
    match market_import::get_recent_import_runs(&app_state.db, limit).await {
        Ok(runs) => Ok(Json(json!({
            "success": true,
            "limit": limit,
            "runs": runs
        }))),
        Err(e) => Err(internal_error(&format!(
            "External import status error: {}",
            e
        ))),
    }
}

#[derive(Debug, Deserialize)]
struct ScoreMatureEpisodesRequest {
    #[serde(default)]
    episode_ids: Option<Vec<i32>>,
}

// Score mature persuasive-alpha episode components directly in prediction-engine.
// Backend callers only persist + mint from these engine-produced scores.
async fn score_mature_persuasion_episodes_endpoint(
    State(app_state): State<AppState>,
    ExtractJson(payload): ExtractJson<ScoreMatureEpisodesRequest>,
) -> ApiResult<Value> {
    match score_mature_persuasion_episodes(&app_state.db, payload.episode_ids.as_deref()).await {
        Ok((processed_episodes, updated_components)) => Ok(Json(json!({
            "success": true,
            "processed_episodes": processed_episodes,
            "updated_components": updated_components
        }))),
        Err(e) => Err(internal_error(&format!(
            "Persuasion mature scoring error: {}",
            e
        ))),
    }
}

async fn score_mature_persuasion_episodes(
    pool: &PgPool,
    episode_ids: Option<&[i32]>,
) -> Result<(i32, i32), anyhow::Error> {
    let rows = if let Some(ids) = episode_ids {
        if ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query(
                r#"
                SELECT
                  pse.id,
                  pse.event_id,
                  pse.market_update_id,
                  pse.p_before,
                  pse.p_after,
                  pse.s_early,
                  pse.s_mid,
                  pse.s_final,
                  mu.created_at AS update_ts,
                  e.closing_date AT TIME ZONE 'UTC' AS closing_date,
                  e.outcome,
                  e.market_prob AS fallback_prob
                FROM post_signal_episodes pse
                JOIN market_updates mu ON mu.id = pse.market_update_id
                JOIN events e ON e.id = pse.event_id
                WHERE pse.is_meaningful = TRUE
                  AND pse.id = ANY($1)
                  AND (pse.s_early IS NULL OR pse.s_mid IS NULL OR (pse.s_final IS NULL AND e.outcome IS NOT NULL))
                ORDER BY pse.id ASC
                "#,
            )
            .bind(ids)
            .fetch_all(pool)
            .await?
        }
    } else {
        sqlx::query(
            r#"
            SELECT
              pse.id,
              pse.event_id,
              pse.market_update_id,
              pse.p_before,
              pse.p_after,
              pse.s_early,
              pse.s_mid,
              pse.s_final,
              mu.created_at AS update_ts,
              e.closing_date AT TIME ZONE 'UTC' AS closing_date,
              e.outcome,
              e.market_prob AS fallback_prob
            FROM post_signal_episodes pse
            JOIN market_updates mu ON mu.id = pse.market_update_id
            JOIN events e ON e.id = pse.event_id
            WHERE pse.is_meaningful = TRUE
              AND (pse.s_early IS NULL OR pse.s_mid IS NULL OR (pse.s_final IS NULL AND e.outcome IS NOT NULL))
            ORDER BY pse.id ASC
            LIMIT 2000
            "#,
        )
        .fetch_all(pool)
        .await?
    };

    let mut processed_episodes = 0_i32;
    let mut updated_components = 0_i32;
    let now = chrono::Utc::now();

    for row in rows {
        processed_episodes += 1;

        let episode_id: i32 = row.get("id");
        let event_id: i32 = row.get("event_id");
        let p_before: f64 = row.get("p_before");
        let p_after: f64 = row.get("p_after");
        let s_early_existing: Option<f64> = row.get("s_early");
        let s_mid_existing: Option<f64> = row.get("s_mid");
        let s_final_existing: Option<f64> = row.get("s_final");
        let update_ts: chrono::DateTime<chrono::Utc> = row.get("update_ts");
        let closing_date: chrono::DateTime<chrono::Utc> = row.get("closing_date");
        let outcome_raw: Option<String> = row.get("outcome");
        let fallback_prob: f64 = row.get("fallback_prob");

        let remaining = closing_date.signed_duration_since(update_ts);
        let remaining_ms = remaining.num_milliseconds().max(0);

        let early_target_ts =
            update_ts + chrono::Duration::milliseconds((remaining_ms as f64 * 0.10).round() as i64);
        let mid_target_ts =
            update_ts + chrono::Duration::milliseconds((remaining_ms as f64 * 0.50).round() as i64);

        let mut set_fragments: Vec<String> = Vec::new();
        let mut bind_values: Vec<f64> = Vec::new();

        if s_early_existing.is_none() && early_target_ts < closing_date && now >= early_target_ts {
            let target =
                get_market_prob_at_or_before(pool, event_id, early_target_ts, fallback_prob)
                    .await?;
            let score = episode_log_score_delta(target, p_before, p_after);
            set_fragments.push(format!("s_early = ${}", bind_values.len() + 1));
            bind_values.push(score);
            set_fragments.push("finalized_early_at = NOW()".to_string());
            updated_components += 1;
        }

        if s_mid_existing.is_none() && mid_target_ts < closing_date && now >= mid_target_ts {
            let target =
                get_market_prob_at_or_before(pool, event_id, mid_target_ts, fallback_prob).await?;
            set_fragments.push(format!("s_mid = ${}", bind_values.len() + 1));
            bind_values.push(episode_log_score_delta(target, p_before, p_after));
            set_fragments.push("finalized_mid_at = NOW()".to_string());
            updated_components += 1;
        }

        if s_final_existing.is_none() {
            if let Some(target_final) = parse_final_target(outcome_raw.as_deref()) {
                set_fragments.push(format!("s_final = ${}", bind_values.len() + 1));
                bind_values.push(episode_log_score_delta(target_final, p_before, p_after));
                set_fragments.push("finalized_final_at = NOW()".to_string());
                updated_components += 1;
            }
        }

        if !set_fragments.is_empty() {
            let query = format!(
                "UPDATE post_signal_episodes SET {} WHERE id = ${}",
                set_fragments.join(", "),
                bind_values.len() + 1
            );

            let mut q = sqlx::query(&query);
            for value in bind_values {
                q = q.bind(value);
            }
            q.bind(episode_id).execute(pool).await?;
        }
    }

    Ok((processed_episodes, updated_components))
}

async fn get_market_prob_at_or_before(
    pool: &PgPool,
    event_id: i32,
    ts: chrono::DateTime<chrono::Utc>,
    fallback_prob: f64,
) -> Result<f64, anyhow::Error> {
    let row = sqlx::query(
        r#"
        SELECT new_prob
        FROM market_updates
        WHERE event_id = $1
          AND created_at <= $2
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(event_id)
    .bind(ts)
    .fetch_optional(pool)
    .await?;

    if let Some(found) = row {
        let value: f64 = found.get("new_prob");
        Ok(value)
    } else {
        Ok(fallback_prob)
    }
}

fn parse_final_target(outcome: Option<&str>) -> Option<f64> {
    let value = outcome?.to_ascii_lowercase();
    match value.as_str() {
        "yes" | "true" | "1" | "correct" => Some(1.0),
        "no" | "false" | "0" | "incorrect" => Some(0.0),
        _ => None,
    }
}

fn episode_log_score_delta(target: f64, p_before: f64, p_after: f64) -> f64 {
    let floor = 0.0001_f64;
    let clamp01 = |p: f64| p.clamp(0.0, 1.0);
    let t = clamp01(target);
    let pb = clamp01(p_before);
    let pa = clamp01(p_after);

    let ll_before = -(t * (pb.max(floor)).ln() + (1.0 - t) * ((1.0 - pb).max(floor)).ln());
    let ll_after = -(t * (pa.max(floor)).ln() + (1.0 - t) * ((1.0 - pa).max(floor)).ln());
    (ll_before - ll_after).max(0.0)
}

// ============================================================================
// LMSR MARKET API ENDPOINTS
// ============================================================================

// Get all events
async fn get_events_endpoint(
    State(app_state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Value> {
    let limit: i64 = params
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);

    // Limit maximum to 1000 to prevent database strain
    let limit = limit.min(1000);

    match database::get_events(&app_state.db, limit).await {
        Ok(events) => Ok(Json(json!(events))),
        Err(e) => Err(internal_error(&format!("Events fetch error: {}", e))),
    }
}

// Get market state for an event
async fn get_market_state_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
) -> ApiResult<Value> {
    match lmsr_api::get_market_state(&app_state.db, event_id).await {
        Ok(market_state) => Ok(Json(market_state)),
        Err(e) => Err(internal_error(&format!("Market state error: {}", e))),
    }
}

// Get recent trades for an event
async fn get_event_trades_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Value> {
    let limit: i32 = params
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);

    // Cap at 100 trades max
    let limit = limit.min(100);

    match lmsr_api::get_event_trades(&app_state.db, event_id, limit).await {
        Ok(trades) => Ok(Json(trades)),
        Err(e) => Err(internal_error(&format!("Trades fetch error: {}", e))),
    }
}

// Update market with new stake
async fn update_market_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate event_id
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    // Validate user_id - require explicit value, no defaults
    let user_id = payload
        .get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid user_id: must be a positive integer")
        })? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    // Validate target_prob - require explicit value, no defaults
    let target_prob = payload
        .get("target_prob")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid target_prob: must be a finite number")
        })?;
    if !target_prob.is_finite() {
        return Err(bad_request_error("Invalid target_prob: must be finite"));
    }
    if target_prob <= 0.0 || target_prob >= 1.0 {
        return Err(bad_request_error(
            "Invalid target_prob: must be between 0 and 1 (exclusive)",
        ));
    }

    // Validate stake - require explicit value, no defaults
    let stake = payload
        .get("stake")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| bad_request_error("Missing or invalid stake: must be a finite number"))?;
    if !stake.is_finite() {
        return Err(bad_request_error("Invalid stake: must be finite"));
    }
    if stake <= 0.0 {
        return Err(bad_request_error("Invalid stake: must be positive"));
    }
    if stake > 1_000_000.0 {
        // 1M RP max per trade
        return Err(bad_request_error(
            "Invalid stake: exceeds maximum allowed (1,000,000 RP)",
        ));
    }
    if stake < 0.01 {
        // Minimum 0.01 RP
        return Err(bad_request_error(
            "Invalid stake: below minimum allowed (0.01 RP)",
        ));
    }

    let update = lmsr_api::MarketUpdate {
        event_id,
        target_prob,
        stake,
        referral_post_id: payload
            .get("referral_post_id")
            .and_then(|value| value.as_i64())
            .filter(|value| *value > 0)
            .map(|value| value as i32),
        referral_click_id: payload
            .get("referral_click_id")
            .and_then(|value| value.as_i64())
            .filter(|value| *value > 0)
            .map(|value| value as i32),
    };

    match lmsr_api::update_market(&app_state.db, &app_state.config, user_id, update).await {
        Ok(result) => {
            invalidate_and_broadcast(
                &app_state,
                "market_updated",
                json!({
                    "event_id": event_id,
                    "user_id": user_id,
                    "new_prob": result.new_prob,
                    "shares_acquired": result.shares_acquired
                }),
            );
            Ok(Json(json!(result)))
        }
        Err(e) => {
            let msg = e.to_string();
            let msg_lower = msg.to_lowercase();
            if msg_lower.contains("market resolved") {
                return Err(bad_request_error("Market resolved"));
            }
            if msg_lower.contains("market closed") {
                return Err(bad_request_error("Market closed"));
            }
            if msg_lower.contains("outcome-based endpoint") {
                return Err(bad_request_error(
                    "Use /events/:id/update-outcome for this market type",
                ));
            }
            Err(internal_error(&format!("Market update error: {}", msg)))
        }
    }
}

// Update market for an explicit outcome (multiple choice / numeric buckets)
async fn update_market_outcome_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    let user_id = payload
        .get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid user_id: must be a positive integer")
        })? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    let outcome_id = payload
        .get("outcome_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| bad_request_error("Missing or invalid outcome_id"))?;
    if outcome_id <= 0 {
        return Err(bad_request_error("Invalid outcome_id: must be positive"));
    }

    let stake = payload
        .get("stake")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| bad_request_error("Missing or invalid stake: must be a finite number"))?;
    if !stake.is_finite() {
        return Err(bad_request_error("Invalid stake: must be finite"));
    }
    if !(0.01..=1_000_000.0).contains(&stake) {
        return Err(bad_request_error(
            "Invalid stake: must be within [0.01, 1,000,000] RP",
        ));
    }

    let update = lmsr_api::OutcomeMarketUpdate {
        event_id,
        outcome_id,
        stake,
        referral_post_id: payload
            .get("referral_post_id")
            .and_then(|value| value.as_i64())
            .filter(|value| *value > 0)
            .map(|value| value as i32),
        referral_click_id: payload
            .get("referral_click_id")
            .and_then(|value| value.as_i64())
            .filter(|value| *value > 0)
            .map(|value| value as i32),
    };

    match lmsr_api::update_market_outcome(&app_state.db, &app_state.config, user_id, update).await {
        Ok(result) => {
            invalidate_and_broadcast(
                &app_state,
                "market_updated",
                json!({
                    "event_id": event_id,
                    "user_id": user_id,
                    "new_prob": result.market_prob,
                    "outcome_id": result.outcome_id
                }),
            );
            Ok(Json(json!(result)))
        }
        Err(e) => {
            let msg = e.to_string();
            let msg_lower = msg.to_lowercase();
            if msg_lower.contains("market resolved") {
                return Err(bad_request_error("Market resolved"));
            }
            if msg_lower.contains("market closed") {
                return Err(bad_request_error("Market closed"));
            }
            if msg_lower.contains("no configured outcomes")
                || msg_lower.contains("selected outcome")
                || msg_lower.contains("binary markets")
            {
                return Err(bad_request_error(&msg));
            }
            Err(internal_error(&format!(
                "Market outcome update error: {}",
                msg
            )))
        }
    }
}

// Get Kelly criterion betting suggestion
async fn kelly_suggestion_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Value> {
    // Validate event_id
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    // Validate belief probability - require explicit value, no defaults
    let belief = params
        .get("belief")
        .and_then(|s| s.parse::<f64>().ok())
        .ok_or_else(|| bad_request_error("Missing or invalid belief: must be a finite number"))?;
    if !belief.is_finite() {
        return Err(bad_request_error("Invalid belief: must be finite"));
    }
    if belief <= 0.0 || belief >= 1.0 {
        return Err(bad_request_error(
            "Invalid belief: must be between 0 and 1 (exclusive)",
        ));
    }

    // Validate user_id - require explicit value, no defaults
    let user_id = params
        .get("user_id")
        .and_then(|s| s.parse::<i32>().ok())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid user_id: must be a positive integer")
        })?;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    // Get current market probability
    let market_prob_result: Result<f64, sqlx::Error> =
        sqlx::query_scalar("SELECT market_prob FROM events WHERE id = $1")
            .bind(event_id)
            .fetch_one(&app_state.db)
            .await;

    let market_prob = match market_prob_result {
        Ok(prob) => prob,
        Err(_) => return Err(not_found_error("Event")),
    };

    // Get user balance from ledger
    let balance_ledger_result: Result<i64, sqlx::Error> =
        sqlx::query_scalar("SELECT rp_balance_ledger FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(&app_state.db)
            .await;

    let balance = match balance_ledger_result {
        Ok(bal) => lmsr_core::from_ledger_units(bal as i128),
        Err(_) => return Err(not_found_error("User")),
    };

    let suggestion = lmsr_api::kelly_suggestion(&app_state.config, belief, market_prob, balance);
    Ok(Json(json!(suggestion)))
}

// Sell shares back to market
async fn sell_shares_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate event_id
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    // Validate user_id - require explicit value, no defaults
    let user_id = payload
        .get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid user_id: must be a positive integer")
        })? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    // Validate share_type - require explicit value, no defaults
    let share_type = payload
        .get("share_type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| bad_request_error("Missing or invalid share_type: must be 'yes' or 'no'"))?;
    if share_type != "yes" && share_type != "no" {
        return Err(bad_request_error(
            "Invalid share_type: must be 'yes' or 'no'",
        ));
    }

    // Validate amount - require explicit value, no defaults
    let amount = payload
        .get("amount")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| bad_request_error("Missing or invalid amount: must be a finite number"))?;
    if !amount.is_finite() {
        return Err(bad_request_error("Invalid amount: must be finite"));
    }
    if amount <= 0.0 {
        return Err(bad_request_error("Invalid amount: must be positive"));
    }
    if amount > 10_000_000.0 {
        // 10M shares max per sale
        return Err(bad_request_error(
            "Invalid amount: exceeds maximum allowed (10,000,000 shares)",
        ));
    }
    if amount < 0.000001 {
        // Minimum 0.000001 shares (1 micro-share)
        return Err(bad_request_error(
            "Invalid amount: below minimum allowed (0.000001 shares)",
        ));
    }

    match lmsr_api::sell_shares(
        &app_state.db,
        &app_state.config,
        user_id,
        event_id,
        share_type,
        amount,
    )
    .await
    {
        Ok(result) => {
            invalidate_and_broadcast(
                &app_state,
                "shares_sold",
                json!({
                    "event_id": event_id,
                    "user_id": user_id,
                    "share_type": share_type,
                    "amount": amount,
                    "payout": result.payout,
                    "new_prob": result.new_prob,
                    "cumulative_stake": result.current_cost_c
                }),
            );
            Ok(Json(json!({
                "success": true,
                "payout": result.payout,
                "new_prob": result.new_prob,
                "cumulative_stake": result.current_cost_c,
                "message": format!("Sold {} {} shares for {} RP", amount, share_type, result.payout)
            })))
        }
        Err(e) => {
            let msg = e.to_string();
            let msg_lower = msg.to_lowercase();
            if msg_lower.contains("hold period not expired") {
                return Err(bad_request_error(
                    "Hold period not expired for recent purchases",
                ));
            }
            if msg_lower.contains("market resolved") {
                return Err(bad_request_error("Market resolved"));
            }
            if msg_lower.contains("market closed") {
                return Err(bad_request_error("Market closed"));
            }
            Err(internal_error(&format!("Share sale error: {}", msg)))
        }
    }
}

// Get user's shares for an event
async fn get_user_shares_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Value> {
    let user_id = params
        .get("user_id")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(1);

    match lmsr_api::get_user_shares(&app_state.db, user_id, event_id).await {
        Ok(shares) => Ok(Json(shares)),
        Err(e) => Err(internal_error(&format!("User shares error: {}", e))),
    }
}

// Resolve market event (LMSR)
async fn resolve_market_event_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate event_id
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    if let Some(outcome_id) = payload.get("outcome_id").and_then(|v| v.as_i64()) {
        if outcome_id <= 0 {
            return Err(bad_request_error("Invalid outcome_id: must be positive"));
        }
        match lmsr_api::resolve_event_by_outcome_id(&app_state.db, event_id, outcome_id, None).await
        {
            Ok(()) => {
                invalidate_and_broadcast(
                    &app_state,
                    "marketResolved",
                    json!({
                        "eventId": event_id,
                        "outcome_id": outcome_id,
                        "timestamp": chrono::Utc::now().to_rfc3339()
                    }),
                );
                return Ok(Json(json!({
                    "success": true,
                    "event_id": event_id,
                    "outcome_id": outcome_id,
                    "message": format!("Market event {} resolved with outcome {}", event_id, outcome_id)
                })));
            }
            Err(e) => return Err(internal_error(&format!("Market resolution error: {}", e))),
        }
    }

    if let Some(numerical_outcome) = payload.get("numerical_outcome").and_then(|v| v.as_f64()) {
        if !numerical_outcome.is_finite() {
            return Err(bad_request_error("numerical_outcome must be finite"));
        }
        match lmsr_api::resolve_numeric_event(&app_state.db, event_id, numerical_outcome).await {
            Ok(outcome_id) => {
                invalidate_and_broadcast(
                    &app_state,
                    "marketResolved",
                    json!({
                        "eventId": event_id,
                        "outcome_id": outcome_id,
                        "numerical_outcome": numerical_outcome,
                        "timestamp": chrono::Utc::now().to_rfc3339()
                    }),
                );
                return Ok(Json(json!({
                    "success": true,
                    "event_id": event_id,
                    "outcome_id": outcome_id,
                    "numerical_outcome": numerical_outcome,
                    "message": format!("Numeric market {} resolved into bucket {}", event_id, outcome_id)
                })));
            }
            Err(e) => {
                return Err(internal_error(&format!(
                    "Numeric market resolution error: {}",
                    e
                )))
            }
        }
    }

    let outcome = payload
        .get("outcome")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| {
            bad_request_error("Provide one of: outcome (bool), outcome_id, or numerical_outcome")
        })?;

    match lmsr_api::resolve_event(&app_state.db, event_id, outcome).await {
        Ok(()) => {
            invalidate_and_broadcast(
                &app_state,
                "marketResolved",
                json!({
                    "eventId": event_id,
                    "outcome": outcome,
                    "timestamp": chrono::Utc::now().to_rfc3339()
                }),
            );
            Ok(Json(json!({
                "success": true,
                "event_id": event_id,
                "outcome": outcome,
                "message": format!("Market event {} resolved as {}", event_id, if outcome { "YES" } else { "NO" })
            })))
        }
        Err(e) => Err(internal_error(&format!("Market resolution error: {}", e))),
    }
}

// Test LMSR invariants using property-based tests
async fn test_lmsr_invariants_endpoint(State(_app_state): State<AppState>) -> ApiResult<Value> {
    println!("🧪 Running LMSR invariant tests...");

    // Run a simplified version of the property tests
    let mut success_count = 0;
    let mut total_tests = 0;
    let mut failed_tests = Vec::new();

    // Test round-trip invariant with a few fixed cases
    let test_cases = vec![
        (5000.0, vec![10_000_000i128, 50_000_000i128], vec![0u8, 1u8]),
        (
            1000.0,
            vec![5_000_000i128, 25_000_000i128, 10_000_000i128],
            vec![0u8, 1u8, 0u8],
        ),
        (10000.0, vec![100_000_000i128], vec![1u8]),
    ];

    for (i, (b, stakes, sides)) in test_cases.iter().enumerate() {
        total_tests += 1;

        let mut mkt = crate::lmsr_core::Market::new(*b);
        let mut cash_ledger: i128 = 0;
        let mut yes_shares: f64 = 0.0;
        let mut no_shares: f64 = 0.0;

        // Execute trades
        for j in 0..stakes.len().min(sides.len()) {
            let stake_ledger = stakes[j];

            if sides[j] == 0 {
                let (dq, cash_debit) = mkt.buy_yes(stake_ledger).unwrap();
                yes_shares += dq;
                cash_ledger -= cash_debit;
            } else {
                let (dq, cash_debit) = mkt.buy_no(stake_ledger).unwrap();
                no_shares += dq;
                cash_ledger -= cash_debit;
            }
        }

        // Unwind positions
        let cash_credit_yes = if yes_shares > 0.0 {
            mkt.sell_yes(yes_shares).unwrap()
        } else {
            0
        };
        let cash_credit_no = if no_shares > 0.0 {
            mkt.sell_no(no_shares).unwrap()
        } else {
            0
        };

        cash_ledger += cash_credit_yes + cash_credit_no;

        // Check invariants
        if cash_ledger.abs() <= 1 && mkt.q_yes.abs() < 1e-9 && mkt.q_no.abs() < 1e-9 {
            success_count += 1;
        } else {
            failed_tests.push(format!(
                "Test case {}: cash_ledger={}, q_yes={:.2e}, q_no={:.2e}",
                i, cash_ledger, mkt.q_yes, mkt.q_no
            ));
        }
    }

    // Test probability bounds
    let mut prob_tests = 0;
    let mut prob_success = 0;

    for b in vec![1000.0, 5000.0, 10000.0] {
        let mut m = crate::lmsr_core::Market::new(b);
        for stake in vec![1_000_000i128, 10_000_000i128, 50_000_000i128] {
            prob_tests += 1;
            let (_dq, _cash) = m.buy_yes(stake).unwrap();
            let p = m.prob_yes();
            if p > 0.0 && p < 1.0 {
                prob_success += 1;
            } else {
                failed_tests.push(format!("Probability out of bounds: p={}", p));
            }
        }
    }

    println!(
        "✅ LMSR tests completed: {}/{} round-trip tests passed, {}/{} probability tests passed",
        success_count, total_tests, prob_success, prob_tests
    );

    let all_passed = success_count == total_tests && prob_success == prob_tests;

    Ok(Json(json!({
        "success": all_passed,
        "round_trip_tests": {
            "passed": success_count,
            "total": total_tests
        },
        "probability_tests": {
            "passed": prob_success,
            "total": prob_tests
        },
        "failed_tests": failed_tests,
        "message": if all_passed {
            "All LMSR invariant tests passed!"
        } else {
            "Some LMSR invariant tests failed - see failed_tests for details"
        }
    })))
}

// ============================================================================
// INVARIANT VERIFICATION ENDPOINTS
// ============================================================================

// Verify balance invariant
async fn verify_balance_invariant_endpoint(
    State(app_state): State<AppState>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate user_id - require explicit value, no defaults
    let user_id = payload
        .get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid user_id: must be a positive integer")
        })? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    match lmsr_api::verify_balance_invariant(&app_state.db, user_id).await {
        Ok(result) => Ok(Json(result)),
        Err(e) => Err(internal_error(&format!(
            "Balance invariant verification error: {}",
            e
        ))),
    }
}

// Verify staked invariant
async fn verify_staked_invariant_endpoint(
    State(app_state): State<AppState>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate user_id - require explicit value, no defaults
    let user_id = payload
        .get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid user_id: must be a positive integer")
        })? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    match lmsr_api::verify_staked_invariant(&app_state.db, user_id).await {
        Ok(result) => Ok(Json(result)),
        Err(e) => Err(internal_error(&format!(
            "Staked invariant verification error: {}",
            e
        ))),
    }
}

// Verify post-resolution invariant
async fn verify_post_resolution_endpoint(
    State(app_state): State<AppState>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate event_id - require explicit value, no defaults
    let event_id = payload
        .get("event_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid event_id: must be a positive integer")
        })? as i32;
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    match lmsr_api::verify_post_resolution_invariant(&app_state.db, event_id).await {
        Ok(result) => Ok(Json(result)),
        Err(e) => Err(internal_error(&format!(
            "Post-resolution invariant verification error: {}",
            e
        ))),
    }
}

// Verify system consistency
async fn verify_consistency_endpoint(
    State(app_state): State<AppState>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate event_id - require explicit value, no defaults
    let event_id = payload
        .get("event_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            bad_request_error("Missing or invalid event_id: must be a positive integer")
        })? as i32;
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    match lmsr_api::verify_system_consistency(&app_state.db, event_id).await {
        Ok(result) => Ok(Json(result)),
        Err(e) => Err(internal_error(&format!(
            "System consistency verification error: {}",
            e
        ))),
    }
}
