// Database connection and query functions
use sqlx::{PgPool, Row};
use anyhow::Result;
use chrono::{DateTime, Utc, Duration};

// This struct represents user prediction accuracy data
#[derive(Debug)]
pub struct UserAccuracy {
    pub user_id: i32,
    pub username: String,
    pub total_predictions: i64,
    pub correct_predictions: i64,
    pub accuracy_rate: f64,
    pub weighted_accuracy: Option<f64>,
    pub brier_score: Option<f64>,
    pub calibration_score: Option<f64>,
    pub monthly_brier: Option<f64>,
    pub weekly_brier: Option<f64>,
}

// Struct for individual prediction with Brier calculation
#[derive(Debug)]
pub struct PredictionScore {
    pub prediction_id: i32,
    pub user_id: i32,
    pub confidence: f64,
    pub outcome: bool,
    pub brier_score: f64,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

// Struct for calibration data
#[derive(Debug)]
pub struct CalibrationBin {
    pub confidence_range: (f64, f64),
    pub predicted_probability: f64,
    pub actual_frequency: f64,
    pub count: i64,
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
            brier_score: None,
            calibration_score: None,
            monthly_brier: None,
            weekly_brier: None,
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
            brier_score: None,
            calibration_score: None,
            monthly_brier: None,
            weekly_brier: None,
        });
    }

    Ok(leaderboard)
}

// Domain-specific expertise tracking
#[derive(Debug)]
pub struct DomainExpertise {
    pub user_id: i32,
    pub username: String,
    pub domain: String,
    pub predictions_count: i64,
    pub accuracy_rate: f64,
    pub brier_score: Option<f64>,
    pub rank_in_domain: Option<i64>,
}

// Get user's expertise across different domains/topics
pub async fn get_user_domain_expertise(pool: &PgPool, user_id: i32) -> Result<Vec<DomainExpertise>> {
    let rows = sqlx::query(
        r#"
        SELECT 
            u.id as user_id,
            u.username,
            t.name as domain,
            COUNT(p.id) as predictions_count,
            CASE 
                WHEN COUNT(p.id) > 0 THEN 
                    COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) * 100.0 / COUNT(p.id)
                ELSE 0 
            END as accuracy_rate,
            AVG(
                POWER(
                    (p.confidence / 100.0) - 
                    CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                    2
                )
            ) as brier_score
        FROM users u
        JOIN predictions p ON u.id = p.user_id
        JOIN events e ON p.event_id = e.id
        JOIN topics t ON e.topic_id = t.id
        WHERE u.id = $1 AND p.outcome IS NOT NULL
        GROUP BY u.id, u.username, t.id, t.name
        HAVING COUNT(p.id) >= 3  -- Only show domains with at least 3 predictions
        ORDER BY accuracy_rate DESC, brier_score ASC
        "#
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut expertise = Vec::new();
    for row in rows {
        expertise.push(DomainExpertise {
            user_id: row.get("user_id"),
            username: row.get("username"),
            domain: row.get("domain"),
            predictions_count: row.get("predictions_count"),
            accuracy_rate: row.get("accuracy_rate"),
            brier_score: row.get("brier_score"),
            rank_in_domain: None, // Will be calculated separately if needed
        });
    }

    Ok(expertise)
}

// Get top experts in a specific domain
pub async fn get_domain_experts(pool: &PgPool, domain: &str, limit: i32) -> Result<Vec<DomainExpertise>> {
    let rows = sqlx::query(
        r#"
        WITH domain_stats AS (
            SELECT 
                u.id as user_id,
                u.username,
                $1 as domain,
                COUNT(p.id) as predictions_count,
                CASE 
                    WHEN COUNT(p.id) > 0 THEN 
                        COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) * 100.0 / COUNT(p.id)
                    ELSE 0 
                END as accuracy_rate,
                AVG(
                    POWER(
                        (p.confidence / 100.0) - 
                        CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                        2
                    )
                ) as brier_score
            FROM users u
            JOIN predictions p ON u.id = p.user_id
            JOIN events e ON p.event_id = e.id
            JOIN topics t ON e.topic_id = t.id
            WHERE t.name = $1 AND p.outcome IS NOT NULL
            GROUP BY u.id, u.username
            HAVING COUNT(p.id) >= 5  -- At least 5 predictions in domain
        ),
        ranked_experts AS (
            SELECT *,
                ROW_NUMBER() OVER (ORDER BY brier_score ASC, accuracy_rate DESC) as rank_in_domain
            FROM domain_stats
        )
        SELECT * FROM ranked_experts
        ORDER BY rank_in_domain
        LIMIT $2
        "#
    )
    .bind(domain)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut experts = Vec::new();
    for row in rows {
        experts.push(DomainExpertise {
            user_id: row.get("user_id"),
            username: row.get("username"),
            domain: row.get("domain"),
            predictions_count: row.get("predictions_count"),
            accuracy_rate: row.get("accuracy_rate"),
            brier_score: row.get("brier_score"),
            rank_in_domain: row.get("rank_in_domain"),
        });
    }

    Ok(experts)
}

// Get all available domains/topics
pub async fn get_available_domains(pool: &PgPool) -> Result<Vec<String>> {
    let rows = sqlx::query(
        r#"
        SELECT DISTINCT t.name as domain
        FROM topics t
        JOIN events e ON t.id = e.topic_id
        JOIN predictions p ON e.id = p.event_id
        WHERE p.outcome IS NOT NULL
        ORDER BY t.name
        "#
    )
    .fetch_all(pool)
    .await?;

    let domains: Vec<String> = rows.into_iter()
        .map(|row| row.get("domain"))
        .collect();

    Ok(domains)
}

// Get domain-specific leaderboard across all topics
pub async fn get_cross_domain_expertise(pool: &PgPool, limit: i32) -> Result<Vec<(String, Vec<DomainExpertise>)>> {
    let domains = get_available_domains(pool).await?;
    let mut domain_leaderboards = Vec::new();

    for domain in domains {
        let experts = get_domain_experts(pool, &domain, limit).await?;
        if !experts.is_empty() {
            domain_leaderboards.push((domain, experts));
        }
    }

    Ok(domain_leaderboards)
}

// Calculate Brier score for a single prediction
// Brier Score = (forecast - outcome)²
pub fn calculate_brier_score(confidence: f64, outcome: bool) -> f64 {
    let forecast = confidence / 100.0; // Convert percentage to probability
    let actual = if outcome { 1.0 } else { 0.0 };
    (forecast - actual).powi(2)
}

// Calculate user's overall Brier score
pub async fn calculate_user_brier_score(pool: &PgPool, user_id: i32) -> Result<Option<f64>> {
    let row = sqlx::query(
        r#"
        SELECT 
            AVG(
                POWER(
                    (p.confidence / 100.0) - 
                    CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                    2
                )
            ) as brier_score
        FROM predictions p
        WHERE p.user_id = $1 AND p.outcome IS NOT NULL
        "#
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    if let Some(row) = row {
        Ok(row.get("brier_score"))
    } else {
        Ok(None)
    }
}

// Calculate time-weighted Brier score (recent predictions weighted more)
pub async fn calculate_weighted_brier_score(
    pool: &PgPool, 
    user_id: i32, 
    days_back: i32
) -> Result<Option<f64>> {
    let cutoff_date = Utc::now() - Duration::days(days_back as i64);
    
    let row = sqlx::query(
        r#"
        SELECT 
            SUM(
                POWER(
                    (p.confidence / 100.0) - 
                    CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                    2
                ) * 
                -- Weight more recent predictions higher
                (1.0 + (EXTRACT(EPOCH FROM (p.created_at - $2)) / 86400.0) / $3)
            ) / SUM(
                1.0 + (EXTRACT(EPOCH FROM (p.created_at - $2)) / 86400.0) / $3
            ) as weighted_brier_score
        FROM predictions p
        WHERE p.user_id = $1 
        AND p.outcome IS NOT NULL
        AND p.created_at >= $2
        "#
    )
    .bind(user_id)
    .bind(cutoff_date)
    .bind(days_back as f64)
    .fetch_optional(pool)
    .await?;

    if let Some(row) = row {
        Ok(row.get("weighted_brier_score"))
    } else {
        Ok(None)
    }
}

// Calculate calibration score (how well-calibrated a user's confidence is)
pub async fn calculate_calibration_score(pool: &PgPool, user_id: i32) -> Result<Vec<CalibrationBin>> {
    let rows = sqlx::query(
        r#"
        SELECT 
            FLOOR(p.confidence / 10) * 10 as confidence_bin_start,
            FLOOR(p.confidence / 10) * 10 + 10 as confidence_bin_end,
            AVG(p.confidence / 100.0) as avg_predicted_prob,
            AVG(CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END) as actual_frequency,
            COUNT(*) as prediction_count
        FROM predictions p
        WHERE p.user_id = $1 AND p.outcome IS NOT NULL
        GROUP BY FLOOR(p.confidence / 10)
        ORDER BY confidence_bin_start
        "#
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut bins = Vec::new();
    for row in rows {
        bins.push(CalibrationBin {
            confidence_range: (row.get("confidence_bin_start"), row.get("confidence_bin_end")),
            predicted_probability: row.get("avg_predicted_prob"),
            actual_frequency: row.get("actual_frequency"),
            count: row.get("prediction_count"),
        });
    }

    Ok(bins)
}

// Enhanced user accuracy with Brier scores
pub async fn calculate_enhanced_user_accuracy(pool: &PgPool, user_id: i32) -> Result<Option<UserAccuracy>> {
    let row = sqlx::query(
        r#"
        SELECT 
            u.id as user_id,
            u.username,
            COUNT(p.id) as total_predictions,
            COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) as correct_predictions,
            CASE 
                WHEN COUNT(p.id) > 0 THEN 
                    (COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) * 100.0 / COUNT(p.id))::FLOAT8
                ELSE 0.0 
            END as accuracy_rate,
            CASE 
                WHEN SUM(p.confidence) > 0 THEN 
                    (SUM(CASE WHEN p.outcome = 'correct' THEN p.confidence ELSE 0 END) * 100.0 / SUM(p.confidence))::FLOAT8
                ELSE NULL 
            END as weighted_accuracy,
            -- Overall Brier score
            AVG(
                POWER(
                    (p.confidence / 100.0) - 
                    CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                    2
                )
            )::FLOAT8 as brier_score,
            -- Monthly Brier score (last 30 days)
            AVG(
                CASE WHEN p.created_at >= NOW() - INTERVAL '30 days' THEN
                    POWER(
                        (p.confidence / 100.0) - 
                        CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                        2
                    )
                END
            )::FLOAT8 as monthly_brier,
            -- Weekly Brier score (last 7 days)
            AVG(
                CASE WHEN p.created_at >= NOW() - INTERVAL '7 days' THEN
                    POWER(
                        (p.confidence / 100.0) - 
                        CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                        2
                    )
                END
            )::FLOAT8 as weekly_brier
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
            brier_score: row.get("brier_score"),
            calibration_score: None, // Calculated separately
            monthly_brier: row.get("monthly_brier"),
            weekly_brier: row.get("weekly_brier"),
        }))
    } else {
        Ok(None)
    }
}

// Get enhanced leaderboard with Brier scores
pub async fn get_enhanced_leaderboard(pool: &PgPool, limit: i32) -> Result<Vec<UserAccuracy>> {
    let rows = sqlx::query(
        r#"
        SELECT 
            u.id as user_id,
            u.username,
            COUNT(p.id) as total_predictions,
            COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) as correct_predictions,
            CASE 
                WHEN COUNT(p.id) > 0 THEN 
                    (COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) * 100.0 / COUNT(p.id))::FLOAT8
                ELSE 0.0 
            END as accuracy_rate,
            CASE 
                WHEN SUM(p.confidence) > 0 THEN 
                    (SUM(CASE WHEN p.outcome = 'correct' THEN p.confidence ELSE 0 END) * 100.0 / SUM(p.confidence))::FLOAT8
                ELSE NULL 
            END as weighted_accuracy,
            AVG(
                POWER(
                    (p.confidence / 100.0) - 
                    CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                    2
                )
            )::FLOAT8 as brier_score,
            AVG(
                CASE WHEN p.created_at >= NOW() - INTERVAL '30 days' THEN
                    POWER(
                        (p.confidence / 100.0) - 
                        CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                        2
                    )
                END
            )::FLOAT8 as monthly_brier,
            AVG(
                CASE WHEN p.created_at >= NOW() - INTERVAL '7 days' THEN
                    POWER(
                        (p.confidence / 100.0) - 
                        CASE WHEN p.outcome = 'correct' THEN 1.0 ELSE 0.0 END, 
                        2
                    )
                END
            )::FLOAT8 as weekly_brier
        FROM users u
        LEFT JOIN predictions p ON u.id = p.user_id AND p.outcome IS NOT NULL
        GROUP BY u.id, u.username
        HAVING COUNT(p.id) > 0
        ORDER BY brier_score ASC, accuracy_rate DESC -- Lower Brier score is better
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
            brier_score: row.get("brier_score"),
            calibration_score: None,
            monthly_brier: row.get("monthly_brier"),
            weekly_brier: row.get("weekly_brier"),
        });
    }

    Ok(leaderboard)
}

