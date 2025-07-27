//! Binary entry point for running stress tests
//! Run with: cargo run --bin stress_test

use anyhow::Result;
use sqlx::postgres::PgPoolOptions;
use prediction_engine::config::Config;
use prediction_engine::stress;
use tracing_subscriber;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter("info,prediction_engine=debug")
        .init();

    println!("🚀 LMSR Prediction Engine Stress Test");
    println!("=====================================\n");

    // Load configuration
    let config = Config::from_env();
    println!("Configuration loaded:");
    println!("  - Hold period: {} hours", config.market.hold_period_hours);
    println!("  - Kelly fraction: {}", config.market.kelly_fraction);
    println!("  - Max Kelly fraction: {}\n", config.market.max_kelly_fraction);

    // Create database connection pool
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://postgres:password@localhost/test_intellacc".to_string());
    
    println!("Connecting to database: {}", database_url);
    let pool = PgPoolOptions::new()
        .max_connections(50)
        .connect(&database_url)
        .await?;

    // Setup test database schema
    println!("\nSetting up test database schema...");
    stress::setup_test_database(&pool).await?;

    // Run the stress test
    println!("\nStarting stress test...");
    stress::run_stress_test(&pool, &config).await?;

    println!("\n✅ Stress test completed successfully!");
    Ok(())
}