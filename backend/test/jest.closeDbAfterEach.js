const db = require('../src/db');
const { server, io } = require('../src/index');
const { forceCloseTestServer } = require('./testServer');

afterAll(async () => {
  if (process.env.NODE_ENV === 'test') {
    try {
      await forceCloseTestServer();
    } catch (error) {
      console.warn('[Test Teardown] Failed to close test HTTP server:', error?.message || error);
    }

    try {
      if (io?.close) {
        await new Promise((resolve) => io.close(() => resolve()));
      }
    } catch (error) {
      console.warn('[Test Teardown] Failed to close Socket.IO server:', error?.message || error);
    }

    try {
      if (server?.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    } catch (error) {
      console.warn('[Test Teardown] Failed to close HTTP server:', error?.message || error);
    }

    try {
      await db.closePool();
    } catch (error) {
      // Ensure one misbehaving test teardown does not fail the suite because of pool cleanup.
      console.warn('[Test Teardown] Failed to close DB pool:', error?.message || error);
    }
  }
});
