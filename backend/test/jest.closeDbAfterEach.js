const db = require('../src/db');
const { forceCloseTestServer } = require('./testServer');

afterAll(async () => {
  if (process.env.NODE_ENV === 'test') {
    try {
      await forceCloseTestServer();
    } catch (error) {
      console.warn('[Test Teardown] Failed to close test HTTP server:', error?.message || error);
    }

    // Resolve the app lazily, at teardown only. This setup file runs before
    // every test file; requiring src/index at module scope would load and
    // cache the whole application BEFORE the test file's jest.mock factories
    // register, silently disarming them (the controller keeps real bindings).
    // At afterAll time the require returns the instance the test itself
    // loaded, or undefined if the test never touched the app.
    let server;
    let io;
    try {
      ({ server, io } = require('../src/index'));
    } catch (error) {
      server = undefined;
      io = undefined;
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
