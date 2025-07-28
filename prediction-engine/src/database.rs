// Database connection and query functions - CLEANED VERSION
use sqlx::{PgPool, Row};
use anyhow::Result;
use chrono::{DateTime, Utc, NaiveDateTime};
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;

// Common SQL fragments to ensure DRY principle
const ACCURACY_CALCULATION_SQL: &str = r#"
    CASE 
        WHEN COUNT(p.id) > 0 THEN 
            COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) * 100.0 / COUNT(p.id)
        ELSE 0 
    END as accuracy_rate"#;

const WEIGHTED_ACCURACY_SQL: &str = r#"
    CASE 
        WHEN SUM(p.confidence) > 0 THEN 
            SUM(CASE WHEN p.outcome = 'correct' THEN p.confidence ELSE 0 END) * 100.0 / SUM(p.confidence)
        ELSE NULL 
    END as weighted_accuracy"#;

// This struct represents user prediction accuracy data
#[derive(Debug)]
pub struct UserAccuracy {
    pub user_id: i32,
    pub username: String,
    pub total_predictions: i64,
    pub correct_predictions: i64,
    pub accuracy_rate: f64,
    pub weighted_accuracy: Option<f64>,
    pub log_loss: Option<f64>,
    pub calibration_score: Option<f64>,
}

// Struct for individual prediction with log scoring
#[derive(Debug)]
pub struct PredictionScore {
    pub prediction_id: i32,
    pub user_id: i32,
    pub confidence: f64,
    pub outcome: bool,
    pub log_loss: f64,
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
    let query = format!(
        r#"
        SELECT 
            u.id as user_id,
            u.username,
            COUNT(p.id) as total_predictions,
            COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) as correct_predictions,
            {},
            {}
        FROM users u
        LEFT JOIN predictions p ON u.id = p.user_id AND p.outcome IS NOT NULL
        WHERE u.id = $1
        GROUP BY u.id, u.username
        "#,
        ACCURACY_CALCULATION_SQL, WEIGHTED_ACCURACY_SQL
    );
    
    let row = sqlx::query(&query)
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
            log_loss: None,
            calibration_score: None,
        }))
    } else {
        Ok(None)
    }
}

// Get leaderboard - top users by accuracy
pub async fn get_leaderboard(pool: &PgPool, limit: i32) -> Result<Vec<UserAccuracy>> {
    let query = format!(
        r#"
        SELECT 
            u.id as user_id,
            u.username,
            COUNT(p.id) as total_predictions,
            COUNT(CASE WHEN p.outcome = 'correct' THEN 1 END) as correct_predictions,
            {},
            {}
        FROM users u
        LEFT JOIN predictions p ON u.id = p.user_id AND p.outcome IS NOT NULL
        GROUP BY u.id, u.username
        HAVING COUNT(p.id) > 0  -- Only users with predictions
        ORDER BY accuracy_rate DESC, total_predictions DESC
        LIMIT $1
        "#,
        ACCURACY_CALCULATION_SQL, WEIGHTED_ACCURACY_SQL
    );
    
    let rows = sqlx::query(&query)
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
            log_loss: None,
            calibration_score: None,
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
    pub log_loss: Option<f64>,
    pub rank_in_domain: Option<i64>,
}

// Calculate user's numerical prediction accuracy
pub async fn calculate_user_numerical_accuracy(pool: &PgPool, user_id: i32) -> Result<Option<f64>> {
    let row = sqlx::query(
        r#"
        SELECT 
            AVG(p.numerical_score) as avg_numerical_score
        FROM predictions p
        WHERE p.user_id = $1 
          AND p.prediction_type IN ('numeric', 'discrete')
          AND p.numerical_score IS NOT NULL
        "#
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    if let Some(row) = row {
        Ok(row.get("avg_numerical_score"))
    } else {
        Ok(None)
    }
}

// Calculate and update numerical scores for resolved predictions
pub async fn update_numerical_scores(pool: &PgPool) -> Result<i32> {
    let updated_count = sqlx::query(
        r#"
        UPDATE predictions 
        SET numerical_score = CASE
            WHEN prediction_type IN ('numeric', 'discrete') AND actual_value IS NOT NULL THEN
                CASE 
                    WHEN lower_bound IS NOT NULL AND upper_bound IS NOT NULL THEN
                        -- Interval score calculation
                        (upper_bound - lower_bound) + 
                        CASE 
                            WHEN actual_value < lower_bound THEN 0.4 * (lower_bound - actual_value)
                            WHEN actual_value > upper_bound THEN 0.4 * (actual_value - upper_bound)
                            ELSE 0
                        END
                    ELSE
                        -- Simple absolute error for point estimates
                        ABS(numerical_value - actual_value)
                END
            ELSE numerical_score
        END
        WHERE prediction_type IN ('numeric', 'discrete') 
          AND actual_value IS NOT NULL 
          AND numerical_score IS NULL
        "#
    )
    .execute(pool)
    .await?;

    Ok(updated_count.rows_affected() as i32)
}

// ============================================================================
// UNIFIED LOG SCORING SYSTEM (All-Log + PLL)
// ============================================================================

/// Calculate and store log loss scores for resolved predictions
pub async fn calculate_log_scores(pool: &PgPool) -> Result<i32> {
    let updated_count = sqlx::query(
        r#"
        UPDATE predictions 
        SET raw_log_loss = CASE
            WHEN prediction_type = 'binary' AND outcome IS NOT NULL AND prob_vector IS NOT NULL THEN
                CASE 
                    WHEN outcome = 'correct' THEN -LN(GREATEST((prob_vector->>0)::FLOAT, 0.0001))
                    ELSE -LN(GREATEST((prob_vector->>1)::FLOAT, 0.0001))
                END
            ELSE raw_log_loss
        END
        WHERE (prediction_type IN ('binary', 'multiple_choice')) 
          AND (outcome IS NOT NULL OR outcome_index IS NOT NULL)
          AND raw_log_loss IS NULL
        "#
    )
    .execute(pool)
    .await?;

    Ok(updated_count.rows_affected() as i32)
}

/// Calculate time-weighted scores for all predictions
pub async fn calculate_time_weighted_scores(pool: &PgPool) -> Result<i32> {
    // First, create time slices for predictions that don't have them
    let _slice_count = sqlx::query(
        r#"
        INSERT INTO score_slices (prediction_id, slice_start, slice_end, raw_loss, time_weight)
        SELECT 
            p.id,
            p.created_at + (generate_series(0, EXTRACT(HOURS FROM (e.closing_date - p.created_at))::int - 1) * interval '1 hour'),
            p.created_at + ((generate_series(0, EXTRACT(HOURS FROM (e.closing_date - p.created_at))::int - 1) + 1) * interval '1 hour'),
            p.raw_log_loss,
            1.0 / EXTRACT(HOURS FROM (e.closing_date - p.created_at))
        FROM predictions p
        JOIN events e ON p.event_id = e.id
        WHERE p.raw_log_loss IS NOT NULL
          AND e.closing_date > p.created_at
          AND NOT EXISTS (SELECT 1 FROM score_slices s WHERE s.prediction_id = p.id)
        "#
    )
    .execute(pool)
    .await?;

    // Calculate time-weighted accuracy for each user
    let update_count = sqlx::query(
        r#"
        UPDATE user_reputation 
        SET time_weighted_score = subquery.total_weighted_score,
            updated_at = NOW()
        FROM (
            SELECT 
                p.user_id,
                COALESCE(SUM(ss.raw_loss * ss.time_weight), 0) as total_weighted_score
            FROM predictions p
            LEFT JOIN score_slices ss ON p.id = ss.prediction_id
            WHERE p.raw_log_loss IS NOT NULL
            GROUP BY p.user_id
        ) as subquery
        WHERE user_reputation.user_id = subquery.user_id
        "#
    )
    .execute(pool)
    .await?;

    Ok(update_count.rows_affected() as i32)
}

/// Calculate peer bonus for a specific user
pub async fn calculate_user_peer_bonus(pool: &PgPool, user_id: i32) -> Result<f64> {
    let result: Option<Decimal> = sqlx::query_scalar(
        r#"
        SELECT COALESCE(AVG(
            CASE 
                WHEN crowd_size >= 5 THEN
                    LEAST(crowd_size::FLOAT / 20.0, 0.5) * (crowd_avg - user_score)
                ELSE 0
            END
        ), 0) as peer_bonus
        FROM (
            SELECT 
                p.raw_log_loss as user_score,
                AVG(other_p.raw_log_loss) as crowd_avg,
                COUNT(other_p.id) as crowd_size
            FROM predictions p
            LEFT JOIN predictions other_p ON p.event_id = other_p.event_id 
                AND other_p.user_id != p.user_id 
                AND other_p.raw_log_loss IS NOT NULL
            WHERE p.user_id = $1 
              AND p.raw_log_loss IS NOT NULL
            GROUP BY p.id, p.raw_log_loss
        ) as event_scores
        "#
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;

    Ok(result.unwrap_or(Decimal::from(0)).to_f64().unwrap_or(0.0))
}

/// Update reputation points for a user
pub async fn update_user_reputation(pool: &PgPool, user_id: i32) -> Result<Decimal> {
    // Get or create user reputation record
    sqlx::query(
        r#"
        INSERT INTO user_reputation (user_id, rep_points) 
        VALUES ($1, 1.0)
        ON CONFLICT (user_id) DO NOTHING
        "#
    )
    .bind(user_id)
    .execute(pool)
    .await?;

    // Calculate peer bonus
    let peer_bonus = calculate_user_peer_bonus(pool, user_id).await?;

    // Get time-weighted score and update reputation
    let rep_points: Option<Decimal> = sqlx::query_scalar(
        r#"
        UPDATE user_reputation 
        SET peer_bonus = $2,
            rep_points = 10 * TANH(-(COALESCE(time_weighted_score, 0) - $2)) + 1,
            updated_at = NOW()
        WHERE user_id = $1
        RETURNING rep_points
        "#
    )
    .bind(user_id)
    .bind(Decimal::from_f64_retain(peer_bonus).unwrap_or(Decimal::from(0)))
    .fetch_one(pool)
    .await?;

    Ok(rep_points.unwrap_or(Decimal::from(1)))
}

/// Resolve event and update all participants' scores
pub async fn resolve_event_batch(pool: &PgPool, event_id: i32, outcome_index: i32) -> Result<i32> {
    println!("🎯 Resolving event {} with outcome {}", event_id, outcome_index);
    
    // Update event with outcome
    sqlx::query(
        "UPDATE events SET outcome = 'resolved', numerical_outcome = $1, updated_at = NOW() WHERE id = $2"
    )
    .bind(Decimal::from(outcome_index))
    .bind(event_id)
    .execute(pool)
    .await?;

    // Get all predictions for this event
    let predictions = sqlx::query(
        r#"
        SELECT id, user_id, prob_vector 
        FROM predictions 
        WHERE event_id = $1 AND prob_vector IS NOT NULL
        "#
    )
    .bind(event_id)
    .fetch_all(pool)
    .await?;

    println!("📊 Processing {} predictions for event {}", predictions.len(), event_id);

    // Calculate scores in Rust (parallel processing)
    let score_updates: Vec<_> = predictions.iter().map(|row| {
        let prediction_id: i32 = row.get("id");
        let user_id: i32 = row.get("user_id");
        let prob_vector_json: serde_json::Value = row.get("prob_vector");
        
        // Parse probability vector
        let prob_vec: Vec<f64> = serde_json::from_value(prob_vector_json).unwrap_or(vec![0.5, 0.5]);
        
        // Calculate log loss
        let log_loss = calculate_log_loss(&prob_vec, outcome_index as usize);
        
        (prediction_id, user_id, log_loss)
    }).collect();

    // Batch update predictions with scores
    for (prediction_id, _user_id, log_loss) in &score_updates {
        sqlx::query(
            "UPDATE predictions SET raw_log_loss = $1, outcome_index = $2, resolved_at = NOW() WHERE id = $3"
        )
        .bind(*log_loss)
        .bind(outcome_index)
        .bind(*prediction_id)
        .execute(pool)
        .await?;
    }

    // Get unique user IDs to update
    let unique_users: std::collections::HashSet<i32> = score_updates.iter().map(|(_, user_id, _)| *user_id).collect();
    
    // Update time-weighted scores for all affected users
    for user_id in &unique_users {
        calculate_time_weighted_scores_for_user(pool, *user_id).await?;
        update_user_reputation(pool, *user_id).await?;
    }

    // Recalculate global rankings for all users (zero-sum)
    update_global_rankings(pool).await?;

    Ok(score_updates.len() as i32)
}

/// Calculate time-weighted scores for a specific user
pub async fn calculate_time_weighted_scores_for_user(pool: &PgPool, user_id: i32) -> Result<()> {
    // Create time slices for new predictions
    sqlx::query(
        r#"
        INSERT INTO score_slices (prediction_id, slice_start, slice_end, raw_loss, time_weight)
        SELECT 
            p.id,
            p.created_at,
            COALESCE(e.closing_date, p.created_at + interval '24 hours'),
            p.raw_log_loss,
            1.0 / GREATEST(EXTRACT(HOURS FROM (COALESCE(e.closing_date, p.created_at + interval '24 hours') - p.created_at)), 1)
        FROM predictions p
        LEFT JOIN events e ON p.event_id = e.id
        WHERE p.user_id = $1 
          AND p.raw_log_loss IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM score_slices s WHERE s.prediction_id = p.id)
        "#
    )
    .bind(user_id)
    .execute(pool)
    .await?;

    // Update user's time-weighted score
    sqlx::query(
        r#"
        UPDATE user_reputation 
        SET time_weighted_score = COALESCE((
            SELECT SUM(ss.raw_loss * ss.time_weight)
            FROM predictions p
            LEFT JOIN score_slices ss ON p.id = ss.prediction_id
            WHERE p.user_id = $1 AND p.raw_log_loss IS NOT NULL
        ), 0),
        updated_at = NOW()
        WHERE user_id = $1
        "#
    )
    .bind(user_id)
    .execute(pool)
    .await?;

    Ok(())
}

/// Update global rankings for all users (zero-sum relative ranking)
pub async fn update_global_rankings(pool: &PgPool) -> Result<i32> {
    println!("🏆 Updating global rankings...");
    
    // Calculate rankings using window function and update in single query
    let updated_count = sqlx::query(
        r#"
        UPDATE user_reputation 
        SET global_rank = ranking.new_rank,
            updated_at = NOW()
        FROM (
            SELECT 
                user_id,
                RANK() OVER (ORDER BY rep_points DESC, time_weighted_score ASC) as new_rank
            FROM user_reputation
            WHERE rep_points IS NOT NULL
        ) as ranking
        WHERE user_reputation.user_id = ranking.user_id
          AND (user_reputation.global_rank IS NULL OR user_reputation.global_rank != ranking.new_rank)
        "#
    )
    .execute(pool)
    .await?;

    println!("📊 Updated rankings for {} users", updated_count.rows_affected());
    Ok(updated_count.rows_affected() as i32)
}



/// Get user reputation and stats
pub async fn get_user_reputation_stats(pool: &PgPool, user_id: i32) -> Result<Option<serde_json::Value>> {
    let row = sqlx::query(
        r#"
        SELECT 
            ur.rep_points,
            ur.global_rank,
            ur.time_weighted_score,
            ur.peer_bonus,
            ur.updated_at::TEXT as updated_at,
            COUNT(p.id) as total_predictions,
            AVG(p.raw_log_loss) as avg_log_loss,
            (SELECT COUNT(*) FROM user_reputation WHERE global_rank IS NOT NULL) as total_users,
            CASE 
                WHEN ur.rep_points >= 9.0 THEN 'Oracle'
                WHEN ur.rep_points >= 7.0 THEN 'Expert'
                WHEN ur.rep_points >= 5.0 THEN 'Skilled'
                WHEN ur.rep_points >= 3.0 THEN 'Novice'
                ELSE 'Beginner'
            END as level
        FROM user_reputation ur
        LEFT JOIN predictions p ON ur.user_id = p.user_id AND p.raw_log_loss IS NOT NULL
        WHERE ur.user_id = $1
        GROUP BY ur.user_id, ur.rep_points, ur.global_rank, ur.time_weighted_score, ur.peer_bonus, ur.updated_at
        "#
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    if let Some(row) = row {
        Ok(Some(serde_json::json!({
            "user_id": user_id,
            "rep_points": row.get::<Option<Decimal>, _>("rep_points").unwrap_or(Decimal::from(1)).to_f64().unwrap_or(1.0),
            "global_rank": row.get::<Option<i32>, _>("global_rank"),
            "total_users": row.get::<i64, _>("total_users"),
            "time_weighted_score": row.get::<Option<Decimal>, _>("time_weighted_score").unwrap_or(Decimal::from(0)).to_f64().unwrap_or(0.0),
            "peer_bonus": row.get::<Option<Decimal>, _>("peer_bonus").unwrap_or(Decimal::from(0)).to_f64().unwrap_or(0.0),
            "total_predictions": row.get::<i64, _>("total_predictions"),
            "avg_log_loss": row.get::<Option<Decimal>, _>("avg_log_loss").map(|d| d.to_f64().unwrap_or(0.0)),
            "level": row.get::<String, _>("level"),
            "updated_at": row.get::<String, _>("updated_at")
        })))
    } else {
        Ok(None)
    }
}

/// Get enhanced leaderboard with log scoring
pub async fn get_log_scoring_leaderboard(pool: &PgPool, limit: i32) -> Result<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        r#"
        SELECT 
            u.id as user_id,
            u.username,
            ur.rep_points,
            ur.time_weighted_score,
            ur.peer_bonus,
            COUNT(p.id) as total_predictions,
            AVG(p.raw_log_loss) as avg_log_loss
        FROM users u
        JOIN user_reputation ur ON u.id = ur.user_id
        LEFT JOIN predictions p ON u.id = p.user_id AND p.raw_log_loss IS NOT NULL
        GROUP BY u.id, u.username, ur.rep_points, ur.time_weighted_score, ur.peer_bonus
        HAVING COUNT(p.id) > 0
        ORDER BY ur.rep_points DESC, COUNT(p.id) DESC
        LIMIT $1
        "#
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut leaderboard = Vec::new();
    for row in rows {
        leaderboard.push(serde_json::json!({
            "user_id": row.get::<i32, _>("user_id"),
            "username": row.get::<String, _>("username"),
            "rep_points": row.get::<Option<Decimal>, _>("rep_points").unwrap_or(Decimal::from(1)).to_f64().unwrap_or(1.0),
            "time_weighted_score": row.get::<Option<Decimal>, _>("time_weighted_score").unwrap_or(Decimal::from(0)).to_f64().unwrap_or(0.0),
            "peer_bonus": row.get::<Option<Decimal>, _>("peer_bonus").unwrap_or(Decimal::from(0)).to_f64().unwrap_or(0.0),
            "total_predictions": row.get::<i64, _>("total_predictions"),
            "avg_log_loss": row.get::<Option<Decimal>, _>("avg_log_loss").map(|d| d.to_f64().unwrap_or(0.0))
        }));
    }

    Ok(leaderboard)
}

// ============================================================================
// UNIFIED LOG SCORING SYSTEM (All-Log + PLL) - PURE FUNCTIONS
// ============================================================================

/// Calculate log loss for binary predictions
/// Formula: L = -ln(p_true)
/// Lower scores are better (0 is perfect)
pub fn calculate_log_loss(prob_vector: &[f64], outcome_index: usize) -> f64 {
    if outcome_index >= prob_vector.len() {
        return f64::INFINITY; // Invalid outcome index
    }
    
    let p_true = prob_vector[outcome_index].max(1e-4); // Clip to avoid infinity
    -p_true.ln()
}

/// Calculate Penalised Log-Loss (PLL) for multi-choice predictions
/// Formula: L = -ln(p_true) + [-ln(1/K)] * 1_{argmax ≠ true}
/// Ensures any forecast with correct top choice beats any with wrong top choice
pub fn calculate_pll_loss(prob_vector: &[f64], outcome_index: usize) -> f64 {
    if outcome_index >= prob_vector.len() {
        return f64::INFINITY;
    }
    
    let k = prob_vector.len() as f64;
    let base_log_loss = calculate_log_loss(prob_vector, outcome_index);
    
    // Find argmax (top choice)
    let argmax_index = prob_vector.iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(idx, _)| idx)
        .unwrap_or(0);
    
    // Add penalty if top choice is wrong
    let penalty = if argmax_index != outcome_index {
        -(1.0 / k).ln() // -ln(1/K) penalty
    } else {
        0.0
    };
    
    base_log_loss + penalty
}

/// Parameters for numeric probability distributions
#[derive(Debug, Clone)]
pub struct NumericDistribution {
    pub dist_type: String,  // "normal", "lognormal", "uniform", etc.
    pub params: Vec<f64>,   // [mean, std] for normal, [min, max] for uniform, etc.
}

impl NumericDistribution {
    /// Calculate probability density at a given value
    pub fn density_at(&self, value: f64) -> f64 {
        match self.dist_type.as_str() {
            "normal" => {
                if self.params.len() != 2 { return 1e-4; }
                let mean = self.params[0];
                let std = self.params[1].max(1e-6); // Avoid division by zero
                
                let z = (value - mean) / std;
                let coeff = 1.0 / (std * (2.0 * std::f64::consts::PI).sqrt());
                coeff * (-0.5 * z * z).exp()
            },
            "lognormal" => {
                if value <= 0.0 || self.params.len() != 2 { return 1e-4; }
                let mu = self.params[0];
                let sigma = self.params[1].max(1e-6);
                
                let ln_value = value.ln();
                let z = (ln_value - mu) / sigma;
                let coeff = 1.0 / (value * sigma * (2.0 * std::f64::consts::PI).sqrt());
                coeff * (-0.5 * z * z).exp()
            },
            "uniform" => {
                if self.params.len() != 2 { return 1e-4; }
                let min_val = self.params[0];
                let max_val = self.params[1];
                
                if value >= min_val && value <= max_val && max_val > min_val {
                    1.0 / (max_val - min_val)
                } else {
                    1e-4
                }
            },
            _ => 1e-4 // Unknown distribution type
        }
    }
}

/// Calculate negative log-likelihood for numeric predictions
/// Formula: L = -ln(f_θ(x_true))
/// Uses full PDF with density clipping at ε = 10^-4 to avoid infinity
pub fn calculate_numeric_log_likelihood(distribution: &NumericDistribution, actual_value: f64) -> f64 {
    let density = distribution.density_at(actual_value).max(1e-4);
    -density.ln()
}

/// Convert raw log loss to positive reputation points
/// Formula: Rep = 10 * tanh(-(Acc + R)) + 1
/// Where Acc is time-weighted accuracy and R is peer bonus
pub fn convert_to_reputation_points(time_weighted_loss: f64, peer_bonus: f64) -> f64 {
    // Negate because lower log loss = better performance
    let combined_score = -(time_weighted_loss - peer_bonus);
    10.0 * combined_score.tanh() + 1.0
}

/// Calculate time weight for a prediction slice
/// Formula: w_s = Δt / T_open
pub fn calculate_time_weight(slice_duration_hours: f64, total_question_duration_hours: f64) -> f64 {
    if total_question_duration_hours <= 0.0 {
        return 1.0;
    }
    slice_duration_hours / total_question_duration_hours
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

// Enhanced user accuracy with log scores only
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
            AVG(p.raw_log_loss)::FLOAT8 as avg_log_loss
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
            log_loss: row.get("avg_log_loss"),
            calibration_score: None, // Calculated separately
        }))
    } else {
        Ok(None)
    }
}

// Get enhanced leaderboard with log scores only
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
            AVG(p.raw_log_loss)::FLOAT8 as avg_log_loss
        FROM users u
        LEFT JOIN predictions p ON u.id = p.user_id AND p.outcome IS NOT NULL
        GROUP BY u.id, u.username
        HAVING COUNT(p.id) > 0
        ORDER BY avg_log_loss ASC, accuracy_rate DESC -- Lower log loss is better
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
            log_loss: row.get("avg_log_loss"),
            calibration_score: None,
        });
    }

    Ok(leaderboard)
}
// ============================================================================
// LMSR MARKET STATE QUERY FUNCTIONS
// ============================================================================

// Struct for market state information
#[derive(Debug)]
pub struct MarketState {
    pub event_id: i32,
    pub title: String,
    pub market_prob: Decimal,
    pub cumulative_stake: Decimal,
    pub liquidity_b: Decimal,
    pub unique_traders: i64,
    pub total_trades: i64,
}

// Struct for user market positions
#[derive(Debug)]
pub struct UserMarketPosition {
    pub user_id: i32,
    pub event_id: i32,
    pub yes_shares: Decimal,
    pub no_shares: Decimal,
    pub total_staked: Decimal,
    pub unrealized_pnl: Decimal,
    pub last_updated: DateTime<Utc>,
}

// Struct for recent market updates
#[derive(Debug)]
pub struct MarketUpdate {
    pub id: i32,
    pub user_id: i32,
    pub username: String,
    pub event_id: i32,
    pub prev_prob: Decimal,
    pub new_prob: Decimal,
    pub stake_amount: Decimal,
    pub shares_acquired: Decimal,
    pub share_type: String,
    pub created_at: DateTime<Utc>,
}

// Get comprehensive market state for an event
pub async fn get_event_market_state(pool: &PgPool, event_id: i32) -> Result<Option<MarketState>> {
    let row = sqlx::query(
        r#"
        SELECT 
            e.id as event_id,
            e.title,
            e.market_prob,
            e.cumulative_stake,
            e.liquidity_b,
            COUNT(DISTINCT mu.user_id) as unique_traders,
            COUNT(mu.id) as total_trades
        FROM events e
        LEFT JOIN market_updates mu ON e.id = mu.event_id
        WHERE e.id = $1
        GROUP BY e.id, e.title, e.market_prob, e.cumulative_stake, e.liquidity_b
        "#
    )
    .bind(event_id)
    .fetch_optional(pool)
    .await?;

    match row {
        Some(row) => Ok(Some(MarketState {
            event_id: row.get("event_id"),
            title: row.get("title"),
            market_prob: row.get("market_prob"),
            cumulative_stake: row.get("cumulative_stake"),
            liquidity_b: row.get("liquidity_b"),
            unique_traders: row.get("unique_traders"),
            total_trades: row.get("total_trades"),
        })),
        None => Ok(None),
    }
}

// Get user's position in a specific market
pub async fn get_user_market_position(pool: &PgPool, user_id: i32, event_id: i32) -> Result<Option<UserMarketPosition>> {
    let row = sqlx::query(
        r#"
        SELECT 
            us.user_id,
            us.event_id,
            COALESCE(us.yes_shares, 0) as yes_shares,
            COALESCE(us.no_shares, 0) as no_shares,
            COALESCE(ledger_to_decimal(us.total_staked_ledger), 0) as total_staked,
            us.last_updated,
            e.market_prob
        FROM user_shares us
        LEFT JOIN events e ON us.event_id = e.id
        WHERE us.user_id = $1 AND us.event_id = $2
        "#
    )
    .bind(user_id)
    .bind(event_id)
    .fetch_optional(pool)
    .await?;

    match row {
        Some(row) => {
            let yes_shares: Decimal = row.get("yes_shares");
            let no_shares: Decimal = row.get("no_shares");
            let market_prob: Decimal = row.get("market_prob");
            let total_staked: Decimal = row.get("total_staked");
            
            // Calculate unrealized P&L
            let yes_value = yes_shares * market_prob;
            let no_value = no_shares * (Decimal::ONE - market_prob);
            let current_value = yes_value + no_value;
            let unrealized_pnl = current_value - total_staked;
            
            Ok(Some(UserMarketPosition {
                user_id: row.get("user_id"),
                event_id: row.get("event_id"),
                yes_shares,
                no_shares,
                total_staked,
                unrealized_pnl,
                last_updated: row.get("last_updated"),
            }))
        },
        None => Ok(None),
    }
}

// Get all active markets (events with market_prob set)
pub async fn get_active_markets(pool: &PgPool, limit: i32) -> Result<Vec<MarketState>> {
    let rows = sqlx::query(
        r#"
        SELECT 
            e.id as event_id,
            e.title,
            e.market_prob,
            e.cumulative_stake,
            e.liquidity_b,
            COUNT(DISTINCT mu.user_id) as unique_traders,
            COUNT(mu.id) as total_trades
        FROM events e
        LEFT JOIN market_updates mu ON e.id = mu.event_id
        WHERE e.market_prob IS NOT NULL 
        AND e.outcome IS NULL
        AND e.closing_date > NOW()
        GROUP BY e.id, e.title, e.market_prob, e.cumulative_stake, e.liquidity_b
        ORDER BY e.cumulative_stake DESC, COUNT(mu.id) DESC
        LIMIT $1
        "#
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut markets = Vec::new();
    for row in rows {
        markets.push(MarketState {
            event_id: row.get("event_id"),
            title: row.get("title"),
            market_prob: row.get("market_prob"),
            cumulative_stake: row.get("cumulative_stake"),
            liquidity_b: row.get("liquidity_b"),
            unique_traders: row.get("unique_traders"),
            total_trades: row.get("total_trades"),
        });
    }

    Ok(markets)
}

// Get user portfolio across all markets  
pub async fn get_user_portfolio(pool: &PgPool, user_id: i32) -> Result<Vec<UserMarketPosition>> {
    let rows = sqlx::query(
        r#"
        SELECT 
            us.user_id,
            us.event_id,
            COALESCE(us.yes_shares, 0) as yes_shares,
            COALESCE(us.no_shares, 0) as no_shares,
            COALESCE(ledger_to_decimal(us.total_staked_ledger), 0) as total_staked,
            us.last_updated,
            e.market_prob,
            e.title
        FROM user_shares us
        JOIN events e ON us.event_id = e.id
        WHERE us.user_id = $1
        AND (us.yes_shares > 0 OR us.no_shares > 0)
        AND e.outcome IS NULL
        ORDER BY us.last_updated DESC
        "#
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;

    let mut positions = Vec::new();
    for row in rows {
        let yes_shares: Decimal = row.get("yes_shares");
        let no_shares: Decimal = row.get("no_shares");
        let market_prob: Decimal = row.get("market_prob");
        let total_staked: Decimal = row.get("total_staked");
        
        // Calculate unrealized P&L
        let yes_value = yes_shares * market_prob;
        let no_value = no_shares * (Decimal::ONE - market_prob);
        let current_value = yes_value + no_value;
        let unrealized_pnl = current_value - total_staked;
        
        positions.push(UserMarketPosition {
            user_id: row.get("user_id"),
            event_id: row.get("event_id"),
            yes_shares,
            no_shares,
            total_staked,
            unrealized_pnl,
            last_updated: row.get("last_updated"),
        });
    }

    Ok(positions)
}

