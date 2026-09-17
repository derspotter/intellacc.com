//! Repair a single untouched legacy import from a saved Metaculus post response.
use anyhow::{anyhow, Result};
use prediction_engine::{market_import::repair_legacy_numeric_market, metaculus::MetaculusClient};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 || args.len() > 3 || (args.len() == 3 && args[2] != "--apply") {
        return Err(anyhow!(
            "usage: repair_legacy_numeric EVENT_ID POST_JSON [--apply] (default: dry run)"
        ));
    }
    let event_id: i32 = args[0].parse()?;
    let market =
        MetaculusClient::new().market_from_post_json(&std::fs::read_to_string(&args[1])?)?;
    let database_url = std::env::var("DATABASE_URL")?;
    let pool = sqlx::PgPool::connect(&database_url).await?;
    let apply = args.len() == 3;
    repair_legacy_numeric_market(&pool, event_id, &market, apply).await?;
    println!(
        "{} event {} (question {}, range {:?}..{:?}, unit {:?})",
        if apply { "Repaired" } else { "Dry-run OK for" },
        event_id,
        market.external_id,
        market.numeric_range_min,
        market.numeric_range_max,
        market.numeric_unit
    );
    Ok(())
}
