// Import the things we need
use axum::{
    extract::{Path, State, WebSocketUpgrade, Query, Json as ExtractJson},
    response::{Json, Response},
    routing::{get, post},
    Router,
};
use tower_http::cors::CorsLayer;
use serde_json::{json, Value};
use sqlx::PgPool;
use rust_decimal::Decimal;
use rust_decimal::prelude::{ToPrimitive, FromPrimitive};
use std::net::SocketAddr;
use std::collections::HashMap;
use axum::extract::ws::{WebSocket, Message};
use futures_util::{sink::SinkExt, stream::StreamExt};
use tokio::sync::broadcast;
use chrono;
use moka::future::Cache;
use std::time::Duration;

// Import our modules
mod database;
mod metaculus;
mod benchmark;
mod lmsr_api;  // Clean LMSR API using lmsr_core directly
mod lmsr_core;
mod db_adapter;
mod config;  // Configuration management
mod stress;  // Comprehensive stress tests

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
        Json(json!({"error": "Internal server error"}))
    )
}

// User not found error
fn not_found_error(entity: &str) -> (axum::http::StatusCode, Json<Value>) {
    (
        axum::http::StatusCode::NOT_FOUND,
        Json(json!({"error": format!("{} not found", entity)}))
    )
}

// Bad request error for validation failures
fn bad_request_error(message: &str) -> (axum::http::StatusCode, Json<Value>) {
    eprintln!("❌ Bad request: {}", message);
    (
        axum::http::StatusCode::BAD_REQUEST,
        Json(json!({"error": message}))
    )
}

// Cache and broadcast helper for score updates
fn invalidate_and_broadcast(app_state: &AppState, event_type: &str, data: Value) {
    app_state.cache.invalidate_all();
    let msg = json!({
        "type": event_type,
        "data": data,
        "timestamp": chrono::Utc::now()
    }).to_string();
    let _ = app_state.tx.send(msg);
}

// JSON mapping helper for UserAccuracy
fn map_user_accuracy_to_json(accuracy: &database::UserAccuracy) -> Value {
    json!({
        "user_id": accuracy.user_id,
        "username": accuracy.username,
        "total_predictions": accuracy.total_predictions,
        "correct_predictions": accuracy.correct_predictions,
        "accuracy_rate": accuracy.accuracy_rate,
        "weighted_accuracy": accuracy.weighted_accuracy,
        "log_loss": accuracy.log_loss
    })
}

// Cache helper with generic key and data
async fn get_or_cache<T, F, Fut>(
    cache: &Cache<String, String>,
    key: &str,
    fetch_fn: F,
) -> ApiResult<Value>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, anyhow::Error>>,
    T: serde::Serialize,
{
    // Check cache first
    if let Some(cached_result) = cache.get(key).await {
        if let Ok(cached_json) = serde_json::from_str::<Value>(&cached_result) {
            return Ok(Json(cached_json));
        }
    }

    // Fetch fresh data
    match fetch_fn().await {
        Ok(data) => {
            let result = json!(data);
            // Cache the result
            if let Ok(result_str) = serde_json::to_string(&result) {
                cache.insert(key.to_string(), result_str).await;
            }
            Ok(Json(result))
        },
        Err(e) => Err(internal_error(&format!("Database error: {}", e)))
    }
}

// Global state for WebSocket broadcasting and caching
#[derive(Clone)]
struct AppState {
    db: PgPool,
    tx: broadcast::Sender<String>,
    cache: Cache<String, String>,
    config: config::Config,
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
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://intellacc_user:supersecretpassword@db:5432/intellaccdb".to_string());
    
    println!("🔌 Connecting to database: {}", database_url.replace(&std::env::var("POSTGRES_PASSWORD").unwrap_or_default(), "***"));
    
    // Connect to PostgreSQL database
    let pool = database::create_pool(&database_url).await?;

    // Create broadcast channel for real-time updates
    let (tx, _rx) = broadcast::channel::<String>(100);
    
    // Create cache for performance optimization
    let cache = Cache::builder()
        .max_capacity(1000)
        .time_to_live(Duration::from_secs(300)) // 5 minutes TTL
        .time_to_idle(Duration::from_secs(60))  // 1 minute idle timeout
        .build();
    
    // Create shared app state
    let app_state = AppState {
        db: pool,
        tx: tx.clone(),
        cache,
        config,
    };

    // Clone pool for background task before moving app_state
    let pool_clone = app_state.db.clone();

    // Create our web application routes with shared state - UNIFIED LOG SCORING ONLY
    let app = Router::new()
        .route("/", get(hello_world))
        .route("/health", get(health_check))
        .route("/user/:user_id/accuracy", get(get_user_accuracy))
        .route("/user/:user_id/enhanced-accuracy", get(get_enhanced_user_accuracy))
        .route("/user/:user_id/calibration", get(get_user_calibration))
        .route("/user/:user_id/numerical-accuracy", get(get_user_numerical_accuracy))
        .route("/numerical-scores/update", get(update_numerical_scores))
        .route("/leaderboard", get(get_leaderboard))
        .route("/enhanced-leaderboard", get(get_enhanced_leaderboard))
        // Unified log scoring system endpoints (ALL-LOG + PLL)
        .route("/log-scoring/calculate", get(calculate_log_scores_endpoint))
        .route("/log-scoring/time-weights", get(calculate_time_weights_endpoint))
        .route("/log-scoring/leaderboard", get(get_log_scoring_leaderboard))
        .route("/user/:user_id/reputation", get(get_user_reputation_endpoint))
        .route("/user/:user_id/update-reputation", get(update_user_reputation_endpoint))
        // Event resolution and ranking endpoints
        .route("/resolve-event/:event_id", axum::routing::post(resolve_event_endpoint))
        .route("/rankings/update-global", get(update_global_rankings_endpoint))
        .route("/ws", get(websocket_handler)) // Real-time updates enabled
        .route("/benchmark/scoring", get(run_scoring_benchmark_endpoint))
        .route("/metaculus/sync", get(manual_metaculus_sync))
        .route("/metaculus/bulk-import", get(manual_bulk_import_endpoint))
        .route("/metaculus/limited-import", get(manual_limited_import_endpoint))
        .route("/metaculus/sync-categories", get(manual_category_sync))
        // LMSR Market API endpoints
        .route("/events/:id/market", get(get_market_state_endpoint))
        .route("/events/:id/trades", get(get_event_trades_endpoint))
        .route("/events/:id/update", post(update_market_endpoint))
        .route("/events/:id/kelly", get(kelly_suggestion_endpoint))
        .route("/events/:id/sell", post(sell_shares_endpoint))
        .route("/events/:id/market-resolve", post(resolve_market_event_endpoint))
        .route("/events/:id/shares", get(get_user_shares_endpoint))
        .route("/lmsr/test-invariants", get(test_lmsr_invariants_endpoint))
        // Invariant verification endpoints
        .route("/lmsr/verify-balance-invariant", post(verify_balance_invariant_endpoint))
        .route("/lmsr/verify-staked-invariant", post(verify_staked_invariant_endpoint))
        .route("/lmsr/verify-post-resolution", post(verify_post_resolution_endpoint))
        .route("/lmsr/verify-consistency", post(verify_consistency_endpoint))
        .layer(
            CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any)
        )
        .with_state(app_state); // Share app state with all routes

    // Define the address to listen on - bind to all interfaces in Docker
    let addr = SocketAddr::from(([0, 0, 0, 0], 3001));
    
    println!("🚀 Server running on http://{}", addr);
    println!("📊 Available endpoints (UNIFIED LOG SCORING SYSTEM):");
    println!("  GET /health - Health check");
    println!("  GET /user/:user_id/accuracy - Get basic user prediction accuracy");
    println!("  GET /user/:user_id/enhanced-accuracy - Get enhanced accuracy with log scores");
    println!("  GET /user/:user_id/calibration - Get user calibration data");
    println!("  GET /user/:user_id/numerical-accuracy - Get numerical prediction accuracy");
    println!("  GET /numerical-scores/update - Update numerical scores for resolved predictions");
    println!("  GET /leaderboard - Get basic leaderboard");
    println!("  GET /enhanced-leaderboard - Get enhanced leaderboard with log scores");
    println!("  GET /log-scoring/calculate - Calculate log scores for resolved predictions");
    println!("  GET /log-scoring/time-weights - Calculate time-weighted scores");
    println!("  GET /log-scoring/leaderboard - Get unified log scoring leaderboard");
    println!("  GET /user/:user_id/reputation - Get user reputation stats");
    println!("  GET /user/:user_id/update-reputation - Update user reputation points");
    println!("  POST /resolve-event/:event_id - Resolve event and update all participants");
    println!("  GET /rankings/update-global - Update global rankings for all users");
    println!("  GET /benchmark/scoring - Run performance benchmark (Rust vs SQL scoring)");
    println!("  GET /metaculus/sync - Manual sync with Metaculus API (150 recent questions)");
    println!("  GET /metaculus/bulk-import - Complete import of ALL Metaculus questions");
    println!("  GET /metaculus/sync-categories - Manual category sync");
    println!("  GET /events/:id/market - Get market state for event");
    println!("  GET /events/:id/trades - Get recent trades for event");
    println!("  POST /events/:id/update - Update market with stake");
    println!("  GET /events/:id/kelly - Get Kelly criterion suggestion");
    println!("  POST /events/:id/sell - Sell shares back to market");
    println!("  POST /events/:id/market-resolve - Resolve market event");
    println!("  GET /events/:id/shares - Get user's shares for event");
    println!("  POST /lmsr/verify-balance-invariant - Verify balance invariant");
    println!("  POST /lmsr/verify-staked-invariant - Verify staked invariant");
    println!("  POST /lmsr/verify-post-resolution - Verify post-resolution invariant");
    println!("  POST /lmsr/verify-consistency - Verify system consistency");

    // Start the daily Metaculus sync job (disabled for testing)
    // tokio::spawn(async move {
    //     if let Err(e) = metaculus::start_daily_sync_job(pool_clone).await {
    //         eprintln!("❌ Failed to start daily sync job: {}", e);
    //     }
    // });

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

// Get user accuracy by ID
async fn get_user_accuracy(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> ApiResult<Value> {
    match database::calculate_user_accuracy(&app_state.db, user_id).await {
        Ok(Some(accuracy)) => Ok(Json(map_user_accuracy_to_json(&accuracy))),
        Ok(None) => Err(not_found_error("User")),
        Err(e) => Err(internal_error(&format!("Database error: {}", e)))
    }
}

// Get leaderboard of top users
async fn get_leaderboard(
    State(app_state): State<AppState>,
) -> ApiResult<Value> {
    get_or_cache(&app_state.cache, "leaderboard_10", || async {
        let leaderboard = database::get_leaderboard(&app_state.db, 10).await?;
        let users: Vec<_> = leaderboard.into_iter().map(|user| map_user_accuracy_to_json(&user)).collect();
        Ok(json!({ "leaderboard": users }))
    }).await
}

// Get enhanced user accuracy with log scores only
async fn get_enhanced_user_accuracy(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> ApiResult<Value> {
    match database::calculate_enhanced_user_accuracy(&app_state.db, user_id).await {
        Ok(Some(accuracy)) => Ok(Json(map_user_accuracy_to_json(&accuracy))),
        Ok(None) => Err(not_found_error("User")),
        Err(e) => Err(internal_error(&format!("Database error: {}", e)))
    }
}

// Get user calibration data
async fn get_user_calibration(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> ApiResult<Value> {
    match database::calculate_calibration_score(&app_state.db, user_id).await {
        Ok(calibration_bins) => {
            let bins: Vec<_> = calibration_bins.into_iter().map(|bin| json!({
                "confidence_range": bin.confidence_range,
                "predicted_probability": bin.predicted_probability,
                "actual_frequency": bin.actual_frequency,
                "count": bin.count
            })).collect();
            
            Ok(Json(json!({
                "user_id": user_id,
                "calibration_data": bins
            })))
        },
        Err(e) => Err(internal_error(&format!("Database error: {}", e)))
    }
}


// Get user numerical prediction accuracy
async fn get_user_numerical_accuracy(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> ApiResult<Value> {
    match database::calculate_user_numerical_accuracy(&app_state.db, user_id).await {
        Ok(Some(numerical_accuracy)) => Ok(Json(json!({
            "user_id": user_id,
            "numerical_accuracy": numerical_accuracy,
            "description": "Average numerical score (lower is better for interval scoring)"
        }))),
        Ok(None) => Err(not_found_error("User or no numerical predictions")),
        Err(e) => Err(internal_error(&format!("Database error: {}", e)))
    }
}

// Update numerical scores for resolved predictions
async fn update_numerical_scores(
    State(app_state): State<AppState>,
) -> ApiResult<Value> {
    match database::update_numerical_scores(&app_state.db).await {
        Ok(updated_count) => {
            invalidate_and_broadcast(&app_state, "numerical_scores_updated", json!({"updated_count": updated_count}));
            Ok(Json(json!({
                "success": true,
                "updated_predictions": updated_count,
                "message": format!("Updated numerical scores for {} predictions", updated_count)
            })))
        },
        Err(e) => Err(internal_error(&format!("Database error: {}", e)))
    }
}

// Get enhanced leaderboard with log scores only
async fn get_enhanced_leaderboard(
    State(app_state): State<AppState>,
) -> ApiResult<Value> {
    get_or_cache(&app_state.cache, "enhanced_leaderboard_10", || async {
        let leaderboard = database::get_enhanced_leaderboard(&app_state.db, 10).await?;
        let users: Vec<_> = leaderboard.into_iter().map(|user| map_user_accuracy_to_json(&user)).collect();
        Ok(json!({ "leaderboard": users }))
    }).await
}

// WebSocket handler for real-time updates
async fn websocket_handler(
    ws: WebSocketUpgrade,
    State(app_state): State<AppState>,
) -> Response {
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
async fn manual_metaculus_sync(
    State(app_state): State<AppState>,
) -> ApiResult<Value> {
    match metaculus::manual_sync(&app_state.db).await {
        Ok(count) => {
            invalidate_and_broadcast(&app_state, "metaculus_sync", json!({"count": count}));
            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully synced {} new questions from Metaculus", count),
                "count": count
            })))
        },
        Err(e) => Err(internal_error(&format!("Metaculus sync error: {}", e)))
    }
}

// Manual Metaculus bulk import endpoint
async fn manual_bulk_import_endpoint(
    State(app_state): State<AppState>,
) -> ApiResult<Value> {
    println!("🚀 Bulk import endpoint called");
    
    match metaculus::manual_bulk_import(&app_state.db).await {
        Ok(count) => {
            invalidate_and_broadcast(&app_state, "metaculus_bulk_import", json!({"count": count, "type": "bulk_import"}));
            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully imported {} questions from Metaculus (bulk import)", count),
                "count": count,
                "type": "bulk_import"
            })))
        },
        Err(e) => Err(internal_error(&format!("Metaculus bulk import error: {}", e)))
    }
}

// Manual Metaculus limited import endpoint
async fn manual_limited_import_endpoint(
    State(app_state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Value> {
    let max_batches: u32 = params.get("batches")
        .and_then(|s| s.parse().ok())
        .unwrap_or(5); // Default to 5 batches for testing
        
    println!("🚀 Limited import endpoint called with max_batches: {}", max_batches);
    
    match metaculus::manual_limited_import(&app_state.db, max_batches).await {
        Ok(count) => {
            invalidate_and_broadcast(&app_state, "metaculus_limited_import", json!({
                "count": count, 
                "max_batches": max_batches, 
                "type": "limited_import"
            }));
            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully imported {} questions from Metaculus (limited to {} batches)", count, max_batches),
                "count": count,
                "max_batches": max_batches,
                "type": "limited_import"
            })))
        },
        Err(e) => Err(internal_error(&format!("Metaculus limited import error: {}", e)))
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
            invalidate_and_broadcast(&app_state, "category_sync", json!({
                "categories": categories, 
                "count": count
            }));
            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully synced {} questions from categories: {:?}", count, categories),
                "categories": categories,
                "count": count
            })))
        },
        Err(e) => Err(internal_error(&format!("Category sync error: {}", e)))
    }
}


// ============================================================================
// UNIFIED LOG SCORING SYSTEM ENDPOINTS
// ============================================================================

// Calculate log scores for resolved predictions
async fn calculate_log_scores_endpoint(
    State(app_state): State<AppState>,
) -> ApiResult<Value> {
    match database::calculate_log_scores(&app_state.db).await {
        Ok(updated_count) => {
            invalidate_and_broadcast(&app_state, "log_scores_calculated", json!({"updated_count": updated_count}));
            Ok(Json(json!({
                "success": true,
                "updated_predictions": updated_count,
                "message": format!("Calculated log scores for {} predictions", updated_count)
            })))
        },
        Err(e) => Err(internal_error(&format!("Log scoring calculation error: {}", e)))
    }
}

// Calculate time-weighted scores
async fn calculate_time_weights_endpoint(
    State(app_state): State<AppState>,
) -> ApiResult<Value> {
    match database::calculate_time_weighted_scores(&app_state.db).await {
        Ok(updated_count) => {
            invalidate_and_broadcast(&app_state, "time_weights_calculated", json!({"updated_count": updated_count}));
            Ok(Json(json!({
                "success": true,
                "updated_users": updated_count,
                "message": format!("Updated time-weighted scores for {} users", updated_count)
            })))
        },
        Err(e) => Err(internal_error(&format!("Time weighting calculation error: {}", e)))
    }
}

// Get unified log scoring leaderboard
async fn get_log_scoring_leaderboard(
    State(app_state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Value> {
    let limit: i32 = params.get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);
        
    let cache_key = format!("log_scoring_leaderboard_{}", limit);
    
    get_or_cache(&app_state.cache, &cache_key, || async {
        let leaderboard = database::get_log_scoring_leaderboard(&app_state.db, limit).await?;
        Ok(json!({
            "leaderboard": leaderboard,
            "scoring_system": "unified_log_scoring",
            "description": "Leaderboard using All-Log + PLL unified scoring system with reputation points"
        }))
    }).await
}

// Get user reputation stats
async fn get_user_reputation_endpoint(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> ApiResult<Value> {
    match database::get_user_reputation_stats(&app_state.db, user_id).await {
        Ok(Some(reputation_stats)) => Ok(Json(reputation_stats)),
        Ok(None) => Err(not_found_error("User or no reputation data")),
        Err(e) => Err(internal_error(&format!("User reputation error: {}", e)))
    }
}

// Update user reputation
async fn update_user_reputation_endpoint(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> ApiResult<Value> {
    match database::update_user_reputation(&app_state.db, user_id).await {
        Ok(rep_points) => {
            invalidate_and_broadcast(&app_state, "reputation_updated", json!({
                "user_id": user_id, 
                "rep_points": rep_points
            }));
            Ok(Json(json!({
                "success": true,
                "user_id": user_id,
                "rep_points": rep_points.to_f64().unwrap_or(1.0),
                "message": format!("Updated reputation for user {} to {:.2} points", user_id, rep_points)
            })))
        },
        Err(e) => Err(internal_error(&format!("Reputation update error: {}", e)))
    }
}

// Run scoring performance benchmark
async fn run_scoring_benchmark_endpoint(
    State(app_state): State<AppState>,
) -> ApiResult<Value> {
    println!("🔥 Starting scoring performance benchmark...");
    
    match benchmark::run_scoring_benchmark(&app_state.db).await {
        Ok(()) => {
            Ok(Json(json!({
                "success": true,
                "message": "Benchmark completed successfully. Check logs for detailed results.",
                "note": "This test creates temporary data and cleans up after itself."
            })))
        },
        Err(e) => Err(internal_error(&format!("Benchmark error: {}", e)))
    }
}

// ============================================================================
// EVENT RESOLUTION AND RANKING ENDPOINTS
// ============================================================================

// Resolve event and update all participants (POST endpoint with JSON body)
async fn resolve_event_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    let outcome_index = payload.get("outcome_index")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    
    println!("🎯 Event resolution triggered: event_id={}, outcome_index={}", event_id, outcome_index);
    
    match database::resolve_event_batch(&app_state.db, event_id, outcome_index).await {
        Ok(updated_count) => {
            invalidate_and_broadcast(&app_state, "event_resolved", json!({
                "event_id": event_id, 
                "outcome_index": outcome_index,
                "updated_predictions": updated_count
            }));
            Ok(Json(json!({
                "success": true,
                "event_id": event_id,
                "outcome_index": outcome_index,
                "updated_predictions": updated_count,
                "message": format!("Resolved event {} affecting {} predictions, updated all rankings", event_id, updated_count)
            })))
        },
        Err(e) => Err(internal_error(&format!("Event resolution error: {}", e)))
    }
}


// Update global rankings manually
async fn update_global_rankings_endpoint(
    State(app_state): State<AppState>,
) -> ApiResult<Value> {
    match database::update_global_rankings(&app_state.db).await {
        Ok(updated_count) => {
            invalidate_and_broadcast(&app_state, "rankings_updated", json!({"updated_count": updated_count}));
            Ok(Json(json!({
                "success": true,
                "updated_users": updated_count,
                "message": format!("Updated global rankings for {} users", updated_count)
            })))
        },
        Err(e) => Err(internal_error(&format!("Ranking update error: {}", e)))
    }
}

// ============================================================================
// LMSR MARKET API ENDPOINTS
// ============================================================================

// Get market state for an event
async fn get_market_state_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
) -> ApiResult<Value> {
    match lmsr_api::get_market_state(&app_state.db, event_id).await {
        Ok(market_state) => Ok(Json(market_state)),
        Err(e) => Err(internal_error(&format!("Market state error: {}", e)))
    }
}

// Get recent trades for an event
async fn get_event_trades_endpoint(
    State(app_state): State<AppState>,
    Path(event_id): Path<i32>,
    Query(params): Query<HashMap<String, String>>,
) -> ApiResult<Value> {
    let limit: i32 = params.get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(50);

    // Cap at 100 trades max
    let limit = limit.min(100);

    match lmsr_api::get_event_trades(&app_state.db, event_id, limit).await {
        Ok(trades) => Ok(Json(trades)),
        Err(e) => Err(internal_error(&format!("Trades fetch error: {}", e)))
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
    let user_id = payload.get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| bad_request_error("Missing or invalid user_id: must be a positive integer"))? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }
    
    // Validate target_prob - require explicit value, no defaults
    let target_prob = payload.get("target_prob")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| bad_request_error("Missing or invalid target_prob: must be a finite number"))?;
    if !target_prob.is_finite() {
        return Err(bad_request_error("Invalid target_prob: must be finite"));
    }
    if target_prob <= 0.0 || target_prob >= 1.0 {
        return Err(bad_request_error("Invalid target_prob: must be between 0 and 1 (exclusive)"));
    }
    
    // Validate stake - require explicit value, no defaults
    let stake = payload.get("stake")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| bad_request_error("Missing or invalid stake: must be a finite number"))?;
    if !stake.is_finite() {
        return Err(bad_request_error("Invalid stake: must be finite"));
    }
    if stake <= 0.0 {
        return Err(bad_request_error("Invalid stake: must be positive"));
    }
    if stake > 1_000_000.0 {  // 1M RP max per trade
        return Err(bad_request_error("Invalid stake: exceeds maximum allowed (1,000,000 RP)"));
    }
    if stake < 0.01 {  // Minimum 0.01 RP
        return Err(bad_request_error("Invalid stake: below minimum allowed (0.01 RP)"));
    }
    
    let update = lmsr_api::MarketUpdate {
        event_id,
        target_prob,
        stake,
    };

    match lmsr_api::update_market(&app_state.db, &app_state.config, user_id, update).await {
        Ok(result) => {
            invalidate_and_broadcast(&app_state, "market_updated", json!({
                "event_id": event_id,
                "user_id": user_id,
                "new_prob": result.new_prob,
                "shares_acquired": result.shares_acquired
            }));
            Ok(Json(json!(result)))
        },
        Err(e) => Err(internal_error(&format!("Market update error: {}", e)))
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
    let belief = params.get("belief")
        .and_then(|s| s.parse::<f64>().ok())
        .ok_or_else(|| bad_request_error("Missing or invalid belief: must be a finite number"))?;
    if !belief.is_finite() {
        return Err(bad_request_error("Invalid belief: must be finite"));
    }
    if belief <= 0.0 || belief >= 1.0 {
        return Err(bad_request_error("Invalid belief: must be between 0 and 1 (exclusive)"));
    }

    // Validate user_id - require explicit value, no defaults
    let user_id = params.get("user_id")
        .and_then(|s| s.parse::<i32>().ok())
        .ok_or_else(|| bad_request_error("Missing or invalid user_id: must be a positive integer"))?;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    // Get current market probability
    let market_prob_decimal: Result<Decimal, sqlx::Error> = sqlx::query_scalar(
        "SELECT market_prob FROM events WHERE id = $1"
    )
    .bind(event_id)
    .fetch_one(&app_state.db)
    .await;

    let market_prob = match market_prob_decimal {
        Ok(prob) => prob.to_f64().unwrap_or(0.5),
        Err(_) => return Err(not_found_error("Event"))
    };

    // Get user balance
    let balance_decimal: Result<Decimal, sqlx::Error> = sqlx::query_scalar(
        "SELECT rp_balance FROM users WHERE id = $1"
    )
    .bind(user_id)
    .fetch_one(&app_state.db)
    .await;

    let balance = match balance_decimal {
        Ok(bal) => bal.to_f64().unwrap_or(0.0),
        Err(_) => return Err(not_found_error("User"))
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
    let user_id = payload.get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| bad_request_error("Missing or invalid user_id: must be a positive integer"))? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    // Validate share_type - require explicit value, no defaults
    let share_type = payload.get("share_type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| bad_request_error("Missing or invalid share_type: must be 'yes' or 'no'"))?;
    if share_type != "yes" && share_type != "no" {
        return Err(bad_request_error("Invalid share_type: must be 'yes' or 'no'"));
    }

    // Validate amount - require explicit value, no defaults
    let amount = payload.get("amount")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| bad_request_error("Missing or invalid amount: must be a finite number"))?;
    if !amount.is_finite() {
        return Err(bad_request_error("Invalid amount: must be finite"));
    }
    if amount <= 0.0 {
        return Err(bad_request_error("Invalid amount: must be positive"));
    }
    if amount > 10_000_000.0 {  // 10M shares max per sale
        return Err(bad_request_error("Invalid amount: exceeds maximum allowed (10,000,000 shares)"));
    }
    if amount < 0.000001 {  // Minimum 0.000001 shares (1 micro-share)
        return Err(bad_request_error("Invalid amount: below minimum allowed (0.000001 shares)"));
    }

    match lmsr_api::sell_shares(&app_state.db, &app_state.config, user_id, event_id, share_type, amount).await {
        Ok(result) => {
            invalidate_and_broadcast(&app_state, "shares_sold", json!({
                "event_id": event_id,
                "user_id": user_id,
                "share_type": share_type,
                "amount": amount,
                "payout": result.payout,
                "new_prob": result.new_prob,
                "cumulative_stake": result.current_cost_c
            }));
            Ok(Json(json!({
                "success": true,
                "payout": result.payout,
                "new_prob": result.new_prob,
                "cumulative_stake": result.current_cost_c,
                "message": format!("Sold {} {} shares for {} RP", amount, share_type, result.payout)
            })))
        },
        Err(e) => {
            let msg = e.to_string();
            if msg.to_lowercase().contains("hold period not expired") {
                return Err(bad_request_error("Hold period not expired for recent purchases"));
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
    let user_id = params.get("user_id")
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(1);

    match lmsr_api::get_user_shares(&app_state.db, user_id, event_id).await {
        Ok(shares) => Ok(Json(shares)),
        Err(e) => Err(internal_error(&format!("User shares error: {}", e)))
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
    
    // Extract and validate outcome: true = YES, false = NO
    let outcome = payload.get("outcome")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| bad_request_error("Missing or invalid outcome (must be boolean)"))?;
    
    println!("🎯 Market resolution triggered: event_id={}, outcome={}", event_id, outcome);
    
    match lmsr_api::resolve_event(&app_state.db, event_id, outcome).await {
        Ok(()) => {
            // Broadcast market resolution
            invalidate_and_broadcast(&app_state, "marketResolved", json!({
                "eventId": event_id,
                "outcome": outcome,
                "timestamp": chrono::Utc::now().to_rfc3339()
            }));
            
            Ok(Json(json!({
                "success": true,
                "event_id": event_id,
                "outcome": outcome,
                "message": format!("Market event {} resolved as {}", event_id, if outcome { "YES" } else { "NO" })
            })))
        },
        Err(e) => Err(internal_error(&format!("Market resolution error: {}", e)))
    }
}

// Test LMSR invariants using property-based tests
async fn test_lmsr_invariants_endpoint(
    State(_app_state): State<AppState>,
) -> ApiResult<Value> {
    println!("🧪 Running LMSR invariant tests...");
    
    // Run a simplified version of the property tests
    let mut success_count = 0;
    let mut total_tests = 0;
    let mut failed_tests = Vec::new();
    
    // Test round-trip invariant with a few fixed cases
    let test_cases = vec![
        (5000.0, vec![10_000_000i128, 50_000_000i128], vec![0u8, 1u8]),
        (1000.0, vec![5_000_000i128, 25_000_000i128, 10_000_000i128], vec![0u8, 1u8, 0u8]),
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
        } else { 0 };
        let cash_credit_no = if no_shares > 0.0 {
            mkt.sell_no(no_shares).unwrap()
        } else { 0 };
        
        cash_ledger += cash_credit_yes + cash_credit_no;
        
        // Check invariants
        if cash_ledger.abs() <= 1 && mkt.q_yes.abs() < 1e-9 && mkt.q_no.abs() < 1e-9 {
            success_count += 1;
        } else {
            failed_tests.push(format!("Test case {}: cash_ledger={}, q_yes={:.2e}, q_no={:.2e}", 
                i, cash_ledger, mkt.q_yes, mkt.q_no));
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
    
    println!("✅ LMSR tests completed: {}/{} round-trip tests passed, {}/{} probability tests passed", 
             success_count, total_tests, prob_success, prob_tests);
    
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
    let user_id = payload.get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| bad_request_error("Missing or invalid user_id: must be a positive integer"))? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    match lmsr_api::verify_balance_invariant(&app_state.db, user_id).await {
        Ok(result) => Ok(Json(result)),
        Err(e) => Err(internal_error(&format!("Balance invariant verification error: {}", e)))
    }
}

// Verify staked invariant
async fn verify_staked_invariant_endpoint(
    State(app_state): State<AppState>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate user_id - require explicit value, no defaults
    let user_id = payload.get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| bad_request_error("Missing or invalid user_id: must be a positive integer"))? as i32;
    if user_id <= 0 {
        return Err(bad_request_error("Invalid user_id: must be positive"));
    }

    match lmsr_api::verify_staked_invariant(&app_state.db, user_id).await {
        Ok(result) => Ok(Json(result)),
        Err(e) => Err(internal_error(&format!("Staked invariant verification error: {}", e)))
    }
}

// Verify post-resolution invariant
async fn verify_post_resolution_endpoint(
    State(app_state): State<AppState>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate event_id - require explicit value, no defaults
    let event_id = payload.get("event_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| bad_request_error("Missing or invalid event_id: must be a positive integer"))? as i32;
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    match lmsr_api::verify_post_resolution_invariant(&app_state.db, event_id).await {
        Ok(result) => Ok(Json(result)),
        Err(e) => Err(internal_error(&format!("Post-resolution invariant verification error: {}", e)))
    }
}

// Verify system consistency
async fn verify_consistency_endpoint(
    State(app_state): State<AppState>,
    ExtractJson(payload): ExtractJson<serde_json::Value>,
) -> ApiResult<Value> {
    // Validate event_id - require explicit value, no defaults
    let event_id = payload.get("event_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| bad_request_error("Missing or invalid event_id: must be a positive integer"))? as i32;
    if event_id <= 0 {
        return Err(bad_request_error("Invalid event_id: must be positive"));
    }

    match lmsr_api::verify_system_consistency(&app_state.db, event_id).await {
        Ok(result) => Ok(Json(result)),
        Err(e) => Err(internal_error(&format!("System consistency verification error: {}", e)))
    }
}

