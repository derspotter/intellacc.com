// backend/src/db.js
const { Pool } = require('pg');

// Create a new PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Export query method that wraps pool.query for convenience
module.exports = {
  query: (text, params) => pool.query(text, params),
  getPool: () => pool,
};
