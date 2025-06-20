// Import the things we need
use axum::{
    extract::{Path, State, WebSocketUpgrade, Query},
    response::{Json, Response},
    routing::get,
    Router,
};
use serde_json::{json, Value};
use sqlx::PgPool;
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

    // Create our web application routes with shared state
    let app = Router::new()
        .route("/", get(hello_world))
        .route("/health", get(health_check))
        .route("/user/:user_id/accuracy", get(get_user_accuracy))
        .route("/user/:user_id/enhanced-accuracy", get(get_enhanced_user_accuracy))
        .route("/user/:user_id/calibration", get(get_user_calibration))
        .route("/user/:user_id/brier", get(get_user_brier_score))
        .route("/leaderboard", get(get_leaderboard))
        .route("/enhanced-leaderboard", get(get_enhanced_leaderboard))
        // .route("/ws", get(websocket_handler)) // Temporarily disabled
        .route("/metaculus/sync", get(manual_metaculus_sync))
        .route("/metaculus/sync-categories", get(manual_category_sync))
        // .route("/user/:user_id/expertise", get(get_user_domain_expertise))
        // .route("/domain/:domain/experts", get(get_domain_experts))
        // .route("/domains", get(get_available_domains))
        // .route("/cross-domain-expertise", get(get_cross_domain_expertise))
        .with_state(app_state); // Share app state with all routes

    // Define the address to listen on - bind to all interfaces in Docker
    let addr = SocketAddr::from(([0, 0, 0, 0], 3001));
    
    println!("🚀 Server running on http://{}", addr);
    println!("📊 Available endpoints:");
    println!("  GET /health - Health check");
    println!("  GET /user/:user_id/accuracy - Get basic user prediction accuracy");
    println!("  GET /user/:user_id/enhanced-accuracy - Get enhanced accuracy with Brier scores");
    println!("  GET /user/:user_id/calibration - Get user calibration data");
    println!("  GET /user/:user_id/brier - Get user Brier score");
    println!("  GET /leaderboard - Get basic leaderboard");
    println!("  GET /enhanced-leaderboard - Get enhanced leaderboard with Brier scores");
    // println!("  GET /ws - WebSocket for real-time updates");
    println!("  GET /metaculus/sync - Manual sync with Metaculus API");
    println!("  GET /metaculus/sync-categories - Manual category sync");
    // println!("  GET /user/:user_id/expertise - Get user's domain expertise");
    // println!("  GET /domain/:domain/experts - Get top experts in domain");
    // println!("  GET /domains - Get available domains");
    // println!("  GET /cross-domain-expertise - Get experts across all domains");

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
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match database::calculate_user_accuracy(&app_state.db, user_id).await {
        Ok(Some(accuracy)) => Ok(Json(json!({
            "user_id": accuracy.user_id,
            "username": accuracy.username,
            "total_predictions": accuracy.total_predictions,
            "correct_predictions": accuracy.correct_predictions,
            "accuracy_rate": accuracy.accuracy_rate,
            "weighted_accuracy": accuracy.weighted_accuracy
        }))),
        Ok(None) => Err((
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({"error": "User not found"}))
        )),
        Err(e) => {
            eprintln!("Database error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Internal server error"}))
            ))
        }
    }
}

// Get leaderboard of top users
async fn get_leaderboard(
    State(app_state): State<AppState>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match database::get_leaderboard(&app_state.db, 10).await {
        Ok(leaderboard) => {
            let users: Vec<_> = leaderboard.into_iter().map(|user| json!({
                "user_id": user.user_id,
                "username": user.username,
                "total_predictions": user.total_predictions,
                "correct_predictions": user.correct_predictions,
                "accuracy_rate": user.accuracy_rate,
                "weighted_accuracy": user.weighted_accuracy
            })).collect();
            
            Ok(Json(json!({
                "leaderboard": users
            })))
        },
        Err(e) => {
            eprintln!("Database error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Internal server error"}))
            ))
        }
    }
}

// Get enhanced user accuracy with Brier scores
async fn get_enhanced_user_accuracy(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match database::calculate_enhanced_user_accuracy(&app_state.db, user_id).await {
        Ok(Some(accuracy)) => Ok(Json(json!({
            "user_id": accuracy.user_id,
            "username": accuracy.username,
            "total_predictions": accuracy.total_predictions,
            "correct_predictions": accuracy.correct_predictions,
            "accuracy_rate": accuracy.accuracy_rate,
            "weighted_accuracy": accuracy.weighted_accuracy,
            "brier_score": accuracy.brier_score,
            "monthly_brier": accuracy.monthly_brier,
            "weekly_brier": accuracy.weekly_brier,
            "calibration_score": accuracy.calibration_score
        }))),
        Ok(None) => Err((
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({"error": "User not found"}))
        )),
        Err(e) => {
            eprintln!("Database error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Internal server error"}))
            ))
        }
    }
}

// Get user calibration data
async fn get_user_calibration(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
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
        Err(e) => {
            eprintln!("Database error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Internal server error"}))
            ))
        }
    }
}

// Get user Brier score
async fn get_user_brier_score(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match database::calculate_user_brier_score(&app_state.db, user_id).await {
        Ok(Some(brier_score)) => Ok(Json(json!({
            "user_id": user_id,
            "brier_score": brier_score
        }))),
        Ok(None) => Err((
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({"error": "User not found or no predictions"}))
        )),
        Err(e) => {
            eprintln!("Database error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Internal server error"}))
            ))
        }
    }
}

// Get enhanced leaderboard with Brier scores
async fn get_enhanced_leaderboard(
    State(app_state): State<AppState>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let cache_key = "enhanced_leaderboard_10".to_string();
    
    // Check cache first
    if let Some(cached_result) = app_state.cache.get(&cache_key).await {
        if let Ok(cached_json) = serde_json::from_str::<Value>(&cached_result) {
            return Ok(Json(cached_json));
        }
    }

    match database::get_enhanced_leaderboard(&app_state.db, 10).await {
        Ok(leaderboard) => {
            let users: Vec<_> = leaderboard.into_iter().map(|user| json!({
                "user_id": user.user_id,
                "username": user.username,
                "total_predictions": user.total_predictions,
                "correct_predictions": user.correct_predictions,
                "accuracy_rate": user.accuracy_rate,
                "weighted_accuracy": user.weighted_accuracy,
                "brier_score": user.brier_score,
                "monthly_brier": user.monthly_brier,
                "weekly_brier": user.weekly_brier
            })).collect();
            
            let result = json!({
                "leaderboard": users
            });
            
            // Cache the result
            if let Ok(result_str) = serde_json::to_string(&result) {
                app_state.cache.insert(cache_key, result_str).await;
            }
            
            Ok(Json(result))
        },
        Err(e) => {
            eprintln!("Database error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Internal server error"}))
            ))
        }
    }
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
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match metaculus::manual_sync(&app_state.db).await {
        Ok(count) => {
            // Clear cache since new data was added
            app_state.cache.invalidate_all();
            
            // Broadcast update to WebSocket clients
            let msg = json!({
                "type": "metaculus_sync",
                "count": count,
                "timestamp": chrono::Utc::now()
            }).to_string();
            let _ = app_state.tx.send(msg);

            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully synced {} new questions from Metaculus", count),
                "count": count
            })))
        },
        Err(e) => {
            eprintln!("Metaculus sync error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Failed to sync with Metaculus"}))
            ))
        }
    }
}

// Manual category sync endpoint
async fn manual_category_sync(
    State(app_state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let default_categories = "politics,economics,science".to_string();
    let categories_str = params.get("categories").unwrap_or(&default_categories);
    let categories: Vec<&str> = categories_str.split(',').map(|s| s.trim()).collect();

    match metaculus::manual_category_sync(&app_state.db, categories.clone()).await {
        Ok(count) => {
            // Clear cache since new data was added
            app_state.cache.invalidate_all();
            
            // Broadcast update to WebSocket clients
            let msg = json!({
                "type": "category_sync",
                "categories": categories,
                "count": count,
                "timestamp": chrono::Utc::now()
            }).to_string();
            let _ = app_state.tx.send(msg);

            Ok(Json(json!({
                "success": true,
                "message": format!("Successfully synced {} questions from categories: {:?}", count, categories),
                "categories": categories,
                "count": count
            })))
        },
        Err(e) => {
            eprintln!("Category sync error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Failed to sync categories with Metaculus"}))
            ))
        }
    }
}

// Get user's domain expertise
async fn get_user_domain_expertise(
    State(app_state): State<AppState>,
    Path(user_id): Path<i32>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match database::get_user_domain_expertise(&app_state.db, user_id).await {
        Ok(expertise) => {
            let domains: Vec<_> = expertise.into_iter().map(|exp| json!({
                "domain": exp.domain,
                "predictions_count": exp.predictions_count,
                "accuracy_rate": exp.accuracy_rate,
                "brier_score": exp.brier_score,
                "rank_in_domain": exp.rank_in_domain
            })).collect();
            
            Ok(Json(json!({
                "user_id": user_id,
                "domain_expertise": domains
            })))
        },
        Err(e) => {
            eprintln!("Domain expertise error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Failed to get domain expertise"}))
            ))
        }
    }
}

// Get top experts in a specific domain
async fn get_domain_experts(
    State(app_state): State<AppState>,
    Path(domain): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let limit: i32 = params.get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    match database::get_domain_experts(&app_state.db, &domain, limit).await {
        Ok(experts) => {
            let expert_list: Vec<_> = experts.into_iter().map(|exp| json!({
                "user_id": exp.user_id,
                "username": exp.username,
                "predictions_count": exp.predictions_count,
                "accuracy_rate": exp.accuracy_rate,
                "brier_score": exp.brier_score,
                "rank_in_domain": exp.rank_in_domain
            })).collect();
            
            Ok(Json(json!({
                "domain": domain,
                "experts": expert_list
            })))
        },
        Err(e) => {
            eprintln!("Domain experts error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Failed to get domain experts"}))
            ))
        }
    }
}

// Get available domains
async fn get_available_domains(
    State(app_state): State<AppState>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match database::get_available_domains(&app_state.db).await {
        Ok(domains) => Ok(Json(json!({
            "domains": domains
        }))),
        Err(e) => {
            eprintln!("Available domains error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Failed to get available domains"}))
            ))
        }
    }
}

// Get cross-domain expertise leaderboards
async fn get_cross_domain_expertise(
    State(app_state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    let limit: i32 = params.get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);

    match database::get_cross_domain_expertise(&app_state.db, limit).await {
        Ok(domain_leaderboards) => {
            let formatted_leaderboards: Vec<_> = domain_leaderboards.into_iter().map(|(domain, experts)| {
                let expert_list: Vec<_> = experts.into_iter().map(|exp| json!({
                    "user_id": exp.user_id,
                    "username": exp.username,
                    "predictions_count": exp.predictions_count,
                    "accuracy_rate": exp.accuracy_rate,
                    "brier_score": exp.brier_score,
                    "rank_in_domain": exp.rank_in_domain
                })).collect();
                
                json!({
                    "domain": domain,
                    "experts": expert_list
                })
            }).collect();
            
            Ok(Json(json!({
                "cross_domain_leaderboards": formatted_leaderboards
            })))
        },
        Err(e) => {
            eprintln!("Cross-domain expertise error: {}", e);
            Err((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "Failed to get cross-domain expertise"}))
            ))
        }
    }
}
