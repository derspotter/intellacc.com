//! Prediction Engine Library
//! 
//! This library provides the core functionality for the LMSR prediction market engine.

// Re-export modules for use in binaries
pub mod config;
pub mod stress;
pub mod lmsr_core;
pub mod lmsr_api;
pub mod db_adapter;
pub mod database;