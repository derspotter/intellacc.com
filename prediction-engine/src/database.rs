use anyhow::Result;
use sqlx::PgPool;

pub async fn create_pool(database_url: &str) -> Result<PgPool> {
    Ok(
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(20)
            .connect(database_url)
            .await?,
    )
}

#[derive(Debug, serde::Serialize, sqlx::FromRow, ts_rs::TS)]
#[ts(export, export_to = "../../shared/types/MarketEvent.ts")]
pub struct MarketEvent {
    pub id: i32,
    pub topic_id: Option<i32>,
    pub title: String,
    pub details: Option<String>,
    pub closing_date: Option<chrono::NaiveDateTime>,
    pub outcome: Option<String>,
    pub event_type: Option<String>,
    pub market_prob: f64,
    pub liquidity_b: f64,
    pub cumulative_stake: f64,
}

pub async fn get_events(pool: &PgPool, limit: i64) -> Result<Vec<MarketEvent>> {
    let events = sqlx::query_as::<_, MarketEvent>(
        r#"
        SELECT
          id,
          topic_id,
          title,
          details,
          closing_date,
          outcome,
          event_type,
          COALESCE(market_prob, 0.5) as market_prob,
          COALESCE(liquidity_b, 100.0) as liquidity_b,
          COALESCE(cumulative_stake, 0.0) as cumulative_stake
        FROM events
        ORDER BY closing_date ASC NULLS LAST
        LIMIT $1
        "#
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(events)
}
