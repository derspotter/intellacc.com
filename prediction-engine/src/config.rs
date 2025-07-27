//! Configuration management for the prediction engine
//! Supports environment variables and default values for market parameters

use serde::{Deserialize, Serialize};
use std::env;

/// Configuration for the prediction engine
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Market configuration
    pub market: MarketConfig,
}

/// Market-specific configuration parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketConfig {
    /// Enable/disable hold period for share selling (default: true)
    pub enable_hold_period: bool,
    
    /// Hold period duration in hours (default: 1.0)
    pub hold_period_hours: f64,
    
    /// Kelly criterion fraction for conservative betting (default: 0.25)
    pub kelly_fraction: f64,
    
    /// Maximum Kelly fraction allowed (default: 1.0)
    pub max_kelly_fraction: f64,
}

impl Default for MarketConfig {
    fn default() -> Self {
        Self {
            enable_hold_period: true,
            hold_period_hours: 1.0,
            kelly_fraction: 0.25,
            max_kelly_fraction: 1.0,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            market: MarketConfig::default(),
        }
    }
}

impl Config {
    /// Load configuration from environment variables with fallback to defaults
    pub fn from_env() -> Self {
        let mut config = Config::default();
        
        // Market configuration from environment
        if let Ok(enable_hold) = env::var("MARKET_ENABLE_HOLD_PERIOD") {
            config.market.enable_hold_period = enable_hold.parse()
                .unwrap_or(config.market.enable_hold_period);
        }
        
        if let Ok(hold_hours) = env::var("MARKET_HOLD_PERIOD_HOURS") {
            config.market.hold_period_hours = hold_hours.parse()
                .unwrap_or(config.market.hold_period_hours);
        }
        
        if let Ok(kelly_frac) = env::var("MARKET_KELLY_FRACTION") {
            let parsed_kelly = kelly_frac.parse()
                .unwrap_or(config.market.kelly_fraction);
            // Clamp to reasonable bounds
            config.market.kelly_fraction = parsed_kelly.max(0.0).min(config.market.max_kelly_fraction);
        }
        
        if let Ok(max_kelly) = env::var("MARKET_MAX_KELLY_FRACTION") {
            config.market.max_kelly_fraction = max_kelly.parse()
                .unwrap_or(config.market.max_kelly_fraction);
        }
        
        // Validate configuration
        config.validate();
        
        config
    }
    
    /// Validate configuration values
    fn validate(&mut self) {
        // Ensure hold period is positive
        if self.market.hold_period_hours < 0.0 {
            eprintln!("⚠️  Invalid hold_period_hours: {}, using default", self.market.hold_period_hours);
            self.market.hold_period_hours = 1.0;
        }
        
        // Ensure Kelly fraction is within bounds
        if self.market.kelly_fraction < 0.0 || self.market.kelly_fraction > self.market.max_kelly_fraction {
            eprintln!("⚠️  Invalid kelly_fraction: {}, using default", self.market.kelly_fraction);
            self.market.kelly_fraction = 0.25;
        }
        
        // Ensure max Kelly fraction is reasonable
        if self.market.max_kelly_fraction < 0.0 || self.market.max_kelly_fraction > 2.0 {
            eprintln!("⚠️  Invalid max_kelly_fraction: {}, using default", self.market.max_kelly_fraction);
            self.market.max_kelly_fraction = 1.0;
        }
    }
    
    /// Print current configuration for debugging
    pub fn print_config(&self) {
        println!("🔧 Prediction Engine Configuration:");
        println!("   Hold Period Enabled: {}", self.market.enable_hold_period);
        println!("   Hold Period Hours: {}", self.market.hold_period_hours);
        println!("   Kelly Fraction: {}", self.market.kelly_fraction);
        println!("   Max Kelly Fraction: {}", self.market.max_kelly_fraction);
    }
}