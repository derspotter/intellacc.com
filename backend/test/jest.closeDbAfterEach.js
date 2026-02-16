const db = require('../src/db');

afterAll(async () => {
  if (process.env.NODE_ENV === 'test') {
    try {
      await db.closePool();
    } catch (error) {
      // Ensure one misbehaving test teardown does not fail the suite because of pool cleanup.
      console.warn('[Test Teardown] Failed to close DB pool:', error?.message || error);
    }
  }
});
