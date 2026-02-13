// Metaculus API integration for fetching prediction questions
use anyhow::Result;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;
use sqlx::{PgPool, Row};
use std::env;

// Metaculus API response structures for /api/posts/
#[derive(Debug, Deserialize)]
struct MetaculusResponse {
    results: Vec<MetaculusPost>,
    next: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct MetaculusPost {
    #[serde(default)]
    categories: Vec<String>,
    question: Option<MetaculusQuestion>,
}

#[derive(Debug, Deserialize, Clone)]
struct MetaculusQuestion {
    id: i32,
    title: String,
    #[serde(default)]
    scheduled_close_time: Option<String>,
    #[serde(rename = "type")]
    question_type: String,
    status: String,
    #[serde(default)]
    description: Option<String>,
}

// Our internal event structure
#[derive(Debug)]
struct PredictionEvent {
    title: String,
    description: String,
    metaculus_id: i32,
    metaculus_url: String,
    close_time: Option<DateTime<Utc>>,
    category: String,
    event_type: String,
    status: String,
}

#[derive(Clone)]
pub struct MetaculusClient {
    client: Client,
    base_url: String,
}

impl MetaculusClient {
    pub fn new() -> Self {
        dotenv::dotenv().ok();
        Self {
            client: Client::new(),
            base_url: "https://www.metaculus.com/api".to_string(),
        }
    }

    fn get_api_token(&self) -> Result<String> {
        env::var("METACULUS_API_TOKEN")
            .map_err(|_| anyhow::anyhow!("METACULUS_API_TOKEN environment variable not set"))
    }

    // DRY helper: Common API request pattern
    async fn make_api_request(&self, url: &str) -> Result<MetaculusResponse> {
        let token = self.get_api_token()?;
        let response: MetaculusResponse = self
            .client
            .get(url)
            .header("User-Agent", "Intellacc-PredictionEngine/1.0")
            .header("Authorization", format!("Token {}", token))
            .send()
            .await?
            .json()
            .await?;
        Ok(response)
    }

    // DRY helper: Extract questions from API response
    fn extract_questions_from_response(
        &self,
        response: MetaculusResponse,
    ) -> Vec<(MetaculusQuestion, MetaculusPost)> {
        response
            .results
            .into_iter()
            .filter_map(|post| post.question.clone().map(|question| (question, post)))
            .collect()
    }

    // Fetch open questions from Metaculus with proper pagination
    async fn fetch_open_questions(
        &self,
        limit: Option<u32>,
    ) -> Result<Vec<(MetaculusQuestion, MetaculusPost)>> {
        let mut all_questions = Vec::new();
        let mut url = format!("{}/posts/?status=open&order_by=-id", self.base_url);

        // Set a reasonable per-page limit for API requests
        let per_page_limit = limit.unwrap_or(100).min(100);
        url = format!("{}&limit={}", url, per_page_limit);

        loop {
            println!("🔍 Fetching from: {}", url);

            let response = self.make_api_request(&url).await?;
            let next_url = response.next.clone(); // Store next URL before consuming response
            let questions = self.extract_questions_from_response(response);
            all_questions.extend(questions);

            println!("📊 Collected {} questions so far", all_questions.len());

            // Check if we should continue pagination
            let should_continue = if let Some(target_limit) = limit {
                all_questions.len() < target_limit as usize && next_url.is_some()
            } else {
                next_url.is_some()
            };

            if !should_continue {
                break;
            }

            // Use the next URL from the response, but ensure it uses HTTPS
            url = next_url.unwrap().replace("http://", "https://");

            // Rate limiting - be respectful to Metaculus API
            tokio::time::sleep(tokio::time::Duration::from_millis(750)).await;
        }

        // If we have a limit, ensure we don't exceed it
        if let Some(target_limit) = limit {
            all_questions.truncate(target_limit as usize);
        }

        println!(
            "✅ Finished fetching: {} total questions",
            all_questions.len()
        );
        Ok(all_questions)
    }

    // Fetch questions by category
    async fn fetch_questions_by_category(
        &self,
        category: &str,
        limit: Option<u32>,
    ) -> Result<Vec<(MetaculusQuestion, MetaculusPost)>> {
        let mut url = format!(
            "{}/posts/?status=open&categories={}&order_by=-created_time",
            self.base_url, category
        );

        if let Some(limit) = limit {
            url = format!("{}&limit={}", url, limit);
        }

        let response = self.make_api_request(&url).await?;
        Ok(self.extract_questions_from_response(response))
    }

    // Convert Metaculus question to our internal event format
    fn convert_to_event(
        &self,
        question: &MetaculusQuestion,
        post: &MetaculusPost,
    ) -> PredictionEvent {
        let close_time = question
            .scheduled_close_time
            .as_ref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|dt| dt.with_timezone(&Utc));

        let description = question
            .description
            .as_ref()
            .unwrap_or(&format!("Imported from Metaculus: {}", question.title))
            .clone();

        // Extract category from post categories, default to "general" if none
        let category = if !post.categories.is_empty() {
            post.categories[0].clone()
        } else {
            "general".to_string()
        };

        PredictionEvent {
            title: question.title.clone(),
            description,
            metaculus_id: question.id,
            metaculus_url: format!("https://www.metaculus.com/questions/{}/", question.id),
            close_time,
            category,
            event_type: question.question_type.clone(),
            status: question.status.clone(),
        }
    }

    // Store fetched questions in our database
    async fn store_questions_in_db(
        &self,
        pool: &PgPool,
        questions_with_posts: Vec<(MetaculusQuestion, MetaculusPost)>,
    ) -> Result<usize> {
        let mut stored_count = 0;

        // First, ensure we have a default topic for Metaculus imports
        let topic_id = self.ensure_metaculus_topic(pool).await?;

        for (question, post) in questions_with_posts {
            let event = self.convert_to_event(&question, &post);

            // Check if we already have this question by Metaculus ID (more reliable)
            let metaculus_id_pattern = format!("Metaculus ID: {}", event.metaculus_id);
            let existing = sqlx::query("SELECT id FROM events WHERE details LIKE $1")
                .bind(format!("%{}%", metaculus_id_pattern))
                .fetch_optional(pool)
                .await?;

            if existing.is_some() {
                println!(
                    "📝 Skipping existing question (ID: {}): {}",
                    event.metaculus_id, event.title
                );
                continue;
            }

            // Truncate title if too long
            let truncated_title = if event.title.len() > 255 {
                format!("{}...", &event.title[..252])
            } else {
                event.title.clone()
            };

            // Create details with Metaculus metadata
            let enhanced_details = format!(
                "{}\n\nMetaculus ID: {}\nMetaculus URL: {}\nCategory: {}\nType: {}",
                event.description,
                event.metaculus_id,
                event.metaculus_url,
                event.category,
                event.event_type
            );

            // Insert new event with category
            let result = sqlx::query(
                r#"
                INSERT INTO events (
                    topic_id, title, details, closing_date, outcome, category
                ) VALUES ($1, $2, $3, $4, $5, $6)
                "#,
            )
            .bind(topic_id)
            .bind(&truncated_title)
            .bind(&enhanced_details)
            .bind(event.close_time)
            .bind(if event.status == "resolved" {
                Some("pending")
            } else {
                None
            })
            .bind(&event.category)
            .execute(pool)
            .await;

            match result {
                Ok(_) => {
                    println!("✅ Stored: {}", truncated_title);
                    stored_count += 1;
                }
                Err(e) => {
                    eprintln!("❌ Failed to store {}: {}", truncated_title, e);
                }
            }
        }

        Ok(stored_count)
    }

    // Ensure we have a topic for Metaculus imports
    async fn ensure_metaculus_topic(&self, pool: &PgPool) -> Result<i32> {
        // Check if "Metaculus Imports" topic exists
        let existing = sqlx::query("SELECT id FROM topics WHERE name = 'Metaculus Imports'")
            .fetch_optional(pool)
            .await?;

        if let Some(topic) = existing {
            return Ok(topic.get("id"));
        }

        // Create the topic if it doesn't exist
        let topic =
            sqlx::query("INSERT INTO topics (name, description) VALUES ($1, $2) RETURNING id")
                .bind("Metaculus Imports")
                .bind("Events imported from Metaculus.com prediction platform")
                .fetch_one(pool)
                .await?;

        println!("📂 Created Metaculus Imports topic");
        Ok(topic.get("id"))
    }

    // Complete initial import - fetch ALL open questions from Metaculus in batches
    pub async fn complete_initial_import(&self, pool: &PgPool) -> Result<usize> {
        self.complete_initial_import_with_limit(pool, None).await
    }

    // Complete initial import with optional batch limit for testing
    pub async fn complete_initial_import_with_limit(
        &self,
        pool: &PgPool,
        max_batches: Option<u32>,
    ) -> Result<usize> {
        println!("🚀 Starting complete Metaculus import...");
        if let Some(limit) = max_batches {
            println!("📊 Limited to {} batches for testing", limit);
        }

        let mut total_stored = 0;
        let mut url = format!(
            "{}/posts/?status=open&order_by=-id&limit=100",
            self.base_url
        );
        let mut page = 1;

        loop {
            println!("📄 Processing batch {} from: {}", page, url);

            let response = self.make_api_request(&url).await?;
            let next_url = response.next.clone();
            let questions = self.extract_questions_from_response(response);

            if questions.is_empty() {
                println!("✅ No more questions found. Import complete!");
                break;
            }

            println!(
                "📥 Fetched {} questions from batch {}",
                questions.len(),
                page
            );

            // Store this batch in database immediately
            let stored_count = self.store_questions_in_db(pool, questions).await?;
            total_stored += stored_count;

            println!(
                "💾 Stored {} new questions from batch {} (total so far: {})",
                stored_count, page, total_stored
            );

            // Check if we've reached the batch limit
            if let Some(max_batches) = max_batches {
                if page >= max_batches {
                    println!(
                        "📊 Reached batch limit of {}. Stopping import.",
                        max_batches
                    );
                    break;
                }
            }

            // Check if there's a next page
            if next_url.is_none() {
                println!("📄 Reached last page. Import complete!");
                break;
            }

            // Use the next URL from the response, but ensure it uses HTTPS
            url = next_url.unwrap().replace("http://", "https://");
            page += 1;

            // Rate limiting - be respectful during bulk import
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
        }

        println!(
            "🎉 Complete import finished! Total new questions imported: {}",
            total_stored
        );
        Ok(total_stored)
    }

    // Daily sync job - fetch and store new questions
    pub async fn daily_sync(&self, pool: &PgPool) -> Result<usize> {
        println!("🔄 Starting daily Metaculus sync...");

        // For daily sync, fetch more questions to catch new ones
        // Use ID ordering to get highest numbered questions first
        let questions = self.fetch_open_questions(Some(150)).await?;
        println!("📥 Fetched {} questions from Metaculus", questions.len());

        // Store in database (duplicates will be skipped)
        let stored_count = self.store_questions_in_db(pool, questions).await?;
        println!("💾 Stored {} new questions in database", stored_count);

        Ok(stored_count)
    }

    // Sync questions by specific categories
    pub async fn sync_categories(&self, pool: &PgPool, categories: Vec<&str>) -> Result<usize> {
        println!("🔄 Starting category sync for: {:?}", categories);
        let mut total_stored = 0;

        for category in categories {
            println!("📂 Syncing category: {}", category);
            let questions = self.fetch_questions_by_category(category, Some(20)).await?;
            let stored = self.store_questions_in_db(pool, questions).await?;
            total_stored += stored;

            // Rate limiting between categories
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
        }

        println!("💾 Total stored across all categories: {}", total_stored);
        Ok(total_stored)
    }
}

// Manual bulk import function for initial setup
pub async fn manual_bulk_import(pool: &PgPool) -> Result<usize> {
    let client = MetaculusClient::new();
    client.complete_initial_import(pool).await
}

// Manual limited import function for testing
pub async fn manual_limited_import(pool: &PgPool, max_batches: u32) -> Result<usize> {
    let client = MetaculusClient::new();
    client
        .complete_initial_import_with_limit(pool, Some(max_batches))
        .await
}

// Manual sync function for testing
pub async fn manual_sync(pool: &PgPool) -> Result<usize> {
    let client = MetaculusClient::new();
    client.daily_sync(pool).await
}

// Sync specific categories manually
pub async fn manual_category_sync(pool: &PgPool, categories: Vec<&str>) -> Result<usize> {
    let client = MetaculusClient::new();
    client.sync_categories(pool, categories).await
}
