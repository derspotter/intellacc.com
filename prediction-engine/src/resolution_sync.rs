// Resolution sync: providers are only polled with status=open during import,
// so resolved outcomes never arrive on their own. This module walks our
// past-close, unresolved, provider-mapped binary events, asks each provider
// for the market's current resolution by external id, and settles matches
// through lmsr_api::resolve_event (transactional payout path).
//
// v1 scope: binary events on manifold / metaculus / polymarket, plus
// multiple_choice events on manifold / metaculus (label-matched against
// event_outcomes, settled through lmsr_api::resolve_event_by_outcome_id).
// numeric events (Task 7): resolved value mapped to its winning bin
// (lower_bound <= v < upper_bound, final bin inclusive on upper) via
// pick_winning_bin, settled through the same resolve_event_by_outcome_id.
// Numeric markets are Metaculus-only today and Metaculus's resolution field
// is unreadable at our token's access level (see sync_numeric_resolutions),
// so this currently finds zero live candidates — the machinery is in place
// for when/if that changes. Voided/annulled markets are counted but
// skipped — that needs a refund path.

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
    // multiple_choice sub-counts (rolled into the totals above too, so
    // `resolved`/`checked`/etc. reflect binary + MC combined).
    pub mc_checked: u32,
    pub mc_resolved: u32,
    pub mc_no_label_match: u32,
    // numeric sub-counts (rolled into the totals above too, same convention
    // as the mc_* fields).
    pub numeric_checked: u32,
    pub numeric_resolved: u32,
    pub numeric_no_bin_match: u32,
}

impl ResolutionStats {
    pub fn to_json(&self) -> Value {
        json!({
            "checked": self.checked,
            "resolved": self.resolved,
            "still_open": self.still_open,
            "unsupported": self.unsupported,
            "errors": self.errors,
            "mc_checked": self.mc_checked,
            "mc_resolved": self.mc_resolved,
            "mc_no_label_match": self.mc_no_label_match,
            "numeric_checked": self.numeric_checked,
            "numeric_resolved": self.numeric_resolved,
            "numeric_no_bin_match": self.numeric_no_bin_match,
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

    sync_mc_resolutions(pool, &client, &mut stats).await?;
    sync_numeric_resolutions(pool, &client, &mut stats).await?;

    println!(
        "🔎 Resolution sync done: {} checked, {} resolved, {} still open, {} unsupported, {} errors ({} MC checked, {} MC resolved, {} MC no-label-match; {} numeric checked, {} numeric resolved, {} numeric no-bin-match)",
        stats.checked, stats.resolved, stats.still_open, stats.unsupported, stats.errors,
        stats.mc_checked, stats.mc_resolved, stats.mc_no_label_match,
        stats.numeric_checked, stats.numeric_resolved, stats.numeric_no_bin_match
    );
    Ok(stats)
}

// Multiple-choice resolution pass. Same shape as the binary loop above, but
// the provider verdict carries a winning *label* instead of a bool, which we
// match against event_outcomes.label (case-insensitive, trimmed) to find the
// outcome_id lmsr_api::resolve_event_by_outcome_id needs.
async fn sync_mc_resolutions(
    pool: &PgPool,
    client: &Client,
    stats: &mut ResolutionStats,
) -> Result<()> {
    let rows = sqlx::query(
        "SELECT e.id, s.source, s.external_id
         FROM events e
         JOIN event_external_sources s ON s.event_id = e.id
         WHERE e.outcome IS NULL
           AND e.closing_date <= NOW()
           AND e.event_type = 'multiple_choice'
           -- Verified live 2026-07-14 against several resolved multiple_choice
           -- posts (e.g. question 44366/post 44355, question 44009/post
           -- 43982): question.resolution is null at our token's access level,
           -- same restriction already documented above for metaculus binary
           -- questions. Skip polling metaculus here so it doesn't crowd real
           -- (manifold) resolutions out of the oldest-first batch. Re-enable
           -- if Metaculus exposes resolution to this token.
           AND s.source != 'metaculus'
         ORDER BY e.closing_date ASC
         LIMIT $1",
    )
    .bind(BATCH_LIMIT)
    .fetch_all(pool)
    .await?;

    println!(
        "🔎 MC resolution sync: checking {} past-close unresolved multiple_choice events",
        rows.len()
    );

    for row in rows {
        let event_id: i32 = row.get("id");
        let source: String = row.get("source");
        let external_id: String = row.get("external_id");
        stats.checked += 1;
        stats.mc_checked += 1;

        let verdict = match source.as_str() {
            "manifold" => manifold_mc_resolution(client, &external_id).await,
            "metaculus" => metaculus_mc_resolution(client, &external_id).await,
            _ => {
                stats.unsupported += 1;
                continue;
            }
        };

        match verdict {
            Ok(McVerdict::Resolved(label)) => {
                let outcomes = sqlx::query(
                    "SELECT id, label FROM event_outcomes WHERE event_id = $1 AND is_active = TRUE",
                )
                .bind(event_id)
                .fetch_all(pool)
                .await?
                .into_iter()
                .map(|r| (r.get::<i64, _>("id"), r.get::<String, _>("label")))
                .collect::<Vec<_>>();

                match match_outcome_label(&outcomes, &label) {
                    Some(outcome_id) => {
                        match crate::lmsr_api::resolve_event_by_outcome_id(
                            pool, event_id, outcome_id, None,
                        )
                        .await
                        {
                            Ok(()) => {
                                stats.resolved += 1;
                                stats.mc_resolved += 1;
                                println!(
                                    "✅ Resolved MC event {} ({}: {}) -> outcome {} ({:?})",
                                    event_id, source, external_id, outcome_id, label
                                );
                            }
                            Err(err) => {
                                stats.errors += 1;
                                println!("⚠️ MC settle failed for event {}: {}", event_id, err);
                            }
                        }
                    }
                    None => {
                        stats.mc_no_label_match += 1;
                        tracing::warn!(
                            event_id,
                            resolution_label = %label,
                            source = %source,
                            external_id = %external_id,
                            "MC resolution sync: no event_outcomes row matches provider's winning label"
                        );
                    }
                }
            }
            Ok(McVerdict::StillOpen) => stats.still_open += 1,
            Ok(McVerdict::Unsupported) => stats.unsupported += 1,
            Err(err) => {
                stats.errors += 1;
                println!(
                    "⚠️ MC resolution lookup failed ({}: {}): {}",
                    source, external_id, err
                );
            }
        }

        tokio::time::sleep(Duration::from_millis(REQUEST_DELAY_MS)).await;
    }

    Ok(())
}

// Numeric resolution pass. Same shape as the binary/MC loops above, but the
// provider verdict carries a winning *value* (f64) instead of a bool/label,
// which pick_winning_bin maps to the event_outcomes row whose bin contains
// it, then settles through the same lmsr_api::resolve_event_by_outcome_id
// the MC pass uses (it already does the numeric-safe distribution_trades
// unstake as of Task 6 — no need to duplicate that here).
async fn sync_numeric_resolutions(
    pool: &PgPool,
    client: &Client,
    stats: &mut ResolutionStats,
) -> Result<()> {
    let rows = sqlx::query(
        "SELECT e.id, s.source, s.external_id
         FROM events e
         JOIN event_external_sources s ON s.event_id = e.id
         WHERE e.outcome IS NULL
           AND e.closing_date <= NOW()
           AND e.event_type = 'numeric'
           -- Verified live 2026-07-14 (Task 7): sampled 19 resolved numeric
           -- posts from /api/posts/?statuses=resolved plus a direct detail
           -- fetch of one of them (post 44351 / question 44362) -
           -- question.resolution is null in every case at our token's
           -- access level, the same restriction already documented above
           -- for binary and multiple_choice questions. Skip polling
           -- metaculus here for the same reason: it would only crowd the
           -- oldest-first batch. Numeric markets are Metaculus-only today
           -- anyway (manifold's PSEUDO_NUMERIC rows never populate
           -- numeric_range_min/max on import - see market_import.rs's
           -- fetch_manifold_markets - so they never become
           -- event_type='numeric'), so this filter currently leaves the
           -- batch empty. Re-enable/extend if a source exposes numeric
           -- resolutions.
           AND s.source != 'metaculus'
         ORDER BY e.closing_date ASC
         LIMIT $1",
    )
    .bind(BATCH_LIMIT)
    .fetch_all(pool)
    .await?;

    println!(
        "🔎 Numeric resolution sync: checking {} past-close unresolved numeric events",
        rows.len()
    );

    for row in rows {
        let event_id: i32 = row.get("id");
        let source: String = row.get("source");
        let external_id: String = row.get("external_id");
        stats.checked += 1;
        stats.numeric_checked += 1;

        let verdict = match source.as_str() {
            "metaculus" => metaculus_numeric_resolution(client, &external_id).await,
            _ => {
                stats.unsupported += 1;
                continue;
            }
        };

        match verdict {
            Ok(NumericVerdict::Resolved(value)) => {
                let bins = sqlx::query(
                    "SELECT id, lower_bound, upper_bound FROM event_outcomes
                     WHERE event_id = $1 AND is_active = TRUE
                     ORDER BY sort_order ASC, id ASC",
                )
                .bind(event_id)
                .fetch_all(pool)
                .await?
                .into_iter()
                .map(|r| {
                    (
                        r.get::<i64, _>("id"),
                        r.get::<Option<f64>, _>("lower_bound"),
                        r.get::<Option<f64>, _>("upper_bound"),
                    )
                })
                .collect::<Vec<_>>();

                match pick_winning_bin(&bins, value) {
                    Some(outcome_id) => {
                        match crate::lmsr_api::resolve_event_by_outcome_id(
                            pool,
                            event_id,
                            outcome_id,
                            Some(value),
                        )
                        .await
                        {
                            Ok(()) => {
                                stats.resolved += 1;
                                stats.numeric_resolved += 1;
                                println!(
                                    "✅ Resolved numeric event {} ({}: {}) -> outcome {} (value {})",
                                    event_id, source, external_id, outcome_id, value
                                );
                            }
                            Err(err) => {
                                stats.errors += 1;
                                println!(
                                    "⚠️ Numeric settle failed for event {}: {}",
                                    event_id, err
                                );
                            }
                        }
                    }
                    None => {
                        stats.numeric_no_bin_match += 1;
                        tracing::warn!(
                            event_id,
                            resolution_value = value,
                            source = %source,
                            external_id = %external_id,
                            "Numeric resolution sync: no event_outcomes bin contains provider's resolved value"
                        );
                    }
                }
            }
            Ok(NumericVerdict::StillOpen) => stats.still_open += 1,
            Ok(NumericVerdict::Unsupported) => stats.unsupported += 1,
            Err(err) => {
                stats.errors += 1;
                println!(
                    "⚠️ Numeric resolution lookup failed ({}: {}): {}",
                    source, external_id, err
                );
            }
        }

        tokio::time::sleep(Duration::from_millis(REQUEST_DELAY_MS)).await;
    }

    Ok(())
}

/// Case-insensitive, whitespace-trimmed match of a provider's winning-option
/// label against our `event_outcomes` rows. Returns the matching outcome id
/// only when exactly one row's label matches after normalization; if zero or
/// more than one row match, returns None so an ambiguous label fails safe
/// (the caller's existing warn+skip path applies) instead of silently
/// settling against whichever row happened to come first.
fn match_outcome_label(outcomes: &[(i64, String)], resolution_label: &str) -> Option<i64> {
    let target = resolution_label.trim().to_lowercase();
    let mut matches = outcomes
        .iter()
        .filter(|(_, label)| label.trim().to_lowercase() == target)
        .map(|(id, _)| *id);

    let first = matches.next()?;
    if matches.next().is_some() {
        None
    } else {
        Some(first)
    }
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

enum McVerdict {
    // Winning option's label, verbatim from the provider.
    Resolved(String),
    StillOpen,
    // Resolved on the provider but not a single-winner label (Manifold
    // CANCEL/MKT, Metaculus annulled/ambiguous), or the winning answer
    // couldn't be matched back to a label at all.
    Unsupported,
}

async fn manifold_mc_resolution(client: &Client, external_id: &str) -> Result<McVerdict> {
    let url = format!("https://api.manifold.markets/v0/market/{}", external_id);
    let body: Value = client.get(&url).send().await?.error_for_status()?.json().await?;

    if !body["isResolved"].as_bool().unwrap_or(false) {
        return Ok(McVerdict::StillOpen);
    }
    // For MULTIPLE_CHOICE markets, `resolution` is the winning answer's id,
    // or "CANCEL" (voided) / "MKT" (weighted multi-winner - no single
    // label). Verified live 2026-07-14 against a resolved MC market.
    let resolution = match body["resolution"].as_str() {
        Some(r) if !r.is_empty() && r != "CANCEL" && r != "MKT" => r,
        _ => return Ok(McVerdict::Unsupported),
    };

    let label = body["answers"]
        .as_array()
        .and_then(|answers| {
            answers
                .iter()
                .find(|a| a["id"].as_str() == Some(resolution))
        })
        .and_then(|a| a["text"].as_str());

    match label {
        Some(text) => Ok(McVerdict::Resolved(text.to_string())),
        None => Ok(McVerdict::Unsupported),
    }
}

async fn metaculus_mc_resolution(client: &Client, external_id: &str) -> Result<McVerdict> {
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

    // Kept for parity with metaculus_resolution / forward compatibility, but
    // the SQL query above excludes metaculus from the MC batch: verified
    // live 2026-07-14 that question.resolution is null here too, at our
    // token's access level, for genuinely resolved multiple_choice posts.
    match body["question"]["resolution"].as_str() {
        None => Ok(McVerdict::StillOpen),
        Some("annulled") | Some("ambiguous") => Ok(McVerdict::Unsupported),
        Some(label) => Ok(McVerdict::Resolved(label.to_string())),
    }
}

enum NumericVerdict {
    // Provider's resolved value, verbatim (before bin-mapping).
    Resolved(f64),
    StillOpen,
    // Resolved on the provider but not a plain numeric value (Metaculus
    // annulled/ambiguous, or any other non-numeric resolution string).
    Unsupported,
}

async fn metaculus_numeric_resolution(client: &Client, external_id: &str) -> Result<NumericVerdict> {
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

    // Kept for parity/forward compatibility, but the SQL query above
    // excludes metaculus from the numeric batch: verified live 2026-07-14
    // (Task 7) that question.resolution is null here too, at our token's
    // access level, for genuinely resolved numeric posts (sampled 19,
    // cross-checked one via the detail endpoint).
    match body["question"]["resolution"].as_str() {
        None => Ok(NumericVerdict::StillOpen),
        Some("annulled") | Some("ambiguous") => Ok(NumericVerdict::Unsupported),
        Some(raw) => match raw.parse::<f64>() {
            Ok(value) if value.is_finite() => Ok(NumericVerdict::Resolved(value)),
            _ => Ok(NumericVerdict::Unsupported),
        },
    }
}

/// Winning bin for a resolved numeric market's value: the `event_outcomes`
/// row (already ordered by `sort_order ASC, id ASC`, matching
/// `lmsr_api::resolve_numeric_event`'s own bin lookup) whose
/// `[lower_bound, upper_bound)` contains `value` — except the *last* row in
/// that ordering, which is closed on the upper end too, so `value ==
/// range_max` resolves into the final bin instead of falling off the edge.
/// A bin with a missing bound is treated as unbounded on that side (numeric
/// bins always populate both in practice, but this mirrors
/// `resolve_numeric_event`'s own defensive `.unwrap_or(true)`). Out-of-range
/// or non-finite values, an empty bin list, and ambiguous matches
/// (overlapping bins - shouldn't exist for well-formed data) all fail safe
/// to `None`, the same "warn + skip" contract `match_outcome_label` uses for
/// MC.
fn pick_winning_bin(bins: &[(i64, Option<f64>, Option<f64>)], value: f64) -> Option<i64> {
    if !value.is_finite() || bins.is_empty() {
        return None;
    }
    let last_idx = bins.len() - 1;

    let mut matches = bins.iter().enumerate().filter_map(|(idx, (id, lower, upper))| {
        let lower_ok = lower.map(|v| value >= v).unwrap_or(true);
        let upper_ok = upper
            .map(|v| if idx == last_idx { value <= v } else { value < v })
            .unwrap_or(true);
        (lower_ok && upper_ok).then_some(*id)
    });

    let first = matches.next()?;
    if matches.next().is_some() {
        None
    } else {
        Some(first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcomes() -> Vec<(i64, String)> {
        vec![
            (1, "Yes".to_string()),
            (2, "No".to_string()),
            (3, "  Too close to call ".to_string()),
        ]
    }

    #[test]
    fn match_outcome_label_exact() {
        assert_eq!(match_outcome_label(&outcomes(), "Yes"), Some(1));
        assert_eq!(match_outcome_label(&outcomes(), "No"), Some(2));
    }

    #[test]
    fn match_outcome_label_case_insensitive() {
        assert_eq!(match_outcome_label(&outcomes(), "yes"), Some(1));
        assert_eq!(match_outcome_label(&outcomes(), "YES"), Some(1));
        assert_eq!(match_outcome_label(&outcomes(), "nO"), Some(2));
    }

    #[test]
    fn match_outcome_label_trims_whitespace_on_both_sides() {
        // Our stored label already has stray whitespace (e.g. seeded from a
        // sloppy source string); the incoming provider label may too.
        assert_eq!(
            match_outcome_label(&outcomes(), " too close to call  "),
            Some(3)
        );
        assert_eq!(match_outcome_label(&outcomes(), "  Yes"), Some(1));
    }

    #[test]
    fn match_outcome_label_no_match_returns_none() {
        assert_eq!(match_outcome_label(&outcomes(), "Maybe"), None);
        assert_eq!(match_outcome_label(&[], "Yes"), None);
    }

    #[test]
    fn match_outcome_label_ambiguous_returns_none() {
        // Two active outcomes normalize (trim+lowercase) to the same label.
        // Settling against "whichever comes first" would silently pick an
        // arbitrary winner, so this must fail safe like an unmatched label.
        let ambiguous = vec![
            (10, "Team A".to_string()),
            (11, "team a".to_string()),
            (12, "No".to_string()),
        ];
        assert_eq!(match_outcome_label(&ambiguous, "Team A"), None);
        assert_eq!(match_outcome_label(&ambiguous, "no"), Some(12));
    }

    // Three contiguous, non-overlapping bins: [0,10), [10,20), [20,30] -
    // the last one closed on both ends, matching linear_bins'/
    // seed_numeric_bins_if_missing's real shape.
    fn bins() -> Vec<(i64, Option<f64>, Option<f64>)> {
        vec![
            (1, Some(0.0), Some(10.0)),
            (2, Some(10.0), Some(20.0)),
            (3, Some(20.0), Some(30.0)),
        ]
    }

    #[test]
    fn pick_winning_bin_range_min_goes_to_first_bin() {
        assert_eq!(pick_winning_bin(&bins(), 0.0), Some(1));
    }

    #[test]
    fn pick_winning_bin_interior_value_goes_to_its_bin() {
        assert_eq!(pick_winning_bin(&bins(), 5.0), Some(1));
        assert_eq!(pick_winning_bin(&bins(), 15.0), Some(2));
        assert_eq!(pick_winning_bin(&bins(), 25.0), Some(3));
    }

    #[test]
    fn pick_winning_bin_exact_boundary_goes_to_the_higher_bin() {
        // lower_bound <= v < upper_bound: a value exactly on the shared edge
        // between two bins belongs to the bin whose *lower* bound equals it,
        // not the one whose upper bound equals it.
        assert_eq!(pick_winning_bin(&bins(), 10.0), Some(2));
        assert_ne!(pick_winning_bin(&bins(), 10.0), Some(1));
        assert_eq!(pick_winning_bin(&bins(), 20.0), Some(3));
        assert_ne!(pick_winning_bin(&bins(), 20.0), Some(2));
    }

    #[test]
    fn pick_winning_bin_range_max_is_inclusive_on_the_final_bin() {
        // Only the last bin is closed on its upper end - v == range_max
        // resolves instead of falling off the edge.
        assert_eq!(pick_winning_bin(&bins(), 30.0), Some(3));
    }

    #[test]
    fn pick_winning_bin_out_of_range_returns_none() {
        assert_eq!(pick_winning_bin(&bins(), -0.001), None);
        assert_eq!(pick_winning_bin(&bins(), 30.001), None);
    }

    #[test]
    fn pick_winning_bin_unparseable_or_non_finite_returns_none() {
        assert_eq!(pick_winning_bin(&bins(), f64::NAN), None);
        assert_eq!(pick_winning_bin(&bins(), f64::INFINITY), None);
        assert_eq!(pick_winning_bin(&bins(), f64::NEG_INFINITY), None);
    }

    #[test]
    fn pick_winning_bin_empty_bins_returns_none() {
        assert_eq!(pick_winning_bin(&[], 5.0), None);
    }

    #[test]
    fn pick_winning_bin_ambiguous_overlapping_bins_returns_none() {
        // Two active bins both claim value 5.0 - shouldn't happen for
        // well-formed data, but must fail safe (None) rather than silently
        // picking whichever row came first.
        let overlapping = vec![
            (1, Some(0.0), Some(10.0)),
            (2, Some(3.0), Some(8.0)),
        ];
        assert_eq!(pick_winning_bin(&overlapping, 5.0), None);
        // Outside the overlap, still resolves normally.
        assert_eq!(pick_winning_bin(&overlapping, 9.0), Some(1));
    }
}
