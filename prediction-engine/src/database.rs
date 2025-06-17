// Database connection and query functions
use sqlx::{PgPool, Row};
use anyhow::Result;

// This struct represents user prediction accuracy data
#[derive(Debug)]
pub struct UserAccuracy {
    pub user_id: i32,
    pub username: String,
    pub total_predictions: i64,
    pub correct_predictions: i64,
    pub accuracy_rate: f64,
    pub weighted_accuracy: Option<f64>,
}

// Create a connection pool to PostgreSQL
pub async fn create_pool(database_url: &str) -> Result<PgPool> {
    println!("🔌 Connecting to PostgreSQL...");
    
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)  // Connection pool size
        .connect(database_url)
        .await?;
    
    println!("✅ Connected to database!");
    Ok(pool)
}

// Calculate accuracy for a specific user
pub async fn calculate_user_accuracy(pool: &PgPool, user_id: i32) -> Result<Option<UserAccuracy>> {
    let row = sqlx::query(
        r#"
        SELECT 
            u.id as user_id,
            u.username,
            COUNT(p.id) as total_predictions,
            COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) as correct_predictions,
            CASE 
                WHEN COUNT(p.id) > 0 THEN 
                    COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) * 100.0 / COUNT(p.id)
                ELSE 0 
            END as accuracy_rate,
            CASE 
                WHEN SUM(p.confidence) > 0 THEN 
                    SUM(CASE WHEN p.outcome = 'correct' THEN p.confidence ELSE 0 END) * 100.0 / SUM(p.confidence)
                ELSE NULL 
            END as weighted_accuracy
        FROM users u
        LEFT JOIN predictions p ON u.id = p.user_id AND p.outcome IS NOT NULL
        WHERE u.id = $1
        GROUP BY u.id, u.username
        "#
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    if let Some(row) = row {
        Ok(Some(UserAccuracy {
            user_id: row.get("user_id"),
            username: row.get("username"),
            total_predictions: row.get("total_predictions"),
            correct_predictions: row.get("correct_predictions"),
            accuracy_rate: row.get("accuracy_rate"),
            weighted_accuracy: row.get("weighted_accuracy"),
        }))
    } else {
        Ok(None)
    }
}

// Get leaderboard - top users by accuracy
pub async fn get_leaderboard(pool: &PgPool, limit: i32) -> Result<Vec<UserAccuracy>> {
    let rows = sqlx::query(
        r#"
        SELECT 
            u.id as user_id,
            u.username,
            COUNT(p.id) as total_predictions,
            COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) as correct_predictions,
            CASE 
                WHEN COUNT(p.id) > 0 THEN 
                    COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) * 100.0 / COUNT(p.id)
                ELSE 0 
            END as accuracy_rate,
            CASE 
                WHEN SUM(p.confidence) > 0 THEN 
                    SUM(CASE WHEN p.outcome = 'correct' THEN p.confidence ELSE 0 END) * 100.0 / SUM(p.confidence)
                ELSE NULL 
            END as weighted_accuracy
        FROM users u
        LEFT JOIN predictions p ON u.id = p.user_id AND p.outcome IS NOT NULL
        GROUP BY u.id, u.username
        HAVING COUNT(p.id) > 0  -- Only users with predictions
        ORDER BY accuracy_rate DESC, total_predictions DESC
        LIMIT $1
        "#
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut leaderboard = Vec::new();
    for row in rows {
        leaderboard.push(UserAccuracy {
            user_id: row.get("user_id"),
            username: row.get("username"),
            total_predictions: row.get("total_predictions"),
            correct_predictions: row.get("correct_predictions"),
            accuracy_rate: row.get("accuracy_rate"),
            weighted_accuracy: row.get("weighted_accuracy"),
        });
    }

    Ok(leaderboard)
}