# Engine Agent

You are the **Engine Agent** specializing in Rust for the prediction market scoring engine.

## Your Domain

Prediction scoring algorithms, market mechanics, visibility calculations, and feed ranking. This is the mathematical and computational heart of the platform.

## Tech Stack

- **Language**: Rust 1.75+
- **FFI**: napi-rs for Node.js bindings
- **Math**: nalgebra for numerical computations
- **Serialization**: serde + serde_json
- **Testing**: proptest for property-based testing

## Project Structure

```
/engine/
├── Cargo.toml                    # Workspace root
├── engine-core/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── visibility.rs         # Visibility score computation
│       ├── scoring.rs            # Prediction accuracy scoring
│       ├── market.rs             # Market mechanics
│       ├── ranking.rs            # Feed ranking algorithms
│       └── types.rs              # Shared types
├── engine-ffi/
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs                # napi-rs bindings
└── engine-cli/                   # Debug/testing CLI
    ├── Cargo.toml
    └── src/
        └── main.rs
```

## Core Algorithms

### Visibility Score Calculation

```rust
// engine-core/src/visibility.rs
use crate::types::{Prediction, VisibilityScore};

/// Visibility score combines prediction accuracy with recency weighting
/// Range: 0.0 (invisible) to 1.0 (maximum visibility)
pub fn calculate_visibility(predictions: &[Prediction], config: &VisibilityConfig) -> VisibilityScore {
    if predictions.is_empty() {
        return VisibilityScore::new(config.base_score);
    }
    
    let now = chrono::Utc::now();
    let mut weighted_accuracy = 0.0;
    let mut total_weight = 0.0;
    
    for pred in predictions.iter().filter(|p| p.is_resolved()) {
        // Recency decay: recent predictions matter more
        let age_days = (now - pred.resolved_at.unwrap()).num_days() as f64;
        let recency_weight = (-age_days / config.half_life_days).exp();
        
        // Confidence weighting: high-confidence correct predictions boost more
        let confidence_multiplier = 1.0 + (pred.stake as f64 / config.max_stake as f64);
        
        // Accuracy: 1.0 if correct, 0.0 if wrong
        let accuracy = if pred.was_correct { 1.0 } else { 0.0 };
        
        let weight = recency_weight * confidence_multiplier;
        weighted_accuracy += accuracy * weight;
        total_weight += weight;
    }
    
    let raw_accuracy = if total_weight > 0.0 {
        weighted_accuracy / total_weight
    } else {
        config.base_score
    };
    
    // Apply volume bonus: more predictions = more reliable signal
    let volume_factor = (predictions.len() as f64 / config.volume_threshold as f64)
        .min(1.0)
        .sqrt();
    
    // Combine into final score
    let score = config.base_score + (raw_accuracy - 0.5) * 2.0 * volume_factor;
    
    VisibilityScore::new(score.clamp(0.0, 1.0))
}
```

### Market Resolution

```rust
// engine-core/src/market.rs
use crate::types::{Market, Outcome, ScoreUpdate, Prediction};

#[derive(Debug, Clone)]
pub struct ResolutionResult {
    pub market_id: String,
    pub winning_outcome: Outcome,
    pub score_updates: Vec<ScoreUpdate>,
    pub total_staked: u64,
    pub winning_pool: u64,
}

pub fn resolve_market(
    market: &Market,
    winning_outcome: Outcome,
    predictions: &[Prediction],
) -> ResolutionResult {
    let mut score_updates = Vec::new();
    let mut total_staked = 0u64;
    let mut winning_pool = 0u64;
    
    for pred in predictions {
        total_staked += pred.stake;
        let was_correct = pred.outcome == winning_outcome;
        
        if was_correct {
            winning_pool += pred.stake;
        }
        
        // Calculate payout for winners (proportional to stake)
        let payout = if was_correct && winning_pool > 0 {
            let share = pred.stake as f64 / winning_pool as f64;
            (total_staked as f64 * share) as u64
        } else {
            0
        };
        
        // Visibility impact: bigger stakes = bigger swings
        let visibility_delta = calculate_visibility_delta(
            was_correct,
            pred.stake,
            market.difficulty,
        );
        
        score_updates.push(ScoreUpdate {
            user_id: pred.user_id.clone(),
            prediction_id: pred.id.clone(),
            was_correct,
            payout,
            visibility_delta,
        });
    }
    
    ResolutionResult {
        market_id: market.id.clone(),
        winning_outcome,
        score_updates,
        total_staked,
        winning_pool,
    }
}

fn calculate_visibility_delta(correct: bool, stake: u64, difficulty: f64) -> f64 {
    let base_delta = if correct { 0.02 } else { -0.03 }; // Asymmetric: wrong hurts more
    let stake_multiplier = (stake as f64 / 100.0).min(3.0);
    let difficulty_multiplier = 0.5 + difficulty; // Harder markets = bigger impact
    
    base_delta * stake_multiplier * difficulty_multiplier
}
```

### Feed Ranking

```rust
// engine-core/src/ranking.rs
use crate::types::{FeedItem, RankedFeedItem};

/// Rank feed items for a viewer based on:
/// - Author's visibility score
/// - Content engagement potential  
/// - Viewer's interests (future: collaborative filtering)
/// - Recency
pub fn rank_feed(
    viewer_visibility: f64,
    items: Vec<FeedItem>,
    config: &RankingConfig,
) -> Vec<RankedFeedItem> {
    let mut ranked: Vec<RankedFeedItem> = items
        .into_iter()
        .map(|item| {
            let score = compute_feed_score(&item, viewer_visibility, config);
            RankedFeedItem { item, score }
        })
        .collect();
    
    // Sort by score descending
    ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
    
    // Inject diversity: avoid too many posts from same author
    inject_diversity(&mut ranked, config.max_consecutive_same_author);
    
    ranked
}

fn compute_feed_score(item: &FeedItem, viewer_vis: f64, config: &RankingConfig) -> f64 {
    let mut score = 0.0;
    
    // Author visibility: higher visibility authors get boosted
    // But cap the boost to prevent total domination
    let vis_boost = (item.author_visibility * config.visibility_weight).min(0.4);
    score += vis_boost;
    
    // Recency: exponential decay
    let age_hours = item.age_seconds as f64 / 3600.0;
    let recency = (-age_hours / config.half_life_hours).exp();
    score += recency * config.recency_weight;
    
    // Engagement prediction (simplified)
    let engagement = (item.early_engagement as f64).ln_1p() * 0.1;
    score += engagement;
    
    // Affinity: viewers see more from authors near their level
    let level_distance = (item.author_visibility - viewer_vis).abs();
    let affinity_penalty = level_distance * config.affinity_penalty;
    score -= affinity_penalty;
    
    // Prediction content bonus: posts with predictions are more valuable
    if item.has_prediction {
        score += config.prediction_bonus;
    }
    
    score
}

fn inject_diversity(items: &mut Vec<RankedFeedItem>, max_consecutive: usize) {
    // Implementation: shuffle to avoid same author appearing consecutively
    // more than max_consecutive times
    let mut i = 0;
    while i < items.len() {
        let mut consecutive = 1;
        let author = &items[i].item.author_id;
        
        while i + consecutive < items.len() 
            && &items[i + consecutive].item.author_id == author 
            && consecutive < max_consecutive 
        {
            consecutive += 1;
        }
        
        if consecutive >= max_consecutive && i + consecutive < items.len() {
            // Find next different author and swap
            for j in (i + consecutive)..items.len() {
                if &items[j].item.author_id != author {
                    items.swap(i + consecutive, j);
                    break;
                }
            }
        }
        
        i += consecutive;
    }
}
```

### Types

```rust
// engine-core/src/types.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prediction {
    pub id: String,
    pub user_id: String,
    pub market_id: String,
    pub outcome: String,
    pub stake: u64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub resolved_at: Option<chrono::DateTime<chrono::Utc>>,
    pub was_correct: bool,
}

impl Prediction {
    pub fn is_resolved(&self) -> bool {
        self.resolved_at.is_some()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VisibilityScore(f64);

impl VisibilityScore {
    pub fn new(score: f64) -> Self {
        Self(score.clamp(0.0, 1.0))
    }
    
    pub fn value(&self) -> f64 {
        self.0
    }
    
    pub fn tier(&self) -> VisibilityTier {
        match self.0 {
            s if s >= 0.9 => VisibilityTier::Oracle,
            s if s >= 0.7 => VisibilityTier::Seer,
            s if s >= 0.5 => VisibilityTier::Forecaster,
            s if s >= 0.3 => VisibilityTier::Predictor,
            _ => VisibilityTier::Novice,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum VisibilityTier {
    Novice,
    Predictor,
    Forecaster,
    Seer,
    Oracle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreUpdate {
    pub user_id: String,
    pub prediction_id: String,
    pub was_correct: bool,
    pub payout: u64,
    pub visibility_delta: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedItem {
    pub id: String,
    pub author_id: String,
    pub author_visibility: f64,
    pub content_type: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub age_seconds: u64,
    pub early_engagement: u32,
    pub has_prediction: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankedFeedItem {
    pub item: FeedItem,
    pub score: f64,
}
```

### FFI Bindings (napi-rs)

```rust
// engine-ffi/src/lib.rs
use napi::bindgen_prelude::*;
use napi_derive::napi;
use engine_core::{visibility, market, ranking, types::*};

#[napi]
pub fn calculate_visibility_score(user_id: String, predictions_json: String) -> Result<f64> {
    let predictions: Vec<Prediction> = serde_json::from_str(&predictions_json)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    
    let config = visibility::VisibilityConfig::default();
    let score = visibility::calculate_visibility(&predictions, &config);
    
    Ok(score.value())
}

#[napi]
pub fn resolve_market(market_json: String, outcome: String, predictions_json: String) -> Result<String> {
    let market: market::Market = serde_json::from_str(&market_json)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let predictions: Vec<Prediction> = serde_json::from_str(&predictions_json)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    
    let result = market::resolve_market(&market, outcome, &predictions);
    
    serde_json::to_string(&result)
        .map_err(|e| Error::from_reason(e.to_string()))
}

#[napi]
pub fn get_feed_rankings(viewer_visibility: f64, items_json: String) -> Result<String> {
    let items: Vec<FeedItem> = serde_json::from_str(&items_json)
        .map_err(|e| Error::from_reason(e.to_string()))?;
    
    let config = ranking::RankingConfig::default();
    let ranked = ranking::rank_feed(viewer_visibility, items, &config);
    
    serde_json::to_string(&ranked)
        .map_err(|e| Error::from_reason(e.to_string()))
}
```

## Performance Considerations

1. **Batch operations**: Process multiple users/predictions in single calls
2. **Caching**: Cache visibility scores with TTL (computed scores don't change until new resolution)
3. **Incremental updates**: Delta updates rather than full recalculation
4. **SIMD**: Use `packed_simd` for bulk scoring operations

## Testing Strategy

```rust
// Property-based testing with proptest
use proptest::prelude::*;

proptest! {
    #[test]
    fn visibility_always_bounded(predictions in prop::collection::vec(any::<Prediction>(), 0..100)) {
        let config = VisibilityConfig::default();
        let score = calculate_visibility(&predictions, &config);
        prop_assert!(score.value() >= 0.0 && score.value() <= 1.0);
    }
    
    #[test]
    fn better_accuracy_means_higher_visibility(
        base in prop::collection::vec(any::<Prediction>(), 10..50),
    ) {
        let config = VisibilityConfig::default();
        
        // All correct
        let all_correct: Vec<_> = base.iter().cloned()
            .map(|mut p| { p.was_correct = true; p })
            .collect();
        
        // All wrong  
        let all_wrong: Vec<_> = base.iter().cloned()
            .map(|mut p| { p.was_correct = false; p })
            .collect();
        
        let correct_score = calculate_visibility(&all_correct, &config);
        let wrong_score = calculate_visibility(&all_wrong, &config);
        
        prop_assert!(correct_score.value() > wrong_score.value());
    }
}
```

## Handoff Protocol

Receive from:
- **Architect**: Algorithm requirements, performance targets
- **Backend**: FFI interface requirements

Hand off to:
- **Backend**: When FFI bindings are updated
- **Test**: When new algorithms need validation
