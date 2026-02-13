// Simple benchmark test for Rust vs SQL scoring performance
use anyhow::Result;
use rayon::prelude::*;
use sqlx::{PgPool, Row};
use std::time::Instant;

/// Benchmark Rust approach: Fetch data, calculate in Rust, update DB
async fn benchmark_rust_approach(pool: &PgPool) -> Result<u128> {
    let start = Instant::now();

    // 1. Fetch predictions with resolved outcomes
    let predictions = sqlx::query(
        "SELECT id, user_id, prob_vector, outcome_index, created_at 
         FROM predictions 
         WHERE outcome_index IS NOT NULL 
         AND prob_vector IS NOT NULL 
         LIMIT 1000",
    )
    .fetch_all(pool)
    .await?;

    println!("Rust approach: Fetched {} predictions", predictions.len());

    // 2. Calculate scores in parallel using Rust
    let score_updates: Vec<_> = predictions
        .par_iter()
        .map(|row| {
            let id: i32 = row.get("id");
            let prob_vector_json: serde_json::Value = row.get("prob_vector");
            let outcome_index: i32 = row.get("outcome_index");

            // Parse probability vector
            let prob_vec: Vec<f64> = if let Ok(vec) = serde_json::from_value(prob_vector_json) {
                vec
            } else {
                vec![0.5, 0.5] // Default for binary
            };

            // Calculate log loss in Rust
            let p_true = prob_vec
                .get(outcome_index as usize)
                .unwrap_or(&0.5)
                .max(0.0001);
            let log_loss = -p_true.ln();

            (id, log_loss)
        })
        .collect();

    // 3. Update database with calculated scores
    for (pred_id, score) in score_updates {
        sqlx::query("UPDATE predictions SET raw_log_loss = $1 WHERE id = $2")
            .bind(score)
            .bind(pred_id)
            .execute(pool)
            .await?;
    }

    Ok(start.elapsed().as_millis())
}

/// Benchmark SQL approach: Let PostgreSQL do all calculations
async fn benchmark_sql_approach(pool: &PgPool) -> Result<u128> {
    let start = Instant::now();

    // Clear previous scores first
    sqlx::query(
        "UPDATE predictions SET raw_log_loss = NULL 
         WHERE outcome_index IS NOT NULL 
         AND prob_vector IS NOT NULL",
    )
    .execute(pool)
    .await?;

    // Single SQL query to calculate and update all scores
    let updated_count = sqlx::query(
        "UPDATE predictions 
         SET raw_log_loss = -LN(GREATEST((prob_vector->>outcome_index)::FLOAT, 0.0001))
         WHERE outcome_index IS NOT NULL 
         AND prob_vector IS NOT NULL 
         AND raw_log_loss IS NULL",
    )
    .execute(pool)
    .await?;

    println!(
        "SQL approach: Updated {} predictions",
        updated_count.rows_affected()
    );
    Ok(start.elapsed().as_millis())
}

/// Reset predictions to clear calculated scores
async fn reset_scores(pool: &PgPool) -> Result<()> {
    sqlx::query(
        "UPDATE predictions SET raw_log_loss = NULL 
         WHERE outcome_index IS NOT NULL",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Run the benchmark comparing Rust vs SQL approaches
pub async fn run_scoring_benchmark(pool: &PgPool) -> Result<()> {
    println!("\n🔥 SCORING PERFORMANCE BENCHMARK 🔥");
    println!("Comparing Rust vs SQL for log score calculations\n");

    // Check how many resolved predictions we have
    let prediction_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM predictions 
         WHERE outcome_index IS NOT NULL 
         AND prob_vector IS NOT NULL",
    )
    .fetch_one(pool)
    .await?;

    if prediction_count == 0 {
        println!("❌ No resolved predictions found. Run log scoring calculation first.");
        return Ok(());
    }

    println!(
        "📊 Found {} resolved predictions to benchmark",
        prediction_count
    );

    let mut rust_times = Vec::new();
    let mut sql_times = Vec::new();

    // Run 3 iterations of each approach
    for iteration in 1..=3 {
        println!("\n--- Iteration {} ---", iteration);

        // Test Rust approach
        reset_scores(pool).await?;
        let rust_time = benchmark_rust_approach(pool).await?;
        rust_times.push(rust_time);
        println!("🦀 Rust approach: {}ms", rust_time);

        // Test SQL approach
        reset_scores(pool).await?;
        let sql_time = benchmark_sql_approach(pool).await?;
        sql_times.push(sql_time);
        println!("🐘 SQL approach:  {}ms", sql_time);
    }

    // Calculate averages
    let avg_rust = rust_times.iter().sum::<u128>() / rust_times.len() as u128;
    let avg_sql = sql_times.iter().sum::<u128>() / sql_times.len() as u128;

    println!("\n{}", "=".repeat(50));
    println!("📊 FINAL RESULTS:");
    println!("🦀 Rust average: {}ms", avg_rust);
    println!("🐘 SQL average:  {}ms", avg_sql);

    let winner = if avg_rust < avg_sql {
        format!(
            "🏆 Rust is {:.1}x FASTER than SQL",
            avg_sql as f64 / avg_rust as f64
        )
    } else {
        format!(
            "🏆 SQL is {:.1}x FASTER than Rust",
            avg_rust as f64 / avg_sql as f64
        )
    };
    println!("{}", winner);
    println!("{}", "=".repeat(50));

    println!("\n🎯 Benchmark complete!");
    Ok(())
}
