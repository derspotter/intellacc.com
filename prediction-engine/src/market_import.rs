use anyhow::{anyhow, Result};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::env;

#[derive(Debug, Clone)]
pub struct ImportedMarket {
    pub source: String,
    pub external_id: String,
    pub external_url: String,
    pub title: String,
    pub description: String,
    pub close_time: Option<DateTime<Utc>>,
    pub category: String,
    pub event_type: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportRunStats {
    pub provider: String,
    pub fetched_count: i32,
    pub excluded_count: i32,
    pub merged_count: i32,
    pub created_count: i32,
    pub linked_count: i32,
    pub error_count: i32,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum ImportProvider {
    Metaculus,
    Manifold,
    Polymarket,
    Kalshi,
}

impl ImportProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            ImportProvider::Metaculus => "metaculus",
            ImportProvider::Manifold => "manifold",
            ImportProvider::Polymarket => "polymarket",
            ImportProvider::Kalshi => "kalshi",
        }
    }

    pub fn all() -> Vec<ImportProvider> {
        vec![
            ImportProvider::Metaculus,
            ImportProvider::Manifold,
            ImportProvider::Polymarket,
            ImportProvider::Kalshi,
        ]
    }
}

impl TryFrom<&str> for ImportProvider {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> Result<Self> {
        match value.trim().to_lowercase().as_str() {
            "metaculus" => Ok(ImportProvider::Metaculus),
            "manifold" => Ok(ImportProvider::Manifold),
            "polymarket" => Ok(ImportProvider::Polymarket),
            "kalshi" => Ok(ImportProvider::Kalshi),
            other => Err(anyhow!("unsupported provider: {}", other)),
        }
    }
}

pub trait MarketImportProvider {
    fn source_name(&self) -> &'static str;
}

pub async fn sync_all_markets(pool: &PgPool) -> Result<Vec<ImportRunStats>> {
    ensure_import_tables(pool).await?;
    let mut results = Vec::new();
    for provider in ImportProvider::all() {
        match sync_provider(pool, provider).await {
            Ok(stats) => results.push(stats),
            Err(err) => {
                results.push(ImportRunStats {
                    provider: provider.as_str().to_string(),
                    fetched_count: 0,
                    excluded_count: 0,
                    merged_count: 0,
                    created_count: 0,
                    linked_count: 0,
                    error_count: 1,
                    errors: vec![err.to_string()],
                });
            }
        }
    }
    Ok(results)
}

pub async fn sync_provider_named(pool: &PgPool, provider: &str) -> Result<ImportRunStats> {
    ensure_import_tables(pool).await?;
    sync_provider(pool, ImportProvider::try_from(provider)?).await
}

pub async fn get_recent_import_runs(pool: &PgPool, limit: i64) -> Result<Vec<Value>> {
    ensure_import_tables(pool).await?;
    let limit = limit.clamp(1, 200);
    let rows = sqlx::query(
        r#"
        SELECT id, provider, started_at, finished_at, success,
               fetched_count, excluded_count, merged_count, created_count, linked_count,
               error_count, errors
        FROM external_import_runs
        ORDER BY started_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        result.push(json!({
            "id": row.get::<i64, _>("id"),
            "provider": row.get::<String, _>("provider"),
            "started_at": row.get::<DateTime<Utc>, _>("started_at"),
            "finished_at": row.get::<Option<DateTime<Utc>>, _>("finished_at"),
            "success": row.get::<bool, _>("success"),
            "fetched_count": row.get::<i32, _>("fetched_count"),
            "excluded_count": row.get::<i32, _>("excluded_count"),
            "merged_count": row.get::<i32, _>("merged_count"),
            "created_count": row.get::<i32, _>("created_count"),
            "linked_count": row.get::<i32, _>("linked_count"),
            "error_count": row.get::<i32, _>("error_count"),
            "errors": row.get::<Value, _>("errors"),
        }));
    }
    Ok(result)
}

async fn sync_provider(pool: &PgPool, provider: ImportProvider) -> Result<ImportRunStats> {
    let started_at = Utc::now();
    let mut stats = ImportRunStats {
        provider: provider.as_str().to_string(),
        fetched_count: 0,
        excluded_count: 0,
        merged_count: 0,
        created_count: 0,
        linked_count: 0,
        error_count: 0,
        errors: Vec::new(),
    };

    let markets = match provider {
        ImportProvider::Metaculus => {
            crate::metaculus::fetch_open_markets(Some(provider_limit(provider))).await
        }
        ImportProvider::Manifold => fetch_manifold_markets(provider_limit(provider)).await,
        ImportProvider::Polymarket => fetch_polymarket_markets(provider_limit(provider)).await,
        ImportProvider::Kalshi => fetch_kalshi_markets(provider_limit(provider)).await,
    };

    let markets = match markets {
        Ok(items) => items,
        Err(err) => {
            stats.error_count += 1;
            stats.errors.push(err.to_string());
            write_import_run(pool, &stats, started_at, false).await?;
            return Ok(stats);
        }
    };

    stats.fetched_count = markets.len() as i32;
    let has_pgvector = has_pgvector_extension(pool).await.unwrap_or(false);
    let topic_id = ensure_external_import_topic(pool).await?;

    for market in markets {
        if let Some(reason) = exclusion_reason(&market) {
            stats.excluded_count += 1;
            println!(
                "⏭️ [{}] Excluded {} [{}]: {}",
                stats.provider, reason, market.external_id, market.title
            );
            continue;
        }

        match upsert_market(pool, topic_id, &market, has_pgvector).await {
            Ok(PersistOutcome::LinkedExisting) => {
                stats.linked_count += 1;
            }
            Ok(PersistOutcome::Merged) => {
                stats.merged_count += 1;
            }
            Ok(PersistOutcome::Created) => {
                stats.created_count += 1;
            }
            Err(err) => {
                stats.error_count += 1;
                if stats.errors.len() < 25 {
                    stats.errors.push(err.to_string());
                }
            }
        }
    }

    let success = stats.error_count == 0;
    write_import_run(pool, &stats, started_at, success).await?;
    Ok(stats)
}

async fn ensure_import_tables(pool: &PgPool) -> Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS event_external_sources (
            id BIGSERIAL PRIMARY KEY,
            event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            source VARCHAR(32) NOT NULL,
            external_id TEXT NOT NULL,
            external_url TEXT,
            raw_payload JSONB,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (source, external_id)
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS external_import_runs (
            id BIGSERIAL PRIMARY KEY,
            provider VARCHAR(32) NOT NULL,
            started_at TIMESTAMPTZ NOT NULL,
            finished_at TIMESTAMPTZ,
            success BOOLEAN NOT NULL DEFAULT FALSE,
            fetched_count INTEGER NOT NULL DEFAULT 0,
            excluded_count INTEGER NOT NULL DEFAULT 0,
            merged_count INTEGER NOT NULL DEFAULT 0,
            created_count INTEGER NOT NULL DEFAULT 0,
            linked_count INTEGER NOT NULL DEFAULT 0,
            error_count INTEGER NOT NULL DEFAULT 0,
            errors JSONB NOT NULL DEFAULT '[]'::jsonb
        );
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

async fn write_import_run(
    pool: &PgPool,
    stats: &ImportRunStats,
    started_at: DateTime<Utc>,
    success: bool,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO external_import_runs (
            provider, started_at, finished_at, success,
            fetched_count, excluded_count, merged_count, created_count, linked_count,
            error_count, errors
        ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        "#,
    )
    .bind(&stats.provider)
    .bind(started_at)
    .bind(success)
    .bind(stats.fetched_count)
    .bind(stats.excluded_count)
    .bind(stats.merged_count)
    .bind(stats.created_count)
    .bind(stats.linked_count)
    .bind(stats.error_count)
    .bind(serde_json::to_string(&stats.errors)?)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum PersistOutcome {
    LinkedExisting,
    Merged,
    Created,
}

#[derive(Debug, Clone)]
struct Candidate {
    event_id: i32,
    event_type: String,
    close_time: DateTime<Utc>,
    embed_sim: f64,
    text_sim: f64,
}

async fn upsert_market(
    pool: &PgPool,
    topic_id: i32,
    market: &ImportedMarket,
    has_pgvector: bool,
) -> Result<PersistOutcome> {
    // Fast idempotent path by exact provider ID.
    if let Some(existing_event_id) =
        find_event_by_source_id(pool, &market.source, &market.external_id).await?
    {
        upsert_source_mapping(pool, existing_event_id, market).await?;
        return Ok(PersistOutcome::LinkedExisting);
    }

    let normalized_text = normalized_market_text(market);
    let event_type = normalize_event_type(&market.event_type);

    let mut maybe_embedding: Option<Vec<f64>> = None;
    if has_pgvector {
        if let Ok(embedding) = embed_text(&normalized_text).await {
            maybe_embedding = Some(embedding);
        }
    }

    let mut candidates = collect_candidates(
        pool,
        market,
        &normalized_text,
        maybe_embedding.as_deref(),
        has_pgvector,
    )
    .await?;
    candidates.sort_by(|a, b| {
        let sa = dedup_score(market, a);
        let sb = dedup_score(market, b);
        sb.partial_cmp(&sa).unwrap_or(Ordering::Equal)
    });

    if let Some(best) = candidates.first() {
        let score = dedup_score(market, best);
        if score >= dedup_threshold() && is_merge_semantically_compatible(market, best) {
            upsert_source_mapping(pool, best.event_id, market).await?;
            return Ok(PersistOutcome::Merged);
        }
    }

    let fallback_close = Utc::now() + Duration::days(90);
    let close_time = market.close_time.unwrap_or(fallback_close).naive_utc();
    let category = truncate(&market.category, 100);
    let title = truncate(&market.title, 255);
    let details = market_details_blob(market);
    let domain = normalize_domain(&market.category);

    let inserted_event_id = insert_event(
        pool,
        topic_id,
        &title,
        &details,
        close_time,
        &category,
        &event_type,
        &domain,
    )
    .await?;

    upsert_source_mapping(pool, inserted_event_id, market).await?;

    if has_pgvector {
        if maybe_embedding.is_none() {
            if let Ok(embedding) = embed_text(&normalized_text).await {
                maybe_embedding = Some(embedding);
            }
        }
        if let Some(embedding) = maybe_embedding {
            let vector_literal = embedding_to_vector_literal(&embedding);
            let _ = sqlx::query("UPDATE events SET embedding = $1 WHERE id = $2")
                .bind(vector_literal)
                .bind(inserted_event_id)
                .execute(pool)
                .await;
        }
    }

    Ok(PersistOutcome::Created)
}

async fn collect_candidates(
    pool: &PgPool,
    market: &ImportedMarket,
    normalized_text: &str,
    incoming_embedding: Option<&[f64]>,
    has_pgvector: bool,
) -> Result<Vec<Candidate>> {
    let mut map: HashMap<i32, Candidate> = HashMap::new();
    let search_query = build_text_search_query(normalized_text);

    if !search_query.is_empty() {
        let rows = sqlx::query(
            r#"
            SELECT id, title, COALESCE(details, '') AS details, event_type, closing_date,
                   ts_rank(search_vector, websearch_to_tsquery('english', $1)) AS text_rank
            FROM events
            WHERE search_vector @@ websearch_to_tsquery('english', $1)
            ORDER BY text_rank DESC
            LIMIT 50
            "#,
        )
        .bind(&search_query)
        .fetch_all(pool)
        .await?;

        for row in rows {
            let event_id: i32 = row.get("id");
            let close_naive: NaiveDateTime = row.get("closing_date");
            let close_time = DateTime::<Utc>::from_naive_utc_and_offset(close_naive, Utc);
            let title: String = row.get("title");
            let details: String = row.get("details");
            let text_rank: f32 = row.get::<f32, _>("text_rank");

            let text_sim =
                text_similarity(normalized_text, &normalized_text_blob(&title, &details))
                    .max(((text_rank as f64) / 0.3).clamp(0.0, 1.0));
            map.insert(
                event_id,
                Candidate {
                    event_id,
                    event_type: row.get::<String, _>("event_type"),
                    close_time,
                    embed_sim: 0.0,
                    text_sim,
                },
            );
        }
    }

    if has_pgvector {
        if let Some(embedding) = incoming_embedding {
            let vector_literal = embedding_to_vector_literal(embedding);
            let rows = sqlx::query(
                r#"
                SELECT id, title, COALESCE(details, '') AS details, event_type, closing_date,
                       (1 - (embedding <=> $1::vector)) AS embed_sim
                FROM events
                WHERE embedding IS NOT NULL
                ORDER BY embedding <=> $1::vector
                LIMIT 50
                "#,
            )
            .bind(vector_literal)
            .fetch_all(pool)
            .await?;

            for row in rows {
                let event_id: i32 = row.get("id");
                let close_naive: NaiveDateTime = row.get("closing_date");
                let close_time = DateTime::<Utc>::from_naive_utc_and_offset(close_naive, Utc);
                let entry = map.entry(event_id).or_insert_with(|| Candidate {
                    event_id,
                    event_type: row.get("event_type"),
                    close_time,
                    embed_sim: 0.0,
                    text_sim: 0.0,
                });
                let embed_sim: f64 = row.get("embed_sim");
                entry.embed_sim = embed_sim.clamp(0.0, 1.0);
            }
        }
    }

    // Remove impossible candidates before scoring.
    let mut candidates = Vec::new();
    for candidate in map.into_values() {
        if !is_merge_semantically_compatible(market, &candidate) {
            continue;
        }
        candidates.push(candidate);
    }
    Ok(candidates)
}

fn dedup_score(market: &ImportedMarket, candidate: &Candidate) -> f64 {
    let close_diff_days = market
        .close_time
        .map(|t| (candidate.close_time - t).num_seconds().unsigned_abs() as f64 / 86_400.0)
        .unwrap_or(999.0);
    let time_score = if close_diff_days <= close_window_days() as f64 {
        (1.0 - close_diff_days / close_window_days() as f64).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (0.55 * candidate.embed_sim) + (0.35 * candidate.text_sim) + (0.10 * time_score)
}

fn is_merge_semantically_compatible(market: &ImportedMarket, candidate: &Candidate) -> bool {
    let Some(import_close_time) = market.close_time else {
        return false;
    };
    let diff_days = (candidate.close_time - import_close_time)
        .num_seconds()
        .unsigned_abs() as f64
        / 86_400.0;
    if diff_days > close_window_days() as f64 {
        return false;
    }

    let import_type = normalize_event_type(&market.event_type);
    let existing_type = normalize_event_type(&candidate.event_type);
    import_type == existing_type
}

async fn find_event_by_source_id(
    pool: &PgPool,
    source: &str,
    external_id: &str,
) -> Result<Option<i32>> {
    let row = sqlx::query(
        r#"
        SELECT event_id
        FROM event_external_sources
        WHERE source = $1 AND external_id = $2
        LIMIT 1
        "#,
    )
    .bind(source)
    .bind(external_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| r.get("event_id")))
}

async fn upsert_source_mapping(
    pool: &PgPool,
    event_id: i32,
    market: &ImportedMarket,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO event_external_sources (event_id, source, external_id, external_url, raw_payload, last_seen_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
        ON CONFLICT (source, external_id)
        DO UPDATE SET
            event_id = EXCLUDED.event_id,
            external_url = EXCLUDED.external_url,
            raw_payload = EXCLUDED.raw_payload,
            last_seen_at = NOW()
        "#,
    )
    .bind(event_id)
    .bind(&market.source)
    .bind(&market.external_id)
    .bind(&market.external_url)
    .bind(json!({
        "title": market.title,
        "description": market.description,
        "close_time": market.close_time,
        "category": market.category,
        "event_type": market.event_type,
        "status": market.status,
    }).to_string())
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_external_import_topic(pool: &PgPool) -> Result<i32> {
    let existing = sqlx::query("SELECT id FROM topics WHERE name = 'External Market Imports'")
        .fetch_optional(pool)
        .await?;
    if let Some(row) = existing {
        return Ok(row.get("id"));
    }

    let created =
        sqlx::query("INSERT INTO topics (name, description) VALUES ($1, $2) RETURNING id")
            .bind("External Market Imports")
            .bind("Markets imported from external prediction providers")
            .fetch_one(pool)
            .await?;
    Ok(created.get("id"))
}

async fn insert_event(
    pool: &PgPool,
    topic_id: i32,
    title: &str,
    details: &str,
    close_time: NaiveDateTime,
    category: &str,
    event_type: &str,
    domain: &str,
) -> Result<i32> {
    let result = sqlx::query(
        r#"
        INSERT INTO events (topic_id, title, details, closing_date, outcome, category, event_type, domain)
        VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(topic_id)
    .bind(title)
    .bind(details)
    .bind(close_time)
    .bind(category)
    .bind(event_type)
    .bind(domain)
    .fetch_one(pool)
    .await;

    match result {
        Ok(row) => Ok(row.get("id")),
        Err(_) => {
            let fallback = sqlx::query(
                r#"
                INSERT INTO events (topic_id, title, details, closing_date, outcome, category, event_type)
                VALUES ($1, $2, $3, $4, NULL, $5, $6)
                RETURNING id
                "#,
            )
            .bind(topic_id)
            .bind(title)
            .bind(details)
            .bind(close_time)
            .bind(category)
            .bind(event_type)
            .fetch_one(pool)
            .await?;
            Ok(fallback.get("id"))
        }
    }
}

async fn has_pgvector_extension(pool: &PgPool) -> Result<bool> {
    let row =
        sqlx::query("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS has")
            .fetch_one(pool)
            .await?;
    Ok(row.get("has"))
}

fn normalized_market_text(market: &ImportedMarket) -> String {
    normalized_text_blob(&market.title, &market.description)
}

fn normalized_text_blob(title: &str, details: &str) -> String {
    normalize_text(&format!("{} {}", title, details))
}

fn normalize_text(input: &str) -> String {
    input
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_text_search_query(input: &str) -> String {
    let stop_words: HashSet<&str> = [
        "the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "is", "are", "will", "be",
        "by", "at", "with", "from", "this", "that",
    ]
    .into_iter()
    .collect();

    input
        .split_whitespace()
        .filter(|token| token.len() > 2 && !stop_words.contains(*token))
        .take(24)
        .collect::<Vec<_>>()
        .join(" ")
}

fn text_similarity(a: &str, b: &str) -> f64 {
    let a_tokens: HashSet<&str> = a.split_whitespace().collect();
    let b_tokens: HashSet<&str> = b.split_whitespace().collect();
    if a_tokens.is_empty() || b_tokens.is_empty() {
        return 0.0;
    }
    let intersection = a_tokens.intersection(&b_tokens).count() as f64;
    let union = a_tokens.union(&b_tokens).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        (intersection / union).clamp(0.0, 1.0)
    }
}

fn market_details_blob(market: &ImportedMarket) -> String {
    format!(
        "{}\n\nSource: {}\nExternal ID: {}\nExternal URL: {}\nCategory: {}\nType: {}",
        market.description,
        market.source,
        market.external_id,
        market.external_url,
        market.category,
        market.event_type
    )
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    value
        .chars()
        .take(max.saturating_sub(3))
        .collect::<String>()
        + "..."
}

fn normalize_domain(category: &str) -> String {
    let c = category.to_lowercase();
    if c.contains("politic") {
        "politics".to_string()
    } else if c.contains("econ") || c.contains("macro") {
        "economics".to_string()
    } else if c.contains("finance") || c.contains("market") {
        "finance".to_string()
    } else if c.contains("crypto") {
        "crypto".to_string()
    } else if c.contains("tech") || c.contains("ai") {
        "technology".to_string()
    } else if c.contains("science") {
        "science".to_string()
    } else if c.contains("climate") || c.contains("weather") {
        "climate".to_string()
    } else if c.contains("war") || c.contains("conflict") {
        "conflict".to_string()
    } else {
        "general".to_string()
    }
}

fn normalize_event_type(raw: &str) -> String {
    let value = raw.trim().to_lowercase();
    if value.contains("binary") || value == "yesno" || value == "yes_no" {
        "binary".to_string()
    } else if value.contains("multi") || value.contains("choice") || value.contains("free_response")
    {
        "multiple_choice".to_string()
    } else if value.contains("numeric") || value.contains("number") || value.contains("scalar") {
        "numeric".to_string()
    } else if value.contains("date") || value.contains("time") {
        "date".to_string()
    } else {
        "binary".to_string()
    }
}

fn dedup_threshold() -> f64 {
    env::var("IMPORT_DEDUP_THRESHOLD")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.86)
        .clamp(0.0, 1.0)
}

fn close_window_days() -> i64 {
    env::var("IMPORT_DEDUP_CLOSE_WINDOW_DAYS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(7)
        .max(1)
}

fn provider_limit(provider: ImportProvider) -> usize {
    let key = format!("IMPORT_{}_LIMIT", provider.as_str().to_uppercase());
    env::var(&key)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(300)
        .clamp(1, 2000)
}

fn embedding_to_vector_literal(values: &[f64]) -> String {
    let joined = values
        .iter()
        .map(|x| format!("{:.8}", x))
        .collect::<Vec<_>>()
        .join(",");
    format!("[{}]", joined)
}

#[derive(Debug, Deserialize)]
struct OpenRouterEmbeddingsResponse {
    data: Vec<OpenRouterEmbeddingsRow>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterEmbeddingsRow {
    embedding: Vec<f64>,
}

async fn embed_text(text: &str) -> Result<Vec<f64>> {
    let api_key = env::var("OPENROUTER_API_KEY")
        .map_err(|_| anyhow!("OPENROUTER_API_KEY is required for embedding-based dedup"))?;
    let model = env::var("IMPORT_EMBEDDING_MODEL")
        .unwrap_or_else(|_| "openai/text-embedding-3-small".to_string());
    let dimensions = env::var("IMPORT_EMBEDDING_DIMENSIONS")
        .ok()
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(768);

    let client = Client::new();
    let response = client
        .post("https://openrouter.ai/api/v1/embeddings")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .header("HTTP-Referer", "https://intellacc.com")
        .header("X-Title", "Intellacc")
        .json(&json!({
            "model": model,
            "input": text,
            "dimensions": dimensions
        }))
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "embedding request failed with status {}",
            response.status()
        ));
    }

    let body: OpenRouterEmbeddingsResponse = response.json().await?;
    let row = body
        .data
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("empty embedding response"))?;
    Ok(row.embedding)
}

async fn fetch_manifold_markets(max_markets: usize) -> Result<Vec<ImportedMarket>> {
    let client = Client::new();
    let page_limit = 100usize;
    let mut before: Option<String> = None;
    let mut output = Vec::new();

    while output.len() < max_markets {
        let mut url = format!(
            "https://api.manifold.markets/v0/markets?limit={}",
            page_limit.min(max_markets - output.len())
        );
        if let Some(ref b) = before {
            url.push_str("&before=");
            url.push_str(b);
        }

        let batch: Vec<Value> = client.get(&url).send().await?.json().await?;
        if batch.is_empty() {
            break;
        }

        for row in &batch {
            if output.len() >= max_markets {
                break;
            }
            if row
                .get("isResolved")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                continue;
            }
            let Some(id) = value_to_string(row.get("id")) else {
                continue;
            };
            let title =
                value_to_string(row.get("question")).unwrap_or_else(|| "Untitled".to_string());
            let description = value_to_string(row.get("textDescription"))
                .or_else(|| value_to_string(row.get("description")))
                .unwrap_or_else(|| title.clone());
            let category = row
                .get("groupSlugs")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.first())
                .and_then(|v| value_to_string(Some(v)))
                .unwrap_or_else(|| "general".to_string());
            let close_time = parse_datetime_value(
                row.get("closeTime")
                    .or_else(|| row.get("close_time"))
                    .or_else(|| row.get("resolutionTime")),
            );
            let event_type =
                value_to_string(row.get("outcomeType")).unwrap_or_else(|| "binary".to_string());
            let external_url = value_to_string(row.get("url")).unwrap_or_else(|| {
                let slug = value_to_string(row.get("slug")).unwrap_or_else(|| id.clone());
                let user = value_to_string(row.get("creatorUsername")).unwrap_or_default();
                if user.is_empty() {
                    format!("https://manifold.markets/{}", slug)
                } else {
                    format!("https://manifold.markets/{}/{}", user, slug)
                }
            });

            output.push(ImportedMarket {
                source: "manifold".to_string(),
                external_id: id,
                external_url,
                title,
                description,
                close_time,
                category,
                event_type,
                status: "open".to_string(),
            });
        }

        before = batch.last().and_then(|v| value_to_string(v.get("id")));
        if before.is_none() || batch.len() < page_limit {
            break;
        }
    }
    Ok(output)
}

async fn fetch_polymarket_markets(max_markets: usize) -> Result<Vec<ImportedMarket>> {
    let client = Client::new();
    let page_limit = 100usize;
    let mut offset = 0usize;
    let mut output = Vec::new();

    while output.len() < max_markets {
        let url = format!(
            "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit={}&offset={}",
            page_limit.min(max_markets - output.len()),
            offset
        );
        let batch: Vec<Value> = client.get(&url).send().await?.json().await?;
        if batch.is_empty() {
            break;
        }

        for row in &batch {
            if output.len() >= max_markets {
                break;
            }
            let Some(id) = value_to_string(row.get("id")) else {
                continue;
            };
            let title = value_to_string(row.get("question"))
                .or_else(|| value_to_string(row.get("title")))
                .unwrap_or_else(|| "Untitled".to_string());
            let description =
                value_to_string(row.get("description")).unwrap_or_else(|| title.clone());
            let close_time = parse_datetime_value(
                row.get("endDate")
                    .or_else(|| row.get("end_date"))
                    .or_else(|| row.get("closeDate"))
                    .or_else(|| row.get("endTime")),
            );
            let category = value_to_string(row.get("category"))
                .or_else(|| {
                    row.get("tags")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|v| value_to_string(Some(v)))
                })
                .unwrap_or_else(|| "general".to_string());
            let external_url = value_to_string(row.get("url")).unwrap_or_else(|| {
                let slug = value_to_string(row.get("slug")).unwrap_or_else(|| id.clone());
                format!("https://polymarket.com/event/{}", slug)
            });

            output.push(ImportedMarket {
                source: "polymarket".to_string(),
                external_id: id,
                external_url,
                title,
                description,
                close_time,
                category,
                event_type: "binary".to_string(),
                status: "open".to_string(),
            });
        }

        offset += batch.len();
        if batch.len() < page_limit {
            break;
        }
    }

    Ok(output)
}

async fn fetch_kalshi_markets(max_markets: usize) -> Result<Vec<ImportedMarket>> {
    let client = Client::new();
    let base = env::var("IMPORT_KALSHI_BASE_URL")
        .unwrap_or_else(|_| "https://trading-api.kalshi.com/trade-api/v2".to_string());
    let page_limit = 200usize;
    let mut cursor: Option<String> = None;
    let mut output = Vec::new();

    loop {
        if output.len() >= max_markets {
            break;
        }

        let mut url = format!(
            "{}/markets?status=open&limit={}",
            base,
            page_limit.min(max_markets - output.len())
        );
        if let Some(ref c) = cursor {
            url.push_str("&cursor=");
            url.push_str(c);
        }

        let mut request = client.get(&url);
        if let Ok(api_key) = env::var("KALSHI_API_KEY") {
            request = request.header("KALSHI-API-KEY", api_key);
        }

        let payload: Value = request.send().await?.json().await?;
        let markets = payload
            .get("markets")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        if markets.is_empty() {
            break;
        }

        for row in &markets {
            if output.len() >= max_markets {
                break;
            }

            let Some(id) = value_to_string(row.get("ticker")) else {
                continue;
            };
            let title = value_to_string(row.get("title"))
                .or_else(|| value_to_string(row.get("subtitle")))
                .unwrap_or_else(|| id.clone());
            let description = value_to_string(row.get("subtitle")).unwrap_or_else(|| title.clone());
            let close_time = parse_datetime_value(
                row.get("close_time")
                    .or_else(|| row.get("expiration_time"))
                    .or_else(|| row.get("expirationTime")),
            );
            let category =
                value_to_string(row.get("category")).unwrap_or_else(|| "general".to_string());
            let external_url = value_to_string(row.get("url"))
                .unwrap_or_else(|| format!("https://kalshi.com/markets/{}", id));

            output.push(ImportedMarket {
                source: "kalshi".to_string(),
                external_id: id,
                external_url,
                title,
                description,
                close_time,
                category,
                event_type: "binary".to_string(),
                status: "open".to_string(),
            });
        }

        cursor = value_to_string(payload.get("cursor"));
        if cursor.is_none() || markets.len() < page_limit {
            break;
        }
    }

    Ok(output)
}

fn value_to_string(value: Option<&Value>) -> Option<String> {
    let v = value?;
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(i) = v.as_i64() {
        return Some(i.to_string());
    }
    if let Some(f) = v.as_f64() {
        return Some(f.to_string());
    }
    None
}

fn parse_datetime_value(value: Option<&Value>) -> Option<DateTime<Utc>> {
    let v = value?;
    if let Some(i) = v.as_i64() {
        // Heuristic: treat very large values as milliseconds.
        if i > 10_000_000_000 {
            return DateTime::<Utc>::from_timestamp_millis(i);
        }
        return DateTime::<Utc>::from_timestamp(i, 0);
    }
    if let Some(s) = v.as_str() {
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Some(dt.with_timezone(&Utc));
        }
        if let Ok(ts) = s.parse::<i64>() {
            if ts > 10_000_000_000 {
                return DateTime::<Utc>::from_timestamp_millis(ts);
            }
            return DateTime::<Utc>::from_timestamp(ts, 0);
        }
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc));
        }
    }
    None
}

pub fn exclusion_reason(market: &ImportedMarket) -> Option<&'static str> {
    let category = market.category.to_lowercase();
    let title = market.title.to_lowercase();
    let description = market.description.to_lowercase();
    let haystack = format!("{} {} {}", category, title, description);

    let sports_keywords = [
        "sport",
        "soccer",
        "football",
        "nfl",
        "nba",
        "mlb",
        "nhl",
        "tennis",
        "golf",
        "f1",
        "formula 1",
        "olympic",
        "world cup",
        "champions league",
        "betting odds",
        "match result",
        "vs ",
    ];
    if sports_keywords.iter().any(|k| haystack.contains(k)) {
        return Some("sports market");
    }

    let mention_keywords = [
        "mention market",
        "mentions market",
        "who will mention",
        "will mention",
        "mentions ",
        "tweet about",
        "x post about",
        "posts about",
        "talk about on x",
        "say on x",
    ];
    if mention_keywords.iter().any(|k| haystack.contains(k)) {
        return Some("mention market");
    }

    None
}
