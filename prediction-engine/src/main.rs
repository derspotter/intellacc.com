// Import the things we need
use axum::{
    extract::{Path, State},
    response::Json,
    routing::get,
    Router,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::net::SocketAddr;

// Import our database module
mod database;

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

    // Create our web application routes with database state
    let app = Router::new()
        .route("/", get(hello_world))
        .route("/health", get(health_check))
        .route("/user/:user_id/accuracy", get(get_user_accuracy))
        .route("/leaderboard", get(get_leaderboard))
        .with_state(pool); // Share database pool with all routes

    // Define the address to listen on - bind to all interfaces in Docker
    let addr = SocketAddr::from(([0, 0, 0, 0], 3001));
    
    println!("🚀 Server running on http://{}", addr);
    println!("📊 Available endpoints:");
    println!("  GET /health - Health check");
    println!("  GET /user/:user_id/accuracy - Get user prediction accuracy");
    println!("  GET /leaderboard - Get top users by accuracy");

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
    State(pool): State<PgPool>,
    Path(user_id): Path<i32>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match database::calculate_user_accuracy(&pool, user_id).await {
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
    State(pool): State<PgPool>,
) -> Result<Json<Value>, (axum::http::StatusCode, Json<Value>)> {
    match database::get_leaderboard(&pool, 10).await {
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
