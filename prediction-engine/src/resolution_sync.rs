// Resolution sync: providers are only polled with status=open during import,
// so resolved outcomes never arrive on their own. This module walks our
// past-close, unresolved, provider-mapped binary events, asks each provider
// for the market's current resolution by external id, and settles matches
// through lmsr_api::resolve_event (transactional payout path).
//
// v1 scope: binary events on manifold / metaculus / polymarket. Multiple
// choice, numeric, and voided/annulled markets are counted but skipped —
// they need outcome-id mapping and a refund path respectively.

use anyhow::Result;
use reqwest::Client;
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::env;
use std::time::Duration;

const BATCH_LIMIT: i64 = 400;
const REQUEST_DELAY_MS: u64 = 150;

#[derive(Default)]
pub struct ResolutionStats {
    pub checked: u32,
    pub resolved: u32,
    pub still_open: u32,
    pub unsupported: u32,
    pub errors: u32,
}

impl ResolutionStats {
    pub fn to_json(&self) -> Value {
        json!({
            "checked": self.checked,
            "resolved": self.resolved,
            "still_open": self.still_open,
            "unsupported": self.unsupported,
            "errors": self.errors,
        })
    }
}

pub async fn sync_resolutions(pool: &PgPool) -> Result<ResolutionStats> {
    let rows = sqlx::query(
        "SELECT e.id, s.source, s.external_id
         FROM events e
         JOIN event_external_sources s ON s.event_id = e.id
         WHERE e.outcome IS NULL
           AND e.closing_date <= NOW()
           AND e.event_type = 'binary'
           -- Metaculus's API returns resolution: null for every question at
           -- our token's access level (verified 2026-07-07, even on their own
           -- resolved-list endpoint), so lookups are pure waste and would
           -- clog the oldest-first batch forever. Re-enable if they expose it.
           AND s.source != 'metaculus'
         ORDER BY e.closing_date ASC
         LIMIT $1",
    )
    .bind(BATCH_LIMIT)
    .fetch_all(pool)
    .await?;

    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Intellacc-PredictionEngine/1.0")
        .build()?;

    let mut stats = ResolutionStats::default();
    println!(
        "🔎 Resolution sync: checking {} past-close unresolved binary events",
        rows.len()
    );

    for row in rows {
        let event_id: i32 = row.get("id");
        let source: String = row.get("source");
        let external_id: String = row.get("external_id");
        stats.checked += 1;

        let verdict = match source.as_str() {
            "manifold" => manifold_resolution(&client, &external_id).await,
            "metaculus" => metaculus_resolution(&client, &external_id).await,
            "polymarket" => polymarket_resolution(&client, &external_id).await,
            _ => {
                stats.unsupported += 1;
                continue;
            }
        };

        match verdict {
            Ok(Verdict::Resolved(outcome)) => {
                match crate::lmsr_api::resolve_event(pool, event_id, outcome).await {
                    Ok(()) => {
                        stats.resolved += 1;
                        println!(
                            "✅ Resolved event {} ({}: {}) -> {}",
                            event_id,
                            source,
                            external_id,
                            if outcome { "YES" } else { "NO" }
                        );
                    }
                    Err(err) => {
                        stats.errors += 1;
                        println!("⚠️ Settle failed for event {}: {}", event_id, err);
                    }
                }
            }
            Ok(Verdict::StillOpen) => stats.still_open += 1,
            Ok(Verdict::Unsupported) => stats.unsupported += 1,
            Err(err) => {
                stats.errors += 1;
                println!(
                    "⚠️ Resolution lookup failed ({}: {}): {}",
                    source, external_id, err
                );
            }
        }

        tokio::time::sleep(Duration::from_millis(REQUEST_DELAY_MS)).await;
    }

    println!(
        "🔎 Resolution sync done: {} checked, {} resolved, {} still open, {} unsupported, {} errors",
        stats.checked, stats.resolved, stats.still_open, stats.unsupported, stats.errors
    );
    Ok(stats)
}

enum Verdict {
    Resolved(bool),
    StillOpen,
    // Resolved on the provider but not expressible as YES/NO (MKT/percent
    // resolutions, cancelled/annulled markets needing refunds).
    Unsupported,
}

async fn manifold_resolution(client: &Client, external_id: &str) -> Result<Verdict> {
    let url = format!("https://api.manifold.markets/v0/market/{}", external_id);
    let body: Value = client.get(&url).send().await?.error_for_status()?.json().await?;

    if !body["isResolved"].as_bool().unwrap_or(false) {
        return Ok(Verdict::StillOpen);
    }
    match body["resolution"].as_str() {
        Some("YES") => Ok(Verdict::Resolved(true)),
        Some("NO") => Ok(Verdict::Resolved(false)),
        _ => Ok(Verdict::Unsupported),
    }
}

async fn metaculus_resolution(client: &Client, external_id: &str) -> Result<Verdict> {
    let token = env::var("METACULUS_API_TOKEN")
        .map_err(|_| anyhow::anyhow!("METACULUS_API_TOKEN not set"))?;
    let url = format!("https://www.metaculus.com/api/posts/{}/", external_id);
    let body: Value = client
        .get(&url)
        .header("Authorization", format!("Token {}", token))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let resolution = body["question"]["resolution"].as_str().unwrap_or("");
    match resolution {
        "yes" => Ok(Verdict::Resolved(true)),
        "no" => Ok(Verdict::Resolved(false)),
        "annulled" | "ambiguous" => Ok(Verdict::Unsupported),
        _ => Ok(Verdict::StillOpen),
    }
}

async fn polymarket_resolution(client: &Client, external_id: &str) -> Result<Verdict> {
    let url = format!("https://gamma-api.polymarket.com/markets/{}", external_id);
    let body: Value = client.get(&url).send().await?.error_for_status()?.json().await?;

    if !body["closed"].as_bool().unwrap_or(false) {
        return Ok(Verdict::StillOpen);
    }
    // outcomePrices is a JSON-encoded string like "[\"1\", \"0\"]" ordered to
    // match `outcomes` (typically ["Yes", "No"]). A settled market pins the
    // winning outcome to ~1.
    let prices_raw = body["outcomePrices"].as_str().unwrap_or("[]");
    let prices: Vec<String> = serde_json::from_str(prices_raw).unwrap_or_default();
    let parsed: Vec<f64> = prices
        .iter()
        .filter_map(|p| p.parse::<f64>().ok())
        .collect();
    if parsed.len() != 2 {
        return Ok(Verdict::Unsupported);
    }
    if parsed[0] > 0.99 && parsed[1] < 0.01 {
        Ok(Verdict::Resolved(true))
    } else if parsed[1] > 0.99 && parsed[0] < 0.01 {
        Ok(Verdict::Resolved(false))
    } else {
        Ok(Verdict::Unsupported)
    }
}
