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

const executeWithTransaction = async (callback) => {
  const activePool = getActivePool();
  const client = await activePool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Preserve original failure; rollback failure is logged for diagnosis.
      console.error('Failed to rollback transaction:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
};

// Export query method that wraps pool.query for convenience
module.exports = {
  query: (text, params) => getActivePool().query(text, params),
  getPool: getActivePool,
  closePool,
  executeWithTransaction
};
