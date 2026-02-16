// backend/src/db.js
const { Pool } = require('pg');

const createPool = () => new Pool({
  connectionString: process.env.DATABASE_URL,
});

let pool = createPool();

const getActivePool = () => {
  if (!pool || pool.ended) {
    pool = createPool();
  }
  return pool;
};

const closePool = async () => {
  if (!pool || pool.ended) {
    pool = null;
    return;
  }

  await pool.end();
  pool = null;
};

// Export query method that wraps pool.query for convenience
module.exports = {
  query: (text, params) => getActivePool().query(text, params),
  getPool: getActivePool,
  closePool
};
