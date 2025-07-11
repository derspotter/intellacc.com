// Import the things we need
use axum::{
    extract::{Path, State, WebSocketUpgrade, Query, Json as ExtractJson},
    response::{Json, Response},
    routing::{get, post},
    Router,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
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
}

// This is our main function - but notice the #[tokio::main] attribute!
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load environment variables from .env file
    dotenv::dotenv().ok();
    
    println!("🦀 Starting Prediction Engine...");

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

