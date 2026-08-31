// Resolution sync: providers are only polled with status=open during import,
// so resolved outcomes never arrive on their own. This module walks our
// unresolved, provider-mapped binary events, asks each provider for the
// market's current resolution by external id, and settles matches through
// lmsr_api::resolve_event (transactional payout path).
//
// Candidate scope: past-close events for every source, PLUS all open
// manifold/polymarket events regardless of closing_date — those providers
// settle early (creator/UMA resolves when reality decides, often years
// before the listed close; e.g. "what day will X release?" markets close
// 2027 but resolved 2026). Batches rotate via events.resolution_checked_at
// (least-recently-checked first) so the per-run LIMIT still covers every
// candidate over successive nightly runs.
//
// Dead ends: a market the provider has resolved in a way we can never settle
// (multi-winner/percent resolutions, cancellations, winning labels that don't
// match our event_outcomes) is hidden (events.hidden_at/hidden_reason) so it
// stops being listed, traded, and weekly-assigned. Positions in hidden events
// stay visible in My Positions; a refund path for voided markets is still TODO.
//
// v1 scope: binary events on manifold / metaculus / polymarket, plus
// multiple_choice events on manifold / metaculus (label-matched against
// event_outcomes, settled through lmsr_api::resolve_event_by_outcome_id).
// numeric events (Task 7): resolved value mapped to its winning bin
// (lower_bound <= v < upper_bound, final inbound bin inclusive on upper;
// out-of-range routes to a tail outcome when one is configured, Task 4) via
// numeric_transform::pick_winning_outcome, settled through the same
// resolve_event_by_outcome_id.
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
    pub dead_ends_hidden: u32,
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
            "dead_ends_hidden": self.dead_ends_hidden,
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
           AND e.hidden_at IS NULL
           -- Manifold/polymarket settle early, so they're polled regardless
           -- of closing_date; other sources keep the past-close gate.
           AND (e.closing_date <= NOW() OR s.source IN ('manifold', 'polymarket'))
           AND e.event_type = 'binary'
           -- Metaculus's API returns resolution: null for every question at
           -- our token's access level (verified 2026-07-07, even on their own
           -- resolved-list endpoint), so lookups are pure waste and would
           -- clog the batch forever. Re-enable if they expose it.
           AND s.source != 'metaculus'
         ORDER BY e.resolution_checked_at ASC NULLS FIRST, e.closing_date ASC
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
        "🔎 Resolution sync: checking {} unresolved binary events",
        rows.len()
    );

    for row in rows {
        let event_id: i32 = row.get("id");
        let source: String = row.get("source");
        let external_id: String = row.get("external_id");
        stats.checked += 1;

        // Mark checked up front (errors included) so a market whose lookup
        // keeps failing can't pin the least-recently-checked queue head.
        mark_resolution_checked(pool, event_id).await;

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
            Ok(Verdict::DeadEnd(reason)) => {
                hide_dead_end(pool, event_id, &source, &external_id, reason, &mut stats).await;
            }
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
        "🔎 Resolution sync done: {} checked, {} resolved, {} still open, {} unsupported, {} dead-ends hidden, {} errors ({} MC checked, {} MC resolved, {} MC no-label-match; {} numeric checked, {} numeric resolved, {} numeric no-bin-match)",
        stats.checked, stats.resolved, stats.still_open, stats.unsupported, stats.dead_ends_hidden, stats.errors,
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
           AND e.hidden_at IS NULL
           -- Manifold settles early, so it's polled regardless of
           -- closing_date; other sources keep the past-close gate.
           AND (e.closing_date <= NOW() OR s.source = 'manifold')
           AND e.event_type = 'multiple_choice'
           -- Verified live 2026-07-14 against several resolved multiple_choice
           -- posts (e.g. question 44366/post 44355, question 44009/post
           -- 43982): question.resolution is null at our token's access level,
           -- same restriction already documented above for metaculus binary
           -- questions. Skip polling metaculus here so it doesn't crowd real
           -- (manifold) resolutions out of the batch. Re-enable if Metaculus
           -- exposes resolution to this token.
           AND s.source != 'metaculus'
         ORDER BY e.resolution_checked_at ASC NULLS FIRST, e.closing_date ASC
         LIMIT $1",
    )
    .bind(BATCH_LIMIT)
    .fetch_all(pool)
    .await?;

    println!(
        "🔎 MC resolution sync: checking {} unresolved multiple_choice events",
        rows.len()
    );

    for row in rows {
        let event_id: i32 = row.get("id");
        let source: String = row.get("source");
        let external_id: String = row.get("external_id");
        stats.checked += 1;
        stats.mc_checked += 1;

        // Same up-front marking as the binary loop: failures count as checks.
        mark_resolution_checked(pool, event_id).await;

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
                        // Decided at the provider but unsettleable here — a
                        // dead end nobody can ever win. Hide it.
                        hide_dead_end(
                            pool,
                            event_id,
                            &source,
                            &external_id,
                            "provider resolved, winning label has no local outcome match",
                            &mut *stats,
                        )
                        .await;
                    }
                }
            }
            Ok(McVerdict::StillOpen) => stats.still_open += 1,
            Ok(McVerdict::Unsupported) => stats.unsupported += 1,
            Ok(McVerdict::DeadEnd(reason)) => {
                hide_dead_end(pool, event_id, &source, &external_id, reason, &mut *stats).await;
            }
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
// which numeric_transform::pick_winning_outcome maps to the event_outcomes
// row whose bin (or tail) contains it, then settles through the same
// lmsr_api::resolve_event_by_outcome_id the MC pass uses (it already does
// the numeric-safe distribution_trades unstake as of Task 6 — no need to
// duplicate that here).
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
                    "SELECT id, lower_bound, upper_bound, bucket_kind FROM event_outcomes
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
                        crate::numeric_transform::BucketKind::parse(&r.get::<String, _>("bucket_kind")),
                        r.get::<Option<f64>, _>("lower_bound"),
                        r.get::<Option<f64>, _>("upper_bound"),
                    )
                })
                .collect::<Vec<_>>();

                match crate::numeric_transform::pick_winning_outcome(&bins, value) {
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

#[derive(Debug, PartialEq)]
enum Verdict {
    Resolved(bool),
    StillOpen,
    // Not resolvable right now for reasons that may be transient or fixable
    // (odd provider payloads).
    Unsupported,
    // Resolved on the provider in a way that can never settle here
    // (MKT/percent resolutions, cancelled/annulled markets). The market is a
    // dead end nobody can win, so it gets hidden; payload is hidden_reason.
    DeadEnd(&'static str),
}

/// Fairness cursor: least-recently-checked candidates go first, so the batch
/// LIMIT rotates through the whole backlog over successive runs. Best-effort —
/// a failed update just means this event may be re-checked sooner.
async fn mark_resolution_checked(pool: &PgPool, event_id: i32) {
    if let Err(err) =
        sqlx::query("UPDATE events SET resolution_checked_at = NOW() WHERE id = $1")
            .bind(event_id)
            .execute(pool)
            .await
    {
        tracing::warn!(event_id, %err, "failed to stamp resolution_checked_at");
    }
}

async fn hide_dead_end(
    pool: &PgPool,
    event_id: i32,
    source: &str,
    external_id: &str,
    reason: &str,
    stats: &mut ResolutionStats,
) {
    match sqlx::query(
        "UPDATE events SET hidden_at = NOW(), hidden_reason = $2 WHERE id = $1 AND hidden_at IS NULL",
    )
    .bind(event_id)
    .bind(format!("resolution-sync dead end: {}", reason))
    .execute(pool)
    .await
    {
        Ok(_) => {
            stats.dead_ends_hidden += 1;
            println!(
                "🪦 Hid dead-end event {} ({}: {}): {}",
                event_id, source, external_id, reason
            );
        }
        Err(err) => {
            stats.errors += 1;
            println!("⚠️ Failed to hide dead-end event {}: {}", event_id, err);
        }
    }
}

async fn manifold_resolution(client: &Client, external_id: &str) -> Result<Verdict> {
    let url = format!("https://api.manifold.markets/v0/market/{}", external_id);
    let body: Value = client.get(&url).send().await?.error_for_status()?.json().await?;
    Ok(classify_manifold_binary(&body))
}

fn classify_manifold_binary(body: &Value) -> Verdict {
    if !body["isResolved"].as_bool().unwrap_or(false) {
        return Verdict::StillOpen;
    }
    match body["resolution"].as_str() {
        Some("YES") => Verdict::Resolved(true),
        Some("NO") => Verdict::Resolved(false),
        Some("CANCEL") => Verdict::DeadEnd("manifold market cancelled"),
        Some("MKT") => Verdict::DeadEnd("manifold resolved to a probability (MKT)"),
        // isResolved with a missing/unknown resolution string: odd payload,
        // don't hide on it.
        _ => Verdict::Unsupported,
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
        "annulled" | "ambiguous" => Ok(Verdict::DeadEnd("metaculus annulled/ambiguous")),
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

#[derive(Debug, PartialEq)]
enum McVerdict {
    // Winning option's label, verbatim from the provider.
    Resolved(String),
    StillOpen,
    // Odd payload; may be transient, don't hide on it.
    Unsupported,
    // Resolved on the provider without a single winning label we could ever
    // settle against (Manifold CANCEL/MKT/CHOOSE_MULTIPLE, Metaculus
    // annulled/ambiguous). Hidden as a dead end; payload is hidden_reason.
    DeadEnd(&'static str),
}

async fn manifold_mc_resolution(client: &Client, external_id: &str) -> Result<McVerdict> {
    let url = format!("https://api.manifold.markets/v0/market/{}", external_id);
    let body: Value = client.get(&url).send().await?.error_for_status()?.json().await?;
    Ok(classify_manifold_mc(&body))
}

fn classify_manifold_mc(body: &Value) -> McVerdict {
    if !body["isResolved"].as_bool().unwrap_or(false) {
        return McVerdict::StillOpen;
    }
    // For MULTIPLE_CHOICE markets, `resolution` is the winning answer's id,
    // or "CANCEL" (voided) / "MKT" / "CHOOSE_MULTIPLE" (weighted or
    // multi-winner - no single label). Verified live 2026-07-14 against a
    // resolved MC market; CHOOSE_MULTIPLE verified live 2026-08-31.
    let resolution = match body["resolution"].as_str() {
        Some("CANCEL") => return McVerdict::DeadEnd("manifold market cancelled"),
        Some("MKT") => return McVerdict::DeadEnd("manifold resolved to weighted answers (MKT)"),
        Some("CHOOSE_MULTIPLE") => {
            return McVerdict::DeadEnd("manifold resolved to multiple answers (CHOOSE_MULTIPLE)")
        }
        Some(r) if !r.is_empty() => r,
        _ => return McVerdict::Unsupported,
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
        Some(text) => McVerdict::Resolved(text.to_string()),
        // Resolution names an answer id we can't find in the payload — odd
        // payload rather than a provable dead end.
        None => McVerdict::Unsupported,
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
        Some("annulled") | Some("ambiguous") => {
            Ok(McVerdict::DeadEnd("metaculus annulled/ambiguous"))
        }
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

    // pick_winning_bin's unit tests moved to numeric_transform::tests as
    // pick_winning_outcome (ported to the shared (id, BucketKind, lower,
    // upper) signature) when this function was replaced by a direct call to
    // the shared picker.

    #[test]
    fn manifold_binary_open_and_resolved() {
        assert_eq!(
            classify_manifold_binary(&json!({"isResolved": false})),
            Verdict::StillOpen
        );
        assert_eq!(
            classify_manifold_binary(&json!({"isResolved": true, "resolution": "YES"})),
            Verdict::Resolved(true)
        );
        assert_eq!(
            classify_manifold_binary(&json!({"isResolved": true, "resolution": "NO"})),
            Verdict::Resolved(false)
        );
    }

    #[test]
    fn manifold_binary_dead_ends_and_odd_payloads() {
        assert!(matches!(
            classify_manifold_binary(&json!({"isResolved": true, "resolution": "CANCEL"})),
            Verdict::DeadEnd(_)
        ));
        assert!(matches!(
            classify_manifold_binary(&json!({"isResolved": true, "resolution": "MKT"})),
            Verdict::DeadEnd(_)
        ));
        // Resolved with a missing/unknown resolution string must NOT hide.
        assert_eq!(
            classify_manifold_binary(&json!({"isResolved": true})),
            Verdict::Unsupported
        );
    }

    #[test]
    fn manifold_mc_single_winner_resolves_to_label() {
        let body = json!({
            "isResolved": true,
            "resolution": "abc123",
            "answers": [
                {"id": "xyz", "text": "Before June"},
                {"id": "abc123", "text": "June 17"},
            ]
        });
        assert_eq!(
            classify_manifold_mc(&body),
            McVerdict::Resolved("June 17".to_string())
        );
    }

    #[test]
    fn manifold_mc_multi_winner_is_dead_end() {
        // Regression: "What day will GPT 5.6 come out?" (zAClyQAdpt) resolved
        // CHOOSE_MULTIPLE on Manifold and sat open here for months.
        let body = json!({"isResolved": true, "resolution": "CHOOSE_MULTIPLE"});
        assert!(matches!(classify_manifold_mc(&body), McVerdict::DeadEnd(_)));
        assert!(matches!(
            classify_manifold_mc(&json!({"isResolved": true, "resolution": "CANCEL"})),
            McVerdict::DeadEnd(_)
        ));
        assert!(matches!(
            classify_manifold_mc(&json!({"isResolved": true, "resolution": "MKT"})),
            McVerdict::DeadEnd(_)
        ));
    }

    #[test]
    fn manifold_mc_open_and_odd_payloads() {
        assert_eq!(
            classify_manifold_mc(&json!({"isResolved": false})),
            McVerdict::StillOpen
        );
        // Winning answer id missing from the answers array: odd payload,
        // must NOT hide.
        let body = json!({
            "isResolved": true,
            "resolution": "ghost-id",
            "answers": [{"id": "xyz", "text": "Before June"}]
        });
        assert_eq!(classify_manifold_mc(&body), McVerdict::Unsupported);
    }
}
